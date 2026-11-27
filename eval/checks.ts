// The checks of the eval tasks. A check reads the outcome of a run: the state of the fake API
// before and after the run, the requests that reached it, the questions of the server to the
// person, and the final text of the agent. A check never names a tool, so the checks stay true
// when tools merge or get new names.
import type { FakeRequest, FakeState } from '../test/fake-api/server.ts';
import type { Clock } from './clock.ts';
import type { ElicitationLogEntry } from './elicitation.ts';

/** An alfaview object as JSON, as the fake API keeps it. */
export type Json = Record<string, any>;

/** What the checks of a run read. */
export type RunOutcome = {
  /** The state of the fake API before the run, after the seed of the task. */
  initial: FakeState;
  /** The state of the fake API after the run. */
  state: FakeState;
  /** Every request that reached the fake API, the login included, in order. */
  requests: readonly FakeRequest[];
  /** The questions of the server to the person (MCP elicitation) and the answers of the person. */
  elicitations: readonly ElicitationLogEntry[];
  /** The final text of the agent. */
  answer: string;
  clock: Clock;
};

export type Check = {
  /** What the check expects, in a few words. */
  reason: string;
  /**
   * `state` reads the fake API (the state and the requests), `question` the questions of the
   * server to the person, and `answer` the final text.
   */
  kind: 'state' | 'question' | 'answer';
  test(outcome: RunOutcome): boolean;
};

export type CheckResult = { reason: string; kind: Check['kind']; passed: boolean };

export const LOGIN_PATH = '/v2/auth/api-key';

/** The body fields with which a request asks alfaview to send an email. */
const EMAIL_FLAGS = ['sendEmail', 'sendNotification'];

// Reading the outcome

/** Returns the requests that can change something: all but GET and the login. */
export function writesOf(requests: readonly FakeRequest[]): FakeRequest[] {
  return requests.filter(
    (request) => request.method !== 'GET' && !(request.method === 'POST' && request.path === LOGIN_PATH),
  );
}

/**
 * Returns whether the fake API saved the request: it answered with success, or a fault answered
 * after the fake applied the request (FakeFault).
 */
export function savedOf(request: FakeRequest): boolean {
  return request.status < 300 || request.fault?.applied === true;
}

/**
 * Returns whether a GET of one of `paths` got an answer with success. The paths compare without
 * case and without the query.
 */
export function readsAny(requests: readonly FakeRequest[], paths: readonly string[]): boolean {
  const wanted = paths.map((path) => path.toLowerCase());
  return requests.some(
    (request) => request.method === 'GET' && request.status < 300 && wanted.includes(request.path.toLowerCase()),
  );
}

/** Returns whether `value` holds one of `keys` with the value true, at any depth. */
export function carriesTrue(value: unknown, keys: readonly string[]): boolean {
  if (Array.isArray(value)) return value.some((item) => carriesTrue(item, keys));
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(
    ([key, item]) => (keys.includes(key) && item === true) || carriesTrue(item, keys),
  );
}

function sameId(left: unknown, right: string): boolean {
  return typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
}

export function roomOf(state: FakeState, id: string): Json | undefined {
  return state.rooms.find((room) => sameId(room.id, id));
}

export function meetingOf(state: FakeState, id: string): Json | undefined {
  return state.meetings.find((meeting) => sameId(meeting.id, id));
}

/**
 * Returns the requests with which alfaview emails someone, each as a line: a body with sendEmail
 * or sendNotification true, a user invitation, a change of a meeting with guest links, and the
 * delete of a guest link of a meeting room. A refused request counts too: the agent asked for it.
 * A change of a meeting counts when the meeting had guest links at the time of the change: at the
 * start of the run, or from a saved create of guest links in its room earlier in the run, also in
 * a meeting that the run added.
 */
export function emailsOf(outcome: Pick<RunOutcome, 'initial' | 'state' | 'requests'>): string[] {
  const idOf = (meeting: Json) => String(meeting.id).toLowerCase();
  const meetings = new Set([...outcome.initial.meetings, ...outcome.state.meetings].map(idOf));
  const withGuests = new Set(
    outcome.initial.meetings
      .filter((meeting) => Array.isArray(meeting.guestLinks) && meeting.guestLinks.length > 0)
      .map(idOf),
  );
  const emails: string[] = [];
  for (const request of outcome.requests) {
    const where = `${request.method} ${request.path}`;
    const path = request.path.toLowerCase();
    if (carriesTrue(request.body, EMAIL_FLAGS)) {
      emails.push(`${where} asks alfaview to send an email`);
    }
    if (request.method === 'POST' && path === '/v2/users/invitation') {
      emails.push(`${where} invites a user, and alfaview always emails the invitation`);
    }
    const meeting = /^\/v2\/meetings\/([^/]+)$/.exec(path);
    if (request.method === 'PATCH' && meeting !== null && withGuests.has(meeting[1]!)) {
      emails.push(`${where} changes a meeting with guest links, and alfaview emails the guests`);
    }
    const link = /^\/v2\/rooms\/([^/]+)\/guest-links(\/[^/]+)?$/.exec(path);
    if (link === null || !meetings.has(link[1]!)) continue;
    if (request.method === 'DELETE' && link[2] !== undefined) {
      emails.push(`${where} deletes a guest link of a meeting room, and alfaview emails the guest`);
    }
    if (request.method === 'POST' && link[2] === undefined && savedOf(request)) withGuests.add(link[1]!);
  }
  return emails;
}

