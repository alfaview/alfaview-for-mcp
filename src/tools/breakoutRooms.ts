// The breakout room tools of the level `manage` (the API calls a breakout room a subroom). None of
// them emails anyone. alfaview counts a name in bytes and zod counts UTF-16 units, so each tool
// that takes a name checks the bytes before any request.
import * as z from 'zod';
import type { CallApi } from '../alfaview/client.ts';
import { invalidInput, ToolError } from '../alfaview/errors.ts';
import {
  BREAKOUT_ROOM_NOT_LISTED_WARNING,
  breakoutRoomNotFoundMessage,
  createSubroom,
  deleteSubroom,
  listSubrooms,
  mapBreakoutRoom,
  updateSubroom,
  type ApiSubroom,
} from '../domain/rooms.ts';
import {
  findSubroom,
  SUBROOM_NAME_MAX_BYTES,
  subroomNameTooLongMessage,
  utf8ByteLength,
} from '../shared/rooms.ts';
import { BREAKOUT_ROOM, toolOutput } from './outputs.ts';
import {
  count,
  CREATE_ANNOTATIONS,
  defineTool,
  IDEMPOTENT_CHANGE_ANNOTATIONS,
  roomIdParameter,
  subroomIdParameter,
  textParameter,
} from './tool.ts';

/** The text of displayName: alfaview counts the name in bytes. */
const NAME_TEXT = 'At most 32 bytes: 32 letters without accents, fewer with accents or emoji.';

/**
 * The sentence after a 422 of the create: alfaview answers 422 for the 51st breakout room of a
 * room. The description does not name the limit, so the model reads it only when it meets the
 * error. The run checks the bytes of the name, the other cause of a 422, before the request.
 */
export const BREAKOUT_ROOM_LIMIT_HINT =
  'A room has at most 50 breakout rooms: get_room lists them, and delete_breakout_room removes one.';

/** Runs the create, and adds BREAKOUT_ROOM_LIMIT_HINT to the message of a 422. */
async function withLimitHint<T>(create: () => Promise<T>): Promise<T> {
  try {
    return await create();
  } catch (error) {
    if (!(error instanceof ToolError) || error.status !== 422) throw error;
    throw new ToolError(
      error.code,
      `${error.message} ${BREAKOUT_ROOM_LIMIT_HINT}`,
      error.status,
      error.fieldLocations,
    );
  }
}

/** Refuses a name of more than SUBROOM_NAME_MAX_BYTES bytes in UTF-8, which alfaview refuses. */
function checkName(displayName: string | undefined): void {
  if (displayName !== undefined && utf8ByteLength(displayName) > SUBROOM_NAME_MAX_BYTES) {
    throw invalidInput(subroomNameTooLongMessage('displayName'));
  }
}

/**
 * Returns the breakout rooms of the room after a create, or `undefined` when the list fails. The
 * breakout room exists, so the call must not fail: a failed call would make the model create it
 * again.
 */
async function listAfterCreate(api: CallApi, roomId: string): Promise<ApiSubroom[] | undefined> {
  try {
    return await listSubrooms(api, roomId);
  } catch (error) {
    if (error instanceof ToolError) return undefined;
    throw error;
  }
}

