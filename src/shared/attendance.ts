/**
 * Rules that turn the attendance sessions of an alfaview room into summaries, visits, attendees
 * and attendance reports. The rules are pure functions and send no request.
 */
import { formatLocalDateTime } from './dateTime.ts';
import { originMatches, type ApiGuestLink } from './guestLinks.ts';
import { isGuestUserId } from './guestUserId.ts';
import { createInputReaders } from './inputs.ts';
import { textOrNull } from './outputValues.ts';
import type { Platform } from './platform.ts';
import { normalizeTimestamp } from './time.ts';

// Constants

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/**
 * The longest attendance window that the rules accept, one minute below the limit of alfaview,
 * which refuses a window of more than 26 hours and 1 minute.
 */
export const MAX_WINDOW_MS = 26 * HOUR_MS;

/**
 * Attendance older than this is refused. The API docs say that alfaview removes the userId and
 * the name of a session 40 days after the join, and keeps the session itself for 62 days after it
 * ends.
 */
export const RETENTION_LIMIT_MS = 39 * DAY_MS;

/** The nil UUID. A row under this userId names no person, so it must not count as an attendee. */
export const NIL_USER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * A connection that starts at most this long after the previous one ended belongs to the same
 * visit: a reconnect, or a device that the next one replaced.
 */
export const RECONNECT_GAP_MS = 2 * MINUTE_MS;

/**
 * For the start of a visit, a session without a leave time counts as open for at most this long
 * after its join, so that a leave that was not recorded does not merge later visits into it.
 */
export const OPEN_SESSION_LIMIT_MS = 12 * HOUR_MS;

/**
 * The window of a poll for new attendees: the last 24 hours. alfaview also returns the sessions
 * that overlap it and started up to 24 hours before it.
 */
export const ATTENDEE_WINDOW_MS = DAY_MS;

/**
 * An event is ready for its report this long after its Valid Until, so that late leaves and the
 * sessions that alfaview records with a delay are in the report.
 */
export const READY_DELAY_MS = 30 * MINUTE_MS;

/** A normal poll leaves out the events whose Valid Until is older than this. */
export const LOOKBACK_MS = 48 * HOUR_MS;

/** A normal poll reports at most this many events, the newest by Valid Until. */
export const MAX_EVENTS_PER_POLL = 20;

/** A sample load or a manual run reports this many of the newest events. */
export const SAMPLE_EVENT_COUNT = 3;

export const ATTENDANCE_DENIED_MESSAGE =
  "alfaview did not return attendance for this room. The room does not exist, or the API key's user needs room admin rights in it.";

/**
 * The message for a guest link without the userId of its guest: alfaview sends an empty userId
 * when it cannot give it, and nothing else matches the guest to the attendance.
 */
export const UNMATCHABLE_GUEST_LINK_MESSAGE =
  'This guest link cannot be matched to attendance data.';

// API shapes (UserAttendances and Attendance in the API docs)

export type ApiAttendanceSession = { displayName?: string; from?: string; to?: string };

/**
 * One user's entry in the answer of `GET /v2/rooms/{roomId}/attendances?from=&to=`. In that
 * answer:
 * - It holds every session that overlaps the window and started at most 24 hours before `from`.
 *   alfaview refuses `from` after `to` and a window of more than 26 hours and 1 minute.
 * - Join and leave times are as recorded, not clipped to the window. A session that is still
 *   open, or whose leave was not recorded, has a `to` before its `from`, usually in year 1.
 * - Users and sessions come in random order, with one session for each connection. Reconnects
 *   and several devices give overlapping sessions.
 * - A wait in the waiting room can give a session too, so "attended" means "connected", not
 *   "admitted".
 */
export type ApiUserAttendances = { userId: string; attendances: ApiAttendanceSession[] };

/** A time window in milliseconds since the epoch. */
export type TimeWindow = { from: number; to: number };

// Rules

export type AttendanceSummary = {
  /** At least one session, and at least `minimumMinutes` minutes. */
  attended: boolean;
  /** Connected minutes inside the window, overlaps counted once, rounded to the nearest minute. */
  totalMinutes: number;
  sessionCount: number;
  /** The earliest join, not clipped to the window. */
  firstJoinedAt: string | null;
  /** The latest leave, or `null` while any session is open. */
  lastLeftAt: string | null;
  stillConnected: boolean;
  /** The name of the latest session that has one. */
  displayName: string | null;
};

