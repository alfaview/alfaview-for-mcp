// The meeting tools. Meetings belong to the API key's user. Below the access level `manage`,
// update_meeting and cancel_meeting refuse an externally managed meeting, because the system that
// manages it can overwrite a change.
import * as z from 'zod';
import {
  invalidInput,
  missingCreatedIdMessage,
  readAfterSavedWrite,
  sendCreate,
  ToolError,
} from '../alfaview/errors.ts';
import {
  byRelevance,
  checkSchedule,
  firstEntryOfEachMeeting,
  getMeeting,
  getMeetingDetails,
  getMeetingOutput,
  listingWindow,
  listMeetings,
  mapListedMeeting,
  MEETING_UNCERTAIN_MESSAGE,
  MEETING_WITHOUT_TIMES_MESSAGE,
  meetingCanceledButNotReadMessage,
  meetingCreatedButNotReadMessage,
  meetingInviteeEmailMessage,
  meetingPath,
  meetingUpdatedButNotReadMessage,
  readRecurrenceRule,
  refuseExternallyManaged,
  titleMatches,
  type MeetingSummary,
} from '../domain/meetings.ts';
import { levelIncludes, type AccessLevel } from '../levels.ts';
import { textList } from '../shared/outputValues.ts';
import { compact, readDateTime, readTimeZone } from '../values/inputs.ts';
import { formatLocalTimestamp, formatTimestamp, normalizeTimestamp } from '../values/time.ts';
import { LIST_PART, MEETING, MEETING_DETAILS, MEETING_SUMMARY, toolOutput } from './outputs.ts';
import {
  CHANGE_ANNOTATIONS,
  count,
  CREATE_ANNOTATIONS,
  dateTimeParameter,
  defineTool,
  limitParameter,
  listPart,
  meetingIdParameter,
  offsetParameter,
  READ_ANNOTATIONS,
  showing,
  textParameter,
  TIME_ZONE_SLOT,
  timezoneParameter,
} from './tool.ts';

const EARLY_ACCESS_TEXT =
  'People without moderator or administrator permissions can join this many minutes early. Moderators and administrators can always join 30 minutes early.';
const AGENDA_TEXT = 'Plain text, no HTML.';
const RECURRENCE_RULE_TEXT =
  'An RFC 5545 RRULE, such as FREQ=WEEKLY;BYDAY=MO. start is the first occurrence, and end minus start the length of each.';

function earlyAccessParameter() {
  return z.number().int().min(0).max(30).describe(EARLY_ACCESS_TEXT);
}

/**
 * Returns the parameter recurrenceRule of create_meeting and update_meeting. It has no maximum
 * length in the schema: readRecurrenceRule refuses a long rule, and its message names alfaview's
 * limit.
 */
function recurrenceRuleParameter(description: string) {
  return textParameter(description).optional();
}

/**
 * Returns `from {start} to {end}` of a meeting output, as local times in `timeZone` with the zone
 * name, so that the model can repeat them to the user as they are.
 */
function schedule(meeting: MeetingSummary, timeZone: string): string {
  const start = formatLocalTimestamp(meeting.start, timeZone) ?? 'an unknown start';
  const end = formatLocalTimestamp(meeting.end, timeZone) ?? 'an unknown end';
  return `from ${start} to ${end}`;
}

/**
 * Returns whether update_meeting and cancel_meeting refuse an externally managed meeting at
 * `level`: below `manage`. The level is set in the server entry, outside the reach of the model,
 * so no tool argument opens the change.
 */
function refusesExternallyManaged(level: AccessLevel): boolean {
  return !levelIncludes(level, 'manage');
}

/** Returns the time range of find_meetings in words, for a range with one or two bounds. */
function period(from: string | null, to: string | null): string {
  if (to === null) return `from ${from} on`;
  if (from === null) return `until ${to}`;
  return `from ${from} to ${to}`;
}

// find_meetings

