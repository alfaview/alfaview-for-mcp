// Meetings belong to the alfaview user who owns the API key: `GET /v2/meetings` lists only that
// user's meetings, and only that user can read, change or cancel them.
import type { CallApi } from '../alfaview/client.ts';
import { invalidResponse, ToolError } from '../alfaview/errors.ts';
import { platform } from '../platform.ts';
import {
  createMeetingChecks,
  createRecurrenceChecks,
  isExternallyManaged,
  mapGroupLinks,
  meetingPath,
  type ApiMeeting,
  type MeetingGroupLinkOutput,
  type MeetingWindow,
} from '../shared/meetings.ts';
import { booleanOrNull, integerOrNull, textList, textOrNull } from '../shared/outputValues.ts';
import { formatTimestamp } from '../values/time.ts';
import { readGroupNames } from './permissionGroups.ts';

export {
  byRelevance,
  firstEntryOfEachMeeting,
  listingWindow,
  meetingPath,
  titleMatches,
} from '../shared/meetings.ts';
export type { ApiMeeting } from '../shared/meetings.ts';

// Messages

export const MEETING_UNCERTAIN_MESSAGE =
  'alfaview may have created the meeting before the error. Check with find_meetings before you create it again: a second create makes a second meeting.';

export const MEETING_WITHOUT_TIMES_MESSAGE =
  'alfaview did not return the current start and end of the meeting. Give both start and end.';

/** Returns the error when the new meeting cannot be read back: the meeting exists. */
export function meetingCreatedButNotReadMessage(meetingId: string): string {
  return `alfaview created the meeting ${meetingId}, but reading it back failed. Do not create it again: that makes a second meeting. Use get_meeting with this ID to get the join URLs.`;
}

/** Returns the error when the meeting cannot be read back after a saved change. */
export function meetingUpdatedButNotReadMessage(meetingId: string): string {
  return `alfaview saved the change to meeting ${meetingId}, but reading it back failed. Do not repeat the change: a repeat can email the invitees again. Use get_meeting with this ID to read the meeting.`;
}

/** Returns the error when the meeting cannot be read back after its cancellation. */
export function meetingCanceledButNotReadMessage(meetingId: string): string {
  return `alfaview canceled the meeting ${meetingId}, but reading it back failed. Do not cancel it again. Use get_meeting with this ID to read the meeting.`;
}

/** Returns the error of update_meeting without sendEmail for a meeting with guest links. */
export function meetingInviteeEmailMessage(guestLinkCount: number): string {
  return `This meeting has ${guestLinkCount} guest links, and alfaview can email those guests about a change. Call update_meeting again with sendEmail true to change it.`;
}

/**
 * The error of update_meeting and cancel_meeting for an externally managed meeting below the
 * access level `manage`. It names no parameter: only the access level of the server entry allows
 * the change, and no tool argument does.
 */
export const EXTERNALLY_MANAGED_MESSAGE =
  'This recurring meeting is externally managed: another system manages it and can overwrite a change. The server changes or cancels such a meeting only at the access level manage or full. Tell the user to change it in the system that manages it.';

// Output shapes and mappers

export type MeetingSummary = {
  id: string;
  title: string | null;
  start: string | null;
  end: string | null;
  timezone: string | null;
  state: string | null;
  canJoin: boolean | null;
  guestLinkCount: number;
  recurrenceRule: string | null;
  externallyManaged: boolean | null;
};

/**
 * An entry of find_meetings. `guestLinkCount` is `null` for a recurring meeting, because
 * `GET /v2/meetings` does not show its guest links.
 */
export type ListedMeeting = Omit<MeetingSummary, 'guestLinkCount'> & {
  guestLinkCount: number | null;
};

/** A meeting without its join URLs: the output of the tools that change a meeting. */
export type MeetingDetails = MeetingSummary & {
  agenda: string | null;
  earlyAccessMinutes: number | null;
  canJoinAfter: string | null;
  canceledAt: string | null;
  roomAvailable: boolean | null;
  createdAt: string | null;
  /** The start of the ongoing or next occurrence of a recurring meeting, or `null`. */
  nextInstance: string | null;
};

export type Meeting = MeetingDetails & {
  /** Sorted by the permission group name. Credentials. */
  groupLinks: MeetingGroupLinkOutput[];
};

/**
 * Returns the keys that every meeting output has. Absent values are `null`, and a meeting without
 * guest links has `guestLinkCount` 0.
 */
export function mapMeetingSummary(meeting: ApiMeeting, timeZone: string): MeetingSummary {
  return {
    id: meeting.id,
    title: textOrNull(meeting.title),
    start: formatTimestamp(meeting.start, timeZone),
    end: formatTimestamp(meeting.end, timeZone),
    timezone: textOrNull(meeting.timezone),
    state: textOrNull(meeting.state),
    canJoin: booleanOrNull(meeting.canJoin),
    guestLinkCount: textList(meeting.guestLinks).length,
    recurrenceRule: textOrNull(meeting.recurrenceRule),
    externallyManaged: booleanOrNull(meeting.externallyManaged),
  };
}

/**
 * Returns an entry of find_meetings: the summary, without a count of the guest links of a
 * recurring meeting, since 0 would say that it has none.
 */
export function mapListedMeeting(meeting: ApiMeeting, timeZone: string): ListedMeeting {
  const summary = mapMeetingSummary(meeting, timeZone);
  return summary.recurrenceRule === null ? summary : { ...summary, guestLinkCount: null };
}

