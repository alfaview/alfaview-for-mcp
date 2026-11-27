// create_breakout_room, update_breakout_room and delete_breakout_room through an MCP SDK client.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ApiRequest, ApiResponse, CallApi } from '../../src/alfaview/client.ts';
import {
  BREAKOUT_ROOM_ID_MISSING_MESSAGE,
  BREAKOUT_ROOM_LIST_MESSAGE,
  BREAKOUT_ROOM_NOT_LISTED_WARNING,
  BREAKOUT_ROOM_UNCERTAIN_MESSAGE,
  breakoutRoomNotFoundMessage,
} from '../../src/domain/rooms.ts';
import { createLogger } from '../../src/log.ts';
import {
  BREAKOUT_ROOM_LIMIT_HINT,
  BREAKOUT_ROOM_TOOLS,
  createBreakoutRoomTool,
  deleteBreakoutRoomTool,
  updateBreakoutRoomTool,
} from '../../src/tools/breakoutRooms.ts';
import {
  CREATE_ANNOTATIONS,
  IDEMPOTENT_CHANGE_ANNOTATIONS,
  SUBROOM_ID_MESSAGE,
  type ToolContext,
} from '../../src/tools/tool.ts';
import {
  loginRequest,
  testApi,
  toolErrorOf,
  untilRequests,
  type ExpectedRequest,
  type FakeAnswer,
} from '../helpers/fakeFetch.ts';
import { fixture } from '../helpers/fixtures.ts';
import { toolHarness, type HarnessOptions } from '../helpers/mcpClient.ts';
import { keepApiRequestProblems, testFileLine } from '../helpers/spec.ts';
import { noQuestions, outputOf } from '../helpers/toolContext.ts';

const ROOM_ID = '0b7c5d2e-91a4-5f3b-8e27-0f4a6c9d1e22';
/** Breakout 1 of rooms/subrooms.json. */
const SUBROOM_ID = '2d4f6a8c-1e3b-5d7f-9a0c-2e4f6a8c0e11';
/** Breakout 2 of rooms/subrooms.json, the new breakout room of the create. */
const NEW_ID = '4e5f6a7b-8c9d-5e0f-9a1b-2c3d4e5f6a7b';
/** The meeting of test/fixtures/meetings/meeting.json: version 5, kind 34 (hex 22) in byte 10. */
const MEETING_ID = '7e9a1c3d-5b2f-5a4e-8c6d-22f0a1b2c3d4';
const SUBROOMS_PATH = `/v2/rooms/${ROOM_ID}/subrooms`;
const SUBROOM_PATH = `${SUBROOMS_PATH}/${SUBROOM_ID}`;
const BAD_IDS = ['Advisory Room', '.', '..', '0b7c5d2e-91a4-5f3b-0f4a6c9d1e22'];

const ROOM_ID_MESSAGE = 'roomId takes an ID from find_rooms, or a meeting ID, not a name.';
const NAME_MESSAGE = 'displayName can have at most 32 bytes (32 letters without accents).';
const ROOM_NOT_FOUND =
  "alfaview could not find the room. It was deleted, or the API key's user cannot see it.";
const BREAKOUT_ROOM_NOT_FOUND =
  "alfaview could not find the breakout room. It was deleted, or the API key's user cannot see it.";
const INVALID_NAME: FakeAnswer = {
  status: 422,
  body: { title: 'Unprocessable Entity', status: 422, detail: 'subroom name too long' },
};

type Json = Record<string, unknown>;

const ok = (body: unknown): FakeAnswer => ({ status: 200, body });
const NO_CONTENT: FakeAnswer = { status: 204 };
const problem = (status: number, file: string): FakeAnswer => ({
  status,
  body: fixture(`core/${file}`),
});

const subrooms = () => fixture<Json[]>('rooms/subrooms.json');

function create(body: Json, respond: FakeAnswer = { status: 201, body: { id: NEW_ID } }): ExpectedRequest {
  return { method: 'POST', path: SUBROOMS_PATH, body, respond };
}

function list(respond: FakeAnswer = ok(subrooms()), token?: string): ExpectedRequest {
  return { method: 'GET', path: SUBROOMS_PATH, respond, ...(token === undefined ? {} : { token }) };
}

function rename(displayName: string, respond: FakeAnswer = NO_CONTENT): ExpectedRequest {
  return { method: 'PATCH', path: SUBROOM_PATH, body: { displayName }, respond };
}