export const findMeetingsTool = defineTool({
  name: 'find_meetings',
  level: 'read',
  title: 'Find meetings',
  description:
    "Lists the alfaview meetings that the API key's user created, best match first. Without from and to, it lists the meetings from 1 day ago to 366 days ahead. Use get_meeting for the join URLs.",
  inputSchema: z.strictObject({
    title: textParameter(
      'Only meetings whose title contains this text, in any case.',
      256,
    ).optional(),
    from: dateTimeParameter('Only meetings that end at or after it.', 'server').optional(),
    to: dateTimeParameter('Only meetings that start at or before it.', 'server').optional(),
    includeCanceled: z.boolean().default(false).describe('Also return canceled meetings.'),
    includeEveryOccurrence: z
      .boolean()
      .default(false)
      .describe(
        'Return one entry for each occurrence of a recurring meeting. By default, a recurring meeting gives one entry, with its ongoing or next occurrence.',
      ),
    limit: limitParameter('meetings', 100, 20),
    offset: offsetParameter(),
  }),
  annotations: READ_ANNOTATIONS,
  personalData: { shape: 'mcp.meeting', list: 'meetings' },
  output: toolOutput({
    windowFrom: z.string().nullable(),
    windowTo: z.string().nullable(),
    ...LIST_PART,
    meetings: z.array(MEETING_SUMMARY),
  }),
  async run(input, { api, now, timeZone }) {
    const from = readDateTime(input.from, 'from', timeZone);
    const to = readDateTime(input.to, 'to', timeZone);
    if (from !== undefined && to !== undefined && Date.parse(from) > Date.parse(to)) {
      throw invalidInput('to must be after from.');
    }

    // Without `from` and `to`, the listing window applies. `listMeetings` says how alfaview treats
    // a bound that is not set.
    const window = from === undefined && to === undefined ? listingWindow(now) : { from, to };
    const listed = await listMeetings(api, window);
    const entries = input.includeEveryOccurrence ? listed : firstEntryOfEachMeeting(listed);
    const matches = entries
      .filter((meeting) => input.includeCanceled || meeting.state !== 'canceled')
      .filter((meeting) => titleMatches(meeting, input.title))
      .sort(byRelevance(input.title));
    const part = listPart(matches, input.offset, input.limit);
    const windowFrom = formatTimestamp(window.from, timeZone);
    const windowTo = formatTimestamp(window.to, timeZone);
    const shownFrom = formatLocalTimestamp(window.from, timeZone);
    const shownTo = formatLocalTimestamp(window.to, timeZone);
    const counted = input.includeEveryOccurrence ? 'occurrence' : 'meeting';
    const found = part.totalMatches === 0 ? 'no meetings' : count(part.totalMatches, counted);
    return {
      summary: `Found ${found} ${period(shownFrom, shownTo)}.${showing(part)}`,
      data: {
        windowFrom,
        windowTo,
        totalMatches: part.totalMatches,
        offset: part.offset,
        nextOffset: part.nextOffset,
        meetings: part.items.map((meeting) => mapListedMeeting(meeting, timeZone)),
      },
    };
  },
});

// get_meeting

export const getMeetingTool = defineTool({
  name: 'get_meeting',
  level: 'read',
  title: 'Get a meeting',
  description:
    "Returns an alfaview meeting that the API key's user created, with its join URLs: one for each permission group, such as Moderator and Guest.",
  inputSchema: z.strictObject({ meetingId: meetingIdParameter }),
  annotations: READ_ANNOTATIONS,
  personalData: { shape: 'mcp.meeting' },
  output: toolOutput(MEETING.shape),
  async run(input, { api, timeZone }) {
    const meeting = await getMeetingOutput(api, input.meetingId, timeZone);
    const joinUrls = count(meeting.groupLinks.length, 'join URL');
    return {
      summary: `Meeting ${meeting.id}: ${meeting.state ?? 'unknown state'}, ${schedule(meeting, timeZone)}. ${joinUrls}.`,
      data: meeting,
    };
  },
});

// create_meeting

