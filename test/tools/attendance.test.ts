// get_room_attendance and get_guest_link_attendance through an MCP SDK client.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ATTENDANCE_DENIED_MESSAGE,
  NO_ORIGIN_WINDOW_MESSAGE,
  ORIGIN_WINDOW_TOO_LONG_MESSAGE,
  UNMATCHABLE_GUEST_LINK_MESSAGE,
} from '../../src/domain/attendance.ts';
import { ATTENDANCE_TOOLS, NO_VALIDITY_MESSAGE } from '../../src/tools/attendance.ts';
import { READ_ANNOTATIONS } from '../../src/tools/tool.ts';
import { testClock } from '../helpers/clock.ts';
import {
  nonexistentLocalTime,
  outOfRangeDateTime,
  unrecognizedDateTime,
} from '../helpers/dateTimeMessages.ts';
import { loginRequest, type ExpectedRequest, type FakeAnswer } from '../helpers/fakeFetch.ts';
import { fixture } from '../helpers/fixtures.ts';
import { toolHarness, type HarnessOptions } from '../helpers/mcpClient.ts';

const ROOM_ID = '0b7c5d2e-91a4-5f3b-8e27-0f4a6c9d1e22';
const ADVISOR = '6c1d9e4f-2a7b-5c3d-9e8f-0a1b2c3d4e5f';
const OPEN = '0001-01-01T00:00:00Z';
const ROOM_NOT_FOUND =
  "alfaview could not find the room. It was deleted, or the API key's user cannot see it.";

/** Guest link ID number `n`: version 5, IETF variant, byte 10 = 0x14. */
function linkIdFor(n: number): string {
  return `0b000000-0000-5000-8000-14${String(n).padStart(10, '0')}`;
}

/** The userId that alfaview returns with the link `linkIdFor(n)` for its guest: byte 10 = 0x18. */
function userIdFor(n: number): string {
  return `0b000000-0000-5000-8000-18${String(n).padStart(10, '0')}`;
}

function harness(expected: readonly ExpectedRequest[], options: HarnessOptions = {}) {
  return toolHarness(ATTENDANCE_TOOLS, expected, options);
}

function session(from: string, to: string, displayName = 'Guest') {
  return { displayName, from, to };
}

// get_room_attendance

/**
 * A webinar room after the webinar of 2026-10-07, 18:30 to 21:30 in Berlin (16:30 to 19:30 UTC).
 * Jane registered twice, Max did not come, the walk-in has no email address, one link has another
 * origin, one link is for a later slot, one link cannot be matched, one has no end. The advisor
 * Anna is a company user.
 */
const WEBINAR_NOW = '2026-10-07T22:00:00Z';

function webinarLink(n: number, fields: Record<string, unknown> = {}) {
  return {
    id: linkIdFor(n),
    userId: userIdFor(n),
    roomId: ROOM_ID,
    origin: 'Webinar',
    validFrom: '2026-10-07T16:30:00Z',
    validUntil: '2026-10-07T19:30:00Z',
    ...fields,
  };
}

const webinarLinks = () => [
  webinarLink(2, { emailAddress: 'Jane@Example.com ' }),
  webinarLink(1, { emailAddress: 'jane@example.com', displayName: 'Jane Doe' }),
  webinarLink(3, { emailAddress: 'max@example.com', displayName: 'Max' }),
  webinarLink(4, { displayName: 'Walk-in' }),
  webinarLink(5, { emailAddress: 'other@example.com', origin: 'Other' }),
  webinarLink(6, {
    emailAddress: 'late@example.com',
    displayName: 'Late',
    validFrom: '2026-10-07T19:00:00Z',
    validUntil: '2026-10-07T21:00:00Z',
  }),
  webinarLink(7, { emailAddress: 'plain@example.com', userId: '' }),
  webinarLink(8, { emailAddress: 'open@example.com', validUntil: OPEN }),
];

const webinarEntries = () => [
  { userId: userIdFor(1), attendances: [session('2026-10-07T17:00:00Z', '2026-10-07T17:30:00Z', 'Jane D')] },
  { userId: userIdFor(2), attendances: [session('2026-10-07T17:20:00Z', '2026-10-07T17:50:00Z')] },
  { userId: userIdFor(4), attendances: [session('2026-10-07T18:00:00Z', '2026-10-07T18:05:00Z')] },
  { userId: userIdFor(6), attendances: [session('2026-10-07T19:10:00Z', '2026-10-07T19:40:00Z', 'Late')] },
  { userId: ADVISOR, attendances: [session('2026-10-07T16:50:00Z', OPEN, 'Anna Example')] },
  { userId: userIdFor(5), attendances: [session('2026-10-07T17:00:00Z', '2026-10-07T17:10:00Z', 'Other')] },
  { userId: '00000000-0000-0000-0000-000000000000', attendances: [session('2026-10-07T17:00:00Z', '2026-10-07T17:05:00Z')] },
];

function linksPage(links: unknown[], respond?: FakeAnswer): ExpectedRequest {
  return {
    method: 'GET',
    path: `/v2/rooms/${ROOM_ID}/guest-links`,
    query: { limit: '500' },
    respond: respond ?? { status: 200, body: { data: links } },
  };
}

