// The tool definitions of the server, the wrapper that runs every tool call, and the parameters
// and result helpers that the tools share. The wrapper turns each error into a message for the
// model and removes the personal values that the option Personal data leaves out.
import {
  inputRequired,
  type CallToolResult,
  type InputRequiredResult,
  type McpServer,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
} from '@modelcontextprotocol/server';
import * as z from 'zod';
import { MinuteWindow, type AlfaviewClient, type CallApi } from '../alfaview/client.ts';
import { ToolError } from '../alfaview/errors.ts';
import { DEFAULT_ACCESS_LEVEL, type AccessLevel } from '../levels.ts';
import type { Logger } from '../log.ts';
import { isGuestUserId } from '../shared/guestUserId.ts';
import {
  leaveOutPersonalData,
  MEETING_ROOM_NAME_KEYS,
  type PERSONAL_KEYS,
  type PersonalDataMode,
  type PersonalDataShape,
} from '../shared/personalData.ts';
import type { PermissionKey } from '../shared/rooms.ts';
import { LOCALES } from '../shared/users.ts';
import { formatLocalTimestamp } from '../values/time.ts';
import {
  canAskInForm,
  clientCapabilities,
  CONFIRM_REQUEST,
  Confirmations,
  formSchema,
  isPersonQuestion,
  PersonConfirmation,
  type PersonQuestion,
} from './confirmation.ts';
import {
  advertisedOutput,
  outputProblem,
  unexpectedResponseMessage,
  unformedResultMessage,
} from './outputs.ts';

// Definitions

export type ToolContext = {
  api: CallApi;
  /** The time of the call's start in milliseconds since the epoch, read once. */
  now: number;
  /** The server's time zone: ALFAVIEW_TIME_ZONE, else Europe/Berlin. */
  timeZone: string;
  signal: AbortSignal;
  /**
   * The logger for the lines that a tool adds to the line of its call. A line never holds an
   * argument or a result.
   */
  log: Logger;
  /**
   * The option Personal data of the server (ALFAVIEW_PERSONAL_DATA). The wrapper removes the
   * personal values of the result, so a tool reads it only for a text of its own that depends on
   * the option, such as the error of a guest list that names an email address twice.
   */
  personalData: PersonalDataMode;
  /**
   * The access level of the server (ALFAVIEW_ACCESS_LEVEL), which decides the tools that the server
   * registers. A tool can read it for a rule of its own.
   */
  level: AccessLevel;
  /**
   * The question to the person of this call: whether the client can ask, the state and the answer
   * of an earlier round, and the renames and names of rooms by this server. delete_room and
   * delete_user read it, and create_room and update_room note room names in it.
   */
  confirmation: PersonConfirmation;
};

/** The data of a result: always an object, with each list under a key of its own. */
export type ToolData = Record<string, unknown>;

export type ToolOutput<Data = ToolData> = {
  /** One to three sentences with counts, IDs, times and states only: no text from alfaview. */
  summary: string;
  /** Sentences that the model must read. The wrapper adds them to the summary and the data. */
  warnings?: string[];
  /**
   * Words for the log line after `ok`, such as how a delete was confirmed. Never a value of the
   * input or the result.
   */
  note?: string;
  data: Data;
};

/** The data that `run` returns for the output schema `Output`: its keys without `warnings`. */
export type DataOf<Output extends z.ZodObject> = Omit<z.input<Output>, 'warnings'>;

/** The shapes of PERSONAL_KEYS for the results of this server. */
export type ToolResultShape = Extract<PersonalDataShape, `mcp.${string}`>;

/**
 * Where the data of a result holds personal values: `shape`, a shape of PERSONAL_KEYS, and `list`,
 * the key of the list whose entries have the shape, or no `list` when the data itself has it. With
 * Leave out, the wrapper sets the personal values of the shape to null, also the name of a meeting
 * room in a room of `mcp.room`. A result without a personal value names the shape of its resource,
 * which then changes nothing and adds no key, as the result of a delete does.
 */
export type ToolPersonalData = {
  shape: ToolResultShape;
  list?: string;
};

