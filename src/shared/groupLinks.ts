/**
 * Group links. A group link is one link that many people share. People who join with it get a
 * random user ID, so attendance data cannot match them to a person.
 */
import { lookupName, type LinkNames } from './guestLinks.ts';
import { booleanOrNull, textOrNull } from './outputValues.ts';
import { roomPath } from './rooms.ts';
import { formatLocalTimestamp, normalizeTimestamp } from './time.ts';

// API shape (spec: GroupLink)

export type ApiGroupLink = {
  id: string;
  roomId?: string;
  description?: string;
  joinUrl?: string;
  /** Deprecated by alfaview in favor of `joinUrl`. Never part of an output. */
  joinLink?: string;
  accessKey?: string;
  permissionGroupId?: string;
  validFrom?: string;
  validUntil?: string;
  dialInAllowed?: boolean;
  dialInCode?: string;
  origin?: string;
  createdAt?: string;
  createdBy?: string;
};

// Output shape, mapper and label

/**
 * The Group Link output. `validFromLocal` and `validUntilLocal` show the validity as local time in
 * the time zone of the step, with the zone name.
 */
export type GroupLinkOutput = {
  id: string;
  roomId: string | null;
  roomName: string | null;
  description: string | null;
  joinUrl: string | null;
  permissionGroupId: string | null;
  permissionGroupName: string | null;
  validFrom: string | null;
  validFromLocal: string | null;
  validUntil: string | null;
  validUntilLocal: string | null;
  dialInAllowed: boolean | null;
  dialInCode: string | null;
  origin: string | null;
  createdAt: string | null;
  createdBy: string | null;
};

/**
 * Returns the Group Link output. Every documented key is present, absent values are `null`, and
 * timestamps before 1971 are `null`. The access key and the deprecated `joinLink` are left out.
 * The local times use `timeZone`, the time zone of the step.
 */
export function mapGroupLink(
  link: ApiGroupLink,
  names: LinkNames,
  timeZone: string,
): GroupLinkOutput {
  return {
    id: link.id,
    roomId: textOrNull(link.roomId),
    roomName: lookupName(names.roomNames, link.roomId),
    description: textOrNull(link.description),
    joinUrl: textOrNull(link.joinUrl),
    permissionGroupId: textOrNull(link.permissionGroupId),
    permissionGroupName: lookupName(names.groupNames, link.permissionGroupId),
    validFrom: normalizeTimestamp(link.validFrom),
    validFromLocal: formatLocalTimestamp(link.validFrom, timeZone),
    validUntil: normalizeTimestamp(link.validUntil),
    validUntilLocal: formatLocalTimestamp(link.validUntil, timeZone),
    dialInAllowed: booleanOrNull(link.dialInAllowed),
    dialInCode: textOrNull(link.dialInCode),
    origin: textOrNull(link.origin),
    createdAt: normalizeTimestamp(link.createdAt),
    createdBy: textOrNull(link.createdBy),
  };
}

/** Returns the description of the group link, or its ID when it has none. */
export function groupLinkLabel(link: ApiGroupLink): string {
  const description = typeof link.description === 'string' ? link.description.trim() : '';
  return description === '' ? link.id : description;
}

// Paths and hint

export function groupLinkPath(groupLinkId: string): string {
  return `/v2/group-links/${encodeURIComponent(groupLinkId)}`;
}

/** Returns the path of the group links of a room, or of the company when `roomId` is undefined. */
export function groupLinksPath(roomId: string | undefined): string {
  return roomId === undefined ? '/v2/group-links' : `${roomPath(roomId)}/group-links`;
}

export function roomGroupLinkPath(roomId: string, groupLinkId: string): string {
  return `${roomPath(roomId)}/group-links/${encodeURIComponent(groupLinkId)}`;
}

/** Returns the sentence after the TooManyResults message of a group link list without a room. */
export function groupLinksHint(roomId: string | undefined): string | undefined {
  return roomId === undefined ? 'Choose a room.' : undefined;
}
