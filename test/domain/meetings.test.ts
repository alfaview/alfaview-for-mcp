import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../../src/alfaview/errors.ts';
import { groupNamesById } from '../../src/domain/permissionGroups.ts';
import {
  EXTERNALLY_MANAGED_MESSAGE,
  getMeeting,
  getMeetingOutput,
  listMeetings,
  mapListedMeeting,
  mapMeeting,
  mapMeetingSummary,
  MEETING_UNCERTAIN_MESSAGE,
  MEETING_WITHOUT_TIMES_MESSAGE,
  meetingCreatedButNotReadMessage,
  meetingInviteeEmailMessage,
  meetingPath,
  refuseExternallyManaged,
  type ApiMeeting,
} from '../../src/domain/meetings.ts';
import { loginRequest, testApi, toolErrorOf, untilRequests } from '../helpers/fakeFetch.ts';
import { fixture } from '../helpers/fixtures.ts';

const MEETING_ID = '7e9a1c3d-5b2f-5a4e-8c6d-22f0a1b2c3d4';
const JOIN_PREFIX = `https://app.alfaview.com/#/join/0123456789ABCDEFGHIJKLMNOP/${MEETING_ID}/`;
const BERLIN = 'Europe/Berlin';

const meeting = () => fixture<ApiMeeting>('meetings/meeting.json');
const listed = (id: string, overrides: Partial<ApiMeeting> = {}): ApiMeeting => ({
  ...fixture<ApiMeeting>('meetings/meeting-listed.json'),
  id,
  ...overrides,
});
const names = () => groupNamesById(fixture('rooms/permission-groups.json'));

