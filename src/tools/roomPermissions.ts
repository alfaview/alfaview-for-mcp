// The room permission tools: find_room_permissions of the level `manage`, and the three writes of
// the level `full`. The writes refuse a meeting room, where alfaview emails a user whose entry is
// added or removed, and a change that locks out the API key's user. No tool emails anyone.
import * as z from 'zod';
import type { CallApi } from '../alfaview/client.ts';
import { invalidInput, ToolError } from '../alfaview/errors.ts';
import { listPermissionGroups, resolvePermissionGroup } from '../domain/permissionGroups.ts';
import {
  addRoomPermission,
  grantedPermissions,
  listRoomPermissions,
  MEETING_ROOM_PERMISSION_MESSAGE,
  NO_PERMISSION_CHANGE_MESSAGE,
  ownAdminMessage,
  ownPermissionMessage,
  PERMISSION_CHANGE_NOT_READ_WARNING,
  PERMISSION_NOT_READ_WARNING,
  permissionText,
  removeRoomPermission,
  updateRoomPermission,
  userPermissionsOf,
} from '../domain/roomPermissions.ts';
import { getRoom } from '../domain/rooms.ts';
import {
  isUserId,
  listUsers,
  NOT_A_USER_ID_MESSAGE,
  readApiKeyUserId,
  sameId,
  userNames,
} from '../domain/users.ts';
import {
  mapRoomPermission,
  newMemberPermissions,
  PERMISSION_INPUT_ORDER,
  type ApiPermissions,
  type PermissionKey,
  type RoomPermissionOutput,
} from '../shared/rooms.ts';
import { LIST_PART, ROOM_PERMISSIONS, toolOutput } from './outputs.ts';
import {
  ADD_ANNOTATIONS,
  count,
  defineTool,
  IDEMPOTENT_CHANGE_ANNOTATIONS,
  limitParameter,
  listPart,
  offsetParameter,
  READ_ANNOTATIONS,
  ROOM_ID_RULE,
  ROOM_PERMISSION_PARAMETERS,
  roomIdNotMeetingWith,
  roomIdWith,
  showing,
  textParameter,
  userIdParameter,
  userIdWith,
  type IdRule,
} from './tool.ts';

/**
 * Returns the user ID of a call in lowercase, the form in which alfaview keys the entries. Before
 * any request, it refuses an ID that is not the ID of a user, such as the ID of a guest link.
 */
function checkedUserId(userId: string): string {
  if (!isUserId(userId)) throw invalidInput(NOT_A_USER_ID_MESSAGE);
  return userId.toLowerCase();
}

// find_room_permissions

/** An entry of find_room_permissions. */
type RoomPermissionEntry = Omit<RoomPermissionOutput, 'roomId'> & {
  userName: string | null;
};

/** Compares two entries by name in any case, with the entries without a name last, then by ID. */
function byEntryName(left: RoomPermissionEntry, right: RoomPermissionEntry): number {
  if (left.userName !== right.userName) {
    if (left.userName === null) return 1;
    if (right.userName === null) return -1;
    const byName = left.userName.localeCompare(right.userName, 'en', { sensitivity: 'base' });
    if (byName !== 0) return byName;
  }
  return left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0;
}

/**
 * The warning of find_room_permissions with Personal data set to Include when an entry has no
 * userName. The description does not name the permission, so the model reads it only when a name
 * is missing. A deleted user keeps its room permissions.
 */
export const UNNAMED_USERS_WARNING =
  "userName is null for a user whom alfaview did not list: the API key's user lacks the user permission List Users, or the user was deleted.";

/**
 * The roomId rule of find_room_permissions: a user ID in roomId gets a message that tells the
 * model where the two IDs go.
 */
const PERMISSIONS_ROOM_ID_RULE: IdRule = {
  ...ROOM_ID_RULE,
  otherKind: (kind, id) =>
    kind === 'user'
      ? `roomId ${id} is a user ID. find_room_permissions lists one room: give roomId from find_rooms and this ID as userId.`
      : ROOM_ID_RULE.otherKind!(kind, id),
};

/**
 * Returns the names of the users for the entries. Any error except a cancel gives no names, so each
 * userName is null: the names only label the entries.
 */
