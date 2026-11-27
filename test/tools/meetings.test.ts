// find_meetings, get_meeting, create_meeting, update_meeting and cancel_meeting through an MCP SDK
// client.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EXTERNALLY_MANAGED_MESSAGE,
  MEETING_UNCERTAIN_MESSAGE,
  MEETING_WITHOUT_TIMES_MESSAGE,
  meetingCanceledButNotReadMessage,
  meetingCreatedButNotReadMessage,
  meetingInviteeEmailMessage,
  meetingUpdatedButNotReadMessage,
} from '../../src/domain/meetings.ts';
import { createLogger } from '../../src/log.ts';
import { createMeetingTool, MEETING_TOOLS } from '../../src/tools/meetings.ts';
import {
  CHANGE_ANNOTATIONS,
  CREATE_ANNOTATIONS,
  READ_ANNOTATIONS,
} from '../../src/tools/tool.ts';
import {
  loginRequest,
  testApi,
  toolErrorOf,
  untilRequests,
  type ExpectedRequest,
  type FakeAnswer,
} from '../helpers/fakeFetch.ts';
import { nonexistentLocalTime, unrecognizedDateTime } from '../helpers/dateTimeMessages.ts';
import { fixture } from '../helpers/fixtures.ts';
import { toolHarness, type HarnessOptions } from '../helpers/mcpClient.ts';
import { noQuestions } from '../helpers/toolContext.ts';

const MEETING_ID = '7e9a1c3d-5b2f-5a4e-8c6d-22f0a1b2c3d4';
const SPARSE_ID = '4b5c6d7e-8f9a-5b0c-9d1e-22a3b4c5d6e7';
const NOW = Date.parse('2026-10-07T08:00:00Z');
const BAD_IDS = ['Quarterly Review', '.', '..', '7e9a1c3d-5b2f-5a4e-22f0a1b2c3d4'];
const GUEST_LINK_IDS = [
  '3f2a9c1e-7b4d-5e21-a3c4-14b7e9d0f6a2',
  '8a1b2c3d-4e5f-5a6b-9c7d-14e9f0a1b2c3',
];

type Json = Record<string, unknown>;

/** The part of an advertised input schema that the tests read. */
type JsonSchema = { properties: Record<string, unknown>; required?: string[] };

const meeting = (overrides: Json = {}): Json => ({
  ...fixture<Json>('meetings/meeting.json'),
  ...overrides,
});
const listed = (overrides: Json = {}): Json => ({
  ...fixture<Json>('meetings/meeting-listed.json'),
  ...overrides,
});

const RULE = 'FREQ=WEEKLY;BYDAY=MO';

const NOT_VALID_RULE =
  'recurrenceRule is not valid. Write KEY=VALUE parts with FREQ, such as FREQ=WEEKLY;BYDAY=MO.';

/**
 * A recurrenceRule of each kind that alfaview refuses, with the message of the tools: the checks
 * of src/shared/meetings.ts with the parameter names recurrenceRule and start. The clock of the
 * harness stands at 2026-10-07T08:00:00Z.
 */
const RECURRENCE_RULE_REFUSALS: [string, string][] = [
  ['freq=weekly', NOT_VALID_RULE],
  ['FREQ=WEEKLY;BYDAY=XX', NOT_VALID_RULE],
  ['DTSTART:20261012T080000Z\nRRULE:FREQ=WEEKLY', NOT_VALID_RULE],
  ['FREQ=HOURLY', 'recurrenceRule must repeat daily or less often.'],
  [
    'FREQ=DAILY;BYHOUR=9',
    'recurrenceRule cannot set BYHOUR, BYMINUTE or BYSECOND: start sets the time.',
  ],
  [
    'FREQ=DAILY;UNTIL=20261231T230000',
    'UNTIL of recurrenceRule must be in UTC, such as UNTIL=20261231T230000Z.',
  ],
  ['FREQ=DAILY;COUNT=3;UNTIL=20261231T230000Z', 'recurrenceRule cannot have both UNTIL and COUNT.'],
  ['FREQ=DAILY;COUNT=0', 'COUNT and INTERVAL of recurrenceRule must be at least 1.'],
  ['RRULE:FREQ=WEEKLY;INTERVAL=-1', 'COUNT and INTERVAL of recurrenceRule must be at least 1.'],
  // 1019 characters after the prefix, which does not count.
  [
    `RRULE:FREQ=DAILY;COUNT=${'1'.padStart(1002, '0')}`,
    'recurrenceRule can have at most 1018 characters.',
  ],
  ['FREQ=DAILY;UNTIL=20261001T000000Z', 'UNTIL of recurrenceRule is in the past.'],
];

/**
 * The list entry of one occurrence of a recurring meeting: alfaview sends it without guest links,
 * group links and canJoinAfter.
 */
const occurrence = (start: string, end: string, overrides: Json = {}): Json =>
  listed({
    start,
    end,
    recurrenceRule: RULE,
    externallyManaged: false,
    guestLinks: undefined,
    groupLinks: undefined,
    canJoinAfter: undefined,
    ...overrides,
  });

/** A recurring meeting as `GET /v2/meetings/{id}` returns it. */
const recurringMeeting = (overrides: Json = {}): Json =>
  meeting({
    recurrenceRule: RULE,
    externallyManaged: true,
    nextInstance: '2026-10-26T08:00:00Z',
    ...overrides,
  });

function meetingRequest(respond: FakeAnswer, id = MEETING_ID): ExpectedRequest {
  return { method: 'GET', path: `/v2/meetings/${id}`, respond };
}

const groupsRequest: ExpectedRequest = {
  method: 'GET',
  path: '/v2/permission-groups',
  respond: { status: 200, body: fixture('rooms/permission-groups.json') },
};

/** The read back of a meeting with its four group links. */
function meetingOutput(body: Json = meeting(), id = MEETING_ID): ExpectedRequest[] {
  return [meetingRequest({ status: 200, body }, id), groupsRequest];
}

function listRequest(from: string, to: string, body: unknown): ExpectedRequest {
  return { method: 'GET', path: '/v2/meetings', query: { from, to }, respond: { status: 200, body } };
}

const DEFAULT_FROM = '2026-10-06T08:00:00.000Z';
const DEFAULT_TO = '2027-10-08T08:00:00.000Z';

function harness(expected: readonly ExpectedRequest[], options: HarnessOptions = {}) {
  return toolHarness(MEETING_TOOLS, expected, options);
}

