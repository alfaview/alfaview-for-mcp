// Guest links for the MCP tools. The API shape, the limits and the rules that do not depend on MCP
// are in ../shared/guestLinks.ts.
import type { CallApi } from '../alfaview/client.ts';
import { invalidResponse, ToolError } from '../alfaview/errors.ts';
import { fetchAllPages, type PageList } from '../alfaview/pagination.ts';
import { platform } from '../platform.ts';
import {
  createGuestLinkChecks,
  DELETE_CONCURRENCY,
  deletedBeforeError,
  guestLinkPath,
  guestLinksPath,
  LINK_PAGE_SIZE,
  lookupName,
  newestLinkFirst,
  roomGuestLinkPath,
  type ApiGuestLink,
} from '../shared/guestLinks.ts';
import { booleanOrNull, textOrNull } from '../shared/outputValues.ts';
import type { PersonalDataMode } from '../shared/personalData.ts';
import { localeOrNull } from '../shared/users.ts';
import { formatTimestamp, instantOf } from '../values/time.ts';
import { isMeetingRoomId } from './rooms.ts';

export {
  CLEANUP_PAGE_LIMIT,
  createdGuestLink,
  createdLinkId,
  DEFAULT_EXPIRED_AT_LEAST_HOURS,
  DELETE_CONCURRENCY,
  expiredLinkIds,
  filterGuestLinks,
  guestLinkPath,
  guestLinksPath,
  lookupName,
  roomGuestLinkPath,
  UNCERTAIN_CREATE_STATUSES,
} from '../shared/guestLinks.ts';
export type { ApiGuestLink } from '../shared/guestLinks.ts';

// Constants

/** The origin of links created by this server when the input names none. */
export const DEFAULT_ORIGIN = 'MCP';

/**
 * Time since the start of the tool call after which the cleanup starts no new delete, so that the
 * call ends inside its time limit. The next call deletes the rest.
 */
export const DELETE_START_LIMIT_MS = 30_000;

// Messages

export const ALL_ROOMS_DENIED_MESSAGE =
  'Searching all rooms needs the user permissions List Rooms and Room Admin. Give roomId instead.';

export const ROOM_LINKS_HINT =
  'Delete old guest links of this room with delete_expired_guest_links.';

export const ALL_ROOMS_LINKS_HINT = 'Give roomId to read one room.';

export const PAST_VALID_UNTIL_MESSAGE =
  'validUntil is in the past, so the guest could not join. Check the event time.';

export const MISSING_LINK_ROOM_MESSAGE = 'alfaview did not return the room of the guest link.';

export const DELETE_NOT_FOUND_MESSAGE =
  "alfaview could not find the guest link, so nothing was deleted. The link is already deleted, or the API key's user cannot see it: in a meeting room, only the meeting's creator can see its guest links.";

export const MEETING_ROOM_EMAIL_MESSAGE =
  'This guest link belongs to a meeting room, and alfaview emails the guest when such a link is deleted. Call delete_guest_link again with sendEmail true only when the person asked for that email: it deletes the link and sends the email.';

export const ROOM_UNKNOWN_EMAIL_MESSAGE =
  'alfaview did not return the room of this guest link, so this tool cannot tell whether alfaview emails the guest on a delete. Call delete_guest_link again with sendEmail true only when the person agrees to that email: it deletes the link anyway.';

export const BULK_DELETE_MEETING_ROOM_MESSAGE =
  'Guest links in meeting rooms are not deleted in bulk, because alfaview emails every guest whose link is deleted there. Use delete_guest_link.';

export const UNCERTAIN_CREATE_MESSAGE =
  'alfaview may have saved this guest link before the error. Call create_guest_links again with the same input: it returns a saved link as existing and creates only the missing ones. With sendEmail true, alfaview may not have sent this guest\'s email.';

export const NOT_ATTEMPTED_MESSAGE =
  'Not attempted. Call create_guest_links again with the same input to create it.';

export const EXISTING_LINK_MESSAGE =
  'This guest has a valid link in this room with the same email address, origin, validity, permission group and dial-in setting. No new link and no email.';