async function readUserNames(api: CallApi): Promise<Map<string, string | null>> {
  try {
    return userNames(await listUsers(api));
  } catch (error) {
    if (error instanceof ToolError && error.code !== 'Canceled') return new Map();
    throw error;
  }
}

export const findRoomPermissionsTool = defineTool({
  name: 'find_room_permissions',
  level: 'manage',
  title: 'Find room permissions',
  description:
    "Lists the users who have a room permission in an alfaview room, with the nine permissions of each, such as admin and join. A user without one gets the room's default permissions, if it has any. Guest links and group links are only counted.",
  descriptionWithoutPersonalData:
    "Lists the users who have a room permission in an alfaview room, with the nine permissions of each, such as admin and join. A user without one gets the room's default permissions, if it has any. Guest links and group links are only counted. This server leaves out personal data: userName is null.",
  inputSchema: z.strictObject({
    roomId: roomIdWith('Room ID from find_rooms.', PERMISSIONS_ROOM_ID_RULE),
    userId: userIdWith('Only this user: a user ID from find_users.').optional(),
    limit: limitParameter('room permissions', 100, 50),
    offset: offsetParameter(),
  }),
  annotations: READ_ANNOTATIONS,
  personalData: { shape: 'mcp.roomPermission', list: 'permissions' },
  output: toolOutput({
    roomId: z.string(),
    ...LIST_PART,
    guestLinkPermissionCount: z.int(),
    groupLinkPermissionCount: z.int(),
    permissions: z.array(
      z.strictObject({ userId: z.string(), ...ROOM_PERMISSIONS, userName: z.string().nullable() }),
    ),
  }),
  async run(input, { api, personalData }) {
    const userId = input.userId === undefined ? undefined : checkedUserId(input.userId);
    const roomId = input.roomId.toLowerCase();
    // alfaview answers 404 also for a room that the API key's user cannot see.
    const list = await listRoomPermissions(api, roomId);
    const entries = list.userPermissions.filter(
      (entry) => userId === undefined || sameId(entry.participantId, userId),
    );
    // The names come from the user list, which only an entry needs.
    const names = entries.length > 0 ? await readUserNames(api) : new Map<string, string | null>();
    const matches = entries
      .map((entry): RoomPermissionEntry => {
        const { roomId: _roomId, ...permission } = mapRoomPermission(
          roomId,
          entry.participantId,
          entry.permissions,
        );
        return { ...permission, userName: names.get(entry.participantId.toLowerCase()) ?? null };
      })
      .sort(byEntryName);
    const part = listPart(matches, input.offset, input.limit);

    const { guestLinkPermissionCount: guestLinks, groupLinkPermissionCount: groupLinks } = list;
    let summary: string;
    if (part.totalMatches === 0) {
      summary =
        userId === undefined
          ? `Found no users with a room permission in room ${roomId}.`
          : `User ${userId} has no room permission in room ${roomId}.`;
    } else {
      const links =
        guestLinks === 0 && groupLinks === 0
          ? ''
          : ` ${count(guestLinks, 'guest link')} and ${count(groupLinks, 'group link')} have one too.`;
      summary = `Found ${count(part.totalMatches, 'user')} with a room permission in room ${roomId}.${links}${showing(part)}`;
    }
    // With Leave out, each userName is null anyway, and the description says so.
    const unnamed =
      personalData === 'include' && part.items.some((entry) => entry.userName === null);
    return {
      summary,
      warnings: unnamed ? [UNNAMED_USERS_WARNING] : [],
      data: {
        roomId,
        totalMatches: part.totalMatches,
        offset: part.offset,
        nextOffset: part.nextOffset,
        guestLinkPermissionCount: guestLinks,
        groupLinkPermissionCount: groupLinks,
        permissions: part.items,
      },
    };
  },
});

/** The room permission tools of the level `manage`. */
export const ROOM_PERMISSION_TOOLS = [findRoomPermissionsTool] as const;

// The tools of `full`

/** Returns the given permissions of ROOM_PERMISSION_PARAMETERS, in PERMISSION_INPUT_ORDER. */
function givenPermissions(input: Partial<Record<PermissionKey, boolean>>): ApiPermissions {
  const given: ApiPermissions = {};
  for (const key of PERMISSION_INPUT_ORDER) {
    if (input[key] !== undefined) given[key] = input[key];
  }
  return given;
}