export const createMeetingTool = defineTool({
  name: 'create_meeting',
  level: 'standard',
  title: 'Create a meeting',
  description:
    "Schedules an alfaview meeting and returns it with its four join URLs (moderator, participant, guest, spectator). Only the API key's user can see, change or cancel it. For an appointment in an existing room, use create_guest_links.",
  inputSchema: z.strictObject({
    title: textParameter('The title of the meeting.'),
    start: dateTimeParameter('The start.', 'timezone'),
    end: dateTimeParameter(
      'The end: after start, at most 24 hours after it, and in the future.',
      'timezone',
    ),
    recurrenceRule: recurrenceRuleParameter(RECURRENCE_RULE_TEXT),
    timezone: timezoneParameter('Time zone for the times shown to the invitees.').optional(),
    waitingRoomEnabled: z
      .boolean()
      .default(false)
      .describe('If true, participants wait until a moderator lets them in.'),
    waitingRoomWelcomeNote: textParameter('Shown to people in the waiting room.').optional(),
    agenda: textParameter(AGENDA_TEXT).optional(),
    earlyAccessMinutes: earlyAccessParameter().optional(),
    passcodeRequired: z
      .boolean()
      .describe('If true, everyone who joins must enter the room passcode.')
      .optional(),
  }),
  annotations: CREATE_ANNOTATIONS,
  personalData: { shape: 'mcp.meeting' },
  output: toolOutput(MEETING.shape),
  readTool: 'get_meeting',
  async run(input, { api, now, timeZone }) {
    const timezone = readTimeZone(input.timezone, 'timezone') ?? timeZone;
    // readDateTime returns undefined only for an undefined value, and both times are required.
    const start = readDateTime(input.start, 'start', timezone)!;
    const end = readDateTime(input.end, 'end', timezone)!;
    const recurrenceRule = readRecurrenceRule(input.recurrenceRule, now, start);
    checkSchedule(start, end, now);

    // alfaview can save the meeting also after it answers 500, and a second create makes a second
    // meeting. With a rule, start is the start of the first occurrence, and end minus start the
    // length of each.
    const answer = await sendCreate<{ id?: unknown }>(
      api,
      {
        method: 'POST',
        path: '/v2/meetings',
        body: compact({
          title: input.title,
          start,
          end,
          recurrenceRule,
          timezone,
          roomFeatures: {},
          waitingRoomEnabled: input.waitingRoomEnabled,
          waitingRoomWelcomeNote: input.waitingRoomWelcomeNote,
          agenda: input.agenda,
          earlyAccessMinutes: input.earlyAccessMinutes,
          passcodeRequired: input.passcodeRequired,
        }),
      },
      MEETING_UNCERTAIN_MESSAGE,
    );
    const meetingId = answer.data?.id;
    if (typeof meetingId !== 'string' || meetingId === '') {
      throw new ToolError('InvalidResponse', missingCreatedIdMessage('meeting'), answer.status);
    }

    // The meeting exists, whatever the error: the read back must never ask for a second create.
    // Its times are in the call's time zone, which is also the meeting's.
    const meeting = await readAfterSavedWrite(
      () => getMeetingOutput(api, meetingId, timezone),
      meetingCreatedButNotReadMessage(meetingId),
    );
    return {
      summary: `Created meeting ${meeting.id} ${schedule(meeting, timezone)}. The join URLs are in the result.`,
      data: meeting,
    };
  },
});

// update_meeting

