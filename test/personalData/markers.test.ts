// The marker test of the option Personal data for every tool of the server. Each case calls its
// tool three times, each on a new fake company of markerState.ts: without the option, with Include
// and with Leave out. A new tool fails the first test until it has a case.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { AlfaviewClient } from '../../src/alfaview/client.ts';
import { createLogger } from '../../src/log.ts';
import { stdioServerFactory, TOOLS } from '../../src/server.ts';
import { PERSONAL_KEYS, type PersonalDataMode } from '../../src/shared/personalData.ts';
import type { AnyTool } from '../../src/tools/tool.ts';
import { createFakeApi, fakeApiFetch, type FakeRequest } from '../fake-api/server.ts';
import { loginRequest, TEST_CONFIG } from '../helpers/fakeFetch.ts';
import { assertToolOutput, connectModern, connectTools, toolHarness } from '../helpers/mcpClient.ts';
import {
  expectRemoved,
  holds,
  isUnder,
  leavesOf,
  removedPaths,
} from './markerChecks.ts';
import {
  ANNA_LINK_ID,
  APPOINTMENT_FROM,
  APPOINTMENT_ORIGIN,
  APPOINTMENT_UNTIL,
  BEN_USER_ID,
  CARLA_USER_ID,
  DEPARTMENT_ID,
  DORA_LINK_ID,
  GROUP_LINK_ID,
  GROUP_LINK_ORIGIN,
  iso,
  KEPT_GROUP_NAME,
  KEPT_MARKER,
  markedEmail,
  markedName,
  markerState,
  MEETING_ID,
  PERSONAL_MARKER,
  ROOM_ID,
  SUBROOM_ID,
  T0,
  WEBINAR_ORIGIN,
} from './markerState.ts';

type Mode = PersonalDataMode | undefined;

