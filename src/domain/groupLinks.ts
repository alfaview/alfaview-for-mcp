// A group link is one join URL that many people share, all with the rights of one permission
// group. alfaview makes four group links in the room of each meeting, get_meeting gives their
// join URLs, and nothing makes a deleted one again. So the writes refuse a meeting room.
import type { CallApi } from '../alfaview/client.ts';
import { invalidResponse, ToolError } from '../alfaview/errors.ts';
import { fetchAllPages } from '../alfaview/pagination.ts';
import { groupLinkPath, groupLinksPath, type ApiGroupLink } from '../shared/groupLinks.ts';
import {
  hasExpired,
  LINK_PAGE_SIZE,
  lookupName,
  newestLinkFirst,
  originMatches,
} from '../shared/guestLinks.ts';
import { booleanOrNull, textOrNull } from '../shared/outputValues.ts';
import { formatTimestamp } from '../values/time.ts';
import {
  ALL_ROOMS_DENIED_MESSAGE,
  ALL_ROOMS_LINKS_HINT,
  type GuestLinkOptions,
} from './guestLinks.ts';
import { isMeetingRoomId } from './rooms.ts';

export { groupLinkPath, groupLinksPath, roomGroupLinkPath } from '../shared/groupLinks.ts';
export type { ApiGroupLink } from '../shared/groupLinks.ts';

// Messages

export const GROUP_LINK_ALONE_MESSAGE =
  'groupLinkId reads one link: leave out roomId, description and originContains.';

export const GROUP_LINK_MEETING_ROOM_MESSAGE =
  'This is the room of a meeting. Its group links belong to the meeting: get_meeting gives their join URLs, and alfaview never makes a deleted one again. So the group link tools do not create, change or delete links in a meeting room. Use update_meeting or cancel_meeting for the meeting.';

export const GROUP_LINK_PAST_VALID_UNTIL_MESSAGE =
  'validUntil is in the past, so nobody could join with this link. Check the event time.';

/** The error of update_group_link for a validUntil that is not after the stored validFrom. */
export const GROUP_LINK_STARTS_LATER_MESSAGE =
  'validUntil must be after validFrom, and this link starts later. Also give validFrom: to turn the link off, give both times in the past.';

export const GROUP_LINK_UNCERTAIN_MESSAGE =
  'alfaview may have saved this group link before the error. Check with find_group_links before you create it again: a second create makes a second group link with another join URL.';

export const GROUP_LINK_ID_MISSING_MESSAGE =
  'alfaview did not return the ID of the new group link, but may have created it. Check with find_group_links before you create it again.';

export const MISSING_GROUP_LINK_ROOM_MESSAGE =
  'alfaview did not return the room of the group link.';

export const GROUP_LINK_DELETE_NOT_FOUND_MESSAGE =
  "alfaview could not find the group link, so nothing was deleted. The link is already deleted, or the API key's user cannot see it: in a meeting room, only the meeting's creator can see its group links.";

/**
 * The error of create_group_link and update_group_link for a permission group with admin, at every
 * access level.
 */
export const ADMIN_GROUP_MESSAGE =
  'This permission group has admin rights, so everyone with the join URL could change and delete the room. Choose a group without admin.';

/**
 * The error of update_group_link for a link whose stored permission group has admin, when the call
 * gives no other group, at every access level.
 */
export const ADMIN_GROUP_LINK_MESSAGE =
  'This group link has a permission group with admin rights, so everyone with its join URL can change and delete the room. Give permissionGroup a group without admin in the same call, or delete the link with delete_group_link.';

/**
 * Returns the error when the new link cannot be read back: it exists, so a second create
 * duplicates it.
 */
export function groupLinkCreatedButNotReadMessage(groupLinkId: string): string {
  return `alfaview created the group link ${groupLinkId}, but reading it back failed. Do not create it again: that makes a second group link. Use find_group_links with groupLinkId ${groupLinkId} to get its join URL.`;
}

/** Returns the error when the link cannot be read back after a saved change. */
export function groupLinkUpdatedButNotReadMessage(groupLinkId: string): string {
  return `alfaview saved the change to group link ${groupLinkId}, but reading it back failed. Use find_group_links with groupLinkId ${groupLinkId} to read the link.`;
}

// Meeting rooms

export { isMeetingRoomId };

/**
 * Refuses a write of a group link in a meeting room, with the code MeetingRoomRefused. The test
 * reads the kind of the room ID, without a request.
 */
export function refuseMeetingRoom(roomId: string): void {
  if (isMeetingRoomId(roomId)) {
    throw new ToolError('MeetingRoomRefused', GROUP_LINK_MEETING_ROOM_MESSAGE);
  }
}

// Output shape and mapper

export type GroupLink = {
  id: string;
  /** find_group_links leaves it out when the call gave roomId. */
  roomId?: string | null;
  description: string | null;
  /** find_group_links gives it only with includeJoinUrls, update_group_link never. A credential. */
  joinUrl?: string | null;
  /** `null` when the group is unknown or the group list was not readable. */
  permissionGroupName: string | null;
  validFrom: string | null;
  validUntil: string | null;
  dialInAllowed: boolean | null;
  origin: string | null;
  createdAt: string | null;
  /** True for a link of a meeting room, which the other group link tools do not change. */
  meetingLink: boolean;
};

