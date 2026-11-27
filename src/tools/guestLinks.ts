// The guest link tools: find_guest_links, create_guest_links, update_guest_link,
// delete_guest_link and delete_expired_guest_links.
import * as z from 'zod';
import type { CallApi } from '../alfaview/client.ts';
import {
  invalidInput,
  missingCreatedIdMessage,
  readAfterSavedWrite,
  ToolError,
  UNCERTAIN_CREATE_CODES,
} from '../alfaview/errors.ts';
import {
  ADMIN_GUEST_GROUP_MESSAGE,
  ADMIN_GUEST_LINK_MESSAGE,
  BULK_DELETE_MEETING_ROOM_MESSAGE,
  checkValidity,
  CLEANUP_PAGE_LIMIT,
  createdGuestLink,
  createdLinkId,
  DEFAULT_EXPIRED_AT_LEAST_HOURS,
  DEFAULT_ORIGIN,
  DELETE_NOT_FOUND_MESSAGE,
  deleteLinksWithinBudget,
  duplicateGuestMessage,
  EXISTING_LINK_MESSAGE,
  expiredLinkIds,
  filterGuestLinks,
  findExistingLink,
  getGuestLink,
  guestLinkCreatedButNotReadMessage,
  guestLinkPath,
  guestLinkUpdatedButNotReadMessage,
  guestLinksPath,
  listGuestLinks,
  lookupName,
  mapGuestLink,
  MEETING_ROOM_EMAIL_MESSAGE,
  NOT_ATTEMPTED_MESSAGE,
  OTHER_RIGHTS_MESSAGE,
  PAST_VALID_UNTIL_MESSAGE,
  ROOM_UNKNOWN_EMAIL_MESSAGE,
  roomGuestLinkPath,
  roomOfLink,
  UNCERTAIN_CREATE_MESSAGE,
  UNCERTAIN_CREATE_STATUSES,
} from '../domain/guestLinks.ts';
import {
  groupNamesById,
  listPermissionGroups,
  readGroupNames,
  refuseAdminGroup,
  refuseStoredAdminGroup,
  resolvePermissionGroup,
  type PermissionGroup,
} from '../domain/permissionGroups.ts';
import { getRoom } from '../domain/rooms.ts';
import { booleanOrNull, textOrNull } from '../shared/outputValues.ts';
import type { PersonalDataMode } from '../shared/personalData.ts';
import { compact, readDateTime, readTimeZone } from '../values/inputs.ts';
import { formatTimestamp } from '../values/time.ts';
import { GUEST_LINK, GUEST_LINK_WITHOUT_URL, LIST_PART, toolOutput } from './outputs.ts';
import {
  CHANGE_ANNOTATIONS,
  count,
  CREATE_ANNOTATIONS,
  dateTimeParameter,
  defineTool,
  guestLinkIdParameter,
  IDEMPOTENT_CHANGE_ANNOTATIONS,
  limitParameter,
  listPart,
  localeParameter,
  offsetParameter,
  READ_ANNOTATIONS,
  roomIdParameter,
  roomIdWith,
  showing,
  textParameter,
  timezoneParameter,
  validity,
} from './tool.ts';

/**
 * Returns the permission group that `value` names, Guest without a value, and refuses a group
 * with admin at every access level: the guest could change and delete the room.
 */
function guestGroup(value: string | undefined, groups: readonly PermissionGroup[]): PermissionGroup {
  const group = resolvePermissionGroup(value, groups);
  refuseAdminGroup(group, ADMIN_GUEST_GROUP_MESSAGE);
  return group;
}

// find_guest_links

