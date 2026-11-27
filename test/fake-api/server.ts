// A fake alfaview API for the tests. startFakeApi serves it on 127.0.0.1, where route-fetch.ts
// sends the requests of the built server, and fakeApiFetch serves it in the test process. It
// answers from a FakeState, applies the writes to it, and checks each request against the spec.
import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FEATURE_KEYS, PERMISSION_KEYS } from '../../src/shared/rooms.ts';
import { fixture } from '../helpers/fixtures.ts';
import { TEST_ENV } from '../helpers/spawnServer.ts';
import { keepContractProblems } from '../helpers/spec.ts';

/** An alfaview object as JSON: a room, a guest link, a meeting and so on. */
type Json = Record<string, any>;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** alfaview's value for a time that is not set. */
const NOT_SET = '0001-01-01T00:00:00Z';

/** The longest attendance window, `to` minus `from`, that alfaview takes. A longer one gets 422. */
const MAX_ATTENDANCE_WINDOW_MS = 26 * HOUR_MS + MINUTE_MS;

/** alfaview returns the sessions that started at most this long before `from`. */
const ATTENDANCE_LOOKBACK_MS = DAY_MS;

const JOIN_URL_BASE = 'https://app.alfaview.com/#/join/0123456789ABCDEFGHIJKLMNOP';

// The IDs and texts of sampleState that the tests refer to

/** Returns an ID in the form of alfaview: version 5, the IETF variant, `kind` in byte 10. */
export function sampleId(kind: string, n: number): string {
  return `c0ffee00-0000-5000-8000-${kind}${String(n).padStart(10, '0')}`;
}

/**
 * Returns the ID of guest link `n` and the userId of its guest, as alfaview returns them with the
 * link: 0x14 in byte 10 of the link ID, and 0x18 in byte 10 of the userId.
 */
export function sampleGuestLink(n: number): { id: string; userId: string } {
  return { id: sampleId('14', n), userId: sampleId('18', n) };
}

/** The user of the API key, and the advisor Anna in the fixtures. */
export const API_USER_ID = '6c1d9e4f-2a7b-5c3d-9e8f-0a1b2c3d4e5f';

/** rooms/room.json: the room of the advisor Anna, with a waiting room and a passcode. */
export const ADVISOR_ROOM_ID = '0b7c5d2e-91a4-5f3b-8e27-0f4a6c9d1e22';

/** core/rooms-page-1.json: the room of the webinars. */
export const WEBINAR_ROOM_ID = '5a6b7c8d-9e0f-5a1b-8c2d-3e4f5a6b7c8d';

/** meetings/meeting.json: a meeting with one guest link, five days ahead. */
export const MEETING_ID = '7e9a1c3d-5b2f-5a4e-8c6d-22f0a1b2c3d4';

/** guestLinks/guest-link.json: the appointment of Jane Doe in the advisor's room, a day ago. */
export const APPOINTMENT_LINK_ID = '3f2a9c1e-7b4d-5e21-a3c4-14b7e9d0f6a2';

/** How long before the start of the state the validity of Jane's appointment starts. */
export const APPOINTMENT_START_BEFORE_T0 = 26 * HOUR_MS;

/** The guest link of the meeting. alfaview emails its guest when it is deleted. */
const MEETING_LINK = sampleGuestLink(1);
export const MEETING_LINK_ID = MEETING_LINK.id;

/** An old booking in the advisor's room, from a Calendly invitee. */
const OLD_BOOKING_LINK = sampleGuestLink(2);
export const OLD_BOOKING_LINK_ID = OLD_BOOKING_LINK.id;

/** Returns a Calendly invitee URI, the origin of a booking link. */
export function calendlyInviteeUri(n: number): string {
  return `https://api.calendly.com/scheduled_events/${sampleId('31', n)}/invitees/${sampleId('32', n)}`;
}

export const OLD_BOOKING_ORIGIN = calendlyInviteeUri(1);

/** The origin of the guest links of the webinar three days ago. */
export const PAST_WEBINAR_ORIGIN = 'Webinar Altersvorsorge';

/** rooms/permission-groups.json */
export const GUEST_GROUP_ID = 'd2b3c4d5-e6f7-5081-9a2b-c3d4e5f6a7b8';
export const SPECTATOR_GROUP_ID = 'f4a5b6c7-d8e9-5f0a-9b1c-2d3e4f5a6b7c';

// State

export type AttendanceSession = { displayName: string; from: string; to: string };
export type UserAttendances = { userId: string; attendances: AttendanceSession[] };

export type FakeState = {
  /**
   * Rooms of every type, also the rooms of the meetings. A room holds the room permissions of its
   * users in `userPermissions`, as rooms/room.json does.
   */
  rooms: Json[];
  /** The passcode of a room, by the room ID in lowercase. */
  passcodes: Map<string, { passcode: string; required: boolean }>;
  permissionGroups: Json[];
  guestLinks: Json[];
  /** The group links of every room, in the shape of groupLinks/group-link.json. */
  groupLinks: Json[];
  meetings: Json[];
  /** The people in a room now (SubroomParticipants), by the room ID in lowercase. */
  participants: Map<string, Json[]>;
  /** The attendance of a room, one entry per userId, by the room ID in lowercase. */
  attendances: Map<string, UserAttendances[]>;
  /** The numbers of the statistics periods, repeated in order. */
  statistics: Json[];
  /** The profile of the user of the API key (spec: User). */
  ownUser: Json;
  /** The other users of the company (spec: User). The user list holds ownUser first, then these. */
  users: Json[];
  /** The company of the API key (spec: Company). */
  company: Json;
  /** The room types of the company's plan (spec: RoomTypeData). */
  roomTypes: Json[];
  /**
   * The language settings of a room (spec: LanguageSettings), by the room ID in lowercase. A room
   * without an entry has no transcription setup.
   */
  languageSettings: Map<string, Json>;
  /** The languages that alfaview offers (spec: Languages). */
  languages: Json;
  /**
   * The file sharing settings of a room (spec: RoomSettings), by the room ID in lowercase. A room
   * without an entry has the default settings of alfaview.
   */
  fileShareSettings: Map<string, Json>;
  /** The storage limits of every room (spec: RoomLimits). */
  fileShareLimits: Json;
};

const ISO_TIME = /^(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;

/**
 * Returns a copy of `value` with every timestamp moved by `shiftMs`, so the fixtures of a fixed
 * day fit the time of the test run. Timestamps before 1971 (alfaview's "not set") stay.
 */
function shiftTimes<T>(value: T, shiftMs: number): T {
  if (typeof value === 'string') {
    const match = ISO_TIME.exec(value);
    if (match === null || Number(match[1]) <= 1970) return value;
    return new Date(Date.parse(value) + shiftMs).toISOString() as T;
  }
  if (Array.isArray(value)) return value.map((item) => shiftTimes(item, shiftMs)) as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, shiftTimes(item, shiftMs)]),
    ) as T;
  }
  return value;
}

/**
 * Returns a guest link in the shape of guestLinks/guest-link.json, with the userId of its guest.
 * The caller gives that userId (sampleGuestLink gives a pair), because the MCP server matches a
 * guest to a link only by it.
 */
export function guestLinkOf(fields: {
  id: string;
  userId: string;
  roomId: string;
  emailAddress: string;
  displayName?: string;
  locale?: string;
  origin: string;
  permissionGroupId?: string;
  dialInAllowed?: boolean;
  validFrom?: string;
  validUntil?: string;
  createdAt: string;
}): Json {
  const accessKey = `Ak${fields.id.replace(/-/g, '').slice(-30)}`;
  return {
    id: fields.id,
    userId: fields.userId,
    roomId: fields.roomId,
    createdBy: API_USER_ID,
    createdAt: fields.createdAt,
    permissionGroupId: fields.permissionGroupId ?? GUEST_GROUP_ID,
    accessKey,
    emailAddress: fields.emailAddress,
    ...(fields.displayName === undefined ? {} : { displayName: fields.displayName }),
    locale: fields.locale ?? 'de-DE',
    origin: fields.origin,
    dialInAllowed: fields.dialInAllowed ?? false,
    dialInCode: '',
    joinUrl: `${JOIN_URL_BASE}/${fields.roomId}/${accessKey}`,
    validFrom: fields.validFrom ?? NOT_SET,
    validUntil: fields.validUntil ?? NOT_SET,
  };
}

