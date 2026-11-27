// Attendance for the MCP tools, with the room report of get_room_attendance. The API shapes and the
// session rules are in ../shared/attendance.ts.
import type { CallApi } from '../alfaview/client.ts';
import { invalidInput, invalidResponse, ToolError } from '../alfaview/errors.ts';
import { platform } from '../platform.ts';
import {
  ATTENDANCE_DENIED_MESSAGE,
  createAttendanceReaders,
  guestLinksByUserId,
  guestUserIdOf,
  MAX_WINDOW_MS,
  sessionsByUserId,
  sharedOrigin,
  summarize,
  type ApiAttendanceSession,
  type ApiUserAttendances,
  type AttendanceStatus,
  type AttendanceSummary,
  type TimeWindow,
} from '../shared/attendance.ts';
import { textOrNull } from '../shared/outputValues.ts';
import { formatInstant, formatTimestamp, instantOf } from '../values/time.ts';
import { listGuestLinks, type ApiGuestLink } from './guestLinks.ts';
import { roomPath } from './rooms.ts';

export {
  ATTENDANCE_DENIED_MESSAGE,
  DAY_MS,
  dropExpiredUsers,
  guestLinkAttendanceWindow,
  guestUserIdOf,
  HOUR_MS,
  sessionsOfUser,
  summarize,
  UNMATCHABLE_GUEST_LINK_MESSAGE,
} from '../shared/attendance.ts';
export type {
  ApiAttendanceSession,
  ApiUserAttendances,
  TimeWindow,
} from '../shared/attendance.ts';

// Constants

/** Maximum invited people for the email lists of get_room_attendance: above it, both are `null`. */
export const MAX_LISTED_EMAILS = 400;

/** Maximum other attendees that get_room_attendance lists. */
export const MAX_OTHER_ATTENDEES = 20;

export const NO_ORIGIN_WINDOW_MESSAGE =
  'No guest link of this room has this origin and a validity period. Give from and to.';

export const ORIGIN_WINDOW_TOO_LONG_MESSAGE =
  'The guest links with this origin span more than 26 hours. Give from and to.';

// Window check

/**
 * Refuses a window that alfaview would refuse or that reaches past the attendance retention: `from`
 * after `to`, more than 26 hours, or `from` more than 39 days before `now`. The check is on `from`,
 * because a guest joins at or after it and userIds expire 40 days after the join. The server reads
 * the minimum minutes with zod and has no Attendees parameter, so no message of the server uses
 * the labels of readMinimumMinutes and readAttendeeScope.
 */
export const { checkWindow } = createAttendanceReaders(platform, {
  from: 'from',
  to: 'to',
  minimumMinutes: 'minimumMinutes',
  attendees: 'Attendees',
  guestLinkChoice: 'People with a Guest Link',
  everyoneChoice: 'Everyone',
});

// Requests

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns the attendance of a room in `window` from `GET /v2/rooms/{roomId}/attendances`.
 * {@link ApiUserAttendances} says what each entry holds. alfaview keeps each session for 62 days
 * after it ends, but its userId and name only for 40 days after the join (spec: ListAttendances
 * `from`, UserAttendances.userId and Attendance.displayName). An older row can come back under the
 * nil UUID, which dropExpiredUsers removes.
 *
 * alfaview answers 403 both for a room that does not exist and for a missing permission, and both
 * give ATTENDANCE_DENIED_MESSAGE. Entries without a userId and sessions that are not objects are
 * left out, and `null` counts as no sessions.
 */
