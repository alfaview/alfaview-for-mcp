// The room tools: find_rooms, get_room and regenerate_room_passcode, then create_room and
// update_room of the level `manage`, and delete_room of the level `full`.
import * as z from 'zod';
import { invalidInput, readAfterSavedWrite, refusedByAlfaview, ToolError } from '../alfaview/errors.ts';
import { readPasscode, regeneratePasscode } from '../domain/passcode.ts';
import {
  CONFIRM_ROOM_NAME_MISSING_MESSAGE,
  confirmRoomNameMessage,
  createRoom,
  deleteRoom,
  DEPARTMENT_DELETE_WARNING,
  DEPARTMENT_MESSAGE,
  DEPARTMENT_NAME_FIELD,
  findRoomsByName,
  getRoom,
  listRooms,
  mapRoom,
  mapRoomSummary,
  MEETING_ROOM_DELETE_MESSAGE,
  planRoomTypeQuotas,
  roomCreatedButNotReadMessage,
  ROOM_DELETE_NOT_FOUND_MESSAGE,
  roomDeleteQuestion,
  ROOM_NAME_FIELD,
  roomNameMismatchWarning,
  roomUpdatedButNotReadMessage,
  SAVED_BEFORE_WAITING_ROOM_SENTENCE,
  unnamedRoomMessage,
  updateRoom,
  welcomeNoteProblem,
  type Room,
  type RoomChange,
} from '../domain/rooms.ts';
import { textOrNull } from '../shared/outputValues.ts';
import { compact } from '../values/inputs.ts';
import { formatLocalTimestamp } from '../values/time.ts';
import { CONFIRMATION_OUTCOMES, confirmationNote, keptWarning } from './confirmation.ts';
import { LIST_PART, ROOM, ROOM_SUMMARY, toolOutput } from './outputs.ts';
import {
  CHANGE_ANNOTATIONS,
  count,
  CREATE_ANNOTATIONS,
  defineTool,
  IDEMPOTENT_CHANGE_ANNOTATIONS,
  idParameter,
  limitParameter,
  listPart,
  offsetParameter,
  READ_ANNOTATIONS,
  roomIdNotMeetingWith,
  roomIdParameter,
  showing,
  textParameter,
} from './tool.ts';

export const findRoomsTool = defineTool({
  name: 'find_rooms',
  level: 'read',
  title: 'Find rooms',
  description:
    "Lists the alfaview rooms that the API key's user can see, with the ID, waiting room and passcode setting of each. With name, exact matches come first, then names that contain it, in any case.",
  inputSchema: z.strictObject({
    name: textParameter('Part of the room name.', 256).optional(),
    type: z
      .enum(['room', 'department'])
      .default('room')
      .describe('department lists departments, which hold rooms and cannot be joined.'),
    limit: limitParameter('rooms', 50, 20),
    offset: offsetParameter(),
  }),
  annotations: READ_ANNOTATIONS,
  // alfaview lists rooms or departments here. Both take the room shape, so that with Leave out, a
  // meeting room among them loses its name, which is its meeting title.
  personalData: { shape: 'mcp.room', list: 'rooms' },
  output: toolOutput({ ...LIST_PART, rooms: z.array(ROOM_SUMMARY) }),
  async run(input, { api }) {
    const rooms = (await listRooms(api, input.type)).map(mapRoomSummary);
    const part = listPart(findRoomsByName(rooms, input.name), input.offset, input.limit);
    const noun = input.type === 'department' ? 'department' : 'room';
    const matching = input.name === undefined ? '' : ' whose name contains the given text';
    const found = part.totalMatches === 0 ? `no ${noun}s` : count(part.totalMatches, noun);
    return {
      summary: `Found ${found}${matching}.${showing(part)}`,
      data: {
        totalMatches: part.totalMatches,
        offset: part.offset,
        nextOffset: part.nextOffset,
        rooms: part.items,
      },
    };
  },
});