/**
 * Reads the room and refuses the room of a meeting. A user with join there is an invitee of the
 * meeting, and alfaview emails a user whose entry an update of a meeting room adds or removes.
 */
async function refuseMeetingRoom(api: CallApi, roomId: string): Promise<void> {
  const room = await getRoom(api, roomId);
  if (room.type === 'meeting') {
    throw new ToolError('MeetingRoomRefused', MEETING_ROOM_PERMISSION_MESSAGE);
  }
}

/**
 * Refuses a change of the entry of the API key's user with `message`. An error of the read ends the
 * call: the guard must not pass without the ID.
 */
async function refuseApiKeyUser(api: CallApi, userId: string, message: string): Promise<void> {
  if (sameId(await readApiKeyUserId(api), userId)) throw new ToolError('OwnUserRefused', message);
}

/**
 * Returns the stored permissions of the user after a saved write, or `undefined` when the read
 * back fails with any ToolError, a cancel included, or alfaview lists no entry: the write is saved,
 * so the call must not fail. A repeat changes nothing more, so the warning need not say "do not
 * repeat".
 */
async function readBack(
  api: CallApi,
  roomId: string,
  userId: string,
): Promise<ApiPermissions | undefined> {
  try {
    return userPermissionsOf(await listRoomPermissions(api, roomId), userId);
  } catch (error) {
    if (error instanceof ToolError) return undefined;
    throw error;
  }
}

const FULL_ROOM_ID_TEXT = 'Room ID from find_rooms.';

export const addRoomPermissionTool = defineTool({
  name: 'add_room_permission',
  level: 'full',
  title: 'Add a room permission',
  description:
    'Changes who has access: gives a user of the alfaview company a room permission: the nine permissions of permissionGroup, and each permission that you give overrides one. With admin, the user can delete the room. If the user has one already, use update_room_permission. Call it only when the user asked for it.',
  inputSchema: z.strictObject({
    roomId: roomIdNotMeetingWith(FULL_ROOM_ID_TEXT),
    userId: userIdParameter,
    permissionGroup: textParameter(
      'Permission group that gives the nine permissions, by name or ID, for example Moderator.',
      256,
    ),
    ...ROOM_PERMISSION_PARAMETERS,
  }),
  // Not destructive: an entry that the user has gives 409. A repeat adds nothing more.
  annotations: ADD_ANNOTATIONS,
  // The result has no userName.
  personalData: { shape: 'mcp.roomPermission' },
  output: toolOutput({
    roomId: z.string(),
    userId: z.string(),
    ...ROOM_PERMISSIONS,
    permissionGroupName: z.string(),
  }),
  readTool: 'find_room_permissions',
  async run(input, { api }) {
    const userId = checkedUserId(input.userId);
    const roomId = input.roomId.toLowerCase();
    await refuseMeetingRoom(api, roomId);
    // The model cannot learn a group ID, so the group can also be given by name.
    const group = resolvePermissionGroup(input.permissionGroup, await listPermissionGroups(api));
    // alfaview needs all nine: each given one, else the one of the group, else false.
    const permissions = newMemberPermissions(givenPermissions(input), group.permissions);
    // An own entry wins over the default permissions of the room, so an entry without admin can
    // take away the admin that the API key's user has through them.
    if (!permissions.admin) await refuseApiKeyUser(api, userId, ownAdminMessage(userId));

    await addRoomPermission(api, roomId, userId, permissions);
    const stored = await readBack(api, roomId, userId);
    const permission = mapRoomPermission(roomId, userId, stored ?? permissions);
    // The summary leaves out the group name: a summary holds no text from alfaview.
    return {
      summary: `Gave user ${userId} a room permission in room ${roomId} with ${permissionText(grantedPermissions(permission))}.`,
      warnings: stored === undefined ? [PERMISSION_NOT_READ_WARNING] : [],
      data: { ...permission, permissionGroupName: group.name },
    };
  },
});