type Session = { from: number; to: number | undefined; displayName: string | null };

/**
 * Returns the sessions in time order. A `to` before the `from`, before 1971 or unreadable means
 * "still open". A session without a readable `from` cannot be placed in time and is left out.
 */
function readSessions(sessions: readonly ApiAttendanceSession[]): Session[] {
  const result: Session[] = [];
  for (const session of sessions) {
    const fromIso = normalizeTimestamp(session?.from);
    if (fromIso === null) continue;
    const from = Date.parse(fromIso);
    const toIso = normalizeTimestamp(session?.to);
    const to = toIso === null ? undefined : Date.parse(toIso);
    result.push({
      from,
      to: to !== undefined && to >= from ? to : undefined,
      displayName: textOrNull(session?.displayName),
    });
  }
  return result.sort((left, right) => left.from - right.from);
}

/** Returns the total length of `intervals` in milliseconds, with overlapping parts counted once. */
function mergedLength(intervals: [start: number, end: number][]): number {
  const sorted = [...intervals].sort((left, right) => left[0] - right[0]);
  let total = 0;
  let current: [number, number] | undefined;
  for (const [start, end] of sorted) {
    if (current !== undefined && start <= current[1]) {
      current[1] = Math.max(current[1], end);
      continue;
    }
    if (current !== undefined) total += current[1] - current[0];
    current = [start, end];
  }
  if (current !== undefined) total += current[1] - current[0];
  return total;
}

/**
 * Summarizes the sessions of one person. Minutes count only inside the window, up to `now` at
 * most: each session is clipped to `[window.from, min(window.to, now)]` (an open session ends at
 * that bound), overlapping sessions are merged, and the sum is rounded to the nearest minute.
 */
export function summarize(
  sessions: readonly ApiAttendanceSession[],
  window: TimeWindow,
  now: number,
  minimumMinutes: number,
): AttendanceSummary {
  const parsed = readSessions(sessions);
  const bound = Math.min(window.to, now);
  const intervals = parsed
    .map((session): [number, number] => [
      Math.max(session.from, window.from),
      Math.min(session.to ?? bound, bound),
    ])
    .filter(([start, end]) => end > start);
  const totalMinutes = Math.round(mergedLength(intervals) / MINUTE_MS);

  const stillConnected = parsed.some((session) => session.to === undefined);
  const leaves = parsed.map((session) => session.to ?? 0);
  const first = parsed[0];
  const named = [...parsed].reverse().find((session) => session.displayName !== null);
  return {
    attended: parsed.length > 0 && totalMinutes >= minimumMinutes,
    totalMinutes,
    sessionCount: parsed.length,
    firstJoinedAt: first === undefined ? null : new Date(first.from).toISOString(),
    lastLeftAt:
      stillConnected || parsed.length === 0 ? null : new Date(Math.max(...leaves)).toISOString(),
    stillConnected,
    displayName: named?.displayName ?? null,
  };
}

/**
 * Returns whether `earlier` belongs to the visit that starts at `visitStart`: it ended after that
 * start or at most RECONNECT_GAP_MS before it (an overlap, a reconnect, or a device that the next
 * one replaced), or it has no leave time and started at most OPEN_SESSION_LIMIT_MS before it.
 */
function belongsToVisit(earlier: Session, visitStart: number): boolean {
  if (earlier.to === undefined) return earlier.from >= visitStart - OPEN_SESSION_LIMIT_MS;
  return earlier.to >= visitStart - RECONNECT_GAP_MS;
}

/**
 * Returns the start of the current visit of one person as an ISO string, from the person's
 * sessions in the room. A visit is one connection, or several connections that follow each other
 * within RECONNECT_GAP_MS. A wait in the waiting room is part of it when alfaview records it as a
 * session.
 *
 * Returns `null` when the person has no session with a readable join, or when the latest session
 * is not current: it has no leave time but started more than OPEN_SESSION_LIMIT_MS before `now`,
 * or it ended more than RECONNECT_GAP_MS before `now`. For a person who is connected now, alfaview
 * has then not recorded the current connection yet. Only this check uses `now`: the start depends
 * on the recorded sessions alone, so it stays the same from poll to poll.
 */