/** Returns `on` or `off` for a setting, or `unknown` when alfaview left the setting out. */
function setting(value: boolean | null, on: string, off: string): string {
  return value === null ? 'unknown' : value ? on : off;
}

export const getRoomTool = defineTool({
  name: 'get_room',
  level: 'read',
  title: 'Get a room',
  description:
    'Returns one alfaview room: its type, waiting room and welcome note, passcode setting, quotas, breakout rooms, and the features that differ from the default. The breakout rooms are in subrooms, because the API calls them subrooms.',
  descriptionWithoutPersonalData:
    'Returns one alfaview room: its type, waiting room, passcode setting, quotas, breakout rooms, and the features that differ from the default. The breakout rooms are in subrooms, because the API calls them subrooms. This server leaves out personal data: the welcome note is null, and so is the name of a meeting room, which is its meeting title.',
  inputSchema: z.strictObject({
    roomId: roomIdParameter,
    includePasscode: z
      .boolean()
      .default(false)
      .describe(
        'Also return the current passcode. It is a credential when passcodeRequired is true.',
      ),
  }),
  annotations: READ_ANNOTATIONS,
  // A meeting ID gives the room of the meeting, whose name is the meeting title.
  personalData: { shape: 'mcp.room' },
  output: toolOutput(ROOM.shape),
  async run(input, { api, timeZone }) {
    const apiRoom = await getRoom(api, input.roomId);
    const passcode = input.includePasscode ? await readPasscode(api, input.roomId) : null;
    const room = mapRoom(apiRoom, timeZone, passcode);
    const waitingRoom = setting(room.waitingRoomEnabled, 'on', 'off');
    const passcodeSetting = setting(room.passcodeRequired, 'required', 'not required');
    const passcodeSentence = !input.includePasscode
      ? ''
      : passcode === null
        ? ' The room has no passcode yet.'
        : ' The passcode is in the result.';
    return {
      summary: `Room ${room.id}: waiting room ${waitingRoom}, passcode ${passcodeSetting}.${passcodeSentence}`,
      data: room,
    };
  },
});

export const regenerateRoomPasscodeTool = defineTool({
  name: 'regenerate_room_passcode',
  level: 'standard',
  title: 'Regenerate a room passcode',
  description:
    'Makes a new passcode for an alfaview room and returns it. The old passcode stops working at once, also in sent invitations. This cannot be undone.',
  inputSchema: z.strictObject({ roomId: roomIdParameter }),
  annotations: CHANGE_ANNOTATIONS,
  personalData: { shape: 'mcp.passcode' },
  output: toolOutput({
    roomId: z.string(),
    passcode: z.string().nullable(),
    passcodeRequired: z.boolean().nullable(),
  }),
  readTool: 'get_room',
  async run(input, { api }) {
    const passcode = await regeneratePasscode(api, input.roomId);
    return {
      summary: `Made a new passcode for room ${passcode.roomId}. The old passcode no longer works.`,
      data: passcode,
    };
  },
});

/** The room tools, in the order of the tool list. */
export const ROOM_TOOLS = [findRoomsTool, getRoomTool, regenerateRoomPasscodeTool] as const;

// create_room and update_room

const ROOM_NAME_TEXT = 'The name of the room.';
const WAITING_ROOM_TEXT = 'If true, people wait until a moderator lets them in.';
const WELCOME_NOTE_TEXT = 'Shown to people in the waiting room: at most 300 characters on one line.';
const PASSCODE_REQUIRED_TEXT =
  'If true, everyone who joins must enter the room passcode, which alfaview makes when the room has none. get_room with includePasscode reads it.';

export const PARENT_ID_MESSAGE =
  'parentId takes a department ID from find_rooms with type department.';

const READ_PASSCODE_SENTENCE = ' Use get_room with includePasscode true to read the passcode.';

