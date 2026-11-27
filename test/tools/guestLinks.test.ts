// find_guest_links, create_guest_links, update_guest_link, delete_guest_link and
// delete_expired_guest_links through an MCP SDK client.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ADMIN_GUEST_GROUP_MESSAGE,
  ADMIN_GUEST_LINK_MESSAGE,
  ALL_ROOMS_DENIED_MESSAGE,
  BULK_DELETE_MEETING_ROOM_MESSAGE,
  DELETE_NOT_FOUND_MESSAGE,
  EXISTING_LINK_MESSAGE,
  guestLinkCreatedButNotReadMessage,
  guestLinkUpdatedButNotReadMessage,
  MEETING_ROOM_EMAIL_MESSAGE,
  MISSING_LINK_ROOM_MESSAGE,
  NOT_ATTEMPTED_MESSAGE,
  OTHER_RIGHTS_MESSAGE,
  PAST_VALID_UNTIL_MESSAGE,
  ROOM_UNKNOWN_EMAIL_MESSAGE,
  UNCERTAIN_CREATE_MESSAGE,
} from '../../src/domain/guestLinks.ts';
import { GUEST_LINK_TOOLS } from '../../src/tools/guestLinks.ts';
import {
  CHANGE_ANNOTATIONS,
  CREATE_ANNOTATIONS,
  IDEMPOTENT_CHANGE_ANNOTATIONS,
  READ_ANNOTATIONS,
} from '../../src/tools/tool.ts';
import { testClock } from '../helpers/clock.ts';
import {
  loginRequest,
  untilRequests,
  type ExpectedRequest,
  type FakeAnswer,
} from '../helpers/fakeFetch.ts';
import { nonexistentLocalTime, unrecognizedDateTime } from '../helpers/dateTimeMessages.ts';
import { fixture } from '../helpers/fixtures.ts';
import { callTool, toolHarness, type HarnessOptions } from '../helpers/mcpClient.ts';

const ROOM_ID = '0b7c5d2e-91a4-5f3b-8e27-0f4a6c9d1e22';
const MEETING_ID = '7e9a1c3d-5b2f-5a4e-8c6d-22f0a1b2c3d4';
const LINK_ID = '3f2a9c1e-7b4d-5e21-a3c4-14b7e9d0f6a2';
const MAX_LINK_ID = '7a1b2c3d-4e5f-5a6b-9c7d-14e2f3a4b5c6';
const GUEST_GROUP_ID = 'd2b3c4d5-e6f7-5081-9a2b-c3d4e5f6a7b8';
const SPECTATOR_GROUP_ID = 'f4a5b6c7-d8e9-5f0a-9b1c-2d3e4f5a6b7c';
const NEW_ID_1 = 'aa000000-0000-5000-8000-000000000001';
const NEW_ID_2 = 'aa000000-0000-5000-8000-000000000002';
const NEW_ID_3 = 'aa000000-0000-5000-8000-000000000003';
const BAD_IDS = ['Advisory Room', '.', '..', '0b7c5d2e-91a4-5f3b-0f4a6c9d1e22'];

/** 2026-10-07T18:00 and 20:00 in Berlin (summer time). */
const EVENT_FROM_UTC = '2026-10-07T16:00:00.000Z';
const EVENT_UNTIL_UTC = '2026-10-07T18:00:00.000Z';
const EVENT_FROM_LOCAL = '2026-10-07T18:00:00+02:00';
const EVENT_UNTIL_LOCAL = '2026-10-07T20:00:00+02:00';
/** The same times as a summary gives them. */
const EVENT_FROM_TEXT = '2026-10-07 18:00 Europe/Berlin';
const EVENT_UNTIL_TEXT = '2026-10-07 20:00 Europe/Berlin';

const JANE = { emailAddress: 'jane.doe@example.com', displayName: 'Jane Doe' };
const MAX = { emailAddress: 'max.mustermann@example.com', displayName: 'Max Mustermann' };
const ERIKA = { emailAddress: 'erika@example.com', displayName: 'Erika Example' };

function apiLink(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...fixture<Record<string, unknown>>('guestLinks/guest-link.json'), ...overrides };
}

function joinUrlOf(id: string): string {
  return `https://app.alfaview.com/#/join/0123456789ABCDEFGHIJKLMNOP/${ROOM_ID}/${id}`;
}

const groupsRequest = (respond: FakeAnswer = { status: 200, body: fixture('rooms/permission-groups.json') }): ExpectedRequest => ({
  method: 'GET',
  path: '/v2/permission-groups',
  respond,
});

function linksPage(links: unknown[], path = `/v2/rooms/${ROOM_ID}/guest-links`): ExpectedRequest {
  return {
    method: 'GET',
    path,
    query: { limit: '500' },
    respond: { status: 200, body: { data: links } },
  };
}

function linkRequest(id: string, respond: FakeAnswer): ExpectedRequest {
  return { method: 'GET', path: `/v2/guest-links/${id}`, respond };
}

function roomRequest(respond: FakeAnswer, roomId = ROOM_ID): ExpectedRequest {
  return { method: 'GET', path: `/v2/rooms/${roomId}`, respond };
}

function harness(expected: readonly ExpectedRequest[], options: HarnessOptions = {}) {
  return toolHarness(GUEST_LINK_TOOLS, expected, options);
}

describe('the guest link tools', () => {
  it('are listed in their fixed order, with their annotations', async () => {
    const tools = await harness([]);
    const { tools: listed } = await tools.client.listTools();
    await tools.done();

    assert.deepEqual(
      listed.map((tool) => [tool.name, tool.annotations]),
      [
        ['find_guest_links', READ_ANNOTATIONS],
        ['create_guest_links', CREATE_ANNOTATIONS],
        ['update_guest_link', CHANGE_ANNOTATIONS],
        ['delete_guest_link', IDEMPOTENT_CHANGE_ANNOTATIONS],
        ['delete_expired_guest_links', CHANGE_ANNOTATIONS],
      ],
    );
  });

  it('refuse a name, dot segments and a broken UUID as an ID without a request', async () => {
    const tools = await harness([]);
    const calls: [string, Record<string, unknown>, RegExp][] = [];
    for (const id of BAD_IDS) {
      const roomMessage = /roomId takes an ID from find_rooms, or a meeting ID, not a name\./;
      const linkMessage = /guestLinkId takes an ID from find_guest_links or create_guest_links\./;
      calls.push(
        ['find_guest_links', { roomId: id }, roomMessage],
        ['create_guest_links', { roomId: id, guests: [JANE], locale: 'de-DE' }, roomMessage],
        ['update_guest_link', { guestLinkId: id, displayName: 'Jane' }, linkMessage],
        ['delete_guest_link', { guestLinkId: id }, linkMessage],
        ['delete_expired_guest_links', { roomId: id }, roomMessage],
      );
    }
    for (const [name, args, message] of calls) {
      const result = await tools.call(name, args);
      assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
      assert.match(result.summary, message);
    }
    await tools.done();
  });
});