/** Returns a group link in the shape of groupLinks/group-link.json. */
export function groupLinkOf(fields: {
  id: string;
  roomId: string;
  description: string;
  origin: string;
  permissionGroupId?: string;
  dialInAllowed?: boolean;
  validFrom?: string;
  validUntil?: string;
  createdAt: string;
}): Json {
  const accessKey = `Gk${fields.id.replace(/-/g, '').slice(-30)}`;
  const joinUrl = `${JOIN_URL_BASE}/${fields.roomId}/${accessKey}`;
  return {
    id: fields.id,
    roomId: fields.roomId,
    description: fields.description,
    permissionGroupId: fields.permissionGroupId ?? GUEST_GROUP_ID,
    createdBy: API_USER_ID,
    createdAt: fields.createdAt,
    joinLink: joinUrl,
    joinUrl,
    accessKey,
    origin: fields.origin,
    dialInAllowed: fields.dialInAllowed ?? false,
    dialInCode: '',
    validFrom: fields.validFrom ?? NOT_SET,
    validUntil: fields.validUntil ?? NOT_SET,
  };
}

/**
 * Returns each of the 14 features in the state `default`, as alfaview gives them for each room,
 * the room of a meeting included (spec: RoomFeatures requires each key).
 */
function defaultFeatures(): Json {
  return Object.fromEntries(FEATURE_KEYS.map((key) => [key, 'default']));
}

/**
 * Returns the room of a meeting, with the default features. A meeting ID also works where a room
 * ID is asked for.
 */
export function meetingRoomOf(meeting: Json): Json {
  return {
    id: meeting.id,
    displayName: meeting.title,
    type: 'meeting',
    managed: true,
    waitingRoomEnabled: false,
    passcodeRequired: false,
    createdAt: meeting.createdAt,
    features: defaultFeatures(),
  };
}

/** Adds sessions to the attendance of a room, one entry per userId as alfaview keeps it. */
function addAttendance(entries: UserAttendances[], added: readonly UserAttendances[]): void {
  for (const entry of added) {
    const existing = entries.find((item) => item.userId === entry.userId);
    if (existing === undefined) {
      entries.push({ userId: entry.userId, attendances: [...entry.attendances] });
    } else {
      existing.attendances.push(...entry.attendances);
    }
  }
}

/** One guest link of the past webinar, and the sessions of its guest in minutes from the start. */
type Registrant = {
  /** The number of the guest link ID. */
  n: number;
  email: string;
  name: string;
  sessions: [fromMinute: number, toMinute: number][];
};

/**
 * The webinar three days ago. With 15 minimum minutes, Anna and Dirk attended (Dirk with two links
 * of 10 minutes each), and Bob (5 minutes) and Carla (no session) did not.
 */
const PAST_WEBINAR_REGISTRANTS: readonly Registrant[] = [
  { n: 11, email: 'anna.attendee@example.com', name: 'Anna Attendee', sessions: [[0, 50]] },
  { n: 12, email: 'bob.brief@example.com', name: 'Bob Brief', sessions: [[10, 15]] },
  { n: 13, email: 'carla.absent@example.com', name: 'Carla Absent', sessions: [] },
  { n: 14, email: 'dirk.twice@example.com', name: 'Dirk Twice', sessions: [[0, 10]] },
  { n: 15, email: 'Dirk.Twice@example.com', name: 'Dirk Twice', sessions: [[30, 40]] },
];

/**
 * Returns the state of a sample company at `t0`, a whole minute, built from the fixtures:
 *
 * - rooms: the advisor Anna's room (waiting room, passcode), Ben's room, a team room in the
 *   department Advisors, the webinar room, and the rooms of two meetings;
 * - the advisor's room: Jane's appointment, which ended 24.5 hours before `t0`, with the
 *   attendance fixture moved to it (41 minutes in two sessions); an old Calendly booking that ended
 *   six days ago; a link without a validity period; the group link of the fixture, for an open
 *   house of the fixture's day; and the people of the participant fixture,
 *   moved so that its 09:00 is `t0`: Jane has waited for 7 minutes 20 seconds, a visitor for 3
 *   minutes, Anna is in the room and Max is on break in a breakout room. Jane's session of the
 *   fixture's day before moves two more days back, so the day of her appointment holds only it;
 * - the webinar room: the registrants of the webinar that started 72 hours before `t0`, and the
 *   advisor Anna, who moderated it;
 * - meetings: the meeting fixture five days ahead with one guest link, and the canceled one;
 * - the permission groups, the room passcode, the statistics, the profile of the user of the API
 *   key, the other users, its company and the room types of the plan of the fixtures;
 * - the language settings of the advisor's room, the languages that alfaview offers and the
 *   storage limits of the fixtures, and the default file sharing settings in every room.
 */
export function sampleState(t0: number): FakeState {
  const iso = (ms: number) => new Date(ms).toISOString();
  const wholeHour = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS;

  const meetingShift = wholeHour(t0 + 5 * DAY_MS) - Date.parse('2026-10-12T08:00:00Z');
  const meeting = shiftTimes(
    { ...fixture('meetings/meeting.json'), guestLinks: [MEETING_LINK_ID] },
    meetingShift,
  );
  const canceledMeeting = shiftTimes(fixture('meetings/meeting-sparse.json'), meetingShift);

  const department = {
    id: fixture('rooms/room-sparse.json').parentId,
    displayName: 'Advisors',
    type: 'department',
    managed: false,
    createdAt: '2026-08-01T08:00:00Z',
  };
  const rooms: Json[] = [
    fixture('rooms/room.json'),
    fixture('core/rooms-page-1.json').data[1],
    fixture('core/rooms-page-2.json').data[0],
    fixture('rooms/room-sparse.json'),
    department,
    meetingRoomOf(meeting),
    meetingRoomOf(canceledMeeting),
  ];

  // Jane's appointment: the link fixture and the attendance fixture of the same day, moved
  // together so that the validity starts APPOINTMENT_START_BEFORE_T0 before t0.
  const appointmentShift = t0 - APPOINTMENT_START_BEFORE_T0 - Date.parse('2026-10-07T08:45:00Z');
  const guestLinks: Json[] = [
    shiftTimes(fixture('guestLinks/guest-link.json'), appointmentShift),
    fixture('guestLinks/guest-link-unbounded.json'),
    guestLinkOf({
      ...OLD_BOOKING_LINK,
      roomId: ADVISOR_ROOM_ID,
      emailAddress: 'old.booking@example.com',
      displayName: 'Old Booking',
      origin: OLD_BOOKING_ORIGIN,
      validFrom: iso(t0 - 6 * DAY_MS),
      validUntil: iso(t0 - 6 * DAY_MS + HOUR_MS),
      createdAt: iso(t0 - 8 * DAY_MS),
    }),
    guestLinkOf({
      ...MEETING_LINK,
      roomId: MEETING_ID,
      emailAddress: 'meeting.guest@example.com',
      displayName: 'Meeting Guest',
      origin: 'MCP',
      validFrom: iso(Date.parse(meeting.start) - 15 * MINUTE_MS),
      validUntil: iso(Date.parse(meeting.end) + 15 * MINUTE_MS),
      createdAt: iso(t0 - DAY_MS),
    }),
  ];

  // The participant fixture also holds a session of Jane on the day before its 09:00. Moved with
  // the rest, it would start 18 hours before t0 and share the Berlin day of her appointment for a
  // run that starts between about 02:00 and 17:20. Two more days back, that day holds only the
  // sessions of the appointment at each start time.
  const participantShift = t0 - Date.parse('2026-10-07T09:00:00Z');
  const participants = shiftTimes(fixture('participants/attendances.json'), participantShift).map(
    (entry: UserAttendances) => ({
      ...entry,
      attendances: entry.attendances.map((session) =>
        Date.parse(session.from) < t0 - 12 * HOUR_MS ? shiftTimes(session, -2 * DAY_MS) : session,
      ),
    }),
  );
  const advisorAttendance: UserAttendances[] = [];
  addAttendance(advisorAttendance, participants);
  addAttendance(advisorAttendance, shiftTimes(fixture('attendance/attendances.json'), appointmentShift));

  // The advisor Anna moderated the webinar from 20 minutes before its start to its end.
  const webinarStart = t0 - 72 * HOUR_MS;
  const moderation = {
    displayName: 'Anna Example',
    from: iso(webinarStart - 20 * MINUTE_MS),
    to: iso(webinarStart + 2 * HOUR_MS),
  };
  const webinarAttendance: UserAttendances[] = [{ userId: API_USER_ID, attendances: [moderation] }];
  for (const registrant of PAST_WEBINAR_REGISTRANTS) {
    const link = sampleGuestLink(registrant.n);
    guestLinks.push(
      guestLinkOf({
        ...link,
        roomId: WEBINAR_ROOM_ID,
        emailAddress: registrant.email,
        displayName: registrant.name,
        origin: PAST_WEBINAR_ORIGIN,
        permissionGroupId: SPECTATOR_GROUP_ID,
        validFrom: iso(webinarStart - 30 * MINUTE_MS),
        validUntil: iso(webinarStart + 2 * HOUR_MS),
        createdAt: iso(webinarStart - 5 * DAY_MS),
      }),
    );
    if (registrant.sessions.length > 0) {
      addAttendance(webinarAttendance, [
        {
          userId: link.userId,
          attendances: registrant.sessions.map(([from, to]) => ({
            displayName: registrant.name,
            from: iso(webinarStart + from * MINUTE_MS),
            to: iso(webinarStart + to * MINUTE_MS),
          })),
        },
      ]);
    }
  }

  return {
    rooms,
    passcodes: new Map([[ADVISOR_ROOM_ID, fixture('rooms/passcode.json')]]),
    permissionGroups: fixture('rooms/permission-groups.json'),
    guestLinks,
    groupLinks: [fixture('groupLinks/group-link.json')],
    meetings: [meeting, canceledMeeting],
    participants: new Map([[ADVISOR_ROOM_ID, fixture('participants/participants.json')]]),
    attendances: new Map([
      [ADVISOR_ROOM_ID, advisorAttendance],
      [WEBINAR_ROOM_ID, webinarAttendance],
    ]),
    statistics: fixture('statistics/stats.json'),
    ownUser: fixture('core/user-profile.json'),
    // The fixture lists the user of the API key too, whom ownUser is.
    users: fixture<Json[]>('users/users.json').filter((user) => user.id !== API_USER_ID),
    company: fixture('core/own-company.json'),
    roomTypes: fixture('rooms/room-types.json'),
    languageSettings: new Map([[ADVISOR_ROOM_ID, fixture('rooms/language-settings.json')]]),
    languages: fixture('rooms/languages.json'),
    fileShareSettings: new Map(),
    fileShareLimits: fixture('rooms/file-share-limits.json'),
  };
}