const QUARTERLY_OUTPUT = {
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
      joinUrl: `https://app.alfaview.com/#/join/0123456789ABCDEFGHIJKLMNOP/${MEETING_ID}/Vb6nM8qW1eR3tY5uI7oP9aS0dF2gH4jK`,
    },
    {
      permissionGroupId: 'c1a2b3c4-d5e6-5f70-8192-a3b4c5d6e7f8',
      permissionGroupName: 'Moderator',
      joinUrl: `https://app.alfaview.com/#/join/0123456789ABCDEFGHIJKLMNOP/${MEETING_ID}/Mx8kP2qR7tV9wY3zA5bC1dE4fG6hJ0kL`,
    },
    {
      permissionGroupId: 'e3f4a5b6-c7d8-5e9f-8a0b-1c2d3e4f5a6b',
      permissionGroupName: 'Participant',
      joinUrl: `https://app.alfaview.com/#/join/0123456789ABCDEFGHIJKLMNOP/${MEETING_ID}/Qw3eR5tY7uI9oP1aS2dF4gH6jK8lZ0xC`,
    },
    {
      permissionGroupId: 'f4a5b6c7-d8e9-5f0a-9b1c-2d3e4f5a6b7c',
      permissionGroupName: 'Spectator',
      joinUrl: `https://app.alfaview.com/#/join/0123456789ABCDEFGHIJKLMNOP/${MEETING_ID}/Zx1cV3bN5mQ7wE9rT0yU2iO4pA6sD8fG`,
    },
  ],
};

describe('the meeting tools', () => {
  it('are listed in their fixed order, with their annotations', async () => {
    const tools = await harness([]);
    const { tools: listedTools } = await tools.client.listTools();
    await tools.done();

    assert.deepEqual(
      listedTools.map((tool) => [tool.name, tool.annotations]),
      [
        ['find_meetings', READ_ANNOTATIONS],
        ['get_meeting', READ_ANNOTATIONS],
        ['create_meeting', CREATE_ANNOTATIONS],
        ['update_meeting', CHANGE_ANNOTATIONS],
        ['cancel_meeting', CHANGE_ANNOTATIONS],
      ],
    );
  });

  it('offer recurrenceRule in create_meeting and update_meeting, optional, as a text', async () => {
    const tools = await harness([]);
    const { tools: listedTools } = await tools.client.listTools();
    await tools.done();

    const create =
      'An RFC 5545 RRULE, such as FREQ=WEEKLY;BYDAY=MO. start is the first occurrence, and end minus start the length of each.';
    const parameters = new Map(
      listedTools.map((tool) => [tool.name, tool.inputSchema as JsonSchema]),
    );
    for (const [name, description] of [
      ['create_meeting', create],
      ['update_meeting', `${create} A recurring meeting cannot stop repeating.`],
    ] as const) {
      const schema = parameters.get(name)!;
      assert.deepEqual(schema.properties.recurrenceRule, { type: 'string', description }, name);
      assert.ok(!schema.required?.includes('recurrenceRule'), name);
    }
  });

  // The rule of alfaview (spec: earlyAccessMinutes): moderators and administrators can always join
  // 30 minutes early, and earlyAccessMinutes opens the meeting early for the other invitees.
  it('offer earlyAccessMinutes in create_meeting and update_meeting, optional, 0 to 30', async () => {
    const tools = await harness([]);
    const { tools: listedTools } = await tools.client.listTools();
    await tools.done();

    const description =
      'People without moderator or administrator permissions can join this many minutes early. Moderators and administrators can always join 30 minutes early.';
    for (const name of ['create_meeting', 'update_meeting']) {
      const schema = listedTools.find((tool) => tool.name === name)!.inputSchema as JsonSchema;
      assert.deepEqual(
        schema.properties.earlyAccessMinutes,
        { type: 'integer', minimum: 0, maximum: 30, description },
        name,
      );
      assert.ok(!schema.required?.includes('earlyAccessMinutes'), name);
    }
  });

  it('refuse a title, dot segments and a broken UUID as a meeting ID without a request', async () => {
    const tools = await harness([]);
    for (const meetingId of BAD_IDS) {
      for (const [name, args] of [
        ['get_meeting', {}],
        ['update_meeting', { title: 'New title' }],
        ['cancel_meeting', {}],
      ] as const) {
        const result = await tools.call(name, { meetingId, ...args });
        assert.equal(result.isError, true, `${name} ${meetingId}`);
        assert.match(
          result.summary,
          /meetingId takes an ID from find_meetings or create_meeting\./,
        );
      }
    }
    await tools.done();
  });
});

