// find_room_permissions, add_room_permission, update_room_permission and remove_room_permission
// through an MCP SDK client.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CANCELED_MESSAGE } from '../../src/alfaview/client.ts';
import { PROFILE_NOT_RETURNED_MESSAGE } from '../../src/domain/account.ts';
import {
  MEETING_ROOM_PERMISSION_MESSAGE,
  NO_PERMISSION_CHANGE_MESSAGE,
  ownAdminMessage,
  ownPermissionMessage,
  PERMISSION_CHANGE_NOT_READ_WARNING,
  PERMISSION_NOT_READ_WARNING,
  permissionExistsMessage,
  permissionNotFoundMessage,
  PERMISSIONS_UNEXPECTED_MESSAGE,
} from '../../src/domain/roomPermissions.ts';
import { NOT_A_USER_ID_MESSAGE } from '../../src/domain/users.ts';
import { createLogger } from '../../src/log.ts';
import { PERMISSION_INPUT_ORDER } from '../../src/shared/rooms.ts';
import {
  addRoomPermissionTool,
  findRoomPermissionsTool,
  FULL_ROOM_PERMISSION_TOOLS,
  ROOM_PERMISSION_TOOLS,
  UNNAMED_USERS_WARNING,
} from '../../src/tools/roomPermissions.ts';
import {
  ADD_ANNOTATIONS,
  IDEMPOTENT_CHANGE_ANNOTATIONS,
  READ_ANNOTATIONS,
  ROOM_PERMISSION_PARAMETERS,
  USER_ID_MESSAGE,
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
import { toolHarness } from '../helpers/mcpClient.ts';
import { noQuestions, outputOf } from '../helpers/toolContext.ts';

type Json = Record<string, unknown>;

/** The room of rooms/room.json. */
const ROOM_ID = '0b7c5d2e-91a4-5f3b-8e27-0f4a6c9d1e22';
const MEETING_ID = '7e9a1c3d-5b2f-5a4e-8c6d-22f0a1b2c3d4';

/** The users of rooms/permissions.json: an admin who is not in users/users.json, and Anna. */
const ADMIN_ENTRY_ID = '9a8b7c6d-5e4f-5a3b-9c2d-1e0f9a8b7c6d';
const ANNA_ID = '6c1d9e4f-2a7b-5c3d-9e8f-0a1b2c3d4e5f';

/** IDs of users in the form of alfaview: version 5 with the kind 18 (hex 12) in byte 10. */
const OWN_USER_ID = 'c0ffee00-0000-5000-8000-120000000001';
const TARGET_USER_ID = 'c0ffee00-0000-5000-8000-120000000002';
const OTHER_USER_ID = 'c0ffee00-0000-5000-8000-120000000003';

/** IDs that the tools refuse as a user ID: a guest link, a guest, the default permissions. */
const NOT_USER_IDS = [
  'c0ffee00-0000-5000-8000-140000000001',
  'c0ffee00-0000-5000-8000-180000000001',
  '11111111-1111-1111-1111-111111111111',
];

const FORBIDDEN = /^The API key's user is not allowed to do this/;
const ROOM_NOT_FOUND = "alfaview could not find the room. It was deleted, or the API key's user cannot see it.";

/** The permissions of the groups of rooms/permission-groups.json. */
const MODERATOR = {
  admin: false,
  voice: true,
  video: true,
  promote: true,
  join: true,
  screen: true,
  vip: true,
  chat: true,
  upload: true,
};
const PARTICIPANT = { ...MODERATOR, promote: false, vip: false };
const ADMIN = { ...MODERATOR, admin: true };

const PERMISSIONS_PATH = `/v2/rooms/${ROOM_ID}/permissions`;
const ENTRY_PATH = `${PERMISSIONS_PATH}/${TARGET_USER_ID}`;

function permissionsRequest(
  respond: FakeAnswer = { status: 200, body: fixture('rooms/permissions.json') },
  path = PERMISSIONS_PATH,
): ExpectedRequest {
  return { method: 'GET', path, respond };
}

function usersRequest(
  respond: FakeAnswer = { status: 200, body: fixture('users/users.json') },
): ExpectedRequest {
  return { method: 'GET', path: '/v2/users', respond };
}

function roomRequest(
  body: unknown = fixture('rooms/room.json'),
  status = 200,
  path = `/v2/rooms/${ROOM_ID}`,
): ExpectedRequest {
  return { method: 'GET', path, respond: { status, body } };
}

const MEETING_ROOM = { id: MEETING_ID, displayName: 'Review', type: 'meeting', managed: true };

/** The profile of the API key's user with the ID `id`. */
function profileRequest(
  id = OWN_USER_ID,
  respond: FakeAnswer = { status: 200, body: { ...fixture<Json>('core/user-profile.json'), id } },
): ExpectedRequest {
  return { method: 'GET', path: '/v2/users/me', respond };
}

function groupsRequest(body: unknown = fixture('rooms/permission-groups.json')): ExpectedRequest {
  return { method: 'GET', path: '/v2/permission-groups', respond: { status: 200, body } };
}

type Entry = [participantId: string, permissions: Json];

/** A permission list with the entries of users, and no guest link and group link entries. */
function permissionList(...entries: Entry[]): Json {
  return {
    userPermissions: entries.map(([participantId, permissions]) => ({ participantId, permissions })),
    guestLinkPermissions: null,
    groupLinkPermissions: null,
  };
}

/** The answer with permissionList. */
function permissionsOf(...entries: Entry[]): FakeAnswer {
  return { status: 200, body: permissionList(...entries) };
}

/** The output of an entry: the IDs, then the nine permissions in the order of the API. */
function entryOutput(userId: string, permissions: Json): Json {
  return {
    roomId: ROOM_ID,
    userId,
    admin: permissions.admin ?? null,
    voice: permissions.voice ?? null,
    video: permissions.video ?? null,
    promote: permissions.promote ?? null,
    join: permissions.join ?? null,
    screen: permissions.screen ?? null,
    vip: permissions.vip ?? null,
    chat: permissions.chat ?? null,
    upload: permissions.upload ?? null,
  };
}

/** The context of a direct call of `run`, for the tests of a cancel. */
function context(api: ToolContext['api'], signal: AbortSignal): ToolContext {
  return {
    api,
    now: Date.parse('2026-10-07T08:00:00Z'),
    timeZone: 'Europe/Berlin',
    signal,
    log: createLogger(() => undefined),
    personalData: 'include',
    level: 'full',
    confirmation: noQuestions(),
  };
}

describe('the room permission tools', () => {
  it('are listed in their fixed order, with their levels, titles and annotations', async () => {
    const tools = [...ROOM_PERMISSION_TOOLS, ...FULL_ROOM_PERMISSION_TOOLS];
    const harness = await toolHarness(tools, []);
    const { tools: listed } = await harness.client.listTools();
    await harness.done();

    assert.deepEqual(
      listed.map((tool) => [tool.name, tool.title, tool.annotations]),
      [
        ['find_room_permissions', 'Find room permissions', READ_ANNOTATIONS],
        ['add_room_permission', 'Add a room permission', ADD_ANNOTATIONS],
        ['update_room_permission', 'Change a room permission', IDEMPOTENT_CHANGE_ANNOTATIONS],
        ['remove_room_permission', 'Remove a room permission', IDEMPOTENT_CHANGE_ANNOTATIONS],
      ],
    );
    assert.deepEqual(
      tools.map((tool) => tool.level),
      ['manage', 'full', 'full', 'full'],
    );
    assert.deepEqual(ADD_ANNOTATIONS, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('give the nine permissions in the order of the form, with their descriptions', async () => {
    const harness = await toolHarness(FULL_ROOM_PERMISSION_TOOLS, []);
    const { tools } = await harness.client.listTools();
    await harness.done();

    assert.deepEqual(Object.keys(ROOM_PERMISSION_PARAMETERS), PERMISSION_INPUT_ORDER);
    const schema = tools[0]!.inputSchema as unknown as {
      properties: Record<string, { description: string }>;
    };
    const { properties } = schema;
    assert.deepEqual(Object.keys(properties), ['roomId', 'userId', 'permissionGroup', ...PERMISSION_INPUT_ORDER]);
    assert.deepEqual(
      PERMISSION_INPUT_ORDER.map((key) => properties[key]!.description),
      [
        'Can change and delete the room, its settings and guests.',
        'Can join the room.',
        'Can speak.',
        'Can send video.',
        'Can share the screen.',
        'Can chat.',
        'Can upload files.',
        'Can change the permissions of others.',
        'Can mark people as VIP.',
      ],
    );
    assert.deepEqual((tools[0]!.inputSchema as { required?: string[] }).required, [
      'roomId',
      'userId',
      'permissionGroup',
    ]);
    assert.deepEqual((tools[1]!.inputSchema as { required?: string[] }).required, ['roomId', 'userId']);
  });

  it('refuse a name in place of an ID, a meeting ID wording and the IDs that are no user IDs, before any request', async () => {
    const harness = await toolHarness([...ROOM_PERMISSION_TOOLS, ...FULL_ROOM_PERMISSION_TOOLS], []);
    const name = await harness.call('remove_room_permission', { roomId: ROOM_ID, userId: 'Anna Example' });
    const room = await harness.call('remove_room_permission', { roomId: 'Advisory Room', userId: TARGET_USER_ID });
    const results = [];
    for (const userId of NOT_USER_IDS) {
      results.push(await harness.call('find_room_permissions', { roomId: ROOM_ID, userId }));
      results.push(await harness.call('add_room_permission', { roomId: ROOM_ID, userId, permissionGroup: 'Moderator' }));
      results.push(await harness.call('update_room_permission', { roomId: ROOM_ID, userId, join: true }));
      results.push(await harness.call('remove_room_permission', { roomId: ROOM_ID, userId }));
    }
    await harness.done();

    assert.equal(name.isError, true);
    assert.match(name.summary, new RegExp(USER_ID_MESSAGE));
    assert.match(room.summary, /roomId takes a room ID from find_rooms, not a name or a meeting ID\./);
    for (const result of results) {
      assert.equal(result.isError, true);
      assert.equal(result.summary, NOT_A_USER_ID_MESSAGE);
    }
    assert.ok(harness.logLines.every((line) => /: InvalidInput, 0 requests, /.test(line)), harness.logLines.join(''));
  });

  // A model can send a user ID as roomId. The message of find_room_permissions says where each ID
  // goes, and the writes give the message of every other roomId parameter.
  it('refuse a user ID as roomId with the message that says where each ID goes, before any request', async () => {
    const harness = await toolHarness([...ROOM_PERMISSION_TOOLS, ...FULL_ROOM_PERMISSION_TOOLS], []);
    const find = await harness.call('find_room_permissions', { roomId: TARGET_USER_ID });
    const add = await harness.call('add_room_permission', {
      roomId: TARGET_USER_ID,
      userId: TARGET_USER_ID,
      permissionGroup: 'Moderator',
    });
    const guest = await harness.call('find_room_permissions', {
      roomId: 'c0ffee00-0000-5000-8000-180000000001',
    });
    await harness.done();

    assert.equal(
      find.summary,
      `Input validation error: Invalid arguments for tool find_room_permissions: roomId: roomId ${TARGET_USER_ID} is a user ID. find_room_permissions lists one room: give roomId from find_rooms and this ID as userId.`,
    );
    assert.match(
      add.summary,
      new RegExp(`roomId: roomId ${TARGET_USER_ID} is a user ID, not a room ID\\. Give a room ID from find_rooms\\.$`),
    );
    assert.match(guest.summary, /is the ID of a guest, not a room ID\. Give a room ID from find_rooms\.$/);
    assert.deepEqual(harness.logLines, []);
  });
});

describe('find_room_permissions', () => {
  function harness(expected: readonly ExpectedRequest[], options: { personalData?: 'include' | 'omit' } = {}) {
    return toolHarness(ROOM_PERMISSION_TOOLS, expected, options);
  }

  it('lists the users with a room permission by name, with their names, and counts the links', async () => {
    const tools = await harness([loginRequest(), permissionsRequest(), usersRequest()]);
    const result = await tools.call('find_room_permissions', { roomId: ROOM_ID });
    await tools.done();

    // The admin entry has no listed user, so the warning names the user permission List Users.
    assert.equal(
      result.summary,
      `Found 2 users with a room permission in room ${ROOM_ID}. 1 guest link and 0 group links have one too. Showing 1 to 2. ${UNNAMED_USERS_WARNING}`,
    );
    assert.deepEqual(Object.keys(result.data.permissions[0]), [
      'userId',
      'admin',
      'voice',
      'video',
      'promote',
      'join',
      'screen',
      'vip',
      'chat',
      'upload',
      'userName',
    ]);
    const { roomId: _anna, ...anna } = entryOutput(ANNA_ID, PARTICIPANT);
    const { roomId: _admin, ...admin } = entryOutput(ADMIN_ENTRY_ID, ADMIN);
    assert.deepEqual(result.data, {
      roomId: ROOM_ID,
      totalMatches: 2,
      offset: 0,
      nextOffset: null,
      guestLinkPermissionCount: 1,
      groupLinkPermissionCount: 0,
      permissions: [
        { ...anna, userName: 'Anna Example' },
        { ...admin, userName: null },
      ],
      warnings: [UNNAMED_USERS_WARNING],
    });
    assert.equal(
      UNNAMED_USERS_WARNING,
      "userName is null for a user whom alfaview did not list: the API key's user lacks the user permission List Users, or the user was deleted.",
    );
    assert.match(tools.logLines.at(-1)!, /tool find_room_permissions: ok, 3 requests, /);
  });

  it('reads no user list for a room without user entries', async () => {
    const empty = { userPermissions: null, guestLinkPermissions: [], groupLinkPermissions: [] };
    const tools = await harness([loginRequest(), permissionsRequest({ status: 200, body: empty })]);
    const result = await tools.call('find_room_permissions', { roomId: ROOM_ID });
    await tools.done();

    assert.equal(result.summary, `Found no users with a room permission in room ${ROOM_ID}.`);
    assert.deepEqual(result.data.permissions, []);
    assert.equal(result.data.totalMatches, 0);
    assert.equal(result.data.guestLinkPermissionCount, 0);
  });

  it('finds the entry of an uppercase userId, and says when the user has none, without the user list', async () => {
    const answer = permissionsOf([TARGET_USER_ID, PARTICIPANT], [OTHER_USER_ID, MODERATOR]);
    const users = [{ id: TARGET_USER_ID, firstName: 'Tara', lastName: 'Target' }];
    const tools = await harness([
      loginRequest(),
      permissionsRequest(answer),
      usersRequest({ status: 200, body: users }),
      permissionsRequest(answer),
    ]);
    const found = await tools.call('find_room_permissions', { roomId: ROOM_ID, userId: TARGET_USER_ID.toUpperCase() });
    const none = await tools.call('find_room_permissions', { roomId: ROOM_ID, userId: OWN_USER_ID.toUpperCase() });
    await tools.done();

    assert.equal(found.summary, `Found 1 user with a room permission in room ${ROOM_ID}. Showing 1 to 1.`);
    assert.deepEqual(
      found.data.permissions.map((entry: Json) => [entry.userId, entry.userName]),
      [[TARGET_USER_ID, 'Tara Target']],
    );
    assert.equal(none.summary, `User ${OWN_USER_ID} has no room permission in room ${ROOM_ID}.`);
    assert.deepEqual(none.data.permissions, []);
  });

  it('sorts by name in any case with the entries without a name last, then by user ID', async () => {
    const ids = ['c0ffee00-0000-5000-8000-120000000010', 'c0ffee00-0000-5000-8000-120000000011'];
    const answer = permissionsOf(
      [ids[1]!, PARTICIPANT],
      [OTHER_USER_ID.toUpperCase(), PARTICIPANT],
      [TARGET_USER_ID, PARTICIPANT],
      [ids[0]!, PARTICIPANT],
      [OWN_USER_ID, PARTICIPANT],
    );
    const users = [
      { id: TARGET_USER_ID, firstName: 'zoe', lastName: 'Zander' },
      { id: OWN_USER_ID, firstName: 'Anna', lastName: '' },
      { id: OTHER_USER_ID, firstName: 'anna', lastName: '' },
      { id: ids[0], firstName: '', lastName: '' },
    ];
    const tools = await harness([loginRequest(), permissionsRequest(answer), usersRequest({ status: 200, body: users })]);
    const result = await tools.call('find_room_permissions', { roomId: ROOM_ID });
    await tools.done();

    assert.deepEqual(
      result.data.permissions.map((entry: Json) => [entry.userId, entry.userName]),
      [
        [OTHER_USER_ID.toUpperCase(), 'anna'],
        [OWN_USER_ID, 'Anna'],
        [TARGET_USER_ID, 'zoe Zander'],
        [ids[0], null],
        [ids[1], null],
      ],
    );
  });

  it('gives null names and still a result when the user list fails or is no list', async () => {
    const tools = await harness([
      loginRequest(),
      permissionsRequest(),
      usersRequest({ status: 500, body: fixture('core/problem-500.json') }),
      permissionsRequest(),
      usersRequest({ status: 200, body: {} }),
    ]);
    const failed = await tools.call('find_room_permissions', { roomId: ROOM_ID });
    const unexpected = await tools.call('find_room_permissions', { roomId: ROOM_ID });
    await tools.done();

    for (const result of [failed, unexpected]) {
      assert.equal(result.isError, false, result.summary);
      assert.deepEqual(
        result.data.permissions.map((entry: Json) => entry.userName),
        [null, null],
      );
      assert.deepEqual(result.data.warnings, [UNNAMED_USERS_WARNING]);
    }
  });

  // With Leave out, each userName is null, which the description says, so the warning of a missing
  // name does not come.
  it('gives the warning of a missing name with Include only', async () => {
    const tools = await harness([loginRequest(), permissionsRequest(), usersRequest()], {
      personalData: 'omit',
    });
    const result = await tools.call('find_room_permissions', { roomId: ROOM_ID });
    await tools.done();

    // Only the warning of Leave out, for the names that it set to null.
    assert.deepEqual(result.data.warnings, [
      'This server leaves out personal data (option Personal data, Leave out): names are null, also where alfaview has a value.',
    ]);
    assert.ok(result.data.permissions.every((entry: Json) => entry.userName === null));
  });

  it('ends the call when it is canceled during the user list', async () => {
    const controller = new AbortController();
    const { api, fake } = testApi([loginRequest(), permissionsRequest(), usersRequest({ hang: true })], {
      signal: controller.signal,
    });
    const input = findRoomPermissionsTool.inputSchema.parse({ roomId: ROOM_ID });
    const run = findRoomPermissionsTool.run(input, context(api, controller.signal));
    await untilRequests(fake, 3);
    controller.abort();
    const error = await toolErrorOf(run);
    fake.assertDone();

    assert.deepEqual([error.code, error.message], ['Canceled', CANCELED_MESSAGE]);
  });

  it('gives the room message for a 404, and its message for an answer that is no object', async () => {
    const tools = await harness([
      loginRequest(),
      permissionsRequest({ status: 404, body: fixture('core/problem-404.json') }),
      permissionsRequest({ status: 200, body: [] }),
    ]);
    const missing = await tools.call('find_room_permissions', { roomId: ROOM_ID });
    const unexpected = await tools.call('find_room_permissions', { roomId: ROOM_ID });
    await tools.done();

    assert.equal(missing.isError, true);
    assert.equal(missing.summary, ROOM_NOT_FOUND);
    assert.equal(unexpected.summary, PERMISSIONS_UNEXPECTED_MESSAGE);
    assert.match(tools.logLines.at(-1)!, /: InvalidResponse, 1 request, /);
  });

  it('pages with limit and offset, and names each count only when one is not 0', async () => {
    const answer = {
      ...permissionList([TARGET_USER_ID, PARTICIPANT], [OTHER_USER_ID, PARTICIPANT], [OWN_USER_ID, PARTICIPANT]),
      groupLinkPermissions: [
        { participantId: 'g1', permissions: PARTICIPANT },
        { participantId: 'g2', permissions: PARTICIPANT },
      ],
    };
    const call = (): ExpectedRequest[] => [permissionsRequest({ status: 200, body: answer }), usersRequest()];
    const tools = await harness([loginRequest(), ...call(), ...call(), ...call()]);
    const first = await tools.call('find_room_permissions', { roomId: ROOM_ID, limit: 2 });
    const second = await tools.call('find_room_permissions', { roomId: ROOM_ID, limit: 2, offset: 2 });
    const beyond = await tools.call('find_room_permissions', { roomId: ROOM_ID, offset: 10 });
    await tools.done();

    const counts = '0 guest links and 2 group links have one too.';
    assert.equal(
      first.summary,
      `Found 3 users with a room permission in room ${ROOM_ID}. ${counts} Showing 1 to 2. Call again with offset 2 for the next ones. ${UNNAMED_USERS_WARNING}`,
    );
    assert.equal(first.data.nextOffset, 2);
    assert.equal(first.data.permissions.length, 2);
    assert.equal(
      second.summary,
      `Found 3 users with a room permission in room ${ROOM_ID}. ${counts} Showing 3 to 3. ${UNNAMED_USERS_WARNING}`,
    );
    assert.equal(second.data.nextOffset, null);
    assert.equal(beyond.summary, `Found 3 users with a room permission in room ${ROOM_ID}. ${counts} Nothing at offset 10.`);
    assert.equal(beyond.data.groupLinkPermissionCount, 2);
  });

  it('sends an uppercase roomId in lowercase and returns it so', async () => {
    const tools = await harness([loginRequest(), permissionsRequest(permissionsOf())]);
    const result = await tools.call('find_room_permissions', { roomId: ROOM_ID.toUpperCase() });
    await tools.done();

    assert.equal(result.data.roomId, ROOM_ID);
    assert.match(result.summary, new RegExp(`Found no users with a room permission in room ${ROOM_ID}\\.`));
  });

  it('refuses a limit above 100 without a request', async () => {
    const tools = await harness([]);
    const result = await tools.call('find_room_permissions', { roomId: ROOM_ID, limit: 101 });
    await tools.done();

    assert.equal(result.isError, true);
    assert.ok(findRoomPermissionsTool.inputSchema.safeParse({ roomId: ROOM_ID, limit: 100 }).success);
  });

  it('describes the names that Leave out removes in each mode', async () => {
    const descriptions: string[] = [];
    for (const personalData of ['include', 'omit'] as const) {
      const tools = await harness([], { personalData });
      const listed = await tools.client.listTools();
      await tools.done();
      descriptions.push(listed.tools[0]!.description ?? '');
    }

    assert.deepEqual(descriptions, [
      "Lists the users who have a room permission in an alfaview room, with the nine permissions of each, such as admin and join. A user without one gets the room's default permissions, if it has any. Guest links and group links are only counted.",
      "Lists the users who have a room permission in an alfaview room, with the nine permissions of each, such as admin and join. A user without one gets the room's default permissions, if it has any. Guest links and group links are only counted. This server leaves out personal data: userName is null.",
    ]);
  });
});

describe('add_room_permission', () => {
  const INPUT = { roomId: ROOM_ID, userId: TARGET_USER_ID, permissionGroup: 'Moderator' };

  function harness(expected: readonly ExpectedRequest[]) {
    return toolHarness(FULL_ROOM_PERMISSION_TOOLS, expected);
  }

  function addRequest(
    permissions: Json = MODERATOR,
    respond: FakeAnswer = { status: 204 },
    participantId = TARGET_USER_ID,
  ): ExpectedRequest {
    return { method: 'POST', path: PERMISSIONS_PATH, body: { participantId, permissions }, respond };
  }

  /** The requests up to the POST of a group without admin. */
  const before = (): ExpectedRequest[] => [roomRequest(), groupsRequest(), profileRequest()];

  it('reads the room, the groups and the API key\'s user, sends all nine permissions of the group and reads them back', async () => {
    const tools = await harness([
      loginRequest(),
      ...before(),
      addRequest(),
      permissionsRequest(permissionsOf([TARGET_USER_ID, MODERATOR])),
    ]);
    const result = await tools.call('add_room_permission', INPUT);
    await tools.done();

    assert.equal(
      result.summary,
      `Gave user ${TARGET_USER_ID} a room permission in room ${ROOM_ID} with join, voice, video, screen, chat, upload, promote and vip.`,
    );
    assert.deepEqual(result.data, {
      ...entryOutput(TARGET_USER_ID, MODERATOR),
      permissionGroupName: 'Moderator',
      warnings: [],
    });
    assert.match(tools.logLines.at(-1)!, /tool add_room_permission: ok, 6 requests, /);
  });

  it('lets a given permission override the one of the group, and shows the stored values', async () => {
    const sent = { ...PARTICIPANT, chat: false, vip: true };
    const stored = { ...sent, upload: false };
    const tools = await harness([
      loginRequest(),
      ...before(),
      addRequest(sent),
      permissionsRequest(permissionsOf([TARGET_USER_ID, stored])),
    ]);
    const result = await tools.call('add_room_permission', {
      ...INPUT,
      permissionGroup: 'Participant',
      chat: false,
      vip: true,
    });
    await tools.done();

    assert.deepEqual(result.data, { ...entryOutput(TARGET_USER_ID, stored), permissionGroupName: 'Participant', warnings: [] });
  });

  it('takes the group by name in any case and by ID in upper case', async () => {
    const tools = await harness([
      loginRequest(),
      ...before(),
      addRequest(),
      permissionsRequest(permissionsOf([TARGET_USER_ID, MODERATOR])),
      ...before(),
      addRequest(),
      permissionsRequest(permissionsOf([TARGET_USER_ID, MODERATOR])),
    ]);
    const byName = await tools.call('add_room_permission', { ...INPUT, permissionGroup: ' mODERATOR ' });
    const byId = await tools.call('add_room_permission', {
      ...INPUT,
      permissionGroup: 'C1A2B3C4-D5E6-5F70-8192-A3B4C5D6E7F8',
    });
    await tools.done();

    assert.equal(byName.data.permissionGroupName, 'Moderator');
    assert.equal(byId.data.permissionGroupName, 'Moderator');
  });

  it('refuses an unknown group and a name of two groups before the POST', async () => {
    const groups = fixture<Json[]>('rooms/permission-groups.json');
    const twice = [...groups, { ...groups[1], id: 'c1a2b3c4-d5e6-5f70-8192-a3b4c5d6e7f9' }];
    const tools = await harness([
      loginRequest(),
      roomRequest(),
      groupsRequest(),
      roomRequest(),
      groupsRequest(twice),
    ]);
    const unknown = await tools.call('add_room_permission', { ...INPUT, permissionGroup: 'Trainer' });
    const ambiguous = await tools.call('add_room_permission', INPUT);
    await tools.done();

    assert.equal(
      unknown.summary,
      'This company has no permission group Trainer. Its groups: Admin, Moderator, Participant, Spectator, Guest.',
    );
    assert.equal(
      ambiguous.summary,
      'More than one permission group is named Moderator. Give the ID of one: c1a2b3c4-d5e6-5f70-8192-a3b4c5d6e7f8, c1a2b3c4-d5e6-5f70-8192-a3b4c5d6e7f9.',
    );
    assert.match(tools.logLines[1]!, /: UnknownPermissionGroup, 3 requests, /);
  });

  it('answers a 409 with the message that names the update tool', async () => {
    const tools = await harness([
      loginRequest(),
      ...before(),
      addRequest(undefined, { status: 409, body: fixture('core/problem-409.json') }),
    ]);
    const result = await tools.call('add_room_permission', INPUT);
    await tools.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, permissionExistsMessage(TARGET_USER_ID));
    assert.equal(
      result.summary,
      `User ${TARGET_USER_ID} already has a room permission in this room. Change it with update_room_permission.`,
    );
    assert.match(tools.logLines.at(-1)!, /: Conflict, 5 requests, /);
  });

  it('sends an uppercase userId and roomId in lowercase', async () => {
    const tools = await harness([
      loginRequest(),
      ...before(),
      addRequest(),
      permissionsRequest(permissionsOf([TARGET_USER_ID, MODERATOR])),
    ]);
    const result = await tools.call('add_room_permission', {
      ...INPUT,
      roomId: ROOM_ID.toUpperCase(),
      userId: TARGET_USER_ID.toUpperCase(),
    });
    await tools.done();

    assert.equal(result.data.userId, TARGET_USER_ID);
    assert.equal(result.data.roomId, ROOM_ID);
  });

  it('refuses a meeting room after the room read, without the POST', async () => {
    const tools = await harness([loginRequest(), roomRequest(MEETING_ROOM, 200, `/v2/rooms/${MEETING_ID}`)]);
    const result = await tools.call('add_room_permission', { ...INPUT, roomId: MEETING_ID });
    await tools.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, MEETING_ROOM_PERMISSION_MESSAGE);
    assert.equal(
      MEETING_ROOM_PERMISSION_MESSAGE,
      'This is the room of a meeting. A user with join there is an invitee of the meeting, and alfaview emails the invitees about changes of the meeting. Invite people to a meeting with create_guest_links.',
    );
    assert.match(tools.logLines.at(-1)!, /: MeetingRoomRefused, 2 requests, /);
  });

  it("refuses an entry without admin for the API key's user, in another case, after the profile read and without the POST", async () => {
    const tools = await harness([loginRequest(), roomRequest(), groupsRequest(), profileRequest(TARGET_USER_ID.toUpperCase())]);
    const result = await tools.call('add_room_permission', INPUT);
    await tools.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, ownAdminMessage(TARGET_USER_ID));
    assert.equal(
      result.summary,
      `User ${TARGET_USER_ID} is the API key's user. This tool does not take its own admin permission away, because the server could lose control of the room. Do it in alfaview.`,
    );
    assert.match(tools.logLines.at(-1)!, /: OwnUserRefused, 4 requests, /);
  });

  it("reads no profile for an entry with admin, and ends the call when the profile read fails", async () => {
    const tools = await harness([
      loginRequest(),
      roomRequest(),
      groupsRequest(),
      addRequest(ADMIN),
      permissionsRequest(permissionsOf([TARGET_USER_ID, ADMIN])),
      roomRequest(),
      groupsRequest(),
      profileRequest(OWN_USER_ID, { status: 200, body: {} }),
    ]);
    const admin = await tools.call('add_room_permission', { ...INPUT, permissionGroup: 'Admin' });
    const unreadable = await tools.call('add_room_permission', INPUT);
    await tools.done();

    assert.equal(admin.isError, false, admin.summary);
    assert.equal(admin.data.admin, true);
    assert.equal(unreadable.summary, PROFILE_NOT_RETURNED_MESSAGE);
  });

  it('guards the admin of the sent entry, which a given admin overrides in the group', async () => {
    const tools = await harness([
      loginRequest(),
      roomRequest(),
      groupsRequest(),
      profileRequest(TARGET_USER_ID),
      roomRequest(),
      groupsRequest(),
      addRequest({ ...MODERATOR, admin: true }),
      permissionsRequest(permissionsOf([TARGET_USER_ID, { ...MODERATOR, admin: true }])),
    ]);
    // The group Admin with admin false for the API key's user would lock it out of the room.
    const withoutAdmin = await tools.call('add_room_permission', {
      ...INPUT,
      permissionGroup: 'Admin',
      admin: false,
    });
    // The group Moderator with admin true needs no profile read.
    const withAdmin = await tools.call('add_room_permission', { ...INPUT, admin: true });
    await tools.done();

    assert.equal(withoutAdmin.isError, true);
    assert.equal(withoutAdmin.summary, ownAdminMessage(TARGET_USER_ID));
    assert.match(tools.logLines[1]!, /: OwnUserRefused, 4 requests, /);
    assert.equal(withAdmin.isError, false, withAdmin.summary);
    assert.equal(withAdmin.data.admin, true);
  });

  it('gives the messages of a 403 and a 404 of the POST', async () => {
    const tools = await harness([
      loginRequest(),
      ...before(),
      addRequest(undefined, { status: 403, body: fixture('core/problem-403.json') }),
      ...before(),
      addRequest(undefined, { status: 404, body: fixture('core/problem-404.json') }),
    ]);
    const forbidden = await tools.call('add_room_permission', INPUT);
    const missing = await tools.call('add_room_permission', INPUT);
    await tools.done();

    assert.match(forbidden.summary, FORBIDDEN);
    assert.equal(missing.summary, ROOM_NOT_FOUND);
  });

  it('gives the sent values and a warning when the read back fails or finds no entry', async () => {
    const tools = await harness([
      loginRequest(),
      ...before(),
      addRequest(),
      permissionsRequest({ status: 500, body: fixture('core/problem-500.json') }),
      ...before(),
      addRequest(),
      permissionsRequest(permissionsOf([OTHER_USER_ID, ADMIN])),
    ]);
    const failed = await tools.call('add_room_permission', INPUT);
    const missing = await tools.call('add_room_permission', INPUT);
    await tools.done();

    for (const result of [failed, missing]) {
      assert.equal(result.isError, false, result.summary);
      assert.equal(
        result.summary,
        `Gave user ${TARGET_USER_ID} a room permission in room ${ROOM_ID} with join, voice, video, screen, chat, upload, promote and vip. ${PERMISSION_NOT_READ_WARNING}`,
      );
      assert.deepEqual(result.data, {
        ...entryOutput(TARGET_USER_ID, MODERATOR),
        permissionGroupName: 'Moderator',
        warnings: [PERMISSION_NOT_READ_WARNING],
      });
    }
    assert.equal(
      PERMISSION_NOT_READ_WARNING,
      'alfaview saved the room permission, but reading it back failed. The result shows the permissions that this call sent.',
    );
  });

  it('gives the sent values and a warning when the read back is canceled', async () => {
    const controller = new AbortController();
    const { api, fake } = testApi(
      [loginRequest(), ...before(), addRequest(), permissionsRequest({ hang: true })],
      { signal: controller.signal },
    );
    const run = addRoomPermissionTool.run(addRoomPermissionTool.inputSchema.parse(INPUT), context(api, controller.signal));
    await untilRequests(fake, 6);
    controller.abort();
    const output = outputOf(await run);
    fake.assertDone();

    assert.deepEqual(output.warnings, [PERMISSION_NOT_READ_WARNING]);
    assert.equal(output.data.join, true);
  });

  it('says no permission when the entry has none', async () => {
    const none = { ...PARTICIPANT, voice: false, video: false, join: false, screen: false, chat: false, upload: false };
    const tools = await harness([
      loginRequest(),
      ...before(),
      addRequest(none),
      permissionsRequest(permissionsOf([TARGET_USER_ID, none])),
    ]);
    const result = await tools.call('add_room_permission', {
      ...INPUT,
      permissionGroup: 'Participant',
      voice: false,
      video: false,
      join: false,
      screen: false,
      chat: false,
      upload: false,
    });
    await tools.done();

    assert.equal(result.summary, `Gave user ${TARGET_USER_ID} a room permission in room ${ROOM_ID} with no permission.`);
    assert.deepEqual(Object.keys(result.data), [
      'roomId',
      'userId',
      'admin',
      'voice',
      'video',
      'promote',
      'join',
      'screen',
      'vip',
      'chat',
      'upload',
      'permissionGroupName',
      'warnings',
    ]);
  });

  // A refusal goes to the error, which the model reads only when it meets it.
  it('describes what it gives, and leaves its refusals to their errors', async () => {
    const tools = await harness([]);
    const { tools: listed } = await tools.client.listTools();
    await tools.done();

    assert.equal(
      listed[0]!.description,
      'Changes who has access: gives a user of the alfaview company a room permission: the nine permissions of permissionGroup, and each permission that you give overrides one. With admin, the user can delete the room. If the user has one already, use update_room_permission. Call it only when the user asked for it.',
    );
  });
});

describe('update_room_permission', () => {
  const INPUT = { roomId: ROOM_ID, userId: TARGET_USER_ID };

  function harness(expected: readonly ExpectedRequest[]) {
    return toolHarness(FULL_ROOM_PERMISSION_TOOLS, expected);
  }

  function patchRequest(body: Json, respond: FakeAnswer = { status: 204 }): ExpectedRequest {
    return { method: 'PATCH', path: ENTRY_PATH, body, respond };
  }

  it('refuses a call without a permission before any request, before the check of the user ID', async () => {
    const tools = await harness([]);
    const result = await tools.call('update_room_permission', { ...INPUT, userId: NOT_USER_IDS[0] });
    await tools.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, NO_PERMISSION_CHANGE_MESSAGE);
    assert.equal(NO_PERMISSION_CHANGE_MESSAGE, 'Give at least one permission to change.');
    assert.match(tools.logLines[0]!, /: InvalidInput, 0 requests, /);
  });

  it('sends only the given permissions, also false ones, and gives the stored values', async () => {
    const stored = { ...PARTICIPANT, join: false, chat: true };
    const tools = await harness([
      loginRequest(),
      roomRequest(),
      patchRequest({ join: false, chat: true }),
      permissionsRequest(permissionsOf([TARGET_USER_ID, stored])),
    ]);
    const result = await tools.call('update_room_permission', { ...INPUT, join: false, chat: true });
    await tools.done();

    assert.equal(
      result.summary,
      `Changed the room permission of user ${TARGET_USER_ID} in room ${ROOM_ID}. It now has voice, video, screen, chat and upload.`,
    );
    assert.deepEqual(result.data, { ...entryOutput(TARGET_USER_ID, stored), warnings: [] });
    assert.match(tools.logLines.at(-1)!, /tool update_room_permission: ok, 4 requests, /);
  });

  it('sends an uppercase userId in lowercase', async () => {
    const tools = await harness([
      loginRequest(),
      roomRequest(),
      patchRequest({ vip: true }),
      permissionsRequest(permissionsOf([TARGET_USER_ID, MODERATOR])),
    ]);
    const result = await tools.call('update_room_permission', {
      ...INPUT,
      userId: TARGET_USER_ID.toUpperCase(),
      vip: true,
    });
    await tools.done();

    assert.equal(result.data.userId, TARGET_USER_ID);
  });

  it("refuses admin false for the API key's user, in another case, after the profile read and without the PATCH", async () => {
    const tools = await harness([loginRequest(), roomRequest(), profileRequest(TARGET_USER_ID.toUpperCase())]);
    const result = await tools.call('update_room_permission', { ...INPUT, admin: false });
    await tools.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, ownAdminMessage(TARGET_USER_ID));
    assert.match(tools.logLines.at(-1)!, /: OwnUserRefused, 3 requests, /);
  });

  it('takes admin false for another user after the profile read', async () => {
    const tools = await harness([
      loginRequest(),
      roomRequest(),
      profileRequest(),
      patchRequest({ admin: false }),
      permissionsRequest(permissionsOf([TARGET_USER_ID, PARTICIPANT])),
    ]);
    const result = await tools.call('update_room_permission', { ...INPUT, admin: false });
    await tools.done();

    assert.equal(result.isError, false, result.summary);
    assert.equal(result.data.admin, false);
  });

  it('reads no profile for admin true and for join false, and ends the call when the profile read fails', async () => {
    const tools = await harness([
      loginRequest(),
      roomRequest(),
      patchRequest({ admin: true }),
      permissionsRequest(permissionsOf([TARGET_USER_ID, ADMIN])),
      roomRequest(),
      patchRequest({ join: false }),
      permissionsRequest(permissionsOf([TARGET_USER_ID, { ...PARTICIPANT, join: false }])),
      roomRequest(),
      profileRequest(OWN_USER_ID, { status: 500, body: fixture('core/problem-500.json') }),
    ]);
    const admin = await tools.call('update_room_permission', { ...INPUT, admin: true });
    const join = await tools.call('update_room_permission', { ...INPUT, join: false });
    const failed = await tools.call('update_room_permission', { ...INPUT, admin: false });
    await tools.done();

    assert.equal(admin.isError, false, admin.summary);
    assert.equal(join.isError, false, join.summary);
    assert.equal(failed.isError, true);
    assert.match(tools.logLines.at(-1)!, /: ServerError, 2 requests, /);
  });

  it('refuses a meeting room after the room read, without the PATCH', async () => {
    const tools = await harness([loginRequest(), roomRequest(MEETING_ROOM, 200, `/v2/rooms/${MEETING_ID}`)]);
    const result = await tools.call('update_room_permission', { roomId: MEETING_ID, userId: TARGET_USER_ID, join: true });
    await tools.done();

    assert.equal(result.summary, MEETING_ROOM_PERMISSION_MESSAGE);
    assert.match(tools.logLines.at(-1)!, /: MeetingRoomRefused, 2 requests, /);
  });

  it('answers a 404 with the message that names the add tool, and passes a 403', async () => {
    const tools = await harness([
      loginRequest(),
      roomRequest(),
      patchRequest({ join: true }, { status: 404, body: fixture('core/problem-404.json') }),
      roomRequest(),
      patchRequest({ join: true }, { status: 403, body: fixture('core/problem-403.json') }),
    ]);
    const missing = await tools.call('update_room_permission', { ...INPUT, join: true });
    const forbidden = await tools.call('update_room_permission', { ...INPUT, join: true });
    await tools.done();

    assert.equal(missing.summary, permissionNotFoundMessage(TARGET_USER_ID));
    assert.equal(
      missing.summary,
      `User ${TARGET_USER_ID} has no room permission in this room, so nothing changed. Give one with add_room_permission.`,
    );
    assert.match(tools.logLines[1]!, /: NotFound, 3 requests, /);
    assert.match(forbidden.summary, FORBIDDEN);
  });

  it('gives the sent values, null for the others and a warning when the read back fails or finds no entry', async () => {
    const tools = await harness([
      loginRequest(),
      roomRequest(),
      patchRequest({ join: true, chat: false }),
      permissionsRequest({ status: 500, body: fixture('core/problem-500.json') }),
      roomRequest(),
      patchRequest({ join: true, chat: false }),
      permissionsRequest(permissionsOf()),
    ]);
    const failed = await tools.call('update_room_permission', { ...INPUT, chat: false, join: true });
    const missing = await tools.call('update_room_permission', { ...INPUT, chat: false, join: true });
    await tools.done();

    for (const result of [failed, missing]) {
      assert.equal(result.isError, false, result.summary);
      assert.equal(
        result.summary,
        `Changed the room permission of user ${TARGET_USER_ID} in room ${ROOM_ID}. ${PERMISSION_CHANGE_NOT_READ_WARNING}`,
      );
      assert.deepEqual(result.data, {
        ...entryOutput(TARGET_USER_ID, { join: true, chat: false }),
        warnings: [PERMISSION_CHANGE_NOT_READ_WARNING],
      });
    }
    assert.equal(
      PERMISSION_CHANGE_NOT_READ_WARNING,
      'alfaview saved the change, but reading it back failed. The result shows the permissions that this call sent, and null for the others.',
    );
  });

  it('describes what it changes, and leaves its refusals to their errors', async () => {
    const tools = await harness([]);
    const { tools: listed } = await tools.client.listTools();
    await tools.done();

    assert.equal(
      listed[1]!.description,
      'Changes who has access: changes the room permission of a user in an alfaview room. Without join the user cannot enter the room, and with admin the user can delete it. Call it only when the user asked for it.',
    );
  });
});

