import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../../src/alfaview/errors.ts';
import {
  ATTENDANCE_DENIED_MESSAGE,
  emailLists,
  invitedLinks,
  invitedPeople,
  listAttendances,
  mapGuestLinkAttendance,
  MAX_LISTED_EMAILS,
  MAX_OTHER_ATTENDEES,
  NO_ORIGIN_WINDOW_MESSAGE,
  ORIGIN_WINDOW_TOO_LONG_MESSAGE,
  otherAttendees,
  overlappingLinks,
  readGuestLinksByUserId,
  sessionsOfUser,
  summarize,
  windowOfOrigin,
  type ApiAttendanceSession,
  type ApiUserAttendances,
  type Invitee,
} from '../../src/domain/attendance.ts';
import type { ApiGuestLink } from '../../src/domain/guestLinks.ts';
import { loginRequest, testApi, toolErrorOf, type ExpectedRequest } from '../helpers/fakeFetch.ts';
import { fixture } from '../helpers/fixtures.ts';

const ROOM_ID = '0b7c5d2e-91a4-5f3b-8e27-0f4a6c9d1e22';
const LINK_ID = '3f2a9c1e-7b4d-5e21-a3c4-14b7e9d0f6a2';
const GUEST_USER_ID = '3f2a9c1e-7b4d-5e21-a3c4-18b7e9d0f6a2';
const ADVISOR_USER_ID = '6c1d9e4f-2a7b-5c3d-9e8f-0a1b2c3d4e5f';
const VISITOR_USER_ID = '9e8d7c6b-5a49-5382-a716-18f5e4d3c2b1';
const BERLIN = 'Europe/Berlin';
const OPEN = '0001-01-01T00:00:00Z';

const at = (iso: string) => Date.parse(iso);

/** Returns guest link ID number `n`: version 5, IETF variant, byte 10 = 0x14. */
function linkIdFor(n: number): string {
  return `0b000000-0000-5000-8000-14${String(n).padStart(10, '0')}`;
}

/** Returns the userId of the guest of the link `linkIdFor(n)`: byte 10 = 0x18, as observed. */
function userIdFor(n: number): string {
  return `0b000000-0000-5000-8000-18${String(n).padStart(10, '0')}`;
}

function session(from: string, to: string, displayName = 'Guest'): ApiAttendanceSession {
  return { displayName, from, to };
}

/** Returns the ToolError that `run` throws, and fails the test when it throws none. */
function errorOf(run: () => unknown): ToolError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ToolError);
    return error;
  }
  throw new assert.AssertionError({ message: 'Expected an error.' });
}

describe('constants', () => {
  it('keep the email lists and the other attendees of get_room_attendance short', () => {
    assert.equal(MAX_LISTED_EMAILS, 400);
    assert.equal(MAX_OTHER_ATTENDEES, 20);
  });
});