describe('find_meetings', () => {
  it('lists the meetings from 1 day ago to 366 days ahead, without canceled ones', async () => {
    const tools = await harness([
      loginRequest(),
      listRequest(DEFAULT_FROM, DEFAULT_TO, [
        fixture('meetings/meeting-sparse.json'),
        listed(),
        listed({ id: 'ee000000-0000-5000-8000-000000000001', title: 'Kickoff', start: '2026-12-01T09:00:00Z', end: '2026-12-01T10:00:00Z', guestLinks: GUEST_LINK_IDS }),
      ]),
    ]);
    const result = await tools.call('find_meetings');
    await tools.done();

    assert.equal(
      result.summary,
      'Found 2 meetings from 2026-10-06 10:00 Europe/Berlin to 2027-10-08 10:00 Europe/Berlin. Showing 1 to 2.',
    );
    assert.deepEqual(result.data, {
      windowFrom: '2026-10-06T10:00:00+02:00',
      windowTo: '2027-10-08T10:00:00+02:00',
      totalMatches: 2,
      offset: 0,
      nextOffset: null,
      meetings: [
        {
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
        },
        {
          id: 'ee000000-0000-5000-8000-000000000001',
          title: 'Kickoff',
          start: '2026-12-01T10:00:00+01:00',
          end: '2026-12-01T11:00:00+01:00',
          timezone: 'Europe/Berlin',
          state: 'scheduled',
          canJoin: false,
          guestLinkCount: 2,
          recurrenceRule: null,
          externallyManaged: null,
        },
      ],
      warnings: [],
    });
  });

  it('shows a recurring meeting once, with its ongoing or next instance and no count of guest links', async () => {
    const tools = await harness([
      loginRequest(),
      listRequest(DEFAULT_FROM, DEFAULT_TO, [
        occurrence('2026-10-12T08:00:00Z', '2026-10-12T09:00:00Z'),
        listed({ id: 'ee000000-0000-5000-8000-000000000001', title: 'Kickoff', start: '2026-10-15T08:00:00Z', end: '2026-10-15T09:00:00Z' }),
        occurrence('2026-10-19T08:00:00Z', '2026-10-19T09:00:00Z'),
      ]),
    ]);
    const result = await tools.call('find_meetings');
    await tools.done();

    assert.equal(
      result.summary,
      'Found 2 meetings from 2026-10-06 10:00 Europe/Berlin to 2027-10-08 10:00 Europe/Berlin. Showing 1 to 2.',
    );
    assert.equal(result.data.totalMatches, 2);
    assert.deepEqual(result.data.meetings, [
      {
        id: MEETING_ID,
        title: 'Quarterly Review',
        start: '2026-10-12T10:00:00+02:00',
        end: '2026-10-12T11:00:00+02:00',
        timezone: 'Europe/Berlin',
        state: 'scheduled',
        canJoin: false,
        guestLinkCount: null,
        recurrenceRule: RULE,
        externallyManaged: false,
      },
      {
        id: 'ee000000-0000-5000-8000-000000000001',
        title: 'Kickoff',
        start: '2026-10-15T10:00:00+02:00',
        end: '2026-10-15T11:00:00+02:00',
        timezone: 'Europe/Berlin',
        state: 'scheduled',
        canJoin: false,
        guestLinkCount: 0,
        recurrenceRule: null,
        externallyManaged: null,
      },
    ]);
  });

  // Ended meetings sort last, so a sort before the series is cut to one entry would keep the later
  // occurrence.
  it('keeps the first entry of a series as alfaview lists it, also when that occurrence ended early', async () => {
    const tools = await harness([
      loginRequest(),
      listRequest(DEFAULT_FROM, DEFAULT_TO, [
        occurrence('2026-10-12T08:00:00Z', '2026-10-12T09:00:00Z', { state: 'ended' }),
        occurrence('2026-10-19T08:00:00Z', '2026-10-19T09:00:00Z'),
      ]),
    ]);
    const result = await tools.call('find_meetings');
    await tools.done();

    assert.deepEqual(
      result.data.meetings.map((entry: Json) => [entry.start, entry.state]),
      [['2026-10-12T10:00:00+02:00', 'ended']],
    );
  });

  it('gives each occurrence with includeEveryOccurrence, and the summary counts occurrences', async () => {
    const tools = await harness([
      loginRequest(),
      listRequest(DEFAULT_FROM, DEFAULT_TO, [
        occurrence('2026-10-12T08:00:00Z', '2026-10-12T09:00:00Z'),
        occurrence('2026-10-19T08:00:00Z', '2026-10-19T09:00:00Z'),
      ]),
    ]);
    const result = await tools.call('find_meetings', { includeEveryOccurrence: true });
    await tools.done();

    assert.equal(
      result.summary,
      'Found 2 occurrences from 2026-10-06 10:00 Europe/Berlin to 2027-10-08 10:00 Europe/Berlin. Showing 1 to 2.',
    );
    assert.equal(result.data.totalMatches, 2);
    assert.deepEqual(
      result.data.meetings.map((entry: Json) => [entry.id, entry.start, entry.guestLinkCount]),
      [
        [MEETING_ID, '2026-10-12T10:00:00+02:00', null],
        [MEETING_ID, '2026-10-19T10:00:00+02:00', null],
      ],
    );
  });

  it('says no meetings with includeEveryOccurrence when nothing matches', async () => {
    const tools = await harness([
      loginRequest(),
      listRequest(DEFAULT_FROM, DEFAULT_TO, null),
    ]);
    const result = await tools.call('find_meetings', { includeEveryOccurrence: true });
    await tools.done();

    assert.equal(
      result.summary,
      'Found no meetings from 2026-10-06 10:00 Europe/Berlin to 2027-10-08 10:00 Europe/Berlin.',
    );
  });

  it('offers includeEveryOccurrence, off by default', async () => {
    const tools = await harness([]);
    const { tools: listedTools } = await tools.client.listTools();
    await tools.done();

    const { properties } = listedTools.find((tool) => tool.name === 'find_meetings')!.inputSchema;
    assert.deepEqual(properties!.includeEveryOccurrence, {
      default: false,
      description:
        'Return one entry for each occurrence of a recurring meeting. By default, a recurring meeting gives one entry, with its ongoing or next occurrence.',
      type: 'boolean',
    });
  });

  it('filters by title, puts an exact title and meetings that have not ended first', async () => {
    const tools = await harness([
      loginRequest(),
      listRequest(DEFAULT_FROM, DEFAULT_TO, [
        listed({ id: 'ee000000-0000-5000-8000-000000000001', title: 'Review', state: 'ended' }),
        listed({ id: 'ee000000-0000-5000-8000-000000000002', title: 'Budget Review', start: '2026-10-08T08:00:00Z' }),
        listed({ id: 'ee000000-0000-5000-8000-000000000003', title: 'review', state: 'canceled' }),
        listed({ id: 'ee000000-0000-5000-8000-000000000004', title: 'Kickoff' }),
      ]),
    ]);
    const result = await tools.call('find_meetings', { title: 'REVIEW', includeCanceled: true });
    await tools.done();

    assert.deepEqual(
      result.data.meetings.map((entry: { id: string }) => entry.id),
      [
        'ee000000-0000-5000-8000-000000000003',
        'ee000000-0000-5000-8000-000000000001',
        'ee000000-0000-5000-8000-000000000002',
      ],
    );
  });

  it('reads from and to as local time and sends them in UTC', async () => {
    const tools = await harness([
      loginRequest(),
      listRequest('2026-10-31T23:00:00.000Z', '2026-11-29T23:00:00.000Z', null),
    ]);
    const result = await tools.call('find_meetings', {
      from: '2026-11-01T00:00',
      to: '2026-11-30T00:00',
    });
    await tools.done();

    assert.equal(
      result.summary,
      'Found no meetings from 2026-11-01 00:00 Europe/Berlin to 2026-11-30 00:00 Europe/Berlin.',
    );
    assert.deepEqual(result.data.meetings, []);
  });

  // find_meetings has no timezone parameter: each parameter costs tokens in every session, and a
  // model can give an offset.
  it("reads from and to and gives the results in the server's time zone", async () => {
    const tools = await harness(
      [
        loginRequest(),
        listRequest('2026-10-12T04:00:00.000Z', '2026-10-13T04:00:00.000Z', [listed()]),
      ],
      { timeZone: 'America/New_York' },
    );
    const result = await tools.call('find_meetings', {
      from: '12.10.2026 00:00',
      to: '2026-10-13 00:00',
    });
    await tools.done();

    assert.equal(
      result.summary,
      'Found 1 meeting from 2026-10-12 00:00 America/New_York to 2026-10-13 00:00 America/New_York. Showing 1 to 1.',
    );
    assert.deepEqual(
      [result.data.windowFrom, result.data.meetings[0].start, result.data.meetings[0].end],
      ['2026-10-12T00:00:00-04:00', '2026-10-12T04:00:00-04:00', '2026-10-12T05:00:00-04:00'],
    );
  });

  it('pages with limit and offset', async () => {
    const many = Array.from({ length: 5 }, (_, index) =>
      listed({ id: `ee000000-0000-5000-8000-00000000000${index}`, start: `2026-10-1${index}T08:00:00Z` }),
    );
    const tools = await harness([
      loginRequest(),
      listRequest(DEFAULT_FROM, DEFAULT_TO, many),
      listRequest(DEFAULT_FROM, DEFAULT_TO, many),
    ]);
    const first = await tools.call('find_meetings', { limit: 2 });
    const last = await tools.call('find_meetings', { limit: 2, offset: 4 });
    await tools.done();

    assert.match(first.summary, /Showing 1 to 2\. Call again with offset 2 for the next ones\.$/);
    assert.equal(first.data.nextOffset, 2);
    assert.match(last.summary, /Showing 5 to 5\.$/);
    assert.equal(last.data.meetings[0].id, 'ee000000-0000-5000-8000-000000000004');
  });

  it('lists with only from or only to, and alfaview sets no limit on the other side', async () => {
    const tools = await harness([
      loginRequest(),
      {
        method: 'GET',
        path: '/v2/meetings',
        query: { from: '2026-10-31T23:00:00.000Z' },
        respond: { status: 200, body: [listed()] },
      },
      {
        method: 'GET',
        path: '/v2/meetings',
        query: { to: '2026-10-31T23:00:00.000Z' },
        respond: { status: 200, body: null },
      },
    ]);
    const onlyFrom = await tools.call('find_meetings', { from: '2026-11-01T00:00' });
    const onlyTo = await tools.call('find_meetings', { to: '2026-11-01T00:00' });
    await tools.done();

    assert.equal(
      onlyFrom.summary,
      'Found 1 meeting from 2026-11-01 00:00 Europe/Berlin on. Showing 1 to 1.',
    );
    assert.deepEqual(
      [onlyFrom.data.windowFrom, onlyFrom.data.windowTo],
      ['2026-11-01T00:00:00+01:00', null],
    );
    assert.equal(onlyTo.summary, 'Found no meetings until 2026-11-01 00:00 Europe/Berlin.');
    assert.deepEqual(
      [onlyTo.data.windowFrom, onlyTo.data.windowTo],
      [null, '2026-11-01T00:00:00+01:00'],
    );
  });

  it('checks the window before any request', async () => {
    const tools = await harness([]);
    const reversed = await tools.call('find_meetings', {
      from: '2026-11-02T00:00',
      to: '2026-11-01T00:00',
    });
    const invalid = await tools.call('find_meetings', { from: 'November', to: '2026-11-01T00:00' });
    const limit = await tools.call('find_meetings', { limit: 101 });
    await tools.done();

    assert.equal(reversed.summary, 'to must be after from.');
    assert.match(invalid.summary, /^from is not a valid date and time\./);
    assert.equal(limit.isError, true);
  });
});

