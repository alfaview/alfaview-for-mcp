import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BREAKOUT_ROOM_ID_MISSING_MESSAGE,
  BREAKOUT_ROOM_LIST_MESSAGE,
  BREAKOUT_ROOM_UNCERTAIN_MESSAGE,
  breakoutRoomNotFoundMessage,
  changedFeatures,
  CREATE_ROOM_DENIED_MESSAGE,
  createRoom,
  createSubroom,
  deleteRoom,
  deleteSubroom,
  FEATURE_STATE_VALUES,
  featureChange,
  findRoomsByName,
  getRoom,
  listRooms,
  listRoomTypes,
  listSubrooms,
  mapBreakoutRoom,
  mapRoom,
  mapRoomSummary,
  planRoomTypeQuotas,
  ROOM_TYPE_LIST_MESSAGE,
  roomTypeNames,
  unknownPlanRoomTypeMessage,
  updateRoom,
  updateRoomFeatures,
  updateSubroom,
  WELCOME_NOTE_MAX_CHARACTERS,
  welcomeNoteProblem,
  type ApiRoom,
  type RoomSummary,
} from '../../src/domain/rooms.ts';
import { FEATURE_KEYS, type ApiRoomType } from '../../src/shared/rooms.ts';
import { loginRequest, testApi, toolErrorOf } from '../helpers/fakeFetch.ts';
import { fixture } from '../helpers/fixtures.ts';

const ROOM_ID = '0b7c5d2e-91a4-5f3b-8e27-0f4a6c9d1e22';
const BERLIN = 'Europe/Berlin';

const room = () => fixture<ApiRoom>('rooms/room.json');
const sparseRoom = () => fixture<ApiRoom>('rooms/room-sparse.json');

describe('mapRoom', () => {
  it('maps a full room to exactly the documented Room output, in the documented key order', () => {
    const output = mapRoom(room(), BERLIN);
    assert.deepEqual(output, {
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
    });
    assert.deepEqual(Object.keys(output), [
      'id',
      'displayName',
      'type',
      'parentId',
      'waitingRoomEnabled',
      'passcodeRequired',
      'waitingRoomWelcomeNote',
      'managed',
      'createdAt',
      'quotas',
      'features',
      'subrooms',
      'passcode',
    ]);
  });

  it('leaves out the permission arrays, the default permissions, sort and creator', () => {
    const output = mapRoom(room(), BERLIN) as Record<string, unknown>;
    for (const key of [
      'userPermissions',
      'guestLinkPermissions',
      'groupLinkPermissions',
      'defaultPermissions',
      'sort',
      'createdBy',
    ]) {
      assert.ok(!(key in output), key);
    }
  });

  it('carries the passcode that the caller read', () => {
    assert.equal(mapRoom(room(), BERLIN, 'Kx7#mQ2p').passcode, 'Kx7#mQ2p');
  });

  it('gives null for absent, empty and year-1 values', () => {
    const output = mapRoom(sparseRoom(), BERLIN);
    assert.deepEqual(
      {
        parentId: output.parentId,
        createdAt: output.createdAt,
        waitingRoomWelcomeNote: output.waitingRoomWelcomeNote,
        passcodeRequired: output.passcodeRequired,
        managed: output.managed,
        quotas: output.quotas,
        features: output.features,
      },
      {
        parentId: '8e1f2a3b-4c5d-5e6f-8a7b-9c0d1e2f3a4b',
        createdAt: null,
        waitingRoomWelcomeNote: null,
        passcodeRequired: null,
        managed: true,
        quotas: null,
        features: { disableCameraOff: 'enabled', localRecording: 'disabled' },
      },
    );
  });

  it('sorts subrooms[] by sort order, then by ID, with null for a missing name', () => {
    assert.deepEqual(mapRoom(sparseRoom(), BERLIN).subrooms, [
      { id: 'a1b2c3d4-e5f6-5a7b-8c9d-0e1f2a3b4c5d', displayName: null },
      { id: 'a9b8c7d6-e5f4-5a3b-8c2d-1e0f9a8b7c6d', displayName: 'Group C' },
      { id: 'b1c2d3e4-f5a6-5b7c-8d9e-0f1a2b3c4d5e', displayName: 'Group B' },
    ]);
  });

  it('turns missing subrooms[] and features into an empty list and no features', () => {
    const output = mapRoom({ ...sparseRoom(), subrooms: null, features: null }, BERLIN);
    assert.deepEqual(output.subrooms, []);
    assert.deepEqual(output.features, {});
  });

  it('leaves out each entry of subrooms[] without an ID', () => {
    const subrooms = [{ sort: 1 }, null, { id: 's1', sort: 2 }] as unknown as ApiRoom['subrooms'];
    assert.deepEqual(mapRoom({ id: 'r1', subrooms }, BERLIN).subrooms, [
      { id: 's1', displayName: null },
    ]);
  });

  it('gives createdAt in the given time zone', () => {
    assert.equal(mapRoom(room(), 'UTC').createdAt, '2026-09-01T08:30:00+00:00');
  });
});