export const updateRoomPermissionTool = defineTool({
  name: 'update_room_permission',
  level: 'full',
  title: 'Change a room permission',
  description:
    'Changes who has access: changes the room permission of a user in an alfaview room. Without join the user cannot enter the room, and with admin the user can delete it. Call it only when the user asked for it.',
  inputSchema: z.strictObject({
    roomId: roomIdNotMeetingWith(FULL_ROOM_ID_TEXT),
    userId: userIdParameter,
    ...ROOM_PERMISSION_PARAMETERS,
  }),
  // A repeat sets the same values and sends no email.
  annotations: IDEMPOTENT_CHANGE_ANNOTATIONS,
  personalData: { shape: 'mcp.roomPermission' },
  output: toolOutput({ roomId: z.string(), userId: z.string(), ...ROOM_PERMISSIONS }),
  readTool: 'find_room_permissions',
  async run(input, { api }) {
    const changes = givenPermissions(input);
    if (Object.keys(changes).length === 0) throw invalidInput(NO_PERMISSION_CHANGE_MESSAGE);
    const userId = checkedUserId(input.userId);
    const roomId = input.roomId.toLowerCase();
    await refuseMeetingRoom(api, roomId);
    if (changes.admin === false) await refuseApiKeyUser(api, userId, ownAdminMessage(userId));

    await updateRoomPermission(api, roomId, userId, changes);
    // Without the read back, the result has the sent values and null for the others.
    const stored = await readBack(api, roomId, userId);
    const permission = mapRoomPermission(roomId, userId, stored ?? changes);
    const current =
      stored === undefined ? '' : ` It now has ${permissionText(grantedPermissions(permission))}.`;
    return {
      summary: `Changed the room permission of user ${userId} in room ${roomId}.${current}`,
      warnings: stored === undefined ? [PERMISSION_CHANGE_NOT_READ_WARNING] : [],
      data: permission,
    };
  },
});

export const removeRoomPermissionTool = defineTool({
  name: 'remove_room_permission',
  level: 'full',
  title: 'Remove a room permission',
  description:
    "Changes who has access: removes the room permission of a user from an alfaview room. The user keeps only the room's default permissions, if any. add_room_permission can give back the removed permissions of the result. Call it only when the user asked for it.",
  inputSchema: z.strictObject({
    roomId: roomIdNotMeetingWith(FULL_ROOM_ID_TEXT),
    userId: userIdParameter,
  }),
  // A repeat finds no entry and does nothing.
  annotations: IDEMPOTENT_CHANGE_ANNOTATIONS,
  personalData: { shape: 'mcp.roomPermission' },
  // removedPermissions is null when the user had no room permission, so nothing was removed.
  output: toolOutput({
    roomId: z.string(),
    userId: z.string(),
    removed: z.boolean(),
    removedPermissions: z.strictObject(ROOM_PERMISSIONS).nullable(),
  }),
  readTool: 'find_room_permissions',
  async run(input, { api }) {
    const userId = checkedUserId(input.userId);
    const roomId = input.roomId.toLowerCase();
    // Without the user permission Room Admin, the API key's user would lose access to the room, and
    // the server could not read or give back the entry.
    await refuseApiKeyUser(api, userId, ownPermissionMessage(userId));
    await refuseMeetingRoom(api, roomId);
    // alfaview answers 204 also without an entry, so only the read tells "removed" from "nothing
    // to remove", and it keeps the permissions for an undo.
    const current = userPermissionsOf(await listRoomPermissions(api, roomId), userId);
    if (current === undefined) {
      return {
        summary: `User ${userId} has no room permission in room ${roomId}, so nothing was removed.`,
        data: { roomId, userId, removed: false, removedPermissions: null },
      };
    }

    await removeRoomPermission(api, roomId, userId);
    const { roomId: _roomId, userId: _userId, ...removedPermissions } = mapRoomPermission(
      roomId,
      userId,
      current,
    );
    return {
      summary: `Removed the room permission of user ${userId} from room ${roomId}. It had ${permissionText(grantedPermissions(removedPermissions))}.`,
      data: { roomId, userId, removed: true, removedPermissions },
    };
  },
});

/** The room permission tools of the level `full`, in the order of the tool list. */
export const FULL_ROOM_PERMISSION_TOOLS = [
  addRoomPermissionTool,
  updateRoomPermissionTool,
  removeRoomPermissionTool,
] as const;
