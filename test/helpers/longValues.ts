// Long values and alfaview answers with many entries, for the result size test. Every entry has
// every field that the tools return, with long values such as 40-character email addresses, so
// the results are as large as they get with real data.

export const ROOM_ID = 'a1b2c3d4-5e6f-5a7b-8c9d-210000000001';
export const SUBROOM_ID = 'a1b2c3d4-5e6f-5a7b-8c9d-230000000001';
export const GUEST_GROUP_ID = 'd2b3c4d5-e6f7-5081-9a2b-c3d4e5f6a7b8';

/** The origin of the guest links of one webinar: its date and its topic. */
export const WEBINAR_ORIGIN = 'Webinar 2026-10-07 Altersvorsorge';

/** Returns a version 5 UUID with the IETF variant, `kind` in byte 10 and `n` in its last digits. */
export function idOf(kind: string, n: number): string {
  return `a1b2c3d4-5e6f-5a7b-8c9d-${kind}${String(n).padStart(10, '0')}`;
}

/** The ID of guest link `n`: byte 10 is 0x14. */
export const guestLinkIdOf = (n: number) => idOf('14', n);

/** The userId of the guest of guest link `n`: byte 10 is 0x18. */
export const guestUserIdOf = (n: number) => idOf('18', n);

/** Returns a 40-character email address, a different one for each `n` below 100,000. */
export function longEmail(n: number): string {
  const domain = '@example-company.com';
  const local = `invitee.${String(n).padStart(5, '0')}.firstname.lastname`;
  return local.slice(0, 40 - domain.length) + domain;
}

/** Returns a 30-character name. */
export function longName(n: number): string {
  return `Maximiliane-Sophie ${String(n).padStart(4, '0')} Mustermann`.slice(0, 30);
}

/** Returns a Calendly invitee URI of 124 characters, the origin of a guest link of a booking. */
export function calendlyOrigin(n: number): string {
  const event = idOf('31', n);
  const invitee = idOf('32', n);
  return `https://api.calendly.com/scheduled_events/${event}/invitees/${invitee}`;
}

/** Returns a join URL with its 32-character access key. */
export function joinUrlOf(roomId: string, n: number): string {
  const key = `Hj7kL9zX2cV4bN6mQ8wE0rT1${String(n).padStart(8, '0')}`;
  return `https://app.alfaview.com/#/join/0123456789ABCDEFGHIJKLMNOP/${roomId}/${key}`;
}

/** Returns `count` rooms with long names. */
export function apiRooms(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    id: idOf('21', index + 1),
    displayName: `Beratungsraum ${longName(index + 1)}`,
    type: 'room',
    parentId: idOf('20', 1),
    waitingRoomEnabled: true,
    passcodeRequired: true,
    sort: index,
  }));
}

export type LinkOptions = {
  roomId?: string;
  origin?: (n: number) => string;
  validFrom: string;
  validUntil: string;
  /** The number of the first link. Default 1. */
  first?: number;
};

/** Returns guest link `n` as an alfaview answer has it, with the userId of its guest. */
export function apiGuestLink(n: number, options: LinkOptions): Record<string, unknown> {
  const roomId = options.roomId ?? ROOM_ID;
  return {
    id: guestLinkIdOf(n),
    userId: guestUserIdOf(n),
    roomId,
    createdBy: idOf('19', 1),
    createdAt: '2026-09-25T10:00:00.123Z',
    permissionGroupId: GUEST_GROUP_ID,
    accessKey: `Hj7kL9zX2cV4bN6mQ8wE0rT1${String(n).padStart(8, '0')}`,
    emailAddress: longEmail(n),
    displayName: longName(n),
    locale: 'de-DE',
    origin: (options.origin ?? calendlyOrigin)(n),
    dialInAllowed: false,
    dialInCode: '',
    joinUrl: joinUrlOf(roomId, n),
    validFrom: options.validFrom,
    validUntil: options.validUntil,
  };
}

/** Returns `count` guest links, numbered from `options.first`. */
export function apiGuestLinks(count: number, options: LinkOptions): Record<string, unknown>[] {
  const first = options.first ?? 1;
  return Array.from({ length: count }, (_, index) => apiGuestLink(first + index, options));
}

/** The ID of group link `n`: byte 10 is 0x15. */
export const groupLinkIdOf = (n: number) => idOf('15', n);

/** A permission group name of 30 characters. */
export const LONG_GROUP_NAME = 'Webinar Teilnehmende ohne Ton.';

/** Returns a group link description of 80 characters, a different one for each `n` below 10,000. */
export function longDescription(n: number): string {
  return `Tag der offenen Tuer ${String(n).padStart(4, '0')} im Beratungszentrum fuer Altersvorsorge und Vermoegensaufbau`.slice(0, 80);
}