describe('mapRoomSummary', () => {
  it('maps a listed room to the summary keys only', () => {
    const listed = fixture('core/rooms-page-1.json').data[1] as ApiRoom;
    assert.deepEqual(mapRoomSummary(listed), {
      id: '5a6b7c8d-9e0f-5a1b-8c2d-3e4f5a6b7c8d',
      displayName: 'Webinar Room',
      type: 'room',
      parentId: null,
      waitingRoomEnabled: false,
      passcodeRequired: null,
    });
  });
});

describe('changedFeatures', () => {
  it('keeps every state other than default, in the order of the schema', () => {
    assert.deepEqual(
      changedFeatures({
        localRecording: 'disabled',
        raiseHands: 'default',
        disableCameraOff: 'enabled',
        liveStreaming: 'forced',
      }),
      { disableCameraOff: 'enabled', localRecording: 'disabled', liveStreaming: 'forced' },
    );
  });

  it('ignores unknown features and states that are not text', () => {
    const features = { unknownFeature: 'enabled', raiseHands: 1, blockWebclient: '' };
    assert.deepEqual(changedFeatures(features as unknown as ApiRoom['features']), {});
    assert.deepEqual(changedFeatures(undefined), {});
  });
});

describe('findRoomsByName', () => {
  const summary = (id: string, displayName: string | null): RoomSummary => ({
    id,
    displayName,
    type: 'room',
    parentId: null,
    waitingRoomEnabled: null,
    passcodeRequired: null,
  });
  const rooms = [
    summary('r1', 'Advisory Room Ben'),
    summary('r2', 'advisory room'),
    summary('r3', 'Webinar Room'),
    summary('r4', 'ADVISORY ROOM'),
    summary('r5', 'Old Advisory Room Anna'),
    summary('r6', null),
  ];

  it('gives exact name matches first, then names that contain the text, any case', () => {
    assert.deepEqual(
      findRoomsByName(rooms, ' Advisory Room ').map((room) => room.id),
      ['r2', 'r4', 'r1', 'r5'],
    );
  });

  it('orders rooms with the same name, case and accents ignored, by ID', () => {
    const same = [summary('r-b', 'Team'), summary('r-c', 'Téam'), summary('r-a', 'team')];
    assert.deepEqual(
      findRoomsByName(same, undefined).map((room) => room.id),
      ['r-a', 'r-b', 'r-c'],
    );
  });

  it('gives every room sorted by name without a name, a room without a name first', () => {
    assert.deepEqual(
      findRoomsByName(rooms, undefined).map((room) => room.id),
      ['r6', 'r2', 'r4', 'r1', 'r5', 'r3'],
    );
  });

  it('gives an empty list when nothing matches', () => {
    assert.deepEqual(findRoomsByName(rooms, 'Kitchen'), []);
  });
});