export function currentVisitStart(
  sessions: readonly ApiAttendanceSession[],
  now: number,
): string | null {
  const parsed = readSessions(sessions);
  const latest = parsed[parsed.length - 1];
  if (latest === undefined) return null;
  const current =
    latest.to === undefined
      ? latest.from >= now - OPEN_SESSION_LIMIT_MS
      : latest.to >= now - RECONNECT_GAP_MS;
  if (!current) return null;

  let start = latest.from;
  for (let index = parsed.length - 2; index >= 0; index -= 1) {
    const earlier = parsed[index] as Session;
    if (!belongsToVisit(earlier, start)) break;
    start = earlier.from;
  }
  return new Date(start).toISOString();
}

/** Removes the rows under NIL_USER_ID. */
export function dropExpiredUsers(entries: readonly ApiUserAttendances[]): ApiUserAttendances[] {
  return entries.filter((entry) => entry.userId.toLowerCase() !== NIL_USER_ID);
}

/** Returns every session of `userId`, in any case, also when alfaview lists the user twice. */
export function sessionsOfUser(
  entries: readonly ApiUserAttendances[],
  userId: string,
): ApiAttendanceSession[] {
  const wanted = userId.toLowerCase();
  return entries
    .filter((entry) => entry.userId.toLowerCase() === wanted)
    .flatMap((entry) => entry.attendances);
}

/**
 * Returns the sessions of each user, keyed by the userId in lowercase, in the order of `entries`.
 * A user that alfaview lists twice gets the sessions of both entries, as in sessionsOfUser.
 *
 * Use it to look up many users: it reads `entries` once, where sessionsOfUser reads them for each
 * user.
 */
export function sessionsByUserId(
  entries: readonly ApiUserAttendances[],
): Map<string, ApiAttendanceSession[]> {
  const sessions = new Map<string, ApiAttendanceSession[]>();
  for (const entry of entries) {
    const userId = entry.userId.toLowerCase();
    const list = sessions.get(userId) ?? [];
    for (const session of entry.attendances) list.push(session);
    sessions.set(userId, list);
  }
  return sessions;
}

/**
 * Returns the userId of the guest of `link` in lowercase, as alfaview returns it with the link.
 * The API docs say that it matches the userId in the attendance. Returns `null` when the link has
 * none or an empty one: alfaview sends an empty userId when it cannot give it, and such a link
 * cannot be matched to attendance data. A guest is matched to a link by this userId alone, so the
 * layout of the IDs does not matter.
 */
export function guestUserIdOf(link: ApiGuestLink): string | null {
  return textOrNull(link.userId)?.toLowerCase() ?? null;
}

/**
 * Returns the guest links keyed by the userId of their guest (guestUserIdOf, lowercase). Links
 * without that userId cannot be matched and are left out.
 */
export function guestLinksByUserId(links: readonly ApiGuestLink[]): Map<string, ApiGuestLink> {
  const result = new Map<string, ApiGuestLink>();
  for (const link of links) {
    const userId = guestUserIdOf(link);
    if (userId !== null) result.set(userId, link);
  }
  return result;
}

/**
 * Returns the attendance window of a guest link as UTC ISO strings: `from` and `to` where given,
 * else the link's Valid From and Valid Until after normalizeTimestamp. Returns `undefined` when a
 * bound is missing in both, so that the caller throws its own message.
 */
export function guestLinkAttendanceWindow(
  link: { validFrom?: unknown; validUntil?: unknown },
  from: string | undefined,
  to: string | undefined,
): { from: string; to: string } | undefined {
  const windowFrom = from ?? normalizeTimestamp(link.validFrom);
  const windowTo = to ?? normalizeTimestamp(link.validUntil);
  if (windowFrom === null || windowTo === null) return undefined;
  return { from: windowFrom, to: windowTo };
}

// Output shapes

export type AttendeeType = 'guest_link' | 'other';