describe('find_guest_links', () => {
  const expiredJane = apiLink({
    id: 'bb000000-0000-5000-8000-000000000001',
    validFrom: '2026-10-06T08:00:00Z',
    validUntil: '2026-10-06T10:00:00Z',
    createdAt: '2026-09-24T10:00:00Z',
  });
  const winterJane = apiLink({
    id: 'bb000000-0000-5000-8000-000000000002',
    validFrom: '2026-11-02T09:00:00Z',
    validUntil: '2026-11-02T10:00:00Z',
    createdAt: '2026-09-23T10:00:00Z',
  });
  const roomLinks = () => [
    fixture('guestLinks/guest-link-unbounded.json'),
    expiredJane,
    apiLink(),
    winterJane,
  ];

  it('lists the valid links of a room, newest first, without room IDs and join URLs', async () => {
    const tools = await harness([loginRequest(), linksPage(roomLinks()), groupsRequest()]);
    const result = await tools.call('find_guest_links', { roomId: ROOM_ID });
    await tools.done();

    assert.equal(
      result.summary,
      'Found 3 guest links. Showing 1 to 3. 1 expired guest link also matches. Call again with includeExpired true, for example for attendance after an event.',
    );
    assert.deepEqual(result.data, {
      roomId: ROOM_ID,
      totalMatches: 3,
      expiredMatchCount: 1,
      offset: 0,
      nextOffset: null,
      links: [
        {
          id: LINK_ID,
          inMeetingRoom: false,
          emailAddress: 'jane.doe@example.com',
          displayName: 'Jane Doe',
          locale: 'de-DE',
          validFrom: '2026-10-07T10:45:00+02:00',
          validUntil: '2026-10-07T12:15:00+02:00',
          permissionGroupName: 'Guest',
          dialInAllowed: false,
          origin: 'Zapier',
          createdAt: '2026-09-25T12:00:00+02:00',
        },
        {
          id: 'bb000000-0000-5000-8000-000000000002',
          inMeetingRoom: false,
          emailAddress: 'jane.doe@example.com',
          displayName: 'Jane Doe',
          locale: 'de-DE',
          validFrom: '2026-11-02T10:00:00+01:00',
          validUntil: '2026-11-02T11:00:00+01:00',
          permissionGroupName: 'Guest',
          dialInAllowed: false,
          origin: 'Zapier',
          createdAt: '2026-09-23T12:00:00+02:00',
        },
        {
          id: MAX_LINK_ID,
          inMeetingRoom: false,
          emailAddress: 'max.mustermann@example.com',
          displayName: null,
          locale: 'en-US',
          validFrom: null,
          validUntil: null,
          permissionGroupName: 'Spectator',
          dialInAllowed: true,
          origin: 'Public API',
          createdAt: '2026-09-20T09:15:30+02:00',
        },
      ],
      warnings: [
        '1 expired guest link also matches. Call again with includeExpired true, for example for attendance after an event.',
      ],
    });
  });

  // The spec allows the locale `unknown` in a guest link. The tool gives null for it, as for an
  // empty locale.
  it('returns a null locale for a link whose locale alfaview answers as unknown', async () => {
    const tools = await harness([loginRequest(), linksPage([apiLink({ locale: 'unknown' })]), groupsRequest()]);
    const result = await tools.call('find_guest_links', { roomId: ROOM_ID });
    await tools.done();

    assert.equal(result.isError, false);
    assert.deepEqual(
      result.data.links.map((link: { id: string; locale: string | null }) => [link.id, link.locale]),
      [[LINK_ID, null]],
    );
  });

  it('filters by email address in any case and by the exact origin, with expired links and join URLs', async () => {
    const tools = await harness([
      loginRequest(),
      linksPage([...roomLinks(), apiLink({ id: 'bb000000-0000-5000-8000-000000000003', origin: 'zapier' })]),
      groupsRequest(),
    ]);
    const result = await tools.call('find_guest_links', {
      roomId: ROOM_ID,
      emailAddress: ' JANE.Doe@Example.com ',
      origin: 'Zapier',
      includeExpired: true,
      includeJoinUrls: true,
    });
    await tools.done();

    assert.equal(result.summary, 'Found 3 guest links. Showing 1 to 3.');
    assert.equal(result.data.expiredMatchCount, 1);
    assert.deepEqual(
      result.data.links.map((link: { id: string }) => link.id),
      [LINK_ID, 'bb000000-0000-5000-8000-000000000001', 'bb000000-0000-5000-8000-000000000002'],
    );
    assert.equal(result.data.links[0].joinUrl, apiLink().joinUrl);
    assert.ok(!('roomId' in result.data.links[0]));
    assert.deepEqual(result.data.warnings, []);
  });

  it('searches every room without roomId, and then gives each link its room', async () => {
    const tools = await harness([
      loginRequest(),
      linksPage([apiLink(), apiLink({ id: MAX_LINK_ID, roomId: MEETING_ID })], '/v2/guest-links'),
      groupsRequest(),
    ]);
    const result = await tools.call('find_guest_links', {});
    await tools.done();

    assert.equal(result.data.roomId, null);
    assert.equal(result.data.links[0].roomId, ROOM_ID);
    assert.ok(!('joinUrl' in result.data.links[0]));
    // delete_guest_link refuses a link of a meeting room without sendEmail, so the list marks such
    // a link without another request.
    assert.deepEqual(
      result.data.links.map((link: { roomId: string; inMeetingRoom: boolean }) => [link.roomId, link.inMeetingRoom]),
      [
        [ROOM_ID, false],
        [MEETING_ID, true],
      ],
    );
  });

  for (const status of [403, 404]) {
    it(`says which permissions a search of every room needs after HTTP ${status}`, async () => {
      const tools = await harness([
        loginRequest(),
        {
          method: 'GET',
          path: '/v2/guest-links',
          query: { limit: '500' },
          respond: { status, body: fixture(`core/problem-${status}.json`) },
        },
      ]);
      const result = await tools.call('find_guest_links', { emailAddress: 'jane.doe@example.com' });
      await tools.done();

      assert.equal(result.isError, true);
      assert.equal(result.summary, ALL_ROOMS_DENIED_MESSAGE);
    });
  }

  it('reads no group names when no link matches', async () => {
    const tools = await harness([loginRequest(), linksPage(roomLinks())]);
    const result = await tools.call('find_guest_links', {
      roomId: ROOM_ID,
      emailAddress: 'nobody@example.com',
    });
    await tools.done();

    assert.equal(result.summary, 'Found no guest links.');
    assert.deepEqual(result.data.links, []);
    assert.equal(result.data.expiredMatchCount, 0);
  });

  it('gives null group names when the group list fails', async () => {
    const tools = await harness([
      loginRequest(),
      linksPage([apiLink()]),
      groupsRequest({ status: 500, body: fixture('core/problem-500.json') }),
    ]);
    const result = await tools.call('find_guest_links', { roomId: ROOM_ID });
    await tools.done();

    assert.equal(result.isError, false);
    assert.equal(result.data.links[0].permissionGroupName, null);
  });

  it('pages with limit and offset, and counts several expired links', async () => {
    const expiredMax = apiLink({
      id: 'bb000000-0000-5000-8000-000000000004',
      validUntil: '2026-10-01T10:00:00Z',
    });
    const tools = await harness([
      loginRequest(),
      linksPage([...roomLinks(), expiredMax]),
      groupsRequest(),
      linksPage([...roomLinks(), expiredMax]),
    ]);
    const first = await tools.call('find_guest_links', { roomId: ROOM_ID, limit: 2 });
    const beyond = await tools.call('find_guest_links', { roomId: ROOM_ID, offset: 3 });
    await tools.done();

    assert.equal(
      first.summary,
      'Found 3 guest links. Showing 1 to 2. Call again with offset 2 for the next ones. 2 expired guest links also match. Call again with includeExpired true, for example for attendance after an event.',
    );
    assert.equal(first.data.nextOffset, 2);
    assert.equal(first.data.links.length, 2);
    assert.match(beyond.summary, /^Found 3 guest links\. Nothing at offset 3\./);
  });

  it('reports a room that alfaview cannot find', async () => {
    const tools = await harness([
      loginRequest(),
      {
        method: 'GET',
        path: `/v2/rooms/${ROOM_ID}/guest-links`,
        query: { limit: '500' },
        respond: { status: 404, body: fixture('core/problem-404.json') },
      },
    ]);
    const result = await tools.call('find_guest_links', { roomId: ROOM_ID });
    await tools.done();

    assert.equal(result.isError, true);
    assert.match(result.summary, /^alfaview could not find the room\./);
  });

  it('refuses a text of only spaces without a request', async () => {
    const tools = await harness([]);
    const result = await tools.call('find_guest_links', { emailAddress: '  ' });
    await tools.done();

    assert.equal(result.isError, true);
  });
});

type Guest = { emailAddress: string; displayName: string; locale?: string };

/**
 * The expected create of one guest: the defaults, changed by `body`. An undefined value is left
 * out.
 */
function createRequest(
  guest: Guest,
  respond: FakeAnswer,
  body: Record<string, unknown> = {},
): ExpectedRequest {
  const { create, ...rest } = body as { create?: Record<string, unknown> };
  const entry = {
    emailAddress: guest.emailAddress,
    displayName: guest.displayName,
    locale: guest.locale ?? 'de-DE',
    permissionGroupId: GUEST_GROUP_ID,
    dialInAllowed: false,
    sendEmail: false,
    validFrom: EVENT_FROM_UTC,
    validUntil: EVENT_UNTIL_UTC,
    ...create,
  };
  return {
    method: 'POST',
    path: `/v2/rooms/${ROOM_ID}/guest-links`,
    body: {
      create: [Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined))],
      origin: 'MCP',
      timezone: 'Europe/Berlin',
      ...rest,
    },
    respond,
  };
}

/** The userIds that alfaview returns with the new links for their guests. */
const NEW_USER_IDS: Record<string, string> = {
  [NEW_ID_1]: 'aa000000-0000-5000-8000-180000000001',
  [NEW_ID_2]: 'aa000000-0000-5000-8000-180000000002',
  [NEW_ID_3]: 'aa000000-0000-5000-8000-180000000003',
};

/**
 * The 201 of a create: alfaview answers the created guest links, each with the userId of its guest
 * and the join URL. The tool takes the ID and the join URL of the first link, and reads nothing
 * back, so the other fields are those of the fixture.
 */
const created = (id: string): FakeAnswer => ({
  status: 201,
  body: [apiLink({ id, userId: NEW_USER_IDS[id], joinUrl: joinUrlOf(id) })],
});

/**
 * Create answers of the new link `id` without a join URL: only the ID, or the link with a blank
 * join URL. The tool then reads the link back for its join URL.
 */
const withoutJoinUrl = (id: string): [string, FakeAnswer][] => [
  ['only the ID', { status: 201, body: [{ id }] }],
  ['a blank join URL', { status: 201, body: [apiLink({ id, userId: NEW_USER_IDS[id], joinUrl: ' ' })] }],
];

/** The read back of the new link `id` of `guest`, after a create answer without a join URL. */
function readBack(id: string, guest: Guest): ExpectedRequest {
  return linkRequest(id, {
    status: 200,
    body: apiLink({ id, ...guest, joinUrl: joinUrlOf(id) }),
  });
}

const EVENT = {
  roomId: ROOM_ID,
  locale: 'de-DE',
  validFrom: '2026-10-07T18:00',
  validUntil: '2026-10-07T20:00',
};

/** The login, the group list and the link list before the creates. */
function before(links: unknown[] = []): ExpectedRequest[] {
  return [loginRequest(), groupsRequest(), linksPage(links)];
}

/** The result of `guest`, at `index` of the input, whose link the call created as `id`. */
function createdResult(guest: Guest, id: string, index: number) {
  return {
    index,
    ...guest,
    status: 'created',
    guestLinkId: id,
    joinUrl: joinUrlOf(id),
    permissionGroupName: 'Guest',
    dialInAllowed: false,
    message: null,
  };
}

/** The result of a guest at `index` of the input without a link: `status` with `message`. */
function withoutLink(guest: Guest, status: string, message: string, index: number) {
  return {
    index,
    ...guest,
    status,
    guestLinkId: null,
    joinUrl: null,
    permissionGroupName: null,
    dialInAllowed: null,
    message,
  };
}