describe('attendance requests', () => {
  const window = { from: at('2026-10-07T08:45:00Z'), to: at('2026-10-07T10:15:00Z') };
  const attendancesRequest = (respond: ExpectedRequest['respond']): ExpectedRequest => ({
    method: 'GET',
    path: `/v2/rooms/${ROOM_ID}/attendances`,
    query: { from: '2026-10-07T08:45:00.000Z', to: '2026-10-07T10:15:00.000Z' },
    respond,
  });

  it('listAttendances asks for the window in UTC with the room ID in lowercase', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      attendancesRequest({ status: 200, body: fixture('attendance/attendances.json') }),
    ]);
    assert.equal((await listAttendances(api, ROOM_ID.toUpperCase(), window)).length, 4);
    fake.assertDone();
  });

  it('listAttendances treats null as no attendance and leaves out broken entries', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      attendancesRequest({ status: 200, body: 'null' }),
      attendancesRequest({
        status: 200,
        body: [
          { attendances: [] },
          { userId: '', attendances: [] },
          'text',
          { userId: GUEST_USER_ID, attendances: [null, 'x', { from: '2026-10-07T09:00:00Z' }] },
          { userId: ADVISOR_USER_ID, attendances: null },
        ],
      }),
    ]);
    assert.deepEqual(await listAttendances(api, ROOM_ID, window), []);
    assert.deepEqual(await listAttendances(api, ROOM_ID, window), [
      { userId: GUEST_USER_ID, attendances: [{ from: '2026-10-07T09:00:00Z' }] },
      { userId: ADVISOR_USER_ID, attendances: [] },
    ]);
    fake.assertDone();
  });

  it('listAttendances explains a 403, which alfaview also gives for a room that does not exist', async () => {
    const { api, fake } = testApi([loginRequest(), attendancesRequest({ status: 403 })]);
    const error = await toolErrorOf(listAttendances(api, ROOM_ID, window));
    assert.deepEqual([error.code, error.message, error.status], ['Forbidden', ATTENDANCE_DENIED_MESSAGE, 403]);
    fake.assertDone();
  });

  it('listAttendances shows a refused window and refuses a body that is not a list', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      attendancesRequest({ status: 422, body: { detail: 'window too long' } }),
      attendancesRequest({ status: 200, body: { data: [] } }),
    ]);
    assert.equal((await toolErrorOf(listAttendances(api, ROOM_ID, window))).code, 'ValidationFailed');
    const invalid = await toolErrorOf(listAttendances(api, ROOM_ID, window));
    assert.deepEqual([invalid.code, invalid.message], [
      'InvalidResponse',
      'alfaview sent an unexpected attendance response.',
    ]);
    fake.assertDone();
  });

  it('readGuestLinksByUserId reads the links of the room once, each by the userId of its guest', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      {
        method: 'GET',
        path: `/v2/rooms/${ROOM_ID}/guest-links`,
        query: { limit: '500' },
        respond: {
          status: 200,
          body: { data: [fixture('guestLinks/guest-link.json'), { id: linkIdFor(2), userId: '' }] },
        },
      },
    ]);
    const map = await readGuestLinksByUserId(api, ROOM_ID.toUpperCase());
    assert.deepEqual([...map.keys()], [GUEST_USER_ID]);
    assert.equal(map.get(GUEST_USER_ID)?.id, LINK_ID);
    assert.equal(map.get(VISITOR_USER_ID), undefined);
    fake.assertDone();
  });
});

describe('mapGuestLinkAttendance', () => {
  it('maps the attendance of one guest link with the window and the link data', () => {
    const link = fixture<ApiGuestLink>('guestLinks/guest-link.json');
    const window = { from: at('2026-10-07T08:45:00Z'), to: at('2026-10-07T10:15:00Z') };
    const entries = fixture<ApiUserAttendances[]>('attendance/attendances.json');
    const summary = summarize(sessionsOfUser(entries, GUEST_USER_ID), window, at('2026-10-08T00:00:00Z'), 0);
    assert.deepEqual(mapGuestLinkAttendance(link, window, 0, summary, BERLIN), {
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
    });
  });

  it('falls back to the name in the room', () => {
    const summary = summarize([session('2026-10-07T09:00:00Z', OPEN, 'In Room')], { from: 0, to: 1 }, 1, 0);
    const output = mapGuestLinkAttendance({ id: LINK_ID }, { from: 0, to: 1 }, 5, summary, 'UTC');
    assert.deepEqual(
      [output.displayName, output.roomId, output.lastLeftAt, output.windowFrom],
      ['In Room', null, null, '1970-01-01T00:00:00+00:00'],
    );
  });
});

