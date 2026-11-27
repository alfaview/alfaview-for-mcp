// The byte budget of the list results: with long values, the JSON of a result stays at or below
// DEFAULT_RESULT_BYTES at the default limits and MAX_RESULT_BYTES at the maximum limits. A change
// of a shape or a limit that breaks a budget changes the limit, not the budget.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TOOLS } from '../../src/server.ts';
import { testClock } from '../helpers/clock.ts';
import { PRODUCTION_ORIGIN, TEST_TOKEN } from '../helpers/fakeFetch.ts';
import { fixture } from '../helpers/fixtures.ts';
import {
  apiAttendances,
  apiGroupLinks,
  apiGuestLink,
  apiGuestLinks,
  apiMeetings,
  apiParticipantGroups,
  apiRoomPermissionEntries,
  apiRooms,
  apiStatsPeriods,
  apiUsers,
  calendlyOrigin,
  GUEST_GROUP_ID,
  guestLinkIdOf,
  guestUserIdOf,
  LONG_GROUP_NAME,
  longEmail,
  longName,
  ROOM_ID,
  WEBINAR_ORIGIN,
} from '../helpers/longValues.ts';
import { callTool, connectTools } from '../helpers/mcpClient.ts';
import { keepContractProblems, testFileLine } from '../helpers/spec.ts';

const DEFAULT_RESULT_BYTES = 24_000;
const MAX_RESULT_BYTES = 40_000;

const MORNING = '2026-10-07T08:00:00Z';
const AFTER_WEBINAR = '2026-10-07T22:00:00Z';
const OPEN = '0001-01-01T00:00:00Z';
const VALIDITY = { validFrom: '2026-10-07T16:30:00Z', validUntil: '2026-10-07T19:30:00Z' };

type Answer = { status: number; body?: unknown };
type Route = (method: string, path: string) => Answer | undefined;

/**
 * A fetch that logs in and answers each request by its method and path. Any other request fails
 * the call, and so the test. Each request goes through the contract check against the API spec.
 */
function answering(route: Route): typeof fetch {
  const site = testFileLine();
  const fetchByRoute = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    assert.equal(url.origin, PRODUCTION_ORIGIN);
    const method = init.method ?? 'GET';
    const contractRequest = {
      method,
      path: url.pathname + url.search,
      headers: Object.fromEntries(new Headers(init.headers)),
      body: typeof init.body === 'string' ? init.body : undefined,
    };
    keepContractProblems(contractRequest, site, undefined);
    const answer =
      url.pathname === '/v2/auth/api-key'
        ? { status: 200, body: { accessToken: TEST_TOKEN } }
        : route(method, url.pathname);
    if (answer === undefined) throw new Error(`unexpected request ${method} ${url.pathname}`);
    const text = answer.body === undefined ? null : JSON.stringify(answer.body);
    return new Response(text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  };
  return fetchByRoute as typeof fetch;
}

/** Calls one tool of the server on `route` and returns the byte size of its JSON and its data. */
async function measure(
  route: Route,
  name: string,
  args: Record<string, unknown>,
  now = MORNING,
): Promise<{ bytes: number; data: any }> {
  const connected = await connectTools(TOOLS, { fetch: answering(route), now: testClock(now).now });
  const result = await callTool(connected.client, name, args);
  await connected.close();
  assert.equal(result.isError, false, result.summary);
  return { bytes: Buffer.byteLength(result.text!), data: result.data };
}

function ok(body: unknown): Answer {
  return { status: 200, body };
}

const groups = () => ok(fixture('rooms/permission-groups.json'));