/**
 * Returns the state of a new company: no room, no guest link, no group link, no meeting and no
 * other user. It has the permission groups of the fixtures, the group Guest among them, and the
 * profile of the API key's user, the company, the room types, the languages, the storage limits
 * and the statistics of the fixtures.
 */
export function newCompanyState(): FakeState {
  return {
    rooms: [],
    passcodes: new Map(),
    permissionGroups: fixture('rooms/permission-groups.json'),
    guestLinks: [],
    groupLinks: [],
    meetings: [],
    participants: new Map(),
    attendances: new Map(),
    statistics: fixture('statistics/stats.json'),
    ownUser: fixture('core/user-profile.json'),
    users: [],
    company: fixture('core/own-company.json'),
    roomTypes: fixture('rooms/room-types.json'),
    languageSettings: new Map(),
    languages: fixture('rooms/languages.json'),
    fileShareSettings: new Map(),
    fileShareLimits: fixture('rooms/file-share-limits.json'),
  };
}

// Server

export type FakeRequest = {
  method: string;
  path: string;
  query: Record<string, string>;
  authorization: string | undefined;
  /** The body as parsed JSON, `undefined` without a body. */
  body: any;
  /** The status of the answer. */
  status: number;
  /**
   * Set when a fault (FakeFault) gave the answer. `applied` is true when the fake applied the
   * request before it answered with the status of the fault.
   */
  fault?: { applied: boolean };
};

/** The fake API without its HTTP server: the state, the records and the answer of a request. */
export type FakeApiCore = {
  /** Every request, in the order of arrival. */
  requests: FakeRequest[];
  state: FakeState;
  /** The tokens of the logins, in order. */
  tokens: string[];
  /**
   * Answers the next request with `status` and a problem body, once. A 401 also revokes every
   * token issued so far, as an expired token is.
   */
  answerNextWith(status: number): void;
  /** The faults (FakeFault) whose nth matching request has not come yet, so they gave no answer. */
  unfiredFaults(): FakeFault[];
  /**
   * Checks the request against the spec, records it and returns its answer. `target` is the path
   * with its query, `text` the body as sent.
   */
  handle(request: {
    method: string;
    target: string;
    headers: Record<string, string | string[] | undefined>;
    text: string;
  }): Answer;
};

export type FakeApi = Omit<FakeApiCore, 'handle'> & {
  /** http://127.0.0.1:<port> */
  origin: string;
  close(): Promise<void>;
};

/**
 * A request that the fake API answers once with an error status, as alfaview can answer under load
 * (429) or after a timeout (500). Only a request with a valid token counts.
 */
export type FakeFault = {
  method: string;
  /** Matches the path of the request, without its query. */
  path: RegExp;
  /** The matching request that fails, counted from 1. Default 1. */
  nth?: number;
  /** The status of the answer, such as 429 or 500. */
  status: number;
  /**
   * True: the fake applies the request before it answers with `status`, as when alfaview saved a
   * create and then timed out. Then only a matching request that the fake applied with
   * success counts, and a request that the fake refuses, such as with 422, gets its own answer.
   * Otherwise the request changes nothing, and every matching request counts, valid or not.
   */
  applied?: boolean;
};

export type FakeApiOptions = {
  /** The clock of the times that the fake writes, such as `createdAt`. Date.now by default. */
  now?: () => number;
  /** The requests that fail once. */
  faults?: readonly FakeFault[];
};

type Answer = { status: number; body?: unknown };

type Route = {
  method: string;
  path: RegExp;
  /** `params` are the decoded groups of `path`. */
  answer(params: string[], request: FakeRequest): Answer;
};

function problem(status: number, detail: string, errors?: Json[]): Answer {
  const body: Json = { title: STATUS_CODES[status], status, detail };
  if (errors !== undefined) body.errors = errors;
  return { status, body };
}

/** Returns an input error at `location`, as alfaview answers input that it cannot process. */
function fieldError(location: string, message: string): Json {
  return { message, location };
}

function invalid(...errors: Json[]): Answer {
  return problem(422, 'validation failed', errors);
}

/** Returns the answer to a time range that alfaview refuses, with an error for each bound. */
function invalidRange(detail: string, fromMessage: string, toMessage: string): Answer {
  return problem(422, detail, [fieldError('query.from', fromMessage), fieldError('query.to', toMessage)]);
}

function reversedRange(): Answer {
  return invalidRange('`from` is after `to`', 'after `to`', 'before `from`');
}

function ok(body: unknown, status = 200): Answer {
  return { status, body };
}

const NO_CONTENT: Answer = { status: 204 };

function sameId(left: unknown, right: string): boolean {
  return typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
}

/** Returns a page of `items` as alfaview pages its lists: `{ data, nextPageToken }`. */
function page(items: readonly Json[], query: Record<string, string>): Answer {
  const limit = Number(query.limit);
  // The tools must always send a page size of 1 or more.
  if (!Number.isInteger(limit) || limit < 1) return problem(400, 'limit must be 1 or more');
  const offset = query.pageToken === undefined ? 0 : Number(query.pageToken.replace('page-', ''));
  const data = items.slice(offset, offset + limit);
  const next = offset + limit;
  return ok(next < items.length ? { data, nextPageToken: `page-${next}` } : { data });
}

/** Returns the instant of a time from alfaview, or `undefined` for a time that is not set. */
function instantOf(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) || time < Date.parse('1971-01-01T00:00:00Z') ? undefined : time;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (text += chunk));
    request.on('end', () => resolve(text));
    request.on('error', reject);
  });
}

/** Returns the content type of an answer with a body. */
function contentTypeOf(answer: Answer): string {
  return answer.status >= 400 ? 'application/problem+json' : 'application/json';
}

function send(response: ServerResponse, answer: Answer): void {
  if (answer.body === undefined) {
    response.writeHead(answer.status);
    response.end();
    return;
  }
  response.writeHead(answer.status, { 'Content-Type': contentTypeOf(answer) });
  response.end(JSON.stringify(answer.body));
}

