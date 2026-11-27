// The built server over stdio against the fake alfaview API, with the flows of docs/examples.md
// and every other tool of `standard`. The tests run in order and share the server and the state:
// each flow starts where the one before it left off.
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { ADMIN_GUEST_GROUP_MESSAGE, MEETING_ROOM_EMAIL_MESSAGE } from '../src/domain/guestLinks.ts';
import { meetingInviteeEmailMessage } from '../src/domain/meetings.ts';
import { SERVER_VERSION, toolsOfLevel } from '../src/server.ts';
import { ROOM_ID_MESSAGE } from '../src/tools/tool.ts';
import {
  ADVISOR_ROOM_ID,
  APPOINTMENT_LINK_ID,
  calendlyInviteeUri,
  GUEST_GROUP_ID,
  MEETING_ID,
  MEETING_LINK_ID,
  OLD_BOOKING_LINK_ID,
  PAST_WEBINAR_ORIGIN,
  sampleId,
  sampleState,
  SPECTATOR_GROUP_ID,
  startFakeApi,
  WEBINAR_ROOM_ID,
  type FakeApi,
  type FakeRequest,
} from './fake-api/server.ts';
import { callTool, type ToolCallResult } from './helpers/mcpClient.ts';
import { serverLaunch, TEST_ENV } from './helpers/spawnServer.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The server's time zone: the default, because the server starts without ALFAVIEW_TIME_ZONE. The
 * process runs in PROCESS_TIME_ZONE (UTC+14), which the server must not use.
 */
const TIME_ZONE = 'Europe/Berlin';
const PROCESS_TIME_ZONE = 'Pacific/Kiritimati';
const SECRETS = Object.values(TEST_ENV);

/** The time of the state: the start of this minute. The server's clock runs on from here. */
const T0 = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;

/** A Calendly booking two days ahead, and its move by one day, which has a new invitee URI. */
const BOOKING_START = Math.floor((T0 + 2 * DAY_MS) / HOUR_MS) * HOUR_MS;
const RESCHEDULED_START = BOOKING_START + DAY_MS;
const BOOKING_URI = calendlyInviteeUri(2);
const RESCHEDULED_URI = calendlyInviteeUri(3);

/**
 * Returns the date of `ms` in Berlin as YYYY-MM-DD, built from its parts, not from a locale's
 * pattern.
 */