/** Refuses a welcome note that alfaview would refuse (welcomeNoteProblem), before any request. */
function checkWelcomeNote(note: string | undefined): void {
  if (note === undefined) return;
  const problem = welcomeNoteProblem(note, 'waitingRoomWelcomeNote');
  if (problem !== undefined) throw invalidInput(problem);
}

/**
 * Returns the error of a failed update_room. alfaview saves the room before its waiting room
 * options and can refuse the options after the save, so a refusal of a call that changes both says
 * that its other fields may be saved. A room that alfaview cannot find has nothing saved.
 */
function updateError(error: unknown, change: RoomChange): unknown {
  const waitingRoom =
    change.waitingRoomEnabled !== undefined || change.waitingRoomWelcomeNote !== undefined;
  const other = change.displayName !== undefined || change.passcodeRequired !== undefined;
  if (!waitingRoom || !other || !refusedByAlfaview(error) || error.status === 404) return error;
  return new ToolError(
    error.code,
    `${error.message} ${SAVED_BEFORE_WAITING_ROOM_SENTENCE}`,
    error.status,
    error.fieldLocations,
  );
}

/** Returns the summary text of the room settings, such as `waiting room on, passcode unknown`. */
function roomSettings(room: Room): string {
  const waitingRoom = setting(room.waitingRoomEnabled, 'on', 'off');
  return `waiting room ${waitingRoom}, passcode ${setting(room.passcodeRequired, 'required', 'not required')}`;
}

export const createRoomTool = defineTool({
  name: 'create_room',
  level: 'manage',
  title: 'Create a room',
  description:
    'Creates an alfaview room, or a department that holds rooms, and returns it. alfaview does not detect duplicate rooms: after an error, check with find_rooms before you create it again.',
  inputSchema: z.strictObject({
    displayName: textParameter(ROOM_NAME_TEXT),
    type: z
      .enum(['room', 'department'])
      .default('room')
      .describe('A department holds rooms and cannot be joined.'),
    parentId: idParameter(
      { parameter: 'parentId', source: 'find_rooms' },
      PARENT_ID_MESSAGE,
      'The department of the room: an ID from find_rooms with type department.',
    ).optional(),
    waitingRoomEnabled: z.boolean().default(false).describe(WAITING_ROOM_TEXT),
    // zod counts UTF-16 units and alfaview counts characters, so run checks the length.
    waitingRoomWelcomeNote: textParameter(WELCOME_NOTE_TEXT).optional(),
    passcodeRequired: z.boolean().describe(PASSCODE_REQUIRED_TEXT).optional(),
    planRoomType: textParameter(
      "A room type of the company's alfaview plan, by name, for its participant limits.",
      256,
    ).optional(),
  }),
  annotations: CREATE_ANNOTATIONS,
  personalData: { shape: 'mcp.room' },
  output: toolOutput(ROOM.shape),
  readTool: 'get_room',
  async run(input, { api, timeZone, confirmation }) {
    checkWelcomeNote(input.waitingRoomWelcomeNote);
    // alfaview refuses only the waiting room of a department, and ignores its passcode and quotas
    // without an error, so the model would report settings that the department does not have.
    const department = input.type === 'department';
    const roomOnly = [input.waitingRoomWelcomeNote, input.passcodeRequired, input.planRoomType];
    if (department && (input.waitingRoomEnabled || roomOnly.some((value) => value !== undefined))) {
      throw invalidInput(DEPARTMENT_MESSAGE);
    }

    const quotas =
      input.planRoomType === undefined ? undefined : await planRoomTypeQuotas(api, input.planRoomType);
    // Room names are not unique, so the question before a delete names a room of the same name that
    // this server made. The note comes before the create and stays after an error: alfaview can
    // save the room and answer an error without its ID.
    const noteRoom = confirmation.renames.noteName(input.displayName);
    const roomId = await createRoom(api, {
      displayName: input.displayName,
      type: input.type,
      waitingRoomEnabled: input.waitingRoomEnabled,
      waitingRoomWelcomeNote: input.waitingRoomWelcomeNote,
      parentId: input.parentId,
      passcodeRequired: input.passcodeRequired,
      quotas,
    });
    noteRoom(roomId);

    // The room exists, whatever the error: the read back must never ask for a second create.
    const room = mapRoom(
      await readAfterSavedWrite(() => getRoom(api, roomId), roomCreatedButNotReadMessage(roomId)),
      timeZone,
      null,
    );
    if (department) return { summary: `Created department ${room.id}.`, data: room };
    const passcode = room.passcodeRequired === true ? READ_PASSCODE_SENTENCE : '';
    return { summary: `Created room ${room.id}: ${roomSettings(room)}.${passcode}`, data: room };
  },
});

