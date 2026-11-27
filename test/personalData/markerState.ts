// The alfaview company of the marker test of the option Personal data, as the state of the fake API
// of fake-api/server.ts. The markers are in lower case, because the checks read the text in lower
// case.
import {
  API_USER_ID,
  GUEST_GROUP_ID,
  groupLinkOf,
  guestLinkOf,
  meetingRoomOf,
  sampleGuestLink,
  sampleId,
  type FakeState,
} from '../fake-api/server.ts';
import { fixture } from '../helpers/fixtures.ts';

/**
 * The marker of each value that Leave out removes: a name, an email address, a title, a city,
 * initials, a welcome note, a meeting title, an agenda and an origin. A meeting room takes the
 * meeting title as its name, so that name holds the marker too.
 */
export const PERSONAL_MARKER = 'zzpersonalzz';
/**
 * The marker of each value that stays: the names of ordinary rooms, breakout rooms, permission
 * groups and the company, and the descriptions of group links.
 */
export const KEPT_MARKER = 'zzkeptzz';

/** The time of the test clock of mcpClient.ts. */
export const T0 = Date.parse('2026-10-07T08:00:00Z');

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const NOT_SET = '0001-01-01T00:00:00Z';

export const iso = (ms: number) => new Date(ms).toISOString();

/** Returns an email address that holds the personal marker. */
export function markedEmail(name: string): string {
  return `${name}.${PERSONAL_MARKER}@example.com`;
}

/** Returns a name that holds the personal marker. */
export function markedName(name: string): string {
  return `${name} ${PERSONAL_MARKER}`;
}

export const ROOM_ID = sampleId('21', 1);
export const DEPARTMENT_ID = sampleId('20', 1);
export const SUBROOM_ID = sampleId('23', 1);
export const MEETING_ID = sampleId('22', 1);

/** A permission group whose name stays with Leave out. */
export const KEPT_GROUP_ID = sampleId('31', 1);
export const KEPT_GROUP_NAME = `Webinar ${KEPT_MARKER}`;

/** The origin of the guest links of yesterday's webinar. */
export const WEBINAR_ORIGIN = `Webinar ${PERSONAL_MARKER}`;
/** The validity of the webinar links: 26 to 24 hours before T0. */
export const WEBINAR_FROM = T0 - 26 * HOUR_MS;
export const WEBINAR_UNTIL = T0 - 24 * HOUR_MS;

/**
 * The guest links and the userIds of their guests, as alfaview returns them with each link. Anna
 * attended the webinar, Bob did not.
 */
const ANNA_LINK = sampleGuestLink(1);
const BOB_LINK = sampleGuestLink(2);
export const ANNA_LINK_ID = ANNA_LINK.id;
export const BOB_LINK_ID = BOB_LINK.id;
/** Carla has a link of the room without a validity, and attended in the window of the webinar. */
const CARLA_LINK = sampleGuestLink(3);
export const CARLA_LINK_ID = CARLA_LINK.id;
/** Dora's appointment is now: she waits in the waiting room. */
const DORA_LINK = sampleGuestLink(4);
export const DORA_LINK_ID = DORA_LINK.id;
export const APPOINTMENT_ORIGIN = `Appointment ${PERSONAL_MARKER}`;
export const APPOINTMENT_FROM = T0 - HOUR_MS;
export const APPOINTMENT_UNTIL = T0 + HOUR_MS;
/** A link that expired six days ago, for the cleanup. */
const OLD_LINK = sampleGuestLink(5);
export const OLD_LINK_ID = OLD_LINK.id;

/** The group link of tomorrow's open house: its description stays, its origin is removed. */
export const GROUP_LINK_ID = sampleId('15', 1);
export const GROUP_LINK_ORIGIN = `Open house ${PERSONAL_MARKER}`;

/** A guest who waits without a guest link of the room. */
const VISITOR_USER_ID = sampleId('18', 50);

/** Two users of the company besides the API key's user: user IDs of the kind 18 (hex 12). */
export const BEN_USER_ID = sampleId('12', 2);
export const CARLA_USER_ID = sampleId('12', 3);

/**
 * The start of the meeting, five days ahead. The meeting has no guest links, so update_meeting
 * needs no sendEmail.
 */
