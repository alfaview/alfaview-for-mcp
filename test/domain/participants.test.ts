// The participant fixture holds, at NOW:
// - Jane, the guest of the guest link fixture, in a waiting room of her own. Her visit started at
//   08:52:40 and continues after a reconnect at 08:54. She also visited the day before.
// - a visitor with a group link in another waiting room, since 08:57.
// - the advisor Anna, a company user, in the main room (nil UUID) since 08:30, with an empty name.
// - Max, a guest without a guest link of this room, on break in a breakout room since 08:40.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CallApi } from '../../src/alfaview/client.ts';
import {
  flattenParticipants,
  listParticipants,
  mapParticipant,
  participantOutputs,
  PARTICIPANTS_DENIED_MESSAGE,
  VISIT_WINDOW_MS,
  type RoomParticipant,
} from '../../src/domain/participants.ts';
import {
  loginRequest,
  testApi,
  toolErrorOf,
  untilRequests,
  type ExpectedRequest,
  type FakeAnswer,
} from '../helpers/fakeFetch.ts';
import { fixture } from '../helpers/fixtures.ts';
import { keepApiRequestProblems, testFileLine } from '../helpers/spec.ts';

const ROOM_ID = '0b7c5d2e-91a4-5f3b-8e27-0f4a6c9d1e22';
const LINK_ID = '3f2a9c1e-7b4d-5e21-a3c4-14b7e9d0f6a2';
const JANE = '3f2a9c1e-7b4d-5e21-a3c4-18b7e9d0f6a2';
const VISITOR = '9e8d7c6b-5a49-5382-a716-18f5e4d3c2b1';
const ANNA = '6c1d9e4f-2a7b-5c3d-9e8f-0a1b2c3d4e5f';
const MAX = '4a5b6c7d-8e9f-5a0b-9c1d-18e2f3a4b5c6';
const BREAKOUT = '2d4f6a8c-1e3b-5d7f-9a0c-2e4f6a8c0e11';
const NOW = Date.parse('2026-10-07T09:00:00.000Z');
const BERLIN = 'Europe/Berlin';

type Group = { subRoomId: string; participants: Record<string, unknown>[] };

const groups = () => fixture<Group[]>('participants/participants.json');

function attendanceRequest(respond: FakeAnswer): ExpectedRequest {
  return {
    method: 'GET',
    path: `/v2/rooms/${ROOM_ID}/attendances`,
    query: {
      from: new Date(NOW - VISIT_WINDOW_MS).toISOString(),
      to: new Date(NOW).toISOString(),
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

const flat = (data: unknown) => flattenParticipants(data) as RoomParticipant[];

describe('listParticipants', () => {
  const path = `/v2/rooms/${ROOM_ID}/participants`;

  it('reads the participants with the room ID in lowercase', async () => {
    const { api, fake } = testApi([loginRequest(), { method: 'GET', path, respond: { status: 200, body: groups() } }]);
    assert.equal((await listParticipants(api, ROOM_ID.toUpperCase())).length, 4);
    fake.assertDone();
  });

  it('explains a 403 with the missing room permission Join', async () => {
    const { api, fake } = testApi([loginRequest(), { method: 'GET', path, respond: { status: 403 } }]);
    const error = await toolErrorOf(listParticipants(api, ROOM_ID));
    assert.deepEqual([error.code, error.message, error.status], ['Forbidden', PARTICIPANTS_DENIED_MESSAGE, 403]);
    assert.equal(
      PARTICIPANTS_DENIED_MESSAGE,
      "alfaview did not list the people in this room. The API key's user needs the room permission Join in this room. Give it in alfaview.",
    );
    fake.assertDone();
  });

  it('fails with NotFound on 404 and with InvalidResponse for a body that is not a list', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'GET', path, respond: { status: 404 } },
      { method: 'GET', path, respond: { status: 200, body: { data: [] } } },
    ]);
    assert.equal(
      (await toolErrorOf(listParticipants(api, ROOM_ID))).message,
      "alfaview could not find the room. It was deleted, or the API key's user cannot see it.",
    );
    const invalid = await toolErrorOf(listParticipants(api, ROOM_ID));
    assert.deepEqual([invalid.code, invalid.message], [
      'InvalidResponse',
      'alfaview sent an unexpected participant response.',
    ]);
    fake.assertDone();
  });
});

