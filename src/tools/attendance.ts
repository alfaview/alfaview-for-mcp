// The attendance tools get_room_attendance and get_guest_link_attendance. alfaview keeps a session
// for 62 days after it ends, but its userId and name only for 40 days after the join. A window is
// at most 26 hours long, and alfaview counts every connection, also time in the waiting room.
import * as z from 'zod';
import { invalidInput } from '../alfaview/errors.ts';
import {
  checkWindow,
  dropExpiredUsers,
  emailLists,
  guestLinkAttendanceWindow,
  guestUserIdOf,
  invitedLinks,
  invitedPeople,
  listAttendances,
  mapGuestLinkAttendance,
  MAX_LISTED_EMAILS,
  MAX_OTHER_ATTENDEES,
  otherAttendees,
  overlappingLinks,
  sessionsOfUser,
  summarize,
  UNMATCHABLE_GUEST_LINK_MESSAGE,
  windowOfOrigin,
  type TimeWindow,
} from '../domain/attendance.ts';
import {
  getGuestLink,
  listGuestLinks,
  roomOfLink,
  type ApiGuestLink,
} from '../domain/guestLinks.ts';
import { formatLocalDateTime } from '../shared/dateTime.ts';
import { readDateTime } from '../values/inputs.ts';
import { formatInstant, formatLocalTimestamp } from '../values/time.ts';
import { LIST_PAGE, toolOutput } from './outputs.ts';
import {
  count,
  dateTimeParameter,
  defineTool,
  guestLinkIdParameter,
  limitParameter,
  listPart,
  offsetParameter,
  READ_ANNOTATIONS,
  roomIdParameter,
  showing,
  textParameter,
} from './tool.ts';

function minimumMinutesParameter() {
  return z
    .number()
    .int()
    .min(0)
    .max(1440)
    .default(0)
    .describe(
      'The minutes connected that count as attended. 0 counts every connection, also in the waiting room.',
    );
}

/** Returns the window from `from` to `to` (UTC ISO strings), or throws as checkWindow does. */
function checkedWindow(from: string, to: string, now: number): TimeWindow {
  const window = { from: Date.parse(from), to: Date.parse(to) };
  checkWindow(window.from, window.to, now);
  return window;
}

// get_room_attendance

/** The window that the call gives, checked, or the origin whose links give the window. */
type WindowRequest = { window: TimeWindow } | { origin: string };

/**
 * Returns the checked window of `from` and `to`, or the origin when the call gives neither.
 * Refuses `from` or `to` alone, and a call without them and without `origin`, before any request.
 */
function readWindowRequest(
  input: { from?: string; to?: string; origin?: string },
  timeZone: string,
  now: number,
): WindowRequest {
  const from = readDateTime(input.from, 'from', timeZone);
  const to = readDateTime(input.to, 'to', timeZone);
  if ((from === undefined) !== (to === undefined)) {
    throw invalidInput('Give from and to together, or neither.');
  }
  if (from === undefined || to === undefined) {
    if (input.origin === undefined) throw invalidInput('Give from and to, or origin.');
    return { origin: input.origin };
  }
  return { window: checkedWindow(from, to, now) };
}

/** Returns the validity of the links with `origin`, checked like a window that the call gives. */
function checkedWindowOfOrigin(
  links: readonly ApiGuestLink[],
  origin: string,
  now: number,
): TimeWindow {
  const window = windowOfOrigin(links, origin);
  checkWindow(window.from, window.to, now);
  return window;
}

/**
 * Returns the warning when no link lies inside the window but some overlap it. `overlapping` holds
 * at least one link. The times are local times in `timeZone`, as in a summary.
 */
function overlapWarning(overlapping: readonly ApiGuestLink[], timeZone: string): string {
  const first = overlapping[0]!;
  const validFrom = formatLocalTimestamp(first.validFrom, timeZone);
  const validUntil = formatLocalTimestamp(first.validUntil, timeZone);
  const verb = overlapping.length === 1 ? 'overlaps' : 'overlap';
  return `No guest link lies inside the window, but ${overlapping.length} ${verb} it, for example one valid from ${validFrom} until ${validUntil}. Widen from and to, or leave them out and give origin.`;
}

/** The text of `status` of get_room_attendance with Personal data set to Include. */
export const STATUS_TEXT =
  'Which invited people to list. The counts and the email lists always cover everyone.';

/**
 * The text of `status` with Personal data set to Leave out. As the description of the tool does,
 * it says that the email lists are null and that the counts and statuses remain.
 */
export const STATUS_TEXT_WITHOUT_PERSONAL_DATA =
  'Which invited people to list. The counts always cover everyone. This server leaves out personal data: the email lists of attendees and no-shows are null. The counts and the status per guest link remain.';