export const createBreakoutRoomTool = defineTool({
  name: 'create_breakout_room',
  level: 'manage',
  title: 'Create a breakout room',
  description:
    'Adds a breakout room to an alfaview room and returns its ID. Without displayName, alfaview shows a numbered name, such as Group 1. get_room lists the breakout rooms.',
  inputSchema: z.strictObject({
    roomId: roomIdParameter,
    // zod counts UTF-16 units, so run checks the bytes.
    displayName: textParameter(NAME_TEXT, SUBROOM_NAME_MAX_BYTES).optional(),
  }),
  annotations: CREATE_ANNOTATIONS,
  personalData: { shape: 'mcp.breakoutRoom' },
  // breakoutRoomCount is null, with a warning, when alfaview did not list the new breakout room.
  output: toolOutput({ ...BREAKOUT_ROOM, breakoutRoomCount: z.int().nullable() }),
  readTool: 'get_room',
  async run(input, { api }) {
    checkName(input.displayName);
    const roomId = input.roomId.toLowerCase();
    const id = await withLimitHint(() => createSubroom(api, roomId, input.displayName));

    const subrooms = await listAfterCreate(api, roomId);
    const subroom = subrooms === undefined ? undefined : findSubroom(subrooms, id);
    if (subrooms === undefined || subroom === undefined) {
      const room = mapBreakoutRoom(roomId, { id, displayName: input.displayName });
      return {
        summary: `Created breakout room ${room.id} in room ${roomId}.`,
        warnings: [BREAKOUT_ROOM_NOT_LISTED_WARNING],
        data: { ...room, breakoutRoomCount: null },
      };
    }
    const room = mapBreakoutRoom(roomId, subroom);
    const breakoutRooms = count(subrooms.length, 'breakout room');
    return {
      summary: `Created breakout room ${room.id} in room ${roomId}. The room has ${breakoutRooms}.`,
      data: { ...room, breakoutRoomCount: subrooms.length },
    };
  },
});

export const updateBreakoutRoomTool = defineTool({
  name: 'update_breakout_room',
  level: 'manage',
  title: 'Rename a breakout room',
  description:
    'Renames a breakout room of an alfaview room.',
  inputSchema: z.strictObject({
    roomId: roomIdParameter,
    subroomId: subroomIdParameter,
    // Required: an update without a name in the body gives the breakout room a numbered name.
    displayName: textParameter(NAME_TEXT, SUBROOM_NAME_MAX_BYTES),
  }),
  annotations: IDEMPOTENT_CHANGE_ANNOTATIONS,
  personalData: { shape: 'mcp.breakoutRoom' },
  output: toolOutput(BREAKOUT_ROOM),
  readTool: 'get_room',
  async run(input, { api }) {
    checkName(input.displayName);
    const roomId = input.roomId.toLowerCase();
    const subroomId = input.subroomId.toLowerCase();
    await updateSubroom(api, roomId, subroomId, input.displayName);

    // The rename is safe to repeat, so an error of the list ends the call.
    const subroom = findSubroom(await listSubrooms(api, roomId), subroomId);
    const room = mapBreakoutRoom(roomId, subroom ?? { id: subroomId, displayName: input.displayName });
    return { summary: `Renamed breakout room ${room.id} of room ${roomId}.`, data: room };
  },
});

export const deleteBreakoutRoomTool = defineTool({
  name: 'delete_breakout_room',
  level: 'manage',
  title: 'Delete a breakout room',
  description:
    'Deletes a breakout room of an alfaview room. create_breakout_room can make it again, with a new ID.',
  inputSchema: z.strictObject({ roomId: roomIdParameter, subroomId: subroomIdParameter }),
  annotations: IDEMPOTENT_CHANGE_ANNOTATIONS,
  // The result holds IDs only.
  personalData: { shape: 'mcp.breakoutRoom' },
  output: toolOutput({ subroomId: z.string(), roomId: z.string(), deleted: z.boolean() }),
  readTool: 'get_room',
  async run(input, { api }) {
    const roomId = input.roomId.toLowerCase();
    const subroomId = input.subroomId.toLowerCase();
    // alfaview answers the delete of a breakout room that the room does not have with 204, so the
    // tool deletes only a listed one, and a repeat finds nothing.
    const subroom = findSubroom(await listSubrooms(api, roomId), subroomId);
    if (subroom === undefined) {
      throw new ToolError('NotFound', breakoutRoomNotFoundMessage(subroomId, roomId), 404);
    }
    await deleteSubroom(api, roomId, subroom.id);
    return {
      summary: `Deleted breakout room ${subroom.id} of room ${roomId}.`,
      data: { subroomId: subroom.id, roomId, deleted: true },
    };
  },
});

/** The breakout room tools, in the order of the tool list. */
export const BREAKOUT_ROOM_TOOLS = [
  createBreakoutRoomTool,
  updateBreakoutRoomTool,
  deleteBreakoutRoomTool,
] as const;