describe('mapParticipant', () => {
  const person = (overrides: Partial<RoomParticipant>): RoomParticipant => ({
    userId: 'u1',
    subRoomId: null,
    waiting: false,
    ...overrides,
  });
  const details = { userId: 'u1', connectedAt: null, link: undefined, sessionName: null };

  it('gives null for flags that alfaview leaves out', () => {
    assert.deepEqual(mapParticipant(person({}), details), {
      userId: 'u1',
      displayName: null,
      participantType: 'user',
      emailAddress: null,
      guestLinkId: null,
      guestLinkOrigin: null,
      inWaitingRoom: null,
      connectedAt: null,
      subroomId: null,
      onBreak: null,
      isSpectator: null,
      isDialIn: null,
    });
  });

  it('gives subroomId null in the waiting room and the main room, and the ID of a breakout room', () => {
    const subroom = (overrides: Partial<RoomParticipant>) => mapParticipant(person(overrides), details).subroomId;
    assert.equal(subroom({ subRoomId: 'S1', inWaitingRoom: true }), null);
    assert.equal(subroom({ subRoomId: '00000000-0000-0000-0000-000000000000' }), null);
    assert.equal(subroom({ subRoomId: BREAKOUT, inWaitingRoom: false }), BREAKOUT);
  });

  it('takes the name of the link, then of the participant list, then of the latest session', () => {
    const link = { id: LINK_ID, displayName: 'Link Name', emailAddress: 'a@example.com', origin: 'MCP' };
    assert.equal(
      mapParticipant(person({ displayName: 'List Name' }), { ...details, link, sessionName: 'Session' }).displayName,
      'Link Name',
    );
    assert.equal(
      mapParticipant(person({ displayName: 'List Name' }), { ...details, sessionName: 'Session' }).displayName,
      'List Name',
    );
    assert.equal(
      mapParticipant(person({ displayName: '' }), { ...details, sessionName: 'Session' }).displayName,
      'Session',
    );
    assert.equal(
      mapParticipant(person({}), { ...details, link: { id: LINK_ID }, sessionName: 'Session' }).displayName,
      'Session',
    );
  });
});

