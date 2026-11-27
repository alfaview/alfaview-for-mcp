/**
 * The permission groups of the company (`GET /v2/permission-groups`). Guest links and group links
 * refer to a group by ID. A company can rename the default groups, so the group named Guest is
 * only a fallback when the user chose no group.
 */
import type { ApiPermissions } from './rooms.ts';

export type PermissionGroup = {
  id: string;
  name: string;
  permissions?: ApiPermissions;
};

export const DEFAULT_GUEST_GROUP_NAME = 'Guest';

/**
 * Reads the groups of a `GET /v2/permission-groups` answer, in the order of the answer. A missing
 * or `null` body is an empty list, and entries without a text ID and name are left out. Returns
 * `undefined` for a body that is not a list, so that the caller throws its response error.
 */
export function readPermissionGroups(data: unknown): PermissionGroup[] | undefined {
  if (data !== undefined && data !== null && !Array.isArray(data)) return undefined;
  return ((data ?? []) as { id?: unknown; name?: unknown }[]).filter(
    (group): group is PermissionGroup =>
      typeof group?.id === 'string' && typeof group?.name === 'string',
  );
}

/** Returns a map from the lowercase permission group ID to its name. */
export function groupNamesById(groups: readonly PermissionGroup[]): Map<string, string> {
  return new Map(groups.map((group) => [group.id.toLowerCase(), group.name] as const));
}

/** Returns the first group named Guest (trimmed, any case), the default for guest links. */
export function findGuestGroup(groups: readonly PermissionGroup[]): PermissionGroup | undefined {
  const wanted = DEFAULT_GUEST_GROUP_NAME.toLowerCase();
  return groups.find((group) => group.name.trim().toLowerCase() === wanted);
}