export const OTHER_RIGHTS_MESSAGE =
  'This guest has a valid link in this room with the same email address, origin and validity, but with another permission group or dial-in setting: see permissionGroupName and dialInAllowed. No new link and no email. To change them, call update_guest_link with this guestLinkId.';

/**
 * The error of create_guest_links and update_guest_link for a permission group with admin, at every
 * access level: a person makes such a link in alfaview.
 */
export const ADMIN_GUEST_GROUP_MESSAGE =
  'This permission group has admin rights, so the guest could change and delete the room. Choose a group without admin, or make the link in alfaview.';

/**
 * The error of update_guest_link for a link whose stored permission group has admin, when the call
 * gives no other group, at every access level.
 */
export const ADMIN_GUEST_LINK_MESSAGE =
  'This guest link has a permission group with admin rights, so its guest can change and delete the room. Give permissionGroup a group without admin in the same call, delete the link with delete_guest_link, or change the link in alfaview.';

/** Returns the status message of a guest whose link exists, but whose read back failed. */
export function guestLinkCreatedButNotReadMessage(guestLinkId: string): string {
  return `alfaview created the guest link ${guestLinkId}, but reading it back failed. Call create_guest_links again with the same input: it returns this link as existing, with its join URL.`;
}

/** Returns the error when the guest link cannot be read back after a saved change. */
export function guestLinkUpdatedButNotReadMessage(guestLinkId: string): string {
  return `alfaview saved the change to guest link ${guestLinkId}, but reading it back failed. Do not repeat the change: with sendEmail true, alfaview emails the guest on every change. Use find_guest_links to read the link.`;
}

/**
 * Returns the error when the guest list names an email address twice. With Personal data set to
 * Leave out, it leaves the address out.
 */
export function duplicateGuestMessage(
  emailAddress: string,
  mode: PersonalDataMode = 'include',
): string {
  return mode === 'omit'
    ? 'The guest list has an email address more than once. Give each email address once per call.'
    : `The guest list has ${emailAddress} more than once. Give each email address once per call.`;
}

// Output shape and mapper

export type GuestLink = {
  id: string;
  /** find_guest_links leaves it out when the call gave roomId. */
  roomId?: string | null;
  /**
   * True when the room of the link is a meeting room, where alfaview emails the guest when the
   * link is deleted. Read from the kind of the room ID (isMeetingRoomId), without a request.
   */
  inMeetingRoom: boolean;
  emailAddress: string | null;
  displayName: string | null;
  /** find_guest_links leaves it out unless includeJoinUrls is true. A credential. */
  joinUrl?: string | null;
  locale: string | null;
  validFrom: string | null;
  validUntil: string | null;
  /** `null` when the group is unknown or the group list was not readable. */
  permissionGroupName: string | null;
  dialInAllowed: boolean | null;
  origin: string | null;
  createdAt: string | null;
};

export type GuestLinkOptions = {
  timeZone: string;
  /** Default true. */
  includeRoomId?: boolean;
  /** Default true. */
  includeJoinUrl?: boolean;
};

/**
 * Returns the GuestLink output. Absent values are `null`, timestamps before 1971 (alfaview's "not
 * set") are `null`, and the others have the offset of `timeZone`. The locale `unknown` is `null`
 * (localeOrNull). The access key and the dial-in code are credentials and are left out, and so are
 * the creator and the group ID, which permissionGroupName replaces. `groupNames` maps the
 * lowercase permission group ID to its name.
 */
export function mapGuestLink(
  link: ApiGuestLink,
  groupNames: ReadonlyMap<string, string>,
  options: GuestLinkOptions,
): GuestLink {
  const { timeZone } = options;
  return {
    id: link.id,
    ...(options.includeRoomId === false ? {} : { roomId: textOrNull(link.roomId) }),
    inMeetingRoom: typeof link.roomId === 'string' && isMeetingRoomId(link.roomId),
    emailAddress: textOrNull(link.emailAddress),
    displayName: textOrNull(link.displayName),
    ...(options.includeJoinUrl === false ? {} : { joinUrl: textOrNull(link.joinUrl) }),
    locale: localeOrNull(link.locale),
    validFrom: formatTimestamp(link.validFrom, timeZone),
    validUntil: formatTimestamp(link.validUntil, timeZone),
    permissionGroupName: lookupName(groupNames, link.permissionGroupId),
    dialInAllowed: booleanOrNull(link.dialInAllowed),
    origin: textOrNull(link.origin),
    createdAt: formatTimestamp(link.createdAt, timeZone),
  };
}

