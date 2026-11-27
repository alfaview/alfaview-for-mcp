// find_group_links, create_group_link, update_group_link and delete_group_link through an MCP SDK
// client.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CallApi } from '../../src/alfaview/client.ts';
import {
  ADMIN_GROUP_LINK_MESSAGE,
  ADMIN_GROUP_MESSAGE,
  GROUP_LINK_ALONE_MESSAGE,
  GROUP_LINK_DELETE_NOT_FOUND_MESSAGE,
  GROUP_LINK_ID_MISSING_MESSAGE,
  GROUP_LINK_MEETING_ROOM_MESSAGE,
  GROUP_LINK_PAST_VALID_UNTIL_MESSAGE,
  GROUP_LINK_STARTS_LATER_MESSAGE,
  GROUP_LINK_UNCERTAIN_MESSAGE,
  groupLinkCreatedButNotReadMessage,
  groupLinkUpdatedButNotReadMessage,
  MISSING_GROUP_LINK_ROOM_MESSAGE,
} from '../../src/domain/groupLinks.ts';
import { ALL_ROOMS_DENIED_MESSAGE } from '../../src/domain/guestLinks.ts';
import { createLogger } from '../../src/log.ts';
import {
  createGroupLinkTool,
  findGroupLinksTool,
  GROUP_LINK_TOOLS,
} from '../../src/tools/groupLinks.ts';
import {
  CREATE_ANNOTATIONS,
  GROUP_LINK_ID_MESSAGE,
  IDEMPOTENT_CHANGE_ANNOTATIONS,
  READ_ANNOTATIONS,
  ROOM_ID_MESSAGE,
  ROOM_ID_NOT_MEETING_MESSAGE,
  type ToolContext,
} from '../../src/tools/tool.ts';
import { unrecognizedDateTime } from '../helpers/dateTimeMessages.ts';
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

/** The room of groupLinks/group-link.json. */
const ROOM_ID = '0b7c5d2e-91a4-5f3b-8e27-0f4a6c9d1e22';
/** A room of version 5 with the kind 32 (hex 20) in byte 10. */
const ROOM_OF_KIND_20 = 'c0ffee00-0000-5000-8000-200000000001';
/** A room of version 4 with 22 in byte 10: an old room is never a meeting room. */
const OLD_ROOM_ID = '6f1d2c3b-4a5e-4b6c-9d7e-22a1b2c3d4e5';
/** The meeting of meetings/meeting.json: version 5, the kind 34 (hex 22). */
const MEETING_ID = '7e9a1c3d-5b2f-5a4e-8c6d-22f0a1b2c3d4';
/** The link of groupLinks/group-link.json. */
const LINK_ID = '8d4e2f1a-6c3b-5a9e-b2d7-c75e1f0a3b94';
const NEW_ID = 'aa000000-0000-5000-8000-150000000001';
const GUEST_GROUP_ID = 'd2b3c4d5-e6f7-5081-9a2b-c3d4e5f6a7b8';
const SPECTATOR_GROUP_ID = 'f4a5b6c7-d8e9-5f0a-9b1c-2d3e4f5a6b7c';
const ADMIN_GROUP_ID = 'a0b1c2d3-e4f5-5061-8728-394a5b6c7d8e';
const NOT_SET = '0001-01-01T00:00:00Z';
const NOW = Date.parse('2026-10-07T08:00:00Z');
const BAD_IDS = ['Advisory Room', '.', '..', '0b7c5d2e-91a4-5f3b-0f4a6c9d1e22'];

/** 2026-10-07T18:00 and 20:00 in Berlin (summer time). */
const EVENT_FROM_UTC = '2026-10-07T16:00:00.000Z';
const EVENT_UNTIL_UTC = '2026-10-07T18:00:00.000Z';

const ROOM_NOT_FOUND =
  "alfaview could not find the room. It was deleted, or the API key's user cannot see it.";
const GROUP_LINK_NOT_FOUND =
  "alfaview could not find the group link. It was deleted, or the API key's user cannot see it.";
const FORBIDDEN = /^The API key's user is not allowed to do this/;
/** The keys of alfaview that no output gives. */
const LEFT_OUT_KEYS = ['roomName', 'permissionGroupId', 'accessKey', 'joinLink', 'dialInCode', 'createdBy'];

type Json = Record<string, unknown>;

function apiLink(overrides: Json = {}): Json {
  return { ...fixture<Json>('groupLinks/group-link.json'), ...overrides };
}

function joinUrlOf(id: string, roomId = ROOM_ID): string {
  return `https://app.alfaview.com/#/join/0123456789ABCDEFGHIJKLMNOP/${roomId}/Gk${id.slice(-12)}`;
}

const ok = (body: unknown): FakeAnswer => ({ status: 200, body });
const problem = (status: number, file = `problem-${status}.json`): FakeAnswer => ({
  status,
  body: fixture(`core/${file}`),
});
const invalidProblem = (detail: string, errors?: Json[]): FakeAnswer => ({
  status: 422,
  body: { title: 'Unprocessable Entity', status: 422, detail, ...(errors === undefined ? {} : { errors }) },
});

const groupsRequest = (respond: FakeAnswer = ok(fixture('rooms/permission-groups.json'))): ExpectedRequest => ({
  method: 'GET',
  path: '/v2/permission-groups',
  respond,
});

function linksPage(links: unknown[], path = `/v2/rooms/${ROOM_ID}/group-links`): ExpectedRequest {
  return { method: 'GET', path, query: { limit: '500' }, respond: ok({ data: links }) };
}

function linkRequest(respond: FakeAnswer, id = LINK_ID): ExpectedRequest {
  return { method: 'GET', path: `/v2/group-links/${id}`, respond };
}

function harness(expected: readonly ExpectedRequest[], options: HarnessOptions = {}) {
  return toolHarness(GROUP_LINK_TOOLS, expected, options);
}

/** The log line of each tool call, without the lines of the logins. */
function toolLines(lines: readonly string[]): string[] {
  return lines.filter((line) => line.includes(': tool '));
}

/** The context of a run without the wrapper, for a cancel. */
function context(api: CallApi, signal: AbortSignal): ToolContext {
  return {
    api,
    now: NOW,
    timeZone: 'Europe/Berlin',
    signal,
    log: createLogger(() => undefined),
    personalData: 'include',
    level: 'manage',
    confirmation: noQuestions(),
  };
}