export type ToolDefinition<Input extends z.ZodObject, Output extends z.ZodObject = z.ZodObject> = {
  name: string;
  /**
   * The lowest access level that registers the tool. Each tool of `full` has a description that
   * starts with `Cannot be undone:` or `Changes who has access:`, and no other tool has one.
   */
  level: AccessLevel;
  title: string;
  description: string;
  /**
   * The description with Personal data set to Leave out, for a tool whose description offers a
   * value that Leave out removes. Without it, the description is the same in both modes.
   */
  descriptionWithoutPersonalData?: string;
  inputSchema: Input;
  /**
   * The input schema with Personal data set to Leave out, for a tool whose parameter text offers a
   * value that Leave out removes. It differs from `inputSchema` in its texts only, so a call reads
   * the same input in both modes. Without it, the schema is the same in both modes.
   */
  inputSchemaWithoutPersonalData?: Input;
  annotations: ToolAnnotations;
  /**
   * The sentence that the wrapper adds to the text of a 403 (the ToolError code Forbidden): the
   * user permission that the tool needs. The description leaves it out, so the model reads it only
   * when it meets the error, not in every request. A tool whose 403 has a text of its own in the
   * domain functions has none.
   */
  forbiddenHint?: string;
  /**
   * Where the data of a result holds personal values. Every tool must name it, so that the wrapper
   * removes the personal values of each result.
   */
  personalData: ToolPersonalData;
  /**
   * The strict shape of the data of a result, `warnings` included (toolOutput of
   * src/tools/outputs.ts). The server registers its open form as the output schema, and the
   * wrapper checks each result with it. The tests check each result against the strict shape.
   */
  output: Output;
  /**
   * For a tool that changes something: the tool that reads the change. The error of a result that
   * does not fit `output` names it, because the change is done.
   */
  readTool?: string;
  /** Returns the output of the call, or a question to the person in its place. */
  run(
    input: z.output<Input>,
    context: ToolContext,
  ): Promise<ToolOutput<DataOf<Output>> | PersonQuestion>;
};

export type AnyTool = ToolDefinition<z.ZodObject, z.ZodObject>;

/** Keeps the input and output types of one definition and returns it for a tool list. */
export function defineTool<Input extends z.ZodObject, Output extends z.ZodObject>(
  definition: ToolDefinition<Input, Output>,
): AnyTool {
  return definition as unknown as AnyTool;
}

/** What the wrapper needs from the server. */
export type ToolDeps = {
  client: AlfaviewClient;
  log: Logger;
  timeZone: string;
  /**
   * The option Personal data (ALFAVIEW_PERSONAL_DATA). Default `include`, which gives every value.
   */
  personalData?: PersonalDataMode;
  /**
   * The access level (ALFAVIEW_ACCESS_LEVEL). Default `standard`. createServer always passes the
   * level of its ServerDeps, which requires one.
   */
  level?: AccessLevel;
  /** Date.now by default. Tests pass a fixed clock or one that they move. */
  now?: () => number;
  /**
   * The tool calls of the last minute, for the limit of TOOL_CALLS_PER_MINUTE. The servers of one
   * process share it. registerTools makes one when it is missing.
   */
  toolCalls?: MinuteWindow;
  /**
   * The key of the request states, the spent nonces, and the room names and renames that this
   * server sent. The servers of one process share it, and each server checks the request states
   * with its `verify`. registerTools needs it. A direct call of runTool without it, which cannot
   * ask, makes one.
   */
  confirmations?: Confirmations;
};

/** What the wrapper reads of a request for the question to the person. */
export type ToolRequest = {
  /** Whether the client can ask the person in form mode (canAskInForm). */
  canAsk: boolean;
  /** The request state as the SDK checked it, or undefined in round 1. */
  state: unknown;
  /** The answers of the person to the question of the last round. */
  responses: unknown;
  /** Returns a signed request state for the tool's question about `id` in `round`. */
  mint(id: string, round: 1 | 2): Promise<string>;
};

/** The error of a question in a call that cannot send one, which only a test makes. */
export const NO_QUESTION_MESSAGE = 'This call cannot ask the person.';

/** The request of a call outside an MCP request: it cannot ask the person. */
const WITHOUT_QUESTIONS: ToolRequest = {
  canAsk: false,
  state: undefined,
  responses: undefined,
  mint: () => Promise.reject(new TypeError(NO_QUESTION_MESSAGE)),
};

/**
 * The most tool calls that the wrapper takes in a minute. The MCP specification requires a server
 * to rate limit tool calls:
 * https://modelcontextprotocol.io/specification/2025-06-18/server/tools#security-considerations
 */
export const TOOL_CALLS_PER_MINUTE = 120;

export const TOOL_CALLS_RATE_LIMITED_MESSAGE = `The alfaview MCP server takes at most ${TOOL_CALLS_PER_MINUTE} tool calls a minute. Wait a minute and call again.`;

/** Returns the description that the server gives the client for `tool` in `mode`. */
export function toolDescription(tool: AnyTool, mode: PersonalDataMode): string {
  return mode === 'omit'
    ? (tool.descriptionWithoutPersonalData ?? tool.description)
    : tool.description;
}

/** Returns the input schema that the server gives the client for `tool` in `mode`. */
export function toolInputSchema(tool: AnyTool, mode: PersonalDataMode): z.ZodObject {
  return mode === 'omit'
    ? (tool.inputSchemaWithoutPersonalData ?? tool.inputSchema)
    : tool.inputSchema;
}