/** Returns the sentence after a TooManyResults error of a guest link list. */
export function guestLinksHint(roomId: string | undefined): string {
  return roomId === undefined ? ALL_ROOMS_LINKS_HINT : ROOM_LINKS_HINT;
}

// Requests

/**
 * Returns every guest link of a room, or of the company when `roomId` is undefined. alfaview lists
 * links only page by page, with no filter by email, origin or time, so a search reads all pages:
 * delete_expired_guest_links keeps the lists short. A company-wide list that alfaview answers with
 * 403 or 404 throws Forbidden with ALL_ROOMS_DENIED_MESSAGE: a missing List Rooms gives 404, a
 * missing Room Admin 403. For a room, a 404 throws NotFound with the message that alfaview could
 * not find the room. With `pageLimit`, at most that many pages are read, `complete` says whether
 * more exist, and `nextPageToken` is where a later list goes on with `pageToken`. alfaview orders
 * the links of a room by link ID and goes on after the last ID of a page, so a later list skips no
 * link after deletes. The API docs do not state this order.
 */
export async function listGuestLinks(
  api: CallApi,
  roomId: string | undefined,
  options: { pageLimit?: number; pageToken?: string } = {},
): Promise<PageList<ApiGuestLink>> {
  const list = await fetchAllPages<ApiGuestLink>(api, guestLinksPath(roomId), {
    pageSize: LINK_PAGE_SIZE,
    tooManyResultsHint: guestLinksHint(roomId),
    allowStatuses: roomId === undefined ? [403, 404] : [],
    pageLimit: options.pageLimit,
    pageToken: options.pageToken,
  });
  if (list.status >= 400) throw new ToolError('Forbidden', ALL_ROOMS_DENIED_MESSAGE, list.status);
  return list;
}

/**
 * Reads a guest link with `GET /v2/guest-links/{id}`. With `allowNotFound`, a 404 gives
 * `undefined`.
 */
export function getGuestLink(api: CallApi, guestLinkId: string): Promise<ApiGuestLink>;
export function getGuestLink(
  api: CallApi,
  guestLinkId: string,
  options: { allowNotFound: true },
): Promise<ApiGuestLink | undefined>;
export async function getGuestLink(
  api: CallApi,
  guestLinkId: string,
  options: { allowNotFound?: boolean } = {},
): Promise<ApiGuestLink | undefined> {
  const { status, data } = await api.request<ApiGuestLink>({
    method: 'GET',
    path: guestLinkPath(guestLinkId),
    allowStatuses: options.allowNotFound === true ? [404] : [],
  });
  if (status === 404) return undefined;
  if (typeof data !== 'object' || data === null || typeof data.id !== 'string') {
    throw invalidResponse('alfaview did not return the guest link.');
  }
  return data;
}

/** Returns the room ID of a link, and throws when alfaview did not return one. */
export function roomOfLink(link: { roomId?: unknown }): string {
  if (typeof link.roomId !== 'string' || link.roomId === '') {
    throw invalidResponse(MISSING_LINK_ROOM_MESSAGE);
  }
  return link.roomId;
}

// Validity check and repeated creates

/**
 * Checks the validity of a new link, with the MCP parameter names in its messages. `validFrom` and
 * `validUntil` are ISO strings or `undefined`. A validUntil in the past throws `pastMessage`,
 * because nobody could use the link. A validUntil before validFrom throws too.
 */
export const { checkValidity } = createGuestLinkChecks(platform, {
  origin: 'origin',
  validFrom: 'validFrom',
  validUntil: 'validUntil',
});

