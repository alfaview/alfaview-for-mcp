// The question to the person before delete_room and delete_user. Both tools ask the person
// through elicitation in form mode, and each round of the question is a new call of the tool.
import { randomBytes } from 'node:crypto';
import {
  CLIENT_CAPABILITIES_META_KEY,
  createRequestStateCodec,
  inputResponse,
  type ClientCapabilities,
  type McpServer,
  type RequestStateCodec,
  type ServerContext,
} from '@modelcontextprotocol/server';
import * as z from 'zod';
import { ToolError } from '../alfaview/errors.ts';

/** How long a request state is valid: the time of one round for the person. */
export const CONFIRMATION_TTL_SECONDS = 300;

/** How long the server keeps a note of a room name or a rename that it sent, for the question. */
export const RENAME_NOTE_MS = 60 * 60 * 1000;

/** The key of the question in `inputRequests` and of its answer in `inputResponses`. */
export const CONFIRM_REQUEST = 'confirm';

/** The first revision of the protocol whose requests carry the client capabilities in `_meta`. */
const FIRST_MODERN_REVISION = '2026-07-28';

/**
 * The payload of a request state. `id` is the ID of the input in lowercase. The state is signed,
 * not encrypted, so the client can read it: it never holds a name, an email address or a hash of
 * either.
 */
const CONFIRMATION_STATE = z.strictObject({
  v: z.literal(1),
  tool: z.string(),
  id: z.string(),
  round: z.union([z.literal(1), z.literal(2)]),
  nonce: z.string(),
});

export type ConfirmationState = z.infer<typeof CONFIRMATION_STATE>;

/** How the call ended: deleted with the word of the person or of the parameter, or kept. */
export const CONFIRMATION_OUTCOMES = [
  'person',
  'parameter',
  'declined',
  'canceled',
  'mismatch',
] as const;

export type ConfirmationOutcome = (typeof CONFIRMATION_OUTCOMES)[number];

/** A name that this server sent for a room: in a create, or in a rename. */
type NameNote = {
  /** In the form of nameKey. */
  name: string;
  /** In lowercase. `null` until alfaview gives the ID of a new room, or when it gives none. */
  roomId: string | null;
  at: number;
};

/**
 * The Hangul fillers and the braille blank. Fonts draw each one as a blank, so it reads as a
 * space, although Unicode counts it as a letter or a symbol.
 */
const BLANK_CHARACTERS = /[\u{115F}\u{1160}\u{2800}\u{3164}\u{FFA0}]/gu;

/**
 * Returns the form in which the notes compare names: NFKC, each blank character as a space,
 * without invisible characters, each run of white space as one space, trimmed and in lowercase.
 * So a name that a person cannot tell apart from another, such as one with a no-break space, a
 * Hangul filler, a double space, a zero-width space or fullwidth letters, gets the note of the
 * same name. Letters of other scripts that look alike stay different.
 */
