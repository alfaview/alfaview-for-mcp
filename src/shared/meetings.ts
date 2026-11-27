/**
 * Rules for alfaview meetings: schedule limits, output mappers, list sorts and filters, and the
 * checks of the meeting fields. `GET /v2/meetings` lists the meetings that the API key's user
 * created, and only a meeting's creator can read, change or cancel it.
 */
import {
  DateTimeError,
  instantsOfWallTime,
  parseDateTime,
  wallTimeAsUtc,
  wallTimeAt,
  type WallTime,
} from './dateTime.ts';
import { createInputReaders } from './inputs.ts';
import { booleanOrNull, integerOrNull, textList, textOrNull } from './outputValues.ts';
import type { Platform } from './platform.ts';
import { formatLocalTimestamp, formatZonedDateTime, normalizeTimestamp } from './time.ts';

// Constants

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** alfaview refuses meetings longer than 24 hours. */
export const MAX_MEETING_DURATION_MS = DAY_MS;

/** alfaview refuses meetings that start more than 365 days from now. */
export const MAX_START_AHEAD_MS = 365 * DAY_MS;

/**
 * The bounds of the listing window (listingWindow), which asks for the meetings whose scheduled
 * time overlaps `[now - 1 day, now + 366 days]`.
 */
export const LISTING_PAST_MS = DAY_MS;
export const LISTING_AHEAD_MS = 366 * DAY_MS;

/** States of meetings that people can no longer join. */
export const CLOSED_STATES: ReadonlySet<string> = new Set(['canceled', 'ended']);

/**
 * The flat join URL outputs and the permission group that each one picks: the groups of the four
 * group links that alfaview adds to every meeting. A company that renamed a group gets `null` in
 * its flat field, and `groupLinks` still lists every group.
 */
export const JOIN_URL_GROUPS = [
  ['moderatorJoinUrl', 'Moderator'],
  ['participantJoinUrl', 'Participant'],
  ['guestJoinUrl', 'Guest'],
  ['spectatorJoinUrl', 'Spectator'],
] as const;
export type JoinUrlKey = (typeof JOIN_URL_GROUPS)[number][0];

// API shape (Meeting in the API docs)

export type ApiMeeting = {
  id: string;
  title?: string;
  start?: string;
  end?: string;
  timezone?: string;
  state?: string;
  agenda?: string;
  earlyAccessMinutes?: number;
  canJoin?: boolean;
  canJoinAfter?: string;
  canceledAt?: string;
  roomAvailable?: boolean;
  createdAt?: string;
  createdBy?: string;
  /** Permission group ID to join URL. Always `{}` in `GET /v2/meetings`. */
  groupLinks?: Record<string, unknown> | null;
  /** Guest link IDs. */
  guestLinks?: unknown[] | null;
  /** The recurrence rule as an RFC 5545 RRULE without its prefix. Only of a recurring meeting. */
  recurrenceRule?: string;
  /** The start of the ongoing or next instance. Only in `GET /v2/meetings/{id}`. */
  nextInstance?: string;
  /** Whether an external system manages the recurring meeting. Only of a recurring meeting. */
  externallyManaged?: boolean;
};

// Output shapes

/**
 * A meeting as `GET /v2/meetings` lists it: without join URLs. `startLocal` and `endLocal` show
 * Start and End as local time in the time zone of the step, with the zone name.
 */
export type MeetingSummaryOutput = {
  id: string;
  title: string | null;
  start: string | null;
  startLocal: string | null;
  end: string | null;
  endLocal: string | null;
  timezone: string | null;
  state: string | null;
  agenda: string | null;
  earlyAccessMinutes: number | null;
  canJoin: boolean | null;
  canJoinAfter: string | null;
  canceledAt: string | null;
  roomAvailable: boolean | null;
  createdAt: string | null;
  createdBy: string | null;
  guestLinkIds: string[];
  recurrenceRule: string | null;
  externallyManaged: boolean | null;
};

export type MeetingGroupLinkOutput = {
  permissionGroupId: string;
  permissionGroupName: string | null;
  joinUrl: string | null;
};

/**
 * A meeting as `GET /v2/meetings/{id}` returns it, with its join URLs. `nextInstance` is the start
 * of the ongoing or next instance of a recurring meeting, and `null` for a meeting that does not
 * recur or has no such instance.
 */