export async function listAttendances(
  api: CallApi,
  roomId: string,
  window: TimeWindow,
): Promise<ApiUserAttendances[]> {
  const { status, data } = await api.request<unknown>({
    method: 'GET',
    path: `${roomPath(roomId)}/attendances`,
    query: { from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString() },
    allowStatuses: [403],
  });
  if (status === 403) throw new ToolError('Forbidden', ATTENDANCE_DENIED_MESSAGE, 403);
  if (data === undefined || data === null) return [];
  if (!Array.isArray(data)) {
    throw invalidResponse('alfaview sent an unexpected attendance response.');
  }
  return data.filter(isObject).flatMap((entry): ApiUserAttendances[] =>
    typeof entry.userId === 'string' && entry.userId !== ''
      ? [
          {
            userId: entry.userId,
            attendances: Array.isArray(entry.attendances)
              ? (entry.attendances.filter(isObject) as ApiAttendanceSession[])
              : [],
          },
        ]
      : [],
  );
}

/**
 * Returns the guest links of a room from all pages of its list, each under the userId of its guest
 * that alfaview returns with the link (guestLinksByUserId). A link without that userId is left
 * out. The participant outputs read it only when a guest is connected.
 */
export async function readGuestLinksByUserId(
  api: CallApi,
  roomId: string,
): Promise<Map<string, ApiGuestLink>> {
  const { items } = await listGuestLinks(api, roomId);
  return guestLinksByUserId(items);
}

// The attendance of one guest link

export type GuestLinkAttendance = {
  guestLinkId: string;
  roomId: string | null;
  emailAddress: string | null;
  displayName: string | null;
  windowFrom: string;
  windowTo: string;
  minimumMinutes: number;
  attended: boolean;
  totalMinutes: number;
  sessionCount: number;
  firstJoinedAt: string | null;
  lastLeftAt: string | null;
  stillConnected: boolean;
};

/** Returns the attendance of one guest link. The name falls back to the name in the room. */
export function mapGuestLinkAttendance(
  link: ApiGuestLink,
  window: TimeWindow,
  minimumMinutes: number,
  summary: AttendanceSummary,
  timeZone: string,
): GuestLinkAttendance {
  return {
    guestLinkId: link.id,
    roomId: textOrNull(link.roomId),
    emailAddress: textOrNull(link.emailAddress),
    displayName: textOrNull(link.displayName) ?? summary.displayName,
    windowFrom: formatInstant(window.from, timeZone),
    windowTo: formatInstant(window.to, timeZone),
    minimumMinutes,
    attended: summary.attended,
    totalMinutes: summary.totalMinutes,
    sessionCount: summary.sessionCount,
    firstJoinedAt: formatTimestamp(summary.firstJoinedAt, timeZone),
    lastLeftAt: formatTimestamp(summary.lastLeftAt, timeZone),
    stillConnected: summary.stillConnected,
  };
}

// The attendance of a room

/** Returns the validity of a link in milliseconds, or `undefined` when a bound is not set. */
function validityOf(link: ApiGuestLink): TimeWindow | undefined {
  const from = instantOf(link.validFrom);
  const to = instantOf(link.validUntil);
  return from === null || to === null ? undefined : { from, to };
}

function hasOrigin(link: ApiGuestLink, origin: string | undefined): boolean {
  return origin === undefined || link.origin === origin;
}

/**
 * Returns the links that count as invited: with the userId of their guest (guestUserIdOf), with
 * both bounds of the validity set and inside the window, and with exactly `origin` when it is
 * given. The guest of a link appears in the attendance under that userId (spec: GuestLink.userId),
 * so a link without it cannot be matched and is left out.
 */
export function invitedLinks(
  links: readonly ApiGuestLink[],
  window: TimeWindow,
  origin: string | undefined,
): ApiGuestLink[] {
  return links.filter((link) => {
    const validity = validityOf(link);
    return (
      guestUserIdOf(link) !== null &&
      hasOrigin(link, origin) &&
      validity !== undefined &&
      window.from <= validity.from &&
      validity.to <= window.to
    );
  });
}

export type Invitee = {
  emailAddress: string | null;
  displayName: string | null;
  guestLinkIds: string[];
  origin: string | null;
  status: AttendanceStatus;
  totalMinutes: number;
  firstJoinedAt: string | null;
  lastLeftAt: string | null;
};

function emailKey(link: ApiGuestLink): string | null {
  return textOrNull(link.emailAddress?.trim().toLowerCase());
}