export const updateMeetingTool = defineTool({
  name: 'update_meeting',
  level: 'standard',
  title: 'Update a meeting',
  description:
    'Changes the title, time, time zone, agenda or early access of an alfaview meeting. A meeting with guest links needs sendEmail true.',
  inputSchema: z.strictObject({
    meetingId: meetingIdParameter,
    title: textParameter('The title of the meeting.').optional(),
    start: dateTimeParameter('The start.', 'timezone').optional(),
    end: dateTimeParameter('The end: at most 24 hours after the start.', 'timezone').optional(),
    recurrenceRule: recurrenceRuleParameter(
      `${RECURRENCE_RULE_TEXT} A recurring meeting cannot stop repeating.`,
    ),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .describe(
        `Time zone for the times shown to the invitees: an IANA name. It is also the zone of times without an offset and of the result. Without it, the meeting keeps its time zone, and times without an offset are read in ${TIME_ZONE_SLOT}.`,
      )
      .optional(),
    agenda: textParameter(AGENDA_TEXT).optional(),
    earlyAccessMinutes: earlyAccessParameter().optional(),
    sendEmail: z
      .boolean()
      .default(false)
      .describe(
        'Must be true for a meeting with guest links: alfaview can email those guests about any change.',
      ),
  }),
  annotations: CHANGE_ANNOTATIONS,
  personalData: { shape: 'mcp.meeting' },
  output: toolOutput(MEETING_DETAILS.shape),
  readTool: 'get_meeting',
  async run(input, { api, now, timeZone, level }) {
    const given = [
      input.title,
      input.start,
      input.end,
      input.recurrenceRule,
      input.timezone,
      input.agenda,
      input.earlyAccessMinutes,
    ];
    if (given.every((value) => value === undefined)) {
      throw invalidInput('Give at least one field to change.');
    }
    // Without timezone the meeting keeps its zone, and the call reads and gives its times in the
    // server's zone.
    const timezone = readTimeZone(input.timezone, 'timezone');
    const callZone = timezone ?? timeZone;
    let start = readDateTime(input.start, 'start', callZone);
    let end = readDateTime(input.end, 'end', callZone);
    // The rule makes the meeting recurring or replaces its rule. Without start, alfaview keeps the
    // current start as the start of the first occurrence. alfaview cannot remove a rule.
    const recurrenceRule = readRecurrenceRule(input.recurrenceRule, now, start);

    const current = await getMeeting(api, input.meetingId);
    // Before the guard of the guest links, whose recovery, sendEmail true, would not help.
    if (refusesExternallyManaged(level)) refuseExternallyManaged(current);
    const guestLinkCount = textList(current.guestLinks).length;
    // alfaview can email the invitees about a change of any field, so the guard covers every field.
    if (guestLinkCount > 0 && !input.sendEmail) {
      throw new ToolError('MeetingInviteeEmail', meetingInviteeEmailMessage(guestLinkCount));
    }
    if (start !== undefined || end !== undefined) {
      start ??= normalizeTimestamp(current.start) ?? undefined;
      end ??= normalizeTimestamp(current.end) ?? undefined;
      if (start === undefined || end === undefined) {
        throw new ToolError('InvalidResponse', MEETING_WITHOUT_TIMES_MESSAGE);
      }
      checkSchedule(start, end, now);
    }

    // start and end go together, so that a new start alone cannot move the end.
    await api.request({
      method: 'PATCH',
      path: meetingPath(input.meetingId),
      body: compact({
        title: input.title,
        start,
        end,
        recurrenceRule,
        timezone,
        agenda: input.agenda,
        earlyAccessMinutes: input.earlyAccessMinutes,
      }),
    });

    // The change is saved: a failed read back must not make the model send it again. The result
    // has no join URLs, which a change does not need.
    const meeting = await readAfterSavedWrite(
      () => getMeetingDetails(api, input.meetingId, callZone),
      meetingUpdatedButNotReadMessage(input.meetingId),
    );
    // The tool never sends sendEmail to alfaview: it only confirms the emails to the guests. So the
    // model must not report an email for a meeting without guest links.
    const guests =
      meeting.guestLinkCount !== 0
        ? ` alfaview can email its ${count(meeting.guestLinkCount, 'guest')} about the change.`
        : input.sendEmail
          ? ' The meeting has no guest links, so sendEmail had no effect.'
          : '';
    return {
      summary: `Updated meeting ${meeting.id}, ${schedule(meeting, callZone)}.${guests}`,
      data: meeting,
    };
  },
});

// cancel_meeting

export const cancelMeetingTool = defineTool({
  name: 'cancel_meeting',
  level: 'standard',
  title: 'Cancel a meeting',
  description:
    'Cancels an alfaview meeting: nobody can join it afterwards. This cannot be undone.',
  inputSchema: z.strictObject({
    meetingId: meetingIdParameter,
    sendEmail: z
      .boolean()
      .default(false)
      .describe('If true, alfaview emails the creator and all invitees about the cancellation.'),
    reason: textParameter('Plain text, no HTML. alfaview puts it into the email.').optional(),
  }),
  annotations: CHANGE_ANNOTATIONS,
  personalData: { shape: 'mcp.meeting' },
  output: toolOutput(MEETING_DETAILS.shape),
  readTool: 'get_meeting',
  async run(input, { api, timeZone, level }) {
    // Only a level that refuses an externally managed meeting reads it before the cancellation.
    if (refusesExternallyManaged(level)) {
      refuseExternallyManaged(await getMeeting(api, input.meetingId));
    }
    await api.request({
      method: 'POST',
      path: `${meetingPath(input.meetingId)}/cancellation`,
      body: compact({ sendNotification: input.sendEmail, reason: input.reason }),
    });
    const meeting = await readAfterSavedWrite(
      () => getMeetingDetails(api, input.meetingId, timeZone),
      meetingCanceledButNotReadMessage(input.meetingId),
    );
    const email = input.sendEmail
      ? 'alfaview emails the creator and the invitees.'
      : 'alfaview sent no email.';
    return { summary: `Canceled meeting ${meeting.id}. ${email}`, data: meeting };
  },
});

/** The meeting tools, in the order of the tool list. */
export const MEETING_TOOLS = [
  findMeetingsTool,
  getMeetingTool,
  createMeetingTool,
  updateMeetingTool,
  cancelMeetingTool,
] as const;