function attendanceRequest(from: string, to: string, respond: FakeAnswer): ExpectedRequest {
  return {
    method: 'GET',
    path: `/v2/rooms/${ROOM_ID}/attendances`,
    query: { from, to },
    respond,
  };
}

/** The requests of a call with the window 18:00 to 22:00 in Berlin. */
function webinarRequests(
  links: unknown[] = webinarLinks(),
  entries: unknown = webinarEntries(),
): ExpectedRequest[] {
  return [
    loginRequest(),
    linksPage(links),
    attendanceRequest('2026-10-07T16:00:00.000Z', '2026-10-07T20:00:00.000Z', {
      status: 200,
      body: entries,
    }),
  ];
}

const EVENING = { roomId: ROOM_ID, from: '2026-10-07T18:00', to: '2026-10-07T22:00' };

function webinarHarness(expected: readonly ExpectedRequest[], options: HarnessOptions = {}) {
  return harness(expected, { now: testClock(WEBINAR_NOW).now, ...options });
}

const WALK_IN = {
  emailAddress: null,
  displayName: 'Walk-in',
  guestLinkIds: [linkIdFor(4)],
  origin: 'Webinar',
  status: 'no_show',
  totalMinutes: 5,
  firstJoinedAt: '2026-10-07T20:00:00+02:00',
  lastLeftAt: '2026-10-07T20:05:00+02:00',
};

const JANE = {
  emailAddress: 'jane@example.com',
  displayName: 'Jane Doe',
  guestLinkIds: [linkIdFor(1), linkIdFor(2)],
  origin: 'Webinar',
  status: 'attended',
  totalMinutes: 50,
  firstJoinedAt: '2026-10-07T19:00:00+02:00',
  lastLeftAt: '2026-10-07T19:50:00+02:00',
};

const MAX = {
  emailAddress: 'max@example.com',
  displayName: 'Max',
  guestLinkIds: [linkIdFor(3)],
  origin: 'Webinar',
  status: 'no_show',
  totalMinutes: 0,
  firstJoinedAt: null,
  lastLeftAt: null,
};

describe('the attendance tools', () => {
  it('are read tools, in their fixed order', async () => {
    const tools = await harness([]);
    const { tools: listed } = await tools.client.listTools();
    await tools.done();

    assert.deepEqual(
      listed.map((tool) => [tool.name, tool.annotations]),
      [
        ['get_room_attendance', READ_ANNOTATIONS],
        ['get_guest_link_attendance', READ_ANNOTATIONS],
      ],
    );
  });
});