/** Returns group link `n` as an alfaview answer has it, with every field and a dial-in code. */
export function apiGroupLink(n: number, options: LinkOptions): Record<string, unknown> {
  const roomId = options.roomId ?? ROOM_ID;
  return {
    id: groupLinkIdOf(n),
    roomId,
    description: longDescription(n),
    permissionGroupId: GUEST_GROUP_ID,
    createdBy: idOf('12', 1),
    createdAt: '2026-09-25T10:00:00.123Z',
    joinLink: joinUrlOf(roomId, n),
    joinUrl: joinUrlOf(roomId, n),
    accessKey: `Hj7kL9zX2cV4bN6mQ8wE0rT1${String(n).padStart(8, '0')}`,
    origin: (options.origin ?? calendlyOrigin)(n),
    dialInAllowed: true,
    dialInCode: '12345678',
    validFrom: options.validFrom,
    validUntil: options.validUntil,
  };
}

/** Returns `count` group links, numbered from `options.first`. */
export function apiGroupLinks(count: number, options: LinkOptions): Record<string, unknown>[] {
  const first = options.first ?? 1;
  return Array.from({ length: count }, (_, index) => apiGroupLink(first + index, options));
}

/** The ID of user `n`: byte 10 is 0x12. */
export const userIdOf = (n: number) => idOf('12', n);

/** A title of 20 characters, the most that alfaview takes. */
export const LONG_TITLE = 'Prof. Dr. habil. Dr.';

/** Returns `count` users with every field of the API and long email addresses, names and titles. */
export function apiUsers(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    id: userIdOf(index + 1),
    emailAddress: longEmail(index + 1),
    firstName: longName(index + 1),
    lastName: longName(index + 1),
    title: LONG_TITLE,
    city: 'Berlin',
    initials: 'MSM',
    locale: 'de-DE',
  }));
}

/** Returns the room permission entry of each of `userIds`, with all nine permissions. */
export function apiRoomPermissionEntries(userIds: readonly string[]): Record<string, unknown>[] {
  return userIds.map((participantId) => ({
    participantId,
    permissions: {
      admin: false,
      voice: true,
      video: true,
      promote: false,
      join: true,
      screen: true,
      vip: false,
      chat: true,
      upload: true,
    },
  }));
}

/** Returns `count` meetings with long titles, each with three guest links. */
export function apiMeetings(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    id: idOf('22', index + 1),
    title: `Beratungsgespraech Altersvorsorge ${longName(index + 1)}`,
    start: '2026-10-12T08:00:00Z',
    end: '2026-10-12T09:00:00Z',
    timezone: 'Europe/Berlin',
    state: 'scheduled',
    agenda: 'Portfolio review and next steps.',
    earlyAccessMinutes: 10,
    canJoin: false,
    canJoinAfter: '2026-10-12T07:50:00Z',
    roomAvailable: false,
    createdAt: '2026-09-25T10:00:00Z',
    createdBy: idOf('19', 1),
    guestLinks: [guestLinkIdOf(3 * index + 1), guestLinkIdOf(3 * index + 2), guestLinkIdOf(3 * index + 3)],
    groupLinks: {},
  }));
}

/**
 * Returns the guests of guest links 1 to `count` in one breakout room (the API calls it a
 * subroom), each on break, so that every field of a participant has a value.
 */
export function apiParticipantGroups(count: number): Record<string, unknown>[] {
  return [
    {
      subRoomId: SUBROOM_ID,
      participants: Array.from({ length: count }, (_, index) => ({
        userId: guestUserIdOf(index + 1),
        displayName: longName(index + 1),
        onBreak: true,
        inWaitingRoom: false,
        isGuest: true,
        isSpectator: false,
        isDialIn: false,
      })),
    },
  ];
}

/**
 * Returns one session of each user, from `from` to `to`. A `to` in the year 1 means that the user
 * is still connected.
 */
export function apiAttendances(
  userIds: readonly string[],
  from: string,
  to: string,
): Record<string, unknown>[] {
  return userIds.map((userId, index) => ({
    userId,
    attendances: [{ displayName: longName(index + 1), from, to }],
  }));
}

/** Returns `count` statistics periods of `stepHours` hours from `from`, with large numbers. */
export function apiStatsPeriods(count: number, from: string, stepHours: number) {
  const start = Date.parse(from);
  const stats = {
    activeCount: 1234,
    sessionCount: 56789,
    roomOnlineSeconds: 12345678,
    usersOnlineSeconds: 98765432,
  };
  return Array.from({ length: count }, (_, index) => ({
    from: new Date(start + index * stepHours * 3_600_000).toISOString(),
    to: new Date(start + (index + 1) * stepHours * 3_600_000).toISOString(),
    rooms: stats,
    meetings: stats,
  }));
}