/** Returns the parameters of get_room_attendance, with `statusText` as the text of `status`. */
function roomAttendanceSchema(statusText: string) {
  return z.strictObject({
    roomId: roomIdParameter,
    origin: textParameter(
      'Only guest links with exactly this origin count as invited, for example Webinar 2026-10-07.',
      256,
    ).optional(),
    from: dateTimeParameter(
      'Start of the window. Give from and to, or origin alone.',
      'server',
    ).optional(),
    to: dateTimeParameter('End of the window, at most 26 hours after from.', 'server').optional(),
    minimumMinutes: minimumMinutesParameter(),
    status: z.enum(['all', 'attended', 'no_show']).default('all').describe(statusText),
    includeOtherAttendees: z
      .boolean()
      .default(false)
      .describe(
        'Also list the people who attended without an invited guest link, such as users of the company.',
      ),
    limit: limitParameter('invited people', 40, 10),
    offset: offsetParameter(),
  });
}

export const getRoomAttendanceTool = defineTool({
  name: 'get_room_attendance',
  level: 'read',
  title: 'Get the attendance of a room',
  description:
    'Reports who attended an alfaview room, for example a webinar: invited people with attended or no-show and their minutes, and the email lists of attendees and no-shows. Guest links whose validity is inside the window count as invited. The window is from and to, starting less than 39 days ago, or the validity of the links with origin.',
  descriptionWithoutPersonalData:
    'Reports who attended an alfaview room, for example a webinar: invited people with attended or no-show and their minutes. Guest links whose validity is inside the window count as invited. The window is from and to, starting less than 39 days ago, or the validity of the links with origin. This server leaves out personal data: the email lists of attendees and no-shows are null, and so are names and email addresses. The counts and the status per guest link remain.',
  inputSchema: roomAttendanceSchema(STATUS_TEXT),
  // The text of `status` names the email lists, so it has its own text with Leave out.
  inputSchemaWithoutPersonalData: roomAttendanceSchema(STATUS_TEXT_WITHOUT_PERSONAL_DATA),
  annotations: READ_ANNOTATIONS,
  personalData: { shape: 'mcp.roomAttendance' },
  // The email lists are null above MAX_LISTED_EMAILS invited people, and origin is null without an
  // origin in the call. With Personal data set to Leave out, all three are null.
  output: toolOutput({
    roomId: z.string(),
    windowFrom: z.string(),
    windowTo: z.string(),
    origin: z.string().nullable(),
    minimumMinutes: z.int(),
    invitedCount: z.int(),
    attendedCount: z.int(),
    noShowCount: z.int(),
    otherAttendeeCount: z.int(),
    attendedEmails: z.array(z.string()).nullable(),
    noShowEmails: z.array(z.string()).nullable(),
    ...LIST_PAGE,
    invitees: z.array(
      z.strictObject({
        emailAddress: z.string().nullable(),
        displayName: z.string().nullable(),
        guestLinkIds: z.array(z.string()),
        origin: z.string().nullable(),
        status: z.enum(['attended', 'no_show']),
        totalMinutes: z.int(),
        firstJoinedAt: z.string().nullable(),
        lastLeftAt: z.string().nullable(),
      }),
    ),
    otherAttendees: z.array(
      z.strictObject({
        userId: z.string(),
        displayName: z.string().nullable(),
        emailAddress: z.string().nullable(),
        guestLinkId: z.string().nullable(),
        totalMinutes: z.int(),
        sessionCount: z.int(),
        firstJoinedAt: z.string().nullable(),
        lastLeftAt: z.string().nullable(),
        stillConnected: z.boolean(),
      }),
    ),
  }),
  async run(input, { api, now, timeZone }) {
    const roomId = input.roomId.toLowerCase();
    const request = readWindowRequest(input, timeZone, now);

    const { items: links } = await listGuestLinks(api, roomId);
    const window =
      'window' in request ? request.window : checkedWindowOfOrigin(links, request.origin, now);
    const entries = dropExpiredUsers(await listAttendances(api, roomId, window));

    const invited = invitedLinks(links, window, input.origin);
    const people = invitedPeople(invited, entries, window, now, input.minimumMinutes, timeZone);
    const others = otherAttendees(entries, invited, links, window, now, timeZone);
    const invitedCount = people.length;
    const attendedCount = people.filter((person) => person.status === 'attended').length;
    const noShowCount = invitedCount - attendedCount;
    const matches =
      input.status === 'all' ? people : people.filter((person) => person.status === input.status);
    const part = listPart(matches, input.offset, input.limit);

    const warnings: string[] = [];
    if (invitedCount > MAX_LISTED_EMAILS) {
      warnings.push(
        `More than ${MAX_LISTED_EMAILS} invited people, so attendedEmails and noShowEmails are left out. Read the invitees with status, offset and limit.`,
      );
    }
    if (invitedCount === 0) {
      const overlapping = overlappingLinks(links, window, input.origin);
      if (overlapping.length > 0) warnings.push(overlapWarning(overlapping, timeZone));
    }
    if (input.includeOtherAttendees && others.length > MAX_OTHER_ATTENDEES) {
      warnings.push(
        `${others.length} other people attended, and the list shows the first ${MAX_OTHER_ATTENDEES} by time of joining.`,
      );
    }

    const windowFrom = formatInstant(window.from, timeZone);
    const windowTo = formatInstant(window.to, timeZone);
    const shownFrom = formatLocalDateTime(window.from, timeZone);
    const shownTo = formatLocalDateTime(window.to, timeZone);
    const invitedPeopleCount = count(invitedCount, 'invited person', 'invited people');
    const otherPeople = count(others.length, 'other person', 'other people');
    return {
      summary: `${attendedCount} of ${invitedPeopleCount} attended, ${noShowCount} did not, between ${shownFrom} and ${shownTo}. ${otherPeople} attended.${showing(part, { items: 'invited people' })}`,
      warnings,
      data: {
        roomId,
        windowFrom,
        windowTo,
        origin: input.origin ?? null,
        minimumMinutes: input.minimumMinutes,
        invitedCount,
        attendedCount,
        noShowCount,
        otherAttendeeCount: others.length,
        ...emailLists(people),
        offset: part.offset,
        nextOffset: part.nextOffset,
        invitees: part.items,
        otherAttendees: input.includeOtherAttendees ? others.slice(0, MAX_OTHER_ATTENDEES) : [],
      },
    };
  },
});