describe('get_room_attendance', () => {
  it('reports the invited people of an origin, the email lists and the other attendees', async () => {
    const tools = await webinarHarness(webinarRequests());
    const result = await tools.call('get_room_attendance', {
      ...EVENING,
      origin: 'Webinar',
      minimumMinutes: 10,
      includeOtherAttendees: true,
    });
    await tools.done();

    assert.equal(
      result.summary,
      '1 of 3 invited people attended, 2 did not, between 2026-10-07 18:00 Europe/Berlin and 2026-10-07 22:00 Europe/Berlin. 3 other people attended. Showing invited people 1 to 3.',
    );
    assert.deepEqual(result.data, {
      roomId: ROOM_ID,
      windowFrom: '2026-10-07T18:00:00+02:00',
      windowTo: '2026-10-07T22:00:00+02:00',
      origin: 'Webinar',
      minimumMinutes: 10,
      invitedCount: 3,
      attendedCount: 1,
      noShowCount: 2,
      otherAttendeeCount: 3,
      attendedEmails: ['jane@example.com'],
      noShowEmails: ['max@example.com'],
      offset: 0,
      nextOffset: null,
      invitees: [WALK_IN, JANE, MAX],
      otherAttendees: [
        {
          userId: ADVISOR,
          displayName: 'Anna Example',
          emailAddress: null,
          guestLinkId: null,
          totalMinutes: 190,
          sessionCount: 1,
          firstJoinedAt: '2026-10-07T18:50:00+02:00',
          lastLeftAt: null,
          stillConnected: true,
        },
        {
          userId: userIdFor(5),
          displayName: 'Other',
          emailAddress: 'other@example.com',
          guestLinkId: linkIdFor(5),
          totalMinutes: 10,
          sessionCount: 1,
          firstJoinedAt: '2026-10-07T19:00:00+02:00',
          lastLeftAt: '2026-10-07T19:10:00+02:00',
          stillConnected: false,
        },
        {
          userId: userIdFor(6),
          displayName: 'Late',
          emailAddress: 'late@example.com',
          guestLinkId: linkIdFor(6),
          totalMinutes: 30,
          sessionCount: 1,
          firstJoinedAt: '2026-10-07T21:10:00+02:00',
          lastLeftAt: '2026-10-07T21:40:00+02:00',
          stillConnected: false,
        },
      ],
      warnings: [],
    });
  });

  it('without origin, counts the links of every origin and every connection at the default minimum, and lists no other attendees', async () => {
    const tools = await webinarHarness(webinarRequests());
    const result = await tools.call('get_room_attendance', EVENING);
    await tools.done();

    assert.equal(
      result.summary,
      '3 of 4 invited people attended, 1 did not, between 2026-10-07 18:00 Europe/Berlin and 2026-10-07 22:00 Europe/Berlin. 2 other people attended. Showing invited people 1 to 4.',
    );
    assert.deepEqual(
      [result.data.origin, result.data.minimumMinutes, result.data.otherAttendeeCount],
      [null, 0, 2],
    );
    assert.deepEqual(result.data.attendedEmails, ['jane@example.com', 'other@example.com']);
    assert.deepEqual(result.data.noShowEmails, ['max@example.com']);
    assert.deepEqual(
      result.data.invitees.map((person: { emailAddress: string | null; status: string }) => [
        person.emailAddress,
        person.status,
      ]),
      [
        [null, 'attended'],
        ['jane@example.com', 'attended'],
        ['max@example.com', 'no_show'],
        ['other@example.com', 'attended'],
      ],
    );
    assert.deepEqual(result.data.otherAttendees, []);
  });

  it('lists only the people of a status, and keeps the counts and email lists of everyone', async () => {
    const input = { ...EVENING, origin: 'Webinar', minimumMinutes: 10 };
    const tools = await webinarHarness([...webinarRequests(), ...webinarRequests().slice(1)]);
    const noShows = await tools.call('get_room_attendance', { ...input, status: 'no_show' });
    const attended = await tools.call('get_room_attendance', { ...input, status: 'attended' });
    await tools.done();

    assert.deepEqual(noShows.data.invitees, [WALK_IN, MAX]);
    assert.match(noShows.summary, /\. Showing invited people 1 to 2\.$/);
    assert.deepEqual(attended.data.invitees, [JANE]);
    for (const result of [noShows, attended]) {
      assert.deepEqual(
        [result.data.invitedCount, result.data.attendedCount, result.data.noShowCount],
        [3, 1, 2],
      );
      assert.deepEqual(result.data.attendedEmails, ['jane@example.com']);
      assert.deepEqual(result.data.noShowEmails, ['max@example.com']);
    }
  });

  it('pages the invited people with limit and offset', async () => {
    const input = { ...EVENING, origin: 'Webinar', limit: 2 };
    const tools = await webinarHarness([...webinarRequests(), ...webinarRequests().slice(1)]);
    const first = await tools.call('get_room_attendance', input);
    const second = await tools.call('get_room_attendance', { ...input, offset: first.data.nextOffset });
    await tools.done();

    assert.match(
      first.summary,
      /\. Showing invited people 1 to 2\. Call again with offset 2 for the next ones\.$/,
    );
    assert.deepEqual([first.data.offset, first.data.nextOffset], [0, 2]);
    assert.deepEqual(second.data.invitees.map((person: { displayName: string }) => person.displayName), ['Max']);
    assert.deepEqual([second.data.offset, second.data.nextOffset], [2, null]);
  });

  it('uses the singular for one invited and one other person', async () => {
    const tools = await webinarHarness(
      webinarRequests([webinarLink(1, { emailAddress: 'jane@example.com' })], webinarEntries().slice(0, 1).concat(webinarEntries()[4]!)),
    );
    const result = await tools.call('get_room_attendance', EVENING);
    await tools.done();

    assert.equal(
      result.summary,
      '1 of 1 invited person attended, 0 did not, between 2026-10-07 18:00 Europe/Berlin and 2026-10-07 22:00 Europe/Berlin. 1 other person attended. Showing invited people 1 to 1.',
    );
  });

  it('takes the window from the validity of the links with the origin', async () => {
    const tools = await webinarHarness([
      loginRequest(),
      linksPage(webinarLinks()),
      attendanceRequest('2026-10-07T16:30:00.000Z', '2026-10-07T21:00:00.000Z', {
        status: 200,
        body: webinarEntries(),
      }),
    ]);
    const result = await tools.call('get_room_attendance', { roomId: ROOM_ID, origin: 'Webinar' });
    await tools.done();

    assert.deepEqual(
      [result.data.windowFrom, result.data.windowTo],
      ['2026-10-07T18:30:00+02:00', '2026-10-07T23:00:00+02:00'],
    );
    assert.deepEqual(
      result.data.invitees.map((person: { emailAddress: string | null }) => person.emailAddress),
      [null, 'jane@example.com', 'late@example.com', 'max@example.com'],
    );
    assert.deepEqual(result.data.attendedEmails, ['jane@example.com', 'late@example.com']);
  });

  it('asks for from and to when no link has the origin and a validity, or the links span more than 26 hours', async () => {
    const spread = [
      webinarLink(1),
      webinarLink(2, { validFrom: '2026-10-08T16:30:00Z', validUntil: '2026-10-08T19:30:00Z' }),
    ];
    const tools = await webinarHarness([
      loginRequest(),
      linksPage(webinarLinks()),
      linksPage(spread),
    ]);
    const none = await tools.call('get_room_attendance', { roomId: ROOM_ID, origin: 'Webinar 2026-10-08' });
    const long = await tools.call('get_room_attendance', { roomId: ROOM_ID, origin: 'Webinar' });
    await tools.done();

    assert.deepEqual([none.isError, none.summary], [true, NO_ORIGIN_WINDOW_MESSAGE]);
    assert.deepEqual([long.isError, long.summary], [true, ORIGIN_WINDOW_TOO_LONG_MESSAGE]);
    assert.equal(
      NO_ORIGIN_WINDOW_MESSAGE,
      'No guest link of this room has this origin and a validity period. Give from and to.',
    );
    assert.equal(
      ORIGIN_WINDOW_TOO_LONG_MESSAGE,
      'The guest links with this origin span more than 26 hours. Give from and to.',
    );
  });

  it('refuses the window of an origin whose links started more than 39 days ago', async () => {
    const old = [webinarLink(1, { validFrom: '2026-08-20T16:30:00Z', validUntil: '2026-08-20T19:30:00Z' })];
    const tools = await webinarHarness([loginRequest(), linksPage(old)]);
    const result = await tools.call('get_room_attendance', { roomId: ROOM_ID, origin: 'Webinar' });
    await tools.done();

    assert.deepEqual(
      [result.isError, result.summary],
      [
        true,
        'from is more than 39 days ago. alfaview removes the user IDs and names from attendance after 40 days.',
      ],
    );
  });

  it('warns when no link lies inside the window but some overlap it', async () => {
    const tools = await webinarHarness([
      loginRequest(),
      linksPage(webinarLinks()),
      attendanceRequest('2026-10-07T17:00:00.000Z', '2026-10-07T18:00:00.000Z', { status: 200, body: [] }),
      linksPage([webinarLink(3)]),
      attendanceRequest('2026-10-07T17:00:00.000Z', '2026-10-07T18:00:00.000Z', { status: 200, body: null }),
    ]);
    const input = { roomId: ROOM_ID, origin: 'Webinar', from: '2026-10-07T19:00', to: '2026-10-07T20:00' };
    const several = await tools.call('get_room_attendance', input);
    const one = await tools.call('get_room_attendance', input);
    await tools.done();

    const warning =
      'No guest link lies inside the window, but 5 overlap it, for example one valid from 2026-10-07 18:30 Europe/Berlin until 2026-10-07 21:30 Europe/Berlin. Widen from and to, or leave them out and give origin.';
    assert.equal(
      several.summary,
      `0 of 0 invited people attended, 0 did not, between 2026-10-07 19:00 Europe/Berlin and 2026-10-07 20:00 Europe/Berlin. 0 other people attended. ${warning}`,
    );
    assert.deepEqual(several.data.warnings, [warning]);
    assert.deepEqual([several.data.attendedEmails, several.data.noShowEmails], [[], []]);
    assert.match(one.data.warnings[0], /^No guest link lies inside the window, but 1 overlaps it, /);
  });

  it('gives no warning of Leave out for a window without invited people, also with origin', async () => {
    const tools = await webinarHarness(
      [
        loginRequest(),
        linksPage(webinarLinks()),
        attendanceRequest('2026-10-07T17:00:00.000Z', '2026-10-07T18:00:00.000Z', { status: 200, body: [] }),
      ],
      { personalData: 'omit' },
    );
    const input = { roomId: ROOM_ID, origin: 'Webinar', from: '2026-10-07T19:00', to: '2026-10-07T20:00' };
    const result = await tools.call('get_room_attendance', input);
    await tools.done();

    // The empty email lists and the echoed origin hold no value of alfaview, so the result gets no
    // warning of Leave out, only its overlap warning.
    assert.deepEqual(
      [result.data.origin, result.data.attendedEmails, result.data.noShowEmails, result.data.invitees],
      [null, null, null, []],
    );
    assert.equal(result.data.warnings.length, 1);
    assert.match(result.data.warnings[0], /^No guest link lies inside the window, but 5 overlap it, /);
    assert.ok(result.summary.endsWith(result.data.warnings[0]));
  });

  it('gives no overlap warning when nothing overlaps either', async () => {
    const tools = await webinarHarness([
      loginRequest(),
      linksPage([]),
      attendanceRequest('2026-10-07T16:00:00.000Z', '2026-10-07T20:00:00.000Z', { status: 200, body: [] }),
    ]);
    const result = await tools.call('get_room_attendance', EVENING);
    await tools.done();

    assert.deepEqual(result.data.warnings, []);
    assert.equal(result.data.invitedCount, 0);
  });

  it('lists at most 20 other attendees, the first by time of joining, and warns', async () => {
    const users = Array.from({ length: 22 }, (_, index) => ({
      userId: `c0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      attendances: [
        session(`2026-10-07T17:${String(index).padStart(2, '0')}:00Z`, '2026-10-07T18:30:00Z', `User ${index}`),
      ],
    }));
    const tools = await webinarHarness([
      ...webinarRequests([], users),
      ...webinarRequests([], users).slice(1),
    ]);
    const listed = await tools.call('get_room_attendance', { ...EVENING, includeOtherAttendees: true });
    const counted = await tools.call('get_room_attendance', EVENING);
    await tools.done();

    const warning =
      '22 other people attended, and the list shows the first 20 by time of joining.';
    assert.equal(listed.data.otherAttendeeCount, 22);
    assert.equal(listed.data.otherAttendees.length, 20);
    assert.equal(listed.data.otherAttendees[0].displayName, 'User 0');
    assert.equal(listed.data.otherAttendees[19].displayName, 'User 19');
    assert.deepEqual(listed.data.warnings, [warning]);
    assert.ok(listed.summary.endsWith(` 22 other people attended. ${warning}`));
    assert.deepEqual([counted.data.otherAttendeeCount, counted.data.otherAttendees, counted.data.warnings], [22, [], []]);
  });

  it('leaves out the email lists above 400 invited people and warns', async () => {
    const links = Array.from({ length: 401 }, (_, index) =>
      webinarLink(index + 1, { emailAddress: `person${index + 1}@example.com` }),
    );
    const tools = await webinarHarness(webinarRequests(links, []));
    const result = await tools.call('get_room_attendance', { ...EVENING, origin: 'Webinar' });
    await tools.done();

    const warning =
      'More than 400 invited people, so attendedEmails and noShowEmails are left out. Read the invitees with status, offset and limit.';
    assert.deepEqual([result.data.attendedEmails, result.data.noShowEmails], [null, null]);
    assert.deepEqual(result.data.warnings, [warning]);
    assert.equal(result.data.invitees.length, 10);
    assert.equal(result.data.nextOffset, 10);
    assert.equal(
      result.summary,
      `0 of 401 invited people attended, 401 did not, between 2026-10-07 18:00 Europe/Berlin and 2026-10-07 22:00 Europe/Berlin. 0 other people attended. Showing invited people 1 to 10. Call again with offset 10 for the next ones. ${warning}`,
    );
  });

  it('gives a winter time with its own offset', async () => {
    const december = [
      webinarLink(1, {
        emailAddress: 'jane@example.com',
        validFrom: '2026-12-01T17:30:00Z',
        validUntil: '2026-12-01T19:30:00Z',
      }),
    ];
    const entries = [{ userId: userIdFor(1), attendances: [session('2026-12-01T18:00:00Z', '2026-12-01T18:45:00Z')] }];
    const tools = await harness(
      [
        loginRequest(),
        linksPage(december),
        attendanceRequest('2026-12-01T17:30:00.000Z', '2026-12-01T19:30:00.000Z', { status: 200, body: entries }),
      ],
      { now: testClock('2026-12-02T08:00:00Z').now },
    );
    const result = await tools.call('get_room_attendance', { roomId: ROOM_ID, origin: 'Webinar' });
    await tools.done();

    assert.deepEqual(
      [result.data.windowFrom, result.data.windowTo, result.data.invitees[0].firstJoinedAt],
      ['2026-12-01T18:30:00+01:00', '2026-12-01T20:30:00+01:00', '2026-12-01T19:00:00+01:00'],
    );
  });

  // get_room_attendance has no timezone parameter: each parameter costs tokens in every session,
  // and a model can give an offset.
  it("reads from and to and gives every time in the server's time zone", async () => {
    const tools = await webinarHarness(webinarRequests(), { timeZone: 'Australia/Sydney' });
    const result = await tools.call('get_room_attendance', {
      roomId: ROOM_ID,
      from: '08.10.2026 03:00',
      to: '2026-10-08 07:00',
      origin: 'Webinar',
    });
    await tools.done();

    assert.equal(
      result.summary,
      '2 of 3 invited people attended, 1 did not, between 2026-10-08 03:00 Australia/Sydney and 2026-10-08 07:00 Australia/Sydney. 3 other people attended. Showing invited people 1 to 3.',
    );
    const jane = result.data.invitees.find(
      (person: { emailAddress: string | null }) => person.emailAddress === 'jane@example.com',
    );
    assert.deepEqual(
      [result.data.windowFrom, result.data.windowTo, jane.firstJoinedAt],
      ['2026-10-08T03:00:00+11:00', '2026-10-08T07:00:00+11:00', '2026-10-08T04:00:00+11:00'],
    );
  });

  it('explains a missing room admin right, and a room that alfaview cannot find', async () => {
    const tools = await webinarHarness([
      loginRequest(),
      linksPage(webinarLinks()),
      attendanceRequest('2026-10-07T16:00:00.000Z', '2026-10-07T20:00:00.000Z', { status: 403 }),
      linksPage([], { status: 404, body: fixture('core/problem-404.json') }),
    ]);
    const denied = await tools.call('get_room_attendance', EVENING);
    const missing = await tools.call('get_room_attendance', EVENING);
    await tools.done();

    assert.deepEqual([denied.isError, denied.summary], [true, ATTENDANCE_DENIED_MESSAGE]);
    assert.deepEqual([missing.isError, missing.summary], [true, ROOM_NOT_FOUND]);
  });

  it('sends an upper-case room ID in lower case and returns it so', async () => {
    const tools = await webinarHarness(webinarRequests([], []));
    const result = await tools.call('get_room_attendance', { ...EVENING, roomId: ROOM_ID.toUpperCase() });
    await tools.done();

    assert.equal(result.data.roomId, ROOM_ID);
  });

  it('checks the window in order before any request', async () => {
    const tools = await webinarHarness([]);
    const cases: [Record<string, unknown>, string][] = [
      [{ from: 'tomorrow', to: '2026-10-07T22:00' }, unrecognizedDateTime('from')],
      [{ from: 'tomorrow' }, unrecognizedDateTime('from')],
      [{ from: '2026-10-07T18:00', origin: 'Webinar' }, 'Give from and to together, or neither.'],
      [{ to: '2026-10-07T18:00' }, 'Give from and to together, or neither.'],
      [{}, 'Give from and to, or origin.'],
      [{ from: '2026-10-07T20:00', to: '2026-10-07T18:00' }, 'to must be after from.'],
      [{ from: '2026-10-06T18:00', to: '2026-10-07T20:01' }, 'to must be at most 26 hours after from.'],
      [
        { from: '2026-08-01T18:00', to: '2026-08-01T20:00' },
        'from is more than 39 days ago. alfaview removes the user IDs and names from attendance after 40 days.',
      ],
      [
        { from: '2027-03-28T02:30', to: '2027-03-28T04:00' },
        nonexistentLocalTime('from', '2027-03-28T02:30', 'Europe/Berlin'),
      ],
    ];
    for (const [input, message] of cases) {
      const result = await tools.call('get_room_attendance', { roomId: ROOM_ID, ...input });
      assert.deepEqual([result.isError, result.summary], [true, message], JSON.stringify(input));
    }
    await tools.done();
  });

  it('refuses a bad room ID, an origin of only spaces and values out of range without a request', async () => {
    const tools = await webinarHarness([]);
    const inputs: Record<string, unknown>[] = [
      { ...EVENING, roomId: '..' },
      { ...EVENING, origin: '   ' },
      { ...EVENING, status: 'maybe' },
      { ...EVENING, minimumMinutes: 1441 },
      { ...EVENING, minimumMinutes: -1 },
      { ...EVENING, limit: 41 },
    ];
    for (const input of inputs) {
      const result = await tools.call('get_room_attendance', input);
      assert.equal(result.isError, true, JSON.stringify(input));
    }
    await tools.done();
  });
});

// get_guest_link_attendance

const LINK_ID = '3f2a9c1e-7b4d-5e21-a3c4-14b7e9d0f6a2';
const UNBOUNDED_ID = '7a1b2c3d-4e5f-5a6b-9c7d-14e2f3a4b5c6';
const AFTER = '2026-10-08T00:00:00Z';

function linkRequest(id: string, respond: FakeAnswer): ExpectedRequest {
  return { method: 'GET', path: `/v2/guest-links/${id}`, respond };
}

const janeLink = (fields: Record<string, unknown> = {}): FakeAnswer => ({
  status: 200,
  body: { ...fixture<Record<string, unknown>>('guestLinks/guest-link.json'), ...fields },
});

/** The attendance of the link's room for the link's validity, 08:45 to 10:15 UTC. */
function validityAttendance(respond: FakeAnswer = { status: 200, body: fixture('attendance/attendances.json') }) {
  return attendanceRequest('2026-10-07T08:45:00.000Z', '2026-10-07T10:15:00.000Z', respond);
}

function linkHarness(expected: readonly ExpectedRequest[], options: HarnessOptions = {}) {
  return harness(expected, { now: testClock(AFTER).now, ...options });
}

describe('get_guest_link_attendance', () => {
  it("reports the attendance of the link's guest in the link's validity", async () => {
    const tools = await linkHarness([loginRequest(), linkRequest(LINK_ID, janeLink()), validityAttendance()]);
    const result = await tools.call('get_guest_link_attendance', { guestLinkId: LINK_ID });
    await tools.done();

    assert.equal(result.summary, `The guest of guest link ${LINK_ID} attended for 41 minutes in 2 sessions.`);
    assert.deepEqual(result.data, {
      guestLinkId: LINK_ID,
      roomId: ROOM_ID,
      emailAddress: 'jane.doe@example.com',
      displayName: 'Jane Doe',
      windowFrom: '2026-10-07T10:45:00+02:00',
      windowTo: '2026-10-07T12:15:00+02:00',
      minimumMinutes: 0,
      attended: true,
      totalMinutes: 41,
      sessionCount: 2,
      firstJoinedAt: '2026-10-07T10:58:10+02:00',
      lastLeftAt: '2026-10-07T11:47:33+02:00',
      stillConnected: false,
      warnings: [],
    });
  });

  it('says that the guest did not attend below minimumMinutes', async () => {
    const tools = await linkHarness([loginRequest(), linkRequest(LINK_ID, janeLink()), validityAttendance()]);
    const result = await tools.call('get_guest_link_attendance', { guestLinkId: LINK_ID, minimumMinutes: 45 });
    await tools.done();

    assert.equal(
      result.summary,
      `The guest of guest link ${LINK_ID} did not attend between 2026-10-07 10:45 Europe/Berlin and 2026-10-07 12:15 Europe/Berlin.`,
    );
    assert.deepEqual([result.data.attended, result.data.totalMinutes, result.data.minimumMinutes], [false, 41, 45]);
  });

  it('uses from and to in local time instead of the validity', async () => {
    const tools = await linkHarness([
      loginRequest(),
      linkRequest(LINK_ID, janeLink()),
      attendanceRequest('2026-10-07T09:00:00.000Z', '2026-10-07T09:30:00.000Z', {
        status: 200,
        body: fixture('attendance/attendances.json'),
      }),
    ]);
    const result = await tools.call('get_guest_link_attendance', {
      guestLinkId: LINK_ID,
      from: '2026-10-07T11:00',
      to: '2026-10-07T11:30',
    });
    await tools.done();

    assert.deepEqual(
      [result.data.windowFrom, result.data.windowTo, result.data.totalMinutes],
      ['2026-10-07T11:00:00+02:00', '2026-10-07T11:30:00+02:00', 22],
    );
  });

  it('says that the guest is still connected, in the singular', async () => {
    const entries = [{ userId: '3f2a9c1e-7b4d-5e21-a3c4-18b7e9d0f6a2', attendances: [session('2026-10-07T09:00:00Z', OPEN)] }];
    const tools = await linkHarness(
      [loginRequest(), linkRequest(LINK_ID, janeLink()), validityAttendance({ status: 200, body: entries })],
      { now: testClock('2026-10-07T09:01:00Z').now },
    );
    const result = await tools.call('get_guest_link_attendance', { guestLinkId: LINK_ID });
    await tools.done();

    assert.equal(
      result.summary,
      `The guest of guest link ${LINK_ID} attended for 1 minute in 1 session. The guest is still connected.`,
    );
    assert.equal(result.data.stillConnected, true);
  });

  it('matches the guest by the userId of the link alone, also one of another layout', async () => {
    // Byte 10 of this userId is 0x2f, not 0x18. The link ID is a version 4 UUID.
    const userId = '5d6e7f80-91a2-5b3c-8d4e-2f5a6b7c8d9e';
    const linkId = '8d4e2f1a-6c3b-4a9e-b2d7-c75e1f0a3b94';
    const entries = [
      ...fixture<unknown[]>('attendance/attendances.json'),
      { userId, attendances: [session('2026-10-07T09:00:00Z', '2026-10-07T09:05:00Z', 'Jane Doe')] },
    ];
    const tools = await linkHarness([
      loginRequest(),
      linkRequest(linkId, janeLink({ id: linkId, userId: userId.toUpperCase() })),
      validityAttendance({ status: 200, body: entries }),
    ]);
    const result = await tools.call('get_guest_link_attendance', { guestLinkId: linkId });
    await tools.done();

    assert.deepEqual(
      [result.data.guestLinkId, result.data.attended, result.data.totalMinutes, result.data.sessionCount],
      [linkId, true, 5, 1],
    );
  });

  it('says that nobody joined in a window without sessions', async () => {
    const tools = await linkHarness([loginRequest(), linkRequest(LINK_ID, janeLink()), validityAttendance({ status: 200, body: null })]);
    const result = await tools.call('get_guest_link_attendance', { guestLinkId: LINK_ID });
    await tools.done();

    assert.match(result.summary, / did not attend between /);
    assert.deepEqual([result.data.sessionCount, result.data.firstJoinedAt], [0, null]);
  });

  it('asks for from and to for a link without a validity period, and uses them', async () => {
    const unbounded = { status: 200, body: fixture('guestLinks/guest-link-unbounded.json') };
    const tools = await linkHarness([
      loginRequest(),
      linkRequest(UNBOUNDED_ID, unbounded),
      linkRequest(UNBOUNDED_ID, unbounded),
      linkRequest(UNBOUNDED_ID, unbounded),
      attendanceRequest('2026-10-07T08:00:00.000Z', '2026-10-07T10:00:00.000Z', { status: 200, body: [] }),
    ]);
    const without = await tools.call('get_guest_link_attendance', { guestLinkId: UNBOUNDED_ID });
    const onlyFrom = await tools.call('get_guest_link_attendance', {
      guestLinkId: UNBOUNDED_ID,
      from: '2026-10-07T10:00',
    });
    const both = await tools.call('get_guest_link_attendance', {
      guestLinkId: UNBOUNDED_ID,
      from: '2026-10-07T10:00',
      to: '2026-10-07T12:00',
    });
    await tools.done();

    assert.deepEqual([without.isError, without.summary], [true, NO_VALIDITY_MESSAGE]);
    assert.deepEqual([onlyFrom.isError, onlyFrom.summary], [true, NO_VALIDITY_MESSAGE]);
    assert.equal(NO_VALIDITY_MESSAGE, 'This guest link has no validity period. Give from and to.');
    assert.equal(both.isError, false);
    assert.equal(both.data.attended, false);
  });

  it('refuses a link without the userId of its guest, before the attendance request, and a link without a room', async () => {
    const withoutUserId = fixture<Record<string, unknown>>('guestLinks/guest-link.json');
    delete withoutUserId.userId;
    const tools = await linkHarness([
      loginRequest(),
      linkRequest(LINK_ID, janeLink({ userId: '' })),
      linkRequest(LINK_ID, { status: 200, body: withoutUserId }),
      linkRequest(LINK_ID, janeLink({ roomId: '' })),
    ]);
    const empty = await tools.call('get_guest_link_attendance', { guestLinkId: LINK_ID });
    const missing = await tools.call('get_guest_link_attendance', { guestLinkId: LINK_ID });
    const roomless = await tools.call('get_guest_link_attendance', { guestLinkId: LINK_ID });
    await tools.done();

    for (const unmatched of [empty, missing]) {
      assert.deepEqual(
        [unmatched.isError, unmatched.summary],
        [true, UNMATCHABLE_GUEST_LINK_MESSAGE],
      );
    }
    assert.equal(
      UNMATCHABLE_GUEST_LINK_MESSAGE,
      'This guest link cannot be matched to attendance data.',
    );
    assert.deepEqual(
      [roomless.isError, roomless.summary],
      [true, 'alfaview did not return the room of the guest link.'],
    );
  });

  it('reports a link that alfaview cannot find, and a missing room admin right', async () => {
    const tools = await linkHarness([
      loginRequest(),
      linkRequest(LINK_ID, { status: 404, body: fixture('core/problem-404.json') }),
      linkRequest(LINK_ID, janeLink()),
      validityAttendance({ status: 403 }),
    ]);
    const missing = await tools.call('get_guest_link_attendance', { guestLinkId: LINK_ID });
    const denied = await tools.call('get_guest_link_attendance', { guestLinkId: LINK_ID });
    await tools.done();

    assert.deepEqual(
      [missing.isError, missing.summary],
      [true, "alfaview could not find the guest link. It was deleted, or the API key's user cannot see it."],
    );
    assert.deepEqual([denied.isError, denied.summary], [true, ATTENDANCE_DENIED_MESSAGE]);
  });

  it('refuses a validity window that alfaview would refuse, after reading the link', async () => {
    const tools = await linkHarness(
      [
        loginRequest(),
        linkRequest(LINK_ID, janeLink({ validUntil: '2026-10-08T12:00:00Z' })),
        linkRequest(LINK_ID, janeLink()),
      ],
      { now: testClock('2026-11-20T00:00:00Z').now },
    );
    const long = await tools.call('get_guest_link_attendance', { guestLinkId: LINK_ID });
    const old = await tools.call('get_guest_link_attendance', { guestLinkId: LINK_ID });
    await tools.done();

    assert.equal(long.summary, 'to must be at most 26 hours after from.');
    assert.equal(
      old.summary,
      'from is more than 39 days ago. alfaview removes the user IDs and names from attendance after 40 days.',
    );
  });

  it('checks the dates, and a window that it gives in full, before any request', async () => {
    const tools = await linkHarness([]);
    const cases: [Record<string, unknown>, string][] = [
      [{ from: '7 October' }, unrecognizedDateTime('from')],
      [{ to: '2026-13-01T10:00' }, outOfRangeDateTime('to', '2026-13-01T10:00')],
      [{ from: '2026-10-07T12:00', to: '2026-10-07T10:00' }, 'to must be after from.'],
      [{ from: '2026-10-06T10:00', to: '2026-10-07T12:01' }, 'to must be at most 26 hours after from.'],
    ];
    for (const [input, message] of cases) {
      const result = await tools.call('get_guest_link_attendance', { guestLinkId: LINK_ID, ...input });
      assert.deepEqual([result.isError, result.summary], [true, message], JSON.stringify(input));
    }
    for (const input of [{ guestLinkId: 'Jane Doe' }, { guestLinkId: LINK_ID, minimumMinutes: 1441 }]) {
      const result = await tools.call('get_guest_link_attendance', input);
      assert.equal(result.isError, true, JSON.stringify(input));
    }
    await tools.done();
  });

  it('gives a winter time with its own offset', async () => {
    const tools = await linkHarness(
      [
        loginRequest(),
        linkRequest(LINK_ID, janeLink({ validFrom: '2026-12-01T08:45:00Z', validUntil: '2026-12-01T10:15:00Z' })),
        attendanceRequest('2026-12-01T08:45:00.000Z', '2026-12-01T10:15:00.000Z', { status: 200, body: [] }),
      ],
      { now: testClock('2026-12-02T00:00:00Z').now },
    );
    const result = await tools.call('get_guest_link_attendance', { guestLinkId: LINK_ID });
    await tools.done();

    assert.deepEqual(
      [result.data.windowFrom, result.data.windowTo],
      ['2026-12-01T09:45:00+01:00', '2026-12-01T11:15:00+01:00'],
    );
  });
});