export type AttendeeOutput = {
  id: string;
  userId: string;
  attendeeType: AttendeeType;
  roomId: string;
  roomName: string | null;
  displayName: string | null;
  emailAddress: string | null;
  guestLinkId: string | null;
  guestLinkOrigin: string | null;
  firstJoinedAt: string | null;
  lastLeftAt: string | null;
  stillConnected: boolean;
  totalMinutes: number;
  sessionCount: number;
};

export type AttendanceStatus = 'attended' | 'no_show';

export type ReportGuestOutput = {
  guestLinkId: string;
  emailAddress: string | null;
  displayName: string | null;
  origin: string | null;
  attended: boolean;
  status: AttendanceStatus;
  totalMinutes: number;
  firstJoinedAt: string | null;
  lastLeftAt: string | null;
};

export type AttendanceReportOutput = {
  id: string;
  roomId: string;
  roomName: string | null;
  origin: string | null;
  eventStart: string;
  eventEnd: string;
  minimumMinutes: number;
  invitedCount: number | null;
  attendedCount: number | null;
  noShowCount: number | null;
  attendedEmails: string | null;
  noShowEmails: string | null;
  guests: ReportGuestOutput[];
};

/**
 * The attendance of one guest link's guest. `windowFromLocal` and `windowToLocal` show the window
 * as local time in the time zone of the step, with the zone name.
 */
export type GuestLinkAttendanceOutput = {
  id: string;
  guestLinkId: string;
  roomId: string | null;
  emailAddress: string | null;
  displayName: string | null;
  windowFrom: string;
  windowFromLocal: string;
  windowTo: string;
  windowToLocal: string;
  minimumMinutes: number;
  attended: boolean;
  totalMinutes: number;
  sessionCount: number;
  firstJoinedAt: string | null;
  lastLeftAt: string | null;
  stillConnected: boolean;
};

// Mappers

/**
 * Returns one guest of an attendance report: the link's email address, name and origin with the
 * attendance of its guest. The name falls back to the name in the room when the link has none.
 */
export function mapReportGuest(link: ApiGuestLink, summary: AttendanceSummary): ReportGuestOutput {
  return {
    guestLinkId: link.id,
    emailAddress: textOrNull(link.emailAddress),
    displayName: textOrNull(link.displayName) ?? summary.displayName,
    origin: textOrNull(link.origin),
    attended: summary.attended,
    status: summary.attended ? 'attended' : 'no_show',
    totalMinutes: summary.totalMinutes,
    firstJoinedAt: summary.firstJoinedAt,
    lastLeftAt: summary.lastLeftAt,
  };
}

function byEmailThenId(left: ReportGuestOutput, right: ReportGuestOutput): number {
  const leftEmail = (left.emailAddress ?? '').toLowerCase();
  const rightEmail = (right.emailAddress ?? '').toLowerCase();
  if (leftEmail !== rightEmail) return leftEmail < rightEmail ? -1 : 1;
  return left.guestLinkId < right.guestLinkId ? -1 : left.guestLinkId > right.guestLinkId ? 1 : 0;
}

export type ReportCounts = Pick<
  AttendanceReportOutput,
  'invitedCount' | 'attendedCount' | 'noShowCount' | 'attendedEmails' | 'noShowEmails'
>;

/**
 * Counts people, not links: links with the same email address (any case) are one person, who
 * attended when any of their links attended. The email lists are lowercase, unique, sorted and
 * comma-separated. An empty list is `null`. A link without an email address counts as a person of
 * its own and appears in no list.
 */
export function countPeople(guests: readonly ReportGuestOutput[]): ReportCounts {
  const people = new Map<string, { email: string | null; attended: boolean }>();
  for (const guest of guests) {
    const email = guest.emailAddress?.trim().toLowerCase() || null;
    const key = email ?? `link:${guest.guestLinkId}`;
    const person = people.get(key) ?? { email, attended: false };
    person.attended = person.attended || guest.attended;
    people.set(key, person);
  }
  const emailList = (attended: boolean) => {
    const emails = [...people.values()]
      .filter((person) => person.attended === attended && person.email !== null)
      .map((person) => person.email as string)
      .sort();
    return emails.length > 0 ? emails.join(',') : null;
  };
  const attendedCount = [...people.values()].filter((person) => person.attended).length;
  return {
    invitedCount: people.size,
    attendedCount,
    noShowCount: people.size - attendedCount,
    attendedEmails: emailList(true),
    noShowEmails: emailList(false),
  };
}

