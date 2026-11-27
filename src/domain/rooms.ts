// Rooms and breakout rooms (the API calls them subrooms) for the MCP tools. The API shapes and the
// rules that do not depend on MCP are in ../shared/rooms.ts.
import type { ApiResponse, CallApi } from '../alfaview/client.ts';
import {
  invalidInput,
  invalidResponse,
  missingCreatedIdMessage,
  sendCreate,
  ToolError,
} from '../alfaview/errors.ts';
import { fetchAllPages } from '../alfaview/pagination.ts';
import { booleanOrNull, integerOrNull, textOrNull } from '../shared/outputValues.ts';
import {
  byRoomName,
  byRoomTypeSize,
  bySortOrder,
  FEATURE_KEYS,
  findRoomsByName as roomsWithName,
  findRoomType,
  noRoomTypeLimitsMessage,
  readRoomTypeList,
  readSubrooms,
  roomPath,
  roomTypeQuotas,
  subroomPath,
  type ApiRoom,
  type ApiRoomType,
  type ApiSubroom,
  type FeatureKey,
  type Quotas,
  type RoomType,
} from '../shared/rooms.ts';
import { compact } from '../values/inputs.ts';
import { formatTimestamp } from '../values/time.ts';

export { roomPath } from '../shared/rooms.ts';
export type { ApiRoom, ApiSubroom } from '../shared/rooms.ts';

/** The page size of room lists: the most that `GET /v2/rooms` allows. */
export const ROOM_PAGE_SIZE = 50;

/**
 * Returns whether `roomId` is the ID of a meeting room: a version 5 UUID with the kind 34 (hex 22)
 * in byte 10. The layout is observed, not part of the API docs, and an ID of another layout counts
 * as no meeting room. The group link tools refuse a meeting room with it, and the guest links give
 * inMeetingRoom, both without a request.
 */
export function isMeetingRoomId(roomId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-22[0-9a-f]{10}$/i.test(roomId);
}

/**
 * Maximum length of a waiting room welcome note in alfaview, counted in code points, not in UTF-16
 * units.
 */
export const WELCOME_NOTE_MAX_CHARACTERS = 300;

/**
 * Feature states that a change takes, as the API names them. `default` removes the room's own
 * setting. The model reads them in the enum, so the labels On and Off of FEATURE_STATES
 * (../shared/rooms.ts) are left out.
 */
export const FEATURE_STATE_VALUES = ['enabled', 'disabled', 'default'] as const;

export type FeatureStateValue = (typeof FEATURE_STATE_VALUES)[number];

/** A state for each feature that a change sets. */
export type FeatureChange = Partial<Record<FeatureKey, FeatureStateValue>>;

// Messages

export const DEPARTMENT_MESSAGE =
  'Departments cannot be joined, so they have no waiting room, welcome note, passcode or participant limits. Leave out waitingRoomEnabled, waitingRoomWelcomeNote, passcodeRequired and planRoomType.';

export const ROOM_UNCERTAIN_MESSAGE =
  'alfaview may have created the room before the error. Check with find_rooms before you create it again: a second create makes a second room.';

export const CREATE_ROOM_DENIED_MESSAGE =
  "alfaview refused the room. The API key's user needs the user permission Create Rooms or Room Admin.";

export const ROOM_TYPE_LIST_MESSAGE = 'alfaview sent an unexpected room type response.';

/**
 * Returns the error for a room type that the company's plan does not have. It lists `names`, the
 * plan's room types from roomTypeNames, because the model has no dropdown to choose from. An empty
 * `names` gives the error that the plan has no room types.
 */
export function unknownPlanRoomTypeMessage(name: string, names: readonly string[]): string {
  return names.length === 0
    ? 'Your alfaview plan has no room types. Leave out planRoomType.'
    : `Your alfaview plan has no room type named ${name}. Its room types: ${names.join(', ')}.`;
}

/** Returns the error when the new room exists but cannot be read back. */
export function roomCreatedButNotReadMessage(roomId: string): string {
  return `alfaview created the room ${roomId}, but reading it back failed. Do not create it again: that makes a second room. Use get_room with this ID to read it.`;
}

/**
 * The sentence after a refusal of an update_room call that changes the waiting room and another
 * field. alfaview saves the room before its waiting room options, and can refuse the options after
 * that save.
 */
export const SAVED_BEFORE_WAITING_ROOM_SENTENCE =
  'alfaview saves the other fields of this call before the waiting room, so they may be saved: check with get_room before you call again.';