export const findGuestLinksTool = defineTool({
  name: 'find_guest_links',
  level: 'read',
  title: 'Find guest links',
  description:
    'Lists the personal alfaview guest links (invitation links for one person) of one room or of every room, newest first. Expired links come only with includeExpired: after an event, set it.',
  inputSchema: z.strictObject({
    roomId: roomIdWith('Room ID from find_rooms. Leave it out to search every room.').optional(),
    emailAddress: textParameter('Only links for this email address, in any case.', 320).optional(),
    origin: textParameter(
      'Only links with exactly this origin, for example Webinar 2026-10-07.',
      256,
    ).optional(),
    includeExpired: z
      .boolean()
      .default(false)
      .describe('Also return links whose validUntil has passed.'),
    includeJoinUrls: z
      .boolean()
      .default(false)
      .describe(
        'Also return the join URLs. A join URL is a credential: whoever has it can join as the guest.',
      ),
    limit: limitParameter('guest links', 50, 20),
    offset: offsetParameter(),
  }),
  annotations: READ_ANNOTATIONS,
  personalData: { shape: 'mcp.guestLink', list: 'links' },
  output: toolOutput({
    roomId: z.string().nullable(),
    ...LIST_PART,
    expiredMatchCount: z.int(),
    links: z.array(GUEST_LINK),
  }),
  async run(input, { api, now, timeZone }) {
    const { items } = await listGuestLinks(api, input.roomId);
    const { links, expiredMatchCount } = filterGuestLinks(
      items,
      {
        emailAddress: input.emailAddress,
        origin: input.origin,
        includeExpired: input.includeExpired,
      },
      now,
    );
    const part = listPart(links, input.offset, input.limit);
    const names = part.items.length > 0 ? await readGroupNames(api) : new Map<string, string>();
    const options = {
      timeZone,
      includeRoomId: input.roomId === undefined,
      includeJoinUrl: input.includeJoinUrls,
    };
    const found =
      part.totalMatches === 0 ? 'no guest links' : count(part.totalMatches, 'guest link');
    const warnings =
      !input.includeExpired && expiredMatchCount > 0
        ? [
            `${count(expiredMatchCount, 'expired guest link')} also ${expiredMatchCount === 1 ? 'matches' : 'match'}. Call again with includeExpired true, for example for attendance after an event.`,
          ]
        : [];
    return {
      summary: `Found ${found}.${showing(part)}`,
      warnings,
      data: {
        roomId: input.roomId ?? null,
        totalMatches: part.totalMatches,
        expiredMatchCount,
        offset: part.offset,
        nextOffset: part.nextOffset,
        links: part.items.map((link) => mapGuestLink(link, names, options)),
      },
    };
  },
});

// create_guest_links

/**
 * Maximum guests per call. Each guest takes one create request, and this many fit well inside the
 * call time limit.
 */
export const MAX_GUESTS_PER_CALL = 25;

/**
 * The message for more guests than a call takes. The description does not name the limit, and the
 * schema keeps it as maxItems.
 */
export const TOO_MANY_GUESTS_MESSAGE =
  `At most ${MAX_GUESTS_PER_CALL} guests per call: create the links in several calls.`;

/**
 * No new guest starts once the call has run this long, so the last guest's requests (the create,
 * and the read back when its answer has no join URL) and the result fit into the call time limit
 * of 50 seconds.
 */
export const CREATE_START_LIMIT_MS = 35_000;

/** The statuses of a guest in the result of create_guest_links. */
const GUEST_STATUSES = ['created', 'existing', 'failed', 'uncertain', 'not_attempted'] as const;

export type GuestStatus = (typeof GUEST_STATUSES)[number];

export type GuestResult = {
  /**
   * The position of the guest in `guests` of the input, from 0, in both modes of Personal data:
   * with Leave out, the result has no email address to match it by.
   */
  index: number;
  emailAddress: string;
  displayName: string;
  status: GuestStatus;
  guestLinkId: string | null;
  joinUrl: string | null;
  /** The rights of the link in `guestLinkId`: for a created link, the ones that the call sent. */
  permissionGroupName: string | null;
  dialInAllowed: boolean | null;
  message: string | null;
};

/** The outcome of one create: the guest's status, and the error that ends the call, if any. */
type Attempt = {
  status: GuestStatus;
  guestLinkId: string | null;
  joinUrl: string | null;
  message: string | null;
  /** Its message is the guest's message. */
  stop?: ToolError;
};

function uncertain(
  code: string,
  status: number | undefined,
  message = UNCERTAIN_CREATE_MESSAGE,
): Attempt {
  return {
    status: 'uncertain',
    guestLinkId: null,
    joinUrl: null,
    message,
    stop: new ToolError(code, message, status),
  };
}

/**
 * Returns whether every location of a 400 or 422 lies in the one guest of the request, such as its
 * email address: the next guest can still succeed. A problem of the whole request (a department
 * room, the dial-in quota, the time zone, the permission group) would fail for every guest.
 */