describe('the group link tools', () => {
  it('are listed in their fixed order, with their titles and annotations, at the level manage', async () => {
    const tools = await harness([]);
    const { tools: listed } = await tools.client.listTools();
    await tools.done();

    assert.deepEqual(
      listed.map((tool) => [tool.name, tool.title, tool.annotations]),
      [
        ['find_group_links', 'Find group links', READ_ANNOTATIONS],
        ['create_group_link', 'Create a group link', CREATE_ANNOTATIONS],
        ['update_group_link', 'Update a group link', IDEMPOTENT_CHANGE_ANNOTATIONS],
        ['delete_group_link', 'Delete a group link', IDEMPOTENT_CHANGE_ANNOTATIONS],
      ],
    );
    assert.deepEqual(
      GROUP_LINK_TOOLS.map((tool) => tool.level),
      ['manage', 'manage', 'manage', 'manage'],
    );
  });

  it('give their descriptions and parameter texts', async () => {
    const tools = await harness([]);
    const { tools: listed } = await tools.client.listTools();
    await tools.done();

    assert.deepEqual(
      listed.map((tool) => tool.description),
      [
        'Lists the alfaview group links (one join URL for many people) of one room or of every room, newest first. meetingLink marks the links of a meeting room, which the other group link tools do not change.',
        'Creates an alfaview group link and returns its join URL, which many people share with the rights of one permission group, for example for an open event. Attendance data cannot tell these people apart: for personal invitations, use create_guest_links. alfaview emails nobody.',
        'Changes the description, validity, permission group or dial-in setting of an alfaview group link. The join URL stays the same, so a change applies to everyone who has it. alfaview emails nobody.',
        'Deletes an alfaview group link: its join URL stops working at once for everyone who has it. This cannot be undone: a new link has a new join URL. To close a link for a while, give update_group_link a validUntil in the past. alfaview emails nobody.',
      ],
    );
    const texts = (name: string) =>
      Object.fromEntries(
        Object.entries(
          listed.find((tool) => tool.name === name)!.inputSchema.properties as Record<
            string,
            { description: string }
          >,
        ).map(([key, property]) => [key, property.description]),
      );
    const zone = ' Local time in Europe/Berlin unless it has an offset, for example 2026-10-27T10:00.';
    assert.deepEqual(texts('find_group_links'), {
      roomId: 'Room ID from find_rooms. Leave it out to search every room.',
      groupLinkId: 'Read only this group link, also when it has expired.',
      description: 'Only links whose description contains this text, in any case.',
      originContains: 'Only links whose origin contains this text, in any case.',
      includeExpired: 'Also return links whose validUntil has passed.',
      includeJoinUrls:
        'Also return the join URLs. A join URL is a credential: whoever has it joins with the rights of its permission group.',
      limit: 'The most group links to return.',
      offset: 'The nextOffset of the previous result.',
    });
    assert.deepEqual(texts('create_group_link'), {
      roomId: 'Room ID from find_rooms. Not a meeting ID.',
      description: 'Shown in the list of links in alfaview, for example Open house.',
      permissionGroup:
        'Permission group of everyone who joins with the link, by name or ID, for example Participant, or Spectator for a webinar. With a moderator group, everyone who has the join URL can moderate.',
      validFrom: `The link works from this time.${zone}`,
      validUntil: `The link works until this time.${zone}`,
      dialInAllowed: 'If true, people can also join by phone. Needs dial-in in the alfaview plan.',
      origin:
        'The source or event, for example Open house 2026-10-07. find_group_links filters by it. Default: MCP.',
    });
    assert.deepEqual(texts('update_group_link'), {
      groupLinkId: 'Group link ID from find_group_links or create_group_link.',
      description: 'Shown in the list of links in alfaview.',
      validFrom: `The link works from this time.${zone}`,
      validUntil: `The link works until this time. A time in the past turns the link off.${zone}`,
      permissionGroup: 'Permission group of everyone who joins with the link, by name or ID.',
      dialInAllowed: 'If true, people can also join by phone.',
    });
    assert.deepEqual(texts('delete_group_link'), {
      groupLinkId: 'Group link ID from find_group_links or create_group_link.',
    });
  });

  it('refuse a room name, dot segments and a broken UUID in each ID without a request', async () => {
    const tools = await harness([]);
    const results: [string, string][] = [];
    for (const id of BAD_IDS) {
      for (const [name, args, message] of [
        ['find_group_links', { roomId: id }, ROOM_ID_MESSAGE],
        ['find_group_links', { groupLinkId: id }, GROUP_LINK_ID_MESSAGE],
        ['create_group_link', { roomId: id, description: 'Open house', permissionGroup: 'Guest' }, ROOM_ID_NOT_MEETING_MESSAGE],
        ['update_group_link', { groupLinkId: id, description: 'Open day' }, GROUP_LINK_ID_MESSAGE],
        ['delete_group_link', { groupLinkId: id }, GROUP_LINK_ID_MESSAGE],
      ] as const) {
        const result = await tools.call(name, args);
        assert.equal(result.isError, true, `${name} ${id}`);
        results.push([result.summary, message]);
      }
    }
    await tools.done();

    for (const [summary, message] of results) assert.ok(summary.includes(message), summary);
    assert.equal(GROUP_LINK_ID_MESSAGE, 'groupLinkId takes an ID from find_group_links or create_group_link.');
    assert.equal(ROOM_ID_NOT_MEETING_MESSAGE, 'roomId takes a room ID from find_rooms, not a name or a meeting ID.');
    assert.ok(findGroupLinksTool.inputSchema.safeParse({ groupLinkId: LINK_ID.toUpperCase() }).success);
    assert.ok(
      createGroupLinkTool.inputSchema.safeParse({
        roomId: ROOM_ID.toUpperCase(),
        description: 'Open house',
        permissionGroup: 'Guest',
      }).success,
    );
  });
});