/**
 * The place of the server's time zone in a parameter text. `advertised` puts the zone of the
 * server (ALFAVIEW_TIME_ZONE, else Europe/Berlin) in its place, so each date parameter names the
 * zone that reads a time without an offset.
 */
export const TIME_ZONE_SLOT = '{timeZone}';

type JsonValue = unknown;

/**
 * Returns `node` as the server advertises it: without `$schema`, with `format: uuid` in the place
 * of the UUID pattern, without `minLength: 1`, without a `maximum` that is the largest safe
 * integer, and with `timeZone` in the place of TIME_ZONE_SLOT in each description. The keys keep
 * their order.
 */
function slimJsonSchema(node: JsonValue, timeZone: string): JsonValue {
  if (Array.isArray(node)) return node.map((entry) => slimJsonSchema(entry, timeZone));
  if (node === null || typeof node !== 'object') return node;
  const slim: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema') continue;
    if (key === 'minLength' && value === 1) continue;
    if (key === 'maximum' && value === Number.MAX_SAFE_INTEGER) continue;
    if (key === 'pattern' && value === UUID_PATTERN.source) {
      slim.format = 'uuid';
    } else if (key === 'description' && typeof value === 'string') {
      slim[key] = value.replaceAll(TIME_ZONE_SLOT, timeZone);
    } else {
      slim[key] = slimJsonSchema(value, timeZone);
    }
  }
  return slim;
}

/**
 * Returns the input schema that the server registers for `schema`: a Standard Schema whose check is
 * the check of zod, so the messages of the checks do not change, and whose JSON Schema is the
 * output of zod for JSON Schema 2020-12 after the steps of slimJsonSchema. The steps save bytes of
 * each tool list and remove only what the model needs no word for: the default dialect, the long
 * pattern of an ID, a minimum length of 1 and the largest safe integer. zod still checks the
 * pattern, the length and the maximum.
 */
export function advertised<Input extends z.ZodObject>(
  schema: Input,
  timeZone: string,
): StandardSchemaWithJSON<z.input<Input>, z.output<Input>> {
  const json = slimJsonSchema(
    z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }),
    timeZone,
  ) as Record<string, unknown>;
  const standard = schema['~standard'];
  // An input schema has one JSON Schema: the SDK advertises the input side.
  const jsonSchema = () => json;
  return {
    '~standard': {
      version: 1,
      vendor: standard.vendor,
      validate: standard.validate,
      jsonSchema: { input: jsonSchema, output: jsonSchema },
    },
  };
}

/**
 * Returns `data` without the personal values of `personalData` in `mode`: with `include` it is
 * `data` itself, with `omit` a copy with the same keys. A `list` that names no list of `data` is a
 * mistake of the tool, so it throws in both modes, and the tests of every tool find it: the
 * removal never misses a list in silence.
 */
export function withoutPersonalData(
  data: ToolData,
  personalData: ToolPersonalData,
  mode: PersonalDataMode,
): ToolData {
  const { shape, list } = personalData;
  if (list !== undefined && !Array.isArray(data[list])) {
    throw new TypeError(`The result has no list ${list} for the option Personal data.`);
  }
  if (mode === 'include') return data;
  if (list === undefined) return leaveOutPersonalData(shape, data, mode);
  return { ...data, [list]: leaveOutPersonalData(shape, data[list], mode) };
}

/**
 * The kinds of personal values that Leave out sets to null, in the order in which the warning of
 * leftOutWarning names them.
 */
export const LEFT_OUT_KINDS = [
  'names',
  'email addresses',
  'titles',
  'cities',
  'initials',
  'meeting titles',
  'the names of meeting rooms',
  'agendas',
  'welcome notes',
  'origins',
] as const;

type LeftOutKind = (typeof LEFT_OUT_KINDS)[number];

type PersonalPath<Shape extends ToolResultShape> = (typeof PERSONAL_KEYS)[Shape][number];

/**
 * The kind of each path of PERSONAL_KEYS for the shapes of this server. The type needs a kind for
 * each path, so a new path of PERSONAL_KEYS fails the type check until it has one. The kind is
 * null for an echo of the input of the call, such as `originContains`: the model gave that value,
 * so the warning does not name it as a value of alfaview.
 */