function concernsOneGuest(error: ToolError): boolean {
  return (
    (error.status === 400 || error.status === 422) &&
    error.fieldLocations.length > 0 &&
    error.fieldLocations.every((location) => location.startsWith('body.create[0].'))
  );
}

/**
 * Sends one `POST /v2/rooms/{id}/guest-links` with one guest. The join URL comes from the create
 * answer, and only an answer without one needs a read back of the link. The body holds the email
 * address and the name of the guest, so with Personal data set to Leave out a 422 names the fields
 * without alfaview's texts.
 */
async function createOneGuestLink(api: CallApi, roomId: string, body: unknown): Promise<Attempt> {
  let answer: { status: number; data: unknown };
  try {
    answer = await api.request<unknown>({
      method: 'POST',
      path: guestLinksPath(roomId),
      body,
      allowStatuses: UNCERTAIN_CREATE_STATUSES,
      personalInput: true,
    });
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    if (UNCERTAIN_CREATE_CODES.includes(error.code)) return uncertain(error.code, error.status);
    return {
      status: 'failed',
      guestLinkId: null,
      joinUrl: null,
      message: error.message,
      stop: concernsOneGuest(error) ? undefined : error,
    };
  }
  if (UNCERTAIN_CREATE_STATUSES.includes(answer.status)) {
    return uncertain('ServerError', answer.status);
  }

  const created = createdGuestLink(answer.data);
  if (created !== undefined) {
    const joinUrl = textOrNull(created.joinUrl);
    return { status: 'created', guestLinkId: created.id, joinUrl, message: null };
  }
  const guestLinkId = createdLinkId(answer.data);
  if (guestLinkId === undefined) {
    return uncertain('InvalidResponse', answer.status, missingCreatedIdMessage('guest link'));
  }
  try {
    const link = await getGuestLink(api, guestLinkId);
    return { status: 'created', guestLinkId, joinUrl: textOrNull(link.joinUrl), message: null };
  } catch (error) {
    // The link exists, whatever the error: the read back must never ask for a second create.
    const message = guestLinkCreatedButNotReadMessage(guestLinkId);
    const code = error instanceof ToolError ? error.code : 'InvalidResponse';
    return {
      status: 'created',
      guestLinkId,
      joinUrl: null,
      message,
      stop: new ToolError(code, message),
    };
  }
}

/**
 * Refuses a guest list that names an email address twice (trimmed, any case). With Personal data
 * set to Leave out, the message leaves the address out.
 */
function checkDistinctGuests(
  guests: readonly { emailAddress: string }[],
  mode: PersonalDataMode,
): void {
  const seen = new Set<string>();
  for (const guest of guests) {
    const key = guest.emailAddress.trim().toLowerCase();
    if (seen.has(key)) throw invalidInput(duplicateGuestMessage(guest.emailAddress, mode));
    seen.add(key);
  }
}

function countOf(results: readonly GuestResult[], status: GuestStatus): number {
  return results.filter((result) => result.status === status).length;
}