/** Creates the fake API on `state`, without a server. */
export function createFakeApi(state: FakeState, options: FakeApiOptions = {}): FakeApiCore {
  const now = options.now ?? Date.now;
  const requests: FakeRequest[] = [];
  const tokens: string[] = [];
  const validTokens = new Set<string>();
  let nextStatus: number | undefined;
  let createdCount = 0;
  const faults = (options.faults ?? []).map((fault) => ({ fault, matches: 0 }));

  /**
   * Returns the fault that answers `request`: the one whose nth match it is. `applied` selects the
   * faults that apply the request first, or those that do not. It counts the request for each
   * fault that it matches.
   */
  function faultFor(request: FakeRequest, applied: boolean): FakeFault | undefined {
    let found: FakeFault | undefined;
    for (const entry of faults) {
      const { fault } = entry;
      if ((fault.applied === true) !== applied) continue;
      if (fault.method !== request.method || !fault.path.test(request.path)) continue;
      entry.matches += 1;
      if (entry.matches === (fault.nth ?? 1)) found ??= fault;
    }
    return found;
  }

  const roomOf = (id: string) => state.rooms.find((room) => sameId(room.id, id));
  const linkOf = (id: string) => state.guestLinks.find((link) => sameId(link.id, id));
  const groupLinkOfId = (id: string) => state.groupLinks.find((link) => sameId(link.id, id));
  const meetingOf = (id: string) => state.meetings.find((meeting) => sameId(meeting.id, id));
  const groupOf = (id: unknown) =>
    state.permissionGroups.find((group) => typeof id === 'string' && sameId(group.id, id));
  const roomMissing = () => problem(404, 'room not found');
  const languageSettingsOf = (id: string): Json =>
    state.languageSettings.get(id.toLowerCase()) ?? fixture('rooms/language-settings-fresh.json');
  const fileShareSettingsOf = (id: string): Json =>
    state.fileShareSettings.get(id.toLowerCase()) ?? fixture('rooms/file-share-settings.json');

  function logIn(body: any): Answer {
    const valid =
      body?.companyId === TEST_ENV.ALFAVIEW_COMPANY_ID &&
      body?.clientId === TEST_ENV.ALFAVIEW_CLIENT_ID &&
      body?.key === TEST_ENV.ALFAVIEW_API_KEY;
    if (!valid) return problem(401, 'invalid credentials');
    const token = `fake-token-${tokens.length + 1}`;
    tokens.push(token);
    validTokens.add(token);
    return ok({ accessToken: token });
  }

  /**
   * `POST /v2/rooms/{roomId}/guest-links`: `{ create: [...], origin, timezone }`. In the room of a
   * meeting, the meeting also lists the new links, so that a later change of the meeting emails
   * their guests. Like alfaview, it answers the created guest links, each with its join URL and
   * the userId of its guest.
   */
  function createGuestLinks(roomId: string, body: any): Answer {
    if (roomOf(roomId) === undefined) return roomMissing();
    const entries: unknown = body?.create;
    if (!Array.isArray(entries) || entries.length === 0) {
      return invalid(fieldError('body.create', 'expected at least 1 item'));
    }
    const errors = entries.flatMap((entry: any, index) => {
      const location = `body.create[${index}]`;
      const entryErrors: Json[] = [];
      if (typeof entry?.emailAddress !== 'string' || !entry.emailAddress.includes('@')) {
        const message = 'expected string to be RFC 5322 email';
        entryErrors.push(fieldError(`${location}.emailAddress`, message));
      }
      if (groupOf(entry?.permissionGroupId) === undefined) {
        entryErrors.push(fieldError(`${location}.permissionGroupId`, 'unknown permission group'));
      }
      return entryErrors;
    });
    if (errors.length > 0) return invalid(...errors);

    const created = entries.map((entry: any) => {
      createdCount += 1;
      const link = guestLinkOf({
        ...sampleGuestLink(1000 + createdCount),
        roomId: roomId.toLowerCase(),
        emailAddress: entry.emailAddress,
        displayName: entry.displayName,
        locale: entry.locale,
        origin: typeof body.origin === 'string' ? body.origin : 'Public API',
        permissionGroupId: entry.permissionGroupId,
        dialInAllowed: entry.dialInAllowed,
        validFrom: entry.validFrom,
        validUntil: entry.validUntil,
        createdAt: new Date(now()).toISOString(),
      });
      state.guestLinks.push(link);
      return link;
    });
    const meeting = meetingOf(roomId);
    if (meeting !== undefined) {
      meeting.guestLinks = [...(meeting.guestLinks ?? []), ...created.map((link) => link.id)];
    }
    return ok(created, 201);
  }

  /**
   * `POST /v2/rooms/{roomId}/group-links`: `{ create: [...], origin }`. Like alfaview, it refuses
   * a department, a blank description and an unknown permission group, and gives a link
   * without an origin in the body the origin `Public API`.
   */
  function createGroupLinks(roomId: string, body: any): Answer {
    const room = roomOf(roomId);
    if (room === undefined) return roomMissing();
    if (room.type === 'department') return problem(422, 'not allowed for departments');
    const entries: unknown = body?.create;
    if (!Array.isArray(entries) || entries.length === 0) {
      return invalid(fieldError('body.create', 'expected at least 1 item'));
    }
    const errors = entries.flatMap((entry: any, index) => {
      const location = `body.create[${index}]`;
      const entryErrors: Json[] = [];
      if (typeof entry?.description !== 'string' || entry.description.trim() === '') {
        entryErrors.push(fieldError(`${location}.description`, 'expected a text that is not blank'));
      }
      if (groupOf(entry?.permissionGroupId) === undefined) {
        entryErrors.push(fieldError(`${location}.permissionGroupId`, 'unknown permission group'));
      }
      return entryErrors;
    });
    if (errors.length > 0) return invalid(...errors);

    const created = entries.map((entry: any) => {
      createdCount += 1;
      const link = groupLinkOf({
        id: sampleId('15', 1000 + createdCount),
        roomId: roomId.toLowerCase(),
        description: entry.description,
        origin: typeof body.origin === 'string' ? body.origin : 'Public API',
        permissionGroupId: entry.permissionGroupId,
        dialInAllowed: entry.dialInAllowed,
        validFrom: entry.validFrom,
        validUntil: entry.validUntil,
        createdAt: new Date(now()).toISOString(),
      });
      state.groupLinks.push(link);
      return { id: link.id };
    });
    return ok(created, 201);
  }

  /**
   * `PATCH /v2/group-links/{id}`: the given fields. Like alfaview, it keeps a field that the body
   * leaves out or sets to null, and it refuses an unknown permission group and a validUntil before
   * the validFrom.
   */
  function updateGroupLink(id: string, body: any): Answer {
    const link = groupLinkOfId(id);
    if (link === undefined) return problem(404, 'group link not found');
    if (body?.permissionGroupId != null && groupOf(body.permissionGroupId) === undefined) {
      return invalid(fieldError('body.permissionGroupId', 'unknown permission group'));
    }
    const changed = { ...link };
    for (const key of ['description', 'validFrom', 'validUntil', 'permissionGroupId', 'dialInAllowed']) {
      if (body?.[key] != null) changed[key] = body[key];
    }
    const from = instantOf(changed.validFrom);
    const until = instantOf(changed.validUntil);
    if (from !== undefined && until !== undefined && until < from) {
      return invalid(fieldError('body.validUntil', 'must be after validFrom'));
    }
    Object.assign(link, changed);
    return NO_CONTENT;
  }

  /** `PATCH /v2/guest-links/{id}`. alfaview needs displayName and sendEmail in every update. */
  function updateGuestLink(id: string, body: any): Answer {
    const link = linkOf(id);
    if (link === undefined) return problem(404, 'guest link not found');
    if (typeof body?.displayName !== 'string' || typeof body?.sendEmail !== 'boolean') {
      return invalid(fieldError('body', 'displayName and sendEmail are required'));
    }
    if (body.permissionGroupId !== undefined && groupOf(body.permissionGroupId) === undefined) {
      return invalid(fieldError('body.permissionGroupId', 'unknown permission group'));
    }
    for (const key of [
      'emailAddress',
      'displayName',
      'locale',
      'validFrom',
      'validUntil',
      'permissionGroupId',
      'dialInAllowed',
    ]) {
      if (body[key] !== undefined) link[key] = body[key];
    }
    return NO_CONTENT;
  }

  /** `POST /v2/meetings`: the meeting, its room and one join URL per group except Admin. */
  function createMeeting(body: any): Answer {
    const texts = [body?.title, body?.start, body?.end];
    if (!texts.every((text) => typeof text === 'string')) {
      return invalid(fieldError('body', 'title, start and end are required'));
    }
    createdCount += 1;
    const id = sampleId('22', 1000 + createdCount);
    const earlyAccessMinutes =
      typeof body.earlyAccessMinutes === 'number' ? body.earlyAccessMinutes : 0;
    const groupLinks = Object.fromEntries(
      state.permissionGroups
        .filter((group) => group.name !== 'Admin')
        .map((group, index) => [group.id, `${JOIN_URL_BASE}/${id}/Gk${createdCount}x${index}`]),
    );
    const meeting = {
      id,
      title: body.title,
      start: body.start,
      end: body.end,
      timezone: body.timezone,
      state: 'scheduled',
      ...(body.agenda === undefined ? {} : { agenda: body.agenda }),
      earlyAccessMinutes,
      canJoin: false,
      canJoinAfter: new Date(Date.parse(body.start) - earlyAccessMinutes * MINUTE_MS).toISOString(),
      roomAvailable: false,
      createdAt: new Date(now()).toISOString(),
      createdBy: API_USER_ID,
      guestLinks: [],
      groupLinks,
    };
    state.meetings.push(meeting);
    state.rooms.push({
      ...meetingRoomOf(meeting),
      waitingRoomEnabled: body.waitingRoomEnabled === true,
      passcodeRequired: body.passcodeRequired === true,
    });
    return ok({ id }, 201);
  }

  /** Sets the passcode of a room as required or not, with a new passcode when it has none. */
  function setPasscodeRequired(roomId: string, required: boolean): void {
    const key = roomId.toLowerCase();
    const passcode = state.passcodes.get(key);
    if (passcode !== undefined) {
      passcode.required = required;
    } else if (required) {
      createdCount += 1;
      state.passcodes.set(key, { passcode: `Nw${createdCount}#pQ7x`, required });
    }
  }

  /**
   * `POST /v2/rooms`: a department, or a room with the 10 breakout rooms without names that
   * alfaview adds. Like alfaview, it refuses only the waiting room of a department, and it ignores
   * the passcode and the quotas of a department. The new room has each of the 14 features in the
   * state `default`, as a room of alfaview has them (spec: RoomFeatures requires each key).
   */
  function createRoom(body: any): Answer {
    if (typeof body?.displayName !== 'string' || body.displayName === '') {
      return invalid(fieldError('body.displayName', 'expected a name'));
    }
    if (typeof body.waitingRoomEnabled !== 'boolean') {
      return invalid(fieldError('body.waitingRoomEnabled', 'expected boolean'));
    }
    const department = body.type === 'department';
    if (department && body.waitingRoomEnabled) {
      return problem(422, "Rooms of the type 'department' cannot have a waiting room.");
    }
    createdCount += 1;
    const id = sampleId('21', 1000 + createdCount);
    const subrooms = department
      ? []
      : Array.from({ length: 10 }, (_, index) => ({
          id: sampleId('23', 1000 + createdCount * 10 + index),
          sort: index + 1,
        }));
    state.rooms.push({
      id,
      displayName: body.displayName,
      type: body.type,
      parentId: body.parentId ?? null,
      sort: 0,
      createdAt: new Date(now()).toISOString(),
      createdBy: API_USER_ID,
      managed: false,
      waitingRoomEnabled: body.waitingRoomEnabled,
      waitingRoomWelcomeNote: body.waitingRoomWelcomeNote ?? '',
      passcodeRequired: !department && body.passcodeRequired === true,
      ...(department || body.quotas === undefined ? {} : { quotas: body.quotas }),
      features: defaultFeatures(),
      subrooms,
    });
    if (!department && body.passcodeRequired === true) setPasscodeRequired(id, true);
    return ok({ id }, 201);
  }

  /** `PATCH /v2/rooms/{id}`: the given name and waiting room and passcode settings. */
  function updateRoom(id: string, body: any): Answer {
    const room = roomOf(id);
    if (room === undefined) return roomMissing();
    const waitingRoom = body?.waitingRoomEnabled === true || body?.waitingRoomWelcomeNote !== undefined;
    if (room.type === 'department' && waitingRoom) {
      return problem(422, "Rooms of the type 'department' cannot have a waiting room.");
    }
    for (const key of ['displayName', 'waitingRoomEnabled', 'waitingRoomWelcomeNote', 'passcodeRequired']) {
      if (body?.[key] !== undefined) room[key] = body[key];
    }
    if (typeof body?.passcodeRequired === 'boolean') setPasscodeRequired(id, body.passcodeRequired);
    return NO_CONTENT;
  }

  /** `GET /v2/rooms/{id}/features`: the state of each of the 14 features, `default` when unset. */
  function roomFeatures(id: string): Answer {
    const room = roomOf(id);
    if (room === undefined) return roomMissing();
    return ok(Object.fromEntries(FEATURE_KEYS.map((key) => [key, room.features?.[key] ?? 'default'])));
  }

  /**
   * `PATCH /v2/rooms/{id}/features`: the given states. `default` gives the feature back to the
   * default of the company, and the room keeps the state `default`, as alfaview shows it.
   */
  function updateRoomFeatures(id: string, body: any): Answer {
    const room = roomOf(id);
    if (room === undefined) return roomMissing();
    const entries = Object.entries(body ?? {});
    const refused = entries.filter(
      ([key, state]) =>
        !(FEATURE_KEYS as readonly string[]).includes(key) ||
        !['enabled', 'disabled', 'default'].includes(state as string),
    );
    if (refused.length > 0) {
      return invalid(...refused.map(([key]) => fieldError(`body.${key}`, 'expected a feature state')));
    }
    room.features = { ...room.features, ...Object.fromEntries(entries) };
    return NO_CONTENT;
  }

  /** `PATCH /v2/rooms/{id}/language-settings`: the given fields, without a check of the codes. */
  function updateLanguageSettings(id: string, body: any): Answer {
    if (roomOf(id) === undefined) return roomMissing();
    const settings = { ...languageSettingsOf(id) };
    for (const key of [
      'defaultSpokenLanguage',
      'targetTranscriptionLanguages',
      'transcriptionEnabled',
      'transcriptionType',
    ]) {
      if (body?.[key] !== undefined) settings[key] = body[key];
    }
    state.languageSettings.set(id.toLowerCase(), settings);
    return NO_CONTENT;
  }

  /**
   * `PATCH /v2/rooms/{id}/file-share-settings`: the given fields. Like alfaview, it stores them
   * also for a room that does not exist.
   */
  function updateFileShareSettings(id: string, body: any): Answer {
    const settings = { ...fileShareSettingsOf(id) };
    for (const key of ['enabled', 'defaultAccessLevel', 'participantsCanUpload']) {
      if (body?.[key] !== undefined) settings[key] = body[key];
    }
    state.fileShareSettings.set(id.toLowerCase(), settings);
    return NO_CONTENT;
  }

  /**
   * `POST /v2/rooms/{id}/subrooms`: a breakout room (the API calls it a subroom) with the name of
   * the body, or an empty name, and the Unix time of the create in seconds as its sort order, as
   * alfaview sets it. Like alfaview, it refuses a name above 32 bytes and the 51st breakout room.
   */
  function createSubroom(roomId: string, body: any): Answer {
    const room = roomOf(roomId);
    if (room === undefined) return roomMissing();
    const displayName = typeof body?.displayName === 'string' ? body.displayName : '';
    if (Buffer.byteLength(displayName) > 32) {
      return invalid(fieldError('body.displayName', 'expected at most 32 bytes'));
    }
    const subrooms: Json[] = room.subrooms ?? [];
    if (subrooms.length >= 50) return problem(422, 'a room can have at most 50 subrooms');
    createdCount += 1;
    const id = sampleId('23', 5000 + createdCount);
    room.subrooms = [...subrooms, { id, sort: Math.floor(now() / 1000), displayName }];
    return ok({ id }, 201);
  }

  /**
   * `PATCH /v2/rooms/{id}/subrooms/{subroomId}`: like alfaview, it compares `subroomId` as sent,
   * with its case, answers 404 for a room or a breakout room that it does not find, and sets a
   * missing name to an empty one, which alfaview shows as the numbered default name.
   */
  function updateSubroom(roomId: string, subroomId: string, body: any): Answer {
    const subroom = (roomOf(roomId)?.subrooms ?? []).find((entry: Json) => entry.id === subroomId);
    if (subroom === undefined) return problem(404, 'subroom not found');
    if (typeof body?.displayName === 'string' && Buffer.byteLength(body.displayName) > 32) {
      return invalid(fieldError('body.displayName', 'expected at most 32 bytes'));
    }
    subroom.displayName = typeof body?.displayName === 'string' ? body.displayName : '';
    return NO_CONTENT;
  }

  /** Returns the nine permissions of a permission group, `false` where the group gives none. */
  function groupPermissions(id: unknown): Json {
    const permissions = groupOf(id)?.permissions;
    return Object.fromEntries(PERMISSION_KEYS.map((key) => [key, permissions?.[key] === true]));
  }

  /**
   * `GET /v2/rooms/{id}/permissions`: the entries of the users of the room, and an entry for each
   * guest link and group link of the room with the permissions of its group, as alfaview keeps them
   * with the links. The default permissions of the room are not in the answer.
   */
  function roomPermissions(id: string): Answer {
    const room = roomOf(id);
    if (room === undefined) return roomMissing();
    const linkEntries = (links: readonly Json[]) =>
      links
        .filter((link) => sameId(link.roomId, id))
        .map((link) => ({ participantId: link.id, permissions: groupPermissions(link.permissionGroupId) }));
    return ok({
      userPermissions: room.userPermissions ?? [],
      guestLinkPermissions: linkEntries(state.guestLinks),
      groupLinkPermissions: linkEntries(state.groupLinks),
    });
  }

  /**
   * `POST /v2/rooms/{id}/permissions`: `{ participantId, permissions }` with all nine. Like
   * alfaview, it answers 409 only for an entry with the user ID as sent. It then keys the entry by
   * the lowercase ID, so an uppercase ID replaces the entry of the user.
   */
  function createPermission(roomId: string, body: any): Answer {
    const room = roomOf(roomId);
    if (room === undefined) return roomMissing();
    const participantId: unknown = body?.participantId;
    if (
      typeof participantId !== 'string' ||
      PERMISSION_KEYS.some((key) => typeof body.permissions?.[key] !== 'boolean')
    ) {
      return invalid(fieldError('body', 'participantId and the nine permissions are required'));
    }
    const entries: Json[] = room.userPermissions ?? [];
    if (entries.some((entry) => entry.participantId === participantId)) {
      return problem(409, 'permissions of user for room already exist');
    }
    room.userPermissions = [
      ...entries.filter((entry) => !sameId(entry.participantId, participantId)),
      { participantId: participantId.toLowerCase(), permissions: { ...body.permissions } },
    ];
    return NO_CONTENT;
  }

  /**
   * `PATCH /v2/rooms/{id}/permissions/{userId}`: the given permissions. Like alfaview, it looks
   * the entry up with the user ID as sent and answers 404 without one.
   */
  function updatePermission(roomId: string, userId: string, body: any): Answer {
    const room = roomOf(roomId);
    if (room === undefined) return roomMissing();
    const entry = (room.userPermissions ?? []).find((item: Json) => item.participantId === userId);
    if (entry === undefined) return problem(404, 'permissions of user for room not found');
    for (const key of PERMISSION_KEYS) {
      if (typeof body?.[key] === 'boolean') entry.permissions = { ...entry.permissions, [key]: body[key] };
    }
    return NO_CONTENT;
  }

  /** `PATCH /v2/users`: the given fields of the profile of the user of the API key. */
  function updateOwnUser(body: any): Answer {
    for (const key of ['firstName', 'lastName', 'title', 'city', 'initials', 'locale']) {
      if (body?.[key] !== undefined) state.ownUser[key] = body[key];
    }
    return NO_CONTENT;
  }

  /**
   * `GET /v2/users`: one bare list of every user, without pages. With `emailAddress`, the users
   * whose address matches without regard to case. Like alfaview, it answers 404 when none matches,
   * a status that the API spec does not list.
   */
  function listUsers(query: Record<string, string>): Answer {
    const users = [state.ownUser, ...state.users];
    if (query.emailAddress === undefined) return ok(users);
    const wanted = query.emailAddress.toLowerCase();
    const found = users.filter((user) => String(user.emailAddress).toLowerCase() === wanted);
    return found.length === 0 ? problem(404, 'user not found') : ok(found);
  }

  /**
   * `POST /v2/users/invitation`: `{ user, permissions }`. Like alfaview, it checks only the email
   * address and answers 202 without a body. alfaview creates the user after the answer, and the
   * fake adds it at once.
   */
  function inviteUser(body: any): Answer {
    const user = body?.user;
    if (typeof user?.emailAddress !== 'string' || !user.emailAddress.includes('@')) {
      return invalid(fieldError('body.user.emailAddress', 'expected string to be RFC 5322 email'));
    }
    createdCount += 1;
    state.users.push({
      id: sampleId('12', 1000 + createdCount),
      emailAddress: user.emailAddress,
      firstName: user.firstName,
      lastName: user.lastName,
      ...(user.title === undefined ? {} : { title: user.title }),
      locale: user.locale ?? 'de-DE',
    });
    return { status: 202 };
  }

  function updateMeeting(id: string, body: any): Answer {
    const meeting = meetingOf(id);
    if (meeting === undefined) return problem(404, 'meeting not found');
    for (const key of ['title', 'start', 'end', 'timezone', 'agenda', 'earlyAccessMinutes']) {
      if (body?.[key] !== undefined) meeting[key] = body[key];
    }
    return NO_CONTENT;
  }

  /**
   * `GET /v2/rooms/{roomId}/attendances?from=&to=`: like alfaview, it checks the times first, then
   * answers 403 for a room that does not exist and 422 for a long window.
   */
  function attendances(roomId: string, query: Record<string, string>): Answer {
    const from = Date.parse(query.from ?? '');
    const to = Date.parse(query.to ?? '');
    if (Number.isNaN(from)) return invalid(fieldError('query.from', 'expected a date-time'));
    if (Number.isNaN(to)) return invalid(fieldError('query.to', 'expected a date-time'));
    if (from > to) return reversedRange();
    if (roomOf(roomId) === undefined) return problem(403, 'missing room admin permissions');
    if (to - from > MAX_ATTENDANCE_WINDOW_MS) {
      return invalid(fieldError('query.to', 'the window is longer than 26 hours and 1 minute'));
    }
    const entries = (state.attendances.get(roomId.toLowerCase()) ?? []).flatMap((entry) => {
      const sessions = entry.attendances.filter((session) => {
        const start = Date.parse(session.from);
        const end = instantOf(session.to) ?? Number.POSITIVE_INFINITY;
        return start < to && end > from && start >= from - ATTENDANCE_LOOKBACK_MS;
      });
      return sessions.length === 0 ? [] : [{ userId: entry.userId, attendances: sessions }];
    });
    return ok(entries);
  }

  /** `GET /v2/stats`: one period per stepDurationHours from `from`, the last one ends at `to`. */
  function statistics(query: Record<string, string>): Answer {
    const from = Date.parse(query.from ?? '');
    const to = Date.parse(query.to ?? '');
    const step = Number(query.stepDurationHours) * HOUR_MS;
    if (Number.isNaN(from)) return invalid(fieldError('query.from', 'expected a date-time'));
    if (Number.isNaN(to)) return invalid(fieldError('query.to', 'expected a date-time'));
    if (!(step >= HOUR_MS)) return invalid(fieldError('query.stepDurationHours', 'expected at least 1'));
    if (from > to) return reversedRange();
    if (from === to) return invalidRange('`from` equals `to`', 'equals `to`', 'equals `from`');
    const periods: Json[] = [];
    for (let start = from, index = 0; start < to; start += step, index += 1) {
      const numbers = state.statistics[index % state.statistics.length]!;
      periods.push({
        from: new Date(start).toISOString(),
        to: new Date(Math.min(start + step, to)).toISOString(),
        rooms: numbers.rooms,
        meetings: numbers.meetings,
      });
    }
    return ok(periods);
  }

  const routes: Route[] = [
    {
      method: 'GET',
      path: /^\/v2\/rooms$/,
      answer: (_, { query }) => {
        const types = (query.roomTypes ?? '').split(',').filter((type) => type !== '');
        return page(
          state.rooms.filter((room) => types.length === 0 || types.includes(room.type)),
          query,
        );
      },
    },
    {
      method: 'POST',
      path: /^\/v2\/rooms$/,
      answer: (_, { body }) => createRoom(body),
    },
    {
      method: 'GET',
      path: /^\/v2\/rooms\/([^/]+)$/,
      answer: ([id]) => {
        const room = roomOf(id!);
        return room === undefined ? roomMissing() : ok(room);
      },
    },
    {
      method: 'PATCH',
      path: /^\/v2\/rooms\/([^/]+)$/,
      answer: ([id], { body }) => updateRoom(id!, body),
    },
    {
      method: 'DELETE',
      path: /^\/v2\/rooms\/([^/]+)$/,
      answer: ([id]) => {
        // alfaview refuses a meeting room with 422 and an empty detail, and answers 204 also for a
        // room that does not exist.
        if (roomOf(id!)?.type === 'meeting') return problem(422, '');
        // alfaview deletes the breakout rooms with the room, and the guest links and group links
        // of the room later. The fake deletes them at once.
        state.rooms = state.rooms.filter((room) => !sameId(room.id, id!));
        state.guestLinks = state.guestLinks.filter((link) => !sameId(link.roomId, id!));
        state.groupLinks = state.groupLinks.filter((link) => !sameId(link.roomId, id!));
        return NO_CONTENT;
      },
    },
    {
      method: 'GET',
      path: /^\/v2\/rooms\/([^/]+)\/permissions$/,
      answer: ([id]) => roomPermissions(id!),
    },
    {
      method: 'POST',
      path: /^\/v2\/rooms\/([^/]+)\/permissions$/,
      answer: ([id], { body }) => createPermission(id!, body),
    },
    {
      method: 'PATCH',
      path: /^\/v2\/rooms\/([^/]+)\/permissions\/([^/]+)$/,
      answer: ([roomId, userId], { body }) => updatePermission(roomId!, userId!, body),
    },
    {
      method: 'DELETE',
      path: /^\/v2\/rooms\/([^/]+)\/permissions\/([^/]+)$/,
      answer: ([roomId, userId]) => {
        const room = roomOf(roomId!);
        if (room === undefined) return roomMissing();
        // Like alfaview, it looks the entry up with the user ID as sent, and answers 204 also
        // when it finds none.
        room.userPermissions = (room.userPermissions ?? []).filter(
          (entry: Json) => entry.participantId !== userId,
        );
        return NO_CONTENT;
      },
    },
    {
      method: 'GET',
      path: /^\/v2\/room-types$/,
      answer: () => ok(state.roomTypes),
    },
    {
      method: 'GET',
      path: /^\/v2\/rooms\/([^/]+)\/features$/,
      answer: ([id]) => roomFeatures(id!),
    },
    {
      method: 'PATCH',
      path: /^\/v2\/rooms\/([^/]+)\/features$/,
      answer: ([id], { body }) => updateRoomFeatures(id!, body),
    },
    {
      method: 'GET',
      path: /^\/v2\/rooms\/([^/]+)\/language-settings$/,
      answer: ([id]) => (roomOf(id!) === undefined ? roomMissing() : ok(languageSettingsOf(id!))),
    },
    {
      method: 'PATCH',
      path: /^\/v2\/rooms\/([^/]+)\/language-settings$/,
      answer: ([id], { body }) => updateLanguageSettings(id!, body),
    },
    {
      method: 'GET',
      path: /^\/v2\/languages$/,
      answer: () => ok(state.languages),
    },
    {
      method: 'GET',
      path: /^\/v2\/rooms\/([^/]+)\/file-share-settings$/,
      // alfaview never answers 404 here: it reads default settings for any room.
      answer: ([id]) => ok(fileShareSettingsOf(id!)),
    },
    {
      method: 'PATCH',
      path: /^\/v2\/rooms\/([^/]+)\/file-share-settings$/,
      answer: ([id], { body }) => updateFileShareSettings(id!, body),
    },
    {
      method: 'GET',
      path: /^\/v2\/rooms\/([^/]+)\/file-share-limits$/,
      answer: () => ok(state.fileShareLimits),
    },
    {
      method: 'GET',
      path: /^\/v2\/rooms\/([^/]+)\/subrooms$/,
      // A bare array, or null for a room without breakout rooms.
      answer: ([id]) => {
        const room = roomOf(id!);
        return room === undefined ? roomMissing() : ok(room.subrooms ?? null);
      },
    },
    {
      method: 'POST',
      path: /^\/v2\/rooms\/([^/]+)\/subrooms$/,
      answer: ([id], { body }) => createSubroom(id!, body),
    },
    {
      method: 'PATCH',
      path: /^\/v2\/rooms\/([^/]+)\/subrooms\/([^/]+)$/,
      answer: ([roomId, id], { body }) => updateSubroom(roomId!, id!, body),
    },
    {
      method: 'DELETE',
      path: /^\/v2\/rooms\/([^/]+)\/subrooms\/([^/]+)$/,
      answer: ([roomId, id]) => {
        const room = roomOf(roomId!);
        if (room === undefined) return roomMissing();
        // alfaview answers 204 also for a breakout room that the room does not have, and deletes
        // nothing then.
        room.subrooms = (room.subrooms ?? []).filter((entry: Json) => entry.id !== id);
        return NO_CONTENT;
      },
    },
    {
      method: 'GET',
      path: /^\/v2\/users\/me$/,
      answer: () => ok(state.ownUser),
    },
    {
      method: 'GET',
      path: /^\/v2\/users\/me\/company$/,
      answer: () => ok(state.company),
    },
    {
      method: 'PATCH',
      path: /^\/v2\/users$/,
      answer: (_, { body }) => updateOwnUser(body),
    },
    {
      method: 'GET',
      path: /^\/v2\/users$/,
      answer: (_, { query }) => listUsers(query),
    },
    {
      method: 'POST',
      path: /^\/v2\/users\/invitation$/,
      answer: (_, { body }) => inviteUser(body),
    },
    {
      method: 'DELETE',
      path: /^\/v2\/users\/([^/]+)$/,
      answer: ([id]) => {
        // alfaview answers 204 also for a user that it does not find.
        state.users = state.users.filter((user) => !sameId(user.id, id!));
        return NO_CONTENT;
      },
    },
    {
      method: 'GET',
      path: /^\/v2\/rooms\/([^/]+)\/passcode$/,
      answer: ([id]) => {
        const room = roomOf(id!);
        if (room === undefined) return roomMissing();
        // alfaview answers 200 with an empty passcode for a room without a passcode, and 404 for a
        // room that it does not find.
        const passcode = state.passcodes.get(id!.toLowerCase());
        return ok(passcode ?? { passcode: '', required: room.passcodeRequired === true });
      },
    },
    {
      method: 'POST',
      path: /^\/v2\/rooms\/([^/]+)\/passcode$/,
      answer: ([id]) => {
        const room = roomOf(id!);
        if (room === undefined) return roomMissing();
        createdCount += 1;
        const passcode = {
          passcode: `Nw${createdCount}#pQ7x`,
          required: room.passcodeRequired === true,
        };
        state.passcodes.set(id!.toLowerCase(), passcode);
        return ok(passcode);
      },
    },
    {
      method: 'GET',
      path: /^\/v2\/rooms\/([^/]+)\/guest-links$/,
      answer: ([id], { query }) =>
        roomOf(id!) === undefined
          ? roomMissing()
          : page(
              state.guestLinks.filter((link) => sameId(link.roomId, id!)),
              query,
            ),
    },
    {
      method: 'POST',
      path: /^\/v2\/rooms\/([^/]+)\/guest-links$/,
      answer: ([id], { body }) => createGuestLinks(id!, body),
    },
    {
      method: 'DELETE',
      path: /^\/v2\/rooms\/([^/]+)\/guest-links\/([^/]+)$/,
      answer: ([roomId, id]) => {
        // alfaview answers 204 also when the link is not in this room, and deletes nothing then.
        const index = state.guestLinks.findIndex(
          (link) => sameId(link.id, id!) && sameId(link.roomId, roomId!),
        );
        if (index >= 0) state.guestLinks.splice(index, 1);
        const meeting = index >= 0 ? meetingOf(roomId!) : undefined;
        if (meeting !== undefined && Array.isArray(meeting.guestLinks)) {
          meeting.guestLinks = meeting.guestLinks.filter((linkId: string) => !sameId(linkId, id!));
        }
        return NO_CONTENT;
      },
    },
    {
      method: 'GET',
      path: /^\/v2\/rooms\/([^/]+)\/participants$/,
      answer: ([id]) =>
        roomOf(id!) === undefined
          ? roomMissing()
          : ok(state.participants.get(id!.toLowerCase()) ?? null),
    },
    {
      method: 'GET',
      path: /^\/v2\/rooms\/([^/]+)\/attendances$/,
      answer: ([id], { query }) => attendances(id!, query),
    },
    {
      method: 'GET',
      path: /^\/v2\/guest-links$/,
      answer: (_, { query }) => page(state.guestLinks, query),
    },
    {
      method: 'GET',
      path: /^\/v2\/guest-links\/([^/]+)$/,
      answer: ([id]) => {
        const link = linkOf(id!);
        return link === undefined ? problem(404, 'guest link not found') : ok(link);
      },
    },
    {
      method: 'PATCH',
      path: /^\/v2\/guest-links\/([^/]+)$/,
      answer: ([id], { body }) => updateGuestLink(id!, body),
    },
    {
      method: 'GET',
      path: /^\/v2\/rooms\/([^/]+)\/group-links$/,
      // alfaview answers 404 for a room that it does not find, a status that the spec does not
      // list.
      answer: ([id], { query }) =>
        roomOf(id!) === undefined
          ? roomMissing()
          : page(
              state.groupLinks.filter((link) => sameId(link.roomId, id!)),
              query,
            ),
    },
    {
      method: 'POST',
      path: /^\/v2\/rooms\/([^/]+)\/group-links$/,
      answer: ([id], { body }) => createGroupLinks(id!, body),
    },
    {
      method: 'DELETE',
      path: /^\/v2\/rooms\/([^/]+)\/group-links\/([^/]+)$/,
      answer: ([roomId, id]) => {
        // alfaview answers 204 also when the link is not in this room, and deletes nothing then.
        const index = state.groupLinks.findIndex(
          (link) => sameId(link.id, id!) && sameId(link.roomId, roomId!),
        );
        if (index >= 0) state.groupLinks.splice(index, 1);
        return NO_CONTENT;
      },
    },
    {
      method: 'GET',
      path: /^\/v2\/group-links$/,
      answer: (_, { query }) => page(state.groupLinks, query),
    },
    {
      method: 'GET',
      path: /^\/v2\/group-links\/([^/]+)$/,
      answer: ([id]) => {
        const link = groupLinkOfId(id!);
        return link === undefined ? problem(404, 'group link not found') : ok(link);
      },
    },
    {
      method: 'PATCH',
      path: /^\/v2\/group-links\/([^/]+)$/,
      answer: ([id], { body }) => updateGroupLink(id!, body),
    },
    {
      method: 'GET',
      path: /^\/v2\/meetings$/,
      answer: (_, { query }) => {
        const from = Date.parse(query.from ?? '');
        const to = Date.parse(query.to ?? '');
        // As alfaview: a missing bound sets no limit, and `from` after `to` answers 422.
        if (from > to) return reversedRange();
        return ok(
          state.meetings
            .filter((meeting) => !(Date.parse(meeting.start) > to) && !(Date.parse(meeting.end) < from))
            .map((meeting) => ({ ...meeting, groupLinks: {} })),
        );
      },
    },
    {
      method: 'POST',
      path: /^\/v2\/meetings$/,
      answer: (_, { body }) => createMeeting(body),
    },
    {
      method: 'GET',
      path: /^\/v2\/meetings\/([^/]+)$/,
      answer: ([id]) => {
        const meeting = meetingOf(id!);
        return meeting === undefined ? problem(404, 'meeting not found') : ok(meeting);
      },
    },
    {
      method: 'PATCH',
      path: /^\/v2\/meetings\/([^/]+)$/,
      answer: ([id], { body }) => updateMeeting(id!, body),
    },
    {
      method: 'POST',
      path: /^\/v2\/meetings\/([^/]+)\/cancellation$/,
      answer: ([id]) => {
        const meeting = meetingOf(id!);
        if (meeting === undefined) return problem(404, 'meeting not found');
        meeting.state = 'canceled';
        meeting.canJoin = false;
        meeting.canceledAt = new Date(now()).toISOString();
        return NO_CONTENT;
      },
    },
    {
      method: 'GET',
      path: /^\/v2\/permission-groups$/,
      answer: () => ok(state.permissionGroups),
    },
    {
      method: 'GET',
      path: /^\/v2\/stats$/,
      answer: (_, { query }) => statistics(query),
    },
  ];

  function answerOf(request: FakeRequest): Answer {
    if (nextStatus !== undefined) {
      const status = nextStatus;
      nextStatus = undefined;
      if (status === 401) validTokens.clear();
      return problem(status, 'answered with this status on request of the test');
    }
    if (request.method === 'POST' && request.path === '/v2/auth/api-key') {
      return logIn(request.body);
    }
    // Only a token that the fake issued counts, and only without a Bearer prefix, so the tests hold
    // the client to the raw token.
    if (request.authorization === undefined || !validTokens.has(request.authorization)) {
      return problem(401, 'An invalid access token was provided in the Authorization header.');
    }
    const before = faultFor(request, false);
    if (before !== undefined) {
      request.fault = { applied: false };
      return problem(before.status, '');
    }
    const answer = routeAnswer(request);
    if (answer.status >= 300) return answer;
    const after = faultFor(request, true);
    if (after === undefined) return answer;
    request.fault = { applied: true };
    return problem(after.status, '');
  }

  function routeAnswer(request: FakeRequest): Answer {
    for (const route of routes) {
      if (route.method !== request.method) continue;
      const match = route.path.exec(request.path);
      if (match !== null) return route.answer(match.slice(1).map(decodeURIComponent), request);
    }
    return problem(404, `no route for ${request.method} ${request.path}`);
  }

  function handle({ method, target, headers, text }: Parameters<FakeApiCore['handle']>[0]): Answer {
    keepContractProblems({ method, path: target, headers, body: text }, undefined, undefined);
    const url = new URL(target, 'http://127.0.0.1');
    const authorization = headers.authorization;
    const request: FakeRequest = {
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: typeof authorization === 'string' ? authorization : undefined,
      body: undefined,
      status: 0,
    };
    let answer: Answer;
    try {
      request.body = text === '' ? undefined : JSON.parse(text);
      answer = answerOf(request);
    } catch {
      answer = problem(400, 'the body is not JSON');
    }
    request.status = answer.status;
    requests.push(request);
    return answer;
  }

  return {
    requests,
    state,
    tokens,
    answerNextWith(status) {
      nextStatus = status;
    },
    unfiredFaults: () => faults.filter((entry) => entry.matches < (entry.fault.nth ?? 1)).map((entry) => entry.fault),
    handle,
  };
}