// get_guest_link_attendance

export const NO_VALIDITY_MESSAGE = 'This guest link has no validity period. Give from and to.';

export const getGuestLinkAttendanceTool = defineTool({
  name: 'get_guest_link_attendance',
  level: 'read',
  title: 'Get the attendance of a guest link',
  description:
    "Reports whether the guest of one alfaview guest link attended, and for how long, within the link's validity or from and to. After the event the link has expired: find it with find_guest_links and includeExpired true.",
  inputSchema: z.strictObject({
    guestLinkId: guestLinkIdParameter,
    from: dateTimeParameter(
      "Start of the window. Default: the link's validFrom.",
      'server',
    ).optional(),
    to: dateTimeParameter(
      "End of the window, at most 26 hours after from. Default: the link's validUntil.",
      'server',
    ).optional(),
    minimumMinutes: minimumMinutesParameter(),
  }),
  annotations: READ_ANNOTATIONS,
  personalData: { shape: 'mcp.guestLinkAttendance' },
  output: toolOutput({
    guestLinkId: z.string(),
    roomId: z.string().nullable(),
    emailAddress: z.string().nullable(),
    displayName: z.string().nullable(),
    windowFrom: z.string(),
    windowTo: z.string(),
    minimumMinutes: z.int(),
    attended: z.boolean(),
    totalMinutes: z.int(),
    sessionCount: z.int(),
    firstJoinedAt: z.string().nullable(),
    lastLeftAt: z.string().nullable(),
    stillConnected: z.boolean(),
  }),
  async run(input, { api, now, timeZone }) {
    const from = readDateTime(input.from, 'from', timeZone);
    const to = readDateTime(input.to, 'to', timeZone);
    // A window that the call gives in full is checked before the first request.
    if (from !== undefined && to !== undefined) checkedWindow(from, to, now);

    const link = await getGuestLink(api, input.guestLinkId);
    // The guest is matched by the userId that alfaview returns with the link, and only by it.
    const guestUserId = guestUserIdOf(link);
    if (guestUserId === null) throw invalidInput(UNMATCHABLE_GUEST_LINK_MESSAGE);
    const roomId = roomOfLink(link);
    const bounds = guestLinkAttendanceWindow(link, from, to);
    if (bounds === undefined) throw invalidInput(NO_VALIDITY_MESSAGE);
    const window = checkedWindow(bounds.from, bounds.to, now);

    const entries = await listAttendances(api, roomId, window);
    const sessions = sessionsOfUser(entries, guestUserId);
    const summary = summarize(sessions, window, now, input.minimumMinutes);
    const attendance = mapGuestLinkAttendance(
      link,
      window,
      input.minimumMinutes,
      summary,
      timeZone,
    );

    const minutes = count(attendance.totalMinutes, 'minute');
    const sessionCount = count(attendance.sessionCount, 'session');
    const shownFrom = formatLocalDateTime(window.from, timeZone);
    const shownTo = formatLocalDateTime(window.to, timeZone);
    const outcome = attendance.attended
      ? `attended for ${minutes} in ${sessionCount}.`
      : `did not attend between ${shownFrom} and ${shownTo}.`;
    const connected = attendance.stillConnected ? ' The guest is still connected.' : '';
    return {
      summary: `The guest of guest link ${attendance.guestLinkId} ${outcome}${connected}`,
      data: attendance,
    };
  },
});

/** The attendance tools, in the order of the tool list. */
export const ATTENDANCE_TOOLS = [getRoomAttendanceTool, getGuestLinkAttendanceTool] as const;