/** Returns the order of two different texts, such as IDs. */
function byText(left: string, right: string): number {
  return left < right ? -1 : 1;
}

/**
 * Orders invitees by email address in any case, a person without one first, then by the first
 * link ID. Two people never share a link, so the IDs always differ.
 */
function byEmailThenId(left: Invitee, right: Invitee): number {
  const leftEmail = (left.emailAddress ?? '').toLowerCase();
  const rightEmail = (right.emailAddress ?? '').toLowerCase();
  if (leftEmail !== rightEmail) return byText(leftEmail, rightEmail);
  return byText(left.guestLinkIds[0]!, right.guestLinkIds[0]!);
}

/**
 * Returns the invited people of `links`, the result of invitedLinks. Links with the same email
 * address (trimmed, any case) are one person, and a link without one is a person of its own. A
 * person's minutes are the merged minutes of the sessions of all their links. The name is that of
 * the first link with a name, else the name in the room. The origin is the one that all their
 * links share, else `null`. Sorted by email address, then by the first link ID.
 */
export function invitedPeople(
  links: readonly ApiGuestLink[],
  entries: readonly ApiUserAttendances[],
  window: TimeWindow,
  now: number,
  minimumMinutes: number,
  timeZone: string,
): Invitee[] {
  const people = new Map<string, ApiGuestLink[]>();
  for (const link of links) {
    const key = emailKey(link) ?? `link:${link.id}`;
    const personLinks = people.get(key);
    if (personLinks === undefined) people.set(key, [link]);
    else personLinks.push(link);
  }
  const sessionsByUser = sessionsByUserId(entries);

  return [...people.values()]
    .map((personLinks): Invitee => {
      const sorted = [...personLinks].sort((left, right) => byText(left.id, right.id));
      const sessions = sorted.flatMap((link) => {
        const userId = guestUserIdOf(link);
        return (userId === null ? undefined : sessionsByUser.get(userId)) ?? [];
      });
      const summary = summarize(sessions, window, now, minimumMinutes);
      const named = sorted.find((link) => textOrNull(link.displayName) !== null);
      const withEmail = sorted.find((link) => emailKey(link) !== null);
      return {
        emailAddress: withEmail === undefined ? null : withEmail.emailAddress!.trim(),
        displayName: textOrNull(named?.displayName) ?? summary.displayName,
        guestLinkIds: sorted.map((link) => link.id),
        origin: sharedOrigin(sorted),
        status: summary.attended ? 'attended' : 'no_show',
        totalMinutes: summary.totalMinutes,
        firstJoinedAt: formatTimestamp(summary.firstJoinedAt, timeZone),
        lastLeftAt: formatTimestamp(summary.lastLeftAt, timeZone),
      };
    })
    .sort(byEmailThenId);
}

/**
 * Returns the email addresses of the invited people who attended and who did not: lowercase, each
 * once, sorted. A person without an email address is in neither list. Both are `null` above
 * MAX_LISTED_EMAILS invited people.
 */
export function emailLists(invitees: readonly Invitee[]): {
  attendedEmails: string[] | null;
  noShowEmails: string[] | null;
} {
  if (invitees.length > MAX_LISTED_EMAILS) return { attendedEmails: null, noShowEmails: null };
  const list = (status: AttendanceStatus) =>
    [
      ...new Set(
        invitees.flatMap((person) =>
          person.status === status && person.emailAddress !== null
            ? [person.emailAddress.trim().toLowerCase()]
            : [],
        ),
      ),
    ].sort();
  return { attendedEmails: list('attended'), noShowEmails: list('no_show') };
}

export type OtherAttendee = {
  userId: string;
  displayName: string | null;
  emailAddress: string | null;
  guestLinkId: string | null;
  totalMinutes: number;
  sessionCount: number;
  firstJoinedAt: string | null;
  lastLeftAt: string | null;
  stillConnected: boolean;
};