describe('find_group_links', () => {
  const expired = apiLink({
    id: 'bb000000-0000-5000-8000-150000000001',
    description: 'Open house old',
    validFrom: '2026-10-06T08:00:00Z',
    validUntil: '2026-10-06T10:00:00Z',
    createdAt: '2026-09-24T10:00:00Z',
  });
  const unbounded = apiLink({
    id: 'bb000000-0000-5000-8000-150000000002',
    description: 'Lobby',
    permissionGroupId: SPECTATOR_GROUP_ID,
    origin: 'Public API',
    dialInAllowed: true,
    dialInCode: '123456',
    validFrom: NOT_SET,
    validUntil: NOT_SET,
    createdAt: '2026-09-20T07:15:30Z',
  });
  const winter = apiLink({
    id: 'bb000000-0000-5000-8000-150000000003',
    description: 'Open house 2',
    validFrom: '2026-11-02T09:00:00Z',
    validUntil: '2026-11-02T10:00:00Z',
    createdAt: '2026-09-26T10:00:00Z',
  });
  const roomLinks = () => [apiLink(), expired, unbounded, winter];

  it('lists the valid links of a room, newest first, without room IDs and join URLs', async () => {
    const tools = await harness([loginRequest(), linksPage(roomLinks()), groupsRequest()]);
    const result = await tools.call('find_group_links', { roomId: ROOM_ID });
    await tools.done();

    assert.equal(
      result.summary,
      'Found 3 group links. Showing 1 to 3. 1 expired group link also matches. Call again with includeExpired true.',
    );
    assert.deepEqual(result.data, {
      roomId: ROOM_ID,
      totalMatches: 3,
      expiredMatchCount: 1,
      offset: 0,
      nextOffset: null,
      links: [
        {
          id: 'bb000000-0000-5000-8000-150000000003',
          description: 'Open house 2',
          permissionGroupName: 'Guest',
          validFrom: '2026-11-02T10:00:00+01:00',
          validUntil: '2026-11-02T11:00:00+01:00',
          dialInAllowed: false,
          origin: 'Zapier',
          createdAt: '2026-09-26T12:00:00+02:00',
          meetingLink: false,
        },
        {
          id: LINK_ID,
          description: 'Open house',
          permissionGroupName: 'Guest',
          validFrom: '2026-10-07T10:45:00+02:00',
          validUntil: '2026-10-07T12:15:00+02:00',
          dialInAllowed: false,
          origin: 'Zapier',
          createdAt: '2026-09-25T12:00:00+02:00',
          meetingLink: false,
        },
        {
          id: 'bb000000-0000-5000-8000-150000000002',
          description: 'Lobby',
          permissionGroupName: 'Spectator',
          validFrom: null,
          validUntil: null,
          dialInAllowed: true,
          origin: 'Public API',
          createdAt: '2026-09-20T09:15:30+02:00',
          meetingLink: false,
        },
      ],
      warnings: ['1 expired group link also matches. Call again with includeExpired true.'],
    });
  });

  it('reads every page of the room with 500 links per page, the room ID in lowercase', async () => {
    const path = `/v2/rooms/${ROOM_ID}/group-links`;
    const tools = await harness([
      loginRequest(),
      { method: 'GET', path, query: { limit: '500' }, respond: ok({ data: [apiLink()], nextPageToken: 'p2' }) },
      { method: 'GET', path, query: { limit: '500', pageToken: 'p2' }, respond: ok({ data: [winter] }) },
      groupsRequest(),
    ]);
    const result = await tools.call('find_group_links', { roomId: ROOM_ID.toUpperCase() });
    await tools.done();

    assert.equal(result.data.roomId, ROOM_ID.toUpperCase());
    assert.equal(result.data.totalMatches, 2);
  });

  it('filters by a part of the description and of the origin in any case, with expired links and join URLs', async () => {
    const tools = await harness([
      loginRequest(),
      linksPage([
        ...roomLinks(),
        apiLink({ id: 'bb000000-0000-5000-8000-150000000004', description: 'Garden open House', origin: 'Public API' }),
        apiLink({ id: 'bb000000-0000-5000-8000-150000000005', description: 'Lobby', origin: 'zapier' }),
      ]),
      groupsRequest(),
    ]);
    const result = await tools.call('find_group_links', {
      roomId: ROOM_ID,
      description: 'OPEN house',
      originContains: 'ZAP',
      includeExpired: true,
      includeJoinUrls: true,
    });
    await tools.done();

    assert.equal(result.summary, 'Found 3 group links. Showing 1 to 3.');
    assert.equal(result.data.expiredMatchCount, 1);
    assert.deepEqual(
      result.data.links.map((link: { id: string }) => link.id),
      ['bb000000-0000-5000-8000-150000000003', LINK_ID, 'bb000000-0000-5000-8000-150000000001'],
    );
    assert.equal(result.data.links[1].joinUrl, apiLink().joinUrl);
    assert.ok(!('roomId' in result.data.links[1]));
    for (const link of result.data.links) {
      for (const key of LEFT_OUT_KEYS) assert.ok(!(key in link), key);
    }
    assert.deepEqual(result.data.warnings, []);
  });

  it('searches every room without roomId, gives each link its room and marks the links of meeting rooms', async () => {
    const tools = await harness([
      loginRequest(),
      linksPage(
        [
          apiLink({ roomId: MEETING_ID, createdAt: '2026-09-28T10:00:00Z' }),
          apiLink({ id: 'bb000000-0000-5000-8000-150000000006', roomId: ROOM_OF_KIND_20, createdAt: '2026-09-27T10:00:00Z' }),
          apiLink({ id: 'bb000000-0000-5000-8000-150000000007', roomId: OLD_ROOM_ID, createdAt: '2026-09-26T10:00:00Z' }),
          { id: 'bb000000-0000-5000-8000-150000000008' },
        ],
        '/v2/group-links',
      ),
      groupsRequest(),
    ]);
    const result = await tools.call('find_group_links', {});
    await tools.done();

    assert.equal(result.data.roomId, null);
    assert.deepEqual(
      result.data.links.map((link: { roomId: string | null; meetingLink: boolean }) => [link.roomId, link.meetingLink]),
      [
        [MEETING_ID, true],
        [ROOM_OF_KIND_20, false],
        [OLD_ROOM_ID, false],
        [null, false],
      ],
    );
    for (const link of result.data.links) {
      assert.ok(!('joinUrl' in link));
      for (const key of LEFT_OUT_KEYS) assert.ok(!(key in link), key);
    }
  });

  for (const status of [403, 404]) {
    it(`says which permissions a search of every room needs after HTTP ${status}`, async () => {
      const tools = await harness([
        loginRequest(),
        { method: 'GET', path: '/v2/group-links', query: { limit: '500' }, respond: problem(status) },
      ]);
      const result = await tools.call('find_group_links', { originContains: 'MCP' });
      await tools.done();

      assert.deepEqual([result.isError, result.summary], [true, ALL_ROOMS_DENIED_MESSAGE]);
    });
  }

  it('reports a room that alfaview cannot find', async () => {
    const tools = await harness([
      loginRequest(),
      { method: 'GET', path: `/v2/rooms/${ROOM_ID}/group-links`, query: { limit: '500' }, respond: problem(404) },
    ]);
    const result = await tools.call('find_group_links', { roomId: ROOM_ID });
    await tools.done();

    assert.deepEqual([result.isError, result.summary], [true, ROOM_NOT_FOUND]);
  });

  it('reads one link by groupLinkId, also when it has expired, with its room and join URL', async () => {
    const tools = await harness([loginRequest(), linkRequest(ok(expired), expired.id as string), groupsRequest()]);
    const result = await tools.call('find_group_links', { groupLinkId: expired.id, includeJoinUrls: true });
    await tools.done();

    assert.equal(result.summary, 'Found 1 group link. Showing 1 to 1.');
    assert.deepEqual(result.data, {
      roomId: null,
      totalMatches: 1,
      expiredMatchCount: 0,
      offset: 0,
      nextOffset: null,
      links: [
        {
          id: 'bb000000-0000-5000-8000-150000000001',
          roomId: ROOM_ID,
          description: 'Open house old',
          joinUrl: apiLink().joinUrl,
          permissionGroupName: 'Guest',
          validFrom: '2026-10-06T10:00:00+02:00',
          validUntil: '2026-10-06T12:00:00+02:00',
          dialInAllowed: false,
          origin: 'Zapier',
          createdAt: '2026-09-24T12:00:00+02:00',
          meetingLink: false,
        },
      ],
      warnings: [],
    });
  });

  it('refuses groupLinkId with roomId, description or originContains before any request', async () => {
    const tools = await harness([]);
    const results = [
      await tools.call('find_group_links', { groupLinkId: LINK_ID, roomId: ROOM_ID }),
      await tools.call('find_group_links', { groupLinkId: LINK_ID, description: 'Open' }),
      await tools.call('find_group_links', { groupLinkId: LINK_ID, originContains: 'MCP' }),
    ];
    await tools.done();

    for (const result of results) assert.deepEqual([result.isError, result.summary], [true, GROUP_LINK_ALONE_MESSAGE]);
    assert.match(tools.logLines.at(-1)!, /tool find_group_links: InvalidInput, 0 requests, /);
  });

  it('gives the texts of a group link that alfaview cannot find and of an ID that it refuses', async () => {
    const tools = await harness([
      loginRequest(),
      linkRequest(problem(404)),
      linkRequest(invalidProblem('invalid group link id')),
    ]);
    const missing = await tools.call('find_group_links', { groupLinkId: LINK_ID });
    const refused = await tools.call('find_group_links', { groupLinkId: LINK_ID });
    await tools.done();

    assert.equal(missing.summary, GROUP_LINK_NOT_FOUND);
    assert.equal(refused.summary, 'alfaview could not process the input: invalid group link id.');
  });

  it('reads no group names when no link matches', async () => {
    const tools = await harness([loginRequest(), linksPage(roomLinks())]);
    const result = await tools.call('find_group_links', { roomId: ROOM_ID, description: 'nothing' });
    await tools.done();

    assert.equal(result.summary, 'Found no group links.');
    assert.deepEqual([result.data.links, result.data.expiredMatchCount], [[], 0]);
  });

  it('gives null group names when the group list fails', async () => {
    const tools = await harness([loginRequest(), linksPage([apiLink()]), groupsRequest(problem(500))]);
    const result = await tools.call('find_group_links', { roomId: ROOM_ID });
    await tools.done();

    assert.equal(result.isError, false);
    assert.equal(result.data.links[0].permissionGroupName, null);
  });

  it('ends the call when it is canceled during the group read', async () => {
    const controller = new AbortController();
    const { api, fake } = testApi([loginRequest(), linksPage([apiLink()]), groupsRequest({ hang: true })], {
      signal: controller.signal,
    });
    const run = findGroupLinksTool.run(
      findGroupLinksTool.inputSchema.parse({ roomId: ROOM_ID }),
      context(api, controller.signal),
    );
    await untilRequests(fake, 3);
    controller.abort();
    const error = await toolErrorOf(run);
    fake.assertDone();

    assert.equal(error.code, 'Canceled');
  });

  it('pages with limit and offset, and counts several expired links', async () => {
    const expiredToo = apiLink({ id: 'bb000000-0000-5000-8000-150000000009', validUntil: '2026-10-01T10:00:00Z' });
    const tools = await harness([
      loginRequest(),
      linksPage([...roomLinks(), expiredToo]),
      groupsRequest(),
      linksPage([...roomLinks(), expiredToo]),
    ]);
    const first = await tools.call('find_group_links', { roomId: ROOM_ID, limit: 2 });
    const beyond = await tools.call('find_group_links', { roomId: ROOM_ID, offset: 3 });
    await tools.done();

    assert.equal(
      first.summary,
      'Found 3 group links. Showing 1 to 2. Call again with offset 2 for the next ones. 2 expired group links also match. Call again with includeExpired true.',
    );
    assert.deepEqual([first.data.nextOffset, first.data.links.length], [2, 2]);
    assert.match(beyond.summary, /^Found 3 group links\. Nothing at offset 3\./);
  });

  it('lets the SDK refuse a text of only spaces and a limit above 50', async () => {
    const tools = await harness([]);
    const spaces = await tools.call('find_group_links', { description: '  ' });
    const limit = await tools.call('find_group_links', { limit: 51 });
    await tools.done();

    assert.deepEqual([spaces.isError, limit.isError], [true, true]);
  });
});