describe('remove_room_permission', () => {
  const INPUT = { roomId: ROOM_ID, userId: TARGET_USER_ID };

  function harness(expected: readonly ExpectedRequest[]) {
    return toolHarness(FULL_ROOM_PERMISSION_TOOLS, expected);
  }

  const deleteRequest = (respond: FakeAnswer = { status: 204 }): ExpectedRequest => ({
    method: 'DELETE',
    path: ENTRY_PATH,
    respond,
  });

  it('reads the API key\'s user, the room and the list, then deletes the entry and gives its permissions', async () => {
    const tools = await harness([
      loginRequest(),
      profileRequest(),
      roomRequest(),
      permissionsRequest(permissionsOf([OTHER_USER_ID, ADMIN], [TARGET_USER_ID, PARTICIPANT])),
      deleteRequest(),
    ]);
    const result = await tools.call('remove_room_permission', INPUT);
    await tools.done();

    assert.equal(
      result.summary,
      `Removed the room permission of user ${TARGET_USER_ID} from room ${ROOM_ID}. It had join, voice, video, screen, chat and upload.`,
    );
    const { roomId: _roomId, userId: _userId, ...removedPermissions } = entryOutput(TARGET_USER_ID, PARTICIPANT);
    assert.deepEqual(result.data, {
      roomId: ROOM_ID,
      userId: TARGET_USER_ID,
      removed: true,
      removedPermissions,
      warnings: [],
    });
    assert.match(tools.logLines.at(-1)!, /tool remove_room_permission: ok, 5 requests, /);
  });

  it("refuses the API key's user, in another case, before the room read", async () => {
    const tools = await harness([loginRequest(), profileRequest(TARGET_USER_ID)]);
    const result = await tools.call('remove_room_permission', { ...INPUT, userId: TARGET_USER_ID.toUpperCase() });
    await tools.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, ownPermissionMessage(TARGET_USER_ID));
    assert.equal(
      result.summary,
      `User ${TARGET_USER_ID} is the API key's user. This tool does not remove its own room permission, because the server could lose access to the room. Do it in alfaview.`,
    );
    assert.match(tools.logLines.at(-1)!, /: OwnUserRefused, 2 requests, /);
  });

  it('ends the call when the profile read fails', async () => {
    const tools = await harness([
      loginRequest(),
      profileRequest(OWN_USER_ID, { status: 500, body: fixture('core/problem-500.json') }),
    ]);
    const result = await tools.call('remove_room_permission', INPUT);
    await tools.done();

    assert.equal(result.isError, true);
    assert.match(tools.logLines.at(-1)!, /: ServerError, 2 requests, /);
  });

  it('refuses a meeting room after the room read, without the list and the delete', async () => {
    const tools = await harness([
      loginRequest(),
      profileRequest(),
      roomRequest(MEETING_ROOM, 200, `/v2/rooms/${MEETING_ID}`),
    ]);
    const result = await tools.call('remove_room_permission', { ...INPUT, roomId: MEETING_ID });
    await tools.done();

    assert.equal(result.summary, MEETING_ROOM_PERMISSION_MESSAGE);
    assert.match(tools.logLines.at(-1)!, /: MeetingRoomRefused, 3 requests, /);
  });

  it('removes nothing for a user without an entry', async () => {
    const tools = await harness([
      loginRequest(),
      profileRequest(),
      roomRequest(),
      permissionsRequest(),
    ]);
    const result = await tools.call('remove_room_permission', INPUT);
    await tools.done();

    assert.equal(
      result.summary,
      `User ${TARGET_USER_ID} has no room permission in room ${ROOM_ID}, so nothing was removed.`,
    );
    assert.deepEqual(result.data, {
      roomId: ROOM_ID,
      userId: TARGET_USER_ID,
      removed: false,
      removedPermissions: null,
      warnings: [],
    });
  });

  it('finds the lowercase entry of an uppercase userId and deletes it in lowercase', async () => {
    const tools = await harness([
      loginRequest(),
      profileRequest(),
      roomRequest(),
      permissionsRequest(permissionsOf([TARGET_USER_ID, MODERATOR])),
      deleteRequest(),
    ]);
    const result = await tools.call('remove_room_permission', { ...INPUT, userId: TARGET_USER_ID.toUpperCase() });
    await tools.done();

    assert.equal(result.data.removed, true);
    assert.equal(result.data.userId, TARGET_USER_ID);
    assert.equal(result.data.removedPermissions.promote, true);
  });

  it('gives the messages of a 404 of the room read and of the list, and of a 403 of the delete', async () => {
    const tools = await harness([
      loginRequest(),
      profileRequest(),
      roomRequest(fixture('core/problem-404.json'), 404),
      profileRequest(),
      roomRequest(),
      permissionsRequest({ status: 404, body: fixture('core/problem-404.json') }),
      profileRequest(),
      roomRequest(),
      permissionsRequest(permissionsOf([TARGET_USER_ID, MODERATOR])),
      deleteRequest({ status: 403, body: fixture('core/problem-403.json') }),
    ]);
    const room = await tools.call('remove_room_permission', INPUT);
    const list = await tools.call('remove_room_permission', INPUT);
    const forbidden = await tools.call('remove_room_permission', INPUT);
    await tools.done();

    assert.equal(room.summary, ROOM_NOT_FOUND);
    assert.equal(list.summary, ROOM_NOT_FOUND);
    assert.match(forbidden.summary, FORBIDDEN);
  });

  it('describes the undo, and leaves its refusals to their errors', async () => {
    const tools = await harness([]);
    const { tools: listed } = await tools.client.listTools();
    await tools.done();

    assert.equal(
      listed[2]!.description,
      "Changes who has access: removes the room permission of a user from an alfaview room. The user keeps only the room's default permissions, if any. add_room_permission can give back the removed permissions of the result. Call it only when the user asked for it.",
    );
  });
});
