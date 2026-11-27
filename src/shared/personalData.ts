/**
 * The option Personal data. Include, the default, gives every value. Leave out sets to `null` the
 * names, email addresses and other personal fields of a user, and the texts that people write
 * about a meeting or a booking, in every output, label and message. Every key stays.
 */
import { formatZonedDateTime } from './time.ts';

// The option

/** `include` gives every value. `omit` (Leave out) sets the personal values to `null`. */
export type PersonalDataMode = 'include' | 'omit';

/** The label of the option, also the default `label` of readPersonalDataMode. */
export const PERSONAL_DATA_LABEL = 'Personal data';

/**
 * Reads the option. Missing, `null` and `''` give the mode `include`, because a connection saved
 * before the option existed has no value. `include` and `omit` give themselves. Any other value
 * gives a problem sentence that names the valid values, with `label` as the name of the option.
 * The function throws nothing, so that the caller reports the problem in its own way.
 */
export function readPersonalDataMode(
  value: unknown,
  label = PERSONAL_DATA_LABEL,
): { mode: PersonalDataMode } | { problem: string } {
  if (value === undefined || value === null || value === '') return { mode: 'include' };
  if (value === 'include' || value === 'omit') return { mode: value };
  return { problem: `${label} must be include or omit, or empty for include.` };
}

// What Leave out removes

/**
 * The paths of the keys that Leave out sets to `null`, for each output shape. A path names a key
 * of the shape: `object.key` names the key of the object `object`, and `list[].key` names the key
 * in every entry of the list `list`. A path to a list of personal values, such as
 * `attendedEmails`, sets the whole list to `null`. A shape without personal values has an empty
 * list, so that every output can pass through leaveOutPersonalData.
 *
 * A shape with the prefix `mcp.` is a separate output shape, whose keys can differ from those of a
 * shape of the same name without the prefix. The names of rooms other than meeting rooms
 * (MEETING_ROOM_NAME_KEYS), breakout room names, group link descriptions, permission group names,
 * IDs (`createdBy` and `userId` included), times, counts, states, join URLs, dial-in codes and
 * passcodes stay.
 */
export const PERSONAL_KEYS = {
  room: ['waitingRoomWelcomeNote'],
  breakoutRoom: [],
  roomFeatures: [],
  languageSettings: [],
  fileSharing: [],
  statistics: [],
  roomPermission: [],
  passcode: [],
  guestLink: ['emailAddress', 'displayName', 'origin'],
  groupLink: ['origin'],
  meeting: ['title', 'agenda'],
  participant: ['displayName', 'emailAddress', 'guestLinkOrigin'],
  attendee: ['displayName', 'emailAddress', 'guestLinkOrigin'],
  attendanceReport: [
    'attendedEmails',
    'noShowEmails',
    'origin',
    'guests[].emailAddress',
    'guests[].displayName',
    'guests[].origin',
  ],
  guestLinkAttendance: ['emailAddress', 'displayName'],
  user: ['emailAddress', 'firstName', 'lastName', 'title', 'city', 'initials'],
  expiredGuestLinkCleanup: [],
  'mcp.room': ['waitingRoomWelcomeNote'],
  'mcp.guestLink': ['emailAddress', 'displayName', 'origin'],
  'mcp.createGuestLinksResult': ['results[].emailAddress', 'results[].displayName'],
  'mcp.deleteExpiredGuestLinksResult': ['originContains'],
  'mcp.meeting': ['title', 'agenda'],
  'mcp.participant': ['displayName', 'emailAddress', 'guestLinkOrigin'],
  'mcp.roomAttendance': [
    'attendedEmails',
    'noShowEmails',
    'origin',
    'invitees[].emailAddress',
    'invitees[].displayName',
    'invitees[].origin',
    'otherAttendees[].emailAddress',
    'otherAttendees[].displayName',
  ],
  'mcp.guestLinkAttendance': ['emailAddress', 'displayName'],
  'mcp.passcode': [],
  'mcp.statistics': [],
  'mcp.account': [
    'user.emailAddress',
    'user.firstName',
    'user.lastName',
    'user.title',
    'user.city',
    'user.initials',
  ],
  'mcp.user': ['emailAddress', 'firstName', 'lastName', 'title', 'city', 'initials'],
  'mcp.roomSettings': [],
  'mcp.breakoutRoom': [],
  'mcp.groupLink': ['origin'],
  'mcp.roomPermission': ['userName'],
} as const;