describe('get_meeting', () => {
  it('returns the meeting with its join URLs sorted by group name', async () => {
    const tools = await harness([loginRequest(), ...meetingOutput()]);
    const result = await tools.call('get_meeting', { meetingId: MEETING_ID });
    await tools.done();

    assert.equal(
      result.summary,
      `Meeting ${MEETING_ID}: scheduled, from 2026-10-12 10:00 Europe/Berlin to 2026-10-12 11:00 Europe/Berlin. 4 join URLs.`,
    );
    assert.deepEqual(result.data, { ...QUARTERLY_OUTPUT, warnings: [] });
  });

  it('gives the recurrence of a recurring meeting and keeps its real count of guest links', async () => {
    const tools = await harness([
      loginRequest(),
      ...meetingOutput(recurringMeeting({ guestLinks: GUEST_LINK_IDS })),
    ]);
    const result = await tools.call('get_meeting', { meetingId: MEETING_ID });
    await tools.done();

    assert.deepEqual(result.data, {
      ...QUARTERLY_OUTPUT,
      guestLinkCount: 2,
      recurrenceRule: RULE,
      externallyManaged: true,
      nextInstance: '2026-10-26T09:00:00+01:00',
      warnings: [],
    });
  });

  it('reads no group names for a meeting without group links', async () => {
    const tools = await harness([
      loginRequest(),
      meetingRequest({ status: 200, body: fixture('meetings/meeting-sparse.json') }, SPARSE_ID),
    ]);
    const result = await tools.call('get_meeting', { meetingId: SPARSE_ID });
    await tools.done();

    assert.equal(
      result.summary,
      `Meeting ${SPARSE_ID}: canceled, from 2026-10-20 17:00 Europe/Berlin to 2026-10-20 17:30 Europe/Berlin. 0 join URLs.`,
    );
    assert.equal(result.data.guestLinkCount, 2);
    assert.equal(result.data.canceledAt, '2026-09-26T09:15:30+02:00');
    assert.equal(result.data.canJoinAfter, null);
  });

  it('says what alfaview left out', async () => {
    const tools = await harness([
      loginRequest(),
      meetingRequest({ status: 200, body: { id: MEETING_ID, groupLinks: { 'a1': 'https://example.com/join' } } }),
      groupsRequest,
    ]);
    const result = await tools.call('get_meeting', { meetingId: MEETING_ID });
    await tools.done();

    assert.equal(
      result.summary,
      `Meeting ${MEETING_ID}: unknown state, from an unknown start to an unknown end. 1 join URL.`,
    );
  });

  it('reports a meeting that alfaview cannot find', async () => {
    const tools = await harness([
      loginRequest(),
      meetingRequest({ status: 404, body: fixture('core/problem-404.json') }),
    ]);
    const result = await tools.call('get_meeting', { meetingId: MEETING_ID });
    await tools.done();

    assert.equal(
      result.summary,
      "alfaview could not find the meeting. It was deleted, or the API key's user cannot see it.",
    );
  });
});

const QUARTERLY = { title: 'Quarterly Review', start: '2026-10-12T10:00', end: '2026-10-12T11:00' };

function createRequest(respond: FakeAnswer, body: Json = {}): ExpectedRequest {
  return {
    method: 'POST',
    path: '/v2/meetings',
    body: {
      title: 'Quarterly Review',
      start: '2026-10-12T08:00:00.000Z',
      end: '2026-10-12T09:00:00.000Z',
      timezone: 'Europe/Berlin',
      roomFeatures: {},
      waitingRoomEnabled: false,
      ...body,
    },
    respond,
  };
}