describe('the result size budget', () => {
  it('holds for find_rooms', async () => {
    const route: Route = (method, path) =>
      method === 'GET' && path === '/v2/rooms' ? ok({ data: apiRooms(50) }) : undefined;
    const standard = await measure(route, 'find_rooms', {});
    const most = await measure(route, 'find_rooms', { limit: 50 });

    assert.equal(standard.data.rooms.length, 20);
    assert.equal(most.data.rooms.length, 50);
    assert.ok(standard.bytes <= DEFAULT_RESULT_BYTES, `${standard.bytes}`);
    assert.ok(most.bytes <= MAX_RESULT_BYTES, `${most.bytes}`);
  });

  it('holds for find_guest_links, in one room and in every room with join URLs', async () => {
    const links = apiGuestLinks(50, { validFrom: VALIDITY.validFrom, validUntil: '2026-10-08T19:30:00Z' });
    const route: Route = (method, path) => {
      if (path === `/v2/rooms/${ROOM_ID}/guest-links` || path === '/v2/guest-links') {
        return ok({ data: links });
      }
      return path === '/v2/permission-groups' ? groups() : undefined;
    };
    const standard = await measure(route, 'find_guest_links', { roomId: ROOM_ID });
    const most = await measure(route, 'find_guest_links', { includeJoinUrls: true, limit: 50 });

    assert.equal(standard.data.links.length, 20);
    assert.equal(most.data.links.length, 50);
    assert.ok(most.data.links[0].joinUrl.startsWith('https://'));
    assert.ok(standard.bytes <= DEFAULT_RESULT_BYTES, `${standard.bytes}`);
    assert.ok(most.bytes <= MAX_RESULT_BYTES, `${most.bytes}`);
  });

  it('holds for find_group_links, in one room and in every room with join URLs', async () => {
    const links = apiGroupLinks(50, { validFrom: VALIDITY.validFrom, validUntil: '2026-10-08T19:30:00Z' });
    const longGroups = [{ id: GUEST_GROUP_ID, name: LONG_GROUP_NAME, permissions: { join: true } }];
    const route: Route = (method, path) => {
      if (path === `/v2/rooms/${ROOM_ID}/group-links` || path === '/v2/group-links') {
        return ok({ data: links });
      }
      return path === '/v2/permission-groups' ? ok(longGroups) : undefined;
    };
    const standard = await measure(route, 'find_group_links', { roomId: ROOM_ID });
    const most = await measure(route, 'find_group_links', { includeJoinUrls: true, limit: 50 });

    assert.equal(standard.data.links.length, 20);
    assert.equal(most.data.links.length, 50);
    assert.equal(most.data.links[0].description.length, 80);
    assert.equal(most.data.links[0].permissionGroupName, LONG_GROUP_NAME);
    assert.ok(most.data.links[0].joinUrl.startsWith('https://'));
    assert.ok(standard.bytes <= DEFAULT_RESULT_BYTES, `${standard.bytes}`);
    assert.ok(most.bytes <= MAX_RESULT_BYTES, `${most.bytes}`);
  });

  it('holds for create_guest_links with 25 guests', async () => {
    let created = 0;
    const route: Route = (method, path) => {
      if (path === '/v2/permission-groups') return groups();
      if (path === `/v2/rooms/${ROOM_ID}/guest-links`) {
        if (method === 'GET') return ok({ data: [] });
        created += 1;
        // alfaview answers a create with the created guest links and their join URLs, so the tool
        // reads no link back, and this route answers no read.
        return { status: 201, body: [apiGuestLink(created, { ...VALIDITY })] };
      }
      return undefined;
    };
    const guests = Array.from({ length: 25 }, (_, index) => ({
      emailAddress: longEmail(index + 1),
      displayName: longName(index + 1),
    }));
    const result = await measure(route, 'create_guest_links', {
      roomId: ROOM_ID,
      guests,
      locale: 'de-DE',
      validFrom: '2026-10-07T18:30',
      validUntil: '2026-10-07T21:30',
      origin: calendlyOrigin(1),
    });

    assert.equal(result.data.createdCount, 25);
    assert.ok(result.bytes <= DEFAULT_RESULT_BYTES, `${result.bytes}`);
  });

  it('holds for find_meetings', async () => {
    const route: Route = (method, path) =>
      method === 'GET' && path === '/v2/meetings' ? ok(apiMeetings(100)) : undefined;
    const standard = await measure(route, 'find_meetings', {});
    const most = await measure(route, 'find_meetings', { limit: 100 });

    assert.equal(standard.data.meetings.length, 20);
    assert.equal(most.data.meetings.length, 100);
    assert.ok(standard.bytes <= DEFAULT_RESULT_BYTES, `${standard.bytes}`);
    assert.ok(most.bytes <= MAX_RESULT_BYTES, `${most.bytes}`);
  });

  it('holds for find_meetings when every entry is a recurring meeting with a long rule', async () => {
    const rule = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR;UNTIL=20271231T225959Z';
    const route: Route = (method, path) =>
      method === 'GET' && path === '/v2/meetings'
        ? ok(apiMeetings(100).map((meeting) => ({ ...meeting, recurrenceRule: rule, externallyManaged: false })))
        : undefined;
    const standard = await measure(route, 'find_meetings', {});
    const most = await measure(route, 'find_meetings', { limit: 100 });

    assert.equal(most.data.meetings[0].recurrenceRule, rule);
    assert.ok(standard.bytes <= DEFAULT_RESULT_BYTES, `${standard.bytes}`);
    assert.ok(most.bytes <= MAX_RESULT_BYTES, `${most.bytes}`);
  });

  it('holds for find_room_participants', async () => {
    const userIds = Array.from({ length: 50 }, (_, index) => guestUserIdOf(index + 1));
    const route: Route = (_method, path) => {
      if (path === `/v2/rooms/${ROOM_ID}/participants`) return ok(apiParticipantGroups(50));
      if (path === `/v2/rooms/${ROOM_ID}/attendances`) {
        return ok(apiAttendances(userIds, '2026-10-07T07:30:00Z', OPEN));
      }
      if (path === `/v2/rooms/${ROOM_ID}/guest-links`) {
        return ok({ data: apiGuestLinks(50, { ...VALIDITY }) });
      }
      return undefined;
    };
    const standard = await measure(route, 'find_room_participants', { roomId: ROOM_ID });
    const most = await measure(route, 'find_room_participants', { roomId: ROOM_ID, limit: 50 });

    assert.equal(standard.data.participants.length, 20);
    assert.equal(most.data.participants.length, 50);
    assert.ok(most.data.participants.every((person: any) => person.emailAddress !== null));
    assert.ok(standard.bytes <= DEFAULT_RESULT_BYTES, `${standard.bytes}`);
    assert.ok(most.bytes <= MAX_RESULT_BYTES, `${most.bytes}`);
  });

  it('holds for get_room_attendance with 400 invited people and 25 other attendees', async () => {
    const invited = apiGuestLinks(400, { ...VALIDITY, origin: () => WEBINAR_ORIGIN });
    const others = apiGuestLinks(25, { ...VALIDITY, first: 401 });
    const attendees = [
      ...Array.from({ length: 200 }, (_, index) => guestUserIdOf(index + 1)),
      ...Array.from({ length: 25 }, (_, index) => guestUserIdOf(401 + index)),
    ];
    const route: Route = (_method, path) => {
      if (path === `/v2/rooms/${ROOM_ID}/guest-links`) return ok({ data: [...invited, ...others] });
      if (path === `/v2/rooms/${ROOM_ID}/attendances`) {
        return ok(apiAttendances(attendees, '2026-10-07T16:35:00Z', '2026-10-07T19:25:00Z'));
      }
      return undefined;
    };
    const input = { roomId: ROOM_ID, origin: WEBINAR_ORIGIN };
    const standard = await measure(route, 'get_room_attendance', input, AFTER_WEBINAR);
    const most = await measure(
      route,
      'get_room_attendance',
      { ...input, limit: 40, includeOtherAttendees: true },
      AFTER_WEBINAR,
    );

    assert.equal(standard.data.invitedCount, 400);
    assert.equal(standard.data.invitees.length, 10);
    assert.equal(standard.data.attendedEmails.length + standard.data.noShowEmails.length, 400);
    assert.equal(most.data.invitees.length, 40);
    assert.equal(most.data.otherAttendeeCount, 25);
    assert.equal(most.data.otherAttendees.length, 20);
    assert.ok(standard.bytes <= DEFAULT_RESULT_BYTES, `${standard.bytes}`);
    assert.ok(most.bytes <= MAX_RESULT_BYTES, `${most.bytes}`);
  });

  it('holds for find_users', async () => {
    const users = apiUsers(150);
    const route: Route = (method, path) => {
      if (method === 'GET' && path === '/v2/users') return ok(users);
      return path === '/v2/users/me' ? ok(users[0]) : undefined;
    };
    const standard = await measure(route, 'find_users', {});
    const most = await measure(route, 'find_users', { limit: 100 });

    assert.equal(standard.data.users.length, 50);
    assert.equal(most.data.users.length, 100);
    assert.equal(most.data.users[0].emailAddress.length, 40);
    assert.equal(most.data.users[0].lastName.length, 30);
    assert.equal(most.data.users[0].title.length, 20);
    assert.ok(standard.bytes <= DEFAULT_RESULT_BYTES, `${standard.bytes}`);
    assert.ok(most.bytes <= MAX_RESULT_BYTES, `${most.bytes}`);
  });

  it('holds for find_room_permissions, with the names of 61 characters of the user list', async () => {
    const users = apiUsers(150);
    const permissions = {
      userPermissions: apiRoomPermissionEntries(users.map((user) => user.id as string)),
      guestLinkPermissions: apiRoomPermissionEntries([guestLinkIdOf(1), guestLinkIdOf(2)]),
      groupLinkPermissions: null,
    };
    const route: Route = (method, path) => {
      if (path === `/v2/rooms/${ROOM_ID}/permissions`) return ok(permissions);
      return method === 'GET' && path === '/v2/users' ? ok(users) : undefined;
    };
    const standard = await measure(route, 'find_room_permissions', { roomId: ROOM_ID });
    const most = await measure(route, 'find_room_permissions', { roomId: ROOM_ID, limit: 100 });

    assert.equal(standard.data.permissions.length, 50);
    assert.equal(most.data.permissions.length, 100);
    assert.equal(most.data.permissions[0].userName.length, 61);
    assert.ok(standard.bytes <= DEFAULT_RESULT_BYTES, `${standard.bytes}`);
    assert.ok(most.bytes <= MAX_RESULT_BYTES, `${most.bytes}`);
  });

  it('holds for get_company_statistics', async () => {
    const route = (periods: unknown): Route => (_method, path) =>
      path === '/v2/stats' ? ok(periods) : undefined;
    const daily = await measure(
      route(apiStatsPeriods(32, '2026-09-05T08:00:00Z', 24)),
      'get_company_statistics',
      { from: '2026-09-05T08:00:00Z', to: '2026-10-07T08:00:00Z' },
    );
    const hourly = await measure(
      route(apiStatsPeriods(100, '2026-10-01T00:00:00Z', 1)),
      'get_company_statistics',
      { from: '2026-10-01T00:00:00Z', to: '2026-10-05T04:00:00Z', stepDurationHours: 1 },
    );

    assert.equal(daily.data.periodCount, 32);
    assert.equal(hourly.data.periodCount, 100);
    assert.ok(daily.bytes <= DEFAULT_RESULT_BYTES, `${daily.bytes}`);
    assert.ok(hourly.bytes <= MAX_RESULT_BYTES, `${hourly.bytes}`);
  });
});
