// Permission groups of the company (`GET /v2/permission-groups`). Guest links and group links
// refer to them by ID, and add_room_permission takes the permissions of one. Companies can rename
// the default groups, so the group named Guest is only a fallback when the input names none.
import type { CallApi } from '../alfaview/client.ts';
import { invalidResponse, ToolError } from '../alfaview/errors.ts';
import {
  findGuestGroup,
  groupNamesById,
  readPermissionGroups,
  type PermissionGroup,
} from '../shared/permissionGroups.ts';

export { DEFAULT_GUEST_GROUP_NAME, groupNamesById } from '../shared/permissionGroups.ts';
export type { PermissionGroup } from '../shared/permissionGroups.ts';

/**
 * Returns every permission group, in the order the company configured. One request, no
 * pagination. An answer of `null` gives no groups, and entries without a text ID and name are left
 * out.
 */
export async function listPermissionGroups(api: CallApi): Promise<PermissionGroup[]> {
  const { data } = await api.request<unknown>({ method: 'GET', path: '/v2/permission-groups' });
  const groups = readPermissionGroups(data);
  if (groups === undefined) {
    throw invalidResponse('alfaview sent an unexpected response for /v2/permission-groups.');
  }
  return groups;
}

/**
 * Returns the permission group names for outputs that only show them. A ToolError other than a
 * cancel gives no names, so the outputs get `null`: a create or update whose change is saved must
 * not fail on a name.
 */
export async function readGroupNames(api: CallApi): Promise<Map<string, string>> {
  try {
    return groupNamesById(await listPermissionGroups(api));
  } catch (error) {
    if (error instanceof ToolError && error.code !== 'Canceled') return new Map();
    throw error;
  }
}

function listOfNames(groups: readonly PermissionGroup[]): string {
  return groups.length === 0 ? 'none' : groups.map((group) => group.name).join(', ');
}

function unknownGroup(message: string): ToolError {
  return new ToolError('UnknownPermissionGroup', message);
}

/**
 * Returns the permission group for `value`: the group whose ID equals it (any case), else the one
 * group whose name equals it (trimmed, any case). It takes a name too, because the outputs show
 * group names and no tool lists the groups. Without a value, it returns the first group named Guest
 * (any case). An unknown value, a name of several groups and a company without a Guest group give
 * an error that lists what the model can give instead.
 */
export function resolvePermissionGroup(
  value: string | undefined,
  groups: readonly PermissionGroup[],
): PermissionGroup {
  const chosen = value?.trim();
  if (chosen === undefined || chosen === '') {
    const guest = findGuestGroup(groups);
    if (guest === undefined) {
      throw unknownGroup(
        `Give permissionGroup. This company has no permission group named Guest. Its groups: ${listOfNames(groups)}.`,
      );
    }
    return guest;
  }

  const wanted = chosen.toLowerCase();
  const byId = groups.find((group) => group.id.toLowerCase() === wanted);
  if (byId !== undefined) return byId;

  const byName = groups.filter((group) => group.name.trim().toLowerCase() === wanted);
  if (byName.length > 1) {
    throw unknownGroup(
      `More than one permission group is named ${chosen}. Give the ID of one: ${byName.map((group) => group.id).join(', ')}.`,
    );
  }
  if (byName.length === 0) {
    throw unknownGroup(
      `This company has no permission group ${chosen}. Its groups: ${listOfNames(groups)}.`,
    );
  }
  return byName[0]!;
}

/**
 * Refuses `group` before a write when its permissions have admin, with the code AdminGroupRefused
 * and `message`: whoever joins with a link of such a group can change and delete the room.
 */
export function refuseAdminGroup(group: PermissionGroup, message: string): void {
  if (group.permissions?.admin === true) throw new ToolError('AdminGroupRefused', message);
}

/**
 * Refuses a change of a link whose stored permission group `groupId` has admin, with the code
 * AdminGroupRefused and `message`, when the call gives no other group: any other change, such as a
 * new email address or validity, would keep the admin rights of the link. A group ID that `groups`
 * does not hold passes, because nothing shows that it has admin.
 */
export function refuseStoredAdminGroup(
  groupId: unknown,
  groups: readonly PermissionGroup[],
  message: string,
): void {
  if (typeof groupId !== 'string') return;
  const stored = groups.find((group) => group.id.toLowerCase() === groupId.toLowerCase());
  if (stored !== undefined) refuseAdminGroup(stored, message);
}