export const createGuestLinksTool = defineTool({
  name: 'create_guest_links',
  level: 'standard',
  title: 'Create guest links',
  description:
    'Creates a personal alfaview guest link (an invitation link for one person) for each guest in a room, for example for a booking or a webinar, and returns the join URLs. Safe to repeat: a guest with a valid link of the same email address, origin, validity, permission group and dial-in setting gets that link back, without a new link or email. alfaview emails nobody unless sendEmail is true. Each result has index, the position of its guest in guests, from 0.',
  inputSchema: z.strictObject({
    roomId: roomIdParameter,
    guests: z
      .array(
        z.strictObject({
          emailAddress: textParameter("The guest's email address.", 320),
          displayName: textParameter("The guest's name in the room.", 256),
          locale: localeParameter.describe('Overrides locale for this guest.').optional(),
        }),
      )
      .min(1)
      .max(MAX_GUESTS_PER_CALL, TOO_MANY_GUESTS_MESSAGE)
      .describe('Each guest gets one link.'),
    locale: localeParameter,
    validFrom: dateTimeParameter('The link works from this time.', 'timezone').optional(),
    validUntil: dateTimeParameter(
      'The link works until this time. Give validFrom and validUntil for get_room_attendance.',
      'timezone',
    ).optional(),
    permissionGroup: textParameter(
      'Permission group of the guests, by name or ID. Default: Guest. For a webinar, a group without voice and video, such as Spectator.',
      256,
    ).optional(),
    origin: textParameter(
      'The event or source, for example Webinar 2026-10-07 or a booking URI. The tools match it exactly. Default: MCP.',
      256,
    ).optional(),
    sendEmail: z
      .boolean()
      .default(false)
      .describe('If true, alfaview emails each new guest the link.'),
    // One call has one timezone for all its guests, so guests in several zones need one call each.
    timezone: timezoneParameter(
      "Time zone of the event and of alfaview's email. For guests in another zone, give the times with an offset and their zone here.",
    ).optional(),
    dialInAllowed: z
      .boolean()
      .default(false)
      .describe('If true, the guests can also join by phone. Needs dial-in in the alfaview plan.'),
  }),
  annotations: CREATE_ANNOTATIONS,
  personalData: { shape: 'mcp.createGuestLinksResult' },
  output: toolOutput({
    roomId: z.string(),
    permissionGroupName: z.string(),
    validFrom: z.string().nullable(),
    validUntil: z.string().nullable(),
    createdCount: z.int(),
    existingCount: z.int(),
    failedCount: z.int(),
    uncertainCount: z.int(),
    notAttemptedCount: z.int(),
    results: z.array(
      z.strictObject({
        index: z.int(),
        // emailAddress and displayName are null with Personal data set to Leave out.
        emailAddress: z.string().nullable(),
        displayName: z.string().nullable(),
        status: z.enum(GUEST_STATUSES),
        guestLinkId: z.string().nullable(),
        joinUrl: z.string().nullable(),
        permissionGroupName: z.string().nullable(),
        dialInAllowed: z.boolean().nullable(),
        message: z.string().nullable(),
      }),
    ),
  }),
  readTool: 'find_guest_links',
  async run(input, { api, now, timeZone, signal, personalData }) {
    const timezone = readTimeZone(input.timezone, 'timezone') ?? timeZone;
    const validFrom = readDateTime(input.validFrom, 'validFrom', timezone);
    const validUntil = readDateTime(input.validUntil, 'validUntil', timezone);
    checkValidity(validFrom, validUntil, now, PAST_VALID_UNTIL_MESSAGE);
    checkDistinctGuests(input.guests, personalData);

    const groups = await listPermissionGroups(api);
    const group = guestGroup(input.permissionGroup, groups);
    const names = groupNamesById(groups);
    const { items: links } = await listGuestLinks(api, input.roomId);
    const origin = input.origin ?? DEFAULT_ORIGIN;
    const wanted = {
      origin,
      validFrom,
      validUntil,
      permissionGroupId: group.id,
      dialInAllowed: input.dialInAllowed,
    };

    const results: GuestResult[] = input.guests.map((guest, index) => {
      const person = { index, emailAddress: guest.emailAddress, displayName: guest.displayName };
      const found = findExistingLink(links, guest, wanted, now);
      if (found === undefined) {
        return {
          ...person,
          status: 'not_attempted',
          guestLinkId: null,
          joinUrl: null,
          permissionGroupName: null,
          dialInAllowed: null,
          message: NOT_ATTEMPTED_MESSAGE,
        };
      }
      // A link with other rights is not the guest's link for this call, and a second link would
      // mean a second invitation: the guest fails, and the model can change the link.
      return {
        ...person,
        status: found.sameRights ? 'existing' : 'failed',
        guestLinkId: found.link.id,
        joinUrl: found.sameRights ? textOrNull(found.link.joinUrl) : null,
        permissionGroupName: lookupName(names, found.link.permissionGroupId),
        dialInAllowed: booleanOrNull(found.link.dialInAllowed),
        message: found.sameRights ? EXISTING_LINK_MESSAGE : OTHER_RIGHTS_MESSAGE,
      };
    });

    let attempted = 0;
    for (const [index, result] of results.entries()) {
      if (result.status !== 'not_attempted') continue;
      if (signal.aborted || api.elapsedMs() >= CREATE_START_LIMIT_MS) break;
      const guest = input.guests[index]!;
      const attempt = await createOneGuestLink(api, input.roomId, {
        create: [
          compact({
            emailAddress: guest.emailAddress,
            displayName: guest.displayName,
            locale: guest.locale ?? input.locale,
            permissionGroupId: group.id,
            dialInAllowed: input.dialInAllowed,
            sendEmail: input.sendEmail,
            validFrom,
            validUntil,
          }),
        ],
        origin,
        timezone,
      });
      attempted += 1;
      const { stop, ...outcome } = attempt;
      Object.assign(result, outcome);
      if (attempt.status === 'created') {
        result.permissionGroupName = group.name;
        result.dialInAllowed = input.dialInAllowed;
      }
      if (stop === undefined) continue;
      // A call that stops at its first create, with no link to return, is an error.
      if (attempted === 1 && countOf(results, 'existing') === 0 && attempt.status !== 'created') {
        throw stop;
      }
      break;
    }

    const createdCount = countOf(results, 'created');
    const existingCount = countOf(results, 'existing');
    const failedCount = countOf(results, 'failed');
    const uncertainCount = countOf(results, 'uncertain');
    const notAttemptedCount = countOf(results, 'not_attempted');

    const sentences = [
      `Created ${count(createdCount, 'guest link')} in room ${input.roomId}, ${validity(validFrom, validUntil, timezone)}.`,
    ];
    if (existingCount > 0) sentences.push(`${count(existingCount, 'guest')} already had a link.`);
    if (failedCount > 0) sentences.push(`${failedCount} failed.`);
    sentences.push(
      input.sendEmail ? 'alfaview emails each created guest.' : 'alfaview sent no emails.',
    );
    const warnings =
      uncertainCount > 0 || notAttemptedCount > 0
        ? [
            `${uncertainCount} ${uncertainCount === 1 ? 'link is' : 'links are'} uncertain and ${notAttemptedCount} ${notAttemptedCount === 1 ? 'was' : 'were'} not attempted. Call create_guest_links again with the same input.`,
          ]
        : [];

    return {
      summary: sentences.join(' '),
      warnings,
      data: {
        roomId: input.roomId,
        permissionGroupName: group.name,
        validFrom: formatTimestamp(validFrom, timezone),
        validUntil: formatTimestamp(validUntil, timezone),
        createdCount,
        existingCount,
        failedCount,
        uncertainCount,
        notAttemptedCount,
        results,
      },
    };
  },
});