function sameEmail(link: ApiGuestLink, emailAddress: string): boolean {
  return (
    typeof link.emailAddress === 'string' &&
    link.emailAddress.trim().toLowerCase() === emailAddress.trim().toLowerCase()
  );
}

export type ExistingLinkInput = {
  origin: string;
  validFrom: string | undefined;
  validUntil: string | undefined;
  permissionGroupId: string;
  dialInAllowed: boolean;
};

export type ExistingLink = {
  link: ApiGuestLink;
  /** `false` when the link has another permission group or dial-in setting than the input. */
  sameRights: boolean;
};

/** Returns whether the link has the permission group (any case) and dial-in setting of `input`. */
function hasRights(link: ApiGuestLink, input: ExistingLinkInput): boolean {
  return (
    typeof link.permissionGroupId === 'string' &&
    link.permissionGroupId.toLowerCase() === input.permissionGroupId.toLowerCase() &&
    link.dialInAllowed === input.dialInAllowed
  );
}

/**
 * Returns the link that a repeated create_guest_links finds instead of creating a new one, so that
 * a repeat makes no second link and sends no second email. It is a link of the guest's email
 * address (trimmed, any case) with exactly `origin`, the same validFrom and validUntil to the
 * millisecond (a missing bound matches only a missing bound, and times before 1971 count as
 * missing), whose validUntil is missing or after `now`. Of several, the newest with the permission
 * group and the dial-in setting of the input. When none has them, the newest with
 * `sameRights: false`: its join URL gives other rights than the call asks for, so the tool must
 * not return it as the guest's link.
 */
export function findExistingLink(
  links: readonly ApiGuestLink[],
  guest: { emailAddress: string },
  input: ExistingLinkInput,
  now: number,
): ExistingLink | undefined {
  const validFrom = input.validFrom === undefined ? null : Date.parse(input.validFrom);
  const validUntil = input.validUntil === undefined ? null : Date.parse(input.validUntil);
  if (validUntil !== null && validUntil <= now) return undefined;
  const matches = links
    .filter(
      (link) =>
        sameEmail(link, guest.emailAddress) &&
        link.origin === input.origin &&
        instantOf(link.validFrom) === validFrom &&
        instantOf(link.validUntil) === validUntil,
    )
    .sort(newestLinkFirst);
  const withRights = matches.find((link) => hasRights(link, input));
  if (withRights !== undefined) return { link: withRights, sameRights: true };
  return matches[0] === undefined ? undefined : { link: matches[0], sameRights: false };
}

// Cleanup

/**
 * Deletes the guest links `linkIds` of a room, at most DELETE_CONCURRENCY at a time, and returns
 * the number of deleted links. No new delete starts once the tool call has run for
 * DELETE_START_LIMIT_MS. The first failing delete stops new deletes. Its ToolError then also gives
 * the number of deleted links, which counts the deletes that were still running at the failure and
 * then succeeded.
 */
export async function deleteLinksWithinBudget(
  api: CallApi,
  roomId: string,
  linkIds: readonly string[],
): Promise<number> {
  let nextIndex = 0;
  let deletedCount = 0;
  let failure: { error: unknown } | undefined;

  const worker = async (): Promise<void> => {
    while (
      failure === undefined &&
      nextIndex < linkIds.length &&
      api.elapsedMs() < DELETE_START_LIMIT_MS
    ) {
      const linkId = linkIds[nextIndex]!;
      nextIndex += 1;
      try {
        await api.request({ method: 'DELETE', path: roomGuestLinkPath(roomId, linkId) });
        deletedCount += 1;
      } catch (error) {
        failure ??= { error };
        return;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(DELETE_CONCURRENCY, linkIds.length) }, () => worker()),
  );

  if (failure !== undefined) {
    const { error } = failure;
    if (!(error instanceof ToolError)) throw error;
    throw new ToolError(
      error.code,
      `${error.message} ${deletedBeforeError(deletedCount)}`,
      error.status,
      error.fieldLocations,
    );
  }
  return deletedCount;
}