function berlinDate(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(ms);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** The date of the next webinar in Berlin, seven days ahead: its times go in as local times. */
const WEBINAR_DATE = berlinDate(T0 + 7 * DAY_MS);
const WEBINAR_ORIGIN = `Webinar ${WEBINAR_DATE}`;

/** A timestamp of a result: whole seconds and the offset of Berlin. */
const LOCAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[12]:00$/;

const START_LINE = `alfaview-mcp: version ${SERVER_VERSION} ready for https://apis.alfaview.com with 17 tools at level standard, time zone ${TIME_ZONE}, personal data include`;

/** Every other line that the server may write to stderr. None can hold a value of a call. */
const LOG_LINE =
  /^alfaview-mcp: (logged in|logged in again after HTTP 401|tool [a-z_]+: [A-Za-z]+, \d+ requests?, \d+ ms)$/;

/** The protocol revision of the client that opens with server/discover. */
const MODERN_REVISION = '2026-07-28';

const iso = (ms: number) => new Date(ms).toISOString();
const roomPath = (roomId: string) => `/v2/rooms/${roomId}`;
const isLogin = (request: FakeRequest) =>
  request.method === 'POST' && request.path === '/v2/auth/api-key';

// The server over stdio

type StdioServer = {
  client: Client;
  /** The server process: the transport gives only its pid, and the exit test needs its code. */
  child: ChildProcess;
  /** What client.onerror received, for example a JSON line on stdout that is not an MCP message. */
  errors: Error[];
  stderr(): string;
};

/**
 * Starts dist/main.js with the preload and `env`, and connects an SDK client over stdio: a client
 * of the 2025 era, or with `modern` a client pinned to 2026-07-28, which opens with
 * server/discover.
 */
async function startOverStdio(
  env: Record<string, string>,
  fakeApiOrigin: string,
  modern = false,
): Promise<StdioServer> {
  const transport = new StdioClientTransport({
    ...serverLaunch({ env, fakeApiOrigin }),
    stderr: 'pipe',
  });
  let stderr = '';
  // With stderr 'pipe', the transport gives a readable stream before the start.
  const stderrStream = transport.stderr as Readable;
  stderrStream.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const client = new Client(
    { name: 'stdio-test', version: '0.0.0' },
    modern ? { versionNegotiation: { mode: { pin: MODERN_REVISION } } } : {},
  );
  const errors: Error[] = [];
  client.onerror = (error) => errors.push(error);
  await client.connect(transport);
  const child = (transport as unknown as { _process?: ChildProcess })._process;
  assert.ok(child !== undefined, 'StdioClientTransport keeps its process in _process');
  return { client, child, errors, stderr: () => stderr };
}

let api: FakeApi;
let server: StdioServer;

/** The tools that returned a normal result at least once. */
const succeededTools = new Set<string>();

/** The tools whose calls reached the wrapper, in order: each call writes one log line. */
const loggedCalls: string[] = [];

type Call = ToolCallResult & {
  /** The requests that reached the fake API during the call. */
  requests: FakeRequest[];
  /** `METHOD /path` of each of them. */
  paths: string[];
};

async function call(name: string, args: Record<string, unknown>): Promise<Call> {
  const first = api.requests.length;
  const result = await callTool(server.client, name, args);
  const requests = api.requests.slice(first);
  const paths = requests.map((request) => `${request.method} ${request.path}`);
  return { ...result, requests, paths };
}

/** Calls `name`, which must give a normal result. */
async function succeeds(name: string, args: Record<string, unknown> = {}): Promise<Call> {
  const result = await call(name, args);
  assert.equal(result.isError, false, `${name}: ${result.summary}`);
  succeededTools.add(name);
  loggedCalls.push(name);
  return result;
}

/** Calls `name`, which the tool must answer with an error result. */
async function failsInTool(name: string, args: Record<string, unknown>): Promise<Call> {
  const result = await call(name, args);
  assert.equal(result.isError, true, `${name}: ${result.summary}`);
  loggedCalls.push(name);
  return result;
}

/** Calls `name` with an input that the SDK refuses: the tool sends no request and logs no line. */
async function refusedBySdk(name: string, args: Record<string, unknown>): Promise<Call> {
  const result = await call(name, args);
  assert.equal(result.isError, true, name);
  assert.deepEqual(result.requests, []);
  return result;
}

/** Returns the body of the only request of `result` with this method and path. */
function bodyOf(result: Call, method: string, path: string): any {
  const matches = result.requests.filter(
    (request) => request.method === method && request.path === path,
  );
  assert.equal(matches.length, 1, `${method} ${path}`);
  return matches[0]!.body;
}

function linksOfRoom(roomId: string) {
  return api.state.guestLinks.filter((link) => link.roomId.toLowerCase() === roomId);
}

/** Returns the links of the Calendly client of flows A to C. */
function clientLinks() {
  return linksOfRoom(ADVISOR_ROOM_ID).filter(
    (link) => link.emailAddress === 'client.one@example.com',
  );
}

before(async () => {
  api = await startFakeApi(sampleState(T0));
  server = await startOverStdio({ ...TEST_ENV, TZ: PROCESS_TIME_ZONE }, api.origin);
});

after(async () => {
  await server.client.close();
  await api.close();
});

describe('the built server over stdio, against the fake alfaview API', () => {
  it('lists the 17 tools of the default level standard without a request to alfaview', async () => {
    const { tools } = await server.client.listTools();

    assert.deepEqual(
      tools.map((tool) => tool.name),
      toolsOfLevel('standard').map((tool) => tool.name),
    );
    assert.equal(tools.length, 17);
    assert.deepEqual(api.requests, []);
  });

  it('A: creates a guest link for a Calendly booking in the advisor room', async () => {
    const rooms = await succeeds('find_rooms', { name: 'anna' });
    assert.deepEqual(rooms.paths, ['POST /v2/auth/api-key', 'GET /v2/rooms']);
    assert.deepEqual(rooms.requests[1]!.query, { roomTypes: 'room', limit: '50' });
    assert.deepEqual(
      rooms.data.rooms.map((room: { id: string }) => room.id),
      [ADVISOR_ROOM_ID],
    );

    const validFrom = BOOKING_START - 15 * MINUTE_MS;
    const validUntil = BOOKING_START + 90 * MINUTE_MS;
    const created = await succeeds('create_guest_links', {
      roomId: rooms.data.rooms[0].id,
      guests: [{ emailAddress: 'client.one@example.com', displayName: 'Client One' }],
      locale: 'de-DE',
      validFrom: iso(validFrom),
      validUntil: iso(validUntil),
      origin: BOOKING_URI,
    });
    const [result] = created.data.results;
    assert.equal(result.status, 'created');
    assert.match(result.joinUrl, /^https:\/\/app\.alfaview\.com\/#\/join\//);
    // The create answer holds the link with its join URL, so the tool reads nothing back.
    assert.deepEqual(created.paths, [
      'GET /v2/permission-groups',
      `GET ${roomPath(ADVISOR_ROOM_ID)}/guest-links`,
      `POST ${roomPath(ADVISOR_ROOM_ID)}/guest-links`,
    ]);
    assert.deepEqual(bodyOf(created, 'POST', `${roomPath(ADVISOR_ROOM_ID)}/guest-links`), {
      create: [
        {
          emailAddress: 'client.one@example.com',
          displayName: 'Client One',
          locale: 'de-DE',
          permissionGroupId: GUEST_GROUP_ID,
          dialInAllowed: false,
          sendEmail: false,
          validFrom: iso(validFrom),
          validUntil: iso(validUntil),
        },
      ],
      origin: BOOKING_URI,
      timezone: TIME_ZONE,
    });
    assert.equal(created.data.permissionGroupName, 'Guest');
    assert.match(created.data.validFrom, LOCAL_TIMESTAMP);
    assert.equal(Date.parse(created.data.validFrom), validFrom);
    assert.match(created.summary, /^Created 1 guest link in room .*\. alfaview sent no emails\.$/);
    assert.match(created.summary, / valid from \d{4}-\d{2}-\d{2} \d{2}:\d{2} Europe\/Berlin until /);
  });

  it('C: moves the booking: deletes its link and creates one for the new invitee', async () => {
    const found = await succeeds('find_guest_links', {
      roomId: ADVISOR_ROOM_ID,
      emailAddress: 'Client.One@example.com',
      origin: BOOKING_URI,
    });
    assert.equal(found.data.totalMatches, 1);
    const [link] = found.data.links;
    assert.equal(link.displayName, 'Client One');
    assert.ok(!('joinUrl' in link) && !('roomId' in link));

    const deleted = await succeeds('delete_guest_link', { guestLinkId: link.id });
    assert.deepEqual(deleted.paths, [
      `GET /v2/guest-links/${link.id}`,
      `GET ${roomPath(ADVISOR_ROOM_ID)}`,
      `DELETE ${roomPath(ADVISOR_ROOM_ID)}/guest-links/${link.id}`,
    ]);
    assert.equal(deleted.data.revocationEmail, false);

    const created = await succeeds('create_guest_links', {
      roomId: ADVISOR_ROOM_ID,
      guests: [{ emailAddress: 'client.one@example.com', displayName: 'Client One' }],
      locale: 'de-DE',
      validFrom: iso(RESCHEDULED_START - 15 * MINUTE_MS),
      validUntil: iso(RESCHEDULED_START + 90 * MINUTE_MS),
      origin: RESCHEDULED_URI,
    });
    assert.equal(created.data.createdCount, 1);
    assert.notEqual(created.data.results[0].guestLinkId, link.id);
    assert.deepEqual(
      clientLinks().map((item) => item.origin),
      [RESCHEDULED_URI],
    );
  });

  it('B: cancels the booking: finds its link in every room and deletes it', async () => {
    const found = await succeeds('find_guest_links', {
      emailAddress: 'client.one@example.com',
      origin: RESCHEDULED_URI,
    });
    assert.deepEqual(found.paths, ['GET /v2/guest-links', 'GET /v2/permission-groups']);
    assert.deepEqual(found.requests[0]!.query, { limit: '500' });
    const [link] = found.data.links;
    assert.equal(link.roomId, ADVISOR_ROOM_ID);

    await succeeds('delete_guest_link', { guestLinkId: link.id });
    assert.equal(clientLinks().length, 0);
  });

  it("D: reports the attendance of yesterday's appointment", async () => {
    const filter = {
      roomId: ADVISOR_ROOM_ID,
      emailAddress: 'jane.doe@example.com',
      origin: 'Zapier',
    };
    const hidden = await succeeds('find_guest_links', filter);
    assert.equal(hidden.data.totalMatches, 0);
    assert.equal(hidden.data.expiredMatchCount, 1);
    assert.match(hidden.summary, /1 expired guest link also matches\. Call again with/);

    const found = await succeeds('find_guest_links', { ...filter, includeExpired: true });
    assert.deepEqual(
      found.data.links.map((link: { id: string }) => link.id),
      [APPOINTMENT_LINK_ID],
    );

    const appointmentFrom = T0 - 26 * HOUR_MS;
    const attendance = await succeeds('get_guest_link_attendance', {
      guestLinkId: APPOINTMENT_LINK_ID,
      minimumMinutes: 30,
    });
    assert.deepEqual(attendance.paths, [
      `GET /v2/guest-links/${APPOINTMENT_LINK_ID}`,
      `GET ${roomPath(ADVISOR_ROOM_ID)}/attendances`,
    ]);
    assert.deepEqual(attendance.requests[1]!.query, {
      from: iso(appointmentFrom),
      to: iso(appointmentFrom + 90 * MINUTE_MS),
    });
    // The attendance fixture: 14 minutes, then 27 minutes 10 seconds after a break.
    const { data } = attendance;
    assert.deepEqual(
      [data.attended, data.totalMinutes, data.sessionCount, data.stillConnected],
      [true, 41, 2, false],
    );
    assert.equal(Date.parse(data.firstJoinedAt), appointmentFrom + 13 * MINUTE_MS + 10_000);
    assert.match(data.firstJoinedAt, LOCAL_TIMESTAMP);
  });

  it('E: registers 30 people for a webinar in two calls; a repeat creates nothing', async () => {
    const registrants = Array.from({ length: 30 }, (_, index) => {
      const n = String(index + 1).padStart(2, '0');
      return { emailAddress: `registrant.${n}@example.com`, displayName: `Registrant ${n}` };
    });
    const input = {
      roomId: WEBINAR_ROOM_ID,
      locale: 'de-DE',
      permissionGroup: 'Spectator',
      origin: WEBINAR_ORIGIN,
      validFrom: `${WEBINAR_DATE}T17:30`,
      validUntil: `${WEBINAR_DATE}T19:30`,
    };

    const firstGuests = registrants.slice(0, 25);
    const first = await succeeds('create_guest_links', { ...input, guests: firstGuests });
    assert.equal(first.data.createdCount, 25);
    assert.equal(first.data.permissionGroupName, 'Spectator');
    // The groups, the links of the room, and one create per guest.
    assert.equal(first.paths.length, 2 + 25);
    assert.match(first.data.validFrom, new RegExp(`^${WEBINAR_DATE}T17:30:00\\+0[12]:00$`));
    assert.match(first.data.validUntil, new RegExp(`^${WEBINAR_DATE}T19:30:00\\+0[12]:00$`));
    const posts = first.requests.filter((request) => request.method === 'POST');
    assert.equal(posts.length, 25);
    for (const post of posts) {
      const [guest] = post.body.create;
      assert.equal(guest.permissionGroupId, SPECTATOR_GROUP_ID);
      assert.equal(guest.sendEmail, false);
      assert.equal(Date.parse(guest.validFrom), Date.parse(first.data.validFrom));
    }

    const lastGuests = registrants.slice(25);
    const second = await succeeds('create_guest_links', { ...input, guests: lastGuests });
    assert.equal(second.data.createdCount, 5);
    assert.equal(second.paths.length, 2 + 5);

    const repeat = await succeeds('create_guest_links', { ...input, guests: firstGuests });
    assert.deepEqual(repeat.paths, [
      'GET /v2/permission-groups',
      `GET ${roomPath(WEBINAR_ROOM_ID)}/guest-links`,
    ]);
    assert.deepEqual([repeat.data.createdCount, repeat.data.existingCount], [0, 25]);
    type GuestResult = { guestLinkId: string; joinUrl: string };
    const linkOf = (result: GuestResult) => [result.guestLinkId, result.joinUrl];
    assert.deepEqual(repeat.data.results.map(linkOf), first.data.results.map(linkOf));
    assert.match(repeat.summary, /^Created 0 guest links .* 25 guests already had a link\. /);
    assert.equal(
      linksOfRoom(WEBINAR_ROOM_ID).filter((link) => link.origin === WEBINAR_ORIGIN).length,
      30,
    );
  });

  it('F: gives the email lists of the attendees and no-shows of the past webinar', async () => {
    const report = await succeeds('get_room_attendance', {
      roomId: WEBINAR_ROOM_ID,
      origin: PAST_WEBINAR_ORIGIN,
      minimumMinutes: 15,
    });
    assert.deepEqual(report.paths, [
      `GET ${roomPath(WEBINAR_ROOM_ID)}/guest-links`,
      `GET ${roomPath(WEBINAR_ROOM_ID)}/attendances`,
    ]);
    const { data } = report;
    assert.deepEqual(
      [data.invitedCount, data.attendedCount, data.noShowCount, data.otherAttendeeCount],
      [4, 2, 2, 1],
    );
    assert.deepEqual(data.attendedEmails, ['anna.attendee@example.com', 'dirk.twice@example.com']);
    assert.deepEqual(data.noShowEmails, ['bob.brief@example.com', 'carla.absent@example.com']);
    // Dirk registered twice, once with capitals: one person, with the minutes of both links.
    const dirk = data.invitees.find(
      (person: { emailAddress: string }) => person.emailAddress === 'dirk.twice@example.com',
    );
    assert.deepEqual(
      [dirk.guestLinkIds.length, dirk.totalMinutes, dirk.status],
      [2, 20, 'attended'],
    );
    // The window is the validity of the links with the origin.
    assert.equal(Date.parse(data.windowFrom), T0 - 72 * HOUR_MS - 30 * MINUTE_MS);
    assert.equal(Date.parse(data.windowTo), T0 - 70 * HOUR_MS);
  });

  it('G: shows who waits in the advisor room, the longest wait first', async () => {
    const waiting = await succeeds('find_room_participants', {
      roomId: ADVISOR_ROOM_ID,
      location: 'waiting_room',
    });
    assert.deepEqual(waiting.paths, [
      `GET ${roomPath(ADVISOR_ROOM_ID)}/participants`,
      `GET ${roomPath(ADVISOR_ROOM_ID)}/attendances`,
      `GET ${roomPath(ADVISOR_ROOM_ID)}/guest-links`,
    ]);
    const { data } = waiting;
    assert.deepEqual([data.roomUserCount, data.waitingCount, data.totalMatches], [1, 2, 2]);
    const [jane, visitor] = data.participants;
    assert.deepEqual(
      [jane.participantType, jane.emailAddress, jane.guestLinkId, jane.inWaitingRoom],
      ['guest_link', 'jane.doe@example.com', APPOINTMENT_LINK_ID, true],
    );
    assert.equal(Date.parse(jane.connectedAt), T0 - 7 * MINUTE_MS - 20_000);
    assert.deepEqual([visitor.participantType, visitor.emailAddress], ['guest', null]);
    assert.equal(Date.parse(visitor.connectedAt), T0 - 3 * MINUTE_MS);
  });

  it('H: deletes the expired links of the past webinar and of the old bookings', async () => {
    const webinar = await succeeds('delete_expired_guest_links', {
      roomId: WEBINAR_ROOM_ID,
      originContains: 'webinar',
    });
    assert.deepEqual(
      [webinar.data.deletedCount, webinar.data.remainingCount, webinar.data.complete],
      [5, 0, true],
    );
    assert.equal(webinar.paths.filter((path) => path.startsWith('DELETE ')).length, 5);
    // The links of the next webinar have not expired.
    assert.deepEqual(
      [...new Set(linksOfRoom(WEBINAR_ROOM_ID).map((link) => link.origin))],
      [WEBINAR_ORIGIN],
    );

    const bookings = await succeeds('delete_expired_guest_links', {
      roomId: ADVISOR_ROOM_ID,
      originContains: 'api.calendly.com',
    });
    assert.equal(bookings.data.deletedCount, 1);
    assert.deepEqual(bookings.paths.slice(-1), [
      `DELETE ${roomPath(ADVISOR_ROOM_ID)}/guest-links/${OLD_BOOKING_LINK_ID}`,
    ]);
    // Jane's appointment ended less than 48 hours ago, and the other link has no end.
    assert.equal(linksOfRoom(ADVISOR_ROOM_ID).length, 2);
  });

  it('reads the room with its passcode, then regenerates the passcode', async () => {
    const room = await succeeds('get_room', { roomId: ADVISOR_ROOM_ID, includePasscode: true });
    assert.deepEqual(room.paths, [
      `GET ${roomPath(ADVISOR_ROOM_ID)}`,
      `GET ${roomPath(ADVISOR_ROOM_ID)}/passcode`,
    ]);
    assert.equal(room.data.passcode, 'Kx7#mQ2p');
    assert.deepEqual(room.data.subrooms, [
      { id: '2d4f6a8c-1e3b-5d7f-9a0c-2e4f6a8c0e11', displayName: 'Breakout 1' },
    ]);

    const regenerated = await succeeds('regenerate_room_passcode', { roomId: ADVISOR_ROOM_ID });
    assert.deepEqual(regenerated.paths, [`POST ${roomPath(ADVISOR_ROOM_ID)}/passcode`]);
    assert.notEqual(regenerated.data.passcode, 'Kx7#mQ2p');
    assert.equal(api.state.passcodes.get(ADVISOR_ROOM_ID)?.passcode, regenerated.data.passcode);
  });

  // alfaview answers 200 with an empty passcode for a room without a passcode.
  it('reads a room without a passcode, for which alfaview answers an empty passcode', async () => {
    const room = await succeeds('get_room', { roomId: WEBINAR_ROOM_ID, includePasscode: true });
    assert.deepEqual(room.paths, [
      `GET ${roomPath(WEBINAR_ROOM_ID)}`,
      `GET ${roomPath(WEBINAR_ROOM_ID)}/passcode`,
    ]);
    assert.deepEqual(
      room.requests.map((request) => request.status),
      [200, 200],
    );
    assert.equal(room.data.passcode, null);
    assert.match(room.summary, / The room has no passcode yet\.$/);
  });

  it('extends a guest link of the next webinar and moves it to another group', async () => {
    const link = linksOfRoom(WEBINAR_ROOM_ID).find(
      (item) => item.emailAddress === 'registrant.26@example.com',
    )!;
    const updated = await succeeds('update_guest_link', {
      guestLinkId: link.id,
      validUntil: `${WEBINAR_DATE}T20:00`,
      permissionGroup: 'guest',
    });
    assert.deepEqual(updated.paths, [
      `GET /v2/guest-links/${link.id}`,
      'GET /v2/permission-groups',
      `PATCH /v2/guest-links/${link.id}`,
      `GET /v2/guest-links/${link.id}`,
    ]);
    const patch = bodyOf(updated, 'PATCH', `/v2/guest-links/${link.id}`);
    assert.deepEqual(Object.keys(patch).sort(), [
      'displayName',
      'permissionGroupId',
      'sendEmail',
      'timezone',
      'validUntil',
    ]);
    assert.deepEqual(
      [patch.displayName, patch.permissionGroupId, patch.sendEmail, patch.timezone],
      ['Registrant 26', GUEST_GROUP_ID, false, TIME_ZONE],
    );
    assert.match(updated.data.validUntil, new RegExp(`^${WEBINAR_DATE}T20:00:00\\+0[12]:00$`));
    assert.equal(updated.data.permissionGroupName, 'Guest');
    assert.ok(!('joinUrl' in updated.data));
  });

  it('schedules, finds, reads, moves and cancels a meeting', async () => {
    const start = Math.floor((T0 + 3 * DAY_MS) / HOUR_MS) * HOUR_MS;
    const created = await succeeds('create_meeting', {
      title: 'Project check-in',
      start: iso(start),
      end: iso(start + HOUR_MS),
      agenda: 'Review the first week.',
    });
    const meetingId: string = created.data.id;
    assert.deepEqual(created.paths, [
      'POST /v2/meetings',
      `GET /v2/meetings/${meetingId}`,
      'GET /v2/permission-groups',
    ]);
    type GroupLink = { permissionGroupName: string };
    assert.deepEqual(
      created.data.groupLinks.map((link: GroupLink) => link.permissionGroupName),
      ['Guest', 'Moderator', 'Participant', 'Spectator'],
    );
    assert.equal(bodyOf(created, 'POST', '/v2/meetings').timezone, TIME_ZONE);

    const found = await succeeds('find_meetings');
    assert.deepEqual(
      found.data.meetings.map((meeting: { id: string }) => meeting.id),
      [meetingId, MEETING_ID],
    );

    const seeded = await succeeds('get_meeting', { meetingId: MEETING_ID });
    assert.equal(seeded.data.guestLinkCount, 1);
    assert.equal(seeded.data.groupLinks.length, 4);

    const moved = await succeeds('update_meeting', {
      meetingId,
      title: 'Project check-in, moved',
      start: iso(start + 30 * MINUTE_MS),
    });
    // The start alone moves: the tool sends the end that alfaview had.
    assert.deepEqual(bodyOf(moved, 'PATCH', `/v2/meetings/${meetingId}`), {
      title: 'Project check-in, moved',
      start: iso(start + 30 * MINUTE_MS),
      end: iso(start + HOUR_MS),
    });
    assert.equal(moved.data.title, 'Project check-in, moved');
    assert.equal(Date.parse(moved.data.start), start + 30 * MINUTE_MS);
    // The changes return no join URLs, so they need no group names either.
    assert.ok(!('groupLinks' in moved.data));
    assert.deepEqual(moved.paths, [
      `GET /v2/meetings/${meetingId}`,
      `PATCH /v2/meetings/${meetingId}`,
      `GET /v2/meetings/${meetingId}`,
    ]);

    const canceled = await succeeds('cancel_meeting', { meetingId });
    assert.deepEqual(bodyOf(canceled, 'POST', `/v2/meetings/${meetingId}/cancellation`), {
      sendNotification: false,
    });
    assert.equal(canceled.data.state, 'canceled');
    assert.match(canceled.data.canceledAt, LOCAL_TIMESTAMP);
    assert.ok(!('groupLinks' in canceled.data));
    // At the level standard, the meeting is read first: an externally managed one is refused.
    assert.deepEqual(canceled.paths, [
      `GET /v2/meetings/${meetingId}`,
      `POST /v2/meetings/${meetingId}/cancellation`,
      `GET /v2/meetings/${meetingId}`,
    ]);
  });

  it('reads the company statistics of the last seven days', async () => {
    const to = Math.floor(T0 / HOUR_MS) * HOUR_MS;
    const statistics = await succeeds('get_company_statistics', {
      from: iso(to - 7 * DAY_MS),
      to: iso(to),
    });
    assert.deepEqual(statistics.paths, ['GET /v2/stats']);
    assert.deepEqual(statistics.requests[0]!.query, {
      from: iso(to - 7 * DAY_MS),
      to: iso(to),
      stepDurationHours: '24',
    });
    assert.equal(statistics.data.periodCount, 7);
    // statistics/stats.json: 36,900 seconds of the first day.
    assert.equal(statistics.data.periods[0].roomOnlineMinutes, 615);
  });

  it('answers refusals and alfaview errors with error results', async () => {
    const unknownRoom = sampleId('21', 9);
    const missing = await failsInTool('get_room', { roomId: unknownRoom });
    assert.equal(
      missing.summary,
      "alfaview could not find the room. It was deleted, or the API key's user cannot see it.",
    );
    assert.deepEqual(missing.paths, [`GET ${roomPath(unknownRoom)}`]);

    const meetingLink = await failsInTool('delete_guest_link', { guestLinkId: MEETING_LINK_ID });
    assert.equal(meetingLink.summary, MEETING_ROOM_EMAIL_MESSAGE);
    assert.deepEqual(meetingLink.paths, [
      `GET /v2/guest-links/${MEETING_LINK_ID}`,
      `GET ${roomPath(MEETING_ID)}`,
    ]);

    const meetingUpdate = await failsInTool('update_meeting', {
      meetingId: MEETING_ID,
      title: 'New',
    });
    assert.equal(meetingUpdate.summary, meetingInviteeEmailMessage(1));
    assert.deepEqual(meetingUpdate.paths, [`GET /v2/meetings/${MEETING_ID}`]);

    // No level takes a guest link group with admin.
    const adminGuest = await failsInTool('create_guest_links', {
      roomId: ADVISOR_ROOM_ID,
      guests: [{ emailAddress: 'admin.guest@example.com', displayName: 'Admin Guest' }],
      locale: 'en-US',
      permissionGroup: 'Admin',
    });
    assert.equal(adminGuest.summary, ADMIN_GUEST_GROUP_MESSAGE);
    assert.deepEqual(adminGuest.paths, ['GET /v2/permission-groups']);

    api.answerNextWith(500);
    const serverError = await failsInTool('find_rooms', {});
    assert.equal(
      serverError.summary,
      'alfaview had a temporary problem (HTTP 500). Try again later.',
    );
    assert.deepEqual(
      serverError.requests.map((request) => request.status),
      [500],
    );

    const byName = await refusedBySdk('find_guest_links', {
      roomId: 'Advisory Room Anna Example',
    });
    assert.ok(byName.summary.includes(ROOM_ID_MESSAGE), byName.summary);
    assert.match(byName.summary, /^Input validation error: Invalid arguments for tool find_guest_links: /);

    // A tool that the server does not list is a protocol error.
    const first = api.requests.length;
    await assert.rejects(
      server.client.callTool({ name: 'delete_room', arguments: { roomId: ADVISOR_ROOM_ID } }),
      { code: -32602, message: /Tool delete_room not found/ },
    );
    assert.equal(api.requests.length, first);
  });

  it('deletes the guest link of a meeting room when sendEmail is true', async () => {
    const deleted = await succeeds('delete_guest_link', {
      guestLinkId: MEETING_LINK_ID,
      sendEmail: true,
    });
    assert.equal(deleted.data.revocationEmail, true);
    assert.match(deleted.summary, / alfaview emails the guest about it\.$/);
    assert.equal(
      deleted.paths.at(-1),
      `DELETE ${roomPath(MEETING_ID)}/guest-links/${MEETING_LINK_ID}`,
    );
  });

  it('called every tool of the level standard, logged in once, sent the raw token, and asked for no email', () => {
    assert.deepEqual(
      [...succeededTools].sort(),
      toolsOfLevel('standard').map((tool) => tool.name).sort(),
    );
    assert.deepEqual(api.tokens, ['fake-token-1']);
    assert.equal(api.requests.filter(isLogin).length, 1);
    for (const request of api.requests.filter((item) => !isLogin(item))) {
      assert.equal(request.authorization, 'fake-token-1', `${request.method} ${request.path}`);
    }
    // The delete with sendEmail true has no body: alfaview emails for it anyway.
    const bodies = JSON.stringify(api.requests.map((request) => request.body));
    assert.ok(!bodies.includes('"sendEmail":true'));
    assert.ok(!bodies.includes('"sendNotification":true'));
  });

  it('logs in again once when alfaview refuses the token, and repeats the request', async () => {
    api.answerNextWith(401);
    const rooms = await succeeds('find_rooms');

    assert.deepEqual(rooms.paths, ['GET /v2/rooms', 'POST /v2/auth/api-key', 'GET /v2/rooms']);
    assert.deepEqual(
      rooms.requests.map((request) => request.status),
      [401, 200, 200],
    );
    assert.deepEqual(api.tokens, ['fake-token-1', 'fake-token-2']);
    assert.equal(rooms.requests[2]!.authorization, 'fake-token-2');
    assert.equal(rooms.data.totalMatches, 4);
  });

  it('ends with code 0 within 2 seconds when stdin closes, with connections open', async () => {
    const { child } = server;
    assert.equal(child.exitCode, null);
    const exit = new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
      child.once('exit', (code, signal) => resolve([code, signal])),
    );
    const started = Date.now();
    await server.client.close();

    assert.deepEqual(await exit, [0, null]);
    assert.ok(Date.now() - started < 2_000, `${Date.now() - started} ms`);
  });

  it('gave the client no error from stdout, and wrote one log line per call to stderr', () => {
    assert.deepEqual(server.errors, []);

    const stderr = server.stderr();
    const lines = stderr.trimEnd().split('\n');
    assert.equal(lines[0], START_LINE);
    // The client of this file opens with initialize, so the server serves the 2025 era.
    assert.equal(lines[1], 'alfaview-mcp: protocol era 2025');
    for (const line of lines.slice(2)) assert.match(line, LOG_LINE);
    assert.deepEqual(
      lines.filter((line) => line.includes(' logged in')),
      ['alfaview-mcp: logged in', 'alfaview-mcp: logged in again after HTTP 401'],
    );
    assert.deepEqual(
      lines.flatMap((line) => /^alfaview-mcp: tool ([a-z_]+):/.exec(line)?.slice(1) ?? []),
      loggedCalls,
    );

    // The log line pattern leaves no room for a value. This check names what must never appear.
    const people = api.requests
      .flatMap((request) => [request.body, ...(request.body?.create ?? [])])
      .concat(sampleState(T0).guestLinks)
      .flatMap((item) => [item?.emailAddress, item?.displayName])
      .filter((value): value is string => typeof value === 'string' && value.length >= 3);
    assert.ok(people.length > 40);
    for (const value of [...SECRETS, ...api.tokens, ...people]) {
      assert.ok(!stderr.includes(value), value);
    }
  });

});

// The command serves revision 2026-07-28 to a client that opens with server/discover, with the
// same tools and results.
describe('the built server over stdio, for a client of 2026-07-28', () => {
  it('answers server/discover, books and cancels a guest link, and exits when stdin closes', async () => {
    const modernApi = await startFakeApi(sampleState(T0));
    const modern = await startOverStdio({ ...TEST_ENV, TZ: PROCESS_TIME_ZONE }, modernApi.origin, true);
    const discovered = await modern.client.discover();
    const version = modern.client.getNegotiatedProtocolVersion();
    const { tools } = await modern.client.listTools();

    const guest = { emailAddress: 'client.two@example.com', displayName: 'Client Two' };
    const created = await callTool(modern.client, 'create_guest_links', {
      roomId: ADVISOR_ROOM_ID,
      guests: [guest],
      locale: 'en-US',
      validFrom: iso(BOOKING_START),
      validUntil: iso(BOOKING_START + HOUR_MS),
      origin: calendlyInviteeUri(4),
    });
    const guestLinkId: string = created.data?.results[0].guestLinkId;
    const deleted = await callTool(modern.client, 'delete_guest_link', { guestLinkId });

    const exit = new Promise<number | null>((resolve) => modern.child.once('exit', resolve));
    await modern.client.close();
    const code = await exit;
    await modernApi.close();

    assert.equal(version, MODERN_REVISION);
    assert.ok(discovered.supportedVersions.includes(MODERN_REVISION), JSON.stringify(discovered));
    assert.deepEqual(
      tools.map((tool) => tool.name),
      toolsOfLevel('standard').map((tool) => tool.name),
    );
    assert.equal(created.isError, false, created.summary);
    assert.equal(created.data.createdCount, 1);
    assert.equal(deleted.isError, false, deleted.summary);
    assert.equal(deleted.data.revocationEmail, false);
    assert.equal(
      modernApi.state.guestLinks.some((link) => link.emailAddress === guest.emailAddress),
      false,
    );
    assert.equal(code, 0);
    assert.deepEqual(modern.errors, []);
    const lines = modern.stderr().trimEnd().split('\n');
    assert.deepEqual(lines.slice(0, 3), [
      START_LINE,
      'alfaview-mcp: protocol era 2026-07-28',
      'alfaview-mcp: logged in',
    ]);
    assert.deepEqual(
      lines.slice(3).map((line) => /^alfaview-mcp: tool ([a-z_]+): ok, /.exec(line)?.[1]),
      ['create_guest_links', 'delete_guest_link'],
    );
  });
});