function remove(respond: FakeAnswer = NO_CONTENT): ExpectedRequest {
  return { method: 'DELETE', path: SUBROOM_PATH, respond };
}

function harness(expected: readonly ExpectedRequest[], options: HarnessOptions = {}) {
  return toolHarness(BREAKOUT_ROOM_TOOLS, expected, options);
}

/** The context of a run without the wrapper, for a cancel and for a call API of the test. */
function context(api: CallApi, signal: AbortSignal): ToolContext {
  return {
    api,
    now: Date.parse('2026-10-07T08:00:00Z'),
    timeZone: 'Europe/Berlin',
    signal,
    log: createLogger(() => undefined),
    personalData: 'include',
    level: 'manage',
    confirmation: noQuestions(),
  };
}

describe('the breakout room tools', () => {
  it('are listed in their fixed order, with their titles and annotations, at the level manage', async () => {
    const tools = await harness([]);
    const { tools: listed } = await tools.client.listTools();
    await tools.done();

    assert.deepEqual(
      listed.map((tool) => [tool.name, tool.title, tool.annotations]),
      [
        ['create_breakout_room', 'Create a breakout room', CREATE_ANNOTATIONS],
        ['update_breakout_room', 'Rename a breakout room', IDEMPOTENT_CHANGE_ANNOTATIONS],
        ['delete_breakout_room', 'Delete a breakout room', IDEMPOTENT_CHANGE_ANNOTATIONS],
      ],
    );
    assert.deepEqual(
      BREAKOUT_ROOM_TOOLS.map((tool) => tool.level),
      ['manage', 'manage', 'manage'],
    );
  });

  it('give their descriptions and parameter descriptions', async () => {
    const tools = await harness([]);
    const { tools: listed } = await tools.client.listTools();
    await tools.done();

    assert.deepEqual(
      listed.map((tool) => tool.description),
      [
        'Adds a breakout room to an alfaview room and returns its ID. Without displayName, alfaview shows a numbered name, such as Group 1. get_room lists the breakout rooms.',
        'Renames a breakout room of an alfaview room.',
        'Deletes a breakout room of an alfaview room. create_breakout_room can make it again, with a new ID.',
      ],
    );
    const properties = (name: string) =>
      listed.find((tool) => tool.name === name)!.inputSchema.properties as Record<
        string,
        { description: string }
      >;
    for (const name of ['create_breakout_room', 'update_breakout_room']) {
      assert.equal(
        properties(name).displayName!.description,
        'At most 32 bytes: 32 letters without accents, fewer with accents or emoji.',
      );
    }
    for (const name of ['update_breakout_room', 'delete_breakout_room']) {
      assert.equal(
        properties(name).subroomId!.description,
        'Breakout room ID from get_room or create_breakout_room.',
      );
    }
  });

  it('refuse a room name, dot segments and a broken UUID in each ID without a request', async () => {
    const tools = await harness([]);
    const results: [string, string][] = [];
    for (const roomId of BAD_IDS) {
      for (const [name, args] of [
        ['create_breakout_room', { roomId }],
        ['update_breakout_room', { roomId, subroomId: SUBROOM_ID, displayName: 'Beratung' }],
        ['delete_breakout_room', { roomId, subroomId: SUBROOM_ID }],
      ] as const) {
        results.push([(await tools.call(name, args)).summary, ROOM_ID_MESSAGE]);
      }
    }
    for (const subroomId of BAD_IDS) {
      for (const [name, args] of [
        ['update_breakout_room', { roomId: ROOM_ID, subroomId, displayName: 'Beratung' }],
        ['delete_breakout_room', { roomId: ROOM_ID, subroomId }],
      ] as const) {
        results.push([(await tools.call(name, args)).summary, SUBROOM_ID_MESSAGE]);
      }
    }
    await tools.done();

    for (const [summary, message] of results) assert.ok(summary.includes(message), summary);
    assert.equal(
      SUBROOM_ID_MESSAGE,
      'subroomId takes a breakout room ID from get_room or create_breakout_room.',
    );
    const upper = { roomId: ROOM_ID.toUpperCase(), subroomId: SUBROOM_ID.toUpperCase() };
    assert.ok(updateBreakoutRoomTool.inputSchema.safeParse({ ...upper, displayName: 'Beratung' }).success);
    assert.ok(deleteBreakoutRoomTool.inputSchema.safeParse(upper).success);
  });

  it('accept a meeting room, unlike the group link writes: the meeting does not depend on its breakout rooms', async () => {
    const path = `/v2/rooms/${MEETING_ID}/subrooms`;
    const listed = ok([{ id: SUBROOM_ID, sort: 1, displayName: 'Beratung' }, { id: NEW_ID, sort: 2 }]);
    const tools = await harness([
      loginRequest(),
      { method: 'POST', path, body: {}, respond: { status: 201, body: { id: NEW_ID } } },
      { method: 'GET', path, respond: listed },
      {
        method: 'PATCH',
        path: `${path}/${SUBROOM_ID}`,
        body: { displayName: 'Beratung' },
        respond: NO_CONTENT,
      },
      { method: 'GET', path, respond: listed },
      { method: 'GET', path, respond: listed },
      { method: 'DELETE', path: `${path}/${SUBROOM_ID}`, respond: NO_CONTENT },
    ]);
    const { tools: listedTools } = await tools.client.listTools();
    const created = await tools.call('create_breakout_room', { roomId: MEETING_ID });
    const renamed = await tools.call('update_breakout_room', {
      roomId: MEETING_ID,
      subroomId: SUBROOM_ID,
      displayName: 'Beratung',
    });
    const deleted = await tools.call('delete_breakout_room', {
      roomId: MEETING_ID,
      subroomId: SUBROOM_ID,
    });
    await tools.done();

    for (const tool of listedTools) {
      const properties = tool.inputSchema.properties as Record<string, { description: string }>;
      assert.equal(properties.roomId!.description, 'Room ID from find_rooms.', tool.name);
    }
    for (const result of [created, renamed, deleted]) {
      assert.equal(result.isError, false, result.summary);
      assert.equal(result.data.roomId, MEETING_ID);
    }
    assert.equal(created.data.breakoutRoomCount, 2);
    assert.equal(deleted.data.deleted, true);
  });
});