function nameKey(name: string): string {
  return name
    .normalize('NFKC')
    .replace(BLANK_CHARACTERS, ' ')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .replace(/[\s\p{Z}]+/gu, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The confirmations of one process: the key of the request states, the nonces that a round has
 * spent, and the room names and renames that this server sent. The servers of a process share one,
 * so a round that a client sends to another server of the process still finds its state valid. The
 * key is 32 random bytes made at the start, so a state of another process is refused.
 */
export class Confirmations {
  readonly #codec: RequestStateCodec<ConfirmationState>;
  /** The spent nonces, each with the time until which its state can still be valid. */
  readonly #spent = new Map<string, number>();
  /** The room IDs in lowercase, each with the time of its last rename by this server. */
  readonly #renames = new Map<string, number>();
  /** The names that this server sent for rooms in the last hour, oldest first. */
  #names: NameNote[] = [];
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
    this.#codec = createRequestStateCodec<ConfirmationState>({
      key: randomBytes(32),
      ttlSeconds: CONFIRMATION_TTL_SECONDS,
      // The tool name is not in the context of a request, so the payload holds it and the tool
      // checks it (claim).
      bind: (ctx) => ctx.mcpReq.method,
    });
  }

  /**
   * The check of `ServerOptions.requestState.verify`: the signature, the expiry and the method. The
   * SDK refuses a state that fails with `-32602 Invalid or expired requestState` before the tool.
   */
  readonly verify = (state: string, ctx: ServerContext): Promise<ConfirmationState> =>
    this.#codec.verify(state, ctx);

  /** Returns a signed state for the question of `round`, with a new nonce of 16 random bytes. */
  mint(tool: string, id: string, round: 1 | 2, ctx: ServerContext): Promise<string> {
    const nonce = randomBytes(16).toString('base64url');
    return this.#codec.mint({ v: 1, tool, id, round, nonce }, ctx);
  }

  /**
   * Marks `nonce` spent until its state can no longer be valid. Returns false when it was spent
   * already, so each state works once. The codec counts the TTL in whole seconds from the second
   * of the mint, so a state is valid up to TTL + 1 seconds after its mint. The spend comes after
   * the mint, so TTL + 1 seconds after the spend cover each state.
   */
  spend(nonce: string): boolean {
    const now = this.#now();
    for (const [key, until] of this.#spent) {
      if (until <= now) this.#spent.delete(key);
    }
    if (this.#spent.has(nonce)) return false;
    this.#spent.set(nonce, now + (CONFIRMATION_TTL_SECONDS + 1) * 1000);
    return true;
  }

  /**
   * Keeps the time of a rename of `roomId` by this server, for one hour. No error takes the note
   * back: alfaview can save the name and then refuse the rest of the call, and the note of a rename
   * that alfaview refused only makes the question more careful.
   */
  noteRename(roomId: string): void {
    const now = this.#now();
    for (const [other, at] of this.#renames) {
      if (now - at >= RENAME_NOTE_MS) this.#renames.delete(other);
    }
    this.#renames.set(roomId.toLowerCase(), now);
  }

  /** Returns the time of the last rename of `roomId` by this server within the last hour. */
  renamedAt(roomId: string): number | undefined {
    const at = this.#renames.get(roomId.toLowerCase());
    return at === undefined || this.#now() - at >= RENAME_NOTE_MS ? undefined : at;
  }

  /**
   * Keeps for one hour that this server sent `name` for the room `roomId`, before the request: a
   * create or a rename. Room names are not unique, so the question before a delete says when this
   * server sent the same name for another room. A create gives no `roomId`: the function that this
   * returns sets it once alfaview gives the ID. No error takes the note back, because alfaview can
   * save a room and then answer an error.
   */
  noteName(name: string, roomId?: string): (roomId: string) => void {
    const now = this.#now();
    this.#names = this.#names.filter((note) => now - note.at < RENAME_NOTE_MS);
    const note: NameNote = { name: nameKey(name), roomId: roomId?.toLowerCase() ?? null, at: now };
    this.#names.push(note);
    return (id) => {
      note.roomId = id.toLowerCase();
    };
  }

  /**
   * Returns the time of the last note of `name` (compared by nameKey) within the last hour whose
   * room is not `roomId`: another room, or a new room whose ID alfaview did not give.
   */
  sameNameAt(name: string, roomId: string): number | undefined {
    const key = nameKey(name);
    const id = roomId.toLowerCase();
    const now = this.#now();
    let at: number | undefined;
    for (const note of this.#names) {
      if (note.name === key && note.roomId !== id && now - note.at < RENAME_NOTE_MS) at = note.at;
    }
    return at;
  }
}

/**
 * Returns the capabilities that the client of `ctx` declared: on revision 2026-07-28 those of the
 * request, on the 2025 era those of `initialize`. The SDK checks a question against the same view.
 */