type MarkerCase = {
  tool: string;
  /** Tells two cases of one tool apart. */
  label?: string;
  args: Record<string, unknown>;
  /** Whether the result with Include holds the personal marker. */
  personal: boolean;
  /** Whether the result holds the kept marker, with Include and with Leave out. */
  kept: boolean;
  /** The data paths that hold a meeting room's name, which Leave out sets to null too. */
  meetingRoomName?: readonly string[];
  /**
   * Whether the result with Leave out gets the warning of Leave out, by default `personal`. A
   * marker only in an echo of the input is no value of alfaview.
   */
  leftOut?: boolean;
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The warning of a result whose personal values Leave out set to null. */
const LEFT_OUT_WARNING =
  /^This server leaves out personal data \(option Personal data, Leave out\): [a-z ,]+ are null, also where alfaview has a value\.$/;

const CASES: readonly MarkerCase[] = [
  { tool: 'find_rooms', args: {}, personal: false, kept: true },
  { tool: 'find_rooms', label: 'departments', args: { type: 'department' }, personal: false, kept: true },
  { tool: 'get_room', args: { roomId: ROOM_ID, includePasscode: true }, personal: true, kept: true },
  {
    tool: 'get_room',
    label: 'the room of a meeting',
    args: { roomId: MEETING_ID },
    personal: true,
    kept: false,
    meetingRoomName: ['displayName'],
  },
  { tool: 'regenerate_room_passcode', args: { roomId: ROOM_ID }, personal: false, kept: false },
  {
    tool: 'find_guest_links',
    args: { roomId: ROOM_ID, includeExpired: true, includeJoinUrls: true },
    personal: true,
    kept: true,
  },
  {
    tool: 'find_guest_links',
    label: 'every room, by email address and origin',
    args: { emailAddress: markedEmail('anna'), origin: WEBINAR_ORIGIN, includeExpired: true },
    personal: true,
    kept: true,
  },
  {
    tool: 'create_guest_links',
    args: {
      roomId: ROOM_ID,
      guests: [
        { emailAddress: markedEmail('new'), displayName: markedName('New') },
        { emailAddress: markedEmail('dora'), displayName: markedName('Dora') },
      ],
      locale: 'de-DE',
      validFrom: iso(APPOINTMENT_FROM),
      validUntil: iso(APPOINTMENT_UNTIL),
      permissionGroup: KEPT_GROUP_NAME,
      origin: APPOINTMENT_ORIGIN,
    },
    personal: true,
    kept: true,
  },
  {
    tool: 'update_guest_link',
    args: { guestLinkId: DORA_LINK_ID, displayName: markedName('Dorothea'), validUntil: iso(T0 + 2 * HOUR_MS) },
    personal: true,
    kept: true,
  },
  { tool: 'delete_guest_link', args: { guestLinkId: DORA_LINK_ID }, personal: false, kept: false },
  // originContains is the filter of the call: Leave out sets it to null without the warning.
  {
    tool: 'delete_expired_guest_links',
    args: { roomId: ROOM_ID, originContains: PERSONAL_MARKER },
    personal: true,
    kept: false,
    leftOut: false,
  },
  { tool: 'find_meetings', args: {}, personal: true, kept: false },
  { tool: 'get_meeting', args: { meetingId: MEETING_ID }, personal: true, kept: true },
  {
    tool: 'create_meeting',
    args: {
      title: `Kickoff ${PERSONAL_MARKER}`,
      start: iso(T0 + 3 * DAY_MS),
      end: iso(T0 + 3 * DAY_MS + HOUR_MS),
      agenda: `Plan ${PERSONAL_MARKER}`,
      waitingRoomWelcomeNote: `Hello ${PERSONAL_MARKER}`,
    },
    personal: true,
    kept: true,
  },
  {
    tool: 'update_meeting',
    args: { meetingId: MEETING_ID, title: `Moved ${PERSONAL_MARKER}` },
    personal: true,
    kept: false,
  },
  { tool: 'cancel_meeting', args: { meetingId: MEETING_ID }, personal: true, kept: false },
  { tool: 'find_room_participants', args: { roomId: ROOM_ID }, personal: true, kept: false },
  {
    tool: 'get_room_attendance',
    args: { roomId: ROOM_ID, origin: WEBINAR_ORIGIN, minimumMinutes: 15, includeOtherAttendees: true },
    personal: true,
    kept: false,
  },
  {
    tool: 'get_guest_link_attendance',
    args: { guestLinkId: ANNA_LINK_ID },
    personal: true,
    kept: false,
  },
  {
    tool: 'get_company_statistics',
    args: { from: iso(T0 - 7 * DAY_MS), to: iso(T0) },
    personal: false,
    kept: false,
  },
  // The profile holds the marker, and the company name, which is no personal data, the kept one.
  { tool: 'get_account', args: {}, personal: true, kept: true },
  {
    tool: 'update_own_user',
    args: { firstName: markedName('Anna'), city: markedName('Hamburg') },
    personal: true,
    kept: false,
  },
  {
    tool: 'create_room',
    args: {
      displayName: `Project Room ${KEPT_MARKER}`,
      waitingRoomEnabled: true,
      waitingRoomWelcomeNote: `Welcome ${PERSONAL_MARKER}`,
    },
    personal: true,
    kept: true,
  },
  { tool: 'update_room', args: { roomId: ROOM_ID, passcodeRequired: true }, personal: true, kept: true },
  {
    tool: 'update_room',
    label: 'the room of a meeting',
    args: { roomId: MEETING_ID, waitingRoomEnabled: true },
    personal: true,
    kept: false,
    meetingRoomName: ['displayName'],
  },
  // The room settings hold codes, states and counts only, so both modes give the same result.
  { tool: 'get_room_settings', args: { roomId: ROOM_ID }, personal: false, kept: false },
  {
    tool: 'update_room_settings',
    args: {
      roomId: ROOM_ID,
      features: { examScreenshare: 'enabled' },
      resetFeatures: true,
      language: { defaultSpokenLanguage: 'en-US', targetTranscriptionLanguages: ['de-DE'] },
      fileSharing: { participantsCanUpload: true },
    },
    personal: false,
    kept: false,
  },
  // A breakout room name is company configuration and stays.
  {
    tool: 'create_breakout_room',
    args: { roomId: ROOM_ID, displayName: `Breakout 2 ${KEPT_MARKER}` },
    personal: false,
    kept: true,
  },
  {
    tool: 'update_breakout_room',
    args: { roomId: ROOM_ID, subroomId: SUBROOM_ID, displayName: `Renamed ${KEPT_MARKER}` },
    personal: false,
    kept: true,
  },
  {
    tool: 'delete_breakout_room',
    args: { roomId: ROOM_ID, subroomId: SUBROOM_ID },
    personal: false,
    kept: false,
  },
  // The origin of a group link is free text. Its description and the name of its permission group
  // are company configuration and stay.
  {
    tool: 'find_group_links',
    args: { roomId: ROOM_ID, includeExpired: true, includeJoinUrls: true },
    personal: true,
    kept: true,
  },
  {
    tool: 'find_group_links',
    label: 'every room, by description and origin',
    args: { description: 'open house', originContains: GROUP_LINK_ORIGIN },
    personal: true,
    kept: true,
  },
  {
    tool: 'create_group_link',
    args: {
      roomId: ROOM_ID,
      description: `Workshop ${KEPT_MARKER}`,
      permissionGroup: KEPT_GROUP_NAME,
      validFrom: iso(T0 + 2 * DAY_MS),
      validUntil: iso(T0 + 2 * DAY_MS + HOUR_MS),
      origin: `Workshop ${PERSONAL_MARKER}`,
    },
    personal: true,
    kept: true,
  },
  {
    tool: 'update_group_link',
    args: { groupLinkId: GROUP_LINK_ID, description: `Open day ${KEPT_MARKER}` },
    personal: true,
    kept: true,
  },
  { tool: 'delete_group_link', args: { groupLinkId: GROUP_LINK_ID }, personal: false, kept: false },
  // The filters match the full values also with Leave out: the removal runs after all logic.
  { tool: 'find_users', args: {}, personal: true, kept: false },
  {
    tool: 'find_users',
    label: 'by name and email address',
    args: { name: 'BEN', emailAddress: markedEmail('Ben') },
    personal: true,
    kept: false,
  },
  // The names of the users come from the user list.
  { tool: 'find_room_permissions', args: { roomId: ROOM_ID }, personal: true, kept: false },
  {
    tool: 'find_room_permissions',
    label: 'one user',
    args: { roomId: ROOM_ID, userId: BEN_USER_ID },
    personal: true,
    kept: false,
  },
  // The name of the permission group is company configuration and stays.
  {
    tool: 'add_room_permission',
    args: { roomId: ROOM_ID, userId: CARLA_USER_ID, permissionGroup: KEPT_GROUP_NAME, chat: true },
    personal: false,
    kept: true,
  },
  {
    tool: 'update_room_permission',
    args: { roomId: ROOM_ID, userId: BEN_USER_ID, admin: false, chat: false },
    personal: false,
    kept: false,
  },
  {
    tool: 'remove_room_permission',
    args: { roomId: ROOM_ID, userId: BEN_USER_ID },
    personal: false,
    kept: false,
  },
  {
    tool: 'invite_user',
    args: {
      emailAddress: markedEmail('nina'),
      firstName: markedName('Nina'),
      lastName: markedName('New'),
      title: `Dr ${PERSONAL_MARKER}`,
      locale: 'de-DE',
      userList: true,
      sendEmail: true,
    },
    personal: true,
    kept: false,
  },
  {
    tool: 'delete_user',
    args: { userId: BEN_USER_ID, confirmEmailAddress: markedEmail('ben') },
    personal: false,
    kept: false,
  },
  // The result holds no name, also not the kept name of the room.
  {
    tool: 'delete_room',
    args: { roomId: ROOM_ID, confirmRoomName: `advisory room ${KEPT_MARKER}` },
    personal: false,
    kept: false,
  },
  {
    tool: 'delete_room',
    label: 'a department',
    args: { roomId: DEPARTMENT_ID, confirmRoomName: `Advisors ${KEPT_MARKER}` },
    personal: false,
    kept: false,
  },
];

function caseName(entry: MarkerCase): string {
  return entry.label === undefined ? entry.tool : `${entry.tool}, ${entry.label}`;
}

function toolOf(name: string): AnyTool {
  const tool = TOOLS.find((item) => item.name === name);
  assert.ok(tool !== undefined, name);
  return tool;
}

type Run = {
  result: CallToolResult;
  summary: string;
  data: Record<string, unknown>;
  requests: FakeRequest[];
};

/** Calls the tool of the case once on a new state of the company, with the option in `mode`. */
async function run(entry: MarkerCase, mode: Mode): Promise<Run> {
  const api = createFakeApi(markerState(), { now: () => T0 });
  const connected = await connectTools(TOOLS, {
    fetch: fakeApiFetch(api),
    now: () => T0,
    ...(mode === undefined ? {} : { personalData: mode }),
  });
  const result = (await connected.client.callTool({
    name: entry.tool,
    arguments: entry.args,
  })) as CallToolResult;

  const content = result.content as { type: 'text'; text: string }[];
  assert.notEqual(result.isError, true, `${caseName(entry)}: ${content[0]?.text}`);
  assert.equal(content.length, 2);
  const data = JSON.parse(content[1]!.text) as Record<string, unknown>;
  assert.deepEqual(data, result.structuredContent);
  // One output schema fits both values of the option.
  await assertToolOutput(connected.client, entry.tool, data);
  await connected.close();
  return { result, summary: content[0]!.text, data, requests: api.requests };
}

/** The data of each case with Include, for the check of the paths below. */
const recorded: { entry: MarkerCase; data: Record<string, unknown> }[] = [];

describe('Personal data in the results of every tool', () => {
  it('has a case for every tool of the server', () => {
    const covered = new Set(CASES.map((entry) => entry.tool));
    assert.deepEqual([...covered].sort(), TOOLS.map((tool) => tool.name).sort());
  });

  it('names a shape of the server for every tool, and each shape of the server is a tool shape', () => {
    const shapes = new Set(TOOLS.map((tool) => tool.personalData.shape));
    const serverShapes = Object.keys(PERSONAL_KEYS).filter((shape) => shape.startsWith('mcp.'));
    assert.deepEqual([...shapes].sort(), serverShapes.sort());
  });

  for (const entry of CASES) {
    it(caseName(entry), async () => {
      const missing = await run(entry, undefined);
      const include = await run(entry, 'include');
      const omit = await run(entry, 'omit');
      recorded.push({ entry, data: include.data });

      // An entry without the option gives the results of Include, byte for byte, and the option
      // never changes a request.
      assert.equal(JSON.stringify(include.result), JSON.stringify(missing.result));
      assert.deepEqual(include.requests, missing.requests);
      assert.deepEqual(omit.requests, include.requests);

      // The personal marker with Include gives each check of Leave out a value to remove.
      assert.equal(holds(include.result, PERSONAL_MARKER), entry.personal, 'personal marker');
      assert.equal(holds(include.result, KEPT_MARKER), entry.kept, 'kept marker');
      assert.ok(!holds(include.summary, PERSONAL_MARKER), 'a summary holds no name');
      // The summary of a successful call holds no text from alfaview, also not the names that stay
      // with Leave out: a client is most likely to show and to keep the summary.
      assert.ok(!holds(include.summary, KEPT_MARKER), `a summary holds no kept value: ${include.summary}`);
      assert.ok(!holds(omit.summary, KEPT_MARKER), 'a summary with Leave out holds no kept value');

      assert.ok(!holds(omit.result, PERSONAL_MARKER), JSON.stringify(omit.result));
      assert.equal(holds(omit.result, KEPT_MARKER), entry.kept, 'kept marker with Leave out');

      // The warning of Leave out comes after the warnings of the tool, which keep their order.
      const includeWarnings = include.data.warnings as string[];
      const omitWarnings = omit.data.warnings as string[];
      const leftOut = omitWarnings.slice(includeWarnings.length);
      assert.deepEqual(omitWarnings.slice(0, includeWarnings.length), includeWarnings);
      const warned = entry.leftOut ?? entry.personal;
      assert.equal(leftOut.length, warned ? 1 : 0, `the warning of Leave out: ${leftOut}`);
      for (const warning of leftOut) {
        assert.match(warning, LEFT_OUT_WARNING);
        assert.ok(!holds(warning, PERSONAL_MARKER) && !holds(warning, KEPT_MARKER), warning);
      }
      assert.equal(omit.summary, [include.summary, ...leftOut].join(' '));
      const paths = removedPaths(toolOf(entry.tool).personalData, entry.meetingRoomName);
      expectRemoved({ ...include.data, warnings: null }, { ...omit.data, warnings: null }, paths);
    });
  }

  // Runs after the cases, in the order of this block.
  it('holds the personal marker in every path of every shape, in at least one case', () => {
    assert.equal(recorded.length, CASES.length);
    const marked = new Set<string>();
    for (const { entry, data } of recorded) {
      const { shape, list } = toolOf(entry.tool).personalData;
      const prefix = list === undefined ? '' : `${list}[].`;
      for (const path of PERSONAL_KEYS[shape] as readonly string[]) {
        const leaves = leavesOf(data).filter((leaf) => isUnder(leaf.keys, [`${prefix}${path}`]));
        if (leaves.some((leaf) => holds(leaf.value, PERSONAL_MARKER))) marked.add(`${shape} ${path}`);
      }
    }
    const all = Object.entries(PERSONAL_KEYS)
      .filter(([shape]) => shape.startsWith('mcp.'))
      .flatMap(([shape, paths]) => (paths as readonly string[]).map((path) => `${shape} ${path}`));
    assert.deepEqual(all.filter((path) => !marked.has(path)), []);
  });
});

// The request state of the question before a delete is signed, not encrypted, so the client can
// read it in clear. It holds a version, the tool, the ID, the round and a random nonce, and no
// name, no email address and no hash of either, in both modes.
describe('Personal data in the question before a delete and in its request state', () => {
  type Asked = { message: string; requestState: string };

  /**
   * Runs round 1 of `tool` in the protocol era 2026-07-28, as a client that declares form mode and
   * fulfills nothing, and returns the question and the request state.
   */
  async function asked(tool: string, args: Record<string, unknown>, mode: PersonalDataMode): Promise<Asked> {
    const api = createFakeApi(markerState(), { now: () => T0 });
    const log = createLogger(() => undefined);
    const factory = stdioServerFactory({
      client: new AlfaviewClient({ config: TEST_CONFIG, fetch: fakeApiFetch(api), log, now: () => T0 }),
      log,
      level: 'full',
      timeZone: 'Europe/Berlin',
      now: () => T0,
      personalData: mode,
    });
    const modern = await connectModern(factory, {
      asking: { answer: () => ({ action: 'decline' }) },
      autoFulfill: false,
    });
    const result = (await modern.client.request(
      { method: 'tools/call', params: { name: tool, arguments: args } } as never,
      { allowInputRequired: true },
    )) as {
      inputRequests: Record<string, { params: { message: string } }>;
      requestState: string;
    };
    await modern.close();
    assert.ok(!api.requests.some((request) => request.method === 'DELETE'));
    return { message: result.inputRequests.confirm!.params.message, requestState: result.requestState };
  }

  /**
   * Returns the payload of a request state: the field `p` of the decoded part between the prefix
   * and the signature.
   */
  function payloadOf(state: string): Record<string, unknown> {
    const body = JSON.parse(Buffer.from(state.slice(3, state.lastIndexOf('.')), 'base64url').toString('utf8'));
    return body.p as Record<string, unknown>;
  }

  it('names the user by name and address with Include, by the ID only with Leave out, and keeps both out of the state', async () => {
    const include = await asked('delete_user', { userId: BEN_USER_ID }, 'include');
    const omit = await asked('delete_user', { userId: BEN_USER_ID }, 'omit');

    assert.ok(holds(include.message, PERSONAL_MARKER), include.message);
    assert.ok(include.message.includes(markedEmail('ben')));
    assert.ok(!holds(omit.message, PERSONAL_MARKER), omit.message);
    assert.ok(omit.message.startsWith(`Delete the user with the ID ${BEN_USER_ID} for good?`));
    for (const { requestState } of [include, omit]) {
      const payload = payloadOf(requestState);
      assert.ok(!holds(requestState, PERSONAL_MARKER));
      assert.ok(!holds(JSON.stringify(payload), PERSONAL_MARKER));
      assert.deepEqual(Object.keys(payload).sort(), ['id', 'nonce', 'round', 'tool', 'v']);
      assert.equal(payload.id, BEN_USER_ID);
    }
    // A hash of the address would be the same in both states: the nonce is random.
    assert.notEqual(payloadOf(include.requestState).nonce, payloadOf(omit.requestState).nonce);
  });

  it('names the room by its name, which is no personal value, in both modes, and keeps it out of the state', async () => {
    for (const mode of ['include', 'omit'] as const) {
      const { message, requestState } = await asked('delete_room', { roomId: ROOM_ID }, mode);

      assert.ok(holds(message, KEPT_MARKER), message);
      assert.ok(!holds(message, PERSONAL_MARKER), message);
      assert.ok(!holds(requestState, KEPT_MARKER));
      assert.ok(!holds(JSON.stringify(payloadOf(requestState)), KEPT_MARKER));
    }
  });
});

describe('Personal data in the room list of find_rooms with a meeting room', () => {
  // find_rooms asks alfaview for rooms or departments, so this list with a meeting room is made up.
  // The rule holds for every room that a list shows.
  const rooms = [
    { id: ROOM_ID, displayName: `Advisory Room ${KEPT_MARKER}`, type: 'room' },
    { id: MEETING_ID, displayName: `Review ${PERSONAL_MARKER}`, type: 'meeting' },
  ];

  async function listed(mode: Mode, name?: string) {
    const harness = await toolHarness(
      [toolOf('find_rooms')],
      [
        loginRequest(),
        {
          method: 'GET',
          path: '/v2/rooms',
          query: { roomTypes: 'room', limit: '50' },
          respond: { status: 200, body: { data: rooms } },
        },
      ],
      mode === undefined ? {} : { personalData: mode },
    );
    const result = await harness.call('find_rooms', name === undefined ? {} : { name });
    await harness.done();
    return result;
  }

  it('leaves out the name of the meeting room and keeps the name of the other room', async () => {
    const include = await listed('include');
    const omit = await listed('omit');

    assert.deepEqual(
      include.data.rooms.map((room: { displayName: string }) => room.displayName),
      [`Advisory Room ${KEPT_MARKER}`, `Review ${PERSONAL_MARKER}`],
    );
    assert.deepEqual(
      omit.data.rooms.map((room: { id: string; displayName: string | null }) => [room.id, room.displayName]),
      [
        [ROOM_ID, `Advisory Room ${KEPT_MARKER}`],
        [MEETING_ID, null],
      ],
    );
    const leftOut =
      'This server leaves out personal data (option Personal data, Leave out): the names of meeting rooms are null, also where alfaview has a value.';
    assert.deepEqual(omit.data.warnings, [leftOut]);
    assert.equal(omit.summary, `${include.summary} ${leftOut}`);
  });

  it('still finds the meeting room by the name that it leaves out, after all logic', async () => {
    const omit = await listed('omit', 'review');

    assert.equal(omit.data.totalMatches, 1);
    assert.deepEqual(omit.data.rooms, [
      {
        id: MEETING_ID,
        displayName: null,
        type: 'meeting',
        parentId: null,
        waitingRoomEnabled: null,
        passcodeRequired: null,
      },
    ]);
  });
});
