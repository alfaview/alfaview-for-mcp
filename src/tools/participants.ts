// The participant tool find_room_participants. It lists the people in a room and its waiting room
// now: a snapshot that a client reads on demand, for example to check the waiting room.
import * as z from 'zod';
import {
  countRoomUsers,
  listParticipants,
  participantOutputs,
  peopleAtLocation,
} from '../domain/participants.ts';
import { LIST_PART, toolOutput } from './outputs.ts';
import {
  count,
  defineTool,
  limitParameter,
  listPart,
  offsetParameter,
  READ_ANNOTATIONS,
  roomIdParameter,
  showing,
} from './tool.ts';

export const findRoomParticipantsTool = defineTool({
  name: 'find_room_participants',
  level: 'read',
  title: 'Find the people in a room',
  description:
    'Lists the people who are in an alfaview room or its waiting room now, the longest wait first. A guest who joined with a guest link of this room comes with the email address and the guest link.',
  descriptionWithoutPersonalData:
    'Lists the people who are in an alfaview room or its waiting room now, the longest wait first. A guest who joined with a guest link of this room comes with the guest link. This server leaves out personal data: names and email addresses are null.',
  inputSchema: z.strictObject({
    roomId: roomIdParameter,
    location: z
      .enum(['waiting_room', 'room'])
      .describe('Only the people who wait to be let in, or only those in the room. Default: both.')
      .optional(),
    limit: limitParameter('people', 50, 20),
    offset: offsetParameter(),
  }),
  annotations: READ_ANNOTATIONS,
  personalData: { shape: 'mcp.participant', list: 'participants' },
  output: toolOutput({
    roomId: z.string(),
    roomUserCount: z.int(),
    waitingCount: z.int(),
    ...LIST_PART,
    participants: z.array(
      z.strictObject({
        userId: z.string(),
        displayName: z.string().nullable(),
        participantType: z.enum(['guest_link', 'guest', 'user']),
        emailAddress: z.string().nullable(),
        guestLinkId: z.string().nullable(),
        guestLinkOrigin: z.string().nullable(),
        inWaitingRoom: z.boolean().nullable(),
        connectedAt: z.string().nullable(),
        subroomId: z.string().nullable(),
        onBreak: z.boolean().nullable(),
        isSpectator: z.boolean().nullable(),
        isDialIn: z.boolean().nullable(),
      }),
    ),
  }),
  async run(input, { api, now, timeZone, log }) {
    const roomId = input.roomId.toLowerCase();
    const everyone = await listParticipants(api, roomId);
    const people = peopleAtLocation(everyone, input.location);
    const { participants, attendanceErrorCode } = await participantOutputs(api, roomId, people, {
      now,
      timeZone,
    });

    const warnings: string[] = [];
    if (attendanceErrorCode !== null) {
      log.info(`tool find_room_participants: attendance not read (${attendanceErrorCode})`);
      warnings.push(
        `alfaview did not return the connection times (${attendanceErrorCode}), so connectedAt is null and the order is not by waiting time.`,
      );
    }

    const part = listPart(participants, input.offset, input.limit);
    const roomUserCount = countRoomUsers(everyone);
    const waitingCount = everyone.filter((person) => person.waiting).length;
    const users = count(roomUserCount, 'company user');
    const waiting = count(waitingCount, 'person', 'people');
    return {
      summary: `${users} in the room, ${waiting} waiting.${showing(part, { ofTotal: true })}`,
      warnings,
      data: {
        roomId,
        roomUserCount,
        waitingCount,
        totalMatches: part.totalMatches,
        offset: part.offset,
        nextOffset: part.nextOffset,
        participants: part.items,
      },
    };
  },
});

/** The participant tools, in the order of the tool list. */
export const PARTICIPANT_TOOLS = [findRoomParticipantsTool] as const;
