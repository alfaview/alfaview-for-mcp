// The room permissions of users: what one user may do in one room, such as Join or Admin.
import type { CallApi } from '../alfaview/client.ts';
import { invalidResponse, ToolError } from '../alfaview/errors.ts';
import {
  PERMISSION_INPUT_ORDER,
  roomPath,
  type ApiParticipantPermissions,
  type ApiPermissions,
  type ApiRoomPermissions,
  type PermissionKey,
} from '../shared/rooms.ts';

// Messages

export const PERMISSIONS_UNEXPECTED_MESSAGE =
  'alfaview sent an unexpected response for the room permissions.';

export const MEETING_ROOM_PERMISSION_MESSAGE =
  'This is the room of a meeting. A user with join there is an invitee of the meeting, and alfaview emails the invitees about changes of the meeting. Invite people to a meeting with create_guest_links.';

export const NO_PERMISSION_CHANGE_MESSAGE = 'Give at least one permission to change.';

export const PERMISSION_NOT_READ_WARNING =
  'alfaview saved the room permission, but reading it back failed. The result shows the permissions that this call sent.';

export const PERMISSION_CHANGE_NOT_READ_WARNING =
  'alfaview saved the change, but reading it back failed. The result shows the permissions that this call sent, and null for the others.';

/** Returns the error of add_room_permission for a user who has an entry in the room. */
export function permissionExistsMessage(userId: string): string {
  return `User ${userId} already has a room permission in this room. Change it with update_room_permission.`;
}

/** Returns the error of update_room_permission for a user without an entry: nothing changed. */
export function permissionNotFoundMessage(userId: string): string {
  return `User ${userId} has no room permission in this room, so nothing changed. Give one with add_room_permission.`;
}

/**
 * Returns the error of add_room_permission and update_room_permission when the change would take
 * the admin permission of the API key's user away.
 */
export function ownAdminMessage(userId: string): string {
  return `User ${userId} is the API key's user. This tool does not take its own admin permission away, because the server could lose control of the room. Do it in alfaview.`;
}

/** Returns the error of remove_room_permission for the entry of the API key's user. */
export function ownPermissionMessage(userId: string): string {
  return `User ${userId} is the API key's user. This tool does not remove its own room permission, because the server could lose access to the room. Do it in alfaview.`;
}

// The permission list

/**
 * The room permissions of a `GET /v2/rooms/{id}/permissions` answer: the user entries, and the
 * counts of the guest link and group link entries. Every guest link and group link of the room has
 * an entry, so a room with many guests has many such entries, and only their counts are kept.
 */
export type RoomPermissionList = {
  /** Each with a text `participantId`, in the order of alfaview. */
  userPermissions: ApiParticipantPermissions[];
  guestLinkPermissionCount: number;
  groupLinkPermissionCount: number;
};

/**
 * Returns the entries with a text `participantId` of one list of the answer: `[]` for a missing or
 * `null` list, and `undefined` for a value that is no list.
 */
function entriesOf(list: unknown): ApiParticipantPermissions[] | undefined {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) return undefined;
  return list.filter(
    (entry): entry is ApiParticipantPermissions =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as ApiParticipantPermissions).participantId === 'string',
  );
}

/**
 * Returns the RoomPermissionList of an answer. A missing or `null` list is an empty one, and
 * entries without a text `participantId` are left out. Returns `undefined` for an answer that is
 * no object or has a list that is no list, so that the caller throws its response error.
 */
export function readRoomPermissions(data: unknown): RoomPermissionList | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const answer = data as Record<string, unknown>;
  const users = entriesOf(answer.userPermissions);
  const guestLinks = entriesOf(answer.guestLinkPermissions);
  const groupLinks = entriesOf(answer.groupLinkPermissions);
  if (users === undefined || guestLinks === undefined || groupLinks === undefined) return undefined;
  return {
    userPermissions: users,
    guestLinkPermissionCount: guestLinks.length,
    groupLinkPermissionCount: groupLinks.length,
  };
}