/** The name of an output shape of PERSONAL_KEYS. */
export type PersonalDataShape = keyof typeof PERSONAL_KEYS;

// The name of a meeting room

/**
 * The type of the room of a meeting (spec: Room.type). alfaview names this room after the meeting
 * title and renames it when the title changes, so its name is a meeting title.
 */
export const MEETING_ROOM_TYPE = 'meeting';

/** Returns whether `type`, the `type` of a room as alfaview gives it, is MEETING_ROOM_TYPE. */
export function isMeetingRoomType(type: unknown): boolean {
  return type === MEETING_ROOM_TYPE;
}

/**
 * The keys of the room name in the shapes whose value is a room with its `type`. Leave out sets
 * them to `null` when the type is MEETING_ROOM_TYPE. The names of other rooms and of breakout
 * rooms stay. An output that names its room by `roomName`, such as a guest link, does not hold
 * the type of the room, so the caller sets that name with roomNameWithoutPersonalData where it
 * reads the room.
 */
export const MEETING_ROOM_NAME_KEYS: Partial<Record<PersonalDataShape, readonly string[]>> = {
  room: ['displayName'],
  'mcp.room': ['displayName'],
};

/**
 * Returns the name of a room for an output with Leave out, such as `roomName` of a guest link:
 * `null` for a meeting room, whose name is the meeting title, and `name` for every other room.
 * `type` is the type of the room as alfaview gives it.
 */
export function roomNameWithoutPersonalData(name: string | null, type: unknown): string | null {
  return isMeetingRoomType(type) ? null : name;
}

/** Returns the toString tag of `value`, such as `Object`, `Array`, `Date`, `Map` or `Error`. */
function kindOf(value: unknown): string {
  return Object.prototype.toString.call(value).slice(8, -1);
}

/**
 * Returns whether `value` is an object whose own keys hold its data, as JSON.stringify reads it: a
 * plain object, an object without a prototype or a class instance, of this realm or another one.
 * A list, a Date, a Map or an Error is not.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return kindOf(value) === 'Object';
}

/** Returns a deep copy of the lists and records of `value`. Other values stay as they are. */
function copyOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyOf);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, copyOf(entry)]));
  }
  return value;
}

/**
 * Sets the key at the path `keys` of `container`, a part of the copy, to `null`, in every entry of
 * each list on the way. A key or a container that is missing or `null`, and a value that is no
 * object, stays as it is. An object of another kind that holds the key, such as an Error, throws a
 * TypeError: copyOf does not copy it, so the removal fails instead of giving its personal value.
 */
function setNull(container: unknown, keys: readonly string[]): void {
  if (Array.isArray(container)) {
    for (const entry of container) setNull(entry, keys);
    return;
  }
  const key = keys[0] as string;
  if (typeof container !== 'object' || container === null) return;
  if (!Object.prototype.hasOwnProperty.call(container, key)) return;
  if (!isRecord(container)) {
    throw new TypeError(`leaveOutPersonalData cannot copy the ${kindOf(container)} that holds ${key}.`);
  }
  if (keys.length === 1) {
    container[key] = null;
    return;
  }
  setNull(container[key], keys.slice(1));
}

/**
 * Sets the keys `keys` of `room`, a part of the copy, to `null` when its `type` is the type of a
 * meeting room, in every entry of a list. The rules of setNull apply.
 */
function setNullInMeetingRoom(room: unknown, keys: readonly string[]): void {
  if (Array.isArray(room)) {
    for (const entry of room) setNullInMeetingRoom(entry, keys);
    return;
  }
  if (typeof room !== 'object' || room === null) return;
  if (!isMeetingRoomType((room as { type?: unknown }).type)) return;
  for (const key of keys) setNull(room, [key]);
}