const KIND_OF_PATH: {
  [Shape in ToolResultShape]: Record<PersonalPath<Shape>, LeftOutKind | null>;
} = {
  'mcp.room': { waitingRoomWelcomeNote: 'welcome notes' },
  'mcp.guestLink': { emailAddress: 'email addresses', displayName: 'names', origin: 'origins' },
  'mcp.createGuestLinksResult': {
    'results[].emailAddress': 'email addresses',
    'results[].displayName': 'names',
  },
  // The filter text of the call.
  'mcp.deleteExpiredGuestLinksResult': { originContains: null },
  'mcp.meeting': { title: 'meeting titles', agenda: 'agendas' },
  'mcp.participant': {
    displayName: 'names',
    emailAddress: 'email addresses',
    guestLinkOrigin: 'origins',
  },
  'mcp.roomAttendance': {
    attendedEmails: 'email addresses',
    noShowEmails: 'email addresses',
    // The origin of the call. The origin of each invited person is a value of alfaview.
    origin: null,
    'invitees[].emailAddress': 'email addresses',
    'invitees[].displayName': 'names',
    'invitees[].origin': 'origins',
    'otherAttendees[].emailAddress': 'email addresses',
    'otherAttendees[].displayName': 'names',
  },
  'mcp.guestLinkAttendance': { emailAddress: 'email addresses', displayName: 'names' },
  'mcp.passcode': {},
  'mcp.statistics': {},
  'mcp.account': {
    'user.emailAddress': 'email addresses',
    'user.firstName': 'names',
    'user.lastName': 'names',
    'user.title': 'titles',
    'user.city': 'cities',
    'user.initials': 'initials',
  },
  'mcp.user': {
    emailAddress: 'email addresses',
    firstName: 'names',
    lastName: 'names',
    title: 'titles',
    city: 'cities',
    initials: 'initials',
  },
  'mcp.roomSettings': {},
  'mcp.breakoutRoom': {},
  'mcp.groupLink': { origin: 'origins' },
  'mcp.roomPermission': { userName: 'names' },
};

/**
 * Adds to `found` the path of each value that is not null in `before` and null in `after`, as
 * PERSONAL_KEYS writes a path: the index of a list is `[]`, as in `invitees[].emailAddress`. An
 * empty list, such as `attendedEmails` of a window without invited people, holds no value, so it
 * does not count. `after` is the copy of withoutPersonalData, so it has the keys and lists of
 * `before`.
 */
function nulledPaths(before: unknown, after: unknown, path: string, found: Set<string>): void {
  if (after === null) {
    const empty =
      before === null || before === undefined || (Array.isArray(before) && before.length === 0);
    if (!empty) found.add(path);
    return;
  }
  if (Array.isArray(before)) {
    const entries = after as unknown[];
    before.forEach((entry, index) => nulledPaths(entry, entries[index], `${path}[]`, found));
    return;
  }
  if (typeof before !== 'object' || before === null) return;
  const values = after as Record<string, unknown>;
  for (const [key, value] of Object.entries(before)) {
    nulledPaths(value, values[key], path === '' ? key : `${path}.${key}`, found);
  }
}

/**
 * Returns the warning of a result with Leave out: `data` is the data of `run`, and `shown` the same
 * data after withoutPersonalData. When the removal set at least one value of alfaview to null, the
 * warning names the kinds of these values in the order of LEFT_OUT_KINDS. It says that the option
 * Personal data of the server leaves them out, and that a null can stand for a value that alfaview
 * has. It does not say that each null does, because alfaview can give a null too. It holds no
 * value of the result. Without such a value, it is undefined, so a result without a personal
 * value, or with only an echo of the input, gets no warning.
 */
export function leftOutWarning(
  data: ToolData,
  shown: ToolData,
  personalData: ToolPersonalData,
): string | undefined {
  const nulled = new Set<string>();
  nulledPaths(data, shown, '', nulled);
  const { shape, list } = personalData;
  const prefix = list === undefined ? '' : `${list}[].`;
  const kinds = new Set<LeftOutKind>();
  const kindOfPath: Record<string, LeftOutKind | null> = KIND_OF_PATH[shape];
  for (const [path, kind] of Object.entries(kindOfPath)) {
    if (kind !== null && nulled.has(`${prefix}${path}`)) kinds.add(kind);
  }
  for (const key of MEETING_ROOM_NAME_KEYS[shape] ?? []) {
    if (nulled.has(`${prefix}${key}`)) kinds.add('the names of meeting rooms');
  }
  if (kinds.size === 0) return undefined;
  const named = listed(
    LEFT_OUT_KINDS.filter((kind) => kinds.has(kind)),
    'and',
  );
  return `This server leaves out personal data (option Personal data, Leave out): ${named} are null, also where alfaview has a value.`;
}

export const READ_ANNOTATIONS: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };

export const CREATE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * Updates that can send an email, cancels, new passcodes and the cleanup of expired links: they
 * overwrite or cannot be undone, and a repeat can have more effect (another email, another
 * passcode, more deleted links).
 */
export const CHANGE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * A change that overwrites or removes, and whose repeat with the same arguments has no more
 * effect, such as the update of a room or the delete of one link.
 */
export const IDEMPOTENT_CHANGE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * The add of a room permission: it only adds an entry, and a repeat adds nothing more, because
 * alfaview answers 409 for an entry that exists.
 */
export const ADD_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

// The wrapper

export const INTERNAL_ERROR_MESSAGE =
  'The alfaview MCP server failed unexpectedly. Its log has the details.';

