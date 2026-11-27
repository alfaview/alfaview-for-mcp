// find_room_participants through an MCP SDK client.
//
// The participant fixture holds, at NOW (09:00 UTC, 11:00 in Berlin):
// - Jane, the guest of the guest link fixture, in her own waiting room since 08:52:40;
// - a group link visitor in another waiting room since 08:57;
// - the advisor Anna, a company user, in the main room since 08:30;
// - Max, a guest without a guest link of this room, on break in a breakout room since 08:40.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PARTICIPANTS_DENIED_MESSAGE, VISIT_WINDOW_MS } from '../../src/domain/participants.ts';
import { PARTICIPANT_TOOLS } from '../../src/tools/participants.ts';
import { READ_ANNOTATIONS } from '../../src/tools/tool.ts';
import { testClock } from '../helpers/clock.ts';
import {
  flush,
  loginRequest,
  untilRequests,
  type ExpectedRequest,
  type FakeAnswer,
} from '../helpers/fakeFetch.ts';
import { fixture } from '../helpers/fixtures.ts';
import { callTool, toolHarness, type HarnessOptions } from '../helpers/mcpClient.ts';

const ROOM_ID = '0b7c5d2e-91a4-5f3b-8e27-0f4a6c9d1e22';
const LINK_ID = '3f2a9c1e-7b4d-5e21-a3c4-14b7e9d0f6a2';
const JANE = '3f2a9c1e-7b4d-5e21-a3c4-18b7e9d0f6a2';
const VISITOR = '9e8d7c6b-5a49-5382-a716-18f5e4d3c2b1';
const ANNA = '6c1d9e4f-2a7b-5c3d-9e8f-0a1b2c3d4e5f';
const MAX = '4a5b6c7d-8e9f-5a0b-9c1d-18e2f3a4b5c6';
const BREAKOUT = '2d4f6a8c-1e3b-5d7f-9a0c-2e4f6a8c0e11';
const NOW = '2026-10-07T09:00:00Z';

type Group = { subRoomId: string; participants: Record<string, unknown>[] };

const groups = () => fixture<Group[]>('participants/participants.json');

/** The groups of the fixture that hold one of `userIds`. */
function groupsOf(...userIds: string[]): Group[] {
  return groups().filter((group) => userIds.includes(group.participants[0]!.userId as string));
}

function participantsRequest(respond: FakeAnswer): ExpectedRequest {
  return { method: 'GET', path: `/v2/rooms/${ROOM_ID}/participants`, respond };
}

function attendanceRequest(respond: FakeAnswer, now = NOW): ExpectedRequest {
  return {
    method: 'GET',
    path: `/v2/rooms/${ROOM_ID}/attendances`,
    query: {
      from: new Date(Date.parse(now) - VISIT_WINDOW_MS).toISOString(),
      to: new Date(Date.parse(now)).toISOString(),
    },
    respond,
  };
}

const linksRequest: ExpectedRequest = {
  method: 'GET',
  path: `/v2/rooms/${ROOM_ID}/guest-links`,
  query: { limit: '500' },
  respond: { status: 200, body: { data: [fixture('guestLinks/guest-link.json')] } },
};

/** The four requests of a call on the whole fixture. */
const everyRequest = (): ExpectedRequest[] => [
  loginRequest(),
  participantsRequest({ status: 200, body: groups() }),
  attendanceRequest({ status: 200, body: fixture('participants/attendances.json') }),
  linksRequest,
];

function harness(expected: readonly ExpectedRequest[], options: HarnessOptions = {}) {
  return toolHarness(PARTICIPANT_TOOLS, expected, { now: testClock(NOW).now, ...options });
}

const PEOPLE = {
  jane: {
    userId: JANE,
    displayName: 'Jane Doe',
    participantType: 'guest_link',
    emailAddress: 'jane.doe@example.com',
    guestLinkId: LINK_ID,
    guestLinkOrigin: 'Zapier',
    inWaitingRoom: true,
    connectedAt: '2026-10-07T10:52:40+02:00',
    subroomId: null,
    onBreak: false,
    isSpectator: false,
    isDialIn: false,
  },
  visitor: {
    userId: VISITOR,
    displayName: 'Visitor',
    participantType: 'guest',
    emailAddress: null,
    guestLinkId: null,
    guestLinkOrigin: null,
    inWaitingRoom: true,
    connectedAt: '2026-10-07T10:57:00+02:00',
    subroomId: null,
    onBreak: false,
    isSpectator: false,
    isDialIn: false,
  },
  anna: {
    userId: ANNA,
    displayName: 'Anna Example',
    participantType: 'user',
    emailAddress: null,
    guestLinkId: null,
    guestLinkOrigin: null,
    inWaitingRoom: false,
    connectedAt: '2026-10-07T10:30:00+02:00',
    subroomId: null,
    onBreak: false,
    isSpectator: false,
    isDialIn: false,
  },
  max: {
    userId: MAX,
    displayName: 'Max Mustermann',
    participantType: 'guest',
    emailAddress: null,
    guestLinkId: null,
    guestLinkOrigin: null,
    inWaitingRoom: false,
    connectedAt: '2026-10-07T10:40:00+02:00',
    subroomId: BREAKOUT,
    onBreak: true,
    isSpectator: false,
    isDialIn: false,
  },
};