/** Returns the error when the room cannot be read back after a saved change. */
export function roomUpdatedButNotReadMessage(roomId: string): string {
  return `alfaview saved the change to room ${roomId}, but reading it back failed. Use get_room with this ID to read the room.`;
}

export const BREAKOUT_ROOM_LIST_MESSAGE = 'alfaview sent an unexpected breakout room response.';

export const BREAKOUT_ROOM_UNCERTAIN_MESSAGE =
  'alfaview may have created the breakout room before the error. Check with get_room before you create it again: a second create makes a second breakout room.';

export const BREAKOUT_ROOM_ID_MISSING_MESSAGE =
  'alfaview did not return the ID of the new breakout room, but may have created it. Check with get_room before you create it again: a second create makes a second breakout room.';

export const BREAKOUT_ROOM_NOT_LISTED_WARNING =
  'alfaview did not list the new breakout room after the create, so displayName is the name that was sent and breakoutRoomCount is null.';

/** Returns the error for a breakout room that the room does not list. Nothing was deleted. */
export function breakoutRoomNotFoundMessage(subroomId: string, roomId: string): string {
  return `alfaview could not find the breakout room ${subroomId} in room ${roomId}, so nothing was deleted. get_room lists the breakout rooms of a room.`;
}

export const ROOM_DELETE_NOT_FOUND_MESSAGE =
  "alfaview could not find the room, so nothing was deleted. The room is already deleted, or the API key's user cannot see it.";

export const MEETING_ROOM_DELETE_MESSAGE =
  'This is the room of a meeting, and alfaview does not delete meeting rooms. Cancel the meeting with cancel_meeting.';

export const DEPARTMENT_DELETE_WARNING =
  'This was a department. alfaview deletes the department only: the rooms in it are not deleted.';

/**
 * Returns the error of delete_room when confirmRoomName is not the name of the room. It does not
 * name the room, so the tool does not hand the name to an injected instruction.
 */
export function confirmRoomNameMessage(roomId: string): string {
  return `confirmRoomName is not the name of room ${roomId}, so nothing was deleted. Check with get_room that this is the room to delete.`;
}

/** Returns the error of delete_room for a room without a name, which nothing can confirm. */
export function unnamedRoomMessage(roomId: string): string {
  return `Room ${roomId} has no name, so nothing was deleted. Give it a name with update_room first, then confirm with that name.`;
}

/**
 * The error of delete_room for a client that cannot ask the person, when the call gives no
 * confirmRoomName.
 */
export const CONFIRM_ROOM_NAME_MISSING_MESSAGE =
  'This client cannot ask the person to confirm. Give confirmRoomName: the name of the room, as the person named it.';

/**
 * The characters that quotedForPerson writes as `\u{...}`. A person cannot see the control and
 * format characters and the separators of lines and paragraphs, or they change the order in which
 * a text shows. The others look like the ASCII double quote. Single quotes and guillemets stay,
 * so an apostrophe stays readable.
 */
const ESCAPED_CHARACTERS = new RegExp(
  String.raw`[\p{Cc}\p{Cf}\p{Zl}\p{Zp}` +
    // The confusables of the double quote in Unicode 18.0 (https://www.unicode.org/reports/tr39/).
    String.raw`\u{02BA}\u{02DD}\u{02EE}\u{02F6}\u{05F2}\u{05F4}\u{1CD3}\u{201C}\u{201D}\u{201F}` +
    String.raw`\u{2033}\u{2036}\u{3003}\u{FF02}` +
    // The other double quotation marks, and the double quotation mark ornaments.
    String.raw`\u{201E}\u{275D}\u{275E}\u{2760}\u{2E42}\u{301D}-\u{301F}\u{1F676}-\u{1F678}]`,
  'gu',
);

/**
 * Returns `text` in double quotes for a question to the person, in the form of JSON: a quote, a
 * backslash and a line break come escaped. Each character of ESCAPED_CHARACTERS comes as
 * `\u{...}`. So a text that other people wrote cannot close its quotes or start a line of its own,
 * and no character of it looks like the closing quote.
 */
