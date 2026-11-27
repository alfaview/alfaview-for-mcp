/**
 * Participants: who is connected to a room now, with the start of each person's visit and the
 * guest link of each guest.
 */
import {
  currentVisitStart,
  DAY_MS,
  dropExpiredUsers,
  sessionsByUserId,
  summarize,
  type ApiAttendanceSession,
  type ApiUserAttendances,
} from './attendance.ts';
import type { ApiGuestLink } from './guestLinks.ts';
import { createInputReaders } from './inputs.ts';
import { booleanOrNull, textOrNull } from './outputValues.ts';
import type { Platform } from './platform.ts';
import { normalizeTimestamp } from './time.ts';

// Constants

/** The time range of attendance before now that gives the visit start and the attendance name. */
export const VISIT_WINDOW_MS = DAY_MS;

/** The `subRoomId` of the main room. A person in the main room has this ID or none. */
export const MAIN_ROOM_ID = '00000000-0000-0000-0000-000000000000';

export const PARTICIPANT_SCOPES = ['guest_links', 'guests', 'everyone'] as const;
export type ParticipantScope = (typeof PARTICIPANT_SCOPES)[number];

export const PARTICIPANT_LOCATIONS = ['waiting_room', 'room'] as const;
export type ParticipantLocation = (typeof PARTICIPANT_LOCATIONS)[number];

// API shapes (spec: SubroomParticipants, Participant)

/**
 * A person of `GET /v2/rooms/{id}/participants`. The list groups people by `subRoomId`, in no
 * stated order, with no join time and no guest link. The visit start comes from the attendance
 * sessions of the room (currentVisitStart), and the guest link from the `userId` that alfaview
 * gives with each guest link of the room (guestLinksByUserId of attendance.ts). A person in a
 * waiting room has `inWaitingRoom: true` and the `subRoomId` of that waiting room. `displayName`
 * is empty unless the API key's user may see user names. alfaview answers 403 unless the API
 * key's user has the room permission Join in the room.
 */
export type ApiParticipant = {
  userId: string;
  displayName?: string;
  onBreak?: boolean;
  inWaitingRoom?: boolean;
  isGuest?: boolean;
  isSpectator?: boolean;
  isDialIn?: boolean;
};

/**
 * One person of the participant list, with the `subRoomId` of their group, and whether the person
 * waits to be let in (`flattenParticipants` says how it decides).
 */
export type RoomParticipant = ApiParticipant & { subRoomId: string | null; waiting: boolean };

// Output shape

export type ParticipantType = 'guest_link' | 'guest' | 'user';

export type ParticipantOutput = {
  id: string;
  userId: string;
  roomId: string;
  roomName: string | null;
  participantType: ParticipantType;
  displayName: string | null;
  emailAddress: string | null;
  guestLinkId: string | null;
  guestLinkOrigin: string | null;
  guestLinkValidFrom: string | null;
  guestLinkValidUntil: string | null;
  connectedAt: string | null;
  inWaitingRoom: boolean | null;
  roomUserCount: number;
  subroomId: string | null;
  onBreak: boolean | null;
  isGuest: boolean | null;
  isSpectator: boolean | null;
  isDialIn: boolean | null;
};

// Participant list

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasUserId(member: Record<string, unknown>): member is ApiParticipant {
  return typeof member.userId === 'string' && member.userId !== '';
}

/**
 * Returns the people of a participant list, one entry per person with the `subRoomId` of their
 * group. A missing or `null` body means that nobody is connected. Entries without a `userId` are
 * left out, and a person listed twice keeps the first entry, with the `userId` compared without
 * case. Returns `undefined` for a body that is not a list, so that the caller throws its own
 * response error.
 *
 * `waiting` is `inWaitingRoom`, except for the company users in a waiting room group with more
 * than one person: alfaview gives each person who must wait a waiting room of their own, and only
 * a moderator can join it, to talk to that person. Such a user does not wait. Two cases look like
 * a waiting person in the list, so they count as waiting: a moderator who stays alone in a waiting
 * room, and a guest with moderator rights who joins a waiting room.
 */