/** The expected create: the defaults, changed by `entry`. An undefined value is left out. */
function createRequest(
  respond: FakeAnswer,
  entry: Json = {},
  options: { origin?: string; roomId?: string } = {},
): ExpectedRequest {
  const fields = {
    description: 'Open house',
    permissionGroupId: GUEST_GROUP_ID,
    dialInAllowed: false,
    validFrom: EVENT_FROM_UTC,
    validUntil: EVENT_UNTIL_UTC,
    ...entry,
  };
  return {
    method: 'POST',
    path: `/v2/rooms/${options.roomId ?? ROOM_ID}/group-links`,
    body: {
      create: [Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))],
      origin: options.origin ?? 'MCP',
    },
    respond,
  };
}

const CREATED: FakeAnswer = { status: 201, body: [{ id: NEW_ID }] };

/** The read back of the new link, with the values of the create. */
function readBack(fields: Json = {}, roomId = ROOM_ID): ExpectedRequest {
  return linkRequest(
    ok(
      apiLink({
        id: NEW_ID,
        roomId,
        origin: 'MCP',
        validFrom: EVENT_FROM_UTC,
        validUntil: EVENT_UNTIL_UTC,
        joinUrl: joinUrlOf(NEW_ID, roomId),
        joinLink: joinUrlOf(NEW_ID, roomId),
        ...fields,
      }),
    ),
    NEW_ID,
  );
}

const EVENT = {
  roomId: ROOM_ID,
  description: 'Open house',
  permissionGroup: 'Guest',
  validFrom: '2026-10-07T18:00',
  validUntil: '2026-10-07T20:00',
};