export function clientCapabilities(
  server: McpServer,
  ctx: ServerContext,
): ClientCapabilities | undefined {
  const revision = server.server.getNegotiatedProtocolVersion();
  if (revision !== undefined && revision >= FIRST_MODERN_REVISION) {
    const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
    return envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined;
  }
  return server.server.getClientCapabilities();
}

/**
 * Returns whether the client can get a question in form mode: it declares `elicitation.form`, or
 * an `elicitation` without `form` and `url`, which the MCP specification counts as form mode
 * (https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation). A value of
 * `elicitation` that is not an object counts too, as the SDK reads it. A client that declares
 * only URL mode cannot, and the SDK would refuse the question.
 */
export function canAskInForm(capabilities: ClientCapabilities | undefined): boolean {
  const elicitation = capabilities?.elicitation as unknown;
  if (elicitation === undefined) return false;
  if (typeof elicitation !== 'object' || elicitation === null) return true;
  const modes = elicitation as Record<string, unknown>;
  return modes.form !== undefined || modes.url === undefined;
}

/** A text field of the form of a question. */
export type FormField = {
  name: string;
  title: string;
  description: string;
  format?: 'email';
};

/** What a tool returns in the place of its output to ask the person. The wrapper sends it. */
export type PersonQuestion = {
  question: { message: string; field: FormField; id: string; round: 1 | 2 };
};

/** Returns the JSON Schema of the form of `field`: one text that the person must give. */
export function formSchema(field: FormField) {
  const { name, ...property } = field;
  return {
    type: 'object' as const,
    properties: { [name]: { type: 'string' as const, ...property } },
    required: [name],
  };
}

/** What a tool asks the person, and how it reads the answer. */
export type ConfirmRequest = {
  /** The ID of the room or the user of the input. */
  id: string;
  /** The text of the question. */
  message: string;
  field: FormField;
  /** Whether a typed value or the fallback parameter names the target. */
  matches(value: string): boolean;
  /**
   * The fallback parameter of a client that cannot ask. The model can fill it itself, so it
   * protects less than the question.
   */
  fallback: {
    value: string | undefined;
    /** The error when the call does not give it. */
    missingMessage: string;
    /** The error when it does not match. It never names the expected value. */
    mismatchMessage: string;
  };
};

export type ConfirmDecision =
  | { kind: 'delete'; confirmation: 'person' | 'parameter' }
  | { kind: 'keep'; confirmation: 'declined' | 'canceled' | 'mismatch' }
  | { kind: 'ask'; ask: PersonQuestion };

/** Returns the error text of a state of another tool or another ID, or of one used already. */
export function invalidConfirmationMessage(tool: string): string {
  return `The answer of the person does not fit this call or was used already, so nothing was deleted. Call ${tool} again, and the server asks the person again.`;
}

/** Returns the error text when the person gave no answer and the server does not ask again. */
export function noAnswerMessage(tool: string): string {
  return `The person did not answer the question, so nothing was deleted. Do not call ${tool} again unless the person asks.`;
}

/**
 * The question of one tool call. The wrapper makes it with the state and the answers of the
 * request. A tool calls `claim` before any request, then `decide` after its checks.
 *
 * Each round is a call of the tool with a signed request state, so no round depends on an earlier
 * request on the same connection. On revision 2026-07-28 the client fulfills the input_required
 * result of the tool. On the 2025 era the shim of the SDK sends elicitation/create and calls the
 * tool again.
 */
export class PersonConfirmation {
  readonly canAsk: boolean;
  readonly #store: Confirmations;
  readonly #tool: string;
  readonly #state: unknown;
  readonly #responses: unknown;
  #claimed: ConfirmationState | undefined;

  constructor(
    store: Confirmations,
    tool: string,
    canAsk: boolean,
    state: unknown,
    responses: unknown,
  ) {
    this.#store = store;
    this.#tool = tool;
    this.canAsk = canAsk;
    this.#state = state;
    this.#responses = responses;
  }

  /** The notes of the room names and renames that this server sent. */
  get renames(): Pick<Confirmations, 'noteRename' | 'renamedAt' | 'noteName' | 'sameNameAt'> {
    return this.#store;
  }