function requestCount(count: number): string {
  return count === 1 ? '1 request' : `${count} requests`;
}

/**
 * Returns the tool result: `shown` with `warnings` as its last key, and the summary of `output`
 * with each warning appended. A client that passes only the structured content to the model still
 * gets the warnings. The JSON text and the structured content are the same object, so both hold
 * the data of withoutPersonalData. `leftOut`, the warning of leftOutWarning, comes after the
 * warnings of the tool.
 */
function toolResult(
  output: ToolOutput,
  shown: ToolData,
  leftOut: string | undefined,
): CallToolResult {
  const warnings = [...(output.warnings ?? []), ...(leftOut === undefined ? [] : [leftOut])];
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(shown)) {
    if (key !== 'warnings') data[key] = value;
  }
  data.warnings = warnings;
  return {
    content: [
      { type: 'text', text: [output.summary, ...warnings].join(' ') },
      { type: 'text', text: JSON.stringify(data) },
    ],
    structuredContent: data,
  };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Runs one tool call: the API of the call, `run`, the result, and one log line with the outcome,
 * the request count and the duration. A call over the limit of `deps.toolCalls` gives RateLimited
 * before `run`, so before any check or request of the tool. registerTools always gives the limit.
 * The result holds the data of `run` without the personal values of the tool's shape when
 * Personal data is set to Leave out, and then the warning of leftOutWarning after the warnings of
 * the tool when the removal set a value of alfaview to null. A ToolError gives its message to the
 * model, and a 403 adds the forbiddenHint of the tool. Any other error gives
 * INTERNAL_ERROR_MESSAGE, and the log gets its name and stack frames, never its message.
 *
 * Data that does not fit the open form of the tool's output schema gives an error result before
 * the SDK checks it, and the log gets the code OutputShape with the path of the key. The text of a
 * tool that only reads says that alfaview sent an unexpected response. The text of any other tool
 * says that the change is done, so the model does not repeat a write that the SDK would turn into
 * an error after alfaview saved it.
 *
 * A tool that asks the person gets an input_required result with the question in form mode and a
 * request state that `request` signs, and the log line says `asks the person (round {round})`.
 * Without `request`, the call cannot ask.
 */
export async function runTool(
  tool: AnyTool,
  input: Record<string, unknown>,
  signal: AbortSignal,
  deps: ToolDeps,
  request: ToolRequest = WITHOUT_QUESTIONS,
): Promise<CallToolResult | InputRequiredResult> {
  const now = (deps.now ?? Date.now)();
  const personalData = deps.personalData ?? 'include';
  const api = deps.client.forCall(signal, { personalData });
  const usage = () => `${requestCount(api.requestCount)}, ${api.elapsedMs()} ms`;
  const confirmation = new PersonConfirmation(
    deps.confirmations ?? new Confirmations(deps.now),
    tool.name,
    request.canAsk,
    request.state,
    request.responses,
  );
  try {
    if (deps.toolCalls?.tryStart() === false) {
      throw new ToolError('RateLimited', TOOL_CALLS_RATE_LIMITED_MESSAGE);
    }
    const output = await tool.run(input, {
      api,
      now,
      timeZone: deps.timeZone,
      signal,
      log: deps.log,
      personalData,
      level: deps.level ?? DEFAULT_ACCESS_LEVEL,
      confirmation,
    });
    if (isPersonQuestion(output)) {
      const { message, field, id, round } = output.question;
      const requestState = await request.mint(id, round);
      deps.log.info(`tool ${tool.name}: asks the person (round ${round}), ${usage()}`);
      return inputRequired({
        inputRequests: {
          [CONFIRM_REQUEST]: inputRequired.elicit({ message, requestedSchema: formSchema(field) }),
        },
        requestState,
      });
    }
    const shown = withoutPersonalData(output.data, tool.personalData, personalData);
    const leftOut =
      personalData === 'omit' ? leftOutWarning(output.data, shown, tool.personalData) : undefined;
    const result = toolResult(output, shown, leftOut);
    const problem = outputProblem(tool.output, result.structuredContent);
    if (problem !== undefined) {
      deps.log.info(`tool ${tool.name}: OutputShape (${problem}), ${usage()}`);
      return errorResult(
        tool.annotations.readOnlyHint === true
          ? unexpectedResponseMessage(tool.name)
          : unformedResultMessage(tool.name, tool.readTool),
      );
    }
    const note = output.note === undefined ? '' : `, ${output.note}`;
    deps.log.info(`tool ${tool.name}: ok${note}, ${usage()}`);
    return result;
  } catch (error) {
    if (error instanceof ToolError) {
      deps.log.info(`tool ${tool.name}: ${error.code}, ${usage()}`);
      const hint =
        error.code === 'Forbidden' && tool.forbiddenHint !== undefined
          ? ` ${tool.forbiddenHint}`
          : '';
      return errorResult(`${error.message}${hint}`);
    }
    deps.log.error(`tool ${tool.name}: internal error, ${usage()}`, error);
    return errorResult(INTERNAL_ERROR_MESSAGE);
  }
}

