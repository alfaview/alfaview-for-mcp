// The flows A to H of docs/examples.md over stdio with ALFAVIEW_PERSONAL_DATA=omit. They work by
// IDs, times, counts and states, and no result holds the name or the email address of a guest. The
// tests run in order and share the server and the state.
import assert from 'node:assert/strict';
import type { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { SERVER_VERSION, serverInstructions } from '../src/server.ts';
import {
  ADVISOR_ROOM_ID,
  APPOINTMENT_LINK_ID,
  calendlyInviteeUri,
  OLD_BOOKING_LINK_ID,
  PAST_WEBINAR_ORIGIN,
  sampleState,
  startFakeApi,
  WEBINAR_ROOM_ID,
  type FakeApi,
} from './fake-api/server.ts';
import { callTool, type ToolCallResult } from './helpers/mcpClient.ts';
import { serverLaunch, TEST_ENV } from './helpers/spawnServer.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const T0 = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
const BOOKING_START = Math.floor((T0 + 2 * DAY_MS) / HOUR_MS) * HOUR_MS;
const BOOKING_URI = calendlyInviteeUri(2);
const RESCHEDULED_URI = calendlyInviteeUri(3);
const WEBINAR_ORIGIN = 'Webinar of next week';
const iso = (ms: number) => new Date(ms).toISOString();

const CLIENT = { emailAddress: 'client.one@example.com', displayName: 'Client One' };

let api: FakeApi;
let client: Client;
let stderr = '';
/** Every result text that the server sent, for the check at the end. */
const texts: string[] = [];

async function succeeds(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
  const result = await callTool(client, name, args);
  texts.push(result.summary, result.text ?? '');
  assert.equal(result.isError, false, `${name}: ${result.summary}`);
  return result;
}

before(async () => {
  api = await startFakeApi(sampleState(T0));
  const transport = new StdioClientTransport({
    ...serverLaunch({
      env: { ...TEST_ENV, TZ: 'Europe/Berlin', ALFAVIEW_PERSONAL_DATA: 'omit' },
      fakeApiOrigin: api.origin,
    }),
    stderr: 'pipe',
  });
  (transport.stderr as Readable).setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  client = new Client({ name: 'stdio-personal-data-test', version: '0.0.0' });
  await client.connect(transport);
});

after(async () => {
  await client.close();
  await api.close();
});

describe('the built server over stdio with ALFAVIEW_PERSONAL_DATA=omit', () => {
  it('gives the instructions of Leave out', () => {
    assert.equal(client.getInstructions(), serverInstructions('Europe/Berlin', undefined, 'omit'));
  });

  it('A: creates a guest link for a booking, and matches the result by its index', async () => {
    const rooms = await succeeds('find_rooms', { name: 'anna' });
    assert.deepEqual(
      rooms.data.rooms.map((room: { id: string; displayName: string }) => [room.id, room.displayName]),
      [[ADVISOR_ROOM_ID, 'Advisory Room Anna Example']],
    );
    const created = await succeeds('create_guest_links', {
      roomId: ADVISOR_ROOM_ID,
      guests: [CLIENT],
      locale: 'de-DE',
      validFrom: iso(BOOKING_START - 15 * MINUTE_MS),
      validUntil: iso(BOOKING_START + 90 * MINUTE_MS),
      origin: BOOKING_URI,
    });
    const [result] = created.data.results;
    assert.deepEqual(
      [result.index, result.status, result.emailAddress, result.displayName],
      [0, 'created', null, null],
    );
    assert.match(result.joinUrl, /^https:\/\/app\.alfaview\.com\/#\/join\//);
  });

  it('C and B: moves the booking, then cancels it, by email address, origin and ID', async () => {
    const found = await succeeds('find_guest_links', {
      roomId: ADVISOR_ROOM_ID,
      emailAddress: CLIENT.emailAddress,
      origin: BOOKING_URI,
    });
    assert.equal(found.data.totalMatches, 1);
    const [link] = found.data.links;
    assert.deepEqual([link.emailAddress, link.displayName, link.origin], [null, null, null]);
    await succeeds('delete_guest_link', { guestLinkId: link.id });
    const moved = await succeeds('create_guest_links', {
      roomId: ADVISOR_ROOM_ID,
      guests: [CLIENT],
      locale: 'de-DE',
      validFrom: iso(BOOKING_START + DAY_MS - 15 * MINUTE_MS),
      validUntil: iso(BOOKING_START + DAY_MS + 90 * MINUTE_MS),
      origin: RESCHEDULED_URI,
    });
    assert.equal(moved.data.createdCount, 1);

    const again = await succeeds('find_guest_links', {
      emailAddress: CLIENT.emailAddress,
      origin: RESCHEDULED_URI,
    });
    await succeeds('delete_guest_link', { guestLinkId: again.data.links[0].id });
    assert.equal(
      api.state.guestLinks.filter((item) => item.emailAddress === CLIENT.emailAddress).length,
      0,
    );
  });

  it("D: reports the attendance of yesterday's appointment", async () => {
    const found = await succeeds('find_guest_links', {
      roomId: ADVISOR_ROOM_ID,
      emailAddress: 'jane.doe@example.com',
      origin: 'Zapier',
      includeExpired: true,
    });
    assert.deepEqual(
      found.data.links.map((link: { id: string }) => link.id),
      [APPOINTMENT_LINK_ID],
    );
    const attendance = await succeeds('get_guest_link_attendance', {
      guestLinkId: APPOINTMENT_LINK_ID,
      minimumMinutes: 30,
    });
    const { data } = attendance;
    assert.deepEqual(
      [data.attended, data.totalMinutes, data.emailAddress, data.displayName],
      [true, 41, null, null],
    );
  });

  it('E: registers 25 people for a webinar; a repeat returns them as existing, in the same order', async () => {
    const registrants = Array.from({ length: 25 }, (_, index) => ({
      emailAddress: `registrant.${index + 1}@example.com`,
      displayName: `Registrant ${index + 1}`,
    }));
    const input = {
      roomId: WEBINAR_ROOM_ID,
      locale: 'de-DE',
      permissionGroup: 'Spectator',
      origin: WEBINAR_ORIGIN,
      validFrom: iso(T0 + 7 * DAY_MS),
      validUntil: iso(T0 + 7 * DAY_MS + 2 * HOUR_MS),
      guests: registrants,
    };
    const first = await succeeds('create_guest_links', input);
    const repeat = await succeeds('create_guest_links', input);

    assert.equal(first.data.createdCount, 25);
    assert.deepEqual([repeat.data.createdCount, repeat.data.existingCount], [0, 25]);
    type Result = { index: number; guestLinkId: string; emailAddress: string | null };
    const byIndex = (results: Result[]) => results.map((result) => [result.index, result.guestLinkId]);
    assert.deepEqual(byIndex(repeat.data.results), byIndex(first.data.results));
    assert.deepEqual(
      first.data.results.map((result: Result) => result.index),
      registrants.map((_, index) => index),
    );
    assert.ok(first.data.results.every((result: Result) => result.emailAddress === null));
  });

  it('F: gives the counts and the statuses of the past webinar, without the email lists', async () => {
    const report = await succeeds('get_room_attendance', {
      roomId: WEBINAR_ROOM_ID,
      origin: PAST_WEBINAR_ORIGIN,
      minimumMinutes: 15,
    });
    const { data } = report;
    assert.deepEqual(
      [data.invitedCount, data.attendedCount, data.noShowCount, data.otherAttendeeCount],
      [4, 2, 2, 1],
    );
    assert.deepEqual([data.attendedEmails, data.noShowEmails, data.origin], [null, null, null]);
    type Invitee = { status: string; guestLinkIds: string[]; emailAddress: string | null };
    assert.deepEqual(
      data.invitees.map((person: Invitee) => [person.status, person.guestLinkIds.length, person.emailAddress]).sort(),
      [
        ['attended', 1, null],
        ['attended', 2, null],
        ['no_show', 1, null],
        ['no_show', 1, null],
      ],
    );
  });

  it('G: shows who waits in the advisor room, with the guest link instead of the address', async () => {
    const waiting = await succeeds('find_room_participants', {
      roomId: ADVISOR_ROOM_ID,
      location: 'waiting_room',
    });
    const [jane, visitor] = waiting.data.participants;
    assert.deepEqual(
      [jane.participantType, jane.guestLinkId, jane.emailAddress, jane.displayName],
      ['guest_link', APPOINTMENT_LINK_ID, null, null],
    );
    assert.deepEqual([visitor.participantType, visitor.displayName], ['guest', null]);
  });

  it('H: deletes the expired links of the past webinar and of the old bookings', async () => {
    const webinar = await succeeds('delete_expired_guest_links', {
      roomId: WEBINAR_ROOM_ID,
      originContains: 'webinar altersvorsorge',
    });
    assert.deepEqual([webinar.data.deletedCount, webinar.data.originContains], [5, null]);
    const bookings = await succeeds('delete_expired_guest_links', {
      roomId: ADVISOR_ROOM_ID,
      originContains: 'api.calendly.com',
    });
    assert.equal(bookings.data.deletedCount, 1);
    assert.ok(!api.state.guestLinks.some((link) => link.id === OLD_BOOKING_LINK_ID));
  });

  it('gave no name and no email address of the state or of a request in a result', () => {
    const people = api.requests
      .flatMap((request) => [request.body, ...(request.body?.create ?? [])])
      .concat(sampleState(T0).guestLinks)
      .flatMap((item) => [item?.emailAddress, item?.displayName])
      .filter((value): value is string => typeof value === 'string' && value.length >= 3);
    assert.ok(people.length > 40);
    const text = texts.join('\n').toLowerCase();
    for (const value of new Set(people)) assert.ok(!text.includes(value.toLowerCase()), value);
  });

  it('names the option in the start line of its log', () => {
    assert.equal(
      stderr.split('\n')[0],
      `alfaview-mcp: version ${SERVER_VERSION} ready for https://apis.alfaview.com with 17 tools at level standard, time zone Europe/Berlin, personal data omit`,
    );
  });
});