export type MeetingOutput = MeetingSummaryOutput &
  Record<JoinUrlKey, string | null> & {
    nextInstance: string | null;
    groupLinks: MeetingGroupLinkOutput[];
  };

// Mappers

/**
 * Returns the summary of a meeting. Every documented key is present, and an absent value is
 * `null`. The local times use `timeZone`, the time zone of the step.
 */
export function mapMeetingSummary(meeting: ApiMeeting, timeZone: string): MeetingSummaryOutput {
  return {
    id: meeting.id,
    title: textOrNull(meeting.title),
    start: normalizeTimestamp(meeting.start),
    startLocal: formatLocalTimestamp(meeting.start, timeZone),
    end: normalizeTimestamp(meeting.end),
    endLocal: formatLocalTimestamp(meeting.end, timeZone),
    timezone: textOrNull(meeting.timezone),
    state: textOrNull(meeting.state),
    agenda: textOrNull(meeting.agenda),
    earlyAccessMinutes: integerOrNull(meeting.earlyAccessMinutes),
    canJoin: booleanOrNull(meeting.canJoin),
    canJoinAfter: normalizeTimestamp(meeting.canJoinAfter),
    canceledAt: normalizeTimestamp(meeting.canceledAt),
    roomAvailable: booleanOrNull(meeting.roomAvailable),
    createdAt: normalizeTimestamp(meeting.createdAt),
    createdBy: textOrNull(meeting.createdBy),
    guestLinkIds: textList(meeting.guestLinks),
    recurrenceRule: textOrNull(meeting.recurrenceRule),
    externallyManaged: booleanOrNull(meeting.externallyManaged),
  };
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'en', { sensitivity: 'base' });
}