describe('participantOutputs', () => {
  it('maps everyone, the longest wait first, with the link of the guest and times in the time zone', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      attendanceRequest({ status: 200, body: fixture('participants/attendances.json') }),
      linksRequest,
    ]);
    const result = await participantOutputs(api, ROOM_ID, flat(groups()), { now: NOW, timeZone: BERLIN });
    assert.equal(result.attendanceErrorCode, null);
    assert.deepEqual(result.participants, [
      {
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
      {
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
      {
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
      {
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
    ]);
    fake.assertDone();
  });

  it('writes the userId in lowercase', async () => {
    const people = flat([{ subRoomId: 'r', participants: [{ userId: ANNA.toUpperCase(), isGuest: false }] }]);
    const { api, fake } = testApi([loginRequest(), attendanceRequest({ status: 200, body: [] })]);
    const result = await participantOutputs(api, ROOM_ID, people, { now: NOW, timeZone: BERLIN });
    assert.equal(result.participants[0]?.userId, ANNA);
    fake.assertDone();
  });

  it('reads no guest links when only company users are connected', async () => {
    const people = flat(groups()).filter((person) => person.userId === ANNA);
    const { api, fake } = testApi([
      loginRequest(),
      attendanceRequest({ status: 200, body: fixture('participants/attendances.json') }),
    ]);
    const result = await participantOutputs(api, ROOM_ID, people, { now: NOW, timeZone: BERLIN });
    assert.deepEqual(result.participants.map((person) => person.connectedAt), ['2026-10-07T10:30:00+02:00']);
    fake.assertDone();
  });

  it('reads the guest links by the guest flag, not by the layout of the userId', async () => {
    // A company user whose userId has the layout of a guest causes no read.
    const companyUser = flat([{ subRoomId: 'r', participants: [{ userId: JANE, isGuest: false }] }]);
    const company = testApi([loginRequest(), attendanceRequest({ status: 200, body: [] })]);
    const read = await participantOutputs(company.api, ROOM_ID, companyUser, { now: NOW, timeZone: BERLIN });
    assert.deepEqual(read.participants.map((person) => [person.participantType, person.guestLinkId]), [['user', null]]);
    company.fake.assertDone();

    // A guest whose userId has another layout (byte 10 is 0x2f) causes the read and gets the link
    // whose userId is the guest's.
    const otherLayout = '5d6e7f80-91a2-5b3c-8d4e-2f5a6b7c8d9e';
    const guest = flat([{ subRoomId: 'r', participants: [{ userId: otherLayout, isGuest: true }] }]);
    const link = { ...fixture<Record<string, unknown>>('guestLinks/guest-link.json'), userId: otherLayout.toUpperCase() };
    const guests = testApi([
      loginRequest(),
      attendanceRequest({ status: 200, body: [] }),
      { ...linksRequest, respond: { status: 200, body: { data: [link] } } },
    ]);
    const matched = await participantOutputs(guests.api, ROOM_ID, guest, { now: NOW, timeZone: BERLIN });
    assert.deepEqual(
      matched.participants.map((person) => [person.userId, person.participantType, person.guestLinkId]),
      [[otherLayout, 'guest_link', LINK_ID]],
    );
    guests.fake.assertDone();
  });

  it('gives connectedAt null for a visit that alfaview has not recorded yet', async () => {
    const people = flat(groups()).filter((person) => person.userId === ANNA);
    const { api, fake } = testApi([loginRequest(), attendanceRequest({ status: 200, body: [] })]);
    const result = await participantOutputs(api, ROOM_ID, people, { now: NOW, timeZone: BERLIN });
    assert.equal(result.participants[0]?.connectedAt, null);
    fake.assertDone();
  });

  it('gives connectedAt null for everyone and the error code when the attendance read fails', async () => {
    const { api, fake } = testApi([loginRequest(), attendanceRequest({ status: 403 }), linksRequest]);
    const result = await participantOutputs(api, ROOM_ID, flat(groups()), { now: NOW, timeZone: BERLIN });
    assert.equal(result.attendanceErrorCode, 'Forbidden');
    assert.ok(result.participants.every((person) => person.connectedAt === null));
    assert.deepEqual(
      result.participants.map((person) => person.userId),
      [VISITOR, JANE, ANNA, MAX],
    );
    assert.equal(result.participants[1]?.guestLinkId, LINK_ID);
    fake.assertDone();
  });

  it('ends the call on a cancel during the attendance read', async () => {
    // Only company users: no guest link read follows, so only the check of the attendance read
    // can end the call.
    const people = flat(groups()).filter((person) => person.userId === ANNA);
    const canceling = new AbortController();
    const { api, fake } = testApi([loginRequest(), attendanceRequest({ hang: true })], {
      signal: canceling.signal,
    });
    const result = participantOutputs(api, ROOM_ID, people, { now: NOW, timeZone: BERLIN });
    await untilRequests(fake, 2);
    canceling.abort();
    assert.equal((await toolErrorOf(result)).code, 'Canceled');
    fake.assertDone();
  });

  it('rethrows an error of the attendance read that is not a ToolError', async () => {
    const { api } = testApi([]);
    const site = testFileLine();
    const failing: CallApi = {
      ...api,
      request: (request) => {
        keepApiRequestProblems(request, site);
        return Promise.reject(new TypeError('bug'));
      },
    };
    await assert.rejects(
      participantOutputs(failing, ROOM_ID, flat(groups()), { now: NOW, timeZone: BERLIN }),
      TypeError,
    );
  });

  it('keeps the error of the guest link list', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      attendanceRequest({ status: 200, body: [] }),
      { ...linksRequest, respond: { status: 503 } },
    ]);
    const error = await toolErrorOf(
      participantOutputs(api, ROOM_ID, flat(groups()), { now: NOW, timeZone: BERLIN }),
    );
    assert.equal(error.code, 'ServerError');
    fake.assertDone();
  });

  it('makes no request for nobody', async () => {
    const { api, fake } = testApi([]);
    assert.deepEqual(await participantOutputs(api, ROOM_ID, [], { now: NOW, timeZone: BERLIN }), {
      participants: [],
      attendanceErrorCode: null,
    });
    fake.assertDone();
  });
});