/**
 * Returns `value` without the personal values of `shape`, by `mode`. With `include` it returns
 * `value` itself. With `omit` it returns a copy in which every path of PERSONAL_KEYS for `shape` is
 * `null`, and so is the room name of MEETING_ROOM_NAME_KEYS in a meeting room. `value` stays as it
 * was. Call it last, on the value that the caller hands on: matching, counting, sorting and the
 * requests need the full values.
 *
 * The copy has the same keys as `value`, so that no output field goes missing. A key that is
 * missing stays missing, and a list or an object that is `null` or missing on the way stays as it
 * is. A path through a list applies to every entry.
 * `value` can also be a list of outputs of the shape, such as the result of a search: then each
 * entry loses its personal values. The copy takes the own keys of every object, whatever its
 * prototype or realm, so a class instance loses its personal values too. An object of another
 * kind, such as an Error, that holds a key of a path throws a TypeError.
 */
export function leaveOutPersonalData<T>(
  shape: PersonalDataShape,
  value: T,
  mode: PersonalDataMode,
): T {
  if (mode === 'include') return value;
  const copy = copyOf(value);
  const paths: readonly string[] = PERSONAL_KEYS[shape];
  for (const path of paths) {
    setNull(
      copy,
      path.split('.').map((key) => key.replace(/\[\]$/, '')),
    );
  }
  const roomNameKeys = MEETING_ROOM_NAME_KEYS[shape];
  if (roomNameKeys !== undefined) setNullInMeetingRoom(copy, roomNameKeys);
  return copy as T;
}

// Labels with Leave out

/** Returns the label of a user in a dropdown or a list search with Leave out: the user ID. */
export function userLabelWithoutPersonalData(user: { id: string }): string {
  return user.id;
}

/**
 * Returns the label of a room in a dropdown or a list search with Leave out: the room ID for a
 * meeting room, whose name is the meeting title. Every other room gets the label that it has with
 * Include: its name, else its ID.
 */
export function roomLabelWithoutPersonalData(room: {
  id: string;
  displayName?: unknown;
  type?: unknown;
}): string {
  if (isMeetingRoomType(room.type)) return room.id;
  const { displayName } = room;
  return typeof displayName === 'string' && displayName.trim() !== '' ? displayName : room.id;
}

/**
 * Returns the label of a guest link with Leave out: "Valid from YYYY-MM-DD (ID)", with the date of
 * `validFrom` in `timeZone`, or the ID alone when the link has no `validFrom`.
 */
export function guestLinkLabelWithoutPersonalData(
  link: { id: string; validFrom?: unknown },
  timeZone: string,
): string {
  const validFrom = formatZonedDateTime(link.validFrom, timeZone);
  return validFrom === null ? link.id : `Valid from ${validFrom.slice(0, 10)} (${link.id})`;
}

/**
 * Returns the label of a meeting with Leave out: "YYYY-MM-DD HH:mm (ID)", with the start in
 * `timeZone`, or the ID alone when the meeting has no start.
 */
export function meetingLabelWithoutPersonalData(
  meeting: { id: string; start?: unknown },
  timeZone: string,
): string {
  const start = formatZonedDateTime(meeting.start, timeZone);
  return start === null ? meeting.id : `${start} (${meeting.id})`;
}

// Texts with Leave out

/**
 * The message of an operation that refuses to run with Leave out, because its only purpose is a
 * personal value.
 */
export const PERSONAL_DATA_REFUSAL_MESSAGE =
  'This connection leaves out personal data. Use a connection with Personal data set to Include for this step.';

/**
 * Returns the message of a 422 answer with Leave out, for an operation whose answer can repeat a
 * personal value of the input. It leaves out alfaview's `detail` and `errors[].message`.
 * `locations` are the field locations of the problem (fieldLocations of apiErrors.ts), which name
 * a field and never a value. The prefix `body.` is dropped, as in the message with Include.
 */
export function inputErrorWithoutPersonalData(locations: readonly string[]): string {
  const fields = locations.map((location) => location.replace(/^body\./, ''));
  const check = fields.length === 0 ? '' : ` Check ${fields.join(', ')}.`;
  return `alfaview could not process the input.${check} The reason from alfaview is hidden because Personal data is set to Leave out.`;
}