describe('the room attendance helpers', () => {
  const window = { from: at('2026-10-07T16:00:00Z'), to: at('2026-10-07T20:00:00Z') };
  const now = at('2026-10-07T22:00:00Z');
  const inside = { validFrom: '2026-10-07T16:30:00Z', validUntil: '2026-10-07T19:30:00Z' };
  const link = (n: number, fields: Partial<ApiGuestLink>): ApiGuestLink => ({
    id: linkIdFor(n),
    userId: userIdFor(n),
    origin: 'Webinar',
    ...inside,
    ...fields,
  });

  const links: ApiGuestLink[] = [
    link(2, { emailAddress: 'Jane@Example.com ' }),
    link(1, { emailAddress: 'jane@example.com', displayName: 'Jane Doe' }),
    link(3, { emailAddress: 'max@example.com', displayName: 'Max' }),
    link(4, { displayName: 'Walk-in' }),
    link(5, { emailAddress: 'other@example.com', origin: 'Other' }),
    link(6, { emailAddress: 'late@example.com', validFrom: '2026-10-07T19:00:00Z', validUntil: '2026-10-07T21:00:00Z' }),
    link(7, { emailAddress: 'open@example.com', validUntil: undefined }),
    link(8, { emailAddress: 'early@example.com', validFrom: '2026-10-07T15:00:00Z', validUntil: '2026-10-07T16:30:00Z' }),
    link(9, { emailAddress: 'after@example.com', validFrom: '2026-10-07T21:00:00Z', validUntil: '2026-10-07T22:00:00Z' }),
    link(10, { emailAddress: 'plain@example.com', userId: '' }),
  ];

  const entries: ApiUserAttendances[] = [
    { userId: userIdFor(1), attendances: [session('2026-10-07T17:00:00Z', '2026-10-07T17:30:00Z', 'Jane D')] },
    { userId: userIdFor(2).toUpperCase(), attendances: [session('2026-10-07T17:20:00Z', '2026-10-07T17:50:00Z')] },
    { userId: userIdFor(4), attendances: [session('2026-10-07T18:00:00Z', '2026-10-07T18:05:00Z')] },
    { userId: userIdFor(6), attendances: [session('2026-10-07T19:10:00Z', '2026-10-07T19:40:00Z', 'Late')] },
    { userId: ADVISOR_USER_ID, attendances: [session('2026-10-07T16:50:00Z', OPEN, 'Anna Example')] },
    { userId: userIdFor(5), attendances: [session('2026-10-07T17:00:00Z', '2026-10-07T17:10:00Z', 'Other')] },
    { userId: userIdFor(5), attendances: [session('2026-10-07T17:05:00Z', '2026-10-07T17:20:00Z', 'Other')] },
    { userId: VISITOR_USER_ID, attendances: [{ displayName: 'no join time' }] },
    { userId: 'same-start-b', attendances: [session('2026-10-07T17:00:00Z', '2026-10-07T17:01:00Z')] },
  ];

  it('invitedLinks keeps links with the userId of their guest and both bounds inside the window, and the origin when given', () => {
    const ids = (list: ApiGuestLink[]) => list.map((entry) => entry.id);
    assert.deepEqual(ids(invitedLinks(links, window, 'Webinar')), [
      linkIdFor(2),
      linkIdFor(1),
      linkIdFor(3),
      linkIdFor(4),
    ]);
    assert.deepEqual(ids(invitedLinks(links, window, undefined)), [
      linkIdFor(2),
      linkIdFor(1),
      linkIdFor(3),
      linkIdFor(4),
      linkIdFor(5),
    ]);
  });

  it('invitedPeople groups links by email address and merges the minutes of a person', () => {
    const people = invitedPeople(invitedLinks(links, window, 'Webinar'), entries, window, now, 10, BERLIN);
    assert.deepEqual(people, [
      {
        emailAddress: null,
        displayName: 'Walk-in',
        guestLinkIds: [linkIdFor(4)],
        origin: 'Webinar',
        status: 'no_show',
        totalMinutes: 5,
        firstJoinedAt: '2026-10-07T20:00:00+02:00',
        lastLeftAt: '2026-10-07T20:05:00+02:00',
      },
      {
        emailAddress: 'jane@example.com',
        displayName: 'Jane Doe',
        guestLinkIds: [linkIdFor(1), linkIdFor(2)],
        origin: 'Webinar',
        status: 'attended',
        totalMinutes: 50,
        firstJoinedAt: '2026-10-07T19:00:00+02:00',
        lastLeftAt: '2026-10-07T19:50:00+02:00',
      },
      {
        emailAddress: 'max@example.com',
        displayName: 'Max',
        guestLinkIds: [linkIdFor(3)],
        origin: 'Webinar',
        status: 'no_show',
        totalMinutes: 0,
        firstJoinedAt: null,
        lastLeftAt: null,
      },
    ]);
  });

  it('matches each invited link and each other attendee by the userId of the link alone, also one of another layout', () => {
    // Byte 10 of this userId is 0x2f, not 0x18. Link 41 has the userId `userIdFor(42)`, and link 43
    // has the ID of a group link: only the userId of the link decides.
    const otherLayout = '5d6e7f80-91a2-5b3c-8d4e-2f5a6b7c8d9e';
    const matched = [
      link(40, { emailAddress: 'a@example.com', userId: otherLayout.toUpperCase() }),
      link(41, { emailAddress: 'b@example.com', userId: userIdFor(42) }),
      { ...link(43, { emailAddress: 'c@example.com' }), id: '8d4e2f1a-6c3b-5a9e-b2d7-c75e1f0a3b94' },
    ];
    const room = [
      { userId: otherLayout, attendances: [session('2026-10-07T17:00:00Z', '2026-10-07T17:12:00Z')] },
      { userId: userIdFor(41), attendances: [session('2026-10-07T17:00:00Z', '2026-10-07T18:00:00Z', 'Not B')] },
      { userId: userIdFor(42), attendances: [session('2026-10-07T17:00:00Z', '2026-10-07T17:07:00Z')] },
      { userId: userIdFor(43), attendances: [session('2026-10-07T17:00:00Z', '2026-10-07T17:03:00Z')] },
    ];
    const invited = invitedLinks(matched, window, 'Webinar');
    assert.deepEqual(
      invited.map((entry) => entry.id),
      [linkIdFor(40), linkIdFor(41), '8d4e2f1a-6c3b-5a9e-b2d7-c75e1f0a3b94'],
    );
    assert.deepEqual(
      invitedPeople(invited, room, window, now, 0, BERLIN).map((person) => [person.emailAddress, person.totalMinutes]),
      [
        ['a@example.com', 12],
        ['b@example.com', 7],
        ['c@example.com', 3],
      ],
    );
    assert.deepEqual(
      otherAttendees(room, invited, matched, window, now, BERLIN).map((other) => [other.userId, other.guestLinkId]),
      [[userIdFor(41), null]],
    );
  });

  it('invitedPeople gives no sessions to a link without the userId of its guest', () => {
    const room = [{ userId: userIdFor(50), attendances: [session('2026-10-07T17:00:00Z', '2026-10-07T18:00:00Z')] }];
    const people = invitedPeople([link(50, { emailAddress: 'e@example.com', userId: '' })], room, window, now, 0, BERLIN);
    assert.deepEqual(people.map((person) => [person.status, person.totalMinutes]), [['no_show', 0]]);
  });

  it('invitedPeople reads the attendance once for all links', () => {
    // Each read of a userId counts, so a lookup that reads every entry for each link fails.
    let reads = 0;
    const room: ApiUserAttendances[] = Array.from({ length: 200 }, (_, index) => {
      const userId = userIdFor(index + 1);
      return {
        get userId() {
          reads += 1;
          return userId;
        },
        attendances: [session('2026-10-07T17:00:00Z', '2026-10-07T17:30:00Z')],
      };
    });
    const many = Array.from({ length: 200 }, (_, index) => link(index + 1, { emailAddress: `guest${index}@example.com` }));
    const people = invitedPeople(many, room, window, now, 0, BERLIN);
    assert.deepEqual(new Set(people.map((person) => person.totalMinutes)), new Set([30]));
    assert.equal(reads, 200);
  });

  it('invitedPeople takes the name in the room when no link has one, and orders by link ID', () => {
    const noNames = [link(12, {}), link(11, {})];
    const room = [{ userId: userIdFor(11), attendances: [session('2026-10-07T17:00:00Z', '2026-10-07T17:10:00Z', 'Seen')] }];
    const people = invitedPeople(noNames, room, window, now, 0, BERLIN);
    assert.deepEqual(
      people.map((person) => [person.guestLinkIds[0], person.displayName]),
      [
        [linkIdFor(11), 'Seen'],
        [linkIdFor(12), null],
      ],
    );
  });

  it('emailLists gives the lowercase addresses of attendees and no-shows, sorted, each once', () => {
    const person = (emailAddress: string | null, status: Invitee['status']): Invitee => ({
      emailAddress,
      displayName: null,
      guestLinkIds: ['x'],
      origin: null,
      status,
      totalMinutes: 0,
      firstJoinedAt: null,
      lastLeftAt: null,
    });
    assert.deepEqual(
      emailLists([
        person('Zoe@example.com', 'attended'),
        person(null, 'attended'),
        person('amy@example.com ', 'attended'),
        person('max@example.com', 'no_show'),
        person('AMY@example.com', 'attended'),
      ]),
      { attendedEmails: ['amy@example.com', 'zoe@example.com'], noShowEmails: ['max@example.com'] },
    );
    assert.deepEqual(emailLists([]), { attendedEmails: [], noShowEmails: [] });
    const many = Array.from({ length: MAX_LISTED_EMAILS + 1 }, (_, index) =>
      person(`p${index}@example.com`, 'attended'),
    );
    assert.deepEqual(emailLists(many), { attendedEmails: null, noShowEmails: null });
    assert.equal(emailLists(many.slice(1)).attendedEmails?.length, MAX_LISTED_EMAILS);
  });

  it('otherAttendees lists the people of no invited link by first join, with the link of a guest', () => {
    const invited = invitedLinks(links, window, 'Webinar');
    const others = otherAttendees(entries, invited, links, window, now, BERLIN);
    assert.deepEqual(
      others.map((other) => [other.userId, other.displayName, other.emailAddress, other.guestLinkId, other.totalMinutes, other.sessionCount]),
      [
        [ADVISOR_USER_ID, 'Anna Example', null, null, 190, 1],
        [userIdFor(5), 'Other', 'other@example.com', linkIdFor(5), 20, 2],
        ['same-start-b', 'Guest', null, null, 1, 1],
        [userIdFor(6), 'Late', 'late@example.com', linkIdFor(6), 30, 1],
      ],
    );
    assert.deepEqual(
      [others[0]?.firstJoinedAt, others[0]?.lastLeftAt, others[0]?.stillConnected],
      ['2026-10-07T18:50:00+02:00', null, true],
    );
    assert.equal(others[3]?.lastLeftAt, '2026-10-07T21:40:00+02:00');
  });

  it('otherAttendees orders people with the same first join by userId', () => {
    const same = [
      { userId: 'user-b', attendances: [session('2026-10-07T17:00:00Z', '2026-10-07T17:01:00Z')] },
      { userId: 'user-a', attendances: [session('2026-10-07T17:00:00Z', '2026-10-07T17:02:00Z')] },
    ];
    assert.deepEqual(
      otherAttendees(same, [], [], window, now, BERLIN).map((other) => other.userId),
      ['user-a', 'user-b'],
    );
  });

  it('otherAttendees prefers the name of the guest link', () => {
    const named = [link(20, { displayName: 'Link Name' })];
    const room = [{ userId: userIdFor(20), attendances: [session('2026-10-07T17:00:00Z', '2026-10-07T17:05:00Z', 'Room Name')] }];
    assert.equal(otherAttendees(room, [], named, window, now, BERLIN)[0]?.displayName, 'Link Name');
  });

  it('windowOfOrigin spans the validity of the links with the origin', () => {
    assert.deepEqual(windowOfOrigin(links, 'Webinar'), {
      from: at('2026-10-07T15:00:00Z'),
      to: at('2026-10-07T22:00:00Z'),
    });
    assert.deepEqual(windowOfOrigin(links, 'Other'), {
      from: at(inside.validFrom),
      to: at(inside.validUntil),
    });
  });

  it('windowOfOrigin asks for from and to when no link fits or the links span more than 26 hours', () => {
    const none = errorOf(() => windowOfOrigin(links, 'Unknown'));
    assert.deepEqual([none.code, none.message], ['InvalidInput', NO_ORIGIN_WINDOW_MESSAGE]);
    const openOnly = errorOf(() => windowOfOrigin([link(1, { validUntil: undefined })], 'Webinar'));
    assert.equal(openOnly.message, NO_ORIGIN_WINDOW_MESSAGE);
    const spread = [link(1, {}), link(2, { validFrom: '2026-10-09T16:30:00Z', validUntil: '2026-10-09T19:30:00Z' })];
    const long = errorOf(() => windowOfOrigin(spread, 'Webinar'));
    assert.deepEqual([long.code, long.message], ['InvalidInput', ORIGIN_WINDOW_TOO_LONG_MESSAGE]);
  });

  it('overlappingLinks gives the links that overlap the window without lying inside, by validFrom', () => {
    const ids = (list: ApiGuestLink[]) => list.map((entry) => entry.id);
    assert.deepEqual(ids(overlappingLinks(links, window, 'Webinar')), [linkIdFor(8), linkIdFor(6)]);
    assert.deepEqual(ids(overlappingLinks(links, window, 'Other')), []);
    const tie = [link(31, { validFrom: '2026-10-07T15:00:00Z' }), link(30, { validFrom: '2026-10-07T15:00:00Z' })];
    assert.deepEqual(ids(overlappingLinks(tie, window, undefined)), [linkIdFor(30), linkIdFor(31)]);
  });
});