describe('create_group_link', () => {
  it('reads the groups, creates the link with the defaults, and reads it back for its join URL', async () => {
    const tools = await harness([loginRequest(), groupsRequest(), createRequest(CREATED), readBack()]);
    const result = await tools.call('create_group_link', EVENT);
    await tools.done();

    assert.equal(
      result.summary,
      `Created group link ${NEW_ID} in room ${ROOM_ID}, valid from 2026-10-07 18:00 Europe/Berlin until 2026-10-07 20:00 Europe/Berlin. The join URL is in the result. alfaview sent no email.`,
    );
    assert.deepEqual(result.data, {
      id: NEW_ID,
      roomId: ROOM_ID,
      description: 'Open house',
      joinUrl: joinUrlOf(NEW_ID),
      permissionGroupName: 'Guest',
      validFrom: '2026-10-07T18:00:00+02:00',
      validUntil: '2026-10-07T20:00:00+02:00',
      dialInAllowed: false,
      origin: 'MCP',
      createdAt: '2026-09-25T12:00:00+02:00',
      meetingLink: false,
      warnings: [],
    });
    for (const key of LEFT_OUT_KEYS) assert.ok(!(key in result.data), key);
  });

  it('sends the chosen group by its name in any case, the dial-in, the origin and winter times in UTC', async () => {
    const entry = {
      description: 'Webinar',
      permissionGroupId: SPECTATOR_GROUP_ID,
      dialInAllowed: true,
      validFrom: '2026-11-02T09:00:00.000Z',
      validUntil: '2026-11-02T10:30:00.000Z',
    };
    const tools = await harness([
      loginRequest(),
      groupsRequest(),
      createRequest(CREATED, entry, { origin: 'Open house 2026-10-07' }),
      readBack({ ...entry, origin: 'Open house 2026-10-07' }),
    ]);
    const result = await tools.call('create_group_link', {
      roomId: ROOM_ID,
      description: 'Webinar',
      permissionGroup: ' spectator ',
      validFrom: '2026-11-02T10:00',
      validUntil: '2026-11-02T11:30',
      dialInAllowed: true,
      origin: 'Open house 2026-10-07',
    });
    await tools.done();

    assert.equal(
      result.summary,
      `Created group link ${NEW_ID} in room ${ROOM_ID}, valid from 2026-11-02 10:00 Europe/Berlin until 2026-11-02 11:30 Europe/Berlin. The join URL is in the result. alfaview sent no email.`,
    );
    assert.deepEqual(
      [result.data.permissionGroupName, result.data.dialInAllowed, result.data.validFrom, result.data.origin],
      ['Spectator', true, '2026-11-02T10:00:00+01:00', 'Open house 2026-10-07'],
    );
  });

  it('creates a link without validity, and takes a group ID in uppercase', async () => {
    const tools = await harness([
      loginRequest(),
      groupsRequest(),
      createRequest(CREATED, { validFrom: undefined, validUntil: undefined }),
      readBack({ validFrom: NOT_SET, validUntil: NOT_SET }),
    ]);
    const result = await tools.call('create_group_link', {
      roomId: ROOM_ID,
      description: 'Open house',
      permissionGroup: GUEST_GROUP_ID.toUpperCase(),
    });
    await tools.done();

    assert.match(result.summary, /, valid from any time until no end\. /);
    assert.deepEqual([result.data.validFrom, result.data.validUntil], [null, null]);
  });

  it('refuses a meeting room before any request, and takes a room of kind 20 and a version 4 room', async () => {
    const tools = await harness([
      loginRequest(),
      groupsRequest(),
      createRequest(CREATED, {}, { roomId: ROOM_OF_KIND_20 }),
      readBack({}, ROOM_OF_KIND_20),
      groupsRequest(),
      createRequest(CREATED, {}, { roomId: OLD_ROOM_ID }),
      readBack({}, OLD_ROOM_ID),
    ]);
    const meeting = await tools.call('create_group_link', { ...EVENT, roomId: MEETING_ID });
    const upper = await tools.call('create_group_link', { ...EVENT, roomId: MEETING_ID.toUpperCase() });
    const room = await tools.call('create_group_link', { ...EVENT, roomId: ROOM_OF_KIND_20 });
    const old = await tools.call('create_group_link', { ...EVENT, roomId: OLD_ROOM_ID });
    await tools.done();

    for (const result of [meeting, upper]) {
      assert.deepEqual([result.isError, result.summary], [true, GROUP_LINK_MEETING_ROOM_MESSAGE]);
    }
    assert.match(toolLines(tools.logLines)[0]!, /tool create_group_link: MeetingRoomRefused, 0 requests, /);
    assert.deepEqual([room.data.roomId, room.data.meetingLink], [ROOM_OF_KIND_20, false]);
    assert.deepEqual([old.data.roomId, old.data.meetingLink], [OLD_ROOM_ID, false]);
  });

  it('checks the meeting room, the times and the validity in order before any request', async () => {
    const tools = await harness([]);
    const pastMeeting = await tools.call('create_group_link', {
      ...EVENT,
      roomId: MEETING_ID,
      validUntil: '2026-10-07T09:00',
    });
    const unreadable = await tools.call('create_group_link', { ...EVENT, validFrom: 'tomorrow' });
    const past = await tools.call('create_group_link', { ...EVENT, validFrom: undefined, validUntil: '2026-10-07T09:00' });
    const reversed = await tools.call('create_group_link', { ...EVENT, validUntil: '2026-10-07T17:00' });
    await tools.done();

    assert.equal(pastMeeting.summary, GROUP_LINK_MEETING_ROOM_MESSAGE);
    assert.equal(unreadable.summary, unrecognizedDateTime('validFrom'));
    assert.equal(past.summary, GROUP_LINK_PAST_VALID_UNTIL_MESSAGE);
    assert.equal(reversed.summary, 'validUntil must be after validFrom.');
    for (const line of tools.logLines) assert.match(line, /, 0 requests, /);
  });

  it('lists the group names for an unknown group, and IDs for a name of two groups', async () => {
    const groups = fixture<Json[]>('rooms/permission-groups.json');
    const twoGuests = [...groups, { id: 'b1c2d3e4-f5a6-5b7c-8d9e-0f1a2b3c4d5e', name: 'guest', permissions: {} }];
    const tools = await harness([loginRequest(), groupsRequest(), groupsRequest(ok(twoGuests))]);
    const unknown = await tools.call('create_group_link', { ...EVENT, permissionGroup: 'Webinar' });
    const twice = await tools.call('create_group_link', { ...EVENT, permissionGroup: 'Guest' });
    await tools.done();

    assert.equal(
      unknown.summary,
      'This company has no permission group Webinar. Its groups: Admin, Moderator, Participant, Spectator, Guest.',
    );
    assert.equal(
      twice.summary,
      `More than one permission group is named Guest. Give the ID of one: ${GUEST_GROUP_ID}, b1c2d3e4-f5a6-5b7c-8d9e-0f1a2b3c4d5e.`,
    );
    assert.match(toolLines(tools.logLines)[0]!, /: UnknownPermissionGroup, 2 requests, /);
    assert.match(toolLines(tools.logLines)[1]!, /: UnknownPermissionGroup, 1 request, /);
  });

  // Everyone with the join URL would get the admin rights, so the refusal holds at every level,
  // also at full.
  it('refuses a permission group with admin before the create, at every level', async () => {
    for (const level of [undefined, 'read', 'standard', 'manage', 'full'] as const) {
      for (const permissionGroup of ['admin', ADMIN_GROUP_ID]) {
        const tools = await harness([loginRequest(), groupsRequest()], level === undefined ? {} : { level });
        const result = await tools.call('create_group_link', { ...EVENT, permissionGroup });
        await tools.done();

        assert.deepEqual([result.isError, result.summary], [true, ADMIN_GROUP_MESSAGE], String(level));
        assert.match(tools.logLines.at(-1)!, /: AdminGroupRefused, 2 requests, /);
      }
    }
  });

  for (const status of [500, 502, 503, 504]) {
    it(`says that the link may exist after HTTP ${status}, without a read back`, async () => {
      const tools = await harness([loginRequest(), groupsRequest(), createRequest(problem(status, 'problem-500.json'))]);
      const result = await tools.call('create_group_link', EVENT);
      await tools.done();

      assert.deepEqual([result.isError, result.summary], [true, GROUP_LINK_UNCERTAIN_MESSAGE]);
      assert.match(tools.logLines.at(-1)!, /: ServerError, 3 requests, /);
    });
  }

  it('says that the link may exist after a timeout or a network error', async () => {
    const tools = await harness(
      [
        loginRequest(),
        groupsRequest(),
        createRequest({ hang: true }),
        groupsRequest(),
        createRequest({ networkError: 'ECONNRESET' }),
      ],
      { timeoutMs: 20 },
    );
    const timeout = await tools.call('create_group_link', EVENT);
    const network = await tools.call('create_group_link', EVENT);
    await tools.done();

    assert.deepEqual([timeout.summary, network.summary], [GROUP_LINK_UNCERTAIN_MESSAGE, GROUP_LINK_UNCERTAIN_MESSAGE]);
    assert.match(toolLines(tools.logLines)[0]!, /: Timeout, /);
    assert.match(toolLines(tools.logLines)[1]!, /: NetworkError, /);
  });

  it('says that the link may exist after a cancel', async () => {
    const controller = new AbortController();
    const { api, fake } = testApi([loginRequest(), groupsRequest(), createRequest({ hang: true })], {
      signal: controller.signal,
    });
    const run = createGroupLinkTool.run(createGroupLinkTool.inputSchema.parse(EVENT), context(api, controller.signal));
    await untilRequests(fake, 3);
    controller.abort();
    const error = await toolErrorOf(run);
    fake.assertDone();

    assert.deepEqual([error.code, error.message], ['Canceled', GROUP_LINK_UNCERTAIN_MESSAGE]);
  });

  it('says that the link may exist after an answer without an ID, without a read back', async () => {
    const tools = await harness([
      loginRequest(),
      groupsRequest(),
      createRequest({ status: 201, body: [] }),
      groupsRequest(),
      createRequest({ status: 201, body: [{}] }),
    ]);
    const empty = await tools.call('create_group_link', EVENT);
    const missing = await tools.call('create_group_link', EVENT);
    await tools.done();

    assert.deepEqual([empty.summary, missing.summary], [GROUP_LINK_ID_MISSING_MESSAGE, GROUP_LINK_ID_MISSING_MESSAGE]);
    assert.match(toolLines(tools.logLines)[0]!, /: InvalidResponse, 3 requests, /);
  });

  it('says that the link exists when the read back fails, with the code of the read error', async () => {
    const tools = await harness(
      [
        loginRequest(),
        groupsRequest(),
        createRequest(CREATED),
        linkRequest(problem(503, 'problem-500.json'), NEW_ID),
        groupsRequest(),
        createRequest(CREATED),
        linkRequest(problem(404), NEW_ID),
        groupsRequest(),
        createRequest(CREATED),
        linkRequest({ hang: true }, NEW_ID),
      ],
      { timeoutMs: 20 },
    );
    const results = [
      await tools.call('create_group_link', EVENT),
      await tools.call('create_group_link', EVENT),
      await tools.call('create_group_link', EVENT),
    ];
    await tools.done();

    for (const result of results) {
      assert.deepEqual([result.isError, result.summary], [true, groupLinkCreatedButNotReadMessage(NEW_ID)]);
    }
    assert.match(toolLines(tools.logLines)[0]!, /: ServerError, 4 requests, /);
    assert.match(toolLines(tools.logLines)[1]!, /: NotFound, /);
    assert.match(toolLines(tools.logLines)[2]!, /: Timeout, /);
  });

  it('gives the texts of a room that alfaview cannot find, a missing permission and a refused input', async () => {
    const refused = invalidProblem('not allowed for departments');
    const tools = await harness([
      loginRequest(),
      groupsRequest(),
      createRequest(problem(404)),
      groupsRequest(),
      createRequest(problem(403)),
      groupsRequest(),
      createRequest(refused),
    ]);
    const missing = await tools.call('create_group_link', EVENT);
    const forbidden = await tools.call('create_group_link', EVENT);
    const department = await tools.call('create_group_link', EVENT);
    await tools.done();

    assert.equal(missing.summary, ROOM_NOT_FOUND);
    assert.match(forbidden.summary, FORBIDDEN);
    assert.equal(department.summary, 'alfaview could not process the input: not allowed for departments.');
  });

  it('names only the fields of a refused input with Personal data set to Leave out', async () => {
    const refused = invalidProblem('validation failed', [
      { message: 'origin Calendly zzpersonalzz is refused', location: 'body.origin' },
    ]);
    const tools = await harness([loginRequest(), groupsRequest(), createRequest(refused)], { personalData: 'omit' });
    const result = await tools.call('create_group_link', EVENT);
    await tools.done();

    assert.equal(
      result.summary,
      'alfaview could not process the input. Check origin. The reason from alfaview is hidden because Personal data is set to Leave out.',
    );
  });
});