describe('welcomeNoteProblem', () => {
  const PROBLEM =
    'note can have at most 300 characters on one line, with letters, digits, punctuation, symbols and plain spaces only.';

  it('takes letters, marks, digits, punctuation, symbols and plain spaces', () => {
    for (const note of [
      'Welcome. Your advisor will let you in shortly.',
      'Willkommen, bitte warten Sie. Grüße! (2026) €5 + 10% = ?',
      // A letter with a combining mark.
      'e\u{301}té 你好 مرحبا',
      // A combined emoji: the joiner between two characters.
      'Running \u{1F3C3}\u{1F3FB}\u{200D}\u{2640}\u{FE0F}',
    ]) {
      assert.equal(welcomeNoteProblem(note, 'note'), undefined, note);
    }
  });

  it('counts characters, not UTF-16 units, up to 300', () => {
    assert.equal(WELCOME_NOTE_MAX_CHARACTERS, 300);
    assert.equal(welcomeNoteProblem('a'.repeat(300), 'note'), undefined);
    assert.equal(welcomeNoteProblem('\u{1F600}'.repeat(300), 'note'), undefined);
    assert.equal(welcomeNoteProblem('a'.repeat(301), 'note'), PROBLEM);
    assert.equal(welcomeNoteProblem('\u{1F600}'.repeat(301), 'note'), PROBLEM);
  });

  it('refuses line breaks, tabs, other spaces, control and format characters and lone surrogates', () => {
    for (const note of [
      'one\ntwo',
      'one\r\ntwo',
      'one\ttwo',
      'no\u{A0}break',
      'thin\u{2009}space',
      'line\u{2028}separator',
      'bell\u0007',
      'soft\u{AD}hyphen',
      'mark\u{200E}ltr',
      'lone \ud83d surrogate',
      'private \u{E000} use',
    ]) {
      assert.equal(welcomeNoteProblem(note, 'note'), PROBLEM, JSON.stringify(note));
    }
  });

  it('refuses the joiner at the start, at the end and twice in a row', () => {
    for (const note of ['\u{200D}start', 'end\u{200D}', 'a\u{200D}\u{200D}b', '\u{200D}']) {
      assert.equal(welcomeNoteProblem(note, 'note'), PROBLEM, JSON.stringify(note));
    }
  });

  it('names the parameter of its caller', () => {
    assert.match(welcomeNoteProblem('one\ntwo', 'waitingRoomWelcomeNote')!, /^waitingRoomWelcomeNote can have/);
  });
});

describe('room types of the plan', () => {
  const types = () => fixture<ApiRoomType[]>('rooms/room-types.json');

  it('roomTypeNames gives the names smallest first, without empty names', () => {
    assert.deepEqual(roomTypeNames(types()), ['Advisory', 'Webinar']);
    assert.deepEqual(roomTypeNames([{ name: '' }, { name: '  ' }]), []);
    assert.deepEqual(roomTypeNames([]), []);
  });

  it('unknownPlanRoomTypeMessage lists the names, or says that the plan has none', () => {
    assert.equal(
      unknownPlanRoomTypeMessage('Seminar', ['Advisory', 'Webinar']),
      'Your alfaview plan has no room type named Seminar. Its room types: Advisory, Webinar.',
    );
    assert.equal(
      unknownPlanRoomTypeMessage('Seminar', []),
      'Your alfaview plan has no room types. Leave out planRoomType.',
    );
  });

  it('listRoomTypes reads GET /v2/room-types: null gives none, a body that is no list fails', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'GET', path: '/v2/room-types', respond: { status: 200, body: types() } },
      { method: 'GET', path: '/v2/room-types', respond: { status: 200, body: 'null' } },
      { method: 'GET', path: '/v2/room-types', respond: { status: 200, body: { data: [] } } },
    ]);
    assert.deepEqual(
      (await listRoomTypes(api)).map((type) => type.name),
      ['Webinar', '', 'Advisory'],
    );
    assert.deepEqual(await listRoomTypes(api), []);
    const error = await toolErrorOf(listRoomTypes(api));
    assert.deepEqual([error.code, error.message], ['InvalidResponse', ROOM_TYPE_LIST_MESSAGE]);
    fake.assertDone();
  });

  it('planRoomTypeQuotas prefers the exact name to a name in another case', async () => {
    const both = [
      { name: 'webinar', maxActiveParticipants: 5, maxSpectatorOnlyParticipants: 5 },
      ...types(),
    ];
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'GET', path: '/v2/room-types', respond: { status: 200, body: both } },
    ]);
    assert.deepEqual(await planRoomTypeQuotas(api, 'Webinar'), {
      activeParticipants: 50,
      spectatorOnlyParticipants: 450,
      maxVideoTilesPerPage: 0,
    });
    fake.assertDone();
  });
});