/**
 * Registers `tools` in their order, each with its description and its advertised input schema for
 * the option Personal data and the time zone of `deps`, and its advertised output schema, which is
 * the same in both values of the option. The SDK checks each call's arguments with zod before
 * `run`, and an argument list that the client leaves out counts as `{}`. The tools share the limit
 * of `deps.toolCalls`, or a limit of their own when `deps` has none. They share the confirmations
 * of `deps.confirmations`, whose `verify` the server must have as `requestState.verify`
 * (protocolOptions of src/server.ts). Each call reads from its request whether the client can ask
 * the person, and the state and the answers of an earlier round.
 */
export function registerTools(
  server: McpServer,
  tools: readonly AnyTool[],
  deps: ToolDeps & { confirmations: Confirmations },
): void {
  const mode = deps.personalData ?? 'include';
  const { confirmations } = deps;
  const limited: ToolDeps = {
    ...deps,
    toolCalls: deps.toolCalls ?? new MinuteWindow(TOOL_CALLS_PER_MINUTE, deps.now),
  };
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: toolDescription(tool, mode),
        inputSchema: advertised(toolInputSchema(tool, mode), deps.timeZone),
        outputSchema: advertisedOutput(tool.output),
        annotations: tool.annotations,
      },
      (input: Record<string, unknown>, ctx) =>
        runTool(tool, input, ctx.mcpReq.signal, limited, {
          canAsk: canAskInForm(clientCapabilities(server, ctx)),
          state: ctx.mcpReq.requestState(),
          responses: ctx.mcpReq.inputResponses,
          mint: (id, round) => confirmations.mint(tool.name, id, round, ctx),
        }),
    );
  }
}

// Shared parameters

/**
 * The form of an alfaview ID. alfaview IDs are UUIDs of more than one version, so the pattern does
 * not check the version. It spells out both cases instead of the flag `i`, because a JSON Schema
 * pattern carries no flags. The advertised schema has `format: uuid` in its place (advertised),
 * and zod checks this pattern.
 */
export const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The nil UUID, which no alfaview resource has. */
const NIL_UUID = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;

/**
 * The kinds of alfaview IDs that a room ID parameter refuses: a user and a guest, by byte 10 of a
 * version 5 UUID, 0x12 for a user and 0x18 for a guest. The layout is observed, not part of the
 * API docs. An ID of another layout, also a guest link ID, gets the answer of the room lookup.
 */
export type OtherIdKind = 'user' | 'guest';

const OTHER_ID_KIND_NAMES: Record<OtherIdKind, string> = {
  user: 'a user ID',
  guest: 'the ID of a guest',
};

/**
 * Returns the kind of `id` when it is the ID of a user or a guest, else undefined. Only a version
 * 5 UUID names its kind: isUserId of src/domain/users.ts also takes a version 4 UUID, which an
 * older room can have too, so this check does not use it. The guest check is isGuestUserId.
 */
export function otherIdKind(id: string): OtherIdKind | undefined {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-12[0-9a-f]{10}$/i.test(id)) {
    return 'user';
  }
  if (isGuestUserId(id)) return 'guest';
  return undefined;
}

/** What an ID parameter refuses besides a value that is not a UUID. */
export type IdRule = {
  /** The parameter, as the messages name it. */
  parameter: string;
  /** The tool that gives the ID, which the message of the nil UUID names. */
  source: string;
  /** The message for an ID of another kind. Only a room ID parameter has it. */
  otherKind?: (kind: OtherIdKind, id: string) => string;
};

/**
 * Returns the message for a UUID that `rule` refuses, or undefined: the nil UUID, and with
 * `otherKind` the ID of a user or a guest. A value that is not a UUID gives undefined, because it
 * gets the message of the pattern.
 */
export function idProblem(rule: IdRule, id: string): string | undefined {
  if (!UUID_PATTERN.test(id)) return undefined;
  if (NIL_UUID.test(id)) {
    return `${rule.parameter} ${id} is no ID. Call ${rule.source} first and use an ID from its result.`;
  }
  const kind = rule.otherKind === undefined ? undefined : otherIdKind(id);
  return kind === undefined ? undefined : rule.otherKind!(kind, id);
}

/**
 * Returns an ID parameter: a UUID, with a message that names the tool that gives the ID, and the
 * checks of `rule`. The checks run in zod, so they cost no byte of the advertised schema and
 * refuse the call before any request.
 */