describe('update_group_link', () => {
  const patch = (body: Json, respond: FakeAnswer = { status: 204 }): ExpectedRequest => ({
    method: 'PATCH',
    path: `/v2/group-links/${LINK_ID}`,
    body,
    respond,
  });
  const read = (fields: Json = {}): ExpectedRequest => linkRequest(ok(apiLink(fields)));

  it('reads the link and the group names, sends only the given fields, then returns the stored link', async () => {
    const stored = { description: 'Open day', validUntil: '2026-10-07T11:00:00Z' };
    const tools = await harness([
      loginRequest(),
      read(),
      groupsRequest(),
      patch({ description: 'Open day', validUntil: '2026-10-07T11:00:00.000Z' }),
      read(stored),
    ]);
    const result = await tools.call('update_group_link', {
      groupLinkId: LINK_ID,
      description: 'Open day',
      validUntil: '2026-10-07T13:00',
    });
    await tools.done();

    assert.equal(
      result.summary,
      `Updated group link ${LINK_ID}, valid from 2026-10-07 10:45 Europe/Berlin until 2026-10-07 13:00 Europe/Berlin. Its join URL stays the same. alfaview sent no email.`,
    );
    assert.deepEqual(result.data, {
      id: LINK_ID,
      roomId: ROOM_ID,
      description: 'Open day',
      permissionGroupName: 'Guest',
      validFrom: '2026-10-07T10:45:00+02:00',
      validUntil: '2026-10-07T13:00:00+02:00',
      dialInAllowed: false,
      origin: 'Zapier',
      createdAt: '2026-09-25T12:00:00+02:00',
      meetingLink: false,
      warnings: [],
    });
    for (const key of ['joinUrl', ...LEFT_OUT_KEYS]) assert.ok(!(key in result.data), key);
  });

  it('resolves a group by its name or its ID, and sends every field with the times in UTC', async () => {
    const every = {
      description: 'Webinar',
      validFrom: '2026-11-02T09:00:00.000Z',
      validUntil: '2026-11-02T10:00:00.000Z',
      permissionGroupId: SPECTATOR_GROUP_ID,
      dialInAllowed: true,
    };
    const tools = await harness([
      loginRequest(),
      read(),
      groupsRequest(),
      patch(every),
      read(every),
      read(),
      groupsRequest(),
      patch({ permissionGroupId: GUEST_GROUP_ID, dialInAllowed: false }),
      read(),
    ]);
    const byName = await tools.call('update_group_link', {
      groupLinkId: LINK_ID,
      description: 'Webinar',
      validFrom: '2026-11-02T10:00',
      validUntil: '2026-11-02T11:00',
      permissionGroup: 'spectator',
      dialInAllowed: true,
    });
    const byId = await tools.call('update_group_link', {
      groupLinkId: LINK_ID,
      permissionGroup: GUEST_GROUP_ID.toUpperCase(),
      dialInAllowed: false,
    });
    await tools.done();

    assert.deepEqual(
      [byName.data.permissionGroupName, byName.data.dialInAllowed, byName.data.validUntil],
      ['Spectator', true, '2026-11-02T11:00:00+01:00'],
    );
    assert.equal(byId.data.permissionGroupName, 'Guest');
  });

  it('refuses a call without a field and a reversed or empty validity before any request', async () => {
    const tools = await harness([]);
    const none = await tools.call('update_group_link', { groupLinkId: LINK_ID });
    const reversed = await tools.call('update_group_link', {
      groupLinkId: LINK_ID,
      validFrom: '2026-10-08T10:00',
      validUntil: '2026-10-08T09:00',
    });
    // alfaview refuses equal times with 422.
    const equal = await tools.call('update_group_link', {
      groupLinkId: LINK_ID,
      validFrom: '2026-10-08T10:00',
      validUntil: '2026-10-08T10:00',
    });
    await tools.done();

    assert.equal(none.summary, 'Give at least one field to change.');
    assert.equal(reversed.summary, 'validUntil must be after validFrom.');
    assert.equal(equal.summary, 'validUntil must be after validFrom.');
    for (const line of tools.logLines) assert.match(line, /: InvalidInput, 0 requests, /);
  });

  it('refuses one bound against the stored other bound after the read, before the change', async () => {
    const tools = await harness([loginRequest(), read(), read(), read(), read()]);
    // The stored validity is 2026-10-07 10:45 to 12:15 in Berlin.
    const fromAfterUntil = await tools.call('update_group_link', { groupLinkId: LINK_ID, validFrom: '2026-10-07T13:00' });
    const fromAtUntil = await tools.call('update_group_link', { groupLinkId: LINK_ID, validFrom: '2026-10-07T12:15' });
    const untilBeforeFrom = await tools.call('update_group_link', { groupLinkId: LINK_ID, validUntil: '2026-10-07T10:00' });
    const untilAtFrom = await tools.call('update_group_link', { groupLinkId: LINK_ID, validUntil: '2026-10-07T10:45' });
    await tools.done();

    for (const result of [fromAfterUntil, fromAtUntil]) {
      assert.deepEqual([result.isError, result.summary], [true, 'validUntil must be after validFrom.']);
    }
    // A validUntil alone cannot close a link that starts later, so the error asks for validFrom.
    for (const result of [untilBeforeFrom, untilAtFrom]) {
      assert.deepEqual([result.isError, result.summary], [true, GROUP_LINK_STARTS_LATER_MESSAGE]);
    }
    assert.match(toolLines(tools.logLines)[0]!, /: InvalidInput, 2 requests, /);
    for (const line of toolLines(tools.logLines).slice(1)) {
      assert.match(line, /: InvalidInput, 1 request, /);
    }
    assert.equal(
      GROUP_LINK_STARTS_LATER_MESSAGE,
      'validUntil must be after validFrom, and this link starts later. Also give validFrom: to turn the link off, give both times in the past.',
    );
  });

  it('turns off a link that starts later with both times in the past', async () => {
    // The stored validity starts on 2026-10-20, after the validUntil of the call.
    const later = { validFrom: '2026-10-20T08:00:00Z', validUntil: '2026-10-20T10:00:00Z' };
    const off = { validFrom: '2026-10-06T07:00:00.000Z', validUntil: '2026-10-06T08:00:00.000Z' };
    const tools = await harness([
      loginRequest(),
      read(later),
      read(later),
      groupsRequest(),
      patch(off),
      read(off),
    ]);
    const alone = await tools.call('update_group_link', { groupLinkId: LINK_ID, validUntil: '2026-10-06T10:00' });
    const both = await tools.call('update_group_link', {
      groupLinkId: LINK_ID,
      validFrom: '2026-10-06T09:00',
      validUntil: '2026-10-06T10:00',
    });
    await tools.done();

    assert.deepEqual([alone.isError, alone.summary], [true, GROUP_LINK_STARTS_LATER_MESSAGE]);
    assert.equal(both.isError, false, both.summary);
    assert.match(both.summary, /, valid from 2026-10-06 09:00 Europe\/Berlin until 2026-10-06 10:00 Europe\/Berlin\. /);
  });

  it('counts a stored year 1 bound as none, and sends a validUntil in the past, which turns the link off', async () => {
    const open = { validFrom: NOT_SET, validUntil: NOT_SET };
    const tools = await harness([
      loginRequest(),
      read(open),
      groupsRequest(),
      patch({ validUntil: '2026-10-06T08:00:00.000Z' }),
      read({ validFrom: NOT_SET, validUntil: '2026-10-06T08:00:00Z' }),
      read(open),
      groupsRequest(),
      patch({ validFrom: '2026-12-01T09:00:00.000Z' }),
      read({ validFrom: '2026-12-01T09:00:00Z', validUntil: NOT_SET }),
    ]);
    const off = await tools.call('update_group_link', { groupLinkId: LINK_ID, validUntil: '2026-10-06T10:00' });
    const later = await tools.call('update_group_link', { groupLinkId: LINK_ID, validFrom: '2026-12-01T10:00' });
    await tools.done();

    assert.match(off.summary, /, valid from any time until 2026-10-06 10:00 Europe\/Berlin\. /);
    assert.match(later.summary, /, valid from 2026-12-01 10:00 Europe\/Berlin until no end\. /);
  });

  it('refuses a link of a meeting room after the read, without a change', async () => {
    const tools = await harness([loginRequest(), read({ roomId: MEETING_ID })]);
    const result = await tools.call('update_group_link', { groupLinkId: LINK_ID, validUntil: '2026-10-07T09:00' });
    await tools.done();

    assert.deepEqual([result.isError, result.summary], [true, GROUP_LINK_MEETING_ROOM_MESSAGE]);
    assert.match(toolLines(tools.logLines)[0]!, /: MeetingRoomRefused, 2 requests, /);
  });

  it('reports a link that alfaview cannot find, and a link without a room, without a change', async () => {
    const tools = await harness([loginRequest(), linkRequest(problem(404)), read({ roomId: '' })]);
    const missing = await tools.call('update_group_link', { groupLinkId: LINK_ID, description: 'Open day' });
    const roomless = await tools.call('update_group_link', { groupLinkId: LINK_ID, description: 'Open day' });
    await tools.done();

    assert.equal(missing.summary, GROUP_LINK_NOT_FOUND);
    assert.equal(roomless.summary, MISSING_GROUP_LINK_ROOM_MESSAGE);
  });

  it('refuses an unknown group and a name of two groups before the change', async () => {
    const twoGuests = [
      ...fixture<Json[]>('rooms/permission-groups.json'),
      { id: 'b1c2d3e4-f5a6-5b7c-8d9e-0f1a2b3c4d5e', name: 'Guest', permissions: {} },
    ];
    const tools = await harness([loginRequest(), read(), groupsRequest(), read(), groupsRequest(ok(twoGuests))]);
    const unknown = await tools.call('update_group_link', { groupLinkId: LINK_ID, permissionGroup: 'Webinar' });
    const twice = await tools.call('update_group_link', { groupLinkId: LINK_ID, permissionGroup: 'guest' });
    await tools.done();

    assert.match(unknown.summary, /^This company has no permission group Webinar\. /);
    assert.match(twice.summary, /^More than one permission group is named guest\. /);
  });

  it('refuses a permission group with admin before the change, at every level', async () => {
    for (const level of [undefined, 'read', 'standard', 'manage', 'full'] as const) {
      const tools = await harness([loginRequest(), read(), groupsRequest()], level === undefined ? {} : { level });
      const result = await tools.call('update_group_link', { groupLinkId: LINK_ID, permissionGroup: 'Admin' });
      await tools.done();

      assert.deepEqual([result.isError, result.summary], [true, ADMIN_GROUP_MESSAGE], String(level));
      assert.match(tools.logLines.at(-1)!, /: AdminGroupRefused, 3 requests, /);
    }
  });

  // A person can make a link with admin in alfaview. A change without a new group would keep its
  // rights, and a new validity would turn its join URL on again.
  it('refuses a change of a link with admin when the call gives no group, at every level', async () => {
    const adminLink = { permissionGroupId: 'A0B1C2D3-E4F5-5061-8728-394A5B6C7D8E', validUntil: '2026-09-30T10:00:00Z' };
    for (const level of [undefined, 'read', 'standard', 'manage', 'full'] as const) {
      for (const change of [{ validUntil: '2026-12-31T23:00' }, { description: 'Open day' }, { dialInAllowed: true }]) {
        const tools = await harness([loginRequest(), read(adminLink), groupsRequest()], level === undefined ? {} : { level });
        const result = await tools.call('update_group_link', { groupLinkId: LINK_ID, ...change });
        await tools.done();

        assert.deepEqual([result.isError, result.summary], [true, ADMIN_GROUP_LINK_MESSAGE], String(level));
        assert.match(tools.logLines.at(-1)!, /: AdminGroupRefused, 3 requests, /);
      }
    }
    assert.equal(
      ADMIN_GROUP_LINK_MESSAGE,
      'This group link has a permission group with admin rights, so everyone with its join URL can change and delete the room. Give permissionGroup a group without admin in the same call, or delete the link with delete_group_link.',
    );
  });

  it('changes a link with admin when the call gives a group without admin', async () => {
    const tools = await harness([
      loginRequest(),
      read({ permissionGroupId: 'a0b1c2d3-e4f5-5061-8728-394a5b6c7d8e' }),
      groupsRequest(),
      patch({ permissionGroupId: 'f4a5b6c7-d8e9-5f0a-9b1c-2d3e4f5a6b7c' }),
      read({ permissionGroupId: 'f4a5b6c7-d8e9-5f0a-9b1c-2d3e4f5a6b7c' }),
    ]);
    const result = await tools.call('update_group_link', { groupLinkId: LINK_ID, permissionGroup: 'Spectator' });
    await tools.done();

    assert.equal(result.isError, false, result.summary);
    assert.equal(result.data.permissionGroupName, 'Spectator');
  });

  it('changes a link whose stored group is not in the list, with a null group name', async () => {
    const unknown = { permissionGroupId: '00000000-0000-5000-8000-000000000999' };
    const tools = await harness([
      loginRequest(),
      read(unknown),
      groupsRequest(),
      patch({ dialInAllowed: true }),
      read({ ...unknown, dialInAllowed: true }),
    ]);
    const result = await tools.call('update_group_link', { groupLinkId: LINK_ID, dialInAllowed: true });
    await tools.done();

    assert.deepEqual([result.data.permissionGroupName, result.data.dialInAllowed], [null, true]);
  });

  // The group list holds the check of the stored group, so its error stops the change.
  it('changes nothing when the group list fails', async () => {
    const tools = await harness([loginRequest(), read(), groupsRequest(problem(500))]);
    const result = await tools.call('update_group_link', { groupLinkId: LINK_ID, dialInAllowed: true });
    await tools.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, 'alfaview had a temporary problem (HTTP 500). Try again later.');
  });

  it('says that the change is saved when reading the link back fails, with the code of the read error', async () => {
    const tools = await harness([
      loginRequest(),
      read(),
      groupsRequest(),
      patch({ description: 'Open day' }),
      linkRequest(problem(503, 'problem-500.json')),
      read(),
      groupsRequest(),
      patch({ description: 'Open day' }),
      linkRequest(problem(404)),
    ]);
    const failed = await tools.call('update_group_link', { groupLinkId: LINK_ID, description: 'Open day' });
    const gone = await tools.call('update_group_link', { groupLinkId: LINK_ID, description: 'Open day' });
    await tools.done();

    for (const result of [failed, gone]) {
      assert.deepEqual([result.isError, result.summary], [true, groupLinkUpdatedButNotReadMessage(LINK_ID)]);
    }
    assert.match(toolLines(tools.logLines)[0]!, /: ServerError, 5 requests, /);
    assert.match(toolLines(tools.logLines)[1]!, /: NotFound, /);
  });

  it('gives the texts of a refused change', async () => {
    const tools = await harness([
      loginRequest(),
      read(),
      groupsRequest(),
      patch({ description: 'Open day' }, problem(403)),
      read(),
      groupsRequest(),
      patch({ description: 'Open day' }, invalidProblem('dial-in quota exceeded')),
    ]);
    const forbidden = await tools.call('update_group_link', { groupLinkId: LINK_ID, description: 'Open day' });
    const invalid = await tools.call('update_group_link', { groupLinkId: LINK_ID, description: 'Open day' });
    await tools.done();

    assert.match(forbidden.summary, FORBIDDEN);
    assert.equal(invalid.summary, 'alfaview could not process the input: dial-in quota exceeded.');
  });
});