/** Starts the fake API on 127.0.0.1 with a free port. */
export async function startFakeApi(
  state: FakeState,
  options: FakeApiOptions = {},
): Promise<FakeApi> {
  const { handle, ...core } = createFakeApi(state, options);
  const server = createServer((incoming, response) => {
    readBody(incoming).then(
      (text) => {
        const method = incoming.method ?? '';
        const target = incoming.url ?? '/';
        send(response, handle({ method, target, headers: incoming.headers, text }));
      },
      () => send(response, problem(400, 'the body could not be read')),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    ...core,
    origin: `http://127.0.0.1:${port}`,
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

const PRODUCTION_ORIGIN = 'https://apis.alfaview.com';

/**
 * Returns a fetch that answers the requests for https://apis.alfaview.com from `api`, in the test
 * process and without a socket, and refuses every other URL.
 */
export function fakeApiFetch(api: FakeApiCore): typeof fetch {
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== PRODUCTION_ORIGIN) throw new TypeError(`fakeApiFetch refused ${url.href}`);
    const answer = api.handle({
      method: init.method ?? 'GET',
      target: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(new Headers(init.headers)),
      text: typeof init.body === 'string' ? init.body : '',
    });
    if (answer.body === undefined) return new Response(null, { status: answer.status });
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'Content-Type': contentTypeOf(answer) },
    });
  };
  return fetch as typeof globalThis.fetch;
}
