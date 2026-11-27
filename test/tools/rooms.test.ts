// find_rooms, get_room and regenerate_room_passcode, create_room and update_room of the level
// manage, and delete_room of the level full, through an MCP SDK client.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { INACTIVE_ACCOUNT_MESSAGE } from '../../src/alfaview/client.ts';
import {
  confirmRoomNameMessage,
  CREATE_ROOM_DENIED_MESSAGE,
  DEPARTMENT_DELETE_WARNING,
  DEPARTMENT_MESSAGE,
  MEETING_ROOM_DELETE_MESSAGE,
  roomCreatedButNotReadMessage,
  ROOM_DELETE_NOT_FOUND_MESSAGE,
  roomUpdatedButNotReadMessage,
  ROOM_UNCERTAIN_MESSAGE,
  SAVED_BEFORE_WAITING_ROOM_SENTENCE,
  unnamedRoomMessage,
} from '../../src/domain/rooms.ts';
import { createLogger } from '../../src/log.ts';
import {
  CONFIRM_ROOM_NAME_TEXT,
  createRoomTool,
  FULL_ROOM_TOOLS,
  PARENT_ID_MESSAGE,
  ROOM_ADMIN_TOOLS,
  ROOM_TOOLS,
} from '../../src/tools/rooms.ts';
import {
  CHANGE_ANNOTATIONS,
  CREATE_ANNOTATIONS,
  IDEMPOTENT_CHANGE_ANNOTATIONS,
  READ_ANNOTATIONS,
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
import { noQuestions } from '../helpers/toolContext.ts';

const ROOM_ID = '0b7c5d2e-91a4-5f3b-8e27-0f4a6c9d1e22';
const WEBINAR_ROOM_ID = '5a6b7c8d-9e0f-5a1b-8c2d-3e4f5a6b7c8d';
const BEN_ROOM_ID = '8e1f2a3b-4c5d-5e6f-9a0b-1c2d3e4f5a6b';
const BAD_IDS = ['Advisory Room', '.', '..', '0b7c5d2e-91a4-5f3b-0f4a6c9d1e22'];

function roomPages(roomTypes = 'room'): ExpectedRequest[] {
  return [
    {
      method: 'GET',
      path: '/v2/rooms',
      query: { roomTypes, limit: '50' },
      respond: { status: 200, body: fixture('core/rooms-page-1.json') },
    },
    {
      method: 'GET',
      path: '/v2/rooms',
      query: { roomTypes, limit: '50', pageToken: 'c2Vjb25kLXBhZ2U' },
      respond: { status: 200, body: fixture('core/rooms-page-2.json') },
    },
  ];
}

function roomRequest(body: unknown, status = 200, path = `/v2/rooms/${ROOM_ID}`): ExpectedRequest {
  return { method: 'GET', path, respond: { status, body } };
}

describe('the room tools', () => {
  it('are listed in their fixed order, with their annotations', async () => {
    const harness = await toolHarness(ROOM_TOOLS, []);
    const { tools } = await harness.client.listTools();
    await harness.done();

    assert.deepEqual(
      tools.map((tool) => [tool.name, tool.annotations]),
      [
        ['find_rooms', READ_ANNOTATIONS],
        ['get_room', READ_ANNOTATIONS],
        ['regenerate_room_passcode', CHANGE_ANNOTATIONS],
      ],
    );
  });

  it('refuse a room name, dot segments and a broken UUID without a request', async () => {
    const harness = await toolHarness(ROOM_TOOLS, []);
    for (const name of ['get_room', 'regenerate_room_passcode']) {
      for (const roomId of BAD_IDS) {
        const result = await harness.call(name, { roomId });
        assert.equal(result.isError, true, `${name} ${roomId}`);
        assert.match(
          result.summary,
          /roomId takes an ID from find_rooms, or a meeting ID, not a name\./,
        );
      }
    }
    await harness.done();
  });
});

describe('find_rooms', () => {
  it('lists every room by name, over all pages', async () => {
    const harness = await toolHarness(ROOM_TOOLS, [loginRequest(), ...roomPages()]);
    const result = await harness.call('find_rooms');
    await harness.done();

    assert.equal(result.summary, 'Found 3 rooms. Showing 1 to 3.');
    assert.deepEqual(result.data, {
      totalMatches: 3,
      offset: 0,
      nextOffset: null,
      rooms: [
        {
          id: ROOM_ID,
          displayName: 'Advisory Room Anna Example',
          type: 'room',
          parentId: null,
          waitingRoomEnabled: true,
          passcodeRequired: null,
        },
        {
          id: BEN_ROOM_ID,
          displayName: 'Advisory Room Ben Example',
          type: 'room',
          parentId: null,
          waitingRoomEnabled: true,
          passcodeRequired: null,
        },
        {
          id: WEBINAR_ROOM_ID,
          displayName: 'Webinar Room',
          type: 'room',
          parentId: null,
          waitingRoomEnabled: false,
          passcodeRequired: null,
        },
      ],
      warnings: [],
    });
  });

  it('puts an exact name first, then the names that contain it, in any case', async () => {
    const pages = fixture('core/rooms-page-1.json');
    pages.data.push({ id: 'aa000000-0000-5000-8000-000000000001', displayName: 'ROOM' });
    const harness = await toolHarness(ROOM_TOOLS, [
      loginRequest(),
      {
        method: 'GET',
        path: '/v2/rooms',
        query: { roomTypes: 'room', limit: '50' },
        respond: { status: 200, body: { data: pages.data } },
      },
    ]);
    const result = await harness.call('find_rooms', { name: ' room ' });
    await harness.done();

    assert.equal(
      result.summary,
      'Found 3 rooms whose name contains the given text. Showing 1 to 3.',
    );
    assert.deepEqual(
      result.data.rooms.map((room: { displayName: string }) => room.displayName),
      ['ROOM', 'Advisory Room Anna Example', 'Webinar Room'],
    );
  });

  it('says so when no room matches the name', async () => {
    const harness = await toolHarness(ROOM_TOOLS, [loginRequest(), ...roomPages()]);
    const result = await harness.call('find_rooms', { name: 'Nothing like it' });
    await harness.done();

    assert.equal(result.summary, 'Found no rooms whose name contains the given text.');
    assert.deepEqual(result.data, {
      totalMatches: 0,
      offset: 0,
      nextOffset: null,
      rooms: [],
      warnings: [],
    });
  });

  it('lists departments with the room type department', async () => {
    const harness = await toolHarness(ROOM_TOOLS, [
      loginRequest(),
      {
        method: 'GET',
        path: '/v2/rooms',
        query: { roomTypes: 'department', limit: '50' },
        respond: { status: 200, body: { data: null } },
      },
    ]);
    const result = await harness.call('find_rooms', { type: 'department' });
    await harness.done();

    assert.equal(result.summary, 'Found no departments.');
    assert.deepEqual(result.data.rooms, []);
  });

  it('pages with limit and offset', async () => {
    const harness = await toolHarness(ROOM_TOOLS, [
      loginRequest(),
      ...roomPages(),
      ...roomPages(),
      ...roomPages(),
    ]);
    const first = await harness.call('find_rooms', { limit: 2 });
    const second = await harness.call('find_rooms', { limit: 2, offset: first.data.nextOffset });
    const beyond = await harness.call('find_rooms', { offset: 5 });
    await harness.done();

    assert.equal(first.summary, 'Found 3 rooms. Showing 1 to 2. Call again with offset 2 for the next ones.');
    assert.equal(first.data.nextOffset, 2);
    assert.equal(first.data.rooms.length, 2);
    assert.equal(second.summary, 'Found 3 rooms. Showing 3 to 3.');
    assert.equal(second.data.nextOffset, null);
    assert.equal(second.data.rooms[0].id, WEBINAR_ROOM_ID);
    assert.equal(beyond.summary, 'Found 3 rooms. Nothing at offset 5.');
    assert.deepEqual(beyond.data.rooms, []);
  });

  it('refuses a limit above 50 and a name of only spaces without a request', async () => {
    const harness = await toolHarness(ROOM_TOOLS, []);
    const limit = await harness.call('find_rooms', { limit: 51 });
    const spaces = await harness.call('find_rooms', { name: '   ' });
    const type = await harness.call('find_rooms', { type: 'meeting' });
    await harness.done();

    assert.equal(limit.isError, true);
    assert.equal(spaces.isError, true);
    assert.equal(type.isError, true);
  });
});

describe('get_room', () => {
  it('returns the room with the changed features, the breakout rooms and local times', async () => {
    const harness = await toolHarness(ROOM_TOOLS, [loginRequest(), roomRequest(fixture('rooms/room.json'))]);
    const result = await harness.call('get_room', { roomId: ROOM_ID });
    await harness.done();

    assert.equal(result.summary, `Room ${ROOM_ID}: waiting room on, passcode not required.`);
    assert.deepEqual(result.data, {
      id: ROOM_ID,
      displayName: 'Advisory Room Anna Example',
      type: 'room',
      parentId: null,
      waitingRoomEnabled: true,
      passcodeRequired: false,
      waitingRoomWelcomeNote: 'Welcome. Your advisor will let you in shortly.',
      managed: false,
      createdAt: '2026-09-01T10:30:00+02:00',
      quotas: { activeParticipants: 10, spectatorOnlyParticipants: 0, maxVideoTilesPerPage: 9 },
      features: { raiseHands: 'enabled', blockWebclient: 'disabled' },
      subrooms: [{ id: '2d4f6a8c-1e3b-5d7f-9a0c-2e4f6a8c0e11', displayName: 'Breakout 1' }],
      passcode: null,
      warnings: [],
    });
  });

  it('gives a winter time with its own offset', async () => {
    const room = { ...fixture('rooms/room.json'), createdAt: '2026-12-01T08:30:00Z' };
    const harness = await toolHarness(ROOM_TOOLS, [loginRequest(), roomRequest(room)]);
    const result = await harness.call('get_room', { roomId: ROOM_ID });
    await harness.done();

    assert.equal(result.data.createdAt, '2026-12-01T09:30:00+01:00');
  });

  it('says unknown for settings that alfaview leaves out', async () => {
    const room = fixture('rooms/room-sparse.json');
    delete room.waitingRoomEnabled;
    const harness = await toolHarness(ROOM_TOOLS, [loginRequest(), roomRequest(room)]);
    const result = await harness.call('get_room', { roomId: ROOM_ID });
    await harness.done();

    assert.equal(
      result.summary,
      'Room 7d8e9f0a-1b2c-5d3e-8f4a-5b6c7d8e9f0a: waiting room unknown, passcode unknown.',
    );
    assert.equal(result.data.createdAt, null);
  });

  it('sends an upper-case room ID in lower case', async () => {
    const harness = await toolHarness(ROOM_TOOLS, [
      loginRequest(),
      roomRequest({
        ...fixture<Record<string, unknown>>('rooms/room.json'),
        waitingRoomEnabled: false,
        passcodeRequired: true,
      }),
    ]);
    const result = await harness.call('get_room', { roomId: ROOM_ID.toUpperCase() });
    await harness.done();

    assert.equal(result.summary, `Room ${ROOM_ID}: waiting room off, passcode required.`);
  });

  it('returns the passcode with includePasscode', async () => {
    const harness = await toolHarness(ROOM_TOOLS, [
      loginRequest(),
      roomRequest(fixture('rooms/room.json')),
      roomRequest(fixture('rooms/passcode.json'), 200, `/v2/rooms/${ROOM_ID}/passcode`),
    ]);
    const result = await harness.call('get_room', { roomId: ROOM_ID, includePasscode: true });
    await harness.done();

    assert.equal(
      result.summary,
      `Room ${ROOM_ID}: waiting room on, passcode not required. The passcode is in the result.`,
    );
    assert.equal(result.data.passcode, 'Kx7#mQ2p');
  });

  // alfaview answers 200 with an empty passcode for a room without a passcode.
  it('gives no passcode for the empty passcode of a room without one', async () => {
    const harness = await toolHarness(ROOM_TOOLS, [
      loginRequest(),
      roomRequest(fixture('rooms/room.json')),
      roomRequest({ passcode: '', required: false }, 200, `/v2/rooms/${ROOM_ID}/passcode`),
    ]);
    const result = await harness.call('get_room', { roomId: ROOM_ID, includePasscode: true });
    await harness.done();

    assert.equal(
      result.summary,
      `Room ${ROOM_ID}: waiting room on, passcode not required. The room has no passcode yet.`,
    );
    assert.equal(result.data.passcode, null);
  });

  // alfaview answers 404 for the passcode only when it does not find the room or the API key's user
  // cannot see it, also after the read of the room.
  it('reports the room as not found when alfaview answers 404 for the passcode of the room that it returned', async () => {
    const harness = await toolHarness(ROOM_TOOLS, [
      loginRequest(),
      roomRequest(fixture('rooms/room.json')),
      roomRequest(fixture('core/problem-404.json'), 404, `/v2/rooms/${ROOM_ID}/passcode`),
    ]);
    const result = await harness.call('get_room', { roomId: ROOM_ID, includePasscode: true });
    await harness.done();

    assert.equal(result.isError, true);
    assert.equal(
      result.summary,
      "alfaview could not find the room. It was deleted, or the API key's user cannot see it.",
    );
  });

  it('reports a room that alfaview cannot find', async () => {
    const harness = await toolHarness(ROOM_TOOLS, [
      loginRequest(),
      roomRequest(fixture('core/problem-404.json'), 404),
    ]);
    const result = await harness.call('get_room', { roomId: ROOM_ID, includePasscode: true });
    await harness.done();

    assert.equal(result.isError, true);
    assert.equal(
      result.summary,
      "alfaview could not find the room. It was deleted, or the API key's user cannot see it.",
    );
  });
});

describe('regenerate_room_passcode', () => {
  const regenerate = (status: number, body: unknown): ExpectedRequest => ({
    method: 'POST',
    path: `/v2/rooms/${ROOM_ID}/passcode`,
    respond: { status, body },
  });

  it('makes a new passcode and returns it', async () => {
    const harness = await toolHarness(ROOM_TOOLS, [
      loginRequest(),
      regenerate(200, fixture('rooms/passcode.json')),
    ]);
    const result = await harness.call('regenerate_room_passcode', { roomId: ROOM_ID });
    await harness.done();

    assert.equal(
      result.summary,
      `Made a new passcode for room ${ROOM_ID}. The old passcode no longer works.`,
    );
    assert.deepEqual(result.data, {
      roomId: ROOM_ID,
      passcode: 'Kx7#mQ2p',
      passcodeRequired: true,
      warnings: [],
    });
  });

  it('tells how to read the passcode when alfaview does not return it', async () => {
    const harness = await toolHarness(ROOM_TOOLS, [loginRequest(), regenerate(200, {})]);
    const result = await harness.call('regenerate_room_passcode', { roomId: ROOM_ID });
    await harness.done();

    assert.equal(result.isError, true);
    assert.equal(
      result.summary,
      `alfaview made a new passcode for the room ${ROOM_ID}, but did not return it. Use get_room with includePasscode true to read it.`,
    );
  });

  it('reports a missing permission', async () => {
    const harness = await toolHarness(ROOM_TOOLS, [
      loginRequest(),
      regenerate(403, fixture('core/problem-403.json')),
    ]);
    const result = await harness.call('regenerate_room_passcode', { roomId: ROOM_ID });
    await harness.done();

    assert.equal(result.isError, true);
    assert.match(result.summary, /^The API key's user is not allowed to do this/);
  });
});

// The tools of the level manage

type Json = Record<string, unknown>;

const NEW_ROOM_ID = '1a2b3c4d-5e6f-5a7b-8c9d-0e1f2a3b4c5d';
/** The department of rooms/room-sparse.json. */
const DEPARTMENT_ID = '8e1f2a3b-4c5d-5e6f-8a7b-9c0d1e2f3a4b';

const NOTE_PROBLEM =
  'waitingRoomWelcomeNote can have at most 300 characters on one line, with letters, digits, punctuation, symbols and plain spaces only.';

/** The 10 breakout rooms without names that alfaview adds to a new room. */
const NEW_SUBROOM_IDS = Array.from(
  { length: 10 },
  (_, index) => `5b000000-0000-5000-8000-0000000000${String(index).padStart(2, '0')}`,
);

/** A new room as alfaview reads it back. */
function newRoom(overrides: Json = {}): Json {
  return {
    id: NEW_ROOM_ID,
    displayName: 'Project Room',
    type: 'room',
    parentId: null,
    sort: 0,
    createdAt: '2026-10-07T08:00:00Z',
    createdBy: '6c1d9e4f-2a7b-5c3d-9e8f-0a1b2c3d4e5f',
    managed: false,
    waitingRoomEnabled: false,
    waitingRoomWelcomeNote: '',
    passcodeRequired: false,
    quotas: { activeParticipants: 25, spectatorOnlyParticipants: 0, maxVideoTilesPerPage: 0 },
    features: {},
    subrooms: NEW_SUBROOM_IDS.map((id, index) => ({ id, sort: index + 1 })),
    ...overrides,
  };
}

const NEW_ROOM_OUTPUT = {
  id: NEW_ROOM_ID,
  displayName: 'Project Room',
  type: 'room',
  parentId: null,
  waitingRoomEnabled: false,
  passcodeRequired: false,
  waitingRoomWelcomeNote: null,
  managed: false,
  createdAt: '2026-10-07T10:00:00+02:00',
  quotas: { activeParticipants: 25, spectatorOnlyParticipants: 0, maxVideoTilesPerPage: 0 },
  features: {},
  subrooms: NEW_SUBROOM_IDS.map((id) => ({ id, displayName: null })),
  passcode: null,
  warnings: [],
};

function createRequest(
  body: Json,
  respond: FakeAnswer = { status: 201, body: { id: NEW_ROOM_ID } },
): ExpectedRequest {
  return { method: 'POST', path: '/v2/rooms', body, respond };
}

function readBack(body: Json = newRoom(), status = 200, id = NEW_ROOM_ID): ExpectedRequest {
  return { method: 'GET', path: `/v2/rooms/${id}`, respond: { status, body } };
}

function roomTypesRequest(body: unknown = fixture('rooms/room-types.json')): ExpectedRequest {
  return { method: 'GET', path: '/v2/room-types', respond: { status: 200, body } };
}

function adminHarness(expected: readonly ExpectedRequest[], options: HarnessOptions = {}) {
  return toolHarness(ROOM_ADMIN_TOOLS, expected, options);
}

describe('the room tools of the level manage', () => {
  it('are listed in their fixed order, with their annotations', async () => {
    const harness = await adminHarness([]);
    const { tools } = await harness.client.listTools();
    await harness.done();

    assert.deepEqual(
      tools.map((tool) => [tool.name, tool.title, tool.annotations]),
      [
        ['create_room', 'Create a room', CREATE_ANNOTATIONS],
        ['update_room', 'Update a room', IDEMPOTENT_CHANGE_ANNOTATIONS],
      ],
    );
    assert.deepEqual(
      ROOM_ADMIN_TOOLS.map((tool) => tool.level),
      ['manage', 'manage'],
    );
  });
});

describe('create_room', () => {
  const PROJECT = { displayName: 'Project Room' };
  const PROJECT_BODY = { displayName: 'Project Room', type: 'room', waitingRoomEnabled: false };

  it('creates a room without a request for the room types, reads it back and returns it', async () => {
    const harness = await adminHarness([loginRequest(), createRequest(PROJECT_BODY), readBack()]);
    const result = await harness.call('create_room', PROJECT);
    await harness.done();

    assert.equal(result.summary, `Created room ${NEW_ROOM_ID}: waiting room off, passcode not required.`);
    assert.deepEqual(result.data, NEW_ROOM_OUTPUT);
  });

  it('sends every setting and the parent ID in lowercase, and says how to read a required passcode', async () => {
    const settings = {
      waitingRoomEnabled: true,
      waitingRoomWelcomeNote: 'Welcome. Your advisor will let you in.',
      passcodeRequired: true,
    };
    const harness = await adminHarness([
      loginRequest(),
      createRequest({ ...PROJECT_BODY, ...settings, parentId: DEPARTMENT_ID }),
      readBack(newRoom({ ...settings, parentId: DEPARTMENT_ID })),
    ]);
    const result = await harness.call('create_room', {
      ...PROJECT,
      ...settings,
      parentId: ` ${DEPARTMENT_ID.toUpperCase()} `,
    });
    await harness.done();

    assert.equal(
      result.summary,
      `Created room ${NEW_ROOM_ID}: waiting room on, passcode required. Use get_room with includePasscode true to read the passcode.`,
    );
    assert.equal(result.data.parentId, DEPARTMENT_ID);
    assert.equal(result.data.passcode, null);
  });

  it('says unknown for the settings that alfaview leaves out', async () => {
    const room = newRoom({ passcodeRequired: null });
    delete room.waitingRoomEnabled;
    const harness = await adminHarness([loginRequest(), createRequest(PROJECT_BODY), readBack(room)]);
    const result = await harness.call('create_room', PROJECT);
    await harness.done();

    assert.equal(result.summary, `Created room ${NEW_ROOM_ID}: waiting room unknown, passcode unknown.`);
  });

  it('says how to read the passcode when the new room requires one, also without passcodeRequired in the call', async () => {
    const harness = await adminHarness([
      loginRequest(),
      createRequest(PROJECT_BODY),
      readBack(newRoom({ passcodeRequired: true })),
    ]);
    const result = await harness.call('create_room', PROJECT);
    await harness.done();

    assert.equal(
      result.summary,
      `Created room ${NEW_ROOM_ID}: waiting room off, passcode required. Use get_room with includePasscode true to read the passcode.`,
    );
  });

  it('creates a department', async () => {
    const department = {
      id: NEW_ROOM_ID,
      displayName: 'Advisors',
      type: 'department',
      managed: false,
      createdAt: '2026-10-07T08:00:00Z',
    };
    const harness = await adminHarness([
      loginRequest(),
      createRequest({ displayName: 'Advisors', type: 'department', waitingRoomEnabled: false }),
      readBack(department),
    ]);
    const result = await harness.call('create_room', { displayName: 'Advisors', type: 'department' });
    await harness.done();

    assert.equal(result.summary, `Created department ${NEW_ROOM_ID}.`);
    assert.deepEqual([result.data.type, result.data.subrooms], ['department', []]);
  });

  it('takes the limits of a room type of the plan in any case, with 0 video tiles per page', async () => {
    const quotas = { activeParticipants: 50, spectatorOnlyParticipants: 450, maxVideoTilesPerPage: 0 };
    const harness = await adminHarness([
      loginRequest(),
      roomTypesRequest(),
      createRequest({ ...PROJECT_BODY, quotas }),
      readBack(newRoom({ quotas })),
    ]);
    const result = await harness.call('create_room', { ...PROJECT, planRoomType: ' webinar ' });
    await harness.done();

    assert.equal(result.isError, false, result.summary);
    assert.deepEqual(result.data.quotas, quotas);
  });

  it('lists the room types of the plan, smallest first, for a name that the plan does not have', async () => {
    const unnamed = fixture<Json[]>('rooms/room-types.json').filter((type) => type.name === '');
    const harness = await adminHarness([
      loginRequest(),
      roomTypesRequest(),
      roomTypesRequest(unnamed),
      roomTypesRequest(null),
    ]);
    const results = [
      await harness.call('create_room', { ...PROJECT, planRoomType: 'Seminar' }),
      await harness.call('create_room', { ...PROJECT, planRoomType: 'Seminar' }),
      await harness.call('create_room', { ...PROJECT, planRoomType: 'Seminar' }),
    ];
    await harness.done();

    assert.deepEqual(
      results.map((result) => result.summary),
      [
        'Your alfaview plan has no room type named Seminar. Its room types: Advisory, Webinar.',
        'Your alfaview plan has no room types. Leave out planRoomType.',
        'Your alfaview plan has no room types. Leave out planRoomType.',
      ],
    );
    // No create follows the room type list.
    assert.match(harness.logLines.at(-1)!, /: InvalidInput, 1 request, /);
  });

  it('reports a room type without limits and a room type answer that is not a list', async () => {
    const harness = await adminHarness([
      loginRequest(),
      roomTypesRequest([{ name: 'Webinar', maxSubRooms: 10 }]),
      roomTypesRequest({ data: [] }),
    ]);
    const limits = await harness.call('create_room', { ...PROJECT, planRoomType: 'Webinar' });
    const list = await harness.call('create_room', { ...PROJECT, planRoomType: 'Webinar' });
    await harness.done();

    assert.equal(limits.summary, 'alfaview did not return the limits of the room type Webinar.');
    assert.equal(list.summary, 'alfaview sent an unexpected room type response.');
    assert.match(harness.logLines.at(-1)!, /: InvalidResponse, /);
  });

  it('refuses a welcome note that alfaview would refuse, and each setting of a department, without a request', async () => {
    const notes = [
      'a'.repeat(301),
      'Line one\nLine two',
      'Tab\there',
      'No\u{A0}break',
      '\u{200D}Joiner first',
    ];
    const departments = [
      { waitingRoomEnabled: true },
      { waitingRoomWelcomeNote: 'Welcome.' },
      { passcodeRequired: false },
      { planRoomType: 'Webinar' },
    ];
    const harness = await adminHarness([]);
    const refusedNotes = [];
    for (const note of notes) {
      refusedNotes.push(await harness.call('create_room', { ...PROJECT, waitingRoomWelcomeNote: note }));
    }
    const refusedDepartments = [];
    for (const settings of departments) {
      refusedDepartments.push(
        await harness.call('create_room', { displayName: 'Advisors', type: 'department', ...settings }),
      );
    }
    // The note comes first: before the room types of the plan and before the department rule.
    refusedNotes.push(
      await harness.call('create_room', {
        ...PROJECT,
        planRoomType: 'Webinar',
        waitingRoomWelcomeNote: 'Line one\nLine two',
      }),
      await harness.call('create_room', {
        displayName: 'Advisors',
        type: 'department',
        waitingRoomWelcomeNote: 'Line one\nLine two',
      }),
    );
    await harness.done();

    for (const result of refusedNotes) assert.equal(result.summary, NOTE_PROBLEM);
    for (const result of refusedDepartments) assert.equal(result.summary, DEPARTMENT_MESSAGE);
  });

  it('takes a note of 300 characters that ends with an emoji of two UTF-16 units', async () => {
    const note = `${'a'.repeat(299)}\u{1F600}`;
    const harness = await adminHarness([
      loginRequest(),
      createRequest({ ...PROJECT_BODY, waitingRoomWelcomeNote: note }),
      readBack(newRoom({ waitingRoomWelcomeNote: note })),
    ]);
    const result = await harness.call('create_room', { ...PROJECT, waitingRoomWelcomeNote: note });
    await harness.done();

    assert.equal(result.isError, false, result.summary);
    assert.equal(result.data.waitingRoomWelcomeNote, note);
  });

  it('refuses a parentId that is not an ID, and takes one in upper case', async () => {
    const harness = await adminHarness([]);
    const results = [
      await harness.call('create_room', { ...PROJECT, parentId: 'Advisors' }),
      await harness.call('create_room', { ...PROJECT, parentId: '..' }),
    ];
    await harness.done();

    for (const result of results) {
      assert.equal(result.isError, true);
      assert.match(result.summary, new RegExp(PARENT_ID_MESSAGE));
    }
    const parsed = createRoomTool.inputSchema.safeParse({ ...PROJECT, parentId: DEPARTMENT_ID.toUpperCase() });
    assert.ok(parsed.success);
  });

  for (const status of [500, 502, 503, 504]) {
    it(`says that the room may exist after HTTP ${status}, without a read back`, async () => {
      const harness = await adminHarness([
        loginRequest(),
        createRequest(PROJECT_BODY, { status, body: fixture('core/problem-500.json') }),
      ]);
      const result = await harness.call('create_room', PROJECT);
      await harness.done();

      assert.equal(result.isError, true);
      assert.equal(result.summary, ROOM_UNCERTAIN_MESSAGE);
      assert.match(harness.logLines.at(-1)!, /: ServerError, 2 requests/);
    });
  }

  it('says that the room may exist after a timeout or a network error', async () => {
    const harness = await adminHarness(
      [
        loginRequest(),
        createRequest(PROJECT_BODY, { hang: true }),
        createRequest(PROJECT_BODY, { networkError: 'ECONNRESET' }),
      ],
      { timeoutMs: 20 },
    );
    const timeout = await harness.call('create_room', PROJECT);
    const network = await harness.call('create_room', PROJECT);
    await harness.done();

    assert.equal(timeout.summary, ROOM_UNCERTAIN_MESSAGE);
    assert.equal(network.summary, ROOM_UNCERTAIN_MESSAGE);
    assert.match(harness.logLines[1]!, /: Timeout, /);
    assert.match(harness.logLines[2]!, /: NetworkError, /);
  });

  it('says that the room may exist after a cancel', async () => {
    const controller = new AbortController();
    const { api, fake } = testApi([loginRequest(), createRequest(PROJECT_BODY, { hang: true })], {
      signal: controller.signal,
    });
    const run = createRoomTool.run(
      { ...PROJECT, type: 'room', waitingRoomEnabled: false },
      {
        api,
        now: Date.parse('2026-10-07T08:00:00Z'),
        timeZone: 'Europe/Berlin',
        signal: controller.signal,
        log: createLogger(() => undefined),
        personalData: 'include',
        level: 'manage',
        confirmation: noQuestions(),
      },
    );
    await untilRequests(fake, 2);
    controller.abort();
    const error = await toolErrorOf(run);
    fake.assertDone();

    assert.deepEqual([error.code, error.message], ['Canceled', ROOM_UNCERTAIN_MESSAGE]);
  });

  it('names the user permission after a 403, and gives the text of a 422', async () => {
    const harness = await adminHarness([
      loginRequest(),
      createRequest(PROJECT_BODY, { status: 403, body: fixture('core/problem-403.json') }),
      createRequest(PROJECT_BODY, {
        status: 422,
        body: { title: 'Unprocessable Entity', detail: 'QUOTA_EXCEEDED' },
      }),
    ]);
    const forbidden = await harness.call('create_room', PROJECT);
    const invalid = await harness.call('create_room', PROJECT);
    await harness.done();

    assert.equal(forbidden.summary, CREATE_ROOM_DENIED_MESSAGE);
    assert.match(harness.logLines[1]!, /: Forbidden, /);
    assert.equal(invalid.summary, 'alfaview could not process the input: QUOTA_EXCEEDED.');
  });

  it('keeps the message of a login that alfaview refuses with 403, without a create', async () => {
    const harness = await adminHarness([
      { ...loginRequest(), respond: { status: 403, body: fixture('core/problem-403.json') } },
    ]);
    const result = await harness.call('create_room', PROJECT);
    await harness.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, INACTIVE_ACCOUNT_MESSAGE);
    assert.match(harness.logLines.at(-1)!, /: LoginRefused, 1 request/);
  });

  it('reports an answer without an ID', async () => {
    const harness = await adminHarness([
      loginRequest(),
      createRequest(PROJECT_BODY, { status: 201, body: {} }),
    ]);
    const result = await harness.call('create_room', PROJECT);
    await harness.done();

    assert.equal(result.summary, 'alfaview did not return the ID of the new room.');
    assert.match(harness.logLines.at(-1)!, /: InvalidResponse, 2 requests/);
  });

  it('says that the room exists when reading it back fails', async () => {
    const harness = await adminHarness([
      loginRequest(),
      createRequest(PROJECT_BODY),
      readBack(fixture('core/problem-404.json'), 404),
      createRequest(PROJECT_BODY),
      readBack(fixture('core/problem-500.json'), 503),
    ]);
    const missing = await harness.call('create_room', PROJECT);
    const failed = await harness.call('create_room', PROJECT);
    await harness.done();

    assert.equal(missing.summary, roomCreatedButNotReadMessage(NEW_ROOM_ID));
    assert.match(harness.logLines[1]!, /: NotFound, /);
    assert.equal(failed.summary, roomCreatedButNotReadMessage(NEW_ROOM_ID));
    assert.match(harness.logLines[2]!, /: ServerError, /);
    assert.equal(
      roomCreatedButNotReadMessage(NEW_ROOM_ID),
      `alfaview created the room ${NEW_ROOM_ID}, but reading it back failed. Do not create it again: that makes a second room. Use get_room with this ID to read it.`,
    );
  });
});

describe('update_room', () => {
  const patch = (body: Json, respond: FakeAnswer = { status: 204 }): ExpectedRequest => ({
    method: 'PATCH',
    path: `/v2/rooms/${ROOM_ID}`,
    body,
    respond,
  });
  const room = (overrides: Json = {}): Json => ({
    ...fixture<Json>('rooms/room.json'),
    ...overrides,
  });

  it('sends only the given field in the path with the lowercase ID, then reads the room back', async () => {
    const fields: [string, unknown][] = [
      ['displayName', 'Advisory Room Anna'],
      ['waitingRoomEnabled', false],
      ['waitingRoomWelcomeNote', 'Welcome.'],
      ['passcodeRequired', false],
    ];
    const harness = await adminHarness([
      loginRequest(),
      ...fields.flatMap(([key, value]) => [patch({ [key]: value }), readBack(room({ [key]: value }), 200, ROOM_ID)]),
    ]);
    const results = [];
    for (const [key, value] of fields) {
      results.push(await harness.call('update_room', { roomId: ROOM_ID.toUpperCase(), [key]: value }));
    }
    await harness.done();

    assert.deepEqual(
      results.map((result) => result.summary),
      [
        `Updated room ${ROOM_ID}: waiting room on, passcode not required.`,
        `Updated room ${ROOM_ID}: waiting room off, passcode not required.`,
        `Updated room ${ROOM_ID}: waiting room on, passcode not required.`,
        `Updated room ${ROOM_ID}: waiting room on, passcode not required.`,
      ],
    );
    assert.equal(results[0]!.data.displayName, 'Advisory Room Anna');
    assert.equal(results[2]!.data.waitingRoomWelcomeNote, 'Welcome.');
    assert.equal(results[0]!.data.passcode, null);
  });

  it('sends all four fields, and says how to read the passcode when passcodeRequired is true', async () => {
    const all = {
      displayName: 'Advisory Room Anna',
      waitingRoomEnabled: true,
      waitingRoomWelcomeNote: 'Welcome.',
      passcodeRequired: true,
    };
    const harness = await adminHarness([
      loginRequest(),
      patch(all),
      readBack(room(all), 200, ROOM_ID),
    ]);
    const result = await harness.call('update_room', { roomId: ROOM_ID, ...all });
    await harness.done();

    assert.equal(
      result.summary,
      `Updated room ${ROOM_ID}: waiting room on, passcode required. Use get_room with includePasscode true to read the passcode.`,
    );
  });

  it('says nothing of the passcode when the call does not set passcodeRequired to true', async () => {
    const harness = await adminHarness([
      loginRequest(),
      patch({ displayName: 'Advisory Room Anna' }),
      readBack(room({ displayName: 'Advisory Room Anna', passcodeRequired: true }), 200, ROOM_ID),
    ]);
    const result = await harness.call('update_room', { roomId: ROOM_ID, displayName: 'Advisory Room Anna' });
    await harness.done();

    assert.equal(result.summary, `Updated room ${ROOM_ID}: waiting room on, passcode required.`);
  });

  it('refuses a call without a field and a welcome note that alfaview would refuse, without a request', async () => {
    const harness = await adminHarness([]);
    const none = await harness.call('update_room', { roomId: ROOM_ID });
    const note = await harness.call('update_room', {
      roomId: ROOM_ID,
      displayName: 'Advisory Room Anna',
      waitingRoomWelcomeNote: 'First line\nSecond line',
    });
    const badId = await harness.call('update_room', { roomId: 'Advisory Room', displayName: 'X' });
    await harness.done();

    assert.equal(none.summary, 'Give at least one field to change.');
    assert.equal(note.summary, NOTE_PROBLEM);
    assert.match(badId.summary, /roomId takes an ID from find_rooms, or a meeting ID, not a name\./);
  });

  it('gives the text of a room that alfaview cannot find, a missing permission and a department', async () => {
    const harness = await adminHarness([
      loginRequest(),
      patch({ displayName: 'X' }, { status: 404, body: fixture('core/problem-404.json') }),
      patch({ displayName: 'X' }, { status: 403, body: fixture('core/problem-403.json') }),
      patch(
        { waitingRoomEnabled: true },
        {
          status: 422,
          body: {
            title: 'Unprocessable Entity',
            detail: "Rooms of the type 'department' cannot have a waiting room.",
          },
        },
      ),
    ]);
    const missing = await harness.call('update_room', { roomId: ROOM_ID, displayName: 'X' });
    const forbidden = await harness.call('update_room', { roomId: ROOM_ID, displayName: 'X' });
    const department = await harness.call('update_room', { roomId: ROOM_ID, waitingRoomEnabled: true });
    await harness.done();

    assert.equal(
      missing.summary,
      "alfaview could not find the room. It was deleted, or the API key's user cannot see it.",
    );
    assert.match(forbidden.summary, /^The API key's user is not allowed to do this/);
    assert.equal(
      department.summary,
      "alfaview could not process the input: Rooms of the type 'department' cannot have a waiting room.",
    );
  });

  // alfaview saves the other fields of a call before its waiting room options, and can refuse the
  // options after that save.
  it('says that the other fields may be saved after a refusal of a call that also changes the waiting room', async () => {
    const refusal = { status: 422, body: { title: 'Unprocessable Entity', detail: 'ACTION_INVALID' } };
    const harness = await adminHarness([
      loginRequest(),
      patch({ displayName: 'X', waitingRoomEnabled: true }, refusal),
      patch({ waitingRoomWelcomeNote: 'Welcome.', passcodeRequired: true }, { status: 400, body: fixture('core/problem-400.json') }),
      patch({ displayName: 'X', waitingRoomEnabled: true }, { status: 404, body: fixture('core/problem-404.json') }),
      patch({ displayName: 'X', waitingRoomEnabled: true }, { status: 503, body: fixture('core/problem-500.json') }),
      patch({ displayName: 'X' }, refusal),
    ]);
    const named = await harness.call('update_room', { roomId: ROOM_ID, displayName: 'X', waitingRoomEnabled: true });
    const passcode = await harness.call('update_room', {
      roomId: ROOM_ID,
      waitingRoomWelcomeNote: 'Welcome.',
      passcodeRequired: true,
    });
    const missing = await harness.call('update_room', { roomId: ROOM_ID, displayName: 'X', waitingRoomEnabled: true });
    const failed = await harness.call('update_room', { roomId: ROOM_ID, displayName: 'X', waitingRoomEnabled: true });
    const nameOnly = await harness.call('update_room', { roomId: ROOM_ID, displayName: 'X' });
    await harness.done();

    const sentence = SAVED_BEFORE_WAITING_ROOM_SENTENCE;
    assert.equal(named.summary, `alfaview could not process the input: ACTION_INVALID. ${sentence}`);
    assert.ok(passcode.summary.startsWith('alfaview rejected the request: '), passcode.summary);
    assert.ok(passcode.summary.endsWith(` ${sentence}`), passcode.summary);
    for (const result of [missing, failed, nameOnly]) {
      assert.equal(result.isError, true);
      assert.ok(!result.summary.includes(sentence), result.summary);
    }
    assert.match(harness.logLines.find((line) => line.includes('tool update_room'))!, /: ValidationFailed, /);
    assert.equal(
      sentence,
      'alfaview saves the other fields of this call before the waiting room, so they may be saved: check with get_room before you call again.',
    );
  });

  it('says that the change is saved when reading the room back fails', async () => {
    const harness = await adminHarness([
      loginRequest(),
      patch({ passcodeRequired: true }),
      readBack(fixture('core/problem-500.json'), 503, ROOM_ID),
    ]);
    const result = await harness.call('update_room', {
      roomId: ROOM_ID.toUpperCase(),
      passcodeRequired: true,
    });
    await harness.done();

    assert.equal(result.summary, roomUpdatedButNotReadMessage(ROOM_ID));
    assert.equal(
      result.summary,
      `alfaview saved the change to room ${ROOM_ID}, but reading it back failed. Use get_room with this ID to read the room.`,
    );
    assert.match(harness.logLines.at(-1)!, /: ServerError, 3 requests/);
  });
});

describe('delete_room', () => {
  /** The name of rooms/room.json. */
  const NAME = 'Advisory Room Anna Example';
  const INPUT = { roomId: ROOM_ID, confirmRoomName: NAME };
  const MEETING_ID = '7e9a1c3d-5b2f-5a4e-8c6d-22f0a1b2c3d4';
  const DEPARTMENT_ID = '9c8b7a6d-5e4f-5a3b-8c2d-201f0e9d8c7b';

  function fullHarness(expected: readonly ExpectedRequest[]) {
    return toolHarness(FULL_ROOM_TOOLS, expected);
  }

  const deleteRequest = (respond: FakeAnswer = { status: 204 }, id = ROOM_ID): ExpectedRequest => ({
    method: 'DELETE',
    path: `/v2/rooms/${id}`,
    respond,
  });

  it('is listed at the level full with its title and annotations', async () => {
    const harness = await fullHarness([]);
    const { tools } = await harness.client.listTools();
    await harness.done();

    assert.deepEqual(
      tools.map((tool) => [tool.name, tool.title, tool.annotations]),
      [['delete_room', 'Delete a room', IDEMPOTENT_CHANGE_ANNOTATIONS]],
    );
    assert.deepEqual(
      FULL_ROOM_TOOLS.map((tool) => tool.level),
      ['full'],
    );
    // The server asks the person, and confirmRoomName is the optional fallback of a client that
    // cannot ask.
    assert.equal(
      tools[0]!.description,
      'Cannot be undone: deletes an alfaview room or department. alfaview disconnects everyone in it and deletes its breakout rooms, guest links, group links, files and polls. The server asks the person to confirm. Meeting rooms are refused: use cancel_meeting.',
    );
    const properties = tools[0]!.inputSchema.properties as Record<string, { description: string }>;
    assert.equal(properties.confirmRoomName!.description, CONFIRM_ROOM_NAME_TEXT);
    assert.equal(
      CONFIRM_ROOM_NAME_TEXT,
      'Only for a client that cannot ask the person: the room name, as the person named it (any case).',
    );
    assert.deepEqual((tools[0]!.inputSchema as { required?: string[] }).required, ['roomId']);
  });

  it('reads the room, then deletes it with the name of a client that cannot ask', async () => {
    const harness = await fullHarness([loginRequest(), roomRequest(fixture('rooms/room.json')), deleteRequest()]);
    const result = await harness.call('delete_room', INPUT);
    await harness.done();

    assert.equal(result.summary, `Deleted room ${ROOM_ID} for good.`);
    assert.deepEqual(result.data, {
      roomId: ROOM_ID,
      type: 'room',
      deleted: true,
      confirmation: 'parameter',
      warnings: [],
    });
    assert.match(
      harness.logLines.at(-1)!,
      /tool delete_room: ok, confirmed by the parameter, 3 requests, /,
    );
  });

  it('reports a room that alfaview cannot find, without a delete', async () => {
    const harness = await fullHarness([loginRequest(), roomRequest(fixture('core/problem-404.json'), 404)]);
    const result = await harness.call('delete_room', INPUT);
    await harness.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, ROOM_DELETE_NOT_FOUND_MESSAGE);
    assert.equal(
      ROOM_DELETE_NOT_FOUND_MESSAGE,
      "alfaview could not find the room, so nothing was deleted. The room is already deleted, or the API key's user cannot see it.",
    );
    assert.match(harness.logLines.at(-1)!, /: NotFound, 2 requests, /);
  });

  it('refuses a meeting room after the read, without a delete', async () => {
    const meetingRoom = { id: MEETING_ID, displayName: 'Review', type: 'meeting', managed: true };
    const harness = await fullHarness([
      loginRequest(),
      roomRequest(meetingRoom, 200, `/v2/rooms/${MEETING_ID}`),
    ]);
    const result = await harness.call('delete_room', { roomId: MEETING_ID, confirmRoomName: 'Review' });
    await harness.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, MEETING_ROOM_DELETE_MESSAGE);
    assert.equal(
      MEETING_ROOM_DELETE_MESSAGE,
      'This is the room of a meeting, and alfaview does not delete meeting rooms. Cancel the meeting with cancel_meeting.',
    );
    assert.match(harness.logLines.at(-1)!, /: MeetingRoomRefused, 2 requests, /);
  });

  it('refuses a wrong name without naming the room, and without a delete', async () => {
    const harness = await fullHarness([loginRequest(), roomRequest(fixture('rooms/room.json'))]);
    const result = await harness.call('delete_room', { ...INPUT, confirmRoomName: 'Advisory Room' });
    await harness.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, confirmRoomNameMessage(ROOM_ID));
    assert.equal(
      result.summary,
      `confirmRoomName is not the name of room ${ROOM_ID}, so nothing was deleted. Check with get_room that this is the room to delete.`,
    );
    assert.ok(!result.summary.includes(NAME));
    assert.match(harness.logLines.at(-1)!, /: ConfirmationMismatch, 2 requests, /);
  });

  it('matches the name in another case and with spaces', async () => {
    const room = { ...fixture<Json>('rooms/room.json'), displayName: `  ${NAME} ` };
    const harness = await fullHarness([loginRequest(), roomRequest(room), deleteRequest()]);
    const result = await harness.call('delete_room', {
      ...INPUT,
      confirmRoomName: ' advisory ROOM anna example ',
    });
    await harness.done();

    assert.equal(result.isError, false, result.summary);
  });

  it('refuses a room without a name, also with its ID as the name, without a delete', async () => {
    const room = fixture<Json>('rooms/room.json');
    const harness = await fullHarness([
      loginRequest(),
      roomRequest({ ...room, displayName: '' }),
      roomRequest({ ...room, displayName: '   ' }),
      roomRequest({ ...room, displayName: undefined }),
    ]);
    const results = [
      await harness.call('delete_room', INPUT),
      await harness.call('delete_room', { ...INPUT, confirmRoomName: ROOM_ID }),
      await harness.call('delete_room', { ...INPUT, confirmRoomName: ROOM_ID }),
    ];
    await harness.done();

    for (const result of results) {
      assert.equal(result.isError, true);
      assert.equal(result.summary, unnamedRoomMessage(ROOM_ID));
    }
    assert.equal(
      results[0]!.summary,
      `Room ${ROOM_ID} has no name, so nothing was deleted. Give it a name with update_room first, then confirm with that name.`,
    );
  });

  it('deletes a department with the warning that its rooms stay', async () => {
    const department = { id: DEPARTMENT_ID, displayName: 'Advisors', type: 'department', managed: false };
    const harness = await fullHarness([
      loginRequest(),
      roomRequest(department, 200, `/v2/rooms/${DEPARTMENT_ID}`),
      deleteRequest(undefined, DEPARTMENT_ID),
    ]);
    const result = await harness.call('delete_room', { roomId: DEPARTMENT_ID, confirmRoomName: 'advisors' });
    await harness.done();

    assert.equal(result.summary, `Deleted department ${DEPARTMENT_ID} for good. ${DEPARTMENT_DELETE_WARNING}`);
    assert.deepEqual(result.data, {
      roomId: DEPARTMENT_ID,
      type: 'department',
      deleted: true,
      confirmation: 'parameter',
      warnings: [DEPARTMENT_DELETE_WARNING],
    });
    assert.equal(
      DEPARTMENT_DELETE_WARNING,
      'This was a department. alfaview deletes the department only: the rooms in it are not deleted.',
    );
  });

  it('gives the messages of a 403 and a 422 of the delete', async () => {
    const harness = await fullHarness([
      loginRequest(),
      roomRequest(fixture('rooms/room.json')),
      deleteRequest({ status: 403, body: fixture('core/problem-403.json') }),
      roomRequest(fixture('rooms/room.json')),
      deleteRequest({ status: 422, body: { title: 'Unprocessable Entity', detail: 'ACTION_INVALID' } }),
    ]);
    const forbidden = await harness.call('delete_room', INPUT);
    const invalid = await harness.call('delete_room', INPUT);
    await harness.done();

    assert.match(forbidden.summary, /^The API key's user is not allowed to do this/);
    assert.equal(invalid.summary, 'alfaview could not process the input: ACTION_INVALID.');
  });

  it('reads and deletes an uppercase roomId in lowercase', async () => {
    const harness = await fullHarness([loginRequest(), roomRequest(fixture('rooms/room.json')), deleteRequest()]);
    const result = await harness.call('delete_room', { ...INPUT, roomId: ROOM_ID.toUpperCase() });
    await harness.done();

    assert.equal(result.data.roomId, ROOM_ID);
  });

  it('refuses a room name in place of the ID with the message without a meeting ID', async () => {
    const harness = await fullHarness([]);
    const result = await harness.call('delete_room', { ...INPUT, roomId: NAME });
    await harness.done();

    assert.equal(result.isError, true);
    assert.match(result.summary, /roomId takes a room ID from find_rooms, not a name or a meeting ID\./);
  });
});