describe('create_breakout_room', () => {
  it('creates the breakout room with the trimmed name, then reads it and counts the breakout rooms', async () => {
    const third = { id: '6a7b8c9d-0e1f-5a2b-8c3d-4e5f6a7b8c9d', sort: 3, displayName: '' };
    const tools = await harness([
      loginRequest(),
      create({ displayName: 'Breakout 2' }),
      list(ok([...subrooms(), third])),
    ]);
    const result = await tools.call('create_breakout_room', {
      roomId: ROOM_ID.toUpperCase(),
      displayName: ' Breakout 2 ',
    });
    await tools.done();

    assert.equal(
      result.summary,
      `Created breakout room ${NEW_ID} in room ${ROOM_ID}. The room has 3 breakout rooms.`,
    );
    assert.deepEqual(result.data, {
      id: NEW_ID,
      roomId: ROOM_ID,
      displayName: 'Breakout 2',
      breakoutRoomCount: 3,
      warnings: [],
    });
  });

  it('sends an empty body without displayName, and gives null for the numbered name', async () => {
    const tools = await harness([loginRequest(), create({}), list(ok([{ id: NEW_ID, sort: 7 }]))]);
    const result = await tools.call('create_breakout_room', { roomId: ROOM_ID });
    await tools.done();

    assert.equal(
      result.summary,
      `Created breakout room ${NEW_ID} in room ${ROOM_ID}. The room has 1 breakout room.`,
    );
    assert.deepEqual(result.data, {
      id: NEW_ID,
      roomId: ROOM_ID,
      displayName: null,
      breakoutRoomCount: 1,
      warnings: [],
    });
  });

  it('takes a name of 32 letters, and refuses more than 32 bytes before any request and 33 characters in the SDK', async () => {
    const name = 'a'.repeat(32);
    const tools = await harness([
      loginRequest(),
      create({ displayName: name }),
      list(ok([{ id: NEW_ID, sort: 1, displayName: name }])),
    ]);
    const passed = await tools.call('create_breakout_room', { roomId: ROOM_ID, displayName: name });
    const umlauts = await tools.call('create_breakout_room', { roomId: ROOM_ID, displayName: 'ä'.repeat(17) });
    const emoji = await tools.call('create_breakout_room', {
      roomId: ROOM_ID,
      displayName: `${'\u{1F600}'.repeat(8)}a`,
    });
    const long = await tools.call('create_breakout_room', { roomId: ROOM_ID, displayName: 'a'.repeat(33) });
    const spaces = await tools.call('create_breakout_room', { roomId: ROOM_ID, displayName: '   ' });
    await tools.done();

    assert.equal(passed.data.displayName, name);
    assert.deepEqual([umlauts.isError, umlauts.summary], [true, NAME_MESSAGE]);
    assert.deepEqual([emoji.isError, emoji.summary], [true, NAME_MESSAGE]);
    assert.match(tools.logLines[2]!, /tool create_breakout_room: InvalidInput, 0 requests, /);
    assert.equal(long.isError, true);
    assert.match(long.summary, /displayName/);
    assert.notEqual(long.summary, NAME_MESSAGE);
    assert.equal(spaces.isError, true);
  });

  for (const status of [500, 502, 503, 504]) {
    it(`says that the breakout room may exist after HTTP ${status}, without a list`, async () => {
      const tools = await harness([
        loginRequest(),
        create({ displayName: 'Breakout 2' }, problem(status, 'problem-500.json')),
      ]);
      const result = await tools.call('create_breakout_room', { roomId: ROOM_ID, displayName: 'Breakout 2' });
      await tools.done();

      assert.deepEqual([result.isError, result.summary], [true, BREAKOUT_ROOM_UNCERTAIN_MESSAGE]);
      assert.match(tools.logLines.at(-1)!, /: ServerError, 2 requests/);
    });
  }

  it('says that the breakout room may exist after a timeout or a network error', async () => {
    const tools = await harness(
      [
        loginRequest(),
        create({}, { hang: true }),
        create({}, { networkError: 'ECONNRESET' }),
      ],
      { timeoutMs: 20 },
    );
    const timeout = await tools.call('create_breakout_room', { roomId: ROOM_ID });
    const network = await tools.call('create_breakout_room', { roomId: ROOM_ID });
    await tools.done();

    assert.equal(timeout.summary, BREAKOUT_ROOM_UNCERTAIN_MESSAGE);
    assert.equal(network.summary, BREAKOUT_ROOM_UNCERTAIN_MESSAGE);
    assert.match(tools.logLines[1]!, /: Timeout, /);
    assert.match(tools.logLines[2]!, /: NetworkError, /);
    assert.equal(
      BREAKOUT_ROOM_UNCERTAIN_MESSAGE,
      'alfaview may have created the breakout room before the error. Check with get_room before you create it again: a second create makes a second breakout room.',
    );
  });

  it('says that the breakout room may exist after a cancel', async () => {
    const controller = new AbortController();
    const { api, fake } = testApi([loginRequest(), create({}, { hang: true })], {
      signal: controller.signal,
    });
    const run = createBreakoutRoomTool.run({ roomId: ROOM_ID }, context(api, controller.signal));
    await untilRequests(fake, 2);
    controller.abort();
    const error = await toolErrorOf(run);
    fake.assertDone();

    assert.deepEqual([error.code, error.message], ['Canceled', BREAKOUT_ROOM_UNCERTAIN_MESSAGE]);
  });

  it('says that the breakout room may exist after an answer without an ID, without a list', async () => {
    const tools = await harness([
      loginRequest(),
      create({}, { status: 201, body: { id: '' } }),
      create({}, { status: 201, body: {} }),
    ]);
    const empty = await tools.call('create_breakout_room', { roomId: ROOM_ID });
    const missing = await tools.call('create_breakout_room', { roomId: ROOM_ID });
    await tools.done();

    assert.equal(empty.summary, BREAKOUT_ROOM_ID_MISSING_MESSAGE);
    assert.equal(missing.summary, BREAKOUT_ROOM_ID_MISSING_MESSAGE);
    assert.match(tools.logLines[1]!, /: InvalidResponse, 2 requests/);
    assert.match(tools.logLines[2]!, /: InvalidResponse, 1 request/);
    assert.equal(
      BREAKOUT_ROOM_ID_MISSING_MESSAGE,
      'alfaview did not return the ID of the new breakout room, but may have created it. Check with get_room before you create it again: a second create makes a second breakout room.',
    );
  });

  it('gives the texts of a room that alfaview cannot find, a missing permission and the 51st breakout room', async () => {
    const tools = await harness([
      loginRequest(),
      create({}, problem(404, 'problem-404.json')),
      create({}, problem(403, 'problem-403.json')),
      create({}, {
        status: 422,
        body: { title: 'Unprocessable Entity', status: 422, detail: 'too many subrooms' },
      }),
    ]);
    const missing = await tools.call('create_breakout_room', { roomId: ROOM_ID });
    const forbidden = await tools.call('create_breakout_room', { roomId: ROOM_ID });
    const full = await tools.call('create_breakout_room', { roomId: ROOM_ID });
    await tools.done();

    assert.equal(missing.summary, ROOM_NOT_FOUND);
    assert.match(forbidden.summary, /^The API key's user is not allowed to do this/);
    assert.doesNotMatch(forbidden.summary, /50 breakout rooms/);
    // The description leaves out the limit, so the error of the 422 names it: the model reads it
    // only when it meets the limit.
    assert.equal(
      full.summary,
      `alfaview could not process the input: too many subrooms. ${BREAKOUT_ROOM_LIMIT_HINT}`,
    );
    assert.equal(
      BREAKOUT_ROOM_LIMIT_HINT,
      'A room has at most 50 breakout rooms: get_room lists them, and delete_breakout_room removes one.',
    );
  });

  it('warns and gives the known values when the list fails or does not show the new breakout room', async () => {
    // The list fails with 503, and with 401 after the one new login. Then it lacks the new ID, and
    // its body is null or an object, not a list. The calls after the new login keep its token.
    const token = 'token-2';
    const tools = await harness([
      loginRequest(),
      create({ displayName: 'Breakout 3' }),
      list(problem(503, 'problem-500.json')),
      create({}),
      list(problem(401, 'problem-401.json')),
      loginRequest(token),
      list(problem(401, 'problem-401.json'), token),
      { ...create({ displayName: 'Breakout 3' }), token },
      list(ok([{ id: SUBROOM_ID, sort: 1 }]), token),
      { ...create({ displayName: 'Breakout 3' }), token },
      list(ok(null), token),
      { ...create({}), token },
      list(ok({ data: [] }), token),
    ]);
    const results = [
      await tools.call('create_breakout_room', { roomId: ROOM_ID, displayName: 'Breakout 3' }),
      await tools.call('create_breakout_room', { roomId: ROOM_ID }),
      await tools.call('create_breakout_room', { roomId: ROOM_ID, displayName: 'Breakout 3' }),
      await tools.call('create_breakout_room', { roomId: ROOM_ID, displayName: 'Breakout 3' }),
      await tools.call('create_breakout_room', { roomId: ROOM_ID }),
    ];
    await tools.done();

    for (const [index, result] of results.entries()) {
      const displayName = index === 1 || index === 4 ? null : 'Breakout 3';
      assert.equal(result.isError, false, result.summary);
      assert.equal(
        result.summary,
        `Created breakout room ${NEW_ID} in room ${ROOM_ID}. ${BREAKOUT_ROOM_NOT_LISTED_WARNING}`,
      );
      assert.deepEqual(result.data, {
        id: NEW_ID,
        roomId: ROOM_ID,
        displayName,
        breakoutRoomCount: null,
        warnings: [BREAKOUT_ROOM_NOT_LISTED_WARNING],
      });
    }
    assert.equal(
      BREAKOUT_ROOM_NOT_LISTED_WARNING,
      'alfaview did not list the new breakout room after the create, so displayName is the name that was sent and breakoutRoomCount is null.',
    );
  });

  it('warns and gives the known values when the list times out or fails in the network', async () => {
    const tools = await harness(
      [
        loginRequest(),
        create({}),
        list({ hang: true }),
        create({}),
        list({ networkError: 'ECONNRESET' }),
      ],
      { timeoutMs: 20 },
    );
    const timeout = await tools.call('create_breakout_room', { roomId: ROOM_ID });
    const network = await tools.call('create_breakout_room', { roomId: ROOM_ID });
    await tools.done();

    for (const result of [timeout, network]) {
      assert.equal(result.isError, false, result.summary);
      assert.deepEqual(result.data, {
        id: NEW_ID,
        roomId: ROOM_ID,
        displayName: null,
        breakoutRoomCount: null,
        warnings: [BREAKOUT_ROOM_NOT_LISTED_WARNING],
      });
    }
  });

  it('warns and gives the known values when the call is canceled during the list', async () => {
    const controller = new AbortController();
    const { api, fake } = testApi([loginRequest(), create({}), list({ hang: true })], {
      signal: controller.signal,
    });
    const run = createBreakoutRoomTool.run({ roomId: ROOM_ID }, context(api, controller.signal));
    await untilRequests(fake, 3);
    controller.abort();
    const result = outputOf(await run);
    fake.assertDone();

    assert.deepEqual(result.warnings, [BREAKOUT_ROOM_NOT_LISTED_WARNING]);
    assert.deepEqual(result.data, {
      id: NEW_ID,
      roomId: ROOM_ID,
      displayName: null,
      breakoutRoomCount: null,
    });
  });

  it('gives an error of the list that is not an error of alfaview to the wrapper', async () => {
    const site = testFileLine();
    const bug = new TypeError('a bug');
    const api: CallApi = {
      request<T>(request: ApiRequest): Promise<ApiResponse<T>> {
        keepApiRequestProblems(request, site);
        if (request.method === 'POST') {
          return Promise.resolve({ status: 201, data: { id: NEW_ID } as T });
        }
        return Promise.reject(bug);
      },
      requestCount: 0,
      elapsedMs: () => 0,
    };
    const signal = new AbortController().signal;
    await assert.rejects(createBreakoutRoomTool.run({ roomId: ROOM_ID }, context(api, signal)), bug);
  });
});

describe('update_breakout_room', () => {
  it('sends the trimmed name with both IDs in lowercase, then reads the breakout room', async () => {
    const tools = await harness([
      loginRequest(),
      rename('Beratung'),
      list(ok([{ id: SUBROOM_ID, sort: 1, displayName: 'Beratung' }, subrooms()[0]])),
    ]);
    const result = await tools.call('update_breakout_room', {
      roomId: ROOM_ID.toUpperCase(),
      subroomId: SUBROOM_ID.toUpperCase(),
      displayName: ' Beratung ',
    });
    await tools.done();

    assert.equal(result.summary, `Renamed breakout room ${SUBROOM_ID} of room ${ROOM_ID}.`);
    assert.deepEqual(result.data, {
      id: SUBROOM_ID,
      roomId: ROOM_ID,
      displayName: 'Beratung',
      warnings: [],
    });
  });

  it('gives the sent name when the list does not show the breakout room', async () => {
    const tools = await harness([loginRequest(), rename('Beratung'), list(ok(null))]);
    const result = await tools.call('update_breakout_room', {
      roomId: ROOM_ID,
      subroomId: SUBROOM_ID.toUpperCase(),
      displayName: 'Beratung',
    });
    await tools.done();

    assert.deepEqual(result.data, {
      id: SUBROOM_ID,
      roomId: ROOM_ID,
      displayName: 'Beratung',
      warnings: [],
    });
  });

  it('takes a name of 32 letters, and refuses 34 bytes before any request and a name of only spaces in the SDK', async () => {
    const name = 'a'.repeat(32);
    const tools = await harness([
      loginRequest(),
      rename(name),
      list(ok([{ id: SUBROOM_ID, sort: 1, displayName: name }])),
    ]);
    const args = { roomId: ROOM_ID, subroomId: SUBROOM_ID };
    const passed = await tools.call('update_breakout_room', { ...args, displayName: name });
    const umlauts = await tools.call('update_breakout_room', { ...args, displayName: 'ä'.repeat(17) });
    const spaces = await tools.call('update_breakout_room', { ...args, displayName: '   ' });
    const none = await tools.call('update_breakout_room', args);
    await tools.done();

    assert.equal(passed.data.displayName, name);
    assert.deepEqual([umlauts.isError, umlauts.summary], [true, NAME_MESSAGE]);
    assert.equal(spaces.isError, true);
    assert.equal(none.isError, true);
    assert.match(none.summary, /displayName/);
  });

  it('gives the texts of a breakout room that alfaview cannot find, a missing permission and a refused name', async () => {
    const tools = await harness([
      loginRequest(),
      rename('Beratung', problem(404, 'problem-404.json')),
      rename('Beratung', problem(403, 'problem-403.json')),
      rename('Beratung', INVALID_NAME),
    ]);
    const args = { roomId: ROOM_ID, subroomId: SUBROOM_ID, displayName: 'Beratung' };
    const missing = await tools.call('update_breakout_room', args);
    const forbidden = await tools.call('update_breakout_room', args);
    const invalid = await tools.call('update_breakout_room', args);
    await tools.done();

    assert.equal(missing.summary, BREAKOUT_ROOM_NOT_FOUND);
    assert.match(forbidden.summary, /^The API key's user is not allowed to do this/);
    assert.equal(invalid.summary, 'alfaview could not process the input: subroom name too long.');
  });

  it('gives the error of the list after the rename, which is safe to repeat', async () => {
    const tools = await harness([
      loginRequest(),
      rename('Beratung'),
      list(problem(503, 'problem-500.json')),
      rename('Beratung'),
      list(ok({ data: [] })),
    ]);
    const args = { roomId: ROOM_ID, subroomId: SUBROOM_ID, displayName: 'Beratung' };
    const failed = await tools.call('update_breakout_room', args);
    const unexpected = await tools.call('update_breakout_room', args);
    await tools.done();

    assert.equal(failed.isError, true);
    assert.match(tools.logLines[1]!, /: ServerError, 3 requests/);
    assert.equal(unexpected.summary, BREAKOUT_ROOM_LIST_MESSAGE);
  });
});

describe('delete_breakout_room', () => {
  it('reads the list, then deletes the listed breakout room with both IDs in lowercase', async () => {
    const tools = await harness([loginRequest(), list(), remove()]);
    const result = await tools.call('delete_breakout_room', {
      roomId: ROOM_ID.toUpperCase(),
      subroomId: SUBROOM_ID.toUpperCase(),
    });
    await tools.done();

    assert.equal(result.summary, `Deleted breakout room ${SUBROOM_ID} of room ${ROOM_ID}.`);
    assert.deepEqual(result.data, {
      subroomId: SUBROOM_ID,
      roomId: ROOM_ID,
      deleted: true,
      warnings: [],
    });
  });

  it('deletes nothing for a breakout room that the list lacks, also for an empty list and on a repeat', async () => {
    const tools = await harness([
      loginRequest(),
      list(ok([subrooms()[0]])),
      list(ok(null)),
      list(ok([])),
      list(),
      remove(),
      list(ok([subrooms()[0]])),
    ]);
    const args = { roomId: ROOM_ID, subroomId: SUBROOM_ID.toUpperCase() };
    const results = [
      await tools.call('delete_breakout_room', args),
      await tools.call('delete_breakout_room', args),
      await tools.call('delete_breakout_room', args),
    ];
    const deleted = await tools.call('delete_breakout_room', args);
    const repeat = await tools.call('delete_breakout_room', args);
    await tools.done();

    const message = breakoutRoomNotFoundMessage(SUBROOM_ID, ROOM_ID);
    assert.equal(
      message,
      `alfaview could not find the breakout room ${SUBROOM_ID} in room ${ROOM_ID}, so nothing was deleted. get_room lists the breakout rooms of a room.`,
    );
    for (const result of [...results, repeat]) {
      assert.deepEqual([result.isError, result.summary], [true, message]);
    }
    assert.equal(deleted.isError, false);
    assert.match(tools.logLines[1]!, /: NotFound, 2 requests/);
  });

  it('names the room after a 404 of the list, and gives the texts of the delete', async () => {
    const tools = await harness([
      loginRequest(),
      list(problem(404, 'problem-404.json')),
      list(),
      remove(problem(403, 'problem-403.json')),
      list(),
      remove({ status: 422, body: { title: 'Unprocessable Entity', status: 422, detail: 'invalid subroom id' } }),
      list(ok({ data: [] })),
    ]);
    const args = { roomId: ROOM_ID, subroomId: SUBROOM_ID };
    const missing = await tools.call('delete_breakout_room', args);
    const forbidden = await tools.call('delete_breakout_room', args);
    const invalid = await tools.call('delete_breakout_room', args);
    const unexpected = await tools.call('delete_breakout_room', args);
    await tools.done();

    assert.equal(missing.summary, ROOM_NOT_FOUND);
    assert.match(forbidden.summary, /^The API key's user is not allowed to do this/);
    assert.equal(invalid.summary, 'alfaview could not process the input: invalid subroom id.');
    assert.equal(unexpected.summary, BREAKOUT_ROOM_LIST_MESSAGE);
    assert.equal(BREAKOUT_ROOM_LIST_MESSAGE, 'alfaview sent an unexpected breakout room response.');
  });
});