describe('mapMeetingSummary', () => {
  it('maps a listed meeting to exactly the documented summary', () => {
    assert.deepEqual(mapMeetingSummary(fixture('meetings/meeting-listed.json'), BERLIN), {
      id: MEETING_ID,
      title: 'Quarterly Review',
      start: '2026-10-12T10:00:00+02:00',
      end: '2026-10-12T11:00:00+02:00',
      timezone: 'Europe/Berlin',
      state: 'scheduled',
      canJoin: false,
      guestLinkCount: 0,
      recurrenceRule: null,
      externallyManaged: null,
    });
  });

  it('gives null for absent and empty values and counts only text guest link IDs', () => {
    assert.deepEqual(mapMeetingSummary(fixture('meetings/meeting-sparse.json'), BERLIN), {
      id: '4b5c6d7e-8f9a-5b0c-9d1e-22a3b4c5d6e7',
      title: null,
      start: '2026-10-20T17:00:00+02:00',
      end: '2026-10-20T17:30:00+02:00',
      timezone: 'UTC',
      state: 'canceled',
      canJoin: false,
      guestLinkCount: 2,
      recurrenceRule: null,
      externallyManaged: null,
    });
  });

  it('gives the rule and the management of a recurring meeting, and no next instance', () => {
    const summary = mapMeetingSummary(
      listed(MEETING_ID, { recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO', externallyManaged: true }),
      BERLIN,
    );
    assert.equal(summary.recurrenceRule, 'FREQ=WEEKLY;BYDAY=MO');
    assert.equal(summary.externallyManaged, true);
    assert.ok(!('nextInstance' in summary));
  });
});

describe('mapListedMeeting', () => {
  const GUEST_LINKS = ['g1', 'g2'];

  it('gives no count of guest links for a recurring meeting, which the list does not show', () => {
    const entry = listed(MEETING_ID, { recurrenceRule: 'FREQ=DAILY', externallyManaged: false });
    delete entry.guestLinks;
    assert.deepEqual(mapListedMeeting(entry, BERLIN), {
      ...mapMeetingSummary(entry, BERLIN),
      guestLinkCount: null,
    });
  });

  it('gives no count for a recurring meeting whatever the guest link field holds', () => {
    const entry = listed(MEETING_ID, { recurrenceRule: 'FREQ=DAILY', guestLinks: GUEST_LINKS });
    assert.equal(mapListedMeeting(entry, BERLIN).guestLinkCount, null);
  });

  it('keeps the count of a meeting that does not recur, and the order of the keys', () => {
    const entry = listed(MEETING_ID, { guestLinks: GUEST_LINKS });
    const output = mapListedMeeting(entry, BERLIN);
    assert.equal(output.guestLinkCount, 2);
    assert.deepEqual(Object.keys(output), Object.keys(mapMeetingSummary(entry, BERLIN)));
  });

  it('treats an empty rule as no rule', () => {
    const entry = listed(MEETING_ID, { recurrenceRule: '', guestLinks: GUEST_LINKS });
    assert.equal(mapListedMeeting(entry, BERLIN).guestLinkCount, 2);
  });
});

describe('mapMeeting', () => {
  it('maps a meeting with its group links to exactly the documented shape and key order', () => {
    const output = mapMeeting(meeting(), names(), BERLIN);
    assert.deepEqual(output, {
      id: MEETING_ID,
      title: 'Quarterly Review',
      start: '2026-10-12T10:00:00+02:00',
      end: '2026-10-12T11:00:00+02:00',
      timezone: 'Europe/Berlin',
      state: 'scheduled',
      canJoin: false,
      guestLinkCount: 0,
      recurrenceRule: null,
      externallyManaged: null,
      agenda: 'Portfolio review and next steps.',
      earlyAccessMinutes: 10,
      canJoinAfter: '2026-10-12T09:50:00+02:00',
      canceledAt: null,
      roomAvailable: false,
      createdAt: '2026-09-25T12:00:00+02:00',
      nextInstance: null,
      groupLinks: [
        {
          permissionGroupId: 'd2b3c4d5-e6f7-5081-9a2b-c3d4e5f6a7b8',
          permissionGroupName: 'Guest',
          joinUrl: `${JOIN_PREFIX}Vb6nM8qW1eR3tY5uI7oP9aS0dF2gH4jK`,
        },
        {
          permissionGroupId: 'c1a2b3c4-d5e6-5f70-8192-a3b4c5d6e7f8',
          permissionGroupName: 'Moderator',
          joinUrl: `${JOIN_PREFIX}Mx8kP2qR7tV9wY3zA5bC1dE4fG6hJ0kL`,
        },
        {
          permissionGroupId: 'e3f4a5b6-c7d8-5e9f-8a0b-1c2d3e4f5a6b',
          permissionGroupName: 'Participant',
          joinUrl: `${JOIN_PREFIX}Qw3eR5tY7uI9oP1aS2dF4gH6jK8lZ0xC`,
        },
        {
          permissionGroupId: 'f4a5b6c7-d8e9-5f0a-9b1c-2d3e4f5a6b7c',
          permissionGroupName: 'Spectator',
          joinUrl: `${JOIN_PREFIX}Zx1cV3bN5mQ7wE9rT0yU2iO4pA6sD8fG`,
        },
      ],
    });
    assert.deepEqual(Object.keys(output), [
      'id',
      'title',
      'start',
      'end',
      'timezone',
      'state',
      'canJoin',
      'guestLinkCount',
      'recurrenceRule',
      'externallyManaged',
      'agenda',
      'earlyAccessMinutes',
      'canJoinAfter',
      'canceledAt',
      'roomAvailable',
      'createdAt',
      'nextInstance',
      'groupLinks',
    ]);
  });

  it('gives the next instance of a recurring meeting in the time zone and its real guest link count', () => {
    const output = mapMeeting(
      {
        ...meeting(),
        recurrenceRule: 'FREQ=WEEKLY',
        externallyManaged: false,
        nextInstance: '2026-10-26T08:00:00Z',
        guestLinks: ['g1', 'g2'],
      },
      names(),
      BERLIN,
    );
    assert.deepEqual(
      [output.recurrenceRule, output.externallyManaged, output.nextInstance, output.guestLinkCount],
      ['FREQ=WEEKLY', false, '2026-10-26T09:00:00+01:00', 2],
    );
  });

  it('gives canceledAt and the year-1 canJoinAfter of a canceled meeting', () => {
    const output = mapMeeting(fixture('meetings/meeting-sparse.json'), names(), BERLIN);
    assert.equal(output.canceledAt, '2026-09-26T09:15:30+02:00');
    assert.equal(output.canJoinAfter, null);
    assert.equal(output.agenda, null);
    assert.equal(output.earlyAccessMinutes, null);
  });
});

describe('messages', () => {
  it('name the meeting and the next step', () => {
    assert.equal(
      meetingCreatedButNotReadMessage(MEETING_ID),
      `alfaview created the meeting ${MEETING_ID}, but reading it back failed. Do not create it again: that makes a second meeting. Use get_meeting with this ID to get the join URLs.`,
    );
    assert.equal(
      meetingInviteeEmailMessage(3),
      'This meeting has 3 guest links, and alfaview can email those guests about a change. Call update_meeting again with sendEmail true to change it.',
    );
    assert.match(MEETING_UNCERTAIN_MESSAGE, /Check with find_meetings before you create it again/);
    assert.match(MEETING_WITHOUT_TIMES_MESSAGE, /Give both start and end\.$/);
    assert.equal(
      EXTERNALLY_MANAGED_MESSAGE,
      'This recurring meeting is externally managed: another system manages it and can overwrite a change. The server changes or cancels such a meeting only at the access level manage or full. Tell the user to change it in the system that manages it.',
    );
  });
});

describe('refuseExternallyManaged', () => {
  it('refuses only a meeting with externallyManaged true, with the code ExternallyManagedRefused', () => {
    assert.throws(
      () => refuseExternallyManaged({ ...meeting(), externallyManaged: true }),
      (error: unknown) =>
        error instanceof ToolError &&
        error.code === 'ExternallyManagedRefused' &&
        error.message === EXTERNALLY_MANAGED_MESSAGE &&
        error.status === undefined,
    );
    refuseExternallyManaged({ ...meeting(), externallyManaged: false });
    refuseExternallyManaged(meeting());
  });
});

describe('meeting requests', () => {
  const window = { from: '2026-10-06T08:00:00.000Z', to: '2027-10-08T08:00:00.000Z' };
  const listRequest = (body: unknown, status = 200) => ({
    method: 'GET',
    path: '/v2/meetings',
    query: window,
    respond: { status, body },
  });

  it('listMeetings sends both bounds of the window', async () => {
    const { api, fake } = testApi([loginRequest(), listRequest([fixture('meetings/meeting-listed.json')])]);
    assert.deepEqual((await listMeetings(api, window)).map((entry) => entry.id), [MEETING_ID]);
    fake.assertDone();
  });

  it('listMeetings treats null as no meetings and skips entries without an ID', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      listRequest('null'),
      listRequest([{ title: 'no ID' }, null, listed('m1')]),
    ]);
    assert.deepEqual(await listMeetings(api, window), []);
    assert.deepEqual((await listMeetings(api, window)).map((entry) => entry.id), ['m1']);
    fake.assertDone();
  });

  it('listMeetings rejects a body that is not a list and shows alfaview errors', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      listRequest({ data: [] }),
      listRequest(fixture('core/problem-400.json'), 400),
    ]);
    const invalid = await toolErrorOf(listMeetings(api, window));
    assert.deepEqual([invalid.code, invalid.message], [
      'InvalidResponse',
      'alfaview sent an unexpected response for /v2/meetings.',
    ]);
    assert.equal((await toolErrorOf(listMeetings(api, window))).code, 'BadRequest');
    fake.assertDone();
  });

  it('getMeeting names the meeting when alfaview cannot find it or returns no ID', async () => {
    const path = meetingPath(MEETING_ID);
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'GET', path, respond: { status: 404 } },
      { method: 'GET', path, respond: { status: 200, body: { title: 'x' } } },
    ]);
    assert.equal(
      (await toolErrorOf(getMeeting(api, MEETING_ID))).message,
      "alfaview could not find the meeting. It was deleted, or the API key's user cannot see it.",
    );
    const invalid = await toolErrorOf(getMeeting(api, MEETING_ID));
    assert.deepEqual([invalid.code, invalid.message], [
      'InvalidResponse',
      'alfaview did not return the meeting.',
    ]);
    fake.assertDone();
  });

  it('getMeetingOutput reads the meeting and the permission group names for its group links', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'GET', path: meetingPath(MEETING_ID), respond: { status: 200, body: meeting() } },
      {
        method: 'GET',
        path: '/v2/permission-groups',
        respond: { status: 200, body: fixture('rooms/permission-groups.json') },
      },
    ]);
    assert.deepEqual(
      await getMeetingOutput(api, MEETING_ID, BERLIN),
      mapMeeting(meeting(), names(), BERLIN),
    );
    fake.assertDone();
  });

  it('getMeetingOutput reads no permission groups for a meeting without group links', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      {
        method: 'GET',
        path: meetingPath(MEETING_ID),
        respond: { status: 200, body: fixture('meetings/meeting-listed.json') },
      },
    ]);
    assert.deepEqual((await getMeetingOutput(api, MEETING_ID, BERLIN)).groupLinks, []);
    fake.assertDone();
  });

  it('getMeetingOutput gives null names when the group read fails', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'GET', path: meetingPath(MEETING_ID), respond: { status: 200, body: meeting() } },
      { method: 'GET', path: '/v2/permission-groups', respond: { status: 503 } },
    ]);
    const output = await getMeetingOutput(api, MEETING_ID, BERLIN);
    assert.equal(output.groupLinks.length, 4);
    assert.ok(output.groupLinks.every((link) => link.permissionGroupName === null));
    fake.assertDone();
  });

  it('getMeetingOutput still ends on a cancel during the group read', async () => {
    const canceling = new AbortController();
    const { api, fake } = testApi(
      [
        loginRequest(),
        { method: 'GET', path: meetingPath(MEETING_ID), respond: { status: 200, body: meeting() } },
        { method: 'GET', path: '/v2/permission-groups', respond: { hang: true } },
      ],
      { signal: canceling.signal },
    );
    const output = getMeetingOutput(api, MEETING_ID, BERLIN);
    await untilRequests(fake, 3);
    canceling.abort();
    assert.equal((await toolErrorOf(output)).code, 'Canceled');
    fake.assertDone();
  });
});