function notAttempted(guest: Guest, index: number) {
  return withoutLink(guest, 'not_attempted', NOT_ATTEMPTED_MESSAGE, index);
}

describe('create_guest_links', () => {
  it('creates one link per guest with the defaults, and takes each join URL from the create answer', async () => {
    const tools = await harness([
      ...before(),
      createRequest(JANE, created(NEW_ID_1)),
      createRequest({ ...MAX, locale: 'en-US' }, created(NEW_ID_2)),
    ]);
    const result = await tools.call('create_guest_links', {
      ...EVENT,
      guests: [JANE, { ...MAX, locale: 'en-US' }],
    });
    await tools.done();

    assert.equal(
      result.summary,
      `Created 2 guest links in room ${ROOM_ID}, valid from ${EVENT_FROM_TEXT} until ${EVENT_UNTIL_TEXT}. alfaview sent no emails.`,
    );
    assert.deepEqual(result.data, {
      roomId: ROOM_ID,
      permissionGroupName: 'Guest',
      validFrom: EVENT_FROM_LOCAL,
      validUntil: EVENT_UNTIL_LOCAL,
      createdCount: 2,
      existingCount: 0,
      failedCount: 0,
      uncertainCount: 0,
      notAttemptedCount: 0,
      results: [createdResult(JANE, NEW_ID_1, 0), createdResult(MAX, NEW_ID_2, 1)],
      warnings: [],
    });
    // The login, the groups, the links of the room and one create per guest: no read back.
    assert.equal(tools.logLines.at(-1), 'alfaview-mcp: tool create_guest_links: ok, 5 requests, 0 ms\n');
  });

  it('sends the chosen group, origin, email, dial-in and time zone, and reads and gives times in that zone', async () => {
    const tools = await harness([
      ...before(),
      createRequest(JANE, created(NEW_ID_1), {
        create: {
          permissionGroupId: SPECTATOR_GROUP_ID,
          dialInAllowed: true,
          sendEmail: true,
          validFrom: '2026-11-10T14:00:00.000Z',
          validUntil: '2026-11-10T16:00:00.000Z',
        },
        origin: 'Webinar 2026-11-10',
        timezone: 'America/New_York',
      }),
    ]);
    const result = await tools.call('create_guest_links', {
      roomId: ROOM_ID,
      guests: [JANE],
      locale: 'de-DE',
      validFrom: '2026-11-10T09:00',
      validUntil: '2026-11-10T11:00',
      permissionGroup: ' spectator ',
      origin: 'Webinar 2026-11-10',
      sendEmail: true,
      dialInAllowed: true,
      timezone: 'america/new_york',
    });
    await tools.done();

    assert.equal(
      result.summary,
      `Created 1 guest link in room ${ROOM_ID}, valid from 2026-11-10 09:00 America/New_York until 2026-11-10 11:00 America/New_York. alfaview emails each created guest.`,
    );
    assert.deepEqual(
      [result.data.validFrom, result.data.validUntil],
      ['2026-11-10T09:00:00-05:00', '2026-11-10T11:00:00-05:00'],
    );
    assert.equal(result.data.permissionGroupName, 'Spectator');
    assert.deepEqual(
      [result.data.results[0].permissionGroupName, result.data.results[0].dialInAllowed],
      ['Spectator', true],
    );
  });

  it('creates links without validity, and takes a group ID in upper case', async () => {
    const tools = await harness([
      ...before(),
      createRequest(JANE, created(NEW_ID_1), {
        create: { permissionGroupId: SPECTATOR_GROUP_ID, validFrom: undefined, validUntil: undefined },
      }),
    ]);
    const result = await tools.call('create_guest_links', {
      roomId: ROOM_ID,
      guests: [JANE],
      locale: 'de-DE',
      permissionGroup: SPECTATOR_GROUP_ID.toUpperCase(),
    });
    await tools.done();

    assert.equal(
      result.summary,
      `Created 1 guest link in room ${ROOM_ID}, valid from any time until no end. alfaview sent no emails.`,
    );
    assert.equal(result.data.validFrom, null);
    assert.equal(result.data.validUntil, null);
  });

  it('returns a guest with a matching link as existing, without a request for it', async () => {
    const janesLink = apiLink({
      id: LINK_ID,
      emailAddress: ' Jane.Doe@EXAMPLE.com ',
      origin: 'MCP',
      validFrom: '2026-10-07T16:00:00Z',
      validUntil: '2026-10-07T18:00:00Z',
    });
    const tools = await harness([...before([janesLink]), createRequest(MAX, created(NEW_ID_2))]);
    const result = await tools.call('create_guest_links', { ...EVENT, guests: [JANE, MAX] });
    await tools.done();

    assert.equal(
      result.summary,
      `Created 1 guest link in room ${ROOM_ID}, valid from ${EVENT_FROM_TEXT} until ${EVENT_UNTIL_TEXT}. 1 guest already had a link. alfaview sent no emails.`,
    );
    assert.deepEqual(result.data.results, [
      {
        index: 0,
        ...JANE,
        status: 'existing',
        guestLinkId: LINK_ID,
        joinUrl: apiLink().joinUrl,
        permissionGroupName: 'Guest',
        dialInAllowed: false,
        message: EXISTING_LINK_MESSAGE,
      },
      createdResult(MAX, NEW_ID_2, 1),
    ]);
    assert.equal(result.data.existingCount, 1);
  });

  it('fails a guest whose matching link has another permission group, without a create or its join URL', async () => {
    const janesLink = apiLink({
      id: LINK_ID,
      origin: 'MCP',
      validFrom: '2026-10-07T16:00:00Z',
      validUntil: '2026-10-07T18:00:00Z',
    });
    const tools = await harness([
      ...before([janesLink]),
      createRequest(MAX, created(NEW_ID_2), { create: { permissionGroupId: SPECTATOR_GROUP_ID } }),
    ]);
    const result = await tools.call('create_guest_links', {
      ...EVENT,
      guests: [JANE, MAX],
      permissionGroup: 'Spectator',
    });
    await tools.done();

    assert.equal(
      result.summary,
      `Created 1 guest link in room ${ROOM_ID}, valid from ${EVENT_FROM_TEXT} until ${EVENT_UNTIL_TEXT}. 1 failed. alfaview sent no emails.`,
    );
    assert.deepEqual(result.data.results, [
      {
        index: 0,
        ...JANE,
        status: 'failed',
        guestLinkId: LINK_ID,
        joinUrl: null,
        permissionGroupName: 'Guest',
        dialInAllowed: false,
        message: OTHER_RIGHTS_MESSAGE,
      },
      { ...createdResult(MAX, NEW_ID_2, 1), permissionGroupName: 'Spectator' },
    ]);
    assert.deepEqual(
      [result.data.permissionGroupName, result.data.existingCount, result.data.failedCount],
      ['Spectator', 0, 1],
    );
  });

  it('fails a guest whose matching link has another dial-in setting', async () => {
    const janesLink = apiLink({
      id: LINK_ID,
      origin: 'MCP',
      validFrom: '2026-10-07T16:00:00Z',
      validUntil: '2026-10-07T18:00:00Z',
    });
    const tools = await harness(before([janesLink]));
    const result = await tools.call('create_guest_links', {
      ...EVENT,
      guests: [JANE],
      dialInAllowed: true,
    });
    await tools.done();

    assert.equal(result.isError, false);
    assert.deepEqual(
      [result.data.results[0].status, result.data.results[0].dialInAllowed, result.data.results[0].joinUrl],
      ['failed', false, null],
    );
    assert.equal(result.data.results[0].message, OTHER_RIGHTS_MESSAGE);
  });

  it('creates a new link when the origin, the validity or the email address differ', async () => {
    const near = (overrides: Record<string, unknown>) =>
      apiLink({
        origin: 'MCP',
        validFrom: '2026-10-07T16:00:00Z',
        validUntil: '2026-10-07T18:00:00Z',
        ...overrides,
      });
    const tools = await harness([
      ...before([
        near({ origin: 'mcp' }),
        near({ validFrom: '2026-10-07T16:00:01Z' }),
        near({ validUntil: '0001-01-01T00:00:00Z' }),
        near({ emailAddress: 'jane.doe@example.org' }),
      ]),
      createRequest(JANE, created(NEW_ID_1)),
    ]);
    const result = await tools.call('create_guest_links', { ...EVENT, guests: [JANE] });
    await tools.done();

    assert.equal(result.data.createdCount, 1);
    assert.equal(result.data.existingCount, 0);
  });

  it('creates a new link when the matching link ends now', async () => {
    const endsNow = apiLink({
      origin: 'MCP',
      validFrom: '2026-10-07T07:00:00Z',
      validUntil: '2026-10-07T08:00:00Z',
    });
    const tools = await harness([
      ...before([endsNow]),
      createRequest(JANE, created(NEW_ID_1), {
        create: { validFrom: '2026-10-07T07:00:00.000Z', validUntil: '2026-10-07T08:00:00.000Z' },
      }),
    ]);
    const result = await tools.call('create_guest_links', {
      ...EVENT,
      guests: [JANE],
      validFrom: '2026-10-07T09:00',
      validUntil: '2026-10-07T10:00',
    });
    await tools.done();

    assert.equal(result.data.createdCount, 1);
  });

  it('sends no create when the same input comes again', async () => {
    const tools = await harness([
      ...before(),
      createRequest(JANE, created(NEW_ID_1)),
      groupsRequest(),
      linksPage([
        apiLink({
          id: NEW_ID_1,
          ...JANE,
          origin: 'MCP',
          validFrom: '2026-10-07T16:00:00Z',
          validUntil: '2026-10-07T18:00:00Z',
          joinUrl: joinUrlOf(NEW_ID_1),
        }),
      ]),
    ]);
    const first = await tools.call('create_guest_links', { ...EVENT, guests: [JANE] });
    const second = await tools.call('create_guest_links', { ...EVENT, guests: [JANE] });
    await tools.done();

    assert.equal(first.data.results[0].status, 'created');
    assert.equal(second.data.results[0].status, 'existing');
    assert.equal(second.data.results[0].joinUrl, joinUrlOf(NEW_ID_1));
    assert.match(second.summary, /^Created 0 guest links in room .*\. 1 guest already had a link\./);
  });

  it('goes on after a problem with one guest, and counts it as failed', async () => {
    const tools = await harness([
      ...before(),
      createRequest(JANE, { status: 422, body: fixture('core/problem-422.json') }),
      createRequest(MAX, created(NEW_ID_2)),
    ]);
    const result = await tools.call('create_guest_links', { ...EVENT, guests: [JANE, MAX] });
    await tools.done();

    assert.equal(result.isError, false);
    assert.match(result.summary, /\. 1 failed\. alfaview sent no emails\.$/);
    assert.deepEqual(
      result.data.results[0],
      withoutLink(
        JANE,
        'failed',
        'alfaview could not process the input: validation failed. create[0].emailAddress: expected string to be RFC 5322 email. create[0].locale: expected value to be one of "de-DE, en-US".',
        0,
      ),
    );
    assert.equal(result.data.failedCount, 1);
    assert.equal(result.data.createdCount, 1);
  });

  it('fails the call when the first create has a problem of the whole request', async () => {
    const tools = await harness([
      ...before(),
      createRequest(JANE, {
        status: 422,
        body: { title: 'Unprocessable Entity', detail: 'rooms of the type department cannot have guest links' },
      }),
    ]);
    const result = await tools.call('create_guest_links', { ...EVENT, guests: [JANE, MAX] });
    await tools.done();

    assert.equal(result.isError, true);
    assert.equal(
      result.summary,
      'alfaview could not process the input: rooms of the type department cannot have guest links.',
    );
    assert.equal(tools.logLines.at(-1), 'alfaview-mcp: tool create_guest_links: ValidationFailed, 4 requests, 0 ms\n');
  });

  it('stops at a later problem of the whole request, and returns every status', async () => {
    const tools = await harness([
      ...before(),
      createRequest(JANE, created(NEW_ID_1)),
      createRequest(MAX, {
        status: 400,
        body: { title: 'Bad Request', detail: 'dial-in quota exceeded', errors: [{ message: 'x', location: 'body.timezone' }] },
      }),
    ]);
    const result = await tools.call('create_guest_links', { ...EVENT, guests: [JANE, MAX, ERIKA] });
    await tools.done();

    assert.equal(result.isError, false);
    assert.deepEqual(
      result.data.results.map((entry: { status: string }) => entry.status),
      ['created', 'failed', 'not_attempted'],
    );
    assert.equal(result.data.results[1].message, 'alfaview rejected the request: dial-in quota exceeded.');
    assert.deepEqual(result.data.results[2], notAttempted(ERIKA, 2));
    assert.deepEqual(result.data.warnings, [
      '0 links are uncertain and 1 was not attempted. Call create_guest_links again with the same input.',
    ]);
  });

  for (const status of [500, 502, 503, 504]) {
    it(`treats HTTP ${status} on a create as uncertain and stops`, async () => {
      const tools = await harness([
        ...before(),
        createRequest(JANE, created(NEW_ID_1)),
        createRequest(MAX, { status, body: fixture('core/problem-500.json') }),
      ]);
      const result = await tools.call('create_guest_links', {
        ...EVENT,
        guests: [JANE, MAX, ERIKA],
      });
      await tools.done();

      assert.deepEqual(
        result.data.results[1],
        withoutLink(MAX, 'uncertain', UNCERTAIN_CREATE_MESSAGE, 1),
      );
      assert.equal(result.data.uncertainCount, 1);
      assert.equal(result.data.notAttemptedCount, 1);
      assert.equal(
        result.summary,
        `Created 1 guest link in room ${ROOM_ID}, valid from ${EVENT_FROM_TEXT} until ${EVENT_UNTIL_TEXT}. alfaview sent no emails. 1 link is uncertain and 1 was not attempted. Call create_guest_links again with the same input.`,
      );
    });
  }

  it('fails the call when the first create is uncertain', async () => {
    const tools = await harness([
      ...before(),
      createRequest(JANE, { status: 503, body: fixture('core/problem-500.json') }),
    ]);
    const result = await tools.call('create_guest_links', { ...EVENT, guests: [JANE, MAX] });
    await tools.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, UNCERTAIN_CREATE_MESSAGE);
    assert.match(tools.logLines.at(-1)!, /: ServerError, 4 requests/);
  });

  it('returns the statuses when the first create is uncertain but a guest had a link', async () => {
    const janesLink = apiLink({
      origin: 'MCP',
      validFrom: '2026-10-07T16:00:00Z',
      validUntil: '2026-10-07T18:00:00Z',
    });
    const tools = await harness([
      ...before([janesLink]),
      createRequest(MAX, { networkError: 'ECONNRESET' }),
    ]);
    const result = await tools.call('create_guest_links', { ...EVENT, guests: [JANE, MAX] });
    await tools.done();

    assert.equal(result.isError, false);
    assert.deepEqual(
      result.data.results.map((entry: { status: string }) => entry.status),
      ['existing', 'uncertain'],
    );
  });

  it('treats a timeout of a create as uncertain', async () => {
    const tools = await harness(
      [...before(), createRequest(JANE, { hang: true })],
      { timeoutMs: 20 },
    );
    const result = await tools.call('create_guest_links', { ...EVENT, guests: [JANE] });
    await tools.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, UNCERTAIN_CREATE_MESSAGE);
    assert.match(tools.logLines.at(-1)!, /: Timeout, /);
  });

  it('treats a create answer without an ID as uncertain', async () => {
    const tools = await harness([...before(), createRequest(JANE, { status: 201, body: [] })]);
    const result = await tools.call('create_guest_links', { ...EVENT, guests: [JANE] });
    await tools.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, 'alfaview did not return the ID of the new guest link.');
    assert.match(tools.logLines.at(-1)!, /: InvalidResponse, /);
  });

  for (const [answerCase, answer] of withoutJoinUrl(NEW_ID_1)) {
    it(`reads the link back for its join URL when the create answer has ${answerCase}`, async () => {
      const tools = await harness([
        ...before(),
        createRequest(JANE, answer),
        readBack(NEW_ID_1, JANE),
        createRequest(MAX, created(NEW_ID_2)),
      ]);
      const result = await tools.call('create_guest_links', { ...EVENT, guests: [JANE, MAX] });
      await tools.done();

      assert.deepEqual(result.data.results, [createdResult(JANE, NEW_ID_1, 0), createdResult(MAX, NEW_ID_2, 1)]);
      assert.equal(tools.logLines.at(-1), 'alfaview-mcp: tool create_guest_links: ok, 6 requests, 0 ms\n');
    });

    it(`counts a link whose read back fails as created, without its join URL, and stops, when the create answer has ${answerCase}`, async () => {
      const tools = await harness([
        ...before(),
        createRequest(JANE, answer),
        linkRequest(NEW_ID_1, { status: 500, body: fixture('core/problem-500.json') }),
      ]);
      const result = await tools.call('create_guest_links', { ...EVENT, guests: [JANE, MAX] });
      await tools.done();

      assert.equal(result.isError, false);
      assert.deepEqual(result.data.results, [
        {
          ...createdResult(JANE, NEW_ID_1, 0),
          joinUrl: null,
          message: guestLinkCreatedButNotReadMessage(NEW_ID_1),
        },
        notAttempted(MAX, 1),
      ]);
    });
  }

  it('counts a link as created also when its ID cannot be read back at all', async () => {
    const tools = await harness([...before(), createRequest(JANE, { status: 201, body: [{ id: '..' }] })]);
    const result = await tools.call('create_guest_links', { ...EVENT, guests: [JANE] });
    await tools.done();

    assert.equal(result.data.results[0].status, 'created');
    assert.equal(result.data.results[0].message, guestLinkCreatedButNotReadMessage('..'));
  });

  it('starts no new guest after 35 seconds, so the call ends in time', async () => {
    const clock = testClock();
    const tools = await harness(
      [
        ...before(),
        createRequest(JANE, created(NEW_ID_1)),
        createRequest(MAX, created(NEW_ID_2)),
      ],
      {
        now: clock.now,
        wrapFetch: (fetch) => (input, init) => {
          clock.advance(7_000);
          return fetch(input, init);
        },
      },
    );
    const result = await tools.call('create_guest_links', { ...EVENT, guests: [JANE, MAX, ERIKA] });
    await tools.done();

    assert.deepEqual(
      result.data.results.map((entry: { status: string }) => entry.status),
      ['created', 'created', 'not_attempted'],
    );
    assert.deepEqual(result.data.warnings, [
      '0 links are uncertain and 1 was not attempted. Call create_guest_links again with the same input.',
    ]);
  });

  it('starts no new guest once the call is canceled', async () => {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tools = await harness([
      ...before(),
      createRequest(JANE, { waitFor: released, then: created(NEW_ID_1) }),
    ]);
    const controller = new AbortController();
    const call = callTool(
      tools.client,
      'create_guest_links',
      { ...EVENT, guests: [JANE, MAX] },
      { signal: controller.signal },
    );
    await untilRequests(tools.fake, 4);
    controller.abort();
    await assert.rejects(call);
    release();
    for (let round = 0; round < 100 && tools.logLines.length < 2; round += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await tools.done();

    assert.equal(tools.logLines[1], 'alfaview-mcp: tool create_guest_links: ok, 4 requests, 0 ms\n');
  });

  it('checks the input in order before any request', async () => {
    const tools = await harness([]);
    const cases: [Record<string, unknown>, string][] = [
      [
        { timezone: 'Local', validFrom: 'soon' },
        'timezone is not a valid time zone. Use a name such as Europe/Berlin.',
      ],
      [{ validFrom: 'soon' }, unrecognizedDateTime('validFrom')],
      [
        { validFrom: '2027-03-28T02:30', validUntil: undefined },
        nonexistentLocalTime('validFrom', '2027-03-28T02:30', 'Europe/Berlin'),
      ],
      [{ validUntil: '2026-10-07T09:00' }, PAST_VALID_UNTIL_MESSAGE],
      [
        { validFrom: '2026-10-07T21:00', validUntil: '2026-10-07T20:00' },
        'validUntil must be after validFrom.',
      ],
      [
        { guests: [JANE, MAX, { ...JANE, emailAddress: ' JANE.DOE@example.com ' }] },
        'The guest list has JANE.DOE@example.com more than once. Give each email address once per call.',
      ],
    ];
    for (const [change, message] of cases) {
      const result = await tools.call('create_guest_links', { ...EVENT, guests: [JANE], ...change });
      assert.equal(result.isError, true, message);
      assert.equal(result.summary, message);
    }
    await tools.done();
  });

  it('lets the SDK refuse an empty guest list, 26 guests and unknown guest keys', async () => {
    const tools = await harness([]);
    const many = Array.from({ length: 26 }, (_, index) => ({
      emailAddress: `guest${index}@example.com`,
      displayName: `Guest ${index}`,
    }));
    for (const guests of [[], many, [{ ...JANE, phone: '123' }], [{ ...JANE, displayName: ' ' }]]) {
      const result = await tools.call('create_guest_links', { ...EVENT, guests });
      assert.equal(result.isError, true);
      // The description does not name the limit, so its message says what to do.
      if (guests === many) {
        assert.match(result.summary, /guests: At most 25 guests per call: create the links in several calls\./);
      }
    }
    const noLocale = await tools.call('create_guest_links', { roomId: ROOM_ID, guests: [JANE] });
    assert.equal(noLocale.isError, true);
    await tools.done();
  });

  it('lists the group names for an unknown group, and IDs for a name of two groups', async () => {
    const twoSpectators = [
      ...fixture<{ id: string; name: string }[]>('rooms/permission-groups.json'),
      { id: 'ff000000-0000-5000-8000-000000000001', name: 'SPECTATOR' },
    ];
    const tools = await harness([
      loginRequest(),
      groupsRequest(),
      groupsRequest({ status: 200, body: twoSpectators }),
      groupsRequest({ status: 200, body: [{ id: 'a1', name: 'Admin' }, { id: 'm1', name: 'Moderator' }] }),
    ]);
    const unknown = await tools.call('create_guest_links', {
      ...EVENT,
      guests: [JANE],
      permissionGroup: 'Speakers',
    });
    const ambiguous = await tools.call('create_guest_links', {
      ...EVENT,
      guests: [JANE],
      permissionGroup: 'Spectator',
    });
    const noGuest = await tools.call('create_guest_links', { ...EVENT, guests: [JANE] });
    await tools.done();

    assert.equal(
      unknown.summary,
      'This company has no permission group Speakers. Its groups: Admin, Moderator, Participant, Spectator, Guest.',
    );
    assert.equal(
      ambiguous.summary,
      `More than one permission group is named Spectator. Give the ID of one: ${SPECTATOR_GROUP_ID}, ff000000-0000-5000-8000-000000000001.`,
    );
    assert.equal(
      noGuest.summary,
      'Give permissionGroup. This company has no permission group named Guest. Its groups: Admin, Moderator.',
    );
    assert.match(tools.logLines.at(-1)!, /: UnknownPermissionGroup, /);
  });

  it('reports a room that alfaview cannot find before any create', async () => {
    const tools = await harness([
      loginRequest(),
      groupsRequest(),
      {
        method: 'GET',
        path: `/v2/rooms/${ROOM_ID}/guest-links`,
        query: { limit: '500' },
        respond: { status: 404, body: fixture('core/problem-404.json') },
      },
    ]);
    const result = await tools.call('create_guest_links', { ...EVENT, guests: [JANE] });
    await tools.done();

    assert.equal(result.isError, true);
    assert.match(result.summary, /^alfaview could not find the room\./);
  });
});