/** Returns the origin that every link has, or `null` when they differ or have none. */
export function sharedOrigin(links: readonly { origin?: unknown }[]): string | null {
  const origins = new Set(links.map((link) => textOrNull(link.origin)));
  const [only] = [...origins];
  return origins.size === 1 && only !== undefined ? only : null;
}

/** Returns the report of one event, with its guests sorted by email address. */
export function mapAttendanceReport(event: {
  id: string;
  roomId: string;
  roomName: string | null;
  eventStart: string;
  eventEnd: string;
  minimumMinutes: number;
  links: readonly ApiGuestLink[];
  guests: readonly ReportGuestOutput[];
}): AttendanceReportOutput {
  const guests = [...event.guests].sort(byEmailThenId);
  return {
    id: event.id,
    roomId: event.roomId,
    roomName: event.roomName,
    origin: sharedOrigin(event.links),
    eventStart: event.eventStart,
    eventEnd: event.eventEnd,
    minimumMinutes: event.minimumMinutes,
    ...countPeople(guests),
    guests,
  };
}

/**
 * Returns the attendance of one guest link's guest. The name falls back to the name in the room
 * when the link has none. The local times of the window use `timeZone`, the time zone of the step.
 */
export function mapGuestLinkAttendance(
  link: ApiGuestLink,
  window: TimeWindow,
  minimumMinutes: number,
  summary: AttendanceSummary,
  timeZone: string,
): GuestLinkAttendanceOutput {
  return {
    id: link.id,
    guestLinkId: link.id,
    roomId: textOrNull(link.roomId),
    emailAddress: textOrNull(link.emailAddress),
    displayName: textOrNull(link.displayName) ?? summary.displayName,
    windowFrom: new Date(window.from).toISOString(),
    windowFromLocal: formatLocalDateTime(window.from, timeZone),
    windowTo: new Date(window.to).toISOString(),
    windowToLocal: formatLocalDateTime(window.to, timeZone),
    minimumMinutes,
    attended: summary.attended,
    totalMinutes: summary.totalMinutes,
    sessionCount: summary.sessionCount,
    firstJoinedAt: summary.firstJoinedAt,
    lastLeftAt: summary.lastLeftAt,
    stillConnected: summary.stillConnected,
  };
}

// Attendees

export const ATTENDEE_SCOPES = ['guest_links', 'everyone'] as const;
export type AttendeeScope = (typeof ATTENDEE_SCOPES)[number];

export type AttendeeGroup = { id: string; userId: string; sessions: ApiAttendanceSession[] };

/**
 * Groups the sessions by attendee. The group ID is the dedupe ID of a poll for new attendees. A
 * guest gets one group with the userId as its ID, so the guest is reported once. Any other person
 * gets one group for each UTC day of a join, with the ID `{userId}:{YYYY-MM-DD}`, so a visit today
 * is reported apart from a visit yesterday. Such a person's session without a readable join is
 * left out.
 *
 * A guest is a userId with the layout of isGuestUserId, because the attendance has no guest flag.
 * The IDs do not depend on the guest links, so a guest whose link is deleted later is not reported
 * again. A guest whose userId has another layout gets one group for each day: it is reported once
 * a day, and no guest is lost. attendeeItems matches a guest to a guest link by the link's userId
 * alone.
 */
export function groupSessions(entries: readonly ApiUserAttendances[]): AttendeeGroup[] {
  const groups = new Map<string, AttendeeGroup>();
  for (const entry of entries) {
    const userId = entry.userId.toLowerCase();
    const guest = isGuestUserId(userId);
    for (const session of entry.attendances) {
      let id = userId;
      if (!guest) {
        const from = normalizeTimestamp(session.from);
        if (from === null) continue;
        id = `${userId}:${from.slice(0, 10)}`;
      }
      const group = groups.get(id) ?? { id, userId, sessions: [] };
      group.sessions.push(session);
      groups.set(id, group);
    }
  }
  return [...groups.values()];
}