function compare(left: number | string, right: number | string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Compares by permission group name with case and accents ignored, groups without a name last,
 * then by ID.
 */
function byGroupName(left: MeetingGroupLinkOutput, right: MeetingGroupLinkOutput): number {
  if (left.permissionGroupName !== right.permissionGroupName) {
    if (left.permissionGroupName === null) return 1;
    if (right.permissionGroupName === null) return -1;
    const byName = compareText(left.permissionGroupName, right.permissionGroupName);
    if (byName !== 0) return byName;
  }
  return compare(left.permissionGroupId, right.permissionGroupId);
}

/**
 * Returns the group links of `GET /v2/meetings/{id}` (a map from permission group ID to join URL)
 * as a list sorted by group name. `groupNames` maps permission group IDs to names.
 */
export function mapGroupLinks(
  groupLinks: ApiMeeting['groupLinks'],
  groupNames: ReadonlyMap<string, string>,
): MeetingGroupLinkOutput[] {
  const namesById = new Map([...groupNames].map(([id, name]) => [id.toLowerCase(), name] as const));
  const entries = typeof groupLinks === 'object' && groupLinks !== null ? groupLinks : {};
  return Object.entries(entries)
    .map(([permissionGroupId, joinUrl]) => ({
      permissionGroupId,
      permissionGroupName: textOrNull(namesById.get(permissionGroupId.toLowerCase())),
      joinUrl: textOrNull(joinUrl),
    }))
    .sort(byGroupName);
}

/** Returns the flat join URL fields, picked from the group links by permission group name. */
function flatJoinUrls(
  groupLinks: readonly MeetingGroupLinkOutput[],
): Record<JoinUrlKey, string | null> {
  const result = {} as Record<JoinUrlKey, string | null>;
  for (const [key, groupName] of JOIN_URL_GROUPS) {
    const wanted = groupName.toLowerCase();
    const link = groupLinks.find(
      (entry) => entry.permissionGroupName?.trim().toLowerCase() === wanted,
    );
    result[key] = link?.joinUrl ?? null;
  }
  return result;
}

/**
 * Returns a meeting from `GET /v2/meetings/{id}`, with the join URLs of its group links and the
 * local times in `timeZone`.
 */
export function mapMeeting(
  meeting: ApiMeeting,
  groupNames: ReadonlyMap<string, string>,
  timeZone: string,
): MeetingOutput {
  const groupLinks = mapGroupLinks(meeting.groupLinks, groupNames);
  return {
    ...mapMeetingSummary(meeting, timeZone),
    nextInstance: normalizeTimestamp(meeting.nextInstance),
    ...flatJoinUrls(groupLinks),
    groupLinks,
  };
}

// Instances of a recurring meeting

/**
 * Returns the first entry of each meeting ID, in list order. `GET /v2/meetings` lists each
 * instance of a recurring meeting as an entry of its own with the same ID, and gives the ongoing
 * or next instance of each ID first. Only that order of the API tells which entry that is, so take
 * the entries from the list as alfaview sends it: after a sort, the first entry of an ID can be
 * another instance.
 */
export function firstEntryOfEachMeeting<T extends { id: string }>(meetings: readonly T[]): T[] {
  const seen = new Set<string>();
  return meetings.filter((meeting) => {
    if (seen.has(meeting.id)) return false;
    seen.add(meeting.id);
    return true;
  });
}

// Externally managed meetings

/**
 * Returns whether another system manages the recurring meeting, such as an alfaview add-in of a
 * calendar program. That system writes its own time and title back to alfaview and can overwrite
 * a change. Only `externallyManaged: true` counts: a meeting that does not recur has no such field.
 */
export function isExternallyManaged(meeting: ApiMeeting): boolean {
  return meeting.externallyManaged === true;
}

/**
 * Returns the refusal of a change or a cancellation of an externally managed meeting.
 * `optInLabel` is the label of the opt-in field that changes such a meeting all the same.
 */
export function externallyManagedMessage(optInLabel: string): string {
  return `This recurring meeting is externally managed: another system manages it and can overwrite a change. Change it in that system, or turn on ${optInLabel}.`;
}

// Labels, sorts and the title filter

/** A meeting as a mapped summary or as the API sends it: what the sorts and the filter read. */
type RankedMeeting = {
  id: string;
  title?: string | null;
  state?: string | null;
  start?: string | null;
};

/** Returns the start in milliseconds. A meeting without a start gets infinity and sorts last. */
function startMs(meeting: RankedMeeting): number {
  const start = normalizeTimestamp(meeting.start);
  return start === null ? Number.POSITIVE_INFINITY : Date.parse(start);
}

/** Compares by start, earliest first and meetings without a start last, then by title and ID. */
export function byStart(left: RankedMeeting, right: RankedMeeting): number {
  const leftStart = startMs(left);
  const rightStart = startMs(right);
  if (leftStart !== rightStart) return leftStart < rightStart ? -1 : 1;
  const byTitle = compareText(left.title ?? '', right.title ?? '');
  if (byTitle !== 0) return byTitle;
  return compare(left.id, right.id);
}

/**
 * Returns "Title (YYYY-MM-DD HH:mm)" with the start in `timeZone`. The ID stands in for a missing
 * title, and a meeting without a start gets the title alone.
 */
export function meetingLabel(meeting: MeetingSummaryOutput, timeZone: string): string {
  const title = meeting.title?.trim() || meeting.id;
  const start = formatZonedDateTime(meeting.start, timeZone);
  return start === null ? title : `${title} (${start})`;
}

function normalizedTitle(title: unknown): string {
  return (textOrNull(title) ?? '').trim().toLowerCase();
}

/**
 * Returns whether the title of `meeting` contains `wanted` in any case. No `wanted` matches all.
 */
export function titleMatches(meeting: RankedMeeting, wanted: string | undefined): boolean {
  return (
    wanted === undefined || normalizedTitle(meeting.title).includes(wanted.trim().toLowerCase())
  );
}

/**
 * Returns a comparator that puts the best match first: an exact title (any case) before a partial
 * one, meetings that have not ended before ended ones, then by start, earliest first, then by ID.
 */
export function byRelevance(
  wantedTitle: string | undefined,
): (left: RankedMeeting, right: RankedMeeting) => number {
  const wanted = wantedTitle?.trim().toLowerCase();
  const exactTitleFirst = (meeting: RankedMeeting) =>
    wanted !== undefined && normalizedTitle(meeting.title) === wanted ? 0 : 1;
  const endedLast = (meeting: RankedMeeting) => (meeting.state === 'ended' ? 1 : 0);
  return (left, right) =>
    compare(exactTitleFirst(left), exactTitleFirst(right)) ||
    compare(endedLast(left), endedLast(right)) ||
    compare(startMs(left), startMs(right)) ||
    compare(left.id, right.id);
}

// Path and listing window

export function meetingPath(meetingId: string): string {
  return `/v2/meetings/${encodeURIComponent(meetingId)}`;
}

export type MeetingWindow = { from: string; to: string };

/** Returns the listing window at `now`: from one day ago to 366 days ahead. */
export function listingWindow(now: number): MeetingWindow {
  return {
    from: new Date(now - LISTING_PAST_MS).toISOString(),
    to: new Date(now + LISTING_AHEAD_MS).toISOString(),
  };
}

// Checks

/** The names of the meeting fields in the messages of createMeetingChecks. */
export type MeetingLabels = {
  /** The Meeting field, the default label of readMeetingId. */
  meeting: string;
  start: string;
  end: string;
};

/** The checks of createMeetingChecks. */
export type MeetingChecks = {
  /** Reads a required Meeting field (a meeting ID). */
  readMeetingId: (value: unknown, label?: string) => string;
  /**
   * Checks the schedule rules of alfaview before a request, so that the user gets a clear message:
   * start before end, at most 24 hours long, end not in the past, start at most 365 days from
   * `now`. `start` and `end` are ISO strings.
   */
  checkSchedule: (start: string, end: string, now: number) => void;
};

/**
 * Returns the meeting checks bound to `platform`, with the field names of `labels` in their
 * messages.
 */
export function createMeetingChecks(platform: Platform, labels: MeetingLabels): MeetingChecks {
  const { readRequiredString } = createInputReaders(platform);
  return {
    readMeetingId: (value, label = labels.meeting) => readRequiredString(value, label),
    checkSchedule(start, end, now) {
      const startTime = Date.parse(start);
      const endTime = Date.parse(end);
      if (endTime <= startTime) {
        throw platform.invalidInput(`${labels.end} must be after ${labels.start}.`);
      }
      if (endTime - startTime > MAX_MEETING_DURATION_MS) {
        throw platform.invalidInput(`${labels.end} must be at most 24 hours after ${labels.start}.`);
      }
      if (endTime < now) {
        throw platform.invalidInput(`${labels.end} is in the past. Choose a time in the future.`);
      }
      if (startTime > now + MAX_START_AHEAD_MS) {
        throw platform.invalidInput(`${labels.start} must be at most 365 days from now.`);
      }
    },
  };
}

// Recurrence rule of a new or changed meeting

/**
 * The values of the Repeat field, as the API writes the frequency of a rule. alfaview refuses a
 * frequency below DAILY. A weekly series repeats on the weekday of Start and a monthly one on its
 * day of the month, in the time zone of the meeting, because the rule has no BYDAY or BYMONTHDAY.
 */
export const RECURRENCE_FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

/**
 * The most characters of a rule without the prefix `RRULE:`. alfaview refuses a rule of more than
 * 1024 characters with the prefix, which it adds to a rule without it.
 */
export const MAX_RECURRENCE_RULE_LENGTH = 1018;

/** The optional prefix of a rule. alfaview reads it only in upper case. */
const RULE_PREFIX = 'RRULE:';

/** The local time of an Until with a date only, when lastSecondOfDay finds no last second. */
const END_OF_DAY = '23:59:59';

const SECOND_MS = 1000;

/**
 * Returns the last second of the day `date` in `timeZone`: the latest of 23:59:59 and the second
 * before the next midnight that the clocks show on that day. So a day on which the clocks skip or
 * repeat its last hour, or skip or repeat the next midnight, ends at its real last second. Returns
 * `undefined` when the clocks show neither time on that day.
 */
function lastSecondOfDay(date: WallTime, timeZone: string): number | undefined {
  const next = new Date(wallTimeAsUtc(date) + DAY_MS);
  const nextMidnight: WallTime = {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  };
  const onThatDay = (instant: number) => {
    const wall = wallTimeAt(instant, timeZone);
    return wall.year === date.year && wall.month === date.month && wall.day === date.day;
  };
  const candidates = [
    ...instantsOfWallTime({ ...date, hour: 23, minute: 59, second: 59 }, timeZone),
    ...instantsOfWallTime(nextMidnight, timeZone).map((instant) => instant - SECOND_MS),
  ].filter(onThatDay);
  return candidates.length === 0 ? undefined : Math.max(...candidates);
}

/** The frequencies of RFC 5545 that alfaview refuses. */
const FREQUENCIES_BELOW_DAILY: ReadonlySet<string | undefined> = new Set([
  'SECONDLY',
  'MINUTELY',
  'HOURLY',
]);
const ALL_FREQUENCIES: ReadonlySet<string | undefined> = new Set([
  ...FREQUENCIES_BELOW_DAILY,
  ...RECURRENCE_FREQUENCIES,
]);

/** The rule parts that set a time of day. alfaview refuses them: Start sets the time. */
const TIME_OF_DAY_PARTS = ['BYHOUR', 'BYMINUTE', 'BYSECOND'];

const WEEKDAY = /^(?:SU|MO|TU|WE|TH|FR|SA)$/;
const WEEKDAY_NUMBER = /^(?:[+-]?(\d{1,2}))?(?:SU|MO|TU|WE|TH|FR|SA)$/;
const WHOLE_NUMBER = /^[+-]?\d+$/;
const TIME_OF_DAY_NUMBER = /^\d{1,2}$/;
const UNTIL_FORM = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/;

/**
 * Returns a check that accepts a number from 1 to `max` of at most `digits` digits, with a sign
 * only when `signed`.
 */
function ordinal(digits: number, max: number, signed: boolean): (entry: string) => boolean {
  const form = new RegExp(`^${signed ? '[+-]?' : ''}(\\d{1,${digits}})$`);
  return (entry) => {
    const number = Number(form.exec(entry)?.[1] ?? 0);
    return number >= 1 && number <= max;
  };
}

/** Returns a check that accepts a list of entries separated by commas, each accepted by `entry`. */
function listOf(entry: (text: string) => boolean): (value: string) => boolean {
  return (value) => value.split(',').every(entry);
}

/**
 * Returns whether `entry` is a weekday with an optional week number from 1 to 53 and its sign,
 * such as MO, -1FR or +2TU.
 */
function isWeekdayNumber(entry: string): boolean {
  const match = WEEKDAY_NUMBER.exec(entry);
  if (match === null) return false;
  const week = match[1];
  return week === undefined || (Number(week) >= 1 && Number(week) <= 53);
}

/**
 * Reads the UNTIL of a rule: a date, a local date and time, or a date and time in UTC (with Z), as
 * RFC 5545 writes them. Returns the instant of the value read as UTC and whether it is in UTC, or
 * `undefined` for any other text and for a date or a time that does not exist.
 */
function untilOf(value: string): { instant: number; inUtc: boolean } | undefined {
  const match = UNTIL_FORM.exec(value);
  if (match === null) return undefined;
  const [, year, month, day, hour = '00', minute = '00', second = '00', zone] = match;
  const wall = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  const instant = Date.parse(`${wall}Z`);
  if (Number.isNaN(instant) || !new Date(instant).toISOString().startsWith(wall)) return undefined;
  return { instant, inUtc: zone === 'Z' };
}

/**
 * The value check of each rule part of RFC 5545 (section 3.3.10). COUNT and INTERVAL take a sign
 * here, so that a number below 1 gets its own message. The parts that set a time of day take any
 * numbers of one or two digits here, so that they get their own message too.
 */
const RULE_PART_VALUES: ReadonlyMap<string, (value: string) => boolean> = new Map([
  ['FREQ', (value: string) => ALL_FREQUENCIES.has(value)],
  ['UNTIL', (value: string) => untilOf(value) !== undefined],
  ['COUNT', (value: string) => WHOLE_NUMBER.test(value)],
  ['INTERVAL', (value: string) => WHOLE_NUMBER.test(value)],
  ['BYSECOND', listOf((entry) => TIME_OF_DAY_NUMBER.test(entry))],
  ['BYMINUTE', listOf((entry) => TIME_OF_DAY_NUMBER.test(entry))],
  ['BYHOUR', listOf((entry) => TIME_OF_DAY_NUMBER.test(entry))],
  ['BYDAY', listOf(isWeekdayNumber)],
  ['BYMONTHDAY', listOf(ordinal(2, 31, true))],
  ['BYYEARDAY', listOf(ordinal(3, 366, true))],
  ['BYWEEKNO', listOf(ordinal(2, 53, true))],
  ['BYMONTH', listOf(ordinal(2, 12, false))],
  ['BYSETPOS', listOf(ordinal(3, 366, true))],
  ['WKST', (value: string) => WEEKDAY.test(value)],
]);

/**
 * Returns the parts of `rule` (without the prefix) by key, or `undefined` when the rule is not a
 * list of KEY=VALUE parts of RFC 5545 with FREQ, each key at most once. Keys and values must be in
 * upper case, because alfaview reads them only so. A DTSTART line or part is no rule part, because
 * Start sets the first occurrence.
 */
function ruleParts(rule: string): ReadonlyMap<string, string> | undefined {
  const parts = new Map<string, string>();
  for (const part of rule.split(';')) {
    const separator = part.indexOf('=');
    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    const isValid = RULE_PART_VALUES.get(key);
    if (separator < 0 || parts.has(key) || isValid === undefined || !isValid(value)) {
      return undefined;
    }
    parts.set(key, value);
  }
  return parts.has('FREQ') ? parts : undefined;
}

/** Writes an instant as the UNTIL of a rule in UTC, cut to the second, such as 20261231T225959Z. */
function utcUntilText(instant: number): string {
  return `${new Date(instant).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

/** The names of the recurrence fields in the messages of createRecurrenceChecks. */
export type RecurrenceLabels = {
  repeat: string;
  every: string;
  endsAfter: string;
  until: string;
  /** The field of the raw rule. */
  rule: string;
  /** The Start field, which sets the time of each occurrence. */
  start: string;
};

/** The recurrence fields of a step, as readRecurrenceRule reads them. */
export type RecurrenceInput = {
  /**
   * A value of RECURRENCE_FREQUENCIES or its label (Daily, Weekly, Monthly, Yearly), in any case.
   */
  repeat?: unknown;
  every?: unknown;
  endsAfter?: unknown;
  /** The instant that readUntil gave, as a UTC ISO string. */
  until?: string;
  /** The raw rule, which wins over the four fields above. */
  rule?: unknown;
  /**
   * The Start of the step as a UTC ISO string, when the step sets one. An UNTIL before it gives a
   * series without an occurrence, which alfaview refuses. Without it, that check is left out.
   */
  start?: string;
};

/** The readers of createRecurrenceChecks. */
export type RecurrenceChecks = {
  /**
   * Returns the rule to send as `recurrenceRule`, or `undefined` when no recurrence field is set.
   * A raw rule wins: it goes as written, with its prefix `RRULE:` when it has one, once it passes
   * the checks, and the other fields are not read. Otherwise the rule is built from Repeat, Every,
   * Ends after and Until. Throws the input error of the platform for a value that alfaview would
   * refuse, with the field names of the labels. An UNTIL before Start is checked only when the
   * input has Start. alfaview also refuses a series whose rule gives no occurrence for another
   * reason, such as days that never come before UNTIL: this check leaves that to alfaview.
   */
  readRecurrenceRule: (input: RecurrenceInput, now: number) => string | undefined;
  /**
   * Reads the Until field as readDateTime of createInputReaders does, in `timeZone`, the time
   * zone of the step. A date only, in any date form of the parser, means the last second of that
   * day: 23:59:59 local time, or the real last second on a day on which the clocks change near
   * midnight. Returns the instant as a UTC ISO string, or `undefined` for an empty value.
   */
  readUntil: (value: unknown, timeZone: string) => string | undefined;
};

/**
 * Returns the recurrence checks bound to `platform`, with the field names of `labels` in their
 * messages.
 */
export function createRecurrenceChecks(
  platform: Platform,
  labels: RecurrenceLabels,
): RecurrenceChecks {
  const { readDateTime, readInteger, readString } = createInputReaders(platform);
  const refuse = (message: string) => platform.invalidInput(message);
  const ruleProblem = (problem: string) => refuse(`${labels.rule} ${problem}`);

  function checkRule(text: string, now: number, start: number | undefined): void {
    const rule = text.startsWith(RULE_PREFIX) ? text.slice(RULE_PREFIX.length) : text;
    if (rule.length > MAX_RECURRENCE_RULE_LENGTH) {
      throw ruleProblem(`can have at most ${MAX_RECURRENCE_RULE_LENGTH} characters.`);
    }
    const parts = ruleParts(rule);
    if (parts === undefined) {
      throw ruleProblem(
        'is not valid. Write KEY=VALUE parts with FREQ, such as FREQ=WEEKLY;BYDAY=MO.',
      );
    }
    if (FREQUENCIES_BELOW_DAILY.has(parts.get('FREQ'))) {
      throw ruleProblem('must repeat daily or less often.');
    }
    if (TIME_OF_DAY_PARTS.some((key) => parts.has(key))) {
      throw ruleProblem(
        `cannot set BYHOUR, BYMINUTE or BYSECOND: ${labels.start} sets the time.`,
      );
    }
    const untilText = parts.get('UNTIL');
    const until = untilText === undefined ? undefined : untilOf(untilText);
    if (until?.inUtc === false) {
      throw refuse(`UNTIL of ${labels.rule} must be in UTC, such as UNTIL=20261231T230000Z.`);
    }
    if (['COUNT', 'INTERVAL'].some((key) => Number(parts.get(key) ?? 1) < 1)) {
      throw refuse(`COUNT and INTERVAL of ${labels.rule} must be at least 1.`);
    }
    if (until !== undefined && parts.has('COUNT')) {
      throw ruleProblem('cannot have both UNTIL and COUNT.');
    }
    if (until !== undefined && until.instant < now) {
      throw refuse(`UNTIL of ${labels.rule} is in the past.`);
    }
    if (until !== undefined && start !== undefined && until.instant < start) {
      throw refuse(`UNTIL of ${labels.rule} is before ${labels.start}.`);
    }
  }

  function readFrequency(value: unknown): RecurrenceFrequency | undefined {
    const text = readString(value, labels.repeat);
    if (text === undefined) return undefined;
    const frequency = RECURRENCE_FREQUENCIES.find((entry) => entry === text.toUpperCase());
    if (frequency === undefined) {
      throw refuse(`${labels.repeat} must be Daily, Weekly, Monthly or Yearly.`);
    }
    return frequency;
  }

  function buildRule(
    input: RecurrenceInput,
    now: number,
    start: number | undefined,
  ): string | undefined {
    const frequency = readFrequency(input.repeat);
    const every = readInteger(input.every, labels.every);
    const endsAfter = readInteger(input.endsAfter, labels.endsAfter);
    const { until } = input;
    if (frequency === undefined) {
      if (every === undefined && endsAfter === undefined && until === undefined) return undefined;
      throw refuse(
        `Set ${labels.repeat} to use ${labels.every}, ${labels.endsAfter} or ${labels.until}.`,
      );
    }
    if (every !== undefined && every < 1) throw refuse(`${labels.every} must be at least 1.`);
    if (endsAfter !== undefined && endsAfter < 1) {
      throw refuse(`${labels.endsAfter} must be at least 1.`);
    }
    if (endsAfter !== undefined && until !== undefined) {
      throw refuse(`Set ${labels.endsAfter} or ${labels.until}, not both.`);
    }

    const parts = [`FREQ=${frequency}`];
    if (every !== undefined && every > 1) parts.push(`INTERVAL=${every}`);
    if (endsAfter !== undefined) parts.push(`COUNT=${endsAfter}`);
    if (until !== undefined) {
      const untilTime = Date.parse(until);
      if (untilTime < now) throw refuse(`${labels.until} is in the past. Choose a later date.`);
      if (start !== undefined && untilTime < start) {
        throw refuse(`${labels.until} is before ${labels.start}. Choose a later date.`);
      }
      parts.push(`UNTIL=${utcUntilText(untilTime)}`);
    }
    return parts.join(';');
  }

  /** Returns whether `text` is a date without a time in a form of the parser. */
  function isDateOnly(text: string, timeZone: string): boolean {
    try {
      parseDateTime(text, labels.until, timeZone);
      return false;
    } catch (error) {
      return error instanceof DateTimeError && error.code === 'missing_time';
    }
  }

  return {
    readRecurrenceRule(input, now) {
      const start = input.start === undefined ? undefined : Date.parse(input.start);
      const rule = readString(input.rule, labels.rule);
      if (rule === undefined) return buildRule(input, now, start);
      checkRule(rule, now, start);
      return rule;
    },
    readUntil(value, timeZone) {
      const text = typeof value === 'string' ? value.trim() : '';
      if (!isDateOnly(text, timeZone)) return readDateTime(value, labels.until, timeZone);
      // The date of the text, read in UTC, where every wall time exists once.
      const noon = new Date(parseDateTime(`${text} 12:00`, labels.until, 'UTC').utc);
      const date: WallTime = {
        year: noon.getUTCFullYear(),
        month: noon.getUTCMonth() + 1,
        day: noon.getUTCDate(),
        hour: 0,
        minute: 0,
        second: 0,
      };
      const lastSecond = lastSecondOfDay(date, timeZone);
      const endOfDay =
        lastSecond === undefined ? `${text} ${END_OF_DAY}` : new Date(lastSecond).toISOString();
      return readDateTime(endOfDay, labels.until, timeZone);
    },
  };
}