describe('delete_group_link', () => {
  const deleteRequest = (roomId = ROOM_ID, id = LINK_ID, respond: FakeAnswer = { status: 204 }): ExpectedRequest => ({
    method: 'DELETE',
    path: `/v2/rooms/${roomId}/group-links/${id}`,
    respond,
  });

  it('reads the link, then deletes it in its room', async () => {
    const tools = await harness([loginRequest(), linkRequest(ok(apiLink())), deleteRequest()]);
    const result = await tools.call('delete_group_link', { groupLinkId: LINK_ID });
    await tools.done();

    assert.equal(
      result.summary,
      `Deleted group link ${LINK_ID} of room ${ROOM_ID}. Its join URL no longer works for anyone. alfaview sent no email.`,
    );
    assert.deepEqual(result.data, { groupLinkId: LINK_ID, roomId: ROOM_ID, deleted: true, warnings: [] });
  });

  it('deletes in the room of the link, the room in lowercase, also for a link ID in uppercase', async () => {
    const upper = LINK_ID.toUpperCase();
    const tools = await harness([
      loginRequest(),
      linkRequest(ok(apiLink({ roomId: ROOM_ID.toUpperCase() })), upper),
      deleteRequest(ROOM_ID, upper),
    ]);
    const result = await tools.call('delete_group_link', { groupLinkId: upper });
    await tools.done();

    assert.deepEqual([result.data.groupLinkId, result.data.roomId], [upper, ROOM_ID.toUpperCase()]);
  });

  it('says that nothing was deleted when alfaview cannot find the link, also on a repeat', async () => {
    const tools = await harness([
      loginRequest(),
      linkRequest(ok(apiLink())),
      deleteRequest(),
      linkRequest(problem(404)),
    ]);
    const deleted = await tools.call('delete_group_link', { groupLinkId: LINK_ID });
    const repeat = await tools.call('delete_group_link', { groupLinkId: LINK_ID });
    await tools.done();

    assert.equal(deleted.isError, false);
    assert.deepEqual([repeat.isError, repeat.summary], [true, GROUP_LINK_DELETE_NOT_FOUND_MESSAGE]);
    assert.match(toolLines(tools.logLines)[1]!, /: NotFound, 1 request, /);
  });

  it('refuses a link of a meeting room and a link without a room, without a delete', async () => {
    const tools = await harness([
      loginRequest(),
      linkRequest(ok(apiLink({ roomId: MEETING_ID }))),
      linkRequest(ok(apiLink({ roomId: undefined }))),
    ]);
    const meeting = await tools.call('delete_group_link', { groupLinkId: LINK_ID });
    const roomless = await tools.call('delete_group_link', { groupLinkId: LINK_ID });
    await tools.done();

    assert.deepEqual([meeting.isError, meeting.summary], [true, GROUP_LINK_MEETING_ROOM_MESSAGE]);
    assert.match(toolLines(tools.logLines)[0]!, /: MeetingRoomRefused, 2 requests, /);
    assert.equal(roomless.summary, MISSING_GROUP_LINK_ROOM_MESSAGE);
  });

  it('gives the texts of a refused read and a refused delete', async () => {
    const tools = await harness([
      loginRequest(),
      linkRequest(problem(403)),
      linkRequest(ok(apiLink())),
      deleteRequest(ROOM_ID, LINK_ID, problem(403)),
    ]);
    const read = await tools.call('delete_group_link', { groupLinkId: LINK_ID });
    const remove = await tools.call('delete_group_link', { groupLinkId: LINK_ID });
    await tools.done();

    assert.match(read.summary, FORBIDDEN);
    assert.match(remove.summary, FORBIDDEN);
  });
});