describe('update_guest_link', () => {
  const patch = (body: Record<string, unknown>): ExpectedRequest => ({
    method: 'PATCH',
    path: `/v2/guest-links/${LINK_ID}`,
    body,
    respond: { status: 204 },
  });
  const updated = apiLink({ validFrom: '2026-10-08T16:00:00Z', validUntil: '2026-10-08T18:00:00Z' });

  it('sends the given fields with the current name, then returns the stored link', async () => {
    const tools = await harness([
      loginRequest(),
      linkRequest(LINK_ID, { status: 200, body: apiLink() }),
      groupsRequest(),
      patch({
        validFrom: '2026-10-08T16:00:00.000Z',
        validUntil: '2026-10-08T18:00:00.000Z',
        displayName: 'Jane Doe',
        sendEmail: false,
        timezone: 'Europe/Berlin',
      }),
      linkRequest(LINK_ID, { status: 200, body: updated }),
    ]);
    const result = await tools.call('update_guest_link', {
      guestLinkId: LINK_ID,
      validFrom: '2026-10-08T18:00',
      validUntil: '2026-10-08T20:00',
    });
    await tools.done();

    assert.equal(
      result.summary,
      `Updated guest link ${LINK_ID}, valid from 2026-10-08 18:00 Europe/Berlin until 2026-10-08 20:00 Europe/Berlin. alfaview sent no email.`,
    );
    // No join URL: the change does not need it, and find_guest_links gives it.
    assert.deepEqual(result.data, {
      id: LINK_ID,
      roomId: ROOM_ID,
      inMeetingRoom: false,
      emailAddress: 'jane.doe@example.com',
      displayName: 'Jane Doe',
      locale: 'de-DE',
      validFrom: '2026-10-08T18:00:00+02:00',
      validUntil: '2026-10-08T20:00:00+02:00',
      permissionGroupName: 'Guest',
      dialInAllowed: false,
      origin: 'Zapier',
      createdAt: '2026-09-25T12:00:00+02:00',
      warnings: [],
    });
  });

  it('resolves a group name, sends every field with the email and the time zone, and gives times in it', async () => {
    const tools = await harness([
      loginRequest(),
      linkRequest(LINK_ID, { status: 200, body: apiLink() }),
      groupsRequest(),
      patch({
        emailAddress: 'jane@example.org',
        locale: 'en-US',
        validUntil: '2026-11-10T16:00:00.000Z',
        permissionGroupId: SPECTATOR_GROUP_ID,
        dialInAllowed: true,
        displayName: 'Jane D.',
        sendEmail: true,
        timezone: 'America/New_York',
      }),
      linkRequest(LINK_ID, {
        status: 200,
        body: apiLink({
          permissionGroupId: SPECTATOR_GROUP_ID,
          validFrom: '0001-01-01T00:00:00Z',
          validUntil: '2026-11-10T16:00:00Z',
        }),
      }),
    ]);
    const result = await tools.call('update_guest_link', {
      guestLinkId: LINK_ID,
      displayName: 'Jane D.',
      emailAddress: 'jane@example.org',
      locale: 'en-US',
      validUntil: '2026-11-10T11:00',
      permissionGroup: 'SPECTATOR',
      dialInAllowed: true,
      sendEmail: true,
      timezone: 'America/New_York',
    });
    await tools.done();

    assert.equal(
      result.summary,
      `Updated guest link ${LINK_ID}, valid from any time until 2026-11-10 11:00 America/New_York. alfaview emails the guest about the change.`,
    );
    assert.deepEqual(
      [result.data.validFrom, result.data.validUntil, result.data.createdAt],
      [null, '2026-11-10T11:00:00-05:00', '2026-09-25T06:00:00-04:00'],
    );
    assert.equal(result.data.permissionGroupName, 'Spectator');
  });

  it('sends an empty name when the link has none', async () => {
    const tools = await harness([
      loginRequest(),
      linkRequest(LINK_ID, { status: 200, body: apiLink({ displayName: undefined }) }),
      groupsRequest(),
      patch({ dialInAllowed: false, displayName: '', sendEmail: false, timezone: 'Europe/Berlin' }),
      linkRequest(LINK_ID, { status: 200, body: apiLink() }),
    ]);
    const result = await tools.call('update_guest_link', { guestLinkId: LINK_ID, dialInAllowed: false });
    await tools.done();

    assert.equal(result.isError, false);
    assert.equal(result.data.permissionGroupName, 'Guest');
  });

  // The group list holds the check of the stored group at every level, so its error stops the
  // change before any write, also at full.
  it('changes nothing when the group list fails, at every level', async () => {
    for (const level of [undefined, 'read', 'standard', 'manage', 'full'] as const) {
      const tools = await harness(
        [
          loginRequest(),
          linkRequest(LINK_ID, { status: 200, body: apiLink() }),
          groupsRequest({ status: 503, body: fixture('core/problem-500.json') }),
        ],
        level === undefined ? {} : { level },
      );
      const result = await tools.call('update_guest_link', { guestLinkId: LINK_ID, dialInAllowed: false });
      await tools.done();

      assert.equal(result.isError, true, String(level));
      assert.equal(result.summary, 'alfaview had a temporary problem (HTTP 503). Try again later.');
    }
  });

  it('sends no change for the unchanged name alone, which alfaview would skip without an email', async () => {
    const tools = await harness([
      loginRequest(),
      linkRequest(LINK_ID, { status: 200, body: apiLink() }),
      groupsRequest(),
    ]);
    const result = await tools.call('update_guest_link', {
      guestLinkId: LINK_ID,
      displayName: 'Jane Doe',
      sendEmail: true,
    });
    await tools.done();

    assert.equal(
      result.summary,
      `Guest link ${LINK_ID} is unchanged: its name is the same, and no other field was given. alfaview sent no email.`,
    );
    assert.equal(result.data.displayName, 'Jane Doe');
    assert.equal(result.data.permissionGroupName, 'Guest');
    assert.ok(!('joinUrl' in result.data));
  });

  it('sends a new name, and the unchanged name with another field, and says that alfaview emails', async () => {
    const tools = await harness([
      loginRequest(),
      linkRequest(LINK_ID, { status: 200, body: apiLink() }),
      groupsRequest(),
      patch({ displayName: 'Jane D.', sendEmail: true, timezone: 'Europe/Berlin' }),
      linkRequest(LINK_ID, { status: 200, body: apiLink({ displayName: 'Jane D.' }) }),
      linkRequest(LINK_ID, { status: 200, body: apiLink() }),
      groupsRequest(),
      patch({ locale: 'de-DE', displayName: 'Jane Doe', sendEmail: true, timezone: 'Europe/Berlin' }),
      linkRequest(LINK_ID, { status: 200, body: apiLink() }),
    ]);
    const renamed = await tools.call('update_guest_link', {
      guestLinkId: LINK_ID,
      displayName: 'Jane D.',
      sendEmail: true,
    });
    const sameValues = await tools.call('update_guest_link', {
      guestLinkId: LINK_ID,
      displayName: 'Jane Doe',
      locale: 'de-DE',
      sendEmail: true,
    });
    await tools.done();

    assert.match(renamed.summary, /\. alfaview emails the guest about the change\.$/);
    assert.match(sameValues.summary, /\. alfaview emails the guest about the change\.$/);
  });

  it('says that the change is saved when reading the link back fails', async () => {
    const tools = await harness([
      loginRequest(),
      linkRequest(LINK_ID, { status: 200, body: apiLink() }),
      groupsRequest(),
      patch({ locale: 'en-US', displayName: 'Jane Doe', sendEmail: true, timezone: 'Europe/Berlin' }),
      linkRequest(LINK_ID, { status: 502, body: fixture('core/problem-500.json') }),
    ]);
    const result = await tools.call('update_guest_link', {
      guestLinkId: LINK_ID,
      locale: 'en-US',
      sendEmail: true,
    });
    await tools.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, guestLinkUpdatedButNotReadMessage(LINK_ID));
    assert.match(result.summary, /Do not repeat the change/);
    assert.match(tools.logLines.at(-1)!, /: ServerError, 5 requests/);
  });

  it('refuses an unknown group before the change', async () => {
    const tools = await harness([
      loginRequest(),
      linkRequest(LINK_ID, { status: 200, body: apiLink() }),
      groupsRequest(),
    ]);
    const result = await tools.call('update_guest_link', {
      guestLinkId: LINK_ID,
      permissionGroup: 'Speakers',
    });
    await tools.done();

    assert.equal(result.isError, true);
    assert.match(result.summary, /^This company has no permission group Speakers\./);
  });

  it('checks the input before any request', async () => {
    const tools = await harness([]);
    const none = await tools.call('update_guest_link', { guestLinkId: LINK_ID, sendEmail: true });
    const zone = await tools.call('update_guest_link', {
      guestLinkId: LINK_ID,
      displayName: 'Jane',
      timezone: 'Local',
    });
    const date = await tools.call('update_guest_link', { guestLinkId: LINK_ID, validUntil: '7 pm' });
    await tools.done();

    assert.equal(none.summary, 'Give at least one field to change.');
    assert.equal(zone.summary, 'timezone is not a valid time zone. Use a name such as Europe/Berlin.');
    assert.match(date.summary, /^validUntil is not a valid date and time\./);
  });

  it('reports a link that alfaview cannot find', async () => {
    const tools = await harness([
      loginRequest(),
      linkRequest(LINK_ID, { status: 404, body: fixture('core/problem-404.json') }),
    ]);
    const result = await tools.call('update_guest_link', { guestLinkId: LINK_ID, displayName: 'Jane' });
    await tools.done();

    assert.equal(
      result.summary,
      "alfaview could not find the guest link. It was deleted, or the API key's user cannot see it.",
    );
  });
});