/**
 * Returns the people with sessions in the window who belong to no invited link, for example users
 * of the company or guests of other links. A guest of another link of the room (`allLinks`) gets
 * that link's email address and ID. Sorted by the first join, then by userId. The caller removes
 * the expired users from `entries` first, with dropExpiredUsers.
 */
export function otherAttendees(
  entries: readonly ApiUserAttendances[],
  invited: readonly ApiGuestLink[],
  allLinks: readonly ApiGuestLink[],
  window: TimeWindow,
  now: number,
  timeZone: string,
): OtherAttendee[] {
  const invitedUserIds = new Set(guestLinksByUserId(invited).keys());
  const linksByUserId = guestLinksByUserId(allLinks);
  const sessionsByUserId = new Map<string, ApiAttendanceSession[]>();
  for (const entry of entries) {
    const userId = entry.userId.toLowerCase();
    if (invitedUserIds.has(userId)) continue;
    sessionsByUserId.set(userId, [...(sessionsByUserId.get(userId) ?? []), ...entry.attendances]);
  }

  return [...sessionsByUserId]
    .map(([userId, sessions]) => ({ userId, summary: summarize(sessions, window, now, 0) }))
    // With a session, firstJoinedAt is set, and a UTC ISO string sorts in time order.
    .filter(({ summary }) => summary.sessionCount > 0)
    .sort((left, right) =>
      left.summary.firstJoinedAt === right.summary.firstJoinedAt
        ? byText(left.userId, right.userId)
        : byText(left.summary.firstJoinedAt!, right.summary.firstJoinedAt!),
    )
    .map(({ userId, summary }): OtherAttendee => {
      const link = linksByUserId.get(userId);
      return {
        userId,
        displayName: textOrNull(link?.displayName) ?? summary.displayName,
        emailAddress: textOrNull(link?.emailAddress),
        guestLinkId: link?.id ?? null,
        totalMinutes: summary.totalMinutes,
        sessionCount: summary.sessionCount,
        firstJoinedAt: formatTimestamp(summary.firstJoinedAt, timeZone),
        lastLeftAt: formatTimestamp(summary.lastLeftAt, timeZone),
        stillConnected: summary.stillConnected,
      };
    });
}

/**
 * Returns the window of get_room_attendance without from and to: from the earliest validFrom to
 * the latest validUntil of the links with exactly `origin` that have both bounds. None, or a span
 * of more than 26 hours, gives an error that asks for from and to.
 */
export function windowOfOrigin(links: readonly ApiGuestLink[], origin: string): TimeWindow {
  const validities = links.flatMap((link) => {
    const validity = link.origin === origin ? validityOf(link) : undefined;
    return validity === undefined ? [] : [validity];
  });
  if (validities.length === 0) throw invalidInput(NO_ORIGIN_WINDOW_MESSAGE);
  const window = {
    from: Math.min(...validities.map((validity) => validity.from)),
    to: Math.max(...validities.map((validity) => validity.to)),
  };
  if (window.to - window.from > MAX_WINDOW_MS) throw invalidInput(ORIGIN_WINDOW_TOO_LONG_MESSAGE);
  return window;
}

/**
 * Returns the links (with exactly `origin` when it is given) whose validity overlaps the window
 * without lying inside it, sorted by validFrom, then by ID. When no link is invited, they explain
 * why.
 */
export function overlappingLinks(
  links: readonly ApiGuestLink[],
  window: TimeWindow,
  origin: string | undefined,
): ApiGuestLink[] {
  return links
    .flatMap((link) => {
      const validity = hasOrigin(link, origin) ? validityOf(link) : undefined;
      if (validity === undefined) return [];
      const overlaps = validity.from < window.to && validity.to > window.from;
      const inside = window.from <= validity.from && validity.to <= window.to;
      return overlaps && !inside ? [{ link, from: validity.from }] : [];
    })
    .sort((left, right) => left.from - right.from || byText(left.link.id, right.link.id))
    .map(({ link }) => link);
}