describe('create_meeting', () => {
  it('creates the meeting with the defaults and reads it back with its join URLs', async () => {
    const tools = await harness([
      loginRequest(),
      createRequest({ status: 201, body: { id: MEETING_ID } }),
      ...meetingOutput(),
    ]);
    const result = await tools.call('create_meeting', QUARTERLY);
    await tools.done();

    assert.equal(
      result.summary,
      `Created meeting ${MEETING_ID} from 2026-10-12 10:00 Europe/Berlin to 2026-10-12 11:00 Europe/Berlin. The join URLs are in the result.`,
    );
    assert.deepEqual(result.data, { ...QUARTERLY_OUTPUT, warnings: [] });
  });

  it('sends every option, and reads the times in the given time zone', async () => {
    const tools = await harness([
      loginRequest(),
      createRequest(
        { status: 201, body: { id: MEETING_ID } },
        {
          start: '2026-11-10T09:00:00.000Z',
          end: '2026-11-10T10:30:00.000Z',
          timezone: 'UTC',
          waitingRoomEnabled: true,
          waitingRoomWelcomeNote: 'Please wait.',
          agenda: 'Budget',
          earlyAccessMinutes: 10,
          passcodeRequired: true,
        },
      ),
      ...meetingOutput(),
    ]);
    const result = await tools.call('create_meeting', {
      title: ' Quarterly Review ',
      start: '2026-11-10T09:00',
      end: '2026-11-10T10:30',
      timezone: 'utc',
      waitingRoomEnabled: true,
      waitingRoomWelcomeNote: 'Please wait.',
      agenda: 'Budget',
      earlyAccessMinutes: 10,
      passcodeRequired: true,
    });
    await tools.done();

    assert.equal(result.isError, false);
  });

  it('sends recurrenceRule as written, with or without its prefix, and gives the recurrence of the result', async () => {
    const weekly = 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10';
    const daily = 'RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261231T230000Z';
    const own = (rule: string) => recurringMeeting({ recurrenceRule: rule, externallyManaged: false });
    const tools = await harness([
      loginRequest(),
      createRequest({ status: 201, body: { id: MEETING_ID } }, { recurrenceRule: weekly }),
      ...meetingOutput(own(weekly)),
      createRequest({ status: 201, body: { id: MEETING_ID } }, { recurrenceRule: daily }),
      ...meetingOutput(own(daily)),
    ]);
    const first = await tools.call('create_meeting', { ...QUARTERLY, recurrenceRule: ` ${weekly} ` });
    const second = await tools.call('create_meeting', { ...QUARTERLY, recurrenceRule: daily });
    await tools.done();

    assert.deepEqual(
      [first.data.recurrenceRule, first.data.externallyManaged, first.data.nextInstance],
      [weekly, false, '2026-10-26T09:00:00+01:00'],
    );
    assert.equal(second.data.recurrenceRule, daily);
  });

  it('refuses each recurrence rule that alfaview would refuse, before any request', async () => {
    const tools = await harness([]);
    for (const [recurrenceRule, message] of RECURRENCE_RULE_REFUSALS) {
      const result = await tools.call('create_meeting', { ...QUARTERLY, recurrenceRule });
      assert.equal(result.isError, true, recurrenceRule);
      assert.equal(result.summary, message, recurrenceRule);
    }
    const blank = await tools.call('create_meeting', { ...QUARTERLY, recurrenceRule: '  ' });
    await tools.done();

    assert.equal(blank.isError, true);
  });

  it('refuses an UNTIL before start, a series without an occurrence, before any request', async () => {
    const tools = await harness([]);
    const result = await tools.call('create_meeting', {
      ...QUARTERLY,
      recurrenceRule: 'FREQ=WEEKLY;UNTIL=20261012T075959Z',
    });
    await tools.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, 'UNTIL of recurrenceRule is before start.');
  });

  it('gives the times of the result and the summary in the time zone of the call', async () => {
    const created = meeting({
      start: '2026-11-10T15:00:00Z',
      end: '2026-11-10T16:30:00Z',
      timezone: 'America/New_York',
    });
    const tools = await harness([
      loginRequest(),
      createRequest(
        { status: 201, body: { id: MEETING_ID } },
        {
          start: '2026-11-10T15:00:00.000Z',
          end: '2026-11-10T16:30:00.000Z',
          timezone: 'America/New_York',
        },
      ),
      ...meetingOutput(created),
    ]);
    const result = await tools.call('create_meeting', {
      ...QUARTERLY,
      start: '10.11.2026 10:00',
      end: '2026-11-10 11:30',
      timezone: 'America/New_York',
    });
    await tools.done();

    assert.equal(
      result.summary,
      `Created meeting ${MEETING_ID} from 2026-11-10 10:00 America/New_York to 2026-11-10 11:30 America/New_York. The join URLs are in the result.`,
    );
    assert.deepEqual(
      [result.data.start, result.data.end, result.data.createdAt],
      ['2026-11-10T10:00:00-05:00', '2026-11-10T11:30:00-05:00', '2026-09-25T06:00:00-04:00'],
    );
  });

  // 500 too: alfaview answers 500 also for a timeout, after which the meeting can exist.
  for (const status of [500, 502, 503, 504]) {
    it(`says that the meeting may exist after HTTP ${status}`, async () => {
      const tools = await harness([
        loginRequest(),
        createRequest({ status, body: fixture('core/problem-500.json') }),
      ]);
      const result = await tools.call('create_meeting', QUARTERLY);
      await tools.done();

      assert.equal(result.isError, true);
      assert.equal(result.summary, MEETING_UNCERTAIN_MESSAGE);
      assert.match(tools.logLines.at(-1)!, /: ServerError, 2 requests/);
    });
  }

  it('says that the meeting may exist after a timeout or a network error', async () => {
    const tools = await harness(
      [
        loginRequest(),
        createRequest({ hang: true }),
        createRequest({ networkError: 'ECONNRESET' }),
      ],
      { timeoutMs: 20 },
    );
    const timeout = await tools.call('create_meeting', QUARTERLY);
    const network = await tools.call('create_meeting', QUARTERLY);
    await tools.done();

    assert.equal(timeout.summary, MEETING_UNCERTAIN_MESSAGE);
    assert.equal(network.summary, MEETING_UNCERTAIN_MESSAGE);
    assert.match(tools.logLines[1]!, /: Timeout, /);
    assert.match(tools.logLines[2]!, /: NetworkError, /);
  });

  it('says that the meeting may exist after a cancel', async () => {
    const controller = new AbortController();
    const { api, fake, logLines } = testApi([loginRequest(), createRequest({ hang: true })], {
      signal: controller.signal,
    });
    const log = createLogger((text) => logLines.push(text));
    const run = createMeetingTool.run(
      { ...QUARTERLY, waitingRoomEnabled: false },
      {
        api,
        now: NOW,
        timeZone: 'Europe/Berlin',
        signal: controller.signal,
        log,
        personalData: 'include',
        level: 'standard',
        confirmation: noQuestions(),
      },
    );
    await untilRequests(fake, 2);
    controller.abort();
    const error = await toolErrorOf(run);
    fake.assertDone();

    assert.equal(error.code, 'Canceled');
    assert.equal(error.message, MEETING_UNCERTAIN_MESSAGE);
  });

  it('keeps the message of a refused create, after which no meeting exists', async () => {
    const tools = await harness([
      loginRequest(),
      createRequest({
        status: 422,
        body: { title: 'Unprocessable Entity', detail: 'no quotas available' },
      }),
    ]);
    const result = await tools.call('create_meeting', QUARTERLY);
    await tools.done();

    assert.equal(result.summary, 'alfaview could not process the input: no quotas available.');
  });

  it('reports an answer without an ID', async () => {
    const tools = await harness([loginRequest(), createRequest({ status: 201, body: {} })]);
    const result = await tools.call('create_meeting', QUARTERLY);
    await tools.done();

    assert.equal(result.summary, 'alfaview did not return the ID of the new meeting.');
  });

  it('says that the meeting exists when reading it back fails', async () => {
    const tools = await harness([
      loginRequest(),
      createRequest({ status: 201, body: { id: MEETING_ID } }),
      meetingRequest({ status: 500, body: fixture('core/problem-500.json') }),
      createRequest({ status: 201, body: { id: '..' } }),
    ]);
    const failed = await tools.call('create_meeting', QUARTERLY);
    const unreadable = await tools.call('create_meeting', QUARTERLY);
    await tools.done();

    assert.equal(failed.summary, meetingCreatedButNotReadMessage(MEETING_ID));
    assert.match(tools.logLines[1]!, /: ServerError, /);
    assert.equal(unreadable.summary, meetingCreatedButNotReadMessage('..'));
    assert.match(tools.logLines[2]!, /: InvalidResponse, /);
  });

  it('checks the input in order before any request', async () => {
    const tools = await harness([]);
    const cases: [Json, string][] = [
      [
        { timezone: 'Local', start: 'soon' },
        'timezone is not a valid time zone. Use a name such as Europe/Berlin.',
      ],
      [{ start: 'soon' }, unrecognizedDateTime('start')],
      [
        { start: '2027-03-28T02:30', end: '2027-03-28T03:30' },
        nonexistentLocalTime('start', '2027-03-28T02:30', 'Europe/Berlin'),
      ],
      [{ end: 'later', recurrenceRule: 'FREQ=HOURLY' }, unrecognizedDateTime('end')],
      [
        { end: '2026-10-12T10:00', recurrenceRule: 'FREQ=HOURLY' },
        'recurrenceRule must repeat daily or less often.',
      ],
      [{ end: '2026-10-12T10:00' }, 'end must be after start.'],
      [{ end: '2026-10-13T10:01' }, 'end must be at most 24 hours after start.'],
      [{ start: '2026-10-06T10:00', end: '2026-10-06T11:00' }, 'end is in the past. Choose a time in the future.'],
      [{ start: '2027-10-08T10:00', end: '2027-10-08T11:00' }, 'start must be at most 365 days from now.'],
    ];
    for (const [change, message] of cases) {
      const result = await tools.call('create_meeting', { ...QUARTERLY, ...change });
      assert.equal(result.summary, message);
    }
    const title = await tools.call('create_meeting', { ...QUARTERLY, title: '  ' });
    const early = await tools.call('create_meeting', { ...QUARTERLY, earlyAccessMinutes: 31 });
    await tools.done();

    assert.equal(title.isError, true);
    assert.equal(early.isError, true);
  });
});