// A guest with admin could change and delete the room, so the two tools refuse such a group at
// every level, also at full: a person makes such a link in alfaview. The tests run each level, also
// read, which registers neither tool, so the rule holds for every level that a tool context can
// have.
describe('a permission group with admin in create_guest_links and update_guest_link', () => {
  const ADMIN_GROUP_ID = 'a0b1c2d3-e4f5-5061-8728-394a5b6c7d8e';
  const LEVELS = [undefined, 'read', 'standard', 'manage', 'full'] as const;
  const patch = (body: Record<string, unknown>): ExpectedRequest => ({
    method: 'PATCH',
    path: `/v2/guest-links/${LINK_ID}`,
    body,
    respond: { status: 204 },
  });
  const levelOption = (level: (typeof LEVELS)[number]): HarnessOptions =>
    level === undefined ? {} : { level };

  it('create_guest_links refuses it at every level before the guest links are read', async () => {
    for (const level of LEVELS) {
      for (const permissionGroup of ['admin', ADMIN_GROUP_ID]) {
        const tools = await harness([loginRequest(), groupsRequest()], levelOption(level));
        const result = await tools.call('create_guest_links', { ...EVENT, guests: [JANE], permissionGroup });
        await tools.done();

        assert.equal(result.isError, true);
        assert.equal(
          result.summary,
          'This permission group has admin rights, so the guest could change and delete the room. Choose a group without admin, or make the link in alfaview.',
          String(level),
        );
        assert.match(tools.logLines.at(-1)!, /: AdminGroupRefused, 2 requests, /);
      }
    }
  });

  it('update_guest_link refuses it at every level before the change', async () => {
    for (const level of LEVELS) {
      const tools = await harness(
        [loginRequest(), linkRequest(LINK_ID, { status: 200, body: apiLink() }), groupsRequest()],
        levelOption(level),
      );
      const result = await tools.call('update_guest_link', {
        guestLinkId: LINK_ID,
        permissionGroup: 'Admin',
        sendEmail: true,
      });
      await tools.done();

      assert.equal(result.isError, true);
      assert.equal(result.summary, ADMIN_GUEST_GROUP_MESSAGE, String(level));
      assert.match(tools.logLines.at(-1)!, /: AdminGroupRefused, 3 requests, /);
    }
  });

  // The level full allows no such group either. The expected requests end before a write, so each
  // refusal comes first, with Include and with Leave out.
  it('full refuses it in both tools, with Include and with Leave out', async () => {
    const adminLink = apiLink({ permissionGroupId: ADMIN_GROUP_ID });
    for (const personalData of ['include', 'omit'] as const) {
      const options: HarnessOptions = { level: 'full', personalData };
      const create = await harness([loginRequest(), groupsRequest()], options);
      const created = await create.call('create_guest_links', {
        ...EVENT,
        guests: [JANE],
        permissionGroup: 'Admin',
        sendEmail: true,
      });
      await create.done();
      const update = await harness(
        [
          loginRequest(),
          linkRequest(LINK_ID, { status: 200, body: apiLink() }),
          groupsRequest(),
          linkRequest(LINK_ID, { status: 200, body: adminLink }),
          groupsRequest(),
        ],
        options,
      );
      const changed = await update.call('update_guest_link', { guestLinkId: LINK_ID, permissionGroup: ADMIN_GROUP_ID });
      const moved = await update.call('update_guest_link', {
        guestLinkId: LINK_ID,
        emailAddress: 'someone.else@example.net',
        sendEmail: true,
      });
      await update.done();

      assert.deepEqual(
        [created, changed, moved].map((result) => [result.isError, result.summary]),
        [
          [true, ADMIN_GUEST_GROUP_MESSAGE],
          [true, ADMIN_GUEST_GROUP_MESSAGE],
          [true, ADMIN_GUEST_LINK_MESSAGE],
        ],
        personalData,
      );
      assert.match(create.logLines.at(-1)!, /: AdminGroupRefused, 2 requests, /);
      // The second call has the token of the first one, so it sends no login.
      assert.deepEqual(
        update.logLines.slice(-2).map((line) => /: AdminGroupRefused, (\d) requests, /.exec(line)?.[1]),
        ['3', '2'],
      );
    }
  });

  // A person can make a link with admin in alfaview. A change without a new group would keep its
  // rights for a new address or a new time: an expired co-host link sent to someone else.
  it('update_guest_link refuses a change of a link with admin at every level when the call gives no group', async () => {
    const adminLink = apiLink({ permissionGroupId: ADMIN_GROUP_ID.toUpperCase(), validUntil: '2026-09-30T10:00:00Z' });
    const changes = [
      { emailAddress: 'someone.else@example.net', sendEmail: true },
      { validUntil: '2026-12-31T23:00' },
      { displayName: 'Co-host' },
    ];
    for (const level of LEVELS) {
      for (const change of changes) {
        const tools = await harness(
          [loginRequest(), linkRequest(LINK_ID, { status: 200, body: adminLink }), groupsRequest()],
          levelOption(level),
        );
        const result = await tools.call('update_guest_link', { guestLinkId: LINK_ID, ...change });
        await tools.done();

        assert.equal(result.isError, true, String(level));
        assert.equal(result.summary, ADMIN_GUEST_LINK_MESSAGE, String(level));
        assert.match(tools.logLines.at(-1)!, /: AdminGroupRefused, 3 requests, /);
      }
    }
    assert.equal(
      ADMIN_GUEST_LINK_MESSAGE,
      'This guest link has a permission group with admin rights, so its guest can change and delete the room. Give permissionGroup a group without admin in the same call, delete the link with delete_guest_link, or change the link in alfaview.',
    );
  });

  it('update_guest_link changes a link with admin at every level when the call gives a group without admin', async () => {
    const adminLink = apiLink({ permissionGroupId: ADMIN_GROUP_ID });
    for (const level of LEVELS) {
      const tools = await harness(
        [
          loginRequest(),
          linkRequest(LINK_ID, { status: 200, body: adminLink }),
          groupsRequest(),
          patch({
            validUntil: '2026-12-31T22:00:00.000Z',
            permissionGroupId: SPECTATOR_GROUP_ID,
            displayName: 'Jane Doe',
            sendEmail: false,
            timezone: 'Europe/Berlin',
          }),
          linkRequest(LINK_ID, { status: 200, body: apiLink({ permissionGroupId: SPECTATOR_GROUP_ID }) }),
        ],
        levelOption(level),
      );
      const result = await tools.call('update_guest_link', {
        guestLinkId: LINK_ID,
        validUntil: '2026-12-31T23:00',
        permissionGroup: 'Spectator',
      });
      await tools.done();

      assert.equal(result.isError, false, String(level));
      assert.equal(result.data.permissionGroupName, 'Spectator');
    }
  });

  it('update_guest_link changes a link whose stored group is not in the list', async () => {
    const unknown = apiLink({ permissionGroupId: '00000000-0000-5000-8000-000000000999' });
    const tools = await harness([
      loginRequest(),
      linkRequest(LINK_ID, { status: 200, body: unknown }),
      groupsRequest(),
      patch({ dialInAllowed: true, displayName: 'Jane Doe', sendEmail: false, timezone: 'Europe/Berlin' }),
      linkRequest(LINK_ID, { status: 200, body: unknown }),
    ]);
    const result = await tools.call('update_guest_link', { guestLinkId: LINK_ID, dialInAllowed: true });
    await tools.done();

    assert.equal(result.isError, false);
    assert.equal(result.data.permissionGroupName, null);
  });

  it('update_guest_link takes a group without admin at every level', async () => {
    for (const level of LEVELS) {
      const tools = await harness(
        [
          loginRequest(),
          linkRequest(LINK_ID, { status: 200, body: apiLink() }),
          groupsRequest(),
          patch({ permissionGroupId: SPECTATOR_GROUP_ID, displayName: 'Jane Doe', sendEmail: false, timezone: 'Europe/Berlin' }),
          linkRequest(LINK_ID, { status: 200, body: apiLink({ permissionGroupId: SPECTATOR_GROUP_ID }) }),
        ],
        levelOption(level),
      );
      const result = await tools.call('update_guest_link', { guestLinkId: LINK_ID, permissionGroup: 'Spectator' });
      await tools.done();

      assert.equal(result.isError, false, String(level));
      assert.equal(result.data.permissionGroupName, 'Spectator');
    }
  });
});