export function idParameter(rule: IdRule, message: string, description: string) {
  return z
    .string()
    .trim()
    .regex(UUID_PATTERN, message)
    .superRefine((id, context) => {
      const problem = idProblem(rule, id);
      if (problem !== undefined) context.addIssue({ code: 'custom', message: problem });
    })
    .describe(description);
}

/** The rule of a room ID: the nil UUID, and the ID of a user or a guest. */
export const ROOM_ID_RULE: IdRule = {
  parameter: 'roomId',
  source: 'find_rooms',
  otherKind: (kind, id) =>
    `roomId ${id} is ${OTHER_ID_KIND_NAMES[kind]}, not a room ID. Give a room ID from find_rooms.`,
};

export const ROOM_ID_MESSAGE = 'roomId takes an ID from find_rooms, or a meeting ID, not a name.';
export const GUEST_LINK_ID_MESSAGE =
  'guestLinkId takes an ID from find_guest_links or create_guest_links.';
export const MEETING_ID_MESSAGE = 'meetingId takes an ID from find_meetings or create_meeting.';
export const SUBROOM_ID_MESSAGE =
  'subroomId takes a breakout room ID from get_room or create_breakout_room.';
export const GROUP_LINK_ID_MESSAGE =
  'groupLinkId takes an ID from find_group_links or create_group_link.';
export const ROOM_ID_NOT_MEETING_MESSAGE =
  'roomId takes a room ID from find_rooms, not a name or a meeting ID.';
export const USER_ID_MESSAGE =
  'userId takes an ID from find_users, not a name or an email address.';

/**
 * The room ID of most tools. A meeting ID also works, which the server instructions say once for
 * all tools.
 */
export const roomIdParameter = idParameter(
  ROOM_ID_RULE,
  ROOM_ID_MESSAGE,
  'Room ID from find_rooms.',
);

/** Returns the room ID schema with a description of its own, and optionally a rule of its own. */
export function roomIdWith(description: string, rule: IdRule = ROOM_ID_RULE) {
  return idParameter(rule, ROOM_ID_MESSAGE, description);
}

/**
 * Returns the room ID schema of a tool that refuses a meeting room, with a description of its own.
 * Its message does not offer a meeting ID.
 */
export function roomIdNotMeetingWith(description: string) {
  return idParameter(ROOM_ID_RULE, ROOM_ID_NOT_MEETING_MESSAGE, description);
}

export const guestLinkIdParameter = idParameter(
  { parameter: 'guestLinkId', source: 'find_guest_links' },
  GUEST_LINK_ID_MESSAGE,
  'Guest link ID from find_guest_links or create_guest_links.',
);

export const meetingIdParameter = idParameter(
  { parameter: 'meetingId', source: 'find_meetings' },
  MEETING_ID_MESSAGE,
  'Meeting ID from find_meetings or create_meeting.',
);

/** The ID of a breakout room (the API calls it a subroom). */
export const subroomIdParameter = idParameter(
  { parameter: 'subroomId', source: 'get_room' },
  SUBROOM_ID_MESSAGE,
  'Breakout room ID from get_room or create_breakout_room.',
);

export const groupLinkIdParameter = idParameter(
  { parameter: 'groupLinkId', source: 'find_group_links' },
  GROUP_LINK_ID_MESSAGE,
  'Group link ID from find_group_links or create_group_link.',
);

/**
 * Returns the user ID schema with a description of its own. It checks the UUID form and the nil
 * UUID only: each tool then refuses an ID that is not the ID of a user with isUserId of
 * src/domain/users.ts, before any request.
 */
export function userIdWith(description: string) {
  return idParameter({ parameter: 'userId', source: 'find_users' }, USER_ID_MESSAGE, description);
}

export const userIdParameter = userIdWith('User ID from find_users.');

/** Returns a room permission parameter, which the call gives or leaves out. */
function roomPermissionParameter(description: string) {
  return z.boolean().describe(description).optional();
}

/**
 * The nine room permissions of the room permission tools, in the order of PERMISSION_INPUT_ORDER
 * of src/shared/rooms.ts. The names are the keys of the API.
 */
export const ROOM_PERMISSION_PARAMETERS = {
  admin: roomPermissionParameter('Can change and delete the room, its settings and guests.'),
  join: roomPermissionParameter('Can join the room.'),
  voice: roomPermissionParameter('Can speak.'),
  video: roomPermissionParameter('Can send video.'),
  screen: roomPermissionParameter('Can share the screen.'),
  chat: roomPermissionParameter('Can chat.'),
  upload: roomPermissionParameter('Can upload files.'),
  promote: roomPermissionParameter('Can change the permissions of others.'),
  vip: roomPermissionParameter('Can mark people as VIP.'),
} satisfies Record<PermissionKey, z.ZodOptional<z.ZodBoolean>>;