// update_guest_link

export const updateGuestLinkTool = defineTool({
  name: 'update_guest_link',
  level: 'standard',
  title: 'Update a guest link',
  description:
    'Changes an alfaview guest link. The join URL and the origin never change: for a Calendly reschedule (a new invitee URI), delete the link and create a new one. With sendEmail true, alfaview emails the guest on each call that gives a field other than an unchanged name, also with the same values.',
  inputSchema: z.strictObject({
    guestLinkId: guestLinkIdParameter,
    displayName: textParameter("The guest's name in the room.", 256).optional(),
    emailAddress: textParameter("The guest's email address.", 320).optional(),
    locale: localeParameter.optional(),
    validFrom: dateTimeParameter('The link works from this time.', 'timezone').optional(),
    validUntil: dateTimeParameter('The link works until this time.', 'timezone').optional(),
    permissionGroup: textParameter('Permission group of the guest, by name or ID.', 256).optional(),
    dialInAllowed: z
      .boolean()
      .describe('If true, the guest can also join by phone.')
      .optional(),
    sendEmail: z
      .boolean()
      .default(false)
      .describe('If true, alfaview emails the guest about the change.'),
    timezone: timezoneParameter(
      "Time zone of the event and of that email. For a guest in another zone, give the times with an offset and the guest's zone here.",
    ).optional(),
  }),
  annotations: CHANGE_ANNOTATIONS,
  personalData: { shape: 'mcp.guestLink' },
  output: toolOutput(GUEST_LINK_WITHOUT_URL.shape),
  readTool: 'find_guest_links',
  async run(input, { api, timeZone }) {
    const nameOnly = [
      input.emailAddress,
      input.locale,
      input.validFrom,
      input.validUntil,
      input.permissionGroup,
      input.dialInAllowed,
    ].every((value) => value === undefined);
    if (nameOnly && input.displayName === undefined) {
      throw invalidInput('Give at least one field to change.');
    }
    const timezone = readTimeZone(input.timezone, 'timezone') ?? timeZone;
    const validFrom = readDateTime(input.validFrom, 'validFrom', timezone);
    const validUntil = readDateTime(input.validUntil, 'validUntil', timezone);

    const current = await getGuestLink(api, input.guestLinkId);
    // Without a new group, the stored group decides: a new address or validity of a link with admin
    // would give its rights to someone else or for longer.
    const groups = await listPermissionGroups(api);
    let permissionGroupId: string | undefined;
    if (input.permissionGroup === undefined) {
      refuseStoredAdminGroup(current.permissionGroupId, groups, ADMIN_GUEST_LINK_MESSAGE);
    } else {
      permissionGroupId = guestGroup(input.permissionGroup, groups).id;
    }
    const names = groupNamesById(groups);

    // The result has no join URL, which a change does not need: find_guest_links gives it. Its
    // times are in the call's time zone.
    const output = { timeZone: timezone, includeJoinUrl: false };
    // alfaview compares only the name with the stored one: a call with the same name and no other
    // field changes nothing and sends no email.
    const currentName = textOrNull(current.displayName) ?? '';
    if (nameOnly && input.displayName === currentName) {
      const link = mapGuestLink(current, names, output);
      return {
        summary: `Guest link ${link.id} is unchanged: its name is the same, and no other field was given. alfaview sent no email.`,
        data: link,
      };
    }

    await api.request({
      method: 'PATCH',
      path: guestLinkPath(input.guestLinkId),
      body: {
        ...compact({
          emailAddress: input.emailAddress,
          locale: input.locale,
          validFrom,
          validUntil,
          permissionGroupId,
          dialInAllowed: input.dialInAllowed,
        }),
        // alfaview needs displayName and sendEmail in every update.
        displayName: input.displayName ?? currentName,
        sendEmail: input.sendEmail,
        timezone,
      },
      // The body holds the name, and maybe an email address, which a 422 can repeat.
      personalInput: true,
    });

    // The change is saved: a failed read back must not make the model send it again.
    const stored = await readAfterSavedWrite(
      () => getGuestLink(api, input.guestLinkId),
      guestLinkUpdatedButNotReadMessage(input.guestLinkId),
    );
    const link = mapGuestLink(stored, names, output);
    const email = input.sendEmail
      ? 'alfaview emails the guest about the change.'
      : 'alfaview sent no email.';
    return {
      summary: `Updated guest link ${link.id}, ${validity(link.validFrom, link.validUntil, timezone)}. ${email}`,
      data: link,
    };
  },
});