export const updateRoomTool = defineTool({
  name: 'update_room',
  level: 'manage',
  title: 'Update a room',
  description:
    'Changes the name, waiting room, welcome note or passcode setting of an alfaview room.',
  inputSchema: z.strictObject({
    roomId: roomIdParameter,
    displayName: textParameter(ROOM_NAME_TEXT).optional(),
    waitingRoomEnabled: z.boolean().describe(WAITING_ROOM_TEXT).optional(),
    waitingRoomWelcomeNote: textParameter(WELCOME_NOTE_TEXT).optional(),
    passcodeRequired: z.boolean().describe(PASSCODE_REQUIRED_TEXT).optional(),
  }),
  annotations: IDEMPOTENT_CHANGE_ANNOTATIONS,
  // A meeting ID changes the room of the meeting, whose name is the meeting title.
  personalData: { shape: 'mcp.room' },
  output: toolOutput(ROOM.shape),
  readTool: 'get_room',
  async run(input, { api, timeZone, confirmation }) {
    const change = compact({
      displayName: input.displayName,
      waitingRoomEnabled: input.waitingRoomEnabled,
      waitingRoomWelcomeNote: input.waitingRoomWelcomeNote,
      passcodeRequired: input.passcodeRequired,
    });
    if (Object.keys(change).length === 0) {
      throw invalidInput('Give at least one field to change.');
    }
    // alfaview saves the room before the waiting room options, so a refused note would leave a
    // new name saved.
    checkWelcomeNote(input.waitingRoomWelcomeNote);
    // The question before a delete names a rename by this server. The note comes before the
    // request, so a delete that reads the new name before alfaview's answer arrives still names the
    // rename. Every error keeps the note: a refusal can come after the save of the name. The name
    // is noted too, for the question before the delete of another room of the same name.
    if (input.displayName !== undefined) {
      confirmation.renames.noteRename(input.roomId);
      confirmation.renames.noteName(input.displayName, input.roomId);
    }
    try {
      await updateRoom(api, input.roomId, change);
    } catch (error) {
      throw updateError(error, change);
    }

    // The change is saved: a failed read back must not read as a failed change.
    const roomId = input.roomId.toLowerCase();
    const room = mapRoom(
      await readAfterSavedWrite(() => getRoom(api, roomId), roomUpdatedButNotReadMessage(roomId)),
      timeZone,
      null,
    );
    const passcode = input.passcodeRequired === true ? READ_PASSCODE_SENTENCE : '';
    return { summary: `Updated room ${room.id}: ${roomSettings(room)}.${passcode}`, data: room };
  },
});

/**
 * The room tools of the level `manage`. The tool list shows them after the tools of `standard`, so
 * they are not in ROOM_TOOLS.
 */
export const ROOM_ADMIN_TOOLS = [createRoomTool, updateRoomTool] as const;

// delete_room

/** The text of confirmRoomName, the fallback for a client that cannot ask the person. */
export const CONFIRM_ROOM_NAME_TEXT =
  'Only for a client that cannot ask the person: the room name, as the person named it (any case).';