export function quotedForPerson(text: string): string {
  return JSON.stringify(text).replace(
    ESCAPED_CHARACTERS,
    (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`,
  );
}

/** The room or department that delete_room asks the person about. */
export type RoomToDelete = {
  id: string;
  name: string;
  department: boolean;
  /** When alfaview created it, as a local time with the zone name, or `null`. */
  createdAt: string | null;
};

/** The notes of this server for the question, each a local time with the zone name, or `null`. */
export type RoomDeleteNotes = {
  /** When this server sent a new name for this room. */
  renamedAt: string | null;
  /** When this server sent the name of this room for another room, or for a new one. */
  sameNameAt: string | null;
};

/**
 * Returns the question to the person before the delete. The facts of the server come first: the
 * ID, what the delete does, when alfaview created the room, and the notes. The model can give a
 * room any name, but it cannot hide the notes. Room names are not unique, so the time of the
 * create tells two rooms of one name apart. The name comes last, quoted and escaped by
 * quotedForPerson: other people write it, so it cannot pass as a text of the server.
 */
export function roomDeleteQuestion(room: RoomToDelete, notes: RoomDeleteNotes): string {
  const noun = room.department ? 'department' : 'room';
  const effect = room.department
    ? 'alfaview deletes only the department: the rooms in it stay.'
    : 'alfaview disconnects everyone in it and deletes its breakout rooms, guest links, group links, files and polls. Its attendance can no longer be read.';
  const sentences = [`Delete the ${noun} with the ID ${room.id} for good?`, effect, 'This cannot be undone.'];
  if (room.createdAt !== null) sentences.push(`alfaview created this ${noun} at ${room.createdAt}.`);
  if (notes.renamedAt !== null) {
    sentences.push(`This server sent a new name for this ${noun} at ${notes.renamedAt}.`);
  }
  if (notes.sameNameAt !== null) {
    sentences.push(`This server sent the same name for another room or department at ${notes.sameNameAt}.`);
  }
  sentences.push(`Its name: ${quotedForPerson(room.name)}.`);
  return sentences.join(' ');
}

/** The form field of the room question: the person types the name of the room. */
export const ROOM_NAME_FIELD = {
  name: 'roomName',
  title: 'Room name',
  description: 'Type the name of the room to delete it.',
};

/** The form field of the department question. */
export const DEPARTMENT_NAME_FIELD = {
  name: 'roomName',
  title: 'Department name',
  description: 'Type the name of the department to delete it.',
};

/**
 * Returns the warning when the person types a name other than the name of the room or department.
 * It never gives the expected name.
 */
export function roomNameMismatchWarning(department: boolean): string {
  return `The person typed a name that is not the name of the ${department ? 'department' : 'room'}.`;
}

// Output shapes

export type RoomSummary = {
  id: string;
  displayName: string | null;
  type: string | null;
  parentId: string | null;
  waitingRoomEnabled: boolean | null;
  passcodeRequired: boolean | null;
};

export type Room = RoomSummary & {
  waitingRoomWelcomeNote: string | null;
  managed: boolean | null;
  createdAt: string | null;
  quotas: {
    activeParticipants: number | null;
    spectatorOnlyParticipants: number | null;
    maxVideoTilesPerPage: number | null;
  } | null;
  /** Only the features whose state is not `default`, for example `enabled` or `disabled`. */
  features: Record<string, string>;
  /** The breakout rooms, sorted by their API field `sort`, then by ID. */
  subrooms: { id: string; displayName: string | null }[];
  /** Only when the tool reads the passcode, else `null`. */
  passcode: string | null;
};

/** A breakout room in the output of the breakout room tools. */
export type BreakoutRoom = {
  id: string;
  /** The room ID of the call, in lowercase: the ID of the requests. */
  roomId: string;
  /** `null`: the alfaview client shows a numbered name, such as Group 1. */
  displayName: string | null;
};

// Mappers

/** Returns the features whose state is set and not `default`, in the order of FEATURE_KEYS. */
export function changedFeatures(features: ApiRoom['features']): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of FEATURE_KEYS) {
    const state = textOrNull(features?.[key]);
    if (state !== null && state !== 'default') result[key] = state;
  }
  return result;
}

/** Returns the RoomSummary output of a room list. Absent values are `null`. */
export function mapRoomSummary(room: ApiRoom): RoomSummary {
  return {
    id: room.id,
    displayName: textOrNull(room.displayName),
    type: textOrNull(room.type),
    parentId: textOrNull(room.parentId),
    waitingRoomEnabled: booleanOrNull(room.waitingRoomEnabled),
    passcodeRequired: booleanOrNull(room.passcodeRequired),
  };
}

/**
 * Returns the Room output. Every documented key is present. An absent value is `null`, except
 * absent features and breakout rooms, which give `{}` and `[]`. The permission arrays and the
 * default permissions are left out: they can hold thousands of entries.
 */
export function mapRoom(room: ApiRoom, timeZone: string, passcode: string | null = null): Room {
  const quotas = room.quotas;
  return {
    ...mapRoomSummary(room),
    waitingRoomWelcomeNote: textOrNull(room.waitingRoomWelcomeNote),
    managed: booleanOrNull(room.managed),
    createdAt: formatTimestamp(room.createdAt, timeZone),
    quotas:
      typeof quotas === 'object' && quotas !== null
        ? {
            activeParticipants: integerOrNull(quotas.activeParticipants),
            spectatorOnlyParticipants: integerOrNull(quotas.spectatorOnlyParticipants),
            maxVideoTilesPerPage: integerOrNull(quotas.maxVideoTilesPerPage),
          }
        : null,
    features: changedFeatures(room.features),
    subrooms: (Array.isArray(room.subrooms) ? room.subrooms : [])
      .filter((subroom) => typeof subroom?.id === 'string')
      .map((subroom) => ({
        id: subroom.id,
        displayName: textOrNull(subroom.displayName),
        sort: integerOrNull(subroom.sort),
      }))
      .sort(bySortOrder)
      .map(({ id, displayName }) => ({ id, displayName })),
    passcode,
  };
}

/**
 * Returns the BreakoutRoom output of a breakout room of the room `roomId`. `sort` is left out, as
 * in get_room: alfaview fills it with the time of the create.
 */
export function mapBreakoutRoom(roomId: string, subroom: ApiSubroom): BreakoutRoom {
  return {
    id: subroom.id,
    roomId: roomId.toLowerCase(),
    displayName: textOrNull(subroom.displayName),
  };
}

// Name match

/**
 * Returns the rooms for a name, in any case: rooms whose name equals it first, then rooms whose
 * name contains it, each group sorted by name. Without a name, every room sorted by name.
 */
export function findRoomsByName(
  rooms: readonly RoomSummary[],
  name: string | undefined,
): RoomSummary[] {
  return name === undefined ? [...rooms].sort(byRoomName) : roomsWithName(rooms, name);
}

// Welcome note

/**
 * A character that alfaview takes in a welcome note: a letter, a mark, a number, a punctuation
 * mark, a symbol or the plain space.
 */
const PRINTABLE = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]$/u;

/** The joiner of a combined emoji, which alfaview takes only between two characters. */
const ZERO_WIDTH_JOINER = '\u{200D}';

/**
 * Returns the problem of a waiting room welcome note that alfaview would refuse, as a sentence that
 * names the parameter `label`, or `undefined` for a note that alfaview takes. alfaview takes at
 * most WELCOME_NOTE_MAX_CHARACTERS code points, each PRINTABLE, and the zero width joiner only
 * inside the note and never twice in a row: no line break, no tab and no space other than U+0020.
 * It throws nothing, so the caller chooses its error. The tools check the note before any request,
 * because alfaview checks it only after it saved the room.
 */
export function welcomeNoteProblem(note: string, label: string): string | undefined {
  const characters = [...note];
  const last = characters.length - 1;
  const refused =
    characters.length > WELCOME_NOTE_MAX_CHARACTERS ||
    characters.some((character, index) =>
      character === ZERO_WIDTH_JOINER
        ? index === 0 || index === last || characters[index - 1] === ZERO_WIDTH_JOINER
        : !PRINTABLE.test(character),
    );
  return refused
    ? `${label} can have at most ${WELCOME_NOTE_MAX_CHARACTERS} characters on one line, with letters, digits, punctuation, symbols and plain spaces only.`
    : undefined;
}

// Feature changes

/**
 * Returns the body of a feature change: for each feature in the order of FEATURE_KEYS, its state
 * from `states`, else `default` when `reset` is true (resetFeatures of update_room_settings), else
 * no key. alfaview reads `default` as the removal of the room's own setting, as
 * `DELETE /v2/rooms/{id}/features` does for every feature, so a reset with new states is one
 * request. An empty body changes nothing.
 */
export function featureChange(states: FeatureChange | undefined, reset: boolean): FeatureChange {
  const change: FeatureChange = {};
  for (const key of FEATURE_KEYS) {
    const state = states?.[key] ?? (reset ? 'default' : undefined);
    if (state !== undefined) change[key] = state;
  }
  return change;
}

// Room types of the plan

/**
 * Returns the names of the plan's room types for a message, smallest room type first. The entry
 * with an empty name, which counts the rooms that fit no room type, is left out.
 */
export function roomTypeNames(types: readonly ApiRoomType[]): string[] {
  return [...types]
    .sort(byRoomTypeSize)
    .map((type) => type.name)
    .filter((name) => name.trim() !== '');
}

// Requests

/** Reads a room with `GET /v2/rooms/{id}`. With `allowNotFound`, a 404 gives `undefined`. */
export function getRoom(api: CallApi, roomId: string): Promise<ApiRoom>;
export function getRoom(
  api: CallApi,
  roomId: string,
  options: { allowNotFound: true },
): Promise<ApiRoom | undefined>;
export async function getRoom(
  api: CallApi,
  roomId: string,
  options: { allowNotFound?: boolean } = {},
): Promise<ApiRoom | undefined> {
  const { status, data } = await api.request<ApiRoom>({
    method: 'GET',
    path: roomPath(roomId),
    allowStatuses: options.allowNotFound === true ? [404] : [],
  });
  if (status === 404) return undefined;
  if (typeof data !== 'object' || data === null || typeof data.id !== 'string') {
    throw invalidResponse('alfaview did not return the room.');
  }
  return data;
}

/** Returns every room of one type, from all pages of `GET /v2/rooms`. */
export async function listRooms(api: CallApi, roomType: RoomType): Promise<ApiRoom[]> {
  const { items } = await fetchAllPages<ApiRoom>(api, '/v2/rooms', {
    query: { roomTypes: roomType },
    pageSize: ROOM_PAGE_SIZE,
  });
  return items;
}

/** Returns the room types of the company's plan from `GET /v2/room-types`, which has one page. */
export async function listRoomTypes(api: CallApi): Promise<ApiRoomType[]> {
  const { data } = await api.request<unknown>({ method: 'GET', path: '/v2/room-types' });
  const types = readRoomTypeList(data);
  if (types === undefined) throw invalidResponse(ROOM_TYPE_LIST_MESSAGE);
  return types;
}

/**
 * Returns the quotas of the room type `name` of the company's plan, with 0 video tiles per page.
 * The exact name wins over a match in any case. An unknown name throws an error with the names of
 * the plan's room types, which the model needs to choose one. They are company configuration, not
 * personal data, so the error names them also with Personal data set to Leave out.
 */
export async function planRoomTypeQuotas(api: CallApi, name: string): Promise<Quotas> {
  const types = await listRoomTypes(api);
  const type = findRoomType(types, name);
  if (type === undefined) {
    throw invalidInput(unknownPlanRoomTypeMessage(name, roomTypeNames(types)));
  }
  const quotas = roomTypeQuotas(type);
  if (quotas === undefined) throw invalidResponse(noRoomTypeLimitsMessage(type.name));
  return quotas;
}

/** The fields of a new room (spec: RoomCreate) that the server sends. */
export type RoomCreate = {
  displayName: string;
  type: RoomType;
  waitingRoomEnabled: boolean;
  waitingRoomWelcomeNote?: string;
  parentId?: string;
  passcodeRequired?: boolean;
  quotas?: Quotas;
};

/**
 * Creates a room with `POST /v2/rooms` and returns its ID. alfaview saves the room before its
 * waiting room options, and an error of that second step answers with its own status and without
 * the ID. So an answer that leaves the outcome open says that the room may exist (sendCreate), and
 * the message of a 403 does not say that no room exists. The parent ID goes in lowercase, the form
 * in which alfaview keys rooms.
 */
export async function createRoom(api: CallApi, room: RoomCreate): Promise<string> {
  let answer: ApiResponse<{ id?: unknown }>;
  try {
    answer = await sendCreate<{ id?: unknown }>(
      api,
      {
        method: 'POST',
        path: '/v2/rooms',
        body: compact({
          displayName: room.displayName,
          type: room.type,
          waitingRoomEnabled: room.waitingRoomEnabled,
          waitingRoomWelcomeNote: room.waitingRoomWelcomeNote,
          parentId: room.parentId?.toLowerCase(),
          passcodeRequired: room.passcodeRequired,
          quotas: room.quotas,
        }),
      },
      ROOM_UNCERTAIN_MESSAGE,
    );
  } catch (error) {
    // Only the 403 of the POST: a refused login (LoginRefused, also 403) keeps its message.
    if (error instanceof ToolError && error.code === 'Forbidden') {
      throw new ToolError('Forbidden', CREATE_ROOM_DENIED_MESSAGE, 403);
    }
    throw error;
  }
  const roomId = answer.data?.id;
  if (typeof roomId !== 'string' || roomId === '') {
    throw new ToolError('InvalidResponse', missingCreatedIdMessage('room'), answer.status);
  }
  return roomId;
}

/** The fields of a room that a change sets (spec: RoomUpdate). Only the given fields change. */
export type RoomChange = {
  displayName?: string;
  waitingRoomEnabled?: boolean;
  waitingRoomWelcomeNote?: string;
  passcodeRequired?: boolean;
};

/**
 * Changes the given fields of a room with `PATCH /v2/rooms/{id}`. It never sends `permissions`,
 * `subrooms` or `features`: alfaview replaces each of them as a whole with the value of the
 * request, so a partial value removes the rest. Its answer has no body.
 */
export async function updateRoom(api: CallApi, roomId: string, change: RoomChange): Promise<void> {
  await api.request({ method: 'PATCH', path: roomPath(roomId), body: change });
}

/**
 * Deletes a room with `DELETE /v2/rooms/{id}`. alfaview answers 204 also for a room that does not
 * exist, so the caller deletes only a room that it read. Its answer has no body.
 */
export async function deleteRoom(api: CallApi, roomId: string): Promise<void> {
  await api.request({ method: 'DELETE', path: roomPath(roomId) });
}

/**
 * Sets the feature states of featureChange with `PATCH /v2/rooms/{id}/features`. The features that
 * it does not name stay as they are, and alfaview saves the change as a whole. Its answer has no
 * body. No tool reads `GET /v2/rooms/{id}/features`, because `GET /v2/rooms/{id}` gives the same
 * features.
 */
export async function updateRoomFeatures(
  api: CallApi,
  roomId: string,
  change: FeatureChange,
): Promise<void> {
  await api.request({ method: 'PATCH', path: `${roomPath(roomId)}/features`, body: change });
}

function subroomsPath(roomId: string): string {
  return `${roomPath(roomId)}/subrooms`;
}

/** Returns the breakout rooms of a room from `GET /v2/rooms/{id}/subrooms`, which has one page. */
export async function listSubrooms(api: CallApi, roomId: string): Promise<ApiSubroom[]> {
  const { data } = await api.request<unknown>({ method: 'GET', path: subroomsPath(roomId) });
  const subrooms = readSubrooms(data);
  if (subrooms === undefined) throw invalidResponse(BREAKOUT_ROOM_LIST_MESSAGE);
  return subrooms;
}

/**
 * Creates a breakout room with `POST /v2/rooms/{id}/subrooms` and returns its ID. An answer that
 * leaves the outcome open says that the breakout room may exist (sendCreate). So does an answer
 * without an ID: alfaview can save the breakout room and still answer success with an empty ID.
 */
export async function createSubroom(
  api: CallApi,
  roomId: string,
  displayName: string | undefined,
): Promise<string> {
  const answer = await sendCreate<{ id?: unknown }>(
    api,
    { method: 'POST', path: subroomsPath(roomId), body: compact({ displayName }) },
    BREAKOUT_ROOM_UNCERTAIN_MESSAGE,
  );
  const id = answer.data?.id;
  if (typeof id !== 'string' || id === '') {
    throw new ToolError('InvalidResponse', BREAKOUT_ROOM_ID_MISSING_MESSAGE, answer.status);
  }
  return id;
}

/**
 * Renames a breakout room with `PATCH /v2/rooms/{id}/subrooms/{subroomId}`. The body always has
 * `displayName`: alfaview sets a missing name to the numbered one. Its answer has no body.
 */
export async function updateSubroom(
  api: CallApi,
  roomId: string,
  subroomId: string,
  displayName: string,
): Promise<void> {
  await api.request({
    method: 'PATCH',
    path: subroomPath(roomId, subroomId),
    body: { displayName },
  });
}

/**
 * Deletes a breakout room with `DELETE /v2/rooms/{id}/subrooms/{subroomId}`. alfaview answers 204
 * also for a breakout room that the room does not have, so the caller deletes only a listed one.
 */
export async function deleteSubroom(api: CallApi, roomId: string, subroomId: string): Promise<void> {
  await api.request({ method: 'DELETE', path: subroomPath(roomId, subroomId) });
}