// delete_guest_link

export const deleteGuestLinkTool = defineTool({
  name: 'delete_guest_link',
  level: 'standard',
  title: 'Delete a guest link',
  description:
    'Deletes an alfaview guest link: its join URL stops working at once. This cannot be undone. No email, except for a link in a meeting room (type meeting, made by create_meeting, inMeetingRoom true in find_guest_links): there the tool refuses unless sendEmail is true.',
  inputSchema: z.strictObject({
    guestLinkId: guestLinkIdParameter,
    sendEmail: z
      .boolean()
      .default(false)
      .describe(
        'Must be true for a link in a meeting room: alfaview then always emails the guest that the link was revoked.',
      ),
  }),
  annotations: IDEMPOTENT_CHANGE_ANNOTATIONS,
  personalData: { shape: 'mcp.guestLink' },
  output: toolOutput({
    guestLinkId: z.string(),
    roomId: z.string(),
    deleted: z.boolean(),
    revocationEmail: z.boolean().nullable(),
  }),
  readTool: 'find_guest_links',
  async run(input, { api }) {
    const link = await getGuestLink(api, input.guestLinkId, { allowNotFound: true });
    if (link === undefined) throw new ToolError('NotFound', DELETE_NOT_FOUND_MESSAGE, 404);
    // The room comes from the link, so a wrong room cannot make alfaview delete nothing.
    const roomId = roomOfLink(link);

    const room = await getRoom(api, roomId, { allowNotFound: true });
    if (!input.sendEmail) {
      if (room === undefined) throw new ToolError('MeetingRoomEmail', ROOM_UNKNOWN_EMAIL_MESSAGE);
      if (room.type === 'meeting') {
        throw new ToolError('MeetingRoomEmail', MEETING_ROOM_EMAIL_MESSAGE);
      }
    }
    const revocationEmail = room === undefined ? null : room.type === 'meeting';

    await api.request({ method: 'DELETE', path: roomGuestLinkPath(roomId, input.guestLinkId) });
    const email = revocationEmail === false ? '' : ' alfaview emails the guest about it.';
    return {
      summary: `Deleted guest link ${input.guestLinkId}. Its join URL no longer works.${email}`,
      data: { guestLinkId: input.guestLinkId, roomId, deleted: true, revocationEmail },
    };
  },
});