describe('room writes', () => {
  const create = (respond: Record<string, unknown>) => ({
    method: 'POST',
    path: '/v2/rooms',
    body: { displayName: 'Project Room', type: 'room', waitingRoomEnabled: false },
    respond: respond as { status: number; body?: unknown },
  });
  const room = { displayName: 'Project Room', type: 'room', waitingRoomEnabled: false } as const;

  it('createRoom gives the ID of the new room, and leaves out the fields that are not set', async () => {
    const { api, fake } = testApi([loginRequest(), create({ status: 201, body: { id: 'new-room' } })]);
    assert.equal(await createRoom(api, room), 'new-room');
    fake.assertDone();
  });

  it('createRoom names the user permission for a 403 and keeps every other error', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      create({ status: 403, body: fixture('core/problem-403.json') }),
      create({ status: 400, body: fixture('core/problem-400.json') }),
      create({ status: 201, body: { id: '' } }),
    ]);
    const forbidden = await toolErrorOf(createRoom(api, room));
    const refused = await toolErrorOf(createRoom(api, room));
    const empty = await toolErrorOf(createRoom(api, room));
    fake.assertDone();

    assert.deepEqual(
      [forbidden.code, forbidden.message, forbidden.status],
      ['Forbidden', CREATE_ROOM_DENIED_MESSAGE, 403],
    );
    assert.equal(
      CREATE_ROOM_DENIED_MESSAGE,
      "alfaview refused the room. The API key's user needs the user permission Create Rooms or Room Admin.",
    );
    assert.equal(refused.code, 'BadRequest');
    assert.deepEqual(
      [empty.code, empty.message, empty.status],
      ['InvalidResponse', 'alfaview did not return the ID of the new room.', 201],
    );
  });

  it('updateRoom sends PATCH /v2/rooms/{id} with the ID in lowercase and the change as it is', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      {
        method: 'PATCH',
        path: `/v2/rooms/${ROOM_ID}`,
        body: { waitingRoomEnabled: true },
        respond: { status: 204 },
      },
    ]);
    await updateRoom(api, ROOM_ID.toUpperCase(), { waitingRoomEnabled: true });
    fake.assertDone();
  });
});

describe('feature changes', () => {
  it('featureChange gives the given states in the order of the features', () => {
    const change = featureChange({ examScreenshare: 'enabled', raiseHands: 'default', disableCameraOff: 'disabled' }, false);
    assert.deepEqual(change, { disableCameraOff: 'disabled', raiseHands: 'default', examScreenshare: 'enabled' });
    assert.deepEqual(Object.keys(change), ['disableCameraOff', 'raiseHands', 'examScreenshare']);
  });

  it('featureChange gives default for every other feature with a reset', () => {
    const change = featureChange({ blockWebclient: 'disabled' }, true);
    assert.deepEqual(Object.keys(change), [...FEATURE_KEYS]);
    assert.equal(change.blockWebclient, 'disabled');
    assert.deepEqual(
      Object.entries(change).filter(([key]) => key !== 'blockWebclient').map(([, state]) => state),
      Array.from({ length: 13 }, () => 'default'),
    );
    assert.deepEqual(featureChange(undefined, true), featureChange({}, true));
  });

  it('featureChange gives an empty change without states and without a reset', () => {
    assert.deepEqual(featureChange(undefined, false), {});
    assert.deepEqual(featureChange({}, false), {});
  });

  it('takes the API values of a feature state', () => {
    assert.deepEqual(FEATURE_STATE_VALUES, ['enabled', 'disabled', 'default']);
  });

  it('updateRoomFeatures sends PATCH with the ID in lowercase and the change as it is', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      {
        method: 'PATCH',
        path: `/v2/rooms/${ROOM_ID}/features`,
        body: { raiseHands: 'default', examScreenshare: 'enabled' },
        respond: { status: 204 },
      },
    ]);
    await updateRoomFeatures(api, ROOM_ID.toUpperCase(), { raiseHands: 'default', examScreenshare: 'enabled' });
    fake.assertDone();
  });
});