/** Returns the Meeting details output of `GET /v2/meetings/{id}`, without the join URLs. */
export function mapMeetingDetails(meeting: ApiMeeting, timeZone: string): MeetingDetails {
  return {
    ...mapMeetingSummary(meeting, timeZone),
    agenda: textOrNull(meeting.agenda),
    earlyAccessMinutes: integerOrNull(meeting.earlyAccessMinutes),
    canJoinAfter: formatTimestamp(meeting.canJoinAfter, timeZone),
    canceledAt: formatTimestamp(meeting.canceledAt, timeZone),
    roomAvailable: booleanOrNull(meeting.roomAvailable),
    createdAt: formatTimestamp(meeting.createdAt, timeZone),
    nextInstance: formatTimestamp(meeting.nextInstance, timeZone),
  };
}

/**
 * Returns the Meeting output of `GET /v2/meetings/{id}`, with the join URLs of its group links.
 * `groupNames` maps permission group IDs, in any case, to names.
 */
export function mapMeeting(
  meeting: ApiMeeting,
  groupNames: ReadonlyMap<string, string>,
  timeZone: string,
): Meeting {
  return {
    ...mapMeetingDetails(meeting, timeZone),
    groupLinks: mapGroupLinks(meeting.groupLinks, groupNames),
  };
}

// Checks

/**
 * Checks the schedule rules of alfaview before a request, so that the model gets a clear message:
 * start before end, at most 24 hours long, end not in the past, start at most 365 days from now.
 * `start` and `end` are ISO strings.
 */
export const { checkSchedule } = createMeetingChecks(platform, {
  meeting: 'meetingId',
  start: 'start',
  end: 'end',
});

/**
 * The recurrence checks with the parameter names of the tools. The tools take only the raw rule,
 * so only the names of `rule` and `start` reach a message. The other names belong to structured
 * recurrence fields, which these tools do not have.
 */
const recurrenceChecks = createRecurrenceChecks(platform, {
  repeat: 'repeat',
  every: 'every',
  endsAfter: 'endsAfter',
  until: 'until',
  rule: 'recurrenceRule',
  start: 'start',
});

/**
 * Returns the `recurrenceRule` of create_meeting and update_meeting as the request sends it, or
 * `undefined` without one. The rule is checked as alfaview checks it, before a request, and is
 * sent as written, with its prefix `RRULE:` when it has one. A rule that alfaview would refuse
 * gives `InvalidInput` with a message that names recurrenceRule. `now` is the time of the call.
 * `start` is the `start` argument of the call as a UTC ISO string, when the call gives one: an
 * UNTIL before it gives a series without an occurrence, which is refused too.
 */
export function readRecurrenceRule(
  rule: string | undefined,
  now: number,
  start?: string,
): string | undefined {
  return recurrenceChecks.readRecurrenceRule({ rule, start }, now);
}

/**
 * Refuses a recurring meeting that another system manages ({@link isExternallyManaged}), with the
 * code ExternallyManagedRefused: that system can overwrite a change. The tools call it only below
 * the access level `manage`.
 */
export function refuseExternallyManaged(meeting: ApiMeeting): void {
  if (isExternallyManaged(meeting)) {
    throw new ToolError('ExternallyManagedRefused', EXTERNALLY_MANAGED_MESSAGE);
  }
}

// Requests

/**
 * Returns the meetings of the API key's user whose scheduled time overlaps `window`
 * (`GET /v2/meetings`). alfaview lists each occurrence of a recurring meeting as an entry of its
 * own, with the same ID. It lists no past occurrence, and no occurrence more than 90 days after
 * the later of `from` and now, or more than 5 years after now. An answer of `null` gives no
 * meetings. An entry without a text ID is left out, and a repeated ID is kept.
 */
export async function listMeetings(
  api: CallApi,
  window: Partial<MeetingWindow>,
): Promise<ApiMeeting[]> {
  const { data } = await api.request<unknown>({
    method: 'GET',
    path: '/v2/meetings',
    query: { from: window.from, to: window.to },
  });
  if (data !== undefined && data !== null && !Array.isArray(data)) {
    throw invalidResponse('alfaview sent an unexpected response for /v2/meetings.');
  }
  return ((data ?? []) as ApiMeeting[]).filter((meeting) => typeof meeting?.id === 'string');
}

/** Returns the meeting (`GET /v2/meetings/{id}`). */
export async function getMeeting(api: CallApi, meetingId: string): Promise<ApiMeeting> {
  const { data } = await api.request<ApiMeeting>({ method: 'GET', path: meetingPath(meetingId) });
  if (typeof data !== 'object' || data === null || typeof data.id !== 'string') {
    throw invalidResponse('alfaview did not return the meeting.');
  }
  return data;
}

/**
 * Returns the full Meeting output: `GET /v2/meetings/{id}`, plus the permission group names for
 * the group links. The names are read only when the meeting has group links, and a failed read
 * gives `null` names ({@link readGroupNames}).
 */
export async function getMeetingOutput(
  api: CallApi,
  meetingId: string,
  timeZone: string,
): Promise<Meeting> {
  const meeting = await getMeeting(api, meetingId);
  const hasGroupLinks =
    typeof meeting.groupLinks === 'object' &&
    meeting.groupLinks !== null &&
    Object.keys(meeting.groupLinks).length > 0;
  const names = hasGroupLinks ? await readGroupNames(api) : new Map<string, string>();
  return mapMeeting(meeting, names, timeZone);
}

/** Returns the Meeting details output: `GET /v2/meetings/{id}` without the join URLs. */
export async function getMeetingDetails(
  api: CallApi,
  meetingId: string,
  timeZone: string,
): Promise<MeetingDetails> {
  return mapMeetingDetails(await getMeeting(api, meetingId), timeZone);
}