// delete_expired_guest_links

export const deleteExpiredGuestLinksTool = defineTool({
  name: 'delete_expired_guest_links',
  level: 'standard',
  title: 'Delete expired guest links',
  description:
    'Deletes the alfaview guest links of one room whose validity ended at least expiredAtLeastHours ago, for example after webinars: old links slow down the guest link and attendance tools. Links without an end of validity stay. alfaview emails nobody. This cannot be undone.',
  inputSchema: z.strictObject({
    roomId: roomIdParameter,
    originContains: textParameter(
      'Only links whose origin contains this text, in any case, for example Webinar.',
      256,
    ).optional(),
    expiredAtLeastHours: z
      .number()
      .int()
      .min(1)
      .max(8760)
      .default(DEFAULT_EXPIRED_AT_LEAST_HOURS)
      .describe(
        'Only links whose validUntil is at least this many hours ago. The attendance tools need the links, so keep 48 or more until the attendance is read.',
      ),
    pageToken: textParameter('The nextPageToken of the previous result.', 128).optional(),
  }),
  // Not idempotent: a call stops after its time budget or page limit and asks for a repeat, which
  // deletes more links.
  annotations: CHANGE_ANNOTATIONS,
  personalData: { shape: 'mcp.deleteExpiredGuestLinksResult' },
  output: toolOutput({
    roomId: z.string(),
    originContains: z.string().nullable(),
    expiredAtLeastHours: z.int(),
    deletedCount: z.int(),
    remainingCount: z.int(),
    complete: z.boolean(),
    nextPageToken: z.string().nullable(),
  }),
  readTool: 'find_guest_links',
  async run(input, { api, now }) {
    const room = await getRoom(api, input.roomId);
    if (room.type === 'meeting') {
      throw new ToolError('MeetingRoomEmail', BULK_DELETE_MEETING_ROOM_MESSAGE);
    }
    const list = await listGuestLinks(api, input.roomId, {
      pageLimit: CLEANUP_PAGE_LIMIT,
      pageToken: input.pageToken,
    });
    const expiredIds = expiredLinkIds(
      list.items,
      { expiredAtLeastHours: input.expiredAtLeastHours, originContains: input.originContains },
      now,
    );
    const deletedCount = await deleteLinksWithinBudget(api, input.roomId, expiredIds);
    const remainingCount = expiredIds.length - deletedCount;
    // nextPageToken goes to the next call only when no expired link of this call remains. A delete
    // does not move alfaview's page token, so that call goes on where this one stopped. Otherwise
    // the next call reads the same links again, with the same input.
    const nextPageToken = remainingCount === 0 ? list.nextPageToken : null;

    const hours = count(input.expiredAtLeastHours, 'hour');
    const remainVerb = remainingCount === 1 ? 'remains' : 'remain';
    const remaining =
      remainingCount === 0
        ? ''
        : ` ${remainingCount} ${remainVerb}: call again with the same input to delete them.`;
    const readCount = count(list.items.length, 'guest link');
    const read = `This call read ${readCount} of the room, and more follow.`;
    const warnings = list.complete
      ? []
      : nextPageToken === null
        ? [`${read} Once a call leaves none remaining, it gives the pageToken for the next ones.`]
        : [`${read} Call again with pageToken ${nextPageToken} to check the next ones.`];
    return {
      summary: `Deleted ${count(deletedCount, 'guest link')} of room ${room.id} whose validity ended at least ${hours} ago.${remaining}`,
      warnings,
      data: {
        roomId: room.id,
        originContains: input.originContains ?? null,
        expiredAtLeastHours: input.expiredAtLeastHours,
        deletedCount,
        remainingCount,
        complete: list.complete,
        nextPageToken,
      },
    };
  },
});

/** The guest link tools, in the order of the tool list. */
export const GUEST_LINK_TOOLS = [
  findGuestLinksTool,
  createGuestLinksTool,
  updateGuestLinkTool,
  deleteGuestLinkTool,
  deleteExpiredGuestLinksTool,
] as const;