describe('room requests', () => {
  it('getRoom reads GET /v2/rooms/{id} with the ID in lowercase', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'GET', path: `/v2/rooms/${ROOM_ID}`, respond: { status: 200, body: room() } },
    ]);
    assert.equal((await getRoom(api, ROOM_ID.toUpperCase())).id, ROOM_ID);
    fake.assertDone();
  });

  it('getRoom fails with InvalidResponse when the body is not a room', async () => {
    for (const body of [{}, [], 'null', { id: 7 }]) {
      const { api, fake } = testApi([
        loginRequest(),
        { method: 'GET', path: `/v2/rooms/${ROOM_ID}`, respond: { status: 200, body } },
      ]);
      const error = await toolErrorOf(getRoom(api, ROOM_ID));
      assert.deepEqual([error.code, error.message], [
        'InvalidResponse',
        'alfaview did not return the room.',
      ]);
      fake.assertDone();
    }
  });

  it('getRoom shows a 404 as NotFound without allowNotFound', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'GET', path: `/v2/rooms/${ROOM_ID}`, respond: { status: 404 } },
    ]);
    const error = await toolErrorOf(getRoom(api, ROOM_ID));
    assert.deepEqual([error.code, error.message], [
      'NotFound',
      "alfaview could not find the room. It was deleted, or the API key's user cannot see it.",
    ]);
    fake.assertDone();
  });

  it('getRoom with allowNotFound gives undefined for a 404 and shows other errors', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'GET', path: `/v2/rooms/${ROOM_ID}`, respond: { status: 404 } },
      { method: 'GET', path: `/v2/rooms/${ROOM_ID}`, respond: { status: 403 } },
      { method: 'GET', path: `/v2/rooms/${ROOM_ID}`, respond: { status: 200, body: room() } },
    ]);
    assert.equal(await getRoom(api, ROOM_ID, { allowNotFound: true }), undefined);
    assert.equal((await toolErrorOf(getRoom(api, ROOM_ID, { allowNotFound: true }))).code, 'Forbidden');
    assert.equal((await getRoom(api, ROOM_ID, { allowNotFound: true }))?.id, ROOM_ID);
    fake.assertDone();
  });

  it('listRooms reads all pages of one room type with 50 per page', async () => {
    const first = fixture('core/rooms-page-1.json');
    const second = fixture('core/rooms-page-2.json');
    second.data.push({ displayName: 'no ID' });
    const { api, fake } = testApi([
      loginRequest(),
      {
        method: 'GET',
        path: '/v2/rooms',
        query: { roomTypes: 'department', limit: '50' },
        respond: { status: 200, body: first },
      },
      {
        method: 'GET',
        path: '/v2/rooms',
        query: { roomTypes: 'department', limit: '50', pageToken: 'c2Vjb25kLXBhZ2U' },
        respond: { status: 200, body: second },
      },
    ]);
    const rooms = await listRooms(api, 'department');
    assert.deepEqual(
      rooms.map((entry) => entry.id),
      [
        '0b7c5d2e-91a4-5f3b-8e27-0f4a6c9d1e22',
        '5a6b7c8d-9e0f-5a1b-8c2d-3e4f5a6b7c8d',
        '8e1f2a3b-4c5d-5e6f-9a0b-1c2d3e4f5a6b',
      ],
    );
    fake.assertDone();
  });

  it('deleteRoom sends DELETE /v2/rooms/{id} with the ID in lowercase', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'DELETE', path: `/v2/rooms/${ROOM_ID}`, respond: { status: 204 } },
    ]);
    await deleteRoom(api, ROOM_ID.toUpperCase());
    fake.assertDone();
  });
});

