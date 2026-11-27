/**
 * Rules for alfaview rooms: paths, output mappers, list sorts and searches, the room types of the
 * company's plan, breakout rooms (the API calls them subrooms) and the checks of the room fields.
 */
import { createInputReaders } from './inputs.ts';
import { booleanOrNull, integerOrNull, textOrNull } from './outputValues.ts';
import type { Platform } from './platform.ts';
import { normalizeTimestamp } from './time.ts';

// Constants

export const ROOM_TYPES = ['room', 'department'] as const;
export type RoomType = (typeof ROOM_TYPES)[number];

/** alfaview refuses breakout room names longer than 32 bytes (UTF-8). */
export const SUBROOM_NAME_MAX_BYTES = 32;

/** The 14 room features. The outputs list them in this order. */
export const FEATURE_KEYS = [
  'disableCameraOff',
  'sixteenByNineVideos',
  'centeredVideoGrid',
  'allowCopyRoomInfo',
  'sortVideoGridAlphabetically',
  'raiseHands',
  'showRaisedHandsOnlyToModerators',
  'shareContentOnlyToModerators',
  'blockWebclient',
  'disableMiniWindow',
  'disableJoinAndLeaveNotifications',
  'localRecording',
  'liveStreaming',
  'examScreenshare',
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

/**
 * The API values of a feature state, plus the labels On and Off, keyed in lowercase. Read a
 * feature field with `readFeatureState` of createRoomReaders: it looks up own keys only, so the
 * names that every object inherits (for example `constructor` or `__proto__`) are refused.
 */
export const FEATURE_STATES: Record<string, string> = {
  enabled: 'enabled',
  disabled: 'disabled',
  default: 'default',
  on: 'enabled',
  off: 'disabled',
};

/** The nine room permissions. The outputs list them in this order. */
export const PERMISSION_KEYS = [
  'admin',
  'voice',
  'video',
  'promote',
  'join',
  'screen',
  'vip',
  'chat',
  'upload',
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

/**
 * The permission fields in the order in which a step lists them. readPermissionChanges reads them
 * in this order, so the first bad field is reported.
 */
export const PERMISSION_INPUT_ORDER: readonly PermissionKey[] = [
  'admin',
  'join',
  'voice',
  'video',
  'screen',
  'chat',
  'upload',
  'promote',
  'vip',
];

/** The three quota fields of a new room, which alfaview needs all together. */
export const QUOTA_KEYS = [
  'activeParticipants',
  'spectatorOnlyParticipants',
  'maxVideoTilesPerPage',
] as const;
export type QuotaKey = (typeof QUOTA_KEYS)[number];
export type Quotas = Record<QuotaKey, number>;

/** The quotas of a new room: the three quota fields, or the name of a room type of the plan. */
export type QuotaInput = { quotas?: Quotas; planRoomType?: string };

// API shapes (Room, Subroom, RoomFeatures, RoomPermissions and RoomTypeData in the API docs)

export type ApiPermissions = Partial<Record<PermissionKey, boolean>>;

export type ApiParticipantPermissions = {
  participantId: string;
  permissions?: ApiPermissions;
};

export type ApiSubroom = { id: string; sort?: number; displayName?: string };

export type ApiRoom = {
  id: string;
  displayName?: string;
  type?: string;
  parentId?: string | null;
  waitingRoomEnabled?: boolean;
  waitingRoomWelcomeNote?: string | null;
  passcodeRequired?: boolean | null;
  managed?: boolean;
  sort?: number;
  createdAt?: string;
  createdBy?: string;
  quotas?: {
    activeParticipants?: number;
    spectatorOnlyParticipants?: number;
    maxVideoTilesPerPage?: number;
  } | null;
  features?: Partial<Record<FeatureKey, string>> | null;
  subrooms?: ApiSubroom[] | null;
};

export type ApiRoomPermissions = {
  userPermissions?: ApiParticipantPermissions[] | null;
  guestLinkPermissions?: ApiParticipantPermissions[] | null;
  groupLinkPermissions?: ApiParticipantPermissions[] | null;
};

/**
 * A room type of the company's plan: a named quota template with the number of rooms it allows
 * (`total`) and the rooms that alfaview counts against it (`used`). Rooms that fit no room type
 * appear as an entry with an empty name.
 */
export type ApiRoomType = {
  name: string;
  maxActiveParticipants?: number;
  maxSpectatorOnlyParticipants?: number;
  maxSubRooms?: number;
  total?: number;
  used?: number;
};

// Output shapes

export type RoomFeaturesMap = Record<FeatureKey, string | null>;

export type SubroomSummary = { id: string; displayName: string | null; sort: number | null };

export type RoomOutput = {
  id: string;
  displayName: string | null;
  type: string | null;
  parentId: string | null;
  waitingRoomEnabled: boolean | null;
  waitingRoomWelcomeNote: string | null;
  passcodeRequired: boolean | null;
  managed: boolean | null;
  sort: number | null;
  createdAt: string | null;
  createdBy: string | null;
  quotas: {
    activeParticipants: number | null;
    spectatorOnlyParticipants: number | null;
    maxVideoTilesPerPage: number | null;
  } | null;
  features: RoomFeaturesMap;
  subrooms: SubroomSummary[];
};

export type SubroomOutput = { id: string; roomId: string } & Omit<SubroomSummary, 'id'>;

export type RoomFeaturesOutput = { roomId: string } & RoomFeaturesMap;

export type RoomPermissionOutput = { roomId: string; userId: string } & Record<
  PermissionKey,
  boolean | null
>;

export type RoomDeleteOutput = { id: string; deleted: true };

export type SubroomDeleteOutput = { id: string; roomId: string; deleted: true };

export type RoomPermissionRemovalOutput = { roomId: string; userId: string; removed: true };

// Paths

/**
 * Returns the path of a room, with the room ID in lowercase. Some endpoints find a room only by
 * its lowercase ID, so an uppercase ID can give 404 or an empty list. UUIDs do not depend on case,
 * so this changes no valid ID.
 */
export function roomPath(roomId: string): string {
  return `/v2/rooms/${encodeURIComponent(roomId.toLowerCase())}`;
}

/**
 * Returns the path of a breakout room, with both IDs in lowercase. alfaview finds a breakout room
 * only by its lowercase ID, so with an uppercase ID an update answers 404, and a delete answers
 * 204 but removes nothing.
 */
export function subroomPath(roomId: string, subroomId: string): string {
  return `${roomPath(roomId)}/subrooms/${encodeURIComponent(subroomId.toLowerCase())}`;
}

// Mappers

/** Returns every feature key with its state, or `null` for a missing one. */
export function mapFeatures(features: ApiRoom['features']): RoomFeaturesMap {
  const result = {} as RoomFeaturesMap;
  for (const key of FEATURE_KEYS) {
    result[key] = textOrNull(features?.[key]);
  }
  return result;
}

function mapSubroomSummary(subroom: ApiSubroom): SubroomSummary {
  return {
    id: subroom.id,
    displayName: textOrNull(subroom.displayName),
    sort: integerOrNull(subroom.sort),
  };
}

/**
 * Compares breakout rooms by `sort`, then by ID, because alfaview lists them in random order. A
 * breakout room without `sort` comes last.
 */
export function bySortOrder(
  left: Pick<SubroomSummary, 'id' | 'sort'>,
  right: Pick<SubroomSummary, 'id' | 'sort'>,
): number {
  const leftSort = left.sort ?? Number.MAX_SAFE_INTEGER;
  const rightSort = right.sort ?? Number.MAX_SAFE_INTEGER;
  if (leftSort !== rightSort) return leftSort - rightSort;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Returns the output of a room. Every documented key is present, and an absent value is `null`.
 * The permission arrays and the default permissions are left out, because they can hold thousands
 * of entries.
 */
export function mapRoom(room: ApiRoom): RoomOutput {
  const quotas = room.quotas;
  return {
    id: room.id,
    displayName: textOrNull(room.displayName),
    type: textOrNull(room.type),
    parentId: textOrNull(room.parentId),
    waitingRoomEnabled: booleanOrNull(room.waitingRoomEnabled),
    waitingRoomWelcomeNote: textOrNull(room.waitingRoomWelcomeNote),
    passcodeRequired: booleanOrNull(room.passcodeRequired),
    managed: booleanOrNull(room.managed),
    sort: integerOrNull(room.sort),
    createdAt: normalizeTimestamp(room.createdAt),
    createdBy: textOrNull(room.createdBy),
    quotas:
      typeof quotas === 'object' && quotas !== null
        ? {
            activeParticipants: integerOrNull(quotas.activeParticipants),
            spectatorOnlyParticipants: integerOrNull(quotas.spectatorOnlyParticipants),
            maxVideoTilesPerPage: integerOrNull(quotas.maxVideoTilesPerPage),
          }
        : null,
    features: mapFeatures(room.features),
    subrooms: (room.subrooms ?? []).map(mapSubroomSummary).sort(bySortOrder),
  };
}

export function mapSubroom(roomId: string, subroom: ApiSubroom): SubroomOutput {
  const { id, displayName, sort } = mapSubroomSummary(subroom);
  return { id, roomId, displayName, sort };
}

export function mapRoomFeatures(roomId: string, features: ApiRoom['features']): RoomFeaturesOutput {
  return { roomId, ...mapFeatures(features) };
}

export function mapRoomPermission(
  roomId: string,
  userId: string,
  permissions: ApiPermissions | undefined,
): RoomPermissionOutput {
  const result = { roomId, userId } as RoomPermissionOutput;
  for (const key of PERMISSION_KEYS) {
    result[key] = booleanOrNull(permissions?.[key]);
  }
  return result;
}

/**
 * Returns the nine permissions of a new room member, because alfaview needs them all: each
 * permission field that is set, else the value of the chosen permission group, else `false`.
 */
export function newMemberPermissions(
  changes: ApiPermissions,
  groupPermissions: ApiPermissions | undefined,
): Record<PermissionKey, boolean> {
  const permissions = {} as Record<PermissionKey, boolean>;
  for (const key of PERMISSION_KEYS) {
    permissions[key] = changes[key] ?? groupPermissions?.[key] === true;
  }
  return permissions;
}

// Labels, sorts and searches of lists

/** Compares by label, with case and accents ignored, then by ID. */
export function byLabel(
  left: { id: string; label: string },
  right: { id: string; label: string },
): number {
  const byText = left.label.localeCompare(right.label, 'en', { sensitivity: 'base' });
  if (byText !== 0) return byText;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Returns the label of a room in a list: its name, else its ID. */
export function roomLabel(room: { id: string; displayName?: string }): string {
  return typeof room.displayName === 'string' && room.displayName.trim() !== ''
    ? room.displayName
    : room.id;
}

type NamedRoom = { id: string; displayName: string | null };

/** Compares by name, with case and accents ignored, then by ID. */
export function byRoomName(left: NamedRoom, right: NamedRoom): number {
  const byText = (left.displayName ?? '').localeCompare(right.displayName ?? '', 'en', {
    sensitivity: 'base',
  });
  if (byText !== 0) return byText;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function normalizedName(name: string | null): string {
  return (name ?? '').trim().toLowerCase();
}

/**
 * Returns the rooms for a name, in any case: rooms whose name equals it first, then rooms whose
 * name contains it, each group sorted by name. A room without a match is left out.
 */
export function findRoomsByName<T extends NamedRoom>(rooms: readonly T[], name: string): T[] {
  const wanted = normalizedName(name);
  const exact = rooms.filter((room) => normalizedName(room.displayName) === wanted).sort(byRoomName);
  const partial = rooms
    .filter((room) => {
      const roomName = normalizedName(room.displayName);
      return roomName !== wanted && roomName.includes(wanted);
    })
    .sort(byRoomName);
  return [...exact, ...partial];
}

/** Returns the breakout room with `subroomId` in any case, or `undefined`. */
export function findSubroom(
  subrooms: readonly ApiSubroom[],
  subroomId: string,
): ApiSubroom | undefined {
  const wanted = subroomId.toLowerCase();
  return subrooms.find((subroom) => subroom.id.toLowerCase() === wanted);
}

// Room types of the plan

/** Returns a number of a room type for a label, or `?` when alfaview sent none. */
function countText(value: unknown): string {
  return String(integerOrNull(value) ?? '?');
}

/** Returns a number of a room type for sorting. A missing number sorts last. */
function countOrder(value: unknown): number {
  return integerOrNull(value) ?? Number.MAX_SAFE_INTEGER;
}

/** Compares room types, the smallest first: by active participants, then spectators, then name. */
export function byRoomTypeSize(left: ApiRoomType, right: ApiRoomType): number {
  const byActive = countOrder(left.maxActiveParticipants) - countOrder(right.maxActiveParticipants);
  if (byActive !== 0) return byActive;
  const bySpectators =
    countOrder(left.maxSpectatorOnlyParticipants) - countOrder(right.maxSpectatorOnlyParticipants);
  if (bySpectators !== 0) return bySpectators;
  return left.name.localeCompare(right.name, 'en', { sensitivity: 'base' });
}

/**
 * Returns the label of a room type of the plan. The room counts are those of the moment the list
 * was loaded, and the label says so, because a saved label can outlive its counts.
 */
export function planRoomTypeLabel(type: ApiRoomType): string {
  return `${type.name} (${countText(type.maxActiveParticipants)} active and ${countText(type.maxSpectatorOnlyParticipants)} spectator participants, ${countText(type.used)} of ${countText(type.total)} rooms used when loaded)`;
}

/**
 * Returns the room types of a `GET /v2/room-types` answer, a bare array with one page. A missing
 * or `null` body gives none. Entries without a text name are left out, and the entry with an empty
 * name stays. Returns `undefined` for a body that is not a list, so that the caller throws its
 * response error.
 */
export function readRoomTypeList(data: unknown): ApiRoomType[] | undefined {
  if (data === undefined || data === null) return [];
  if (!Array.isArray(data)) return undefined;
  return data.filter(
    (entry): entry is ApiRoomType =>
      typeof entry === 'object' && entry !== null && typeof (entry as ApiRoomType).name === 'string',
  );
}

/** Returns the room type named `name`: the exact name first, then the name in any case. */
export function findRoomType(types: readonly ApiRoomType[], name: string): ApiRoomType | undefined {
  const wanted = name.toLowerCase();
  return (
    types.find((type) => type.name === name) ??
    types.find((type) => type.name.toLowerCase() === wanted)
  );
}

/**
 * Returns the quotas of a room type of the plan, with 0 video tiles per page: the value that
 * alfaview uses for a room created without quotas. Returns `undefined` when alfaview sent no limit
 * for active or spectator participants, so that the caller throws its own response error.
 */
export function roomTypeQuotas(type: ApiRoomType): Quotas | undefined {
  const activeParticipants = integerOrNull(type.maxActiveParticipants);
  const spectatorOnlyParticipants = integerOrNull(type.maxSpectatorOnlyParticipants);
  if (activeParticipants === null || spectatorOnlyParticipants === null) return undefined;
  return { activeParticipants, spectatorOnlyParticipants, maxVideoTilesPerPage: 0 };
}

/** Returns the message for a room type that the company's plan does not have. */
export function noPlanRoomTypeMessage(name: string): string {
  return `Your alfaview plan has no room type named ${name}. Choose one from the list.`;
}

/** Returns the message for a room type of the plan without the limits that roomTypeQuotas needs. */
export function noRoomTypeLimitsMessage(typeName: string): string {
  return `alfaview did not return the limits of the room type ${typeName}.`;
}

// Breakout room lists and names

/**
 * Returns the breakout rooms of a `GET /v2/rooms/{roomId}/subrooms` answer, a bare array with one
 * page. A missing or `null` body gives none. Entries without an ID that is a text and not empty
 * are left out. Returns `undefined` for a body that is not a list, so that the caller throws its
 * response error.
 */
export function readSubrooms(data: unknown): ApiSubroom[] | undefined {
  if (data === undefined || data === null) return [];
  if (!Array.isArray(data)) return undefined;
  return data.filter(
    (entry): entry is ApiSubroom =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as ApiSubroom).id === 'string' &&
      (entry as ApiSubroom).id !== '',
  );
}

/**
 * Returns the number of bytes of `text` in UTF-8, the unit of alfaview's limit on breakout room
 * names. A lone surrogate counts 3 bytes, as the replacement character that it becomes.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) as number;
    if (codePoint < 0x80) bytes += 1;
    else if (codePoint < 0x800) bytes += 2;
    else if (codePoint < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * Returns the message for a breakout room name above SUBROOM_NAME_MAX_BYTES. `label` names the
 * field.
 */
export function subroomNameTooLongMessage(label: string): string {
  return `${label} can have at most ${SUBROOM_NAME_MAX_BYTES} bytes (${SUBROOM_NAME_MAX_BYTES} letters without accents).`;
}

// Readers and checks

/** The names of the room fields in the messages of createRoomReaders. */
export type RoomLabels = {
  /** The Room field, the default label of readRoomId. */
  room: string;
  /** The User field, the default label of readUserId. */
  user: string;
  /** The field of the room type (room or department), the default label of readRoomType. */
  roomType: string;
  /** The field of a room type of the company's plan. */
  planRoomType: string;
  /** The three quota fields. */
  quotas: Record<QuotaKey, string>;
  /** The nine permission fields. */
  permissions: Record<PermissionKey, string>;
  /** The field of a breakout room name. */
  subroomName: string;
};

/** The readers of createRoomReaders. */
export type RoomReaders = {
  /** Reads a required Room field (a room or meeting ID). */
  readRoomId: (value: unknown, label?: string) => string;
  /** Reads a required User field (a user ID). */
  readUserId: (value: unknown, label?: string) => string;
  /** Reads a room type field: `room` or `department` in any case. Empty gives `room`. */
  readRoomType: (value: unknown, label?: string) => RoomType;
  /** Reads the permission fields that are set, as `{ key: boolean }`, in PERMISSION_INPUT_ORDER. */
  readPermissionChanges: (input: Record<string, unknown>) => ApiPermissions;
  /**
   * Reads the three quota fields, or a room type of the plan instead. The quota fields must be all
   * set or none, because alfaview requires all three together. A room type takes no video tiles
   * per page: the room types of the plan show no tile limit, and more tiles than the type allows
   * would count the room against a larger type without an error. Reads the fields only, and the
   * caller looks up the room type.
   */
  readQuotas: (input: Record<string, unknown>) => QuotaInput;
  /** Refuses a breakout room name of more than SUBROOM_NAME_MAX_BYTES bytes in UTF-8. */
  checkSubroomName: (name: string) => void;
  /**
   * Reads a feature field: On, Off or Default, or the API values, in any case. Empty gives
   * `undefined`. Anything else is refused, also the names that every object inherits.
   */
  readFeatureState: (value: unknown, label: string) => string | undefined;
};

/**
 * Returns the room readers bound to `platform`, with the field names of `labels` in their
 * messages.
 */
export function createRoomReaders(platform: Platform, labels: RoomLabels): RoomReaders {
  const { readBoolean, readInteger, readRequiredString, readString } =
    createInputReaders(platform);

  function readRoomType(value: unknown, label = labels.roomType): RoomType {
    const text = readString(value, label)?.toLowerCase();
    if (text === undefined) return 'room';
    if (text === 'room' || text === 'department') return text;
    throw platform.invalidInput(`${label} must be Room or Department.`);
  }

  function readPermissionChanges(input: Record<string, unknown>): ApiPermissions {
    const changes: ApiPermissions = {};
    for (const key of PERMISSION_INPUT_ORDER) {
      const value = readBoolean(input[key], labels.permissions[key]);
      if (value !== undefined) changes[key] = value;
    }
    return changes;
  }

  function readQuotas(input: Record<string, unknown>): QuotaInput {
    const values = {} as Record<QuotaKey, number | undefined>;
    for (const key of QUOTA_KEYS) {
      values[key] = readInteger(input[key], labels.quotas[key], { min: 0 });
    }
    const planRoomType = readString(input.planRoomType, labels.planRoomType);

    if (planRoomType !== undefined) {
      if (values.activeParticipants !== undefined || values.spectatorOnlyParticipants !== undefined) {
        throw platform.invalidInput(
          `Choose ${labels.planRoomType} or set ${labels.quotas.activeParticipants} and ${labels.quotas.spectatorOnlyParticipants}, not both.`,
        );
      }
      if (values.maxVideoTilesPerPage !== undefined) {
        throw platform.invalidInput(
          `Leave ${labels.quotas.maxVideoTilesPerPage} empty when you choose ${labels.planRoomType}.`,
        );
      }
      return { planRoomType };
    }

    const setCount = QUOTA_KEYS.filter((key) => values[key] !== undefined).length;
    if (setCount === 0) return {};
    if (setCount < QUOTA_KEYS.length) {
      throw platform.invalidInput('Set all three quota fields or none.');
    }
    return { quotas: values as Quotas };
  }

  function checkSubroomName(name: string): void {
    if (utf8ByteLength(name) > SUBROOM_NAME_MAX_BYTES) {
      throw platform.invalidInput(subroomNameTooLongMessage(labels.subroomName));
    }
  }

  function readFeatureState(value: unknown, label: string): string | undefined {
    const text = readString(value, label);
    if (text === undefined) return undefined;
    const key = text.toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(FEATURE_STATES, key)) {
      throw platform.invalidInput(`${label} must be On, Off or Default.`);
    }
    return FEATURE_STATES[key];
  }

  return {
    readRoomId: (value, label = labels.room) => readRequiredString(value, label),
    readUserId: (value, label = labels.user) => readRequiredString(value, label),
    readRoomType,
    readPermissionChanges,
    readQuotas,
    checkSubroomName,
    readFeatureState,
  };
}