export function flattenParticipants(data: unknown): RoomParticipant[] | undefined {
  if (data === undefined || data === null) return [];
  if (!Array.isArray(data)) return undefined;

  const seen = new Set<string>();
  const result: RoomParticipant[] = [];
  for (const group of data.filter(isObject)) {
    const subRoomId = textOrNull(group.subRoomId);
    const members = Array.isArray(group.participants)
      ? group.participants.filter(isObject).filter(hasUserId)
      : [];
    const peopleInWaitingRoom = new Set(
      members
        .filter((member) => member.inWaitingRoom === true)
        .map((member) => member.userId.toLowerCase()),
    );
    for (const member of members) {
      const userId = member.userId.toLowerCase();
      if (seen.has(userId)) continue;
      seen.add(userId);
      const joinedAnotherWaitingRoom = peopleInWaitingRoom.size > 1 && member.isGuest !== true;
      const waiting = member.inWaitingRoom === true && !joinedAnotherWaitingRoom;
      result.push({ ...member, subRoomId, waiting });
    }
  }
  return result;
}

/**
 * Returns the number of company users in the room itself: people who neither wait nor are guests.
 * A company user who talks to a waiting person in that person's waiting room counts. Pass the full
 * list, before any filter.
 */
export function countRoomUsers(participants: readonly RoomParticipant[]): number {
  return participants.filter((participant) => !participant.waiting && participant.isGuest !== true)
    .length;
}

// Scope and location filters

/**
 * Returns the people that `scope` can include. The scopes `guests` and `guest_links` keep the
 * people with `isGuest: true`, whatever the layout of their `userId`. Only a guest can have a guest
 * link, and with `guest_links` mapVisits later leaves out the guests without a guest link of this
 * room. Filtering first lets the caller skip the attendance request when only company users are
 * connected.
 */
export function peopleInScope(
  participants: readonly RoomParticipant[],
  scope: ParticipantScope,
): RoomParticipant[] {
  if (scope === 'everyone') return [...participants];
  return participants.filter((participant) => participant.isGuest === true);
}

/**
 * Returns whether one of `visits` is a guest by the flag `isGuest`. Only a guest can have a guest
 * link, so without a guest the caller can skip the read of the guest links of the room.
 */
export function hasGuest(visits: readonly { participant: RoomParticipant }[]): boolean {
  return visits.some((visit) => visit.participant.isGuest === true);
}

/** Returns the people at `location`: in the waiting room or in the room. No location keeps all. */
export function peopleAtLocation(
  participants: readonly RoomParticipant[],
  location: ParticipantLocation | undefined,
): RoomParticipant[] {
  return participants.filter(
    (participant) =>
      location === undefined || participant.waiting === (location === 'waiting_room'),
  );
}

// Mapper

/**
 * Returns the output `inWaitingRoom`: whether the person waits, so `false` for a company user who
 * talks to a waiting person in that person's waiting room. `null` when alfaview leaves the flag
 * out.
 */
export function inWaitingRoomOf(participant: RoomParticipant): boolean | null {
  return typeof participant.inWaitingRoom === 'boolean' ? participant.waiting : null;
}

/**
 * Returns the ID of the person's breakout room (the API calls it a subroom), or `null` in a
 * waiting room and in the main room.
 */
export function subroomIdOf(participant: RoomParticipant): string | null {
  if (participant.inWaitingRoom === true) return null;
  const subroomId = participant.subRoomId;
  return subroomId === null || subroomId.toLowerCase() === MAIN_ROOM_ID ? null : subroomId;
}

/**
 * Returns the Participant output of one person. `userId` is in lower case, `link` is the person's
 * guest link of this room, and `sessionName` is the name from the attendance. `roomName` is
 * `null`, and the caller adds it.
 */