/**
 * Returns the Group Link output. Absent values are `null`, timestamps before 1971 (alfaview's
 * "not set") are `null`, and the others have the offset of `timeZone`. The room name, the
 * permission group ID, the access key, the deprecated joinLink, the dial-in code and the creator
 * are left out: the access key and the dial-in code are credentials, and the others help a model
 * little. `groupNames` maps the lowercase permission group ID to its name.
 */
export function mapGroupLink(
  link: ApiGroupLink,
  groupNames: ReadonlyMap<string, string>,
  options: GuestLinkOptions,
): GroupLink {
  const { timeZone } = options;
  return {
    id: link.id,
    ...(options.includeRoomId === false ? {} : { roomId: textOrNull(link.roomId) }),
    description: textOrNull(link.description),
    ...(options.includeJoinUrl === false ? {} : { joinUrl: textOrNull(link.joinUrl) }),
    permissionGroupName: lookupName(groupNames, link.permissionGroupId),
    validFrom: formatTimestamp(link.validFrom, timeZone),
    validUntil: formatTimestamp(link.validUntil, timeZone),
    dialInAllowed: booleanOrNull(link.dialInAllowed),
    origin: textOrNull(link.origin),
    createdAt: formatTimestamp(link.createdAt, timeZone),
    meetingLink: typeof link.roomId === 'string' && isMeetingRoomId(link.roomId),
  };
}

// Filter

/** What find_group_links matches. */
export type GroupLinkFilter = {
  /** Part of the description, trimmed and in any case. */
  description?: string;
  /** Part of the origin, in any case. */
  originContains?: string;
  includeExpired: boolean;
};

/**
 * Returns the links whose description and origin contain the texts of `filter`, newest first.
 * `expiredMatchCount` counts the matching links whose validUntil has passed. Without
 * `includeExpired`, these links are left out.
 */
export function filterGroupLinks(
  links: readonly ApiGroupLink[],
  filter: GroupLinkFilter,
  now: number,
): { links: ApiGroupLink[]; expiredMatchCount: number } {
  const description = filter.description?.trim().toLowerCase();
  const matches = links.filter(
    (link) =>
      (description === undefined ||
        (typeof link.description === 'string' &&
          link.description.toLowerCase().includes(description))) &&
      originMatches(link.origin, filter.originContains),
  );
  const expiredMatchCount = matches.filter((link) => hasExpired(link, now)).length;
  const kept = filter.includeExpired ? matches : matches.filter((link) => !hasExpired(link, now));
  return { links: kept.sort(newestLinkFirst), expiredMatchCount };
}

// Requests

/**
 * Returns every group link of a room, or of the company when `roomId` is undefined. The company
 * list needs the user permissions List Rooms and Room Admin: alfaview answers 404 without List
 * Rooms and 403 without Room Admin, and both give ALL_ROOMS_DENIED_MESSAGE. For a room that
 * alfaview does not find, the 404 gives the message of the room.
 */
export async function listGroupLinks(
  api: CallApi,
  roomId: string | undefined,
): Promise<ApiGroupLink[]> {
  const list = await fetchAllPages<ApiGroupLink>(api, groupLinksPath(roomId), {
    pageSize: LINK_PAGE_SIZE,
    tooManyResultsHint: roomId === undefined ? ALL_ROOMS_LINKS_HINT : undefined,
    allowStatuses: roomId === undefined ? [403, 404] : [],
  });
  if (list.status >= 400) throw new ToolError('Forbidden', ALL_ROOMS_DENIED_MESSAGE, list.status);
  return list.items;
}

/**
 * Returns a group link (`GET /v2/group-links/{id}`). With `allowNotFound`, a 404 gives
 * `undefined`.
 */
export function getGroupLink(api: CallApi, groupLinkId: string): Promise<ApiGroupLink>;
export function getGroupLink(
  api: CallApi,
  groupLinkId: string,
  options: { allowNotFound: true },
): Promise<ApiGroupLink | undefined>;
export async function getGroupLink(
  api: CallApi,
  groupLinkId: string,
  options: { allowNotFound?: boolean } = {},
): Promise<ApiGroupLink | undefined> {
  const { status, data } = await api.request<ApiGroupLink>({
    method: 'GET',
    path: groupLinkPath(groupLinkId),
    allowStatuses: options.allowNotFound === true ? [404] : [],
  });
  if (status === 404) return undefined;
  if (typeof data !== 'object' || data === null || typeof data.id !== 'string') {
    throw invalidResponse('alfaview did not return the group link.');
  }
  return data;
}

/** Returns the room of a group link, or throws InvalidResponse when alfaview did not return one. */
export function roomOfGroupLink(link: ApiGroupLink): string {
  if (typeof link.roomId !== 'string' || link.roomId === '') {
    throw invalidResponse(MISSING_GROUP_LINK_ROOM_MESSAGE);
  }
  return link.roomId;
}