describe('update_meeting', () => {
  const patch = (body: Json): ExpectedRequest => ({
    method: 'PATCH',
    path: `/v2/meetings/${MEETING_ID}`,
    body,
    respond: { status: 204 },
  });

  it('changes the given fields of a meeting without guest links', async () => {
    const tools = await harness([
      loginRequest(),
      meetingRequest({ status: 200, body: meeting() }),
      patch({ title: 'Annual Review', agenda: 'Plans', earlyAccessMinutes: 0 }),
      meetingRequest({ status: 200, body: meeting({ title: 'Annual Review' }) }),
    ]);
    const result = await tools.call('update_meeting', {
      meetingId: MEETING_ID,
      title: 'Annual Review',
      agenda: 'Plans',
      earlyAccessMinutes: 0,
    });
    await tools.done();

    assert.equal(
      result.summary,
      `Updated meeting ${MEETING_ID}, from 2026-10-12 10:00 Europe/Berlin to 2026-10-12 11:00 Europe/Berlin.`,
    );
    // The meeting without its join URLs, which the change does not need.
    const { groupLinks, ...details } = QUARTERLY_OUTPUT;
    assert.equal(groupLinks.length, 4);
    assert.deepEqual(result.data, { ...details, title: 'Annual Review', warnings: [] });
  });

  it('gives the next instance of a recurring meeting in the time zone of the call', async () => {
    const own = recurringMeeting({ externallyManaged: false });
    const tools = await harness([
      loginRequest(),
      meetingRequest({ status: 200, body: own }),
      patch({ timezone: 'UTC' }),
      meetingRequest({ status: 200, body: own }),
    ]);
    const result = await tools.call('update_meeting', { meetingId: MEETING_ID, timezone: 'utc' });
    await tools.done();

    assert.deepEqual(
      [result.data.recurrenceRule, result.data.externallyManaged, result.data.nextInstance],
      [RULE, false, '2026-10-26T08:00:00+00:00'],
    );
  });

  // The refusal comes before the guard of the guest links: sendEmail true would not open it.
  it('refuses an externally managed meeting at the level standard, before the change', async () => {
    const tools = await harness([
      loginRequest(),
      meetingRequest({ status: 200, body: recurringMeeting({ guestLinks: GUEST_LINK_IDS }) }),
    ]);
    const result = await tools.call('update_meeting', { meetingId: MEETING_ID, title: 'New' });
    await tools.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, EXTERNALLY_MANAGED_MESSAGE);
    assert.match(tools.logLines.at(-1)!, /: ExternallyManagedRefused, 2 requests/);
  });

  for (const level of ['manage', 'full'] as const) {
    it(`changes an externally managed meeting at the level ${level}, with one read before the change`, async () => {
      const tools = await harness(
        [
          loginRequest(),
          meetingRequest({ status: 200, body: recurringMeeting() }),
          patch({ title: 'New' }),
          meetingRequest({ status: 200, body: recurringMeeting({ title: 'New' }) }),
        ],
        { level },
      );
      const result = await tools.call('update_meeting', { meetingId: MEETING_ID, title: 'New' });
      await tools.done();

      assert.equal(result.isError, false);
      assert.deepEqual([result.data.title, result.data.externallyManaged], ['New', true]);
    });
  }

  it('refuses a meeting with guest links without sendEmail, before the change', async () => {
    const tools = await harness([
      loginRequest(),
      meetingRequest({ status: 200, body: meeting({ guestLinks: GUEST_LINK_IDS }) }),
    ]);
    const result = await tools.call('update_meeting', { meetingId: MEETING_ID, title: 'New' });
    await tools.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, meetingInviteeEmailMessage(2));
    assert.match(tools.logLines.at(-1)!, /: MeetingInviteeEmail, 2 requests/);
  });

  it('changes a meeting with guest links with sendEmail, and says that alfaview can email them', async () => {
    const withGuests = meeting({ guestLinks: GUEST_LINK_IDS });
    const tools = await harness([
      loginRequest(),
      meetingRequest({ status: 200, body: withGuests }),
      patch({ title: 'New' }),
      meetingRequest({ status: 200, body: withGuests }),
    ]);
    const result = await tools.call('update_meeting', {
      meetingId: MEETING_ID,
      title: 'New',
      sendEmail: true,
    });
    await tools.done();

    assert.match(result.summary, / alfaview can email its 2 guests about the change\.$/);
  });

  // The tool never sends sendEmail, so for a meeting without guest links it changes nothing.
  it('says that sendEmail had no effect on a meeting without guest links', async () => {
    const tools = await harness([
      loginRequest(),
      meetingRequest({ status: 200, body: meeting() }),
      patch({ title: 'New' }),
      meetingRequest({ status: 200, body: meeting({ title: 'New' }) }),
    ]);
    const result = await tools.call('update_meeting', {
      meetingId: MEETING_ID,
      title: 'New',
      sendEmail: true,
    });
    await tools.done();

    assert.equal(
      result.summary,
      `Updated meeting ${MEETING_ID}, from 2026-10-12 10:00 Europe/Berlin to 2026-10-12 11:00 Europe/Berlin. The meeting has no guest links, so sendEmail had no effect.`,
    );
  });

  it('says that the change is saved when reading the meeting back fails', async () => {
    const tools = await harness([
      loginRequest(),
      meetingRequest({ status: 200, body: meeting() }),
      patch({ title: 'New' }),
      meetingRequest({ status: 503, body: fixture('core/problem-500.json') }),
    ]);
    const result = await tools.call('update_meeting', { meetingId: MEETING_ID, title: 'New' });
    await tools.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, meetingUpdatedButNotReadMessage(MEETING_ID));
    assert.match(result.summary, /Do not repeat the change/);
    assert.match(tools.logLines.at(-1)!, /: ServerError, 4 requests/);
  });

  it('makes a meeting recurring with only recurrenceRule, which keeps the start', async () => {
    const recurring = recurringMeeting({ recurrenceRule: 'FREQ=WEEKLY', externallyManaged: false });
    const tools = await harness([
      loginRequest(),
      meetingRequest({ status: 200, body: meeting() }),
      patch({ recurrenceRule: 'FREQ=WEEKLY' }),
      meetingRequest({ status: 200, body: recurring }),
    ]);
    const result = await tools.call('update_meeting', {
      meetingId: MEETING_ID,
      recurrenceRule: 'FREQ=WEEKLY',
    });
    await tools.done();

    assert.equal(
      result.summary,
      `Updated meeting ${MEETING_ID}, from 2026-10-12 10:00 Europe/Berlin to 2026-10-12 11:00 Europe/Berlin.`,
    );
    assert.deepEqual(
      [result.data.recurrenceRule, result.data.nextInstance],
      ['FREQ=WEEKLY', '2026-10-26T09:00:00+01:00'],
    );
  });

  it('sends recurrenceRule with the other fields, and start and end together', async () => {
    const tools = await harness([
      loginRequest(),
      meetingRequest({ status: 200, body: meeting() }),
      patch({
        title: 'Weekly Review',
        start: '2026-10-12T07:30:00.000Z',
        end: '2026-10-12T09:00:00.000Z',
        recurrenceRule: 'RRULE:FREQ=WEEKLY;UNTIL=20261231T230000Z',
      }),
      meetingRequest({ status: 200, body: recurringMeeting({ externallyManaged: false }) }),
    ]);
    const result = await tools.call('update_meeting', {
      meetingId: MEETING_ID,
      title: 'Weekly Review',
      start: '2026-10-12T09:30',
      recurrenceRule: 'RRULE:FREQ=WEEKLY;UNTIL=20261231T230000Z',
    });
    await tools.done();

    assert.equal(result.isError, false);
  });

  it('refuses each recurrence rule that alfaview would refuse, before any request', async () => {
    const tools = await harness([]);
    for (const [recurrenceRule, message] of RECURRENCE_RULE_REFUSALS) {
      const result = await tools.call('update_meeting', { meetingId: MEETING_ID, recurrenceRule });
      assert.equal(result.isError, true, recurrenceRule);
      assert.equal(result.summary, message, recurrenceRule);
    }
    const blank = await tools.call('update_meeting', { meetingId: MEETING_ID, recurrenceRule: '' });
    await tools.done();

    assert.equal(blank.isError, true);
  });

  it('refuses an UNTIL before a new start, before any request', async () => {
    const tools = await harness([]);
    const result = await tools.call('update_meeting', {
      meetingId: MEETING_ID,
      start: '2026-10-12T10:00',
      end: '2026-10-12T11:00',
      recurrenceRule: 'FREQ=WEEKLY;UNTIL=20261012T075959Z',
    });
    await tools.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, 'UNTIL of recurrenceRule is before start.');
  });

  it('leaves an UNTIL before the current start to alfaview when the call has no start', async () => {
    const tools = await harness([
      loginRequest(),
      meetingRequest({ status: 200, body: meeting() }),
      patch({ recurrenceRule: 'FREQ=WEEKLY;UNTIL=20261011T000000Z' }),
      meetingRequest({ status: 200, body: recurringMeeting({ externallyManaged: false }) }),
    ]);
    const result = await tools.call('update_meeting', {
      meetingId: MEETING_ID,
      recurrenceRule: 'FREQ=WEEKLY;UNTIL=20261011T000000Z',
    });
    await tools.done();

    assert.equal(result.isError, false);
  });

  it('sends start and end together when only the start changes', async () => {
    const tools = await harness([
      loginRequest(),
      meetingRequest({ status: 200, body: meeting() }),
      patch({ start: '2026-10-12T07:30:00.000Z', end: '2026-10-12T09:00:00.000Z' }),
      meetingRequest({ status: 200, body: meeting() }),
    ]);
    const result = await tools.call('update_meeting', {
      meetingId: MEETING_ID,
      start: '2026-10-12T09:30',
    });
    await tools.done();

    assert.equal(result.isError, false);
  });

  it('takes the current start when only the end changes, and reads and gives times in the given zone', async () => {
    const stored = meeting({ end: '2026-10-12T10:00:00Z', timezone: 'UTC' });
    const tools = await harness([
      loginRequest(),
      meetingRequest({ status: 200, body: meeting() }),
      patch({ start: '2026-10-12T08:00:00.000Z', end: '2026-10-12T10:00:00.000Z', timezone: 'UTC' }),
      meetingRequest({ status: 200, body: stored }),
    ]);
    const result = await tools.call('update_meeting', {
      meetingId: MEETING_ID,
      end: '2026-10-12T10:00',
      timezone: 'utc',
    });
    await tools.done();

    assert.equal(
      result.summary,
      `Updated meeting ${MEETING_ID}, from 2026-10-12 08:00 UTC to 2026-10-12 10:00 UTC.`,
    );
    assert.deepEqual(
      [result.data.start, result.data.end, result.data.timezone],
      ['2026-10-12T08:00:00+00:00', '2026-10-12T10:00:00+00:00', 'UTC'],
    );
  });

  it("reads and gives times in the server's zone without timezone, which it does not send", async () => {
    const tools = await harness(
      [
        loginRequest(),
        meetingRequest({ status: 200, body: meeting() }),
        patch({ start: '2026-10-12T13:00:00.000Z', end: '2026-10-12T14:00:00.000Z' }),
        meetingRequest({
          status: 200,
          body: meeting({ start: '2026-10-12T13:00:00Z', end: '2026-10-12T14:00:00Z' }),
        }),
      ],
      { timeZone: 'America/New_York' },
    );
    const result = await tools.call('update_meeting', {
      meetingId: MEETING_ID,
      start: '2026-10-12 09:00',
      end: '12.10.2026 10:00',
    });
    await tools.done();

    assert.equal(
      result.summary,
      `Updated meeting ${MEETING_ID}, from 2026-10-12 09:00 America/New_York to 2026-10-12 10:00 America/New_York.`,
    );
    assert.deepEqual(
      [result.data.start, result.data.timezone],
      ['2026-10-12T09:00:00-04:00', 'Europe/Berlin'],
    );
  });

  it('checks the schedule with the current times', async () => {
    const tools = await harness([
      loginRequest(),
      meetingRequest({ status: 200, body: meeting() }),
      meetingRequest({ status: 200, body: meeting({ start: '0001-01-01T00:00:00Z' }) }),
      meetingRequest({ status: 200, body: meeting({ end: undefined }) }),
    ]);
    const tooLong = await tools.call('update_meeting', {
      meetingId: MEETING_ID,
      end: '2026-10-13T11:00',
    });
    const noStart = await tools.call('update_meeting', {
      meetingId: MEETING_ID,
      end: '2026-10-12T12:00',
    });
    const noEnd = await tools.call('update_meeting', {
      meetingId: MEETING_ID,
      start: '2026-10-12T09:00',
    });
    await tools.done();

    assert.equal(tooLong.summary, 'end must be at most 24 hours after start.');
    assert.equal(noStart.summary, MEETING_WITHOUT_TIMES_MESSAGE);
    assert.equal(noEnd.summary, MEETING_WITHOUT_TIMES_MESSAGE);
  });

  it('checks the input before any request', async () => {
    const tools = await harness([]);
    const none = await tools.call('update_meeting', { meetingId: MEETING_ID, sendEmail: true });
    const zone = await tools.call('update_meeting', { meetingId: MEETING_ID, timezone: 'Local' });
    const date = await tools.call('update_meeting', { meetingId: MEETING_ID, start: 'tomorrow' });
    await tools.done();

    assert.equal(none.summary, 'Give at least one field to change.');
    assert.equal(zone.summary, 'timezone is not a valid time zone. Use a name such as Europe/Berlin.');
    assert.match(date.summary, /^start is not a valid date and time\./);
  });
});