describe('breakout rooms', () => {
  const SUBROOM_ID = '2d4f6a8c-1e3b-5d7f-9a0c-2e4f6a8c0e11';
  const SUBROOMS_PATH = `/v2/rooms/${ROOM_ID}/subrooms`;
  const SUBROOM_PATH = `${SUBROOMS_PATH}/${SUBROOM_ID}`;

  it('mapBreakoutRoom gives the ID, the room ID in lowercase and the name, without the sort order', () => {
    const output = mapBreakoutRoom(ROOM_ID.toUpperCase(), { id: SUBROOM_ID, sort: 1, displayName: 'Breakout 1' });
    assert.deepEqual(output, { id: SUBROOM_ID, roomId: ROOM_ID, displayName: 'Breakout 1' });
    assert.deepEqual(Object.keys(output), ['id', 'roomId', 'displayName']);
  });

  it('mapBreakoutRoom gives null for a missing or empty name, which alfaview shows as a numbered name', () => {
    assert.equal(mapBreakoutRoom(ROOM_ID, { id: SUBROOM_ID }).displayName, null);
    assert.equal(mapBreakoutRoom(ROOM_ID, { id: SUBROOM_ID, displayName: '' }).displayName, null);
  });

  it('listSubrooms reads the list with the room ID in lowercase: null gives none, a body that is no list fails', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'GET', path: SUBROOMS_PATH, respond: { status: 200, body: fixture('rooms/subrooms.json') } },
      { method: 'GET', path: SUBROOMS_PATH, respond: { status: 200, body: 'null' } },
      { method: 'GET', path: SUBROOMS_PATH, respond: { status: 200 } },
      { method: 'GET', path: SUBROOMS_PATH, respond: { status: 200, body: { data: [] } } },
      { method: 'GET', path: SUBROOMS_PATH, respond: { status: 404 } },
    ]);
    assert.deepEqual(
      (await listSubrooms(api, ROOM_ID.toUpperCase())).map((subroom) => subroom.id),
      ['4e5f6a7b-8c9d-5e0f-9a1b-2c3d4e5f6a7b', SUBROOM_ID],
    );
    assert.deepEqual(await listSubrooms(api, ROOM_ID), []);
    assert.deepEqual(await listSubrooms(api, ROOM_ID), []);
    const unexpected = await toolErrorOf(listSubrooms(api, ROOM_ID));
    const missing = await toolErrorOf(listSubrooms(api, ROOM_ID));
    fake.assertDone();

    assert.deepEqual([unexpected.code, unexpected.message], ['InvalidResponse', BREAKOUT_ROOM_LIST_MESSAGE]);
    assert.deepEqual([missing.code, missing.message], [
      'NotFound',
      "alfaview could not find the room. It was deleted, or the API key's user cannot see it.",
    ]);
  });

  it('createSubroom sends the name, or an empty body, and gives the ID of the new breakout room', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      {
        method: 'POST',
        path: SUBROOMS_PATH,
        body: { displayName: 'Breakout 3' },
        respond: { status: 201, body: { id: SUBROOM_ID } },
      },
      { method: 'POST', path: SUBROOMS_PATH, body: {}, respond: { status: 201, body: { id: SUBROOM_ID } } },
    ]);
    assert.equal(await createSubroom(api, ROOM_ID.toUpperCase(), 'Breakout 3'), SUBROOM_ID);
    assert.equal(await createSubroom(api, ROOM_ID, undefined), SUBROOM_ID);
    fake.assertDone();
  });

  it('createSubroom says that the breakout room may exist after an uncertain status and an answer without an ID', async () => {
    const create = (respond: { status: number; body?: unknown }) => ({
      method: 'POST',
      path: SUBROOMS_PATH,
      body: {},
      respond,
    });
    const { api, fake } = testApi([
      loginRequest(),
      create({ status: 502, body: fixture('core/problem-500.json') }),
      create({ status: 201, body: { id: 7 } }),
      create({ status: 201 }),
      create({ status: 403, body: fixture('core/problem-403.json') }),
    ]);
    const uncertain = await toolErrorOf(createSubroom(api, ROOM_ID, undefined));
    const notText = await toolErrorOf(createSubroom(api, ROOM_ID, undefined));
    const empty = await toolErrorOf(createSubroom(api, ROOM_ID, undefined));
    const forbidden = await toolErrorOf(createSubroom(api, ROOM_ID, undefined));
    fake.assertDone();

    assert.deepEqual(
      [uncertain.code, uncertain.message, uncertain.status],
      ['ServerError', BREAKOUT_ROOM_UNCERTAIN_MESSAGE, 502],
    );
    assert.deepEqual(
      [notText.code, notText.message, notText.status],
      ['InvalidResponse', BREAKOUT_ROOM_ID_MISSING_MESSAGE, 201],
    );
    assert.deepEqual([empty.code, empty.message], ['InvalidResponse', BREAKOUT_ROOM_ID_MISSING_MESSAGE]);
    assert.equal(forbidden.code, 'Forbidden');
  });

  it('updateSubroom always sends displayName, with both IDs in lowercase', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'PATCH', path: SUBROOM_PATH, body: { displayName: 'Beratung' }, respond: { status: 204 } },
    ]);
    await updateSubroom(api, ROOM_ID.toUpperCase(), SUBROOM_ID.toUpperCase(), 'Beratung');
    fake.assertDone();
  });

  it('deleteSubroom sends DELETE with both IDs in lowercase', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'DELETE', path: SUBROOM_PATH, respond: { status: 204 } },
    ]);
    await deleteSubroom(api, ROOM_ID.toUpperCase(), SUBROOM_ID.toUpperCase());
    fake.assertDone();
  });

  it('breakoutRoomNotFoundMessage names the breakout room, the room and the tool that lists them', () => {
    assert.equal(
      breakoutRoomNotFoundMessage(SUBROOM_ID, ROOM_ID),
      `alfaview could not find the breakout room ${SUBROOM_ID} in room ${ROOM_ID}, so nothing was deleted. get_room lists the breakout rooms of a room.`,
    );
  });
});