export function mapParticipant(
  participant: RoomParticipant,
  details: {
    roomId: string;
    userId: string;
    connectedAt: string | null;
    link: ApiGuestLink | undefined;
    sessionName: string | null;
    roomUserCount: number;
  },
): ParticipantOutput {
  const { link, userId, connectedAt } = details;
  return {
    id: connectedAt === null ? userId : `${userId}|${connectedAt}`,
    userId,
    roomId: details.roomId,
    roomName: null,
    participantType:
      link !== undefined ? 'guest_link' : participant.isGuest === true ? 'guest' : 'user',
    displayName:
      (link === undefined ? null : textOrNull(link.displayName)) ??
      textOrNull(participant.displayName) ??
      details.sessionName,
    emailAddress: link === undefined ? null : textOrNull(link.emailAddress),
    guestLinkId: link === undefined ? null : link.id,
    guestLinkOrigin: link === undefined ? null : textOrNull(link.origin),
    guestLinkValidFrom: link === undefined ? null : normalizeTimestamp(link.validFrom),
    guestLinkValidUntil: link === undefined ? null : normalizeTimestamp(link.validUntil),
    connectedAt,
    inWaitingRoom: inWaitingRoomOf(participant),
    roomUserCount: details.roomUserCount,
    subroomId: subroomIdOf(participant),
    onBreak: booleanOrNull(participant.onBreak),
    isGuest: booleanOrNull(participant.isGuest),
    isSpectator: booleanOrNull(participant.isSpectator),
    isDialIn: booleanOrNull(participant.isDialIn),
  };
}

// Visits

/** One person of the participant list with the attendance sessions and the start of the visit. */
export type ParticipantVisit = {
  participant: RoomParticipant;
  /** The userId in lowercase. */
  userId: string;
  sessions: ApiAttendanceSession[];
  /** The start of the current visit, or `null` when the attendance does not show it. */
  connectedAt: string | null;
};

/**
 * Returns the visits of `participants`, each with the person's sessions of `entries` and the start
 * of the current visit (currentVisitStart). Rows of `entries` under NIL_USER_ID, which name no
 * person, are ignored. `entries` is `undefined` when the attendance could not be read: then every
 * visit has no sessions and `connectedAt: null`. With `skipUnrecordedVisits`, a person without a
 * current visit is left out and named in `skippedUserIds`, in the order of `participants`, so that
 * the caller can log each one.
 */
export function selectVisits(
  participants: readonly RoomParticipant[],
  entries: readonly ApiUserAttendances[] | undefined,
  now: number,
  skipUnrecordedVisits: boolean,
): { visits: ParticipantVisit[]; skippedUserIds: string[] } {
  const current = entries === undefined ? undefined : sessionsByUserId(dropExpiredUsers(entries));
  const visits: ParticipantVisit[] = [];
  const skippedUserIds: string[] = [];
  for (const participant of participants) {
    const userId = participant.userId.toLowerCase();
    const sessions = current?.get(userId) ?? [];
    const connectedAt = current === undefined ? null : currentVisitStart(sessions, now);
    if (connectedAt === null && skipUnrecordedVisits) {
      skippedUserIds.push(userId);
      continue;
    }
    visits.push({ participant, userId, sessions, connectedAt });
  }
  return { visits, skippedUserIds };
}

/**
 * Returns the Participant outputs of `visits`, with `roomName: null`. With the scope
 * `guest_links`, people without a guest link in `linksByUserId` are left out. With
 * `emailAddress`, everyone without a guest link of that email address (trimmed, in any case) is
 * left out. The name is the name of the guest link, else the name in the list, else the name in
 * the attendance of the last 24 hours.
 */