export const deleteRoomTool = defineTool({
  name: 'delete_room',
  level: 'full',
  title: 'Delete a room',
  description:
    'Cannot be undone: deletes an alfaview room or department. alfaview disconnects everyone in it and deletes its breakout rooms, guest links, group links, files and polls. The server asks the person to confirm. Meeting rooms are refused: use cancel_meeting.',
  inputSchema: z.strictObject({
    roomId: roomIdNotMeetingWith('Room or department ID from find_rooms.'),
    confirmRoomName: textParameter(CONFIRM_ROOM_NAME_TEXT, 256).optional(),
  }),
  annotations: IDEMPOTENT_CHANGE_ANNOTATIONS,
  // The result holds no name. A meeting room, whose name is the meeting title, is refused, so the
  // question names no meeting title either.
  personalData: { shape: 'mcp.room' },
  output: toolOutput({
    roomId: z.string(),
    type: z.string().nullable(),
    deleted: z.boolean(),
    confirmation: z.enum(CONFIRMATION_OUTCOMES),
  }),
  readTool: 'find_rooms',
  async run(input, { api, confirmation, timeZone }) {
    // A round after a question must carry the confirmation state of this room, which works once.
    confirmation.claim(input.roomId);
    // alfaview answers 204 also for a room that does not exist, so only the read tells a deleted
    // room from a wrong ID. Each round reads the room again, so a new name counts.
    const room = await getRoom(api, input.roomId, { allowNotFound: true });
    if (room === undefined) throw new ToolError('NotFound', ROOM_DELETE_NOT_FOUND_MESSAGE, 404);
    // alfaview refuses it with 422 and an empty detail. cancel_meeting ends a meeting instead.
    if (room.type === 'meeting') {
      throw new ToolError('MeetingRoomRefused', MEETING_ROOM_DELETE_MESSAGE);
    }
    // The messages never name the expected name. A room without a name would expect its ID, which
    // the call already has and which so confirms nothing.
    const name = typeof room.displayName === 'string' ? room.displayName.trim() : '';
    if (name === '') throw new ToolError('ConfirmationMismatch', unnamedRoomMessage(room.id));

    const department = room.type === 'department';
    const local = (at: number | undefined) =>
      at === undefined ? null : formatLocalTimestamp(new Date(at).toISOString(), timeZone);
    const decision = confirmation.decide({
      id: input.roomId,
      message: roomDeleteQuestion(
        { id: room.id, name, department, createdAt: formatLocalTimestamp(room.createdAt, timeZone) },
        {
          renamedAt: local(confirmation.renames.renamedAt(input.roomId)),
          sameNameAt: local(confirmation.renames.sameNameAt(name, input.roomId)),
        },
      ),
      field: department ? DEPARTMENT_NAME_FIELD : ROOM_NAME_FIELD,
      matches: (value) => value.trim().toLowerCase() === name.toLowerCase(),
      fallback: {
        value: input.confirmRoomName,
        missingMessage: CONFIRM_ROOM_NAME_MISSING_MESSAGE,
        mismatchMessage: confirmRoomNameMessage(room.id),
      },
    });
    if (decision.kind === 'ask') return decision.ask;

    const noun = department ? 'department' : 'room';
    const data = { roomId: room.id, type: textOrNull(room.type) };
    if (decision.kind === 'keep') {
      return {
        summary: `Did not delete ${noun} ${room.id}.`,
        warnings: [keptWarning(decision.confirmation, roomNameMismatchWarning(department))],
        note: confirmationNote(decision.confirmation),
        data: { ...data, deleted: false, confirmation: decision.confirmation },
      };
    }
    await deleteRoom(api, input.roomId);
    return {
      summary: `Deleted ${noun} ${room.id} for good.`,
      warnings: department ? [DEPARTMENT_DELETE_WARNING] : [],
      note: confirmationNote(decision.confirmation),
      data: { ...data, deleted: true, confirmation: decision.confirmation },
    };
  },
});

/**
 * The room tools of the level `full`. The tool list shows the tools of `full` last, so these are
 * not in ROOM_TOOLS.
 */
export const FULL_ROOM_TOOLS = [deleteRoomTool] as const;