export const MEETING_START = T0 + 5 * DAY_MS;

/** Returns the state of the marker test's company, new for every run. */
export function markerState(): FakeState {
  const created = iso(T0 - 5 * DAY_MS);
  const link = (
    pair: { id: string; userId: string },
    name: string,
    fields: { origin: string; validFrom?: number; validUntil?: number },
  ) =>
    guestLinkOf({
      ...pair,
      roomId: ROOM_ID,
      emailAddress: markedEmail(name.toLowerCase()),
      displayName: markedName(name),
      origin: fields.origin,
      permissionGroupId: KEPT_GROUP_ID,
      validFrom: fields.validFrom === undefined ? NOT_SET : iso(fields.validFrom),
      validUntil: fields.validUntil === undefined ? NOT_SET : iso(fields.validUntil),
      createdAt: created,
    });
  const webinar = { origin: WEBINAR_ORIGIN, validFrom: WEBINAR_FROM, validUntil: WEBINAR_UNTIL };

  const meeting = {
    id: MEETING_ID,
    title: `Review ${PERSONAL_MARKER}`,
    start: iso(MEETING_START),
    end: iso(MEETING_START + HOUR_MS),
    timezone: 'Europe/Berlin',
    state: 'scheduled',
    agenda: `Agenda ${PERSONAL_MARKER}`,
    earlyAccessMinutes: 10,
    canJoin: false,
    canJoinAfter: iso(MEETING_START - 10 * MINUTE_MS),
    roomAvailable: false,
    createdAt: created,
    createdBy: API_USER_ID,
    guestLinks: null,
    groupLinks: {
      [GUEST_GROUP_ID]: `https://app.alfaview.com/#/join/0123456789ABCDEFGHIJKLMNOP/${MEETING_ID}/Gk1`,
      [KEPT_GROUP_ID]: `https://app.alfaview.com/#/join/0123456789ABCDEFGHIJKLMNOP/${MEETING_ID}/Gk2`,
    },
  };

  const room = {
    ...fixture('rooms/room.json'),
    id: ROOM_ID,
    parentId: DEPARTMENT_ID,
    displayName: `Advisory Room ${KEPT_MARKER}`,
    waitingRoomWelcomeNote: `Welcome, ${PERSONAL_MARKER}.`,
    subrooms: [{ id: SUBROOM_ID, sort: 1, displayName: `Breakout 1 ${KEPT_MARKER}` }],
    // The API key's user and Ben have a room permission, and Carla has none.
    userPermissions: [
      ...fixture('rooms/room.json').userPermissions,
      {
        participantId: BEN_USER_ID,
        permissions: { ...fixture('rooms/room.json').defaultPermissions, screen: true },
      },
    ],
  };
  const department = {
    id: DEPARTMENT_ID,
    displayName: `Advisors ${KEPT_MARKER}`,
    type: 'department',
    managed: false,
    createdAt: created,
  };
  const meetingRoom = { ...meetingRoomOf(meeting), waitingRoomWelcomeNote: `Hello, ${PERSONAL_MARKER}.` };

  const session = (name: string, from: number, to?: number) => ({
    displayName: markedName(name),
    from: iso(from),
    to: to === undefined ? NOT_SET : iso(to),
  });

  return {
    rooms: [room, department, meetingRoom],
    passcodes: new Map([[ROOM_ID, { passcode: 'Kx7#mQ2p', required: true }]]),
    permissionGroups: [
      ...fixture('rooms/permission-groups.json'),
      { id: KEPT_GROUP_ID, name: KEPT_GROUP_NAME, permissions: { join: true } },
    ],
    guestLinks: [
      link(ANNA_LINK, 'Anna', webinar),
      link(BOB_LINK, 'Bob', webinar),
      link(CARLA_LINK, 'Carla', { origin: `Booking ${PERSONAL_MARKER}` }),
      link(DORA_LINK, 'Dora', {
        origin: APPOINTMENT_ORIGIN,
        validFrom: APPOINTMENT_FROM,
        validUntil: APPOINTMENT_UNTIL,
      }),
      link(OLD_LINK, 'Olga', {
        origin: `Old ${PERSONAL_MARKER}`,
        validFrom: T0 - 6 * DAY_MS - HOUR_MS,
        validUntil: T0 - 6 * DAY_MS,
      }),
    ],
    groupLinks: [
      groupLinkOf({
        id: GROUP_LINK_ID,
        roomId: ROOM_ID,
        description: `Open house ${KEPT_MARKER}`,
        origin: GROUP_LINK_ORIGIN,
        permissionGroupId: KEPT_GROUP_ID,
        validFrom: iso(T0 + DAY_MS),
        validUntil: iso(T0 + DAY_MS + 3 * HOUR_MS),
        createdAt: created,
      }),
    ],
    meetings: [meeting],
    participants: new Map([
      [
        ROOM_ID,
        [
          {
            subRoomId: sampleId('23', 90),
            participants: [
              {
                userId: DORA_LINK.userId,
                displayName: '',
                onBreak: false,
                inWaitingRoom: true,
                isGuest: true,
                isSpectator: false,
                isDialIn: false,
              },
            ],
          },
          {
            subRoomId: sampleId('23', 91),
            participants: [
              {
                userId: VISITOR_USER_ID,
                displayName: markedName('Visitor'),
                onBreak: false,
                inWaitingRoom: true,
                isGuest: true,
                isSpectator: false,
                isDialIn: false,
              },
            ],
          },
          {
            subRoomId: '00000000-0000-0000-0000-000000000000',
            participants: [
              {
                userId: API_USER_ID,
                displayName: markedName('Advisor'),
                onBreak: false,
                inWaitingRoom: false,
                isGuest: false,
                isSpectator: false,
                isDialIn: false,
              },
            ],
          },
        ],
      ],
    ]),
    attendances: new Map([
      [
        ROOM_ID,
        [
          {
            userId: ANNA_LINK.userId,
            attendances: [session('Anna', WEBINAR_FROM + 5 * MINUTE_MS, WEBINAR_UNTIL - 5 * MINUTE_MS)],
          },
          {
            userId: CARLA_LINK.userId,
            attendances: [session('Carla', WEBINAR_FROM + HOUR_MS, WEBINAR_FROM + 90 * MINUTE_MS)],
          },
          {
            userId: API_USER_ID,
            attendances: [
              session('Advisor', WEBINAR_FROM, WEBINAR_UNTIL),
              session('Advisor', T0 - 30 * MINUTE_MS),
            ],
          },
          {
            userId: DORA_LINK.userId,
            attendances: [session('Dora', T0 - 10 * MINUTE_MS)],
          },
          { userId: VISITOR_USER_ID, attendances: [session('Visitor', T0 - 3 * MINUTE_MS)] },
        ],
      ],
    ]),
    statistics: fixture('statistics/stats.json'),
    // The stored profile holds the marker in each of its six personal values, also in the
    // initials, which update_own_user cannot set to a value this long.
    ownUser: {
      id: API_USER_ID,
      emailAddress: markedEmail('advisor'),
      firstName: markedName('Anna'),
      lastName: markedName('Example'),
      title: `Dr ${PERSONAL_MARKER}`,
      city: markedName('Berlin'),
      initials: PERSONAL_MARKER,
      locale: 'de-DE',
    },
    // Each personal value of a user holds the marker. The output of find_users has no city and no
    // initials, also not those of Carla.
    users: [
      {
        id: BEN_USER_ID,
        emailAddress: markedEmail('ben'),
        firstName: markedName('Ben'),
        lastName: markedName('Brown'),
        title: `Prof ${PERSONAL_MARKER}`,
        locale: 'en-US',
      },
      {
        id: CARLA_USER_ID,
        emailAddress: markedEmail('carla'),
        firstName: markedName('Carla'),
        lastName: markedName('Clark'),
        city: markedName('Hamburg'),
        initials: PERSONAL_MARKER,
        locale: 'de-DE',
      },
    ],
    company: { companyId: 'company-1', displayName: `Example Training ${KEPT_MARKER}`, createdAt: created },
    roomTypes: fixture('rooms/room-types.json'),
    // The room settings hold codes, states and counts only, no text of a person.
    languageSettings: new Map([[ROOM_ID, fixture('rooms/language-settings.json')]]),
    languages: fixture('rooms/languages.json'),
    fileShareSettings: new Map(),
    fileShareLimits: fixture('rooms/file-share-limits.json'),
  };
}