export function mapVisits(
  roomId: string,
  visits: readonly ParticipantVisit[],
  linksByUserId: ReadonlyMap<string, ApiGuestLink>,
  options: { now: number; scope: ParticipantScope; roomUserCount: number; emailAddress?: string },
): ParticipantOutput[] {
  const { now } = options;
  const window = { from: now - VISIT_WINDOW_MS, to: now };
  const wantedEmail = options.emailAddress?.trim().toLowerCase();

  const outputs: ParticipantOutput[] = [];
  for (const { participant, userId, sessions, connectedAt } of visits) {
    const link = linksByUserId.get(userId);
    if (link === undefined && options.scope === 'guest_links') continue;
    const emailAddress = link === undefined ? null : textOrNull(link.emailAddress);
    if (wantedEmail !== undefined && emailAddress?.trim().toLowerCase() !== wantedEmail) continue;

    outputs.push(
      mapParticipant(participant, {
        roomId,
        userId,
        connectedAt,
        link,
        sessionName: summarize(sessions, window, now, 0).displayName,
        roomUserCount: options.roomUserCount,
      }),
    );
  }
  return outputs;
}

// Sorts

/** Sorts the newest visit first, an unknown visit start last, then by ID. */
export function byNewestVisit(left: ParticipantOutput, right: ParticipantOutput): number {
  const byStart = (right.connectedAt ?? '').localeCompare(left.connectedAt ?? '');
  if (byStart !== 0) return byStart;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** What byLongestWait reads of a participant output, so that it also sorts smaller outputs. */
type WaitOrdered = Pick<ParticipantOutput, 'userId' | 'displayName' | 'inWaitingRoom' | 'connectedAt'>;

/**
 * Sorts the people in the waiting room first, then the longest wait or visit first with an unknown
 * visit start last, then by name and `userId`. `connectedAt` is a UTC ISO string, so that a text
 * comparison gives the time order.
 */
export function byLongestWait(left: WaitOrdered, right: WaitOrdered): number {
  const waiting = Number(right.inWaitingRoom === true) - Number(left.inWaitingRoom === true);
  if (waiting !== 0) return waiting;
  if (left.connectedAt !== right.connectedAt) {
    if (left.connectedAt === null) return 1;
    if (right.connectedAt === null) return -1;
    return left.connectedAt < right.connectedAt ? -1 : 1;
  }
  const byName = (left.displayName ?? '').localeCompare(right.displayName ?? '', 'en', {
    sensitivity: 'base',
  });
  if (byName !== 0) return byName;
  return left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0;
}

// Readers

/** The names of the participant fields and choices in the messages of createParticipantReaders. */
export type ParticipantLabels = {
  /** The Participants field, with the names of its three choices. */
  participants: string;
  guestLinkChoice: string;
  guestChoice: string;
  everyoneChoice: string;
  /** The Location field, with the names of its two choices. */
  location: string;
  waitingRoomChoice: string;
  roomChoice: string;
};

export type ParticipantReaders = {
  /** Reads the Participants field in any case. Empty gives `defaultScope`. */
  readParticipantScope: (value: unknown, defaultScope: ParticipantScope) => ParticipantScope;
  /** Reads the Location field in any case. Empty gives `undefined`: both places. */
  readLocation: (value: unknown) => ParticipantLocation | undefined;
};

/**
 * Returns the participant readers bound to `platform`, with the field and choice names of `labels`
 * in their messages.
 */
export function createParticipantReaders(
  platform: Platform,
  labels: ParticipantLabels,
): ParticipantReaders {
  const { readString } = createInputReaders(platform);
  return {
    readParticipantScope(value, defaultScope) {
      const text = readString(value, labels.participants)?.toLowerCase();
      if (text === undefined) return defaultScope;
      if (text === 'guest_links' || text === 'guests' || text === 'everyone') return text;
      throw platform.invalidInput(
        `${labels.participants} must be ${labels.guestLinkChoice}, ${labels.guestChoice} or ${labels.everyoneChoice}.`,
      );
    },
    readLocation(value) {
      const text = readString(value, labels.location)?.toLowerCase();
      if (text === undefined) return undefined;
      if (text === 'waiting_room' || text === 'room') return text;
      throw platform.invalidInput(
        `${labels.location} must be ${labels.waitingRoomChoice} or ${labels.roomChoice}.`,
      );
    },
  };
}
