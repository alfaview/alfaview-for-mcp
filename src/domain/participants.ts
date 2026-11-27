// The people who are connected to a room now, with the start of each visit and the guest link of
// each guest.
import type { CallApi } from '../alfaview/client.ts';
import { invalidResponse, ToolError } from '../alfaview/errors.ts';
import { booleanOrNull, textOrNull } from '../shared/outputValues.ts';
import {
  byLongestWait,
  flattenParticipants,
  hasGuest,
  inWaitingRoomOf,
  selectVisits,
  subroomIdOf,
  VISIT_WINDOW_MS,
  type ParticipantType,
  type RoomParticipant,
} from '../shared/participants.ts';
import { formatTimestamp } from '../values/time.ts';
import {
  listAttendances,
  readGuestLinksByUserId,
  summarize,
  type ApiUserAttendances,
} from './attendance.ts';
import type { ApiGuestLink } from './guestLinks.ts';
import { roomPath } from './rooms.ts';

export {
  countRoomUsers,
  flattenParticipants,
  peopleAtLocation,
  VISIT_WINDOW_MS,
} from '../shared/participants.ts';
export type { RoomParticipant } from '../shared/participants.ts';

export const PARTICIPANTS_DENIED_MESSAGE =
  "alfaview did not list the people in this room. The API key's user needs the room permission Join in this room. Give it in alfaview.";

// Output shape

export type Participant = {
  userId: string;
  displayName: string | null;
  participantType: ParticipantType;
  emailAddress: string | null;
  guestLinkId: string | null;
  guestLinkOrigin: string | null;
  inWaitingRoom: boolean | null;
  connectedAt: string | null;
  subroomId: string | null;
  onBreak: boolean | null;
  isSpectator: boolean | null;
  isDialIn: boolean | null;
};

// Request

/**
 * Returns the people who are connected to the room or its waiting room now
 * (`GET /v2/rooms/{id}/participants`, read by {@link flattenParticipants}). An answer of `null`
 * means nobody is connected. `displayName` is empty unless the API key's user has the user
 * permission User Admin, List Users or Show User Names. A 403, which alfaview answers unless that
 * user has the room permission Join in the room, gives PARTICIPANTS_DENIED_MESSAGE. A 404 gives
 * the message of the room.
 */
export async function listParticipants(api: CallApi, roomId: string): Promise<RoomParticipant[]> {
  const { status, data } = await api.request<unknown>({
    method: 'GET',
    path: `${roomPath(roomId)}/participants`,
    allowStatuses: [403],
  });
  if (status === 403) throw new ToolError('Forbidden', PARTICIPANTS_DENIED_MESSAGE, 403);
  const participants = flattenParticipants(data);
  if (participants === undefined) {
    throw invalidResponse('alfaview sent an unexpected participant response.');
  }
  return participants;
}

// Mapper and outputs

/**
 * Returns the Participant output of one person. `userId` is in lowercase, `link` is the person's
 * guest link of this room, and `sessionName` the name from the attendance. `connectedAt` is a UTC
 * ISO string as it is: the caller formats it after the sort.
 */
export function mapParticipant(
  participant: RoomParticipant,
  details: {
    userId: string;
    connectedAt: string | null;
    link: ApiGuestLink | undefined;
    sessionName: string | null;
  },
): Participant {
  const { link } = details;
  return {
    userId: details.userId,
    displayName:
      (link === undefined ? null : textOrNull(link.displayName)) ??
      textOrNull(participant.displayName) ??
      details.sessionName,
    participantType:
      link !== undefined ? 'guest_link' : participant.isGuest === true ? 'guest' : 'user',
    emailAddress: link === undefined ? null : textOrNull(link.emailAddress),
    guestLinkId: link === undefined ? null : link.id,
    guestLinkOrigin: link === undefined ? null : textOrNull(link.origin),
    inWaitingRoom: inWaitingRoomOf(participant),
    connectedAt: details.connectedAt,
    subroomId: subroomIdOf(participant),
    onBreak: booleanOrNull(participant.onBreak),
    isSpectator: booleanOrNull(participant.isSpectator),
    isDialIn: booleanOrNull(participant.isDialIn),
  };
}

/**
 * Returns the Participant outputs of every person of `participants`, in the order of
 * {@link byLongestWait}. The participant list has no join time and no guest link, so the start of
 * each visit comes from the attendance of the last 24 hours, and the guest link of each guest from
 * the guest links of the room. The guest links are read only when a person with the flag `isGuest`
 * is connected, because only a guest can have a guest link.
 *
 * A failed attendance read gives `connectedAt: null` for everyone and its error code in
 * `attendanceErrorCode`. A cancel ends the call. An empty `participants` sends no request.
 */
export async function participantOutputs(
  api: CallApi,
  roomId: string,
  participants: readonly RoomParticipant[],
  options: { now: number; timeZone: string },
): Promise<{ participants: Participant[]; attendanceErrorCode: string | null }> {
  if (participants.length === 0) return { participants: [], attendanceErrorCode: null };
  const { now } = options;
  const window = { from: now - VISIT_WINDOW_MS, to: now };

  let entries: ApiUserAttendances[] | undefined;
  let attendanceErrorCode: string | null = null;
  try {
    entries = await listAttendances(api, roomId, window);
  } catch (error) {
    if (!(error instanceof ToolError) || error.code === 'Canceled') throw error;
    attendanceErrorCode = error.code;
  }

  const { visits } = selectVisits(participants, entries, now, false);
  const linksByUserId = hasGuest(visits)
    ? await readGuestLinksByUserId(api, roomId)
    : new Map<string, ApiGuestLink>();
  const outputs = visits.map(({ participant, userId, sessions, connectedAt }) =>
    mapParticipant(participant, {
      userId,
      connectedAt,
      link: linksByUserId.get(userId),
      sessionName: summarize(sessions, window, now, 0).displayName,
    }),
  );
  return {
    participants: outputs.sort(byLongestWait).map((output) => ({
      ...output,
      connectedAt: formatTimestamp(output.connectedAt, options.timeZone),
    })),
    attendanceErrorCode,
  };
}