/**
 * Returns the permissions of the entry of `userPermissions` whose `participantId` equals `userId`
 * in any case, else `undefined`. alfaview keys the entries by the lowercase ID, and a model can
 * give another case. An entry without permissions gives an empty object, so the caller still tells
 * it from no entry.
 */
export function userPermissionsOf(
  answer: Pick<ApiRoomPermissions, 'userPermissions'>,
  userId: string,
): ApiPermissions | undefined {
  const wanted = userId.toLowerCase();
  const entry = (answer.userPermissions ?? []).find(
    (candidate) => candidate?.participantId?.toLowerCase() === wanted,
  );
  return entry === undefined ? undefined : (entry.permissions ?? {});
}

/** Returns the names of the permissions that are `true`, in the order of PERMISSION_INPUT_ORDER. */
export function grantedPermissions(
  permissions: Partial<Record<PermissionKey, boolean | null>>,
): PermissionKey[] {
  return PERMISSION_INPUT_ORDER.filter((key) => permissions[key] === true);
}

/** Returns the names as a summary list, such as `join, voice and chat`, or `no permission`. */
export function permissionText(names: readonly string[]): string {
  if (names.length === 0) return 'no permission';
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

// Paths

function permissionsPath(roomId: string): string {
  return `${roomPath(roomId)}/permissions`;
}

/**
 * Returns the path of the entry of a user, with both IDs in lowercase. alfaview finds an entry
 * only by the lowercase ID: an uppercase ID gives 404 in an update and removes nothing with 204 in
 * a delete.
 */
export function userPermissionPath(roomId: string, userId: string): string {
  return `${permissionsPath(roomId)}/${encodeURIComponent(userId.toLowerCase())}`;
}

// Requests

/**
 * Returns the permission list of a room: `GET /v2/rooms/{id}/permissions`, read by
 * {@link readRoomPermissions}.
 */
export async function listRoomPermissions(
  api: CallApi,
  roomId: string,
): Promise<RoomPermissionList> {
  const { data } = await api.request<unknown>({ method: 'GET', path: permissionsPath(roomId) });
  const permissions = readRoomPermissions(data);
  if (permissions === undefined) throw invalidResponse(PERMISSIONS_UNEXPECTED_MESSAGE);
  return permissions;
}

/**
 * Adds the entry of a user (`POST /v2/rooms/{id}/permissions`) with all nine permissions, which
 * the API requires, and the user ID in lowercase: with an uppercase ID, alfaview does not find the
 * entry that the user has, so it answers no 409 and replaces that entry. A user who has an entry
 * gives the code Conflict. Its answer has no body.
 */
export async function addRoomPermission(
  api: CallApi,
  roomId: string,
  userId: string,
  permissions: Record<PermissionKey, boolean>,
): Promise<void> {
  const { status } = await api.request({
    method: 'POST',
    path: permissionsPath(roomId),
    body: { participantId: userId.toLowerCase(), permissions },
    allowStatuses: [409],
  });
  if (status === 409) throw new ToolError('Conflict', permissionExistsMessage(userId), 409);
}

/**
 * Changes the given permissions of the entry of a user
 * (`PATCH /v2/rooms/{id}/permissions/{userId}`). alfaview answers 404 for a user without an entry
 * and for a room that it does not find, so the 404 gives the code NotFound with a message that
 * nothing changed. Its answer has no body.
 */
export async function updateRoomPermission(
  api: CallApi,
  roomId: string,
  userId: string,
  changes: ApiPermissions,
): Promise<void> {
  const { status } = await api.request({
    method: 'PATCH',
    path: userPermissionPath(roomId, userId),
    body: changes,
    allowStatuses: [404],
  });
  if (status === 404) throw new ToolError('NotFound', permissionNotFoundMessage(userId), 404);
}

/**
 * Removes the entry of a user (`DELETE /v2/rooms/{id}/permissions/{userId}`). alfaview answers 204
 * also for a user without an entry, so the caller removes only an entry that it read. Its answer
 * has no body.
 */
export async function removeRoomPermission(
  api: CallApi,
  roomId: string,
  userId: string,
): Promise<void> {
  await api.request({ method: 'DELETE', path: userPermissionPath(roomId, userId) });
}