describe('cancel_meeting', () => {
  const cancel = (body: Json, respond: FakeAnswer = { status: 204 }): ExpectedRequest => ({
    method: 'POST',
    path: `/v2/meetings/${MEETING_ID}/cancellation`,
    body,
    respond,
  });
  const canceled = meeting({ state: 'canceled', canceledAt: '2026-10-07T08:00:00Z' });
  /** The read of the level standard before the cancellation. */
  const readFirst = (body: Json = meeting()): ExpectedRequest =>
    meetingRequest({ status: 200, body });

  it('cancels without an email by default', async () => {
    const tools = await harness([
      loginRequest(),
      readFirst(),
      cancel({ sendNotification: false }),
      meetingRequest({ status: 200, body: canceled }),
    ]);
    const result = await tools.call('cancel_meeting', { meetingId: MEETING_ID });
    await tools.done();

    assert.equal(result.summary, `Canceled meeting ${MEETING_ID}. alfaview sent no email.`);
    assert.equal(result.data.state, 'canceled');
    assert.equal(result.data.canceledAt, '2026-10-07T10:00:00+02:00');
    assert.ok(!('groupLinks' in result.data));
    assert.equal(result.data.nextInstance, null);
  });

  it('gives the recurrence of a canceled recurring meeting', async () => {
    const tools = await harness([
      loginRequest(),
      readFirst(recurringMeeting({ externallyManaged: false })),
      cancel({ sendNotification: false }),
      meetingRequest({
        status: 200,
        body: recurringMeeting({ state: 'canceled', externallyManaged: false }),
      }),
    ]);
    const result = await tools.call('cancel_meeting', { meetingId: MEETING_ID });
    await tools.done();

    assert.deepEqual(
      [result.data.recurrenceRule, result.data.externallyManaged, result.data.nextInstance],
      [RULE, false, '2026-10-26T09:00:00+01:00'],
    );
  });

  it('refuses an externally managed meeting at the level standard, without the cancellation', async () => {
    const tools = await harness([loginRequest(), readFirst(recurringMeeting())]);
    const result = await tools.call('cancel_meeting', { meetingId: MEETING_ID, sendEmail: true });
    await tools.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, EXTERNALLY_MANAGED_MESSAGE);
    assert.match(tools.logLines.at(-1)!, /: ExternallyManagedRefused, 2 requests/);
  });

  for (const level of ['manage', 'full'] as const) {
    it(`cancels an externally managed meeting at the level ${level}, with no read before the cancellation`, async () => {
      const tools = await harness(
        [
          loginRequest(),
          cancel({ sendNotification: false }),
          meetingRequest({ status: 200, body: recurringMeeting({ state: 'canceled' }) }),
        ],
        { level },
      );
      const result = await tools.call('cancel_meeting', { meetingId: MEETING_ID });
      await tools.done();

      assert.equal(result.isError, false);
      assert.deepEqual([result.data.state, result.data.externallyManaged], ['canceled', true]);
    });
  }

  it('asks alfaview to email the creator and the invitees with sendEmail, with the reason', async () => {
    const tools = await harness([
      loginRequest(),
      readFirst(),
      cancel({ sendNotification: true, reason: 'The advisor is ill.' }),
      meetingRequest({ status: 200, body: canceled }),
    ]);
    const result = await tools.call('cancel_meeting', {
      meetingId: MEETING_ID,
      sendEmail: true,
      reason: 'The advisor is ill.',
    });
    await tools.done();

    assert.equal(
      result.summary,
      `Canceled meeting ${MEETING_ID}. alfaview emails the creator and the invitees.`,
    );
  });

  it('says that the meeting is canceled when reading it back fails', async () => {
    const tools = await harness(
      [
        loginRequest(),
        readFirst(),
        cancel({ sendNotification: true }),
        meetingRequest({ hang: true }),
      ],
      { timeoutMs: 20 },
    );
    const result = await tools.call('cancel_meeting', { meetingId: MEETING_ID, sendEmail: true });
    await tools.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, meetingCanceledButNotReadMessage(MEETING_ID));
    assert.match(result.summary, /Do not cancel it again/);
    assert.match(tools.logLines.at(-1)!, /: Timeout, 4 requests/);
  });

  it('reports a meeting that alfaview cannot find, at the read and at the cancellation', async () => {
    const notFound: FakeAnswer = { status: 404, body: fixture('core/problem-404.json') };
    const standard = await harness([loginRequest(), meetingRequest(notFound)]);
    const atStandard = await standard.call('cancel_meeting', { meetingId: MEETING_ID });
    await standard.done();
    const manage = await harness(
      [loginRequest(), cancel({ sendNotification: false }, notFound)],
      { level: 'manage' },
    );
    const atManage = await manage.call('cancel_meeting', { meetingId: MEETING_ID });
    await manage.done();

    assert.match(atStandard.summary, /^alfaview could not find the meeting\./);
    assert.match(atManage.summary, /^alfaview could not find the meeting\./);
  });
});