/**
 * Returns the attendees of `groups`, sorted by first join with the latest first, then by ID.
 * People whose userId belongs to a guest link of the room get `guest_link` and the link's email
 * address, name, ID and origin. Everyone else gets `other` and the name from the room. With the
 * scope `guest_links`, the others are left out. `roomName` is `null`, and the caller adds it.
 */
export function attendeeItems(
  groups: readonly AttendeeGroup[],
  linksByUserId: ReadonlyMap<string, ApiGuestLink>,
  options: { roomId: string; scope: AttendeeScope; window: TimeWindow; now: number },
): AttendeeOutput[] {
  const items: AttendeeOutput[] = [];
  for (const group of groups) {
    const summary = summarize(group.sessions, options.window, options.now, 0);
    if (summary.sessionCount === 0) continue;
    const link = linksByUserId.get(group.userId);
    if (link === undefined && options.scope === 'guest_links') continue;
    items.push({
      id: group.id,
      userId: group.userId,
      attendeeType: link === undefined ? 'other' : 'guest_link',
      roomId: options.roomId,
      roomName: null,
      displayName: (link === undefined ? null : textOrNull(link.displayName)) ?? summary.displayName,
      emailAddress: link === undefined ? null : textOrNull(link.emailAddress),
      guestLinkId: link === undefined ? null : link.id,
      guestLinkOrigin: link === undefined ? null : textOrNull(link.origin),
      firstJoinedAt: summary.firstJoinedAt,
      lastLeftAt: summary.lastLeftAt,
      stillConnected: summary.stillConnected,
      totalMinutes: summary.totalMinutes,
      sessionCount: summary.sessionCount,
    });
  }
  return items.sort((left, right) => {
    const byJoin = (right.firstJoinedAt ?? '').localeCompare(left.firstJoinedAt ?? '');
    return byJoin !== 0 ? byJoin : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

// Report events

/**
 * An event: the guest links of one room that share Valid From and Valid Until. `id` is
 * `{roomId}|{eventStart}|{eventEnd}`, the dedupe ID of its report.
 */
export type ReportEvent = {
  id: string;
  roomId: string;
  eventStart: string;
  eventEnd: string;
  links: ApiGuestLink[];
};

/** Returns the attendance window of an event: the shared validity of its links. */
export function eventWindow(event: ReportEvent): TimeWindow {
  return { from: Date.parse(event.eventStart), to: Date.parse(event.eventEnd) };
}

function newestEventFirst(left: ReportEvent, right: ReportEvent): number {
  if (left.eventEnd !== right.eventEnd) return left.eventEnd < right.eventEnd ? 1 : -1;
  if (left.eventStart !== right.eventStart) return left.eventStart < right.eventStart ? 1 : -1;
  return left.roomId < right.roomId ? -1 : left.roomId > right.roomId ? 1 : 0;
}

/**
 * Returns the events that are ready for a report, the latest Valid Until first. A link counts when
 * it has the userId of its guest (guestUserIdOf) and a room, and its origin matches
 * `originContains`. Its Valid Until must be at most MAX_WINDOW_MS after its Valid From and not
 * before it, and at least READY_DELAY_MS ago. A normal poll also needs a Valid Until at most
 * LOOKBACK_MS ago. A sample load or a manual run (`loadingSample`) takes every event whose Valid
 * From is at most RETENTION_LIMIT_MS ago instead, so that it shows the last real event.
 */
export function readyEvents(
  links: readonly ApiGuestLink[],
  options: { now: number; originContains?: string; loadingSample: boolean },
): ReportEvent[] {
  const events = new Map<string, ReportEvent>();
  for (const link of links) {
    if (guestUserIdOf(link) === null) continue;
    if (typeof link.roomId !== 'string' || link.roomId === '') continue;
    if (!originMatches(link.origin, options.originContains)) continue;
    const eventStart = normalizeTimestamp(link.validFrom);
    const eventEnd = normalizeTimestamp(link.validUntil);
    if (eventStart === null || eventEnd === null) continue;

    const start = Date.parse(eventStart);
    const end = Date.parse(eventEnd);
    if (end < start || end - start > MAX_WINDOW_MS) continue;
    if (end > options.now - READY_DELAY_MS) continue;
    const inLookback = options.loadingSample
      ? start >= options.now - RETENTION_LIMIT_MS
      : end >= options.now - LOOKBACK_MS;
    if (!inLookback) continue;

    const roomId = link.roomId.toLowerCase();
    const id = `${roomId}|${eventStart}|${eventEnd}`;
    const event = events.get(id) ?? { id, roomId, eventStart, eventEnd, links: [] };
    event.links.push(link);
    events.set(id, event);
  }
  return [...events.values()].sort(newestEventFirst);
}

/**
 * Returns the report of one event. Each link's guest is matched by the userId of the link
 * (guestUserIdOf). A link without one has no sessions, and readyEvents leaves such links out.
 * `roomName` is `null`, and the caller adds it.
 */
export function buildReport(
  event: ReportEvent,
  entries: readonly ApiUserAttendances[],
  now: number,
  minimumMinutes: number,
): AttendanceReportOutput {
  const window = eventWindow(event);
  const sessionsByUser = sessionsByUserId(entries);
  const guests = event.links.map((link) => {
    const userId = guestUserIdOf(link);
    const sessions = (userId === null ? undefined : sessionsByUser.get(userId)) ?? [];
    return mapReportGuest(link, summarize(sessions, window, now, minimumMinutes));
  });
  return mapAttendanceReport({
    id: event.id,
    roomId: event.roomId,
    roomName: null,
    eventStart: event.eventStart,
    eventEnd: event.eventEnd,
    minimumMinutes,
    links: event.links,
    guests,
  });
}

// Readers and checks

/** The names of the attendance fields and choices in the messages of createAttendanceReaders. */
export type AttendanceLabels = {
  from: string;
  to: string;
  minimumMinutes: string;
  /**
   * The Attendees field that readAttendeeScope reads. guestLinkChoice and everyoneChoice name its
   * two choices.
   */
  attendees: string;
  guestLinkChoice: string;
  everyoneChoice: string;
};

/** The readers of createAttendanceReaders. */
export type AttendanceReaders = {
  /**
   * Refuses `from` after `to`, a window longer than MAX_WINDOW_MS and a `from` more than
   * RETENTION_LIMIT_MS before `now`. The check is on `from`, because a guest joins at or after it
   * and userIds expire 40 days after the join.
   */
  checkWindow: (from: number, to: number, now: number) => void;
  /** Reads the Minimum Minutes field: a whole number, 0 or more. Empty gives 0. */
  readMinimumMinutes: (value: unknown) => number;
  /** Reads the Attendees field in any case. Empty gives `guest_links`. */
  readAttendeeScope: (value: unknown) => AttendeeScope;
};

/**
 * Returns the attendance readers bound to `platform`, with the field and choice names of `labels`
 * in their messages.
 */
export function createAttendanceReaders(
  platform: Platform,
  labels: AttendanceLabels,
): AttendanceReaders {
  const { readInteger, readString } = createInputReaders(platform);
  return {
    checkWindow(from, to, now) {
      if (from > to) throw platform.invalidInput(`${labels.to} must be after ${labels.from}.`);
      if (to - from > MAX_WINDOW_MS) {
        throw platform.invalidInput(`${labels.to} must be at most 26 hours after ${labels.from}.`);
      }
      if (from < now - RETENTION_LIMIT_MS) {
        throw platform.invalidInput(
          `${labels.from} is more than 39 days ago. alfaview removes the user IDs and names from attendance after 40 days.`,
        );
      }
    },
    readMinimumMinutes: (value) => readInteger(value, labels.minimumMinutes, { min: 0 }) ?? 0,
    readAttendeeScope(value) {
      const text = readString(value, labels.attendees)?.toLowerCase();
      if (text === undefined) return 'guest_links';
      if (text === 'guest_links' || text === 'everyone') return text;
      throw platform.invalidInput(
        `${labels.attendees} must be ${labels.guestLinkChoice} or ${labels.everyoneChoice}.`,
      );
    },
  };
}