  /**
   * Checks the request state of a round after a question: it must be of this tool and of `id`, and
   * its nonce must not be spent. Then it spends the nonce. A state that fails throws
   * InvalidConfirmation. Without a state, it does nothing.
   */
  claim(id: string): void {
    if (this.#state === undefined) return;
    const parsed = CONFIRMATION_STATE.safeParse(this.#state);
    if (
      !parsed.success ||
      parsed.data.tool !== this.#tool ||
      parsed.data.id !== id.toLowerCase() ||
      !this.#store.spend(parsed.data.nonce)
    ) {
      throw new ToolError('InvalidConfirmation', invalidConfirmationMessage(this.#tool));
    }
    this.#claimed = parsed.data;
  }

  /**
   * Returns what the tool does after its checks. Without a state: the question of round 1 when the
   * client can ask, else the fallback parameter, which throws ConfirmationMissing or
   * ConfirmationMismatch when it does not confirm. With a state: the answer of the person. Round 1
   * without an answer asks once more when the client can still ask. Any other round without an
   * answer throws NoAnswer. The parameter never takes the place of the person.
   */
  decide(request: ConfirmRequest): ConfirmDecision {
    if (this.#state !== undefined && this.#claimed === undefined) {
      throw new TypeError('decide needs claim first in a round with a request state.');
    }
    const state = this.#claimed;
    if (state === undefined) {
      if (this.canAsk) return this.#ask(request, 1);
      const { value, missingMessage, mismatchMessage } = request.fallback;
      if (value === undefined) throw new ToolError('ConfirmationMissing', missingMessage);
      if (!request.matches(value)) throw new ToolError('ConfirmationMismatch', mismatchMessage);
      return { kind: 'delete', confirmation: 'parameter' };
    }

    const answer = inputResponse(
      this.#responses as Record<string, unknown> | undefined,
      CONFIRM_REQUEST,
    );
    if (answer.kind !== 'elicit') {
      if (state.round === 1 && this.canAsk) return this.#ask(request, 2);
      throw new ToolError('NoAnswer', noAnswerMessage(this.#tool));
    }
    if (answer.action === 'decline') return { kind: 'keep', confirmation: 'declined' };
    if (answer.action === 'cancel') return { kind: 'keep', confirmation: 'canceled' };
    // A blank answer confirms nothing, whatever the target holds.
    const typed = answer.content?.[request.field.name];
    return typeof typed === 'string' && typed.trim() !== '' && request.matches(typed)
      ? { kind: 'delete', confirmation: 'person' }
      : { kind: 'keep', confirmation: 'mismatch' };
  }

  #ask(request: ConfirmRequest, round: 1 | 2): ConfirmDecision {
    const { message, field } = request;
    return { kind: 'ask', ask: { question: { message, field, id: request.id.toLowerCase(), round } } };
  }
}

/** Returns whether `value` is the question of a tool, not its output. */
export function isPersonQuestion(value: object): value is PersonQuestion {
  return 'question' in value;
}

/** Returns the warning of a delete that the person did not confirm, for each outcome. */
export function keptWarning(
  confirmation: 'declined' | 'canceled' | 'mismatch',
  mismatch: string,
): string {
  const reason =
    confirmation === 'declined'
      ? 'The person declined.'
      : confirmation === 'canceled'
        ? 'The person canceled the question.'
        : mismatch;
  return `${reason} Nothing was deleted. Do not call this tool again unless the person asks.`;
}

/** Returns the note of the log line of a delete, by its outcome: never a value of the input. */
export function confirmationNote(confirmation: ConfirmationOutcome): string {
  switch (confirmation) {
    case 'person':
      return 'confirmed by the person';
    case 'parameter':
      return 'confirmed by the parameter';
    case 'declined':
      return 'declined by the person';
    case 'canceled':
      return 'canceled by the person';
    case 'mismatch':
      return 'not confirmed by the person';
  }
}