/** Returns a text parameter: trimmed, at least 1 character, so a value of only spaces fails. */
export function textParameter(description: string, maxLength?: number) {
  const text = z.string().trim().min(1);
  return (maxLength === undefined ? text : text.max(maxLength)).describe(description);
}

/**
 * The zone that reads a date parameter without an offset: the tool's `timezone` parameter, else
 * the server's time zone, or the server's time zone alone for a tool without that parameter.
 */
export type DateTimeZone = 'timezone' | 'server';

/**
 * Returns a date and time parameter, which the tool reads with readDateTime. The description names
 * the zone that reads a time without an offset, because a client may drop the server's
 * instructions: the zone of the server by its name, such as Europe/Berlin, which `advertised` puts
 * in the place of TIME_ZONE_SLOT. A name is clearer than "the server's time zone": the server
 * runs on the user's computer, but its zone need not be the computer's zone. The description shows
 * one ISO form, which a model writes. readDateTime also accepts other forms.
 */
export function dateTimeParameter(meaning: string, zone: DateTimeZone) {
  const readIn =
    zone === 'timezone'
      ? `Local time in timezone, else in ${TIME_ZONE_SLOT}, unless it has an offset`
      : `Local time in ${TIME_ZONE_SLOT} unless it has an offset`;
  return z
    .string()
    .trim()
    .min(1)
    .max(64)
    .describe(`${meaning} ${readIn}, for example 2026-10-27T10:00.`);
}

/**
 * Returns a time zone parameter, which the tool reads with readTimeZone, with the zone of the
 * server as its default.
 */
export function timezoneParameter(use: string) {
  return z
    .string()
    .trim()
    .min(1)
    .max(64)
    .describe(
      `${use} An IANA name. It is also the zone of times without an offset and of the result. Default: ${TIME_ZONE_SLOT}.`,
    );
}

export const localeParameter = z
  .enum(LOCALES)
  .describe("Language of the join page and of alfaview's emails.");

export function limitParameter(items: string, max: number, defaultValue: number) {
  return z
    .number()
    .int()
    .min(1)
    .max(max)
    .default(defaultValue)
    .describe(`The most ${items} to return.`);
}

/**
 * Returns the offset parameter of a list. The advertised schema leaves out its maximum, the largest
 * safe integer, which zod still checks.
 */
export function offsetParameter() {
  return z.number().int().min(0).default(0).describe('The nextOffset of the previous result.');
}

// Result helpers

/** Returns the count with its noun, such as `1 room` or `2 rooms`. */
export function count(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

/** Joins the names as `a`, `a and b` or `a, b and c`, with `conjunction` before the last one. */
export function listed(names: readonly string[], conjunction: 'and' | 'or'): string {
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} ${conjunction} ${names.at(-1)}`;
}

/**
 * Returns `valid from {validFrom} until {validUntil}` as local times in `timeZone` with the zone
 * name, with words for a missing bound: the validity of a guest link or a group link in a summary.
 */
export function validity(validFrom: unknown, validUntil: unknown, timeZone: string): string {
  const from = formatLocalTimestamp(validFrom, timeZone) ?? 'any time';
  const until = formatLocalTimestamp(validUntil, timeZone) ?? 'no end';
  return `valid from ${from} until ${until}`;
}

/** One part of a sorted list: `limit` items from `offset`. */
export type ListPart<T> = {
  /** The matches after the filters, before offset and limit. */
  totalMatches: number;
  offset: number;
  /** The offset of the next part, or `null` when no match follows the returned ones. */
  nextOffset: number | null;
  items: T[];
};

export function listPart<T>(matches: readonly T[], offset: number, limit: number): ListPart<T> {
  const items = matches.slice(offset, offset + limit);
  const end = offset + items.length;
  return {
    totalMatches: matches.length,
    offset,
    nextOffset: items.length > 0 && end < matches.length ? end : null,
    items,
  };
}

/**
 * Returns the paging text of a summary, which starts with a space: `Showing {first} to {last}.`
 * with the paging sentence when more follow, `Nothing at offset {offset}.` beyond the matches, and
 * an empty text without matches. `items` names what is shown (`Showing invited people 1 to 10.`),
 * and `ofTotal` adds the number of matches (`Showing 1 to 20 of 31.`), for summaries that do not
 * state it before.
 */
export function showing(
  part: ListPart<unknown>,
  options: { items?: string; ofTotal?: boolean } = {},
): string {
  if (part.items.length === 0) {
    return part.totalMatches === 0 ? '' : ` Nothing at offset ${part.offset}.`;
  }
  const items = options.items === undefined ? '' : `${options.items} `;
  const last = part.offset + part.items.length;
  const total = options.ofTotal === true ? ` of ${part.totalMatches}` : '';
  const next =
    part.nextOffset === null ? '' : ` Call again with offset ${part.nextOffset} for the next ones.`;
  return ` Showing ${items}${part.offset + 1} to ${last}${total}.${next}`;
}