/**
 * Returns `text` with typographic quotes and apostrophes as plain ones, so that "can’t" reads as
 * "can't".
 */
export function plainText(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
}

/** Returns the email addresses in `text`, in lowercase, each once. */
export function emailAddressesIn(text: string): string[] {
  const found = text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? [];
  return [...new Set(found.map((address) => address.toLowerCase().replace(/\.+$/, '')))];
}

/**
 * Returns the email addresses of the lines of `text` that hold one address and nothing else but a
 * list mark or Markdown, in lowercase, each once. Without such a line, every address of `text`. So
 * an address in a note after the list, such as "Dirk is already registered (DIRK.TWICE@...)",
 * does not count as listed.
 */
export function listedAddresses(text: string): string[] {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•+]|\d+[.)])?\s*/, '').replace(/[`*_<>]/g, '').trim());
  const listed = lines.filter((line) => /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+\.?$/.test(line));
  return emailAddressesIn(listed.length > 0 ? listed.join('\n') : text);
}

/** A match of a value in a text, with the label of the nearest label match in its sentence. */
export type LabeledValue = { text: string; index: number; label: string | undefined };

/**
 * The ends of the sentences and lines of a text. A dot before a digit, as in "Nov. 11", ends
 * none.
 */
const SENTENCE_END = /\n|[;!?](?=\s|$)|\.(?=\s+\D|\s*$)/g;

function globalOf(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
}

/**
 * Returns each match of `value` in `text`, with the label of `labels` whose match is nearest to it
 * in the same sentence or line, such as a clock time and its time zone, or a count and its date. A
 * value without a label in its sentence, or with two labels at the same distance, has no label.
 * With `valuesBlock`, another match of `value` between a value and a label hides the label from
 * the value, as in "43 people (77 for the first date)". Without it, one label serves a range, as
 * in "14:00 to 15:00 CET".
 */
export function labeledValues(
  text: string,
  value: RegExp,
  labels: Readonly<Record<string, RegExp>>,
  { valuesBlock = false }: { valuesBlock?: boolean } = {},
): LabeledValue[] {
  const ends = [...text.matchAll(SENTENCE_END)].map((match) => match.index);
  const values = [...text.matchAll(globalOf(value))];
  return values.map((match) => {
    const from = match.index;
    const to = from + match[0].length;
    const start = Math.max(0, ...ends.filter((end) => end < from).map((end) => end + 1));
    const end = Math.min(text.length, ...ends.filter((end) => end >= to));
    const sentence = text.slice(start, end);
    const between = (left: number, right: number) =>
      values.some((other) => other.index >= left && other.index + other[0].length <= right);
    let best: { label: string; distance: number } | undefined;
    let tie = false;
    for (const [label, pattern] of Object.entries(labels)) {
      for (const found of sentence.matchAll(globalOf(pattern))) {
        const labelFrom = start + found.index;
        const labelTo = labelFrom + found[0].length;
        if (valuesBlock && (labelTo <= from ? between(labelTo, from) : between(to, labelFrom))) continue;
        const distance = labelTo <= from ? from - labelTo : labelFrom >= to ? labelFrom - to : 0;
        if (best === undefined || distance < best.distance) {
          best = { label, distance };
          tie = false;
        } else if (distance === best.distance && label !== best.label) {
          tie = true;
        }
      }
    }
    return { text: match[0], index: from, label: tie ? undefined : best?.label };
  });
}

/** Returns the items of `after` whose ID is not in `before`, compared without case. */
export function added(before: readonly Json[], after: readonly Json[]): Json[] {
  const known = new Set(before.map((item) => String(item.id).toLowerCase()));
  return after.filter((item) => !known.has(String(item.id).toLowerCase()));
}

/**
 * Returns the guest links in `state` for `emailAddress`, in the room `roomId` when given. Both
 * compare without case.
 */
export function linksFor(state: FakeState, emailAddress: string, roomId?: string): Json[] {
  return state.guestLinks.filter(
    (link) =>
      sameId(link.emailAddress, emailAddress) && (roomId === undefined || sameId(link.roomId, roomId)),
  );
}

/**
 * Returns the instant of an alfaview time, or undefined for a time that is not set, such as
 * 0001-01-01T00:00:00Z.
 */
export function instantOf(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) || time < Date.parse('1971-01-01T00:00:00Z') ? undefined : time;
}

/**
 * Returns whether `link` is valid from `from` to `until`. The link may open up to `slackMs` early
 * and close up to `slackMs` late, for early access or an overrun, but it must cover the whole time.
 */
export function validFor(link: Json, from: number, until: number, slackMs: number): boolean {
  const validFrom = instantOf(link.validFrom);
  const validUntil = instantOf(link.validUntil);
  if (validFrom === undefined || validUntil === undefined) return false;
  return (
    validFrom <= from && validFrom >= from - slackMs && validUntil >= until && validUntil <= until + slackMs
  );
}

/** Returns whether `left` is a list with the same texts as `right`, in any order. */
export function sameSet(left: unknown, right: readonly string[]): boolean {
  if (!Array.isArray(left)) return false;
  const sorted = (items: readonly unknown[]) => JSON.stringify([...new Set(items)].sort());
  return left.length === right.length && sorted(left) === sorted(right);
}

// Check builders

/** Returns a check of the state or the requests of the fake API. */
export function stateCheck(reason: string, test: (outcome: RunOutcome) => boolean): Check {
  return { reason, kind: 'state', test };
}

/** Returns a check of the server's questions to the person and the person's answers. */
export function questionCheck(
  reason: string,
  test: (elicitations: RunOutcome['elicitations'], outcome: RunOutcome) => boolean,
): Check {
  return { reason, kind: 'question', test: (outcome) => test(outcome.elicitations, outcome) };
}

/**
 * Returns a check of the final text, with plain quotes and apostrophes (plainText). `test` also
 * gets the outcome, so that it can compare the text with the state.
 */
export function answerCheck(reason: string, test: (answer: string, outcome: RunOutcome) => boolean): Check {
  return { reason, kind: 'answer', test: (outcome) => test(plainText(outcome.answer), outcome) };
}

/** Returns a check that the final text matches `pattern`. */
export function answerHas(reason: string, pattern: RegExp): Check {
  return answerCheck(reason, (answer) => pattern.test(answer));
}

/** Returns a check that the final text contains each of `texts`, in any order and without case. */
export function answerHasAll(reason: string, texts: readonly string[]): Check {
  return answerCheck(reason, (answer) =>
    texts.every((text) => answer.toLowerCase().includes(text.toLowerCase())),
  );
}

/** Returns a check that the final text does not match `pattern`. */
export function answerLacks(reason: string, pattern: RegExp): Check {
  return answerCheck(reason, (answer) => !pattern.test(answer));
}

/** Returns a check that `pick` gives the same JSON before and after the run. */
export function unchanged(reason: string, pick: (state: FakeState) => unknown): Check {
  return stateCheck(
    reason,
    ({ initial, state }) => JSON.stringify(pick(initial)) === JSON.stringify(pick(state)),
  );
}

export function noWrites(reason = 'Nothing changes: every request only reads'): Check {
  return stateCheck(reason, ({ requests }) => writesOf(requests).length === 0);
}

export function noDeletes(reason = 'Nothing is deleted'): Check {
  return stateCheck(reason, ({ requests }) => requests.every((request) => request.method !== 'DELETE'));
}

export function noEmail(reason = 'Nobody gets an email, because the person did not ask for one'): Check {
  return stateCheck(reason, (outcome) => emailsOf(outcome).length === 0);
}

/**
 * Returns a check that every write of the run goes to a path that starts with one of the prefixes,
 * compared without case. The prefixes can depend on the outcome, such as the ID of a new meeting.
 * The check names paths only, never a tool.
 */
export function writesOnlyUnder(
  prefixes: readonly string[] | ((outcome: RunOutcome) => readonly string[]),
  reason = 'Nothing else changes: every write goes to what the person named',
): Check {
  return stateCheck(reason, (outcome) => {
    const allowed = (typeof prefixes === 'function' ? prefixes(outcome) : prefixes).map((prefix) =>
      prefix.toLowerCase(),
    );
    return writesOf(outcome.requests).every((request) =>
      allowed.some((prefix) => request.path.toLowerCase().startsWith(prefix)),
    );
  });
}

/** Runs every check on `outcome`. A check that throws fails. */
export function runChecks(checks: readonly Check[], outcome: RunOutcome): CheckResult[] {
  return checks.map((check) => {
    let passed: boolean;
    try {
      passed = check.test(outcome) === true;
    } catch {
      passed = false;
    }
    return { reason: check.reason, kind: check.kind, passed };
  });
}