describe('find_room_participants', () => {
  it('is a read tool', async () => {
    const tools = await harness([]);
    const { tools: listed } = await tools.client.listTools();
    await tools.done();

    assert.deepEqual(
      listed.map((tool) => [tool.name, tool.annotations]),
      [['find_room_participants', READ_ANNOTATIONS]],
    );
  });

  it('lists everyone in the room and its waiting room, the longest wait first', async () => {
    const tools = await harness(everyRequest());
    const result = await tools.call('find_room_participants', { roomId: ROOM_ID });
    await tools.done();

    assert.equal(
      result.summary,
      '1 company user in the room, 2 people waiting. Showing 1 to 4 of 4.',
    );
    assert.deepEqual(result.data, {
      roomId: ROOM_ID,
      roomUserCount: 1,
      waitingCount: 2,
      totalMatches: 4,
      offset: 0,
      nextOffset: null,
      participants: [PEOPLE.jane, PEOPLE.visitor, PEOPLE.anna, PEOPLE.max],
      warnings: [],
    });
    assert.deepEqual(tools.logLines, [
      'alfaview-mcp: logged in\n',
      'alfaview-mcp: tool find_room_participants: ok, 4 requests, 0 ms\n',
    ]);
  });

  it('lists only the people who wait, and counts over everyone', async () => {
    const tools = await harness(everyRequest());
    const result = await tools.call('find_room_participants', {
      roomId: ROOM_ID,
      location: 'waiting_room',
    });
    await tools.done();

    assert.equal(
      result.summary,
      '1 company user in the room, 2 people waiting. Showing 1 to 2 of 2.',
    );
    assert.deepEqual(result.data.participants, [PEOPLE.jane, PEOPLE.visitor]);
    assert.deepEqual([result.data.roomUserCount, result.data.waitingCount], [1, 2]);
  });

  it('lists only the people in the room', async () => {
    const tools = await harness(everyRequest());
    const result = await tools.call('find_room_participants', { roomId: ROOM_ID, location: 'room' });
    await tools.done();

    assert.equal(result.data.totalMatches, 2);
    assert.deepEqual(result.data.participants, [PEOPLE.anna, PEOPLE.max]);
  });

  it('reads no guest links when no guest is connected', async () => {
    const tools = await harness([
      loginRequest(),
      participantsRequest({ status: 200, body: groupsOf(ANNA) }),
      attendanceRequest({ status: 200, body: fixture('participants/attendances.json') }),
    ]);
    const result = await tools.call('find_room_participants', { roomId: ROOM_ID });
    await tools.done();

    assert.equal(result.summary, '1 company user in the room, 0 people waiting. Showing 1 to 1 of 1.');
    assert.deepEqual(result.data.participants, [PEOPLE.anna]);
  });

  it('stops after the participant list when nobody is at the chosen place', async () => {
    const tools = await harness([
      loginRequest(),
      participantsRequest({ status: 200, body: groupsOf(ANNA) }),
      participantsRequest({ status: 200, body: null }),
    ]);
    const waiting = await tools.call('find_room_participants', {
      roomId: ROOM_ID,
      location: 'waiting_room',
    });
    const empty = await tools.call('find_room_participants', { roomId: ROOM_ID });
    await tools.done();

    assert.equal(waiting.summary, '1 company user in the room, 0 people waiting.');
    assert.deepEqual(waiting.data, {
      roomId: ROOM_ID,
      roomUserCount: 1,
      waitingCount: 0,
      totalMatches: 0,
      offset: 0,
      nextOffset: null,
      participants: [],
      warnings: [],
    });
    assert.equal(empty.summary, '0 company users in the room, 0 people waiting.');
  });

  it('pages with limit and offset', async () => {
    const tools = await harness([
      ...everyRequest(),
      ...everyRequest().slice(1),
      ...everyRequest().slice(1),
    ]);
    const first = await tools.call('find_room_participants', { roomId: ROOM_ID, limit: 3 });
    const second = await tools.call('find_room_participants', {
      roomId: ROOM_ID,
      limit: 3,
      offset: first.data.nextOffset,
    });
    const beyond = await tools.call('find_room_participants', { roomId: ROOM_ID, offset: 9 });
    await tools.done();

    assert.equal(
      first.summary,
      '1 company user in the room, 2 people waiting. Showing 1 to 3 of 4. Call again with offset 3 for the next ones.',
    );
    assert.equal(first.data.nextOffset, 3);
    assert.deepEqual(second.data.participants, [PEOPLE.max]);
    assert.equal(second.data.nextOffset, null);
    assert.equal(second.summary, '1 company user in the room, 2 people waiting. Showing 4 to 4 of 4.');
    assert.equal(beyond.summary, '1 company user in the room, 2 people waiting. Nothing at offset 9.');
    assert.deepEqual(beyond.data.participants, []);
  });

  it('warns and logs when alfaview does not return the connection times', async () => {
    const tools = await harness([
      loginRequest(),
      participantsRequest({ status: 200, body: groups() }),
      attendanceRequest({ status: 403 }),
      linksRequest,
    ]);
    const result = await tools.call('find_room_participants', { roomId: ROOM_ID });
    await tools.done();

    const warning =
      'alfaview did not return the connection times (Forbidden), so connectedAt is null and the order is not by waiting time.';
    assert.equal(
      result.summary,
      `1 company user in the room, 2 people waiting. Showing 1 to 4 of 4. ${warning}`,
    );
    assert.deepEqual(result.data.warnings, [warning]);
    assert.deepEqual(
      result.data.participants.map((person: { userId: string; connectedAt: unknown }) => [
        person.userId,
        person.connectedAt,
      ]),
      [
        [VISITOR, null],
        [JANE, null],
        [ANNA, null],
        [MAX, null],
      ],
    );
    assert.deepEqual(tools.logLines, [
      'alfaview-mcp: logged in\n',
      'alfaview-mcp: tool find_room_participants: attendance not read (Forbidden)\n',
      'alfaview-mcp: tool find_room_participants: ok, 4 requests, 0 ms\n',
    ]);
  });

  it('ends the call when it is canceled during the attendance read', async () => {
    const tools = await harness([
      loginRequest(),
      participantsRequest({ status: 200, body: groups() }),
      attendanceRequest({ hang: true }),
    ]);
    const controller = new AbortController();
    const call = callTool(
      tools.client,
      'find_room_participants',
      { roomId: ROOM_ID },
      { signal: controller.signal },
    );
    await untilRequests(tools.fake, 3);
    controller.abort();
    await assert.rejects(call);
    for (let round = 0; round < 100 && tools.logLines.length < 2; round += 1) await flush();
    await tools.done();

    assert.equal(
      tools.logLines[1],
      'alfaview-mcp: tool find_room_participants: Canceled, 3 requests, 0 ms\n',
    );
  });

  it('explains a missing room permission Join, and a room that alfaview cannot find', async () => {
    const tools = await harness([
      loginRequest(),
      participantsRequest({ status: 403, body: fixture('core/problem-403.json') }),
      participantsRequest({ status: 404, body: fixture('core/problem-404.json') }),
    ]);
    const denied = await tools.call('find_room_participants', { roomId: ROOM_ID });
    const missing = await tools.call('find_room_participants', { roomId: ROOM_ID });
    await tools.done();

    assert.deepEqual([denied.isError, denied.summary], [true, PARTICIPANTS_DENIED_MESSAGE]);
    assert.deepEqual(
      [missing.isError, missing.summary],
      [true, "alfaview could not find the room. It was deleted, or the API key's user cannot see it."],
    );
  });

  it('gives a winter time with its own offset', async () => {
    const now = '2026-12-01T09:00:00Z';
    const attendances = [
      { userId: ANNA, attendances: [{ displayName: 'Anna Example', from: '2026-12-01T08:30:00Z', to: '0001-01-01T00:00:00Z' }] },
    ];
    const tools = await harness(
      [
        loginRequest(),
        participantsRequest({ status: 200, body: groupsOf(ANNA) }),
        attendanceRequest({ status: 200, body: attendances }, now),
      ],
      { now: testClock(now).now },
    );
    const result = await tools.call('find_room_participants', { roomId: ROOM_ID });
    await tools.done();

    assert.equal(result.data.participants[0].connectedAt, '2026-12-01T09:30:00+01:00');
  });

  it('sends an upper-case room ID in lower case and returns it so', async () => {
    const tools = await harness([
      loginRequest(),
      participantsRequest({ status: 200, body: null }),
    ]);
    const result = await tools.call('find_room_participants', { roomId: ROOM_ID.toUpperCase() });
    await tools.done();

    assert.equal(result.data.roomId, ROOM_ID);
  });

  it('refuses a room name, dot segments, an unknown location and a limit above 50 without a request', async () => {
    const tools = await harness([]);
    for (const roomId of ['Advisory Room', '.', '..', '0b7c5d2e-91a4-5f3b-0f4a6c9d1e22']) {
      const result = await tools.call('find_room_participants', { roomId });
      assert.equal(result.isError, true, roomId);
      assert.match(result.summary, /roomId takes an ID from find_rooms, or a meeting ID, not a name\./);
    }
    const location = await tools.call('find_room_participants', { roomId: ROOM_ID, location: 'lobby' });
    const limit = await tools.call('find_room_participants', { roomId: ROOM_ID, limit: 51 });
    await tools.done();

    assert.equal(location.isError, true);
    assert.equal(limit.isError, true);
  });
});