describe('delete_guest_link', () => {
  const deleteRequest = (roomId = ROOM_ID): ExpectedRequest => ({
    method: 'DELETE',
    path: `/v2/rooms/${roomId}/guest-links/${LINK_ID}`,
    respond: { status: 204 },
  });
  const room = (type: string) => ({ status: 200, body: { ...fixture('rooms/room.json'), type } });

  for (const sendEmail of [false, true]) {
    it(`deletes a link of a room without an email (sendEmail ${sendEmail})`, async () => {
      const tools = await harness([
        loginRequest(),
        linkRequest(LINK_ID, { status: 200, body: apiLink() }),
        roomRequest(room('room')),
        deleteRequest(),
      ]);
      const result = await tools.call('delete_guest_link', { guestLinkId: LINK_ID, sendEmail });
      await tools.done();

      assert.equal(result.summary, `Deleted guest link ${LINK_ID}. Its join URL no longer works.`);
      assert.deepEqual(result.data, {
        guestLinkId: LINK_ID,
        roomId: ROOM_ID,
        deleted: true,
        revocationEmail: false,
        warnings: [],
      });
    });
  }

  it('refuses a link of a meeting room without sendEmail', async () => {
    const tools = await harness([
      loginRequest(),
      linkRequest(LINK_ID, { status: 200, body: apiLink({ roomId: MEETING_ID }) }),
      roomRequest(room('meeting'), MEETING_ID),
    ]);
    const result = await tools.call('delete_guest_link', { guestLinkId: LINK_ID });
    await tools.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, MEETING_ROOM_EMAIL_MESSAGE);
    // Each refusal tells the model to set sendEmail only when the person wants the email.
    assert.equal(
      MEETING_ROOM_EMAIL_MESSAGE,
      'This guest link belongs to a meeting room, and alfaview emails the guest when such a link is deleted. Call delete_guest_link again with sendEmail true only when the person asked for that email: it deletes the link and sends the email.',
    );
    assert.match(ROOM_UNKNOWN_EMAIL_MESSAGE, / with sendEmail true only when the person agrees to that email: /);
  });

  it('deletes a link of a meeting room with sendEmail, which emails the guest', async () => {
    const tools = await harness([
      loginRequest(),
      linkRequest(LINK_ID, { status: 200, body: apiLink({ roomId: MEETING_ID }) }),
      roomRequest(room('meeting'), MEETING_ID),
      deleteRequest(MEETING_ID),
    ]);
    const result = await tools.call('delete_guest_link', { guestLinkId: LINK_ID, sendEmail: true });
    await tools.done();

    assert.equal(
      result.summary,
      `Deleted guest link ${LINK_ID}. Its join URL no longer works. alfaview emails the guest about it.`,
    );
    assert.equal(result.data.revocationEmail, true);
  });

  it('refuses a link whose room it cannot read without sendEmail', async () => {
    const tools = await harness([
      loginRequest(),
      linkRequest(LINK_ID, { status: 200, body: apiLink() }),
      roomRequest({ status: 404, body: fixture('core/problem-404.json') }),
    ]);
    const result = await tools.call('delete_guest_link', { guestLinkId: LINK_ID });
    await tools.done();

    assert.equal(result.summary, ROOM_UNKNOWN_EMAIL_MESSAGE);
  });

  it('deletes a link whose room it cannot read with sendEmail', async () => {
    const tools = await harness([
      loginRequest(),
      linkRequest(LINK_ID, { status: 200, body: apiLink() }),
      roomRequest({ status: 404, body: fixture('core/problem-404.json') }),
      deleteRequest(),
    ]);
    const result = await tools.call('delete_guest_link', { guestLinkId: LINK_ID, sendEmail: true });
    await tools.done();

    assert.equal(result.data.revocationEmail, null);
    assert.match(result.summary, / alfaview emails the guest about it\.$/);
  });

  it('deletes in the room of the link, in lower case', async () => {
    const tools = await harness([
      loginRequest(),
      linkRequest(LINK_ID, { status: 200, body: apiLink({ roomId: ROOM_ID.toUpperCase() }) }),
      roomRequest(room('room')),
      deleteRequest(),
    ]);
    const result = await tools.call('delete_guest_link', { guestLinkId: LINK_ID });
    await tools.done();

    assert.equal(result.data.roomId, ROOM_ID.toUpperCase());
  });

  it('says that nothing was deleted when alfaview cannot find the link', async () => {
    const tools = await harness([
      loginRequest(),
      linkRequest(LINK_ID, { status: 404, body: fixture('core/problem-404.json') }),
    ]);
    const result = await tools.call('delete_guest_link', { guestLinkId: LINK_ID, sendEmail: true });
    await tools.done();

    assert.equal(result.summary, DELETE_NOT_FOUND_MESSAGE);
    assert.match(tools.logLines.at(-1)!, /: NotFound, /);
  });

  it('refuses a link without a room', async () => {
    const tools = await harness([
      loginRequest(),
      linkRequest(LINK_ID, { status: 200, body: apiLink({ roomId: '' }) }),
    ]);
    const result = await tools.call('delete_guest_link', { guestLinkId: LINK_ID });
    await tools.done();

    assert.equal(result.summary, MISSING_LINK_ROOM_MESSAGE);
  });
});

describe('delete_expired_guest_links', () => {
  const HOUR = 60 * 60 * 1000;
  const NOW = Date.parse('2026-10-07T08:00:00Z');
  const endedAgo = (id: string, hours: number, origin = 'Webinar 2026-10-04') =>
    apiLink({ id, origin, validUntil: new Date(NOW - hours * HOUR).toISOString() });
  const deleteRequest = (id: string, respond: FakeAnswer = { status: 204 }): ExpectedRequest => ({
    method: 'DELETE',
    path: `/v2/rooms/${ROOM_ID}/guest-links/${id}`,
    respond,
  });
  const roomLinks = () => [
    endedAgo(NEW_ID_1, 72),
    endedAgo(NEW_ID_2, 1),
    fixture('guestLinks/guest-link-unbounded.json'),
    endedAgo(NEW_ID_3, 48, 'https://api.calendly.com/scheduled_events/x/invitees/y'),
    apiLink(),
  ];

  it('deletes the links that ended at least 48 hours ago, and keeps links without an end', async () => {
    const tools = await harness(
      [
        loginRequest(),
        roomRequest({ status: 200, body: fixture('rooms/room.json') }),
        linksPage(roomLinks()),
        deleteRequest(NEW_ID_1),
        deleteRequest(NEW_ID_3),
      ],
      { anyOrder: true },
    );
    const result = await tools.call('delete_expired_guest_links', { roomId: ROOM_ID });
    await tools.done();

    assert.equal(
      result.summary,
      `Deleted 2 guest links of room ${ROOM_ID} whose validity ended at least 48 hours ago.`,
    );
    assert.deepEqual(result.data, {
      roomId: ROOM_ID,
      originContains: null,
      expiredAtLeastHours: 48,
      deletedCount: 2,
      remainingCount: 0,
      complete: true,
      nextPageToken: null,
      warnings: [],
    });
  });

  it('filters by a part of the origin in any case, and takes the hours', async () => {
    const tools = await harness([
      loginRequest(),
      roomRequest({ status: 200, body: fixture('rooms/room.json') }),
      linksPage(roomLinks()),
      deleteRequest(NEW_ID_1),
      deleteRequest(NEW_ID_2),
    ], { anyOrder: true });
    const result = await tools.call('delete_expired_guest_links', {
      roomId: ROOM_ID,
      originContains: 'WEBINAR',
      expiredAtLeastHours: 1,
    });
    await tools.done();

    assert.equal(
      result.summary,
      `Deleted 2 guest links of room ${ROOM_ID} whose validity ended at least 1 hour ago.`,
    );
    assert.equal(result.data.originContains, 'WEBINAR');
  });

  it('refuses a meeting room before it reads the links', async () => {
    const tools = await harness([
      loginRequest(),
      roomRequest({
        status: 200,
        body: { ...fixture<Record<string, unknown>>('rooms/room.json'), type: 'meeting' },
      }),
    ]);
    const result = await tools.call('delete_expired_guest_links', { roomId: ROOM_ID });
    await tools.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, BULK_DELETE_MEETING_ROOM_MESSAGE);
    assert.match(tools.logLines.at(-1)!, /: MeetingRoomEmail, /);
  });

  it('reports a room that alfaview cannot find', async () => {
    const tools = await harness([
      loginRequest(),
      roomRequest({ status: 404, body: fixture('core/problem-404.json') }),
    ]);
    const result = await tools.call('delete_expired_guest_links', { roomId: ROOM_ID });
    await tools.done();

    assert.match(result.summary, /^alfaview could not find the room\./);
  });

  it('says how many links were deleted before a failed delete', async () => {
    const tools = await harness([
      loginRequest(),
      roomRequest({ status: 200, body: fixture('rooms/room.json') }),
      linksPage(roomLinks()),
      deleteRequest(NEW_ID_1),
      deleteRequest(NEW_ID_3, { status: 500, body: fixture('core/problem-500.json') }),
    ], { anyOrder: true });
    const result = await tools.call('delete_expired_guest_links', { roomId: ROOM_ID });
    await tools.done();

    assert.equal(result.isError, true);
    assert.equal(
      result.summary,
      'alfaview had a temporary problem (HTTP 500). Try again later. 1 link was deleted before the error.',
    );
  });

  it('starts no new delete after 30 seconds, and says how many remain', async () => {
    const clock = testClock();
    const expired = Array.from({ length: 7 }, (_, index) =>
      endedAgo(`cc000000-0000-5000-8000-00000000000${index}`, 72),
    );
    const tools = await harness(
      [
        loginRequest(),
        roomRequest({ status: 200, body: fixture('rooms/room.json') }),
        linksPage(expired),
        ...expired.slice(0, 5).map((link) => deleteRequest(link.id as string)),
      ],
      {
        anyOrder: true,
        now: clock.now,
        wrapFetch: (fetch) => (input, init) => {
          clock.advance(6_000);
          return fetch(input, init);
        },
      },
    );
    const result = await tools.call('delete_expired_guest_links', { roomId: ROOM_ID });
    await tools.done();

    assert.equal(
      result.summary,
      `Deleted 5 guest links of room ${ROOM_ID} whose validity ended at least 48 hours ago. 2 remain: call again with the same input to delete them.`,
    );
    assert.equal(result.data.remainingCount, 2);
  });

  it('says that one link remains', async () => {
    const clock = testClock();
    const expired = Array.from({ length: 6 }, (_, index) =>
      endedAgo(`cc000000-0000-5000-8000-00000000000${index}`, 72),
    );
    const tools = await harness(
      [
        loginRequest(),
        roomRequest({ status: 200, body: fixture('rooms/room.json') }),
        linksPage(expired),
        ...expired.slice(0, 5).map((link) => deleteRequest(link.id as string)),
      ],
      {
        anyOrder: true,
        now: clock.now,
        wrapFetch: (fetch) => (input, init) => {
          clock.advance(6_000);
          return fetch(input, init);
        },
      },
    );
    const result = await tools.call('delete_expired_guest_links', { roomId: ROOM_ID });
    await tools.done();

    assert.match(result.summary, / 1 remains: call again with the same input to delete them\.$/);
  });

  /**
   * The 20 pages that one call reads of a room with more links, and the read of the link after
   * them: page 1 holds `firstPage`, every other page one link that has not expired.
   */
  const pagesOfLargeRoom = (firstPage: unknown[]): ExpectedRequest[] => [
    ...Array.from({ length: 20 }, (_, index): ExpectedRequest => {
      const id = `dd000000-0000-5000-8000-0000000000${String(index).padStart(2, '0')}`;
      return {
        method: 'GET',
        path: `/v2/rooms/${ROOM_ID}/guest-links`,
        query: index === 0 ? { limit: '500' } : { limit: '500', pageToken: `page-${index}` },
        respond: {
          status: 200,
          body: { data: index === 0 ? firstPage : [apiLink({ id })], nextPageToken: `page-${index + 1}` },
        },
      };
    }),
    {
      method: 'GET',
      path: `/v2/rooms/${ROOM_ID}/guest-links`,
      query: { limit: '1', pageToken: 'page-20' },
      respond: {
        status: 200,
        body: { data: [apiLink({ id: 'ee000000-0000-5000-8000-000000000001' })], nextPageToken: 'x' },
      },
    },
  ];

  it('gives the pageToken of the next links when the room has more links than one call reads', async () => {
    const tools = await harness([
      loginRequest(),
      roomRequest({ status: 200, body: fixture('rooms/room.json') }),
      ...pagesOfLargeRoom([apiLink({ id: 'dd000000-0000-5000-8000-000000000000' })]),
    ]);
    const result = await tools.call('delete_expired_guest_links', { roomId: ROOM_ID });
    await tools.done();

    assert.deepEqual(
      [result.data.complete, result.data.deletedCount, result.data.nextPageToken],
      [false, 0, 'page-20'],
    );
    assert.equal(
      result.summary,
      `Deleted 0 guest links of room ${ROOM_ID} whose validity ended at least 48 hours ago. This call read 20 guest links of the room, and more follow. Call again with pageToken page-20 to check the next ones.`,
    );
  });

  it('goes on at pageToken, and ends there when no link follows', async () => {
    const tools = await harness([
      loginRequest(),
      roomRequest({ status: 200, body: fixture('rooms/room.json') }),
      {
        method: 'GET',
        path: `/v2/rooms/${ROOM_ID}/guest-links`,
        query: { limit: '500', pageToken: 'page-20' },
        respond: { status: 200, body: { data: [endedAgo(NEW_ID_1, 72), apiLink()] } },
      },
      deleteRequest(NEW_ID_1),
    ]);
    const result = await tools.call('delete_expired_guest_links', {
      roomId: ROOM_ID,
      pageToken: 'page-20',
    });
    await tools.done();

    assert.equal(
      result.summary,
      `Deleted 1 guest link of room ${ROOM_ID} whose validity ended at least 48 hours ago.`,
    );
    assert.deepEqual([result.data.complete, result.data.nextPageToken], [true, null]);
  });

  it('gives no pageToken while expired links of the read ones remain', async () => {
    const clock = testClock();
    const expired = Array.from({ length: 7 }, (_, index) =>
      endedAgo(`cc000000-0000-5000-8000-00000000000${index}`, 72),
    );
    const tools = await harness(
      [
        loginRequest(),
        roomRequest({ status: 200, body: fixture('rooms/room.json') }),
        ...pagesOfLargeRoom(expired),
        ...expired.slice(0, 5).map((link) => deleteRequest(link.id as string)),
      ],
      {
        anyOrder: true,
        now: clock.now,
        wrapFetch: (fetch) => (input, init) => {
          if (init?.method === 'DELETE') clock.advance(6_000);
          return fetch(input, init);
        },
      },
    );
    const result = await tools.call('delete_expired_guest_links', { roomId: ROOM_ID });
    await tools.done();

    assert.deepEqual(
      [result.data.deletedCount, result.data.remainingCount, result.data.complete, result.data.nextPageToken],
      [5, 2, false, null],
    );
    assert.equal(
      result.summary,
      `Deleted 5 guest links of room ${ROOM_ID} whose validity ended at least 48 hours ago. 2 remain: call again with the same input to delete them. This call read 26 guest links of the room, and more follow. Once a call leaves none remaining, it gives the pageToken for the next ones.`,
    );
  });

  it('lets the SDK refuse hours outside 1 to 8760', async () => {
    const tools = await harness([]);
    for (const expiredAtLeastHours of [0, 8761, 1.5]) {
      const result = await tools.call('delete_expired_guest_links', {
        roomId: ROOM_ID,
        expiredAtLeastHours,
      });
      assert.equal(result.isError, true);
    }
    await tools.done();
  });
});
