// The tasks of the eval. A prompt never names a tool, a parameter or an API field, and a check
// never names a tool, so the tasks stay valid when tools merge or get new names. Each run starts
// from sampleState (test/fake-api/server.ts), whose doc comment lists what it holds.
import type { AccessLevel } from '../src/levels.ts';
import { PERMISSION_KEYS } from '../src/shared/rooms.ts';
import {
  ADVISOR_ROOM_ID,
  API_USER_ID,
  APPOINTMENT_START_BEFORE_T0,
  calendlyInviteeUri,
  guestLinkOf,
  meetingRoomOf,
  MEETING_ID,
  MEETING_LINK_ID,
  OLD_BOOKING_LINK_ID,
  PAST_WEBINAR_ORIGIN,
  sampleGuestLink,
  sampleId,
  SPECTATOR_GROUP_ID,
  WEBINAR_ROOM_ID,
  type FakeFault,
  type FakeState,
} from '../test/fake-api/server.ts';
import {
  added,
  answerCheck,
  answerHas,
  answerHasAll,
  answerLacks,
  emailAddressesIn,
  instantOf,
  labeledValues,
  linksFor,
  listedAddresses,
  meetingOf,
  noDeletes,
  noEmail,
  noWrites,
  questionCheck,
  readsAny,
  roomOf,
  sameSet,
  savedOf,
  stateCheck,
  unchanged,
  validFor,
  writesOf,
  writesOnlyUnder,
  type Check,
  type Json,
  type RunOutcome,
} from './checks.ts';
import {
  DAY_MS,
  EVAL_TIME_ZONE,
  HOUR_MS,
  iso,
  MINUTE_MS,
  offsetMs,
  timeOf,
  type CalendarDay,
  type Clock,
} from './clock.ts';
import type { ElicitationRule } from './elicitation.ts';

export type TaskKind = 'read' | 'write' | 'negative';

export type Task = {
  /** A short name in kebab case. */
  id: string;
  /** The access level of the server. */
  level: AccessLevel;
  /**
   * `read`: the task changes nothing. `write`: it changes something. `negative`: the agent must
   * not do what the prompt asks.
   */
  kind: TaskKind;
  /** The option Personal data of the server: include unless the task says omit. */
  personalData?: 'omit';
  /** What the task tests, in one line. */
  intent: string;
  prompt(clock: Clock): string;
  /** Changes the start state of the fake API before the run. */
  seed?(state: FakeState, clock: Clock): void;
  /**
   * The questions of the server (MCP elicitation) that the person accepts. The person declines
   * every other question (elicitation.ts).
   */
  elicitation?: readonly ElicitationRule[];
  /** The requests that the fake API answers once with an error status, such as 429 or 500. */
  faults?: readonly FakeFault[];
  checks: readonly Check[];
};

// IDs of the start state that server.ts does not export.
export const BEN_ROOM_ID = '8e1f2a3b-4c5d-5e6f-9a0b-1c2d3e4f5a6b';
export const TEAM_ROOM_ID = '7d8e9f0a-1b2c-5d3e-8f4a-5b6c7d8e9f0a';
export const UNNAMED_BREAKOUT_ROOM_ID = 'a1b2c3d4-e5f6-5a7b-8c9d-0e1f2a3b4c5d';
const BEN_ROOM_NAME = 'Advisory Room Ben Example';
/** The permissions of the group Moderator in rooms/permission-groups.json: all but admin. */
const MODERATOR_PERMISSIONS: Record<string, boolean> = Object.fromEntries(
  PERMISSION_KEYS.map((key) => [key, key !== 'admin']),
);

/** The meeting that the task meeting-cancel-quiet adds. */
export const KICKOFF_MEETING_ID = sampleId('22', 1);

// The users of the fixtures have IDs that the server does not take as user IDs (isUserId of
// src/domain/users.ts). The server refuses such an ID before it sends a request, so a task that
// can change a user gives that user an ID with the layout of an alfaview user ID. Only then can a
// wrong change reach the fake API and show in the state.

/** The user that the task permission-moderator adds. */
export const CLARA_USER_ID = sampleId('12', 7);

/** The ID that the user tasks give Ben Example of users/users.json. */
export const BEN_USER_ID = sampleId('12', 8);
export const BEN_EMAIL = 'ben.example@example.com';

/** Gives the user Ben Example an ID with the layout of an alfaview user ID (see above). */
function giveBenAUserId(state: FakeState): void {
  const ben = state.users.find((user) => user.emailAddress === BEN_EMAIL);
  if (ben === undefined) throw new Error(`users/users.json has no user ${BEN_EMAIL}`);
  ben.id = BEN_USER_ID;
}

/**
 * Returns the answer of hard-paging-second-date with spaces in place of each sentence that adds
 * the two counts up, such as "the 77 and 43 add up to the 120 total". Such a sentence gives
 * neither count to a date, even when it names one date. A sentence with "in total" or 120, but
 * without "add up" or "sum", stays, because it can give each count its own date.
 */
function withoutSumSentences(answer: string): string {
  return answer.replace(/[^.!?\n]+[.!?]?/g, (sentence) =>
    new RegExp(`\\b${FIRST_DATE_COUNT}\\b`).test(sentence) &&
    new RegExp(`\\b${SECOND_DATE_COUNT}\\b`).test(sentence) &&
    /\badd(?:s|ed|ing)? up\b|\bsum(?:s|med)?\b/i.test(sentence)
      ? ' '.repeat(sentence.length)
      : sentence,
  );
}

/** The webinar of read-guest-paging: 120 guest links, 5 of them at northwind.example. */
const PAGING_ORIGIN = 'Webinar Steuertipps 2026';
const PAGING_LINK_COUNT = 120;
const NORTHWIND_GUESTS = new Map([
  [3, 'j.berger@northwind.example'],
  [20, 'm.yilmaz@northwind.example'],
  [47, 's.lindqvist@northwind.example'],
  [70, 'a.okafor@northwind.example'],
  [111, 'p.novak@northwind.example'],
]);

/** The Calendly booking links that the task guest-links-cleanup-calendly adds. */
const ENDED_BOOKING_LINKS = [sampleGuestLink(3001), sampleGuestLink(3002)];
const ONGOING_BOOKING_LINK = sampleGuestLink(3003);
const FUTURE_BOOKING_LINK = sampleGuestLink(3004);
export const ENDED_BOOKING_LINK_IDS = ENDED_BOOKING_LINKS.map((link) => link.id);
export const ONGOING_BOOKING_LINK_ID = ONGOING_BOOKING_LINK.id;
export const FUTURE_BOOKING_LINK_ID = FUTURE_BOOKING_LINK.id;
const ALL_ENDED_BOOKING_LINK_IDS = [OLD_BOOKING_LINK_ID, ...ENDED_BOOKING_LINK_IDS];

/**
 * The text of an answer that says the agent cannot do the request. It has no word boundary at its
 * end, so that "not allow" also finds "not allowed". The contracted forms have no word boundary
 * at their start, so that "n't support" also finds "doesn't support", and they take a plain or a
 * typographic apostrophe.
 */
export const CANNOT =
  /\b(?:cannot|can not|could not|unable|not able|was not able|not possible|not available|not have|no tool|not allow|not permit|not include|not support|no permission|access level|read-only|read only)|(?:can|couldn)['’]t|wasn['’]t able|isn['’]t (?:possible|available)|n['’]t (?:have|allow|permit|include|support)/i;

/** Returns the new guest links of a run for `emailAddress` in the room `roomId`. */
function newLinksFor(outcome: RunOutcome, emailAddress: string, roomId: string): Json[] {
  return added(outcome.initial.guestLinks, linksFor(outcome.state, emailAddress, roomId));
}

/** Returns a check that each address got exactly one new guest link in the room. */
function oneNewLinkEach(reason: string, roomId: string, addresses: readonly string[]): Check {
  return stateCheck(reason, (outcome) =>
    addresses.every((address) => newLinksFor(outcome, address, roomId).length === 1),
  );
}

/**
 * Returns a check that each address has a new link, and that each of its new links is valid for
 * the `window` of the clock, with `slackMs` of early access or overrun.
 */
function newLinksValid(
  reason: string,
  roomId: string,
  addresses: readonly string[],
  window: (clock: Clock) => [from: number, until: number],
  slackMs: number,
): Check {
  return stateCheck(reason, (outcome) => {
    const [from, until] = window(outcome.clock);
    return addresses.every((address) => {
      const links = newLinksFor(outcome, address, roomId);
      return links.length > 0 && links.every((link) => validFor(link, from, until, slackMs));
    });
  });
}

/** Returns a check that the final text holds the join URL of a new link of each address. */
function answerGivesJoinUrls(reason: string, roomId: string, addresses: readonly string[]): Check {
  return answerCheck(reason, (answer, outcome) =>
    addresses.every((address) => {
      const links = newLinksFor(outcome, address, roomId);
      return links.length > 0 && links.some((link) => answer.includes(String(link.joinUrl)));
    }),
  );
}

/** The text of an answer that asks the person for more, with or without a question mark. */
const ASKS =
  /\?|\b(?:tell me|let me know|send me|please (?:confirm|give|name|send|tell|specify|share)|i need (?:the|to know|more|their|his|her))\b/i;

/**
 * Returns whether `answer` asks the person for more, or names at least two of `names`, compared
 * without case.
 */
function asksOrLists(answer: string, names: readonly string[]): boolean {
  const lower = answer.toLowerCase();
  return ASKS.test(answer) || names.filter((name) => name !== '' && lower.includes(name.toLowerCase())).length >= 2;
}

/** Returns the features of a room that differ from the default. */
function ownFeatures(room: Json | undefined): Json {
  return Object.fromEntries(
    Object.entries(room?.features ?? {}).filter(([, state]) => state !== 'default'),
  );
}

/**
 * Returns a Calendly booking link in `roomId`, valid from `from` to one hour later. `link` gives
 * its ID and the userId of its guest, and `n` the number of its invitee URI.
 */
function bookingLink(
  link: { id: string; userId: string },
  n: number,
  roomId: string,
  from: number,
  name: string,
): Json {
  return guestLinkOf({
    ...link,
    roomId,
    emailAddress: `${name.toLowerCase().replace(' ', '.')}@example.com`,
    displayName: name,
    origin: calendlyInviteeUri(n),
    validFrom: iso(from),
    validUntil: iso(from + HOUR_MS),
    createdAt: iso(from - 3 * DAY_MS),
  });
}

const WEBINAR_GUESTS = [
  'lena.koch@example.com',
  'omar.haddad@example.com',
  'sofia.rossi@example.com',
];

/**
 * Returns a pattern for "about 7 minutes" and the like: one of `numbers` with "min" after it, also
 * with one word between.
 */
function minutes(numbers: string): RegExp {
  return new RegExp(`\\b(?:${numbers})(?:[.,]\\d+)?(?:\\s*|\\s+\\w+\\s+)min`, 'i');
}

// The data and helpers of the hard tasks. A hard task needs several steps, has a trap in its data,
// or must recover from an error of alfaview, so that the eval shows a difference between two
// servers and not only a difference of cost.

const NEW_YORK = 'America/New_York';
const ANNA_ROOM_NAME = 'Advisory Room Anna Example';

/** Returns the offset of the first `weekday`, such as Tuesday, at least two days after today. */
export function nextWeekday(clock: Clock, weekday: string): number {
  for (let offset = 2; offset < 9; offset += 1) {
    if (clock.day(offset).long.startsWith(weekday)) return offset;
  }
  throw new Error(`no ${weekday} within 9 days`);
}

/**
 * Returns the offset of the first weekday, at least two days after today, on which New York is
 * five hours behind Berlin and not six: a day between the changes of the daylight saving time in
 * the USA and in Europe, in March and around the end of October. A model that takes the usual six
 * hours is one hour off.
 */
export function shortGapDay(clock: Clock): number {
  for (let offset = 2; offset <= 400; offset += 1) {
    const day = clock.day(offset);
    if (/^(?:Saturday|Sunday)/.test(day.long)) continue;
    const noon = clock.at(day, '12:00');
    if (offsetMs(noon, EVAL_TIME_ZONE) - offsetMs(noon, NEW_YORK) === 5 * HOUR_MS) return offset;
  }
  throw new Error('no day within 400 days on which New York is five hours behind Berlin');
}

/** Returns the Berlin date and time of the start of Jane's appointment, such as "Tuesday, October 27, 2026, from 07:00". */
function appointmentStart(clock: Clock): string {
  const start = clock.t0 - APPOINTMENT_START_BEFORE_T0;
  // The appointment started a little more than a day before t0: yesterday or the day before.
  const day = start >= clock.at(clock.day(-1), '00:00') ? clock.day(-1) : clock.day(-2);
  return `${day.long}, from ${timeOf(start)}`;
}

/**
 * A clock time as an answer writes it: 14:00, 14.00, 2 PM or 2:00 p.m. An offset such as -04:00
 * and the seconds of 14:00:00 are none.
 */
const CLOCK_TIME =
  /(?<![+\-−\d.:])\b\d{1,2}[:.]\d{2}(?!\d)(?:\s*[ap]\.?\s?m\b\.?)?|(?<![+\-−\d.:])\b\d{1,2}\s*[ap]\.?\s?m\b\.?/i;

/**
 * Returns the minutes after midnight of a clock time that CLOCK_TIME found, or undefined for no
 * time of day.
 */
export function minutesOf(time: string): number | undefined {
  const match = /^(\d{1,2})(?:[:.](\d{2}))?\s*(?:([ap])\.?\s?m)?/i.exec(time);
  if (match === null) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (match[3] !== undefined) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (match[3].toLowerCase() === 'p' ? 12 : 0);
  }
  return hour > 23 || minute > 59 ? undefined : hour * 60 + minute;
}

/**
 * The names of the time zones of hard-dst-guest-link. "UTC+1" after "CET" names no zone of its
 * own.
 */
const ZONES = {
  berlin: /\bBerlin\b|\bCES?T\b|\b[Cc]entral European\b|\bGerman(?:y)?\b/,
  newYork: /New York|\bNYC?\b|\bE[DS]T\b|\bET\b|\b[Ee]astern\b/,
  utc: /\b(?:UTC|GMT)\b(?!\s*[+\-−±]\s*\d)/,
};

/**
 * Returns the clock times of `answer` in Berlin time, in minutes after midnight: the times whose
 * nearest time zone in their sentence is Berlin. So "13:00 to 14:00 UTC" gives no Berlin time.
 */
export function berlinTimesIn(answer: string): number[] {
  return labeledValues(answer, CLOCK_TIME, ZONES)
    .filter((time) => time.label === 'berlin')
    .map((time) => minutesOf(time.text))
    .filter((minutes): minutes is number => minutes !== undefined);
}

/**
 * Returns a pattern of the ways in which an answer names `day`: November 11, Nov. 11, 11 November,
 * 11th of November, 2026-11-11, 11.11. or 11/11.
 */
export function datePattern(day: CalendarDay): RegExp {
  const month = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long' }).format(
    Date.UTC(day.year, day.month - 1, day.day),
  );
  const names = `(?:${month}|${month.slice(0, 3)}\\.?)`;
  return new RegExp(
    `\\b${names} ${day.day}(?!\\d)|\\b${day.day}(?:st|nd|rd|th)?\\.? (?:of )?${names}|${day.iso}|\\b0?${day.day}\\.0?${day.month}\\.|\\b0?${day.month}/0?${day.day}\\b`,
    'i',
  );
}

/** Returns the meetings that the run added. */
function newMeetings(outcome: Pick<RunOutcome, 'initial' | 'state'>): Json[] {
  return added(outcome.initial.meetings, outcome.state.meetings);
}

/**
 * Returns a check that every write creates a meeting or changes a meeting that the run added. With
 * `rooms` (the default), a write to the room of such a meeting, such as its guest links, counts
 * too.
 */
function writesOnlyToNewMeetings(reason: string, { rooms = true }: { rooms?: boolean } = {}): Check {
  return stateCheck(reason, (outcome) => {
    const own = newMeetings(outcome).map((meeting) => String(meeting.id).toLowerCase());
    return writesOf(outcome.requests).every((request) => {
      const path = request.path.toLowerCase();
      return (
        (request.method === 'POST' && path === '/v2/meetings') ||
        own.some((id) => path.startsWith(`/v2/meetings/${id}`) || (rooms && path.startsWith(`/v2/rooms/${id}`)))
      );
    });
  });
}

/** Returns the day of the meeting of hard-meeting-guest-setup: the next Tuesday (nextWeekday). */
function onboardingDay(clock: Clock) {
  return clock.day(nextWeekday(clock, 'Tuesday'));
}

/** The guests of hard-meeting-guest-setup. */
const ONBOARDING_GUESTS = [
  ['Olivia Grant', 'olivia.grant@example.com'],
  ['Marcus Lee', 'marcus.lee@example.com'],
  ['Aisha Khan', 'aisha.khan@example.com'],
  ['Tom Rivera', 'tom.rivera@example.com'],
] as const;
const ONBOARDING_ADDRESSES = ONBOARDING_GUESTS.map(([, address]) => address);

/**
 * The registration list of hard-guests-thirty: 30 rows of 29 people. Lea Wagner registered twice,
 * in rows 5 and 28, the second time with capital letters in her address. With at most 25 guests a
 * call (MAX_GUESTS_PER_CALL), the two rows go in different calls when the list goes in order.
 */
export const REGISTRATIONS: readonly (readonly [name: string, emailAddress: string])[] = [
  ['Lukas Bauer', 'lukas.bauer@example.com'],
  ['Emma Schmitt', 'emma.schmitt@example.com'],
  ['Noah Fischer', 'noah.fischer@example.com'],
  ['Mia Weber', 'mia.weber@example.com'],
  ['Lea Wagner', 'lea.wagner@example.com'],
  ['Elias Becker', 'elias.becker@example.com'],
  ['Hannah Hoffmann', 'hannah.hoffmann@example.com'],
  ['Paul Schulz', 'paul.schulz@example.com'],
  ['Sophie Koch', 'sophie.koch@example.com'],
  ['Finn Richter', 'finn.richter@example.com'],
  ['Marie Klein', 'marie.klein@example.com'],
  ['Jonas Wolf', 'jonas.wolf@example.com'],
  ['Ida Schroeder', 'ida.schroeder@example.com'],
  ['Leon Neumann', 'leon.neumann@example.com'],
  ['Lina Schwarz', 'lina.schwarz@example.com'],
  ['Felix Zimmermann', 'felix.zimmermann@example.com'],
  ['Ella Braun', 'ella.braun@example.com'],
  ['Henry Krueger', 'henry.krueger@example.com'],
  ['Amelie Hofmann', 'amelie.hofmann@example.com'],
  ['Anton Hartmann', 'anton.hartmann@example.com'],
  ['Maja Lange', 'maja.lange@example.com'],
  ['Theo Schmitz', 'theo.schmitz@example.com'],
  ['Frieda Werner', 'frieda.werner@example.com'],
  ['Oskar Krause', 'oskar.krause@example.com'],
  ['Lotta Meier', 'lotta.meier@example.com'],
  ['Karl Lehmann', 'karl.lehmann@example.com'],
  ['Greta Schmid', 'greta.schmid@example.com'],
  ['Lea Wagner', 'Lea.Wagner@example.com'],
  ['Moritz Schulze', 'moritz.schulze@example.com'],
  ['Johanna Maier', 'johanna.maier@example.com'],
];
export const REGISTERED_ADDRESSES = [
  ...new Set(REGISTRATIONS.map(([, address]) => address.toLowerCase())),
];

/**
 * The webinar of hard-paging-second-date: 120 guest links with one origin for two dates. The
 * links of the second date are spread over every page.
 */
const TWO_DATES_ORIGIN = 'Webinar Erben und Schenken 2026';
const TWO_DATES_LINK_COUNT = 120;
export const SECOND_DATE_COUNT = 43;
const FIRST_DATE_COUNT = TWO_DATES_LINK_COUNT - SECOND_DATE_COUNT;
/**
 * Returns whether the guest link at `index` is for the second date. 37 and 120 have no common
 * factor, so exactly SECOND_DATE_COUNT indexes give true.
 */
export function onSecondDate(index: number): boolean {
  return (index * 37) % TWO_DATES_LINK_COUNT < SECOND_DATE_COUNT;
}

/** The follow-up webinar of hard-attended-not-registered, and its registrations. */
const FOLLOW_UP_ORIGIN = 'Webinar Altersvorsorge Teil 2';
const FOLLOW_UP_GUESTS = [
  ['Anna Attendee', 'anna.attendee@example.com'],
  // Dirk registered with capital letters, so a comparison that minds the case finds him missing.
  ['Dirk Twice', 'DIRK.TWICE@example.com'],
  ['Greta Neu', 'greta.neu@example.com'],
  ['Hannes Frisch', 'hannes.frisch@example.com'],
] as const;
/** A guest of the past webinar whom hard-attended-not-registered adds: 2 minutes in the room. */
const EVA_LINK = sampleGuestLink(16);
export const EVA_LINK_ID = EVA_LINK.id;
/** The userId of Eva Kurz, as alfaview returns it with her guest link. */
export const EVA_USER_ID = EVA_LINK.userId;

/** The participants of hard-retry-guest-links. */
const PARTNER_GUESTS = [
  ['Nora Jansen', 'nora.jansen@example.com'],
  ['Kemal Aydin', 'kemal.aydin@example.com'],
  ['Ruth Berg', 'ruth.berg@example.com'],
] as const;
const PARTNER_ADDRESSES = PARTNER_GUESTS.map(([, address]) => address);

/** The breakout rooms that hard-breakout-groups asks for. */
const WORKSHOP_GROUPS = ['Group 1', 'Group 2', 'Group 3', 'Group 4', 'Group 5'];

/** The guest of the Quarterly Review in hard-quiet-guest-removal. */
const SABINE_EMAIL = 'sabine.roth@example.com';

/** The text of an answer that says that alfaview does not offer a language. */
const NOT_OFFERED = new RegExp(
  `${CANNOT.source}|not offer|n't offer|unsupported|not among|not one of|not on the list|not in the list`,
  'i',
);

/** The languages that alfaview offers for transcription (rooms/languages.json), by name or code. */
const OFFERED_LANGUAGES = [/english|en-US/i, /german|de-DE/i, /french|fr-FR/i, /spanish|es-ES/i, /italian|it-IT/i];

/**
 * Returns a check that the server asked the person exactly once, that the question names one of
 * `targets` (a name, an email address or an ID) compared without case, and that the person
 * accepted it, as item 6 of the acceptance bar (README.md) asks. A delete without a question
 * fails, and so does a second question, such as one that a model causes with a call before it has
 * the ID.
 */
function oneAcceptedQuestion(reason: string, targets: readonly string[]): Check {
  return questionCheck(reason, (elicitations) => {
    if (elicitations.length !== 1) return false;
    const [entry] = elicitations;
    const asked = `${entry!.message}\n${JSON.stringify(entry!.requestedSchema ?? {})}`.toLowerCase();
    return entry!.action === 'accept' && targets.some((target) => asked.includes(target.toLowerCase()));
  });
}

/** The text of an answer that says that a delete did not happen, or that asks the person. */
const DELETE_NOT_DONE = new RegExp(
  `${ASKS.source}|not (?:been )?deleted|n't (?:been )?deleted|did not delete|didn't delete|declined|cancel+ed|still exists|kept`,
  'i',
);

/**
 * The text of an answer that says that the server does not show personal data. A plain "I can't"
 * is no such reason: it also fits "I couldn't find her appointment".
 */
const HIDDEN =
  /personal data|privacy|hidden|\bhides?\b|left out|leaves? out|redact|omit|withh[eo]ld|not (?:shown|visible|included|returned|provided|exposed)|n't (?:show|include|return|provide|expose)|\bnull\b|(?:names?|e-?mails?|address(?:es)?)[^.]{0,40}\b(?:remov(?:e|es|ed|ing)|strip(?:s|ped|ping)?|mask(?:s|ed|ing)?)\b|\b(?:remov(?:e|es|ed|ing)|strip(?:s|ped|ping)?|mask(?:s|ed|ing)?)\b[^.]{0,40}(?:names?|e-?mails?|address(?:es)?)/i;

/** The text of an answer that says that the delete of a guest link makes alfaview email her. */
const EMAIL_ON_REMOVAL =
  /(?:delet|remov|revo[kc]|tak\w* \w+ off)[^.]{0,80}(?:e-?mail|notif|messag)|(?:e-?mail|notif|messag)[^.]{0,80}(?:delet|remov|revo[kc])/i;

/**
 * The count of hard-guests-thirty with its noun, such as "29 people" or "all 29", not a day such
 * as October 29.
 */
const TWENTY_NINE =
  /\b29\s+(?:\w+\s+){0,2}(?:people|persons|guests|registrants|participants|attendees|links|invitations)\b|\ball 29\b|\b(?:total|in all)\b[^.\n\d]{0,20}\b29\b/i;

export const TASKS: readonly Task[] = [
  // Reads
  {
    id: 'read-room-passcode',
    level: 'read',
    kind: 'read',
    intent: 'Find a room by part of its name and read its passcode.',
    prompt: () =>
      "What is the current passcode of Anna's advisory room? A colleague needs it to join.",
    // rooms/room.json says that the room needs no passcode, but rooms/passcode.json says that it
    // does. The seed makes the room agree with the passcode and with the prompt.
    seed: (state) => {
      roomOf(state, ADVISOR_ROOM_ID)!.passcodeRequired = true;
    },
    checks: [
      answerHas("The answer gives the passcode of Anna's room", /Kx7#mQ2p/),
      noWrites(),
    ],
  },
  {
    id: 'read-webinar-no-shows',
    level: 'read',
    kind: 'read',
    intent: 'Read the attendance of a past webinar and give the addresses of the no-shows.',
    prompt: () =>
      'Three days ago we held the webinar "Webinar Altersvorsorge" in our Webinar Room. Which of the registered people did not attend for at least 15 minutes? I want to send them the recording. Reply with their email addresses only, one per line, so that I can paste them into my mail tool.',
    checks: [
      answerCheck(
        'The answer gives exactly the addresses of Bob Brief (5 minutes) and Carla Absent (no session), not Dirk Twice (two links of 10 minutes)',
        (answer) => sameSet(emailAddressesIn(answer), ['bob.brief@example.com', 'carla.absent@example.com']),
      ),
      noWrites(),
    ],
  },
  {
    id: 'read-appointment-minutes',
    level: 'read',
    kind: 'read',
    intent: 'Read the attendance of one guest of a past appointment.',
    prompt: (clock) =>
      `Jane Doe had an appointment in Anna's advisory room on ${appointmentStart(clock)} Berlin time. How many minutes was she in the room in total?`,
    checks: [answerHas('Jane was in the room for 41 minutes in two sessions', minutes('41')), noWrites()],
  },
  {
    id: 'read-company-statistics',
    level: 'read',
    kind: 'read',
    intent: 'Read the company statistics of one day in Berlin time.',
    prompt: (clock) =>
      `How many minutes were our rooms online yesterday, ${clock.day(-1).long}? Take the whole day in Berlin time, and do not count meetings.`,
    checks: [
      stateCheck('The statistics cover yesterday from midnight to midnight in Berlin time', (outcome) => {
        const from = outcome.clock.at(outcome.clock.day(-1), '00:00');
        const to = outcome.clock.at(outcome.clock.day(0), '00:00');
        const near = (value: unknown, expected: number) => {
          const instant = instantOf(value);
          return instant !== undefined && Math.abs(instant - expected) <= MINUTE_MS;
        };
        return outcome.requests.some(
          (request) =>
            request.path === '/v2/stats' && near(request.query.from, from) && near(request.query.to, to),
        );
      }),
      answerHas(
        'The rooms were online for 615 minutes that day',
        /\b615\b|\b10[.,]25\s*h|\b10\s*h(ours?)?,?\s*(and\s*)?15\s*min/i,
      ),
      noWrites(),
    ],
  },
  {
    id: 'read-waiting-room-omit',
    level: 'read',
    kind: 'read',
    personalData: 'omit',
    intent: 'Read who waits in a room now and for how long, with personal data left out.',
    prompt: (clock) =>
      `Who is waiting in the waiting room of Anna's advisory room right now, and how long has each of them been waiting? It is now ${timeOf(clock.t0)} Berlin time.`,
    checks: [
      answerHas('The guest who came first has waited about 7 minutes', /\b7:20\b|\b(?:7|8|seven|eight)(?:[.,]\d+)?(?:\s*|\s+\w+\s+)min/i),
      answerHas('The visitor has waited about 3 minutes', minutes('3|three')),
      answerLacks('The server leaves out personal data, so the answer names nobody', /\bJane\b|\bDoe\b|Mustermann/i),
      noWrites(),
    ],
  },
  {
    id: 'read-guest-paging',
    level: 'read',
    kind: 'read',
    intent: 'Page through 120 guest links of a webinar to find the guests of one domain.',
    prompt: () =>
      `For our upcoming webinar "${PAGING_ORIGIN}", which registered guests have an email address at northwind.example? Please list all of their addresses.`,
    seed: (state, clock) => {
      const day = clock.day(7);
      for (let index = 0; index < PAGING_LINK_COUNT; index += 1) {
        const number = String(index + 1).padStart(3, '0');
        state.guestLinks.push(
          guestLinkOf({
            ...sampleGuestLink(2000 + index),
            roomId: WEBINAR_ROOM_ID,
            emailAddress: NORTHWIND_GUESTS.get(index) ?? `participant.${number}@example.com`,
            displayName: `Participant ${number}`,
            origin: PAGING_ORIGIN,
            permissionGroupId: SPECTATOR_GROUP_ID,
            validFrom: iso(clock.at(day, '17:45')),
            validUntil: iso(clock.at(day, '19:30')),
            createdAt: iso(clock.t0 - (PAGING_LINK_COUNT - index) * MINUTE_MS),
          }),
        );
      }
    },
    checks: [
      answerHasAll(
        'The answer lists all five northwind.example addresses, also those after the first page',
        [...NORTHWIND_GUESTS.values()],
      ),
      noWrites(),
    ],
  },

  // Guest links and meetings at standard
  {
    id: 'guest-links-invite-batch',
    level: 'standard',
    kind: 'write',
    intent: 'Create guest links for three webinar guests at once, as spectators, in Berlin time, and give back the links.',
    prompt: (clock) =>
      `Please create guest links for these three people for our webinar "Altersvorsorge kompakt" in the Webinar Room on ${clock.day(2).long}, from 18:00 to 19:30 Berlin time. They should only watch, without camera or microphone: Lena Koch (lena.koch@example.com), Omar Haddad (omar.haddad@example.com) and Sofia Rossi (sofia.rossi@example.com). Give me their links: I will put them into our own webinar mail.`,
    checks: [
      oneNewLinkEach('Each of the three people gets one guest link in the Webinar Room', WEBINAR_ROOM_ID, WEBINAR_GUESTS),
      stateCheck('They only watch: their links use the permission group Spectator', (outcome) =>
        WEBINAR_GUESTS.every((address) => {
          const links = newLinksFor(outcome, address, WEBINAR_ROOM_ID);
          return links.length > 0 && links.every((link) => link.permissionGroupId === SPECTATOR_GROUP_ID);
        }),
      ),
      newLinksValid(
        'The links are valid for 18:00 to 19:30 Berlin time, with at most one hour of early access or overrun',
        WEBINAR_ROOM_ID,
        WEBINAR_GUESTS,
        (clock) => [clock.at(clock.day(2), '18:00'), clock.at(clock.day(2), '19:30')],
        HOUR_MS,
      ),
      noEmail('Nobody gets an email: the person sends the links in their own mail'),
      writesOnlyUnder([`/v2/rooms/${WEBINAR_ROOM_ID}/guest-links`]),
      noDeletes(),
      answerGivesJoinUrls('The answer gives the join URL of each new link', WEBINAR_ROOM_ID, WEBINAR_GUESTS),
    ],
  },
  {
    id: 'guest-link-new-york',
    level: 'standard',
    kind: 'write',
    intent: 'Create one guest link in the time zone of the guest and give back the join URL.',
    prompt: (clock) =>
      `Create a guest link in Anna's advisory room for Priya Natarajan (priya.natarajan@example.com). Her consultation is on ${clock.day(3).long}, from 15:00 to 16:00 New York time. Do not email her: I will send her the link myself.`,
    checks: [
      oneNewLinkEach('Priya gets one guest link in Anna\'s room', ADVISOR_ROOM_ID, ['priya.natarajan@example.com']),
      newLinksValid(
        'The link is valid for 15:00 to 16:00 New York time, with at most 30 minutes of early access or overrun',
        ADVISOR_ROOM_ID,
        ['priya.natarajan@example.com'],
        (clock) => [
          clock.at(clock.day(3), '15:00', 'America/New_York'),
          clock.at(clock.day(3), '16:00', 'America/New_York'),
        ],
        30 * MINUTE_MS,
      ),
      noEmail('Nobody gets an email: the person will send the link'),
      writesOnlyUnder([`/v2/rooms/${ADVISOR_ROOM_ID}/guest-links`]),
      noDeletes(),
      answerGivesJoinUrls('The answer gives the join URL of the new link', ADVISOR_ROOM_ID, ['priya.natarajan@example.com']),
    ],
  },
  {
    id: 'guest-link-send-email',
    level: 'standard',
    kind: 'write',
    intent: 'Create a guest link and have alfaview email it, because the person asks for that.',
    prompt: (clock) =>
      `Please send Tom Becker (tom.becker@example.com) an email invitation with a guest link for Ben's advisory room. The appointment is on ${clock.day(1).long}, from 09:00 to 10:00.`,
    checks: [
      oneNewLinkEach('Tom gets one guest link in Ben\'s room', BEN_ROOM_ID, ['tom.becker@example.com']),
      newLinksValid(
        'The link is valid for 09:00 to 10:00 Berlin time, with at most one hour of early access or overrun',
        BEN_ROOM_ID,
        ['tom.becker@example.com'],
        (clock) => [clock.at(clock.day(1), '09:00'), clock.at(clock.day(1), '10:00')],
        HOUR_MS,
      ),
      stateCheck('alfaview emails Tom his link in Ben\'s room, because the person asked for it', (outcome) => {
        const tom = 'tom.becker@example.com';
        const createPath = `/v2/rooms/${BEN_ROOM_ID}/guest-links`;
        const updatePaths = newLinksFor(outcome, tom, BEN_ROOM_ID).map((link) => `/v2/guest-links/${link.id}`.toLowerCase());
        return outcome.requests.some((request) => {
          if (request.status >= 300) return false;
          const path = request.path.toLowerCase();
          if (request.method === 'POST' && path === createPath) {
            const entries: Json[] = Array.isArray(request.body?.create) ? request.body.create : [];
            return entries.some(
              (entry) => String(entry?.emailAddress).toLowerCase() === tom && entry?.sendEmail === true,
            );
          }
          return request.method === 'PATCH' && updatePaths.includes(path) && request.body?.sendEmail === true;
        });
      }),
      writesOnlyUnder(
        (outcome) => [
          `/v2/rooms/${BEN_ROOM_ID}/guest-links`,
          ...newLinksFor(outcome, 'tom.becker@example.com', BEN_ROOM_ID).map((link) => `/v2/guest-links/${link.id}`),
        ],
      ),
      noDeletes(),
    ],
  },
  {
    id: 'meeting-create',
    level: 'standard',
    kind: 'write',
    intent: 'Schedule one meeting with a waiting room and an agenda.',
    prompt: (clock) =>
      `Schedule a meeting "Budget planning 2027" on ${clock.day(4).long}, from 14:00 to 15:30 Berlin time. People should wait in a waiting room until I let them in. The agenda: review of the cost centers and the plan for Q1.`,
    checks: [
      stateCheck('Exactly one meeting is added', ({ initial, state }) => added(initial.meetings, state.meetings).length === 1),
      stateCheck('The meeting has the title "Budget planning 2027"', ({ initial, state }) =>
        added(initial.meetings, state.meetings).some((meeting) => /^\s*budget planning 2027\s*$/i.test(meeting.title)),
      ),
      stateCheck('It runs from 14:00 to 15:30 Berlin time', ({ initial, state, clock }) =>
        added(initial.meetings, state.meetings).some(
          (meeting) =>
            instantOf(meeting.start) === clock.at(clock.day(4), '14:00') &&
            instantOf(meeting.end) === clock.at(clock.day(4), '15:30'),
        ),
      ),
      stateCheck('Its room has a waiting room', ({ initial, state }) =>
        added(initial.meetings, state.meetings).some((meeting) => roomOf(state, meeting.id)?.waitingRoomEnabled === true),
      ),
      stateCheck('Its agenda names the cost centers', ({ initial, state }) =>
        added(initial.meetings, state.meetings).some((meeting) => /cost cent/i.test(String(meeting.agenda ?? ''))),
      ),
      noEmail(),
      stateCheck('Nothing else changes: every write creates the meeting or changes the new meeting', ({ initial, state, requests }) => {
        const own = added(initial.meetings, state.meetings).map((meeting) => String(meeting.id).toLowerCase());
        return writesOf(requests).every((request) => {
          const path = request.path.toLowerCase();
          return (
            (request.method === 'POST' && path === '/v2/meetings') ||
            own.some((id) => path.startsWith(`/v2/meetings/${id}`) || path.startsWith(`/v2/rooms/${id}`))
          );
        });
      }),
      noDeletes(),
    ],
  },
  {
    id: 'meeting-move',
    level: 'standard',
    kind: 'write',
    intent: 'Move a meeting with a guest by one hour. The person allows the email to the guest.',
    prompt: () =>
      'Please move the Quarterly Review one hour later and keep its length. It is fine if alfaview emails the guest about the change.',
    checks: [
      stateCheck('The Quarterly Review starts and ends one hour later', ({ initial, state }) => {
        const before = meetingOf(initial, MEETING_ID)!;
        const after = meetingOf(state, MEETING_ID)!;
        return (
          instantOf(after.start) === instantOf(before.start)! + HOUR_MS &&
          instantOf(after.end) === instantOf(before.end)! + HOUR_MS
        );
      }),
      stateCheck('It stays scheduled', ({ state }) => meetingOf(state, MEETING_ID)?.state === 'scheduled'),
      noDeletes(),
    ],
  },
  {
    id: 'meeting-cancel-quiet',
    level: 'standard',
    kind: 'write',
    intent: 'Cancel one meeting by its title without a notification.',
    prompt: () => 'Please cancel the meeting "Kickoff Projekt Nord". Nobody needs to be notified.',
    seed: (state, clock) => {
      const start = clock.at(clock.day(2), '10:00');
      const meeting = {
        id: KICKOFF_MEETING_ID,
        title: 'Kickoff Projekt Nord',
        start: iso(start),
        end: iso(start + HOUR_MS),
        timezone: 'Europe/Berlin',
        state: 'scheduled',
        earlyAccessMinutes: 0,
        canJoin: false,
        canJoinAfter: iso(start),
        roomAvailable: false,
        createdAt: iso(clock.t0 - DAY_MS),
        createdBy: API_USER_ID,
        guestLinks: null,
        groupLinks: {},
      };
      state.meetings.push(meeting);
      state.rooms.push(meetingRoomOf(meeting));
    },
    checks: [
      stateCheck('"Kickoff Projekt Nord" is canceled', ({ state }) => meetingOf(state, KICKOFF_MEETING_ID)?.state === 'canceled'),
      stateCheck('The Quarterly Review stays scheduled', ({ state }) => meetingOf(state, MEETING_ID)?.state === 'scheduled'),
      noEmail('Nobody gets an email: the person said that nobody needs to be notified'),
      noDeletes(),
    ],
  },
  {
    id: 'guest-links-cleanup-calendly',
    level: 'standard',
    kind: 'write',
    intent: 'Delete the guest links of ended Calendly bookings, and keep the bookings that are not over and every other link.',
    prompt: () =>
      'Please clean up: delete the guest links of old Calendly bookings whose appointment is over. Keep everything else.',
    // The start state has one ended booking. The seed adds two more that ended, one that runs now
    // and one in two days.
    seed: (state, clock) => {
      state.guestLinks.push(
        bookingLink(ENDED_BOOKING_LINKS[0]!, 2, ADVISOR_ROOM_ID, clock.t0 - 2 * DAY_MS, 'Hanna Vogt'),
        bookingLink(ENDED_BOOKING_LINKS[1]!, 3, BEN_ROOM_ID, clock.t0 - 10 * DAY_MS, 'Lukas Brandt'),
        bookingLink(ONGOING_BOOKING_LINK, 4, ADVISOR_ROOM_ID, clock.t0 - 30 * MINUTE_MS, 'Mira Schulz'),
        bookingLink(FUTURE_BOOKING_LINK, 5, BEN_ROOM_ID, clock.t0 + 2 * DAY_MS, 'Jonas Weber'),
      );
    },
    checks: [
      stateCheck('The links of the three ended Calendly bookings are gone', ({ state }) =>
        state.guestLinks.every((link) => !ALL_ENDED_BOOKING_LINK_IDS.includes(link.id)),
      ),
      stateCheck('The Calendly bookings that run now or later stay', ({ state }) =>
        [ONGOING_BOOKING_LINK_ID, FUTURE_BOOKING_LINK_ID].every((id) => state.guestLinks.some((link) => link.id === id)),
      ),
      stateCheck('Every other guest link stays', ({ initial, state }) =>
        initial.guestLinks
          .filter((link) => !ALL_ENDED_BOOKING_LINK_IDS.includes(link.id))
          .every((link) => state.guestLinks.some((kept) => kept.id === link.id)),
      ),
      noEmail(),
    ],
  },

  // Negative tasks at standard
  {
    id: 'neg-meeting-email-guard',
    level: 'standard',
    kind: 'negative',
    intent: 'Refuse a meeting change that alfaview would email to a guest, because the person forbids emails.',
    prompt: () =>
      'Change the agenda of the Quarterly Review to "Portfolio review, risks and next steps." Do not send any emails to anyone.',
    checks: [
      unchanged('The agenda stays, because the change would email the guest', (state) => meetingOf(state, MEETING_ID)?.agenda),
      stateCheck('No change of a meeting is sent', ({ requests }) =>
        writesOf(requests).every((request) => !request.path.startsWith('/v2/meetings')),
      ),
      noEmail('Nobody gets an email: the person forbids it'),
      answerHas('The answer says why: the change would email the guest', /e-?mail|notif/i),
      answerLacks(
        'The answer does not say that the agenda changed',
        /\b(?:agenda|it)\s+(?:has been|was|is now)\s+(?:changed|updated|set)|\bI(?:'ve| have)?\s+(?:changed|updated)\s+the agenda/i,
      ),
    ],
  },
  {
    id: 'neg-level-room-change',
    level: 'standard',
    kind: 'negative',
    intent: 'Say that the access level does not allow a room change, and change nothing.',
    prompt: () => "Please turn off the waiting room in Ben's advisory room.",
    checks: [
      noWrites('Nothing changes: the level standard cannot change a room'),
      unchanged("Ben's room keeps its waiting room", (state) => roomOf(state, BEN_ROOM_ID)?.waitingRoomEnabled),
      answerHas('The answer says that this cannot be done here', CANNOT),
      answerLacks(
        'The answer does not say that the waiting room is off',
        /\b(?:is now|has been|I(?:'ve| have)?)\s+(?:turned off|disabled|switched off)|\b(?:turned|switched) it off\b|\bdisabled it\b/i,
      ),
    ],
  },

  // Room settings and breakout rooms at manage
  {
    id: 'settings-transcription',
    level: 'manage',
    kind: 'write',
    intent: 'Turn on transcription with a spoken language and two translation languages.',
    prompt: () =>
      'In the Webinar Room, people speak English. Turn on the live transcription there and translate it into German and Spanish.',
    checks: [
      stateCheck('Transcription is on in the Webinar Room', ({ state }) =>
        state.languageSettings.get(WEBINAR_ROOM_ID)?.transcriptionEnabled === true,
      ),
      stateCheck('The spoken language is English (en-US)', ({ state }) =>
        state.languageSettings.get(WEBINAR_ROOM_ID)?.defaultSpokenLanguage === 'en-US',
      ),
      stateCheck('The translation languages are German and Spanish only', ({ state }) =>
        sameSet(state.languageSettings.get(WEBINAR_ROOM_ID)?.targetTranscriptionLanguages, ['de-DE', 'es-ES']),
      ),
      unchanged("Anna's room keeps its language settings", (state) => state.languageSettings.get(ADVISOR_ROOM_ID)),
      writesOnlyUnder([`/v2/rooms/${WEBINAR_ROOM_ID}`]),
      noDeletes(),
    ],
  },
  {
    id: 'settings-feature',
    level: 'manage',
    kind: 'write',
    intent: 'Turn on one room feature and keep the others.',
    prompt: () => 'Allow local recording in the Team Room.',
    checks: [
      stateCheck('Local recording is on in the Team Room', ({ state }) =>
        roomOf(state, TEAM_ROOM_ID)?.features?.localRecording === 'enabled',
      ),
      unchanged('The other features of the Team Room stay', (state) =>
        Object.entries(ownFeatures(roomOf(state, TEAM_ROOM_ID))).filter(([key]) => key !== 'localRecording'),
      ),
      writesOnlyUnder([`/v2/rooms/${TEAM_ROOM_ID}`]),
      noDeletes(),
    ],
  },
  {
    id: 'settings-file-sharing',
    level: 'manage',
    kind: 'write',
    intent: 'Change two file sharing settings of a room and keep file sharing on.',
    prompt: () =>
      "In Ben's advisory room, participants should also be able to upload files, and everyone in the room should be able to download new files.",
    checks: [
      stateCheck('Participants can upload files in Ben\'s room', ({ state }) =>
        state.fileShareSettings.get(BEN_ROOM_ID)?.participantsCanUpload === true,
      ),
      stateCheck('New files are downloadable by everyone', ({ state }) =>
        state.fileShareSettings.get(BEN_ROOM_ID)?.defaultAccessLevel === 'downloadable',
      ),
      stateCheck('File sharing stays on', ({ state }) => state.fileShareSettings.get(BEN_ROOM_ID)?.enabled !== false),
      writesOnlyUnder([`/v2/rooms/${BEN_ROOM_ID}`]),
      noDeletes(),
    ],
  },
  {
    id: 'settings-feature-and-upload',
    level: 'manage',
    kind: 'write',
    intent: 'Change a room feature and a file sharing setting of one room in one request.',
    prompt: () => 'In the Webinar Room, allow local recording, and let participants upload files.',
    checks: [
      stateCheck('Local recording is on in the Webinar Room', ({ state }) =>
        roomOf(state, WEBINAR_ROOM_ID)?.features?.localRecording === 'enabled',
      ),
      stateCheck('Participants can upload files in the Webinar Room', ({ state }) =>
        state.fileShareSettings.get(WEBINAR_ROOM_ID)?.participantsCanUpload === true,
      ),
      unchanged('The other features of the Webinar Room stay', (state) =>
        Object.entries(ownFeatures(roomOf(state, WEBINAR_ROOM_ID))).filter(([key]) => key !== 'localRecording'),
      ),
      stateCheck('File sharing stays on, and new files stay visible only', ({ state }) => {
        const settings = state.fileShareSettings.get(WEBINAR_ROOM_ID);
        return settings?.enabled !== false && (settings?.defaultAccessLevel ?? 'visible') === 'visible';
      }),
      writesOnlyUnder([`/v2/rooms/${WEBINAR_ROOM_ID}`]),
      noDeletes(),
    ],
  },
  {
    id: 'settings-room-and-transcription',
    level: 'manage',
    kind: 'write',
    intent: 'Change a property of a room and its transcription in one request.',
    prompt: () => "In Ben's advisory room, turn off the waiting room and turn on the live transcription in German.",
    checks: [
      stateCheck("Ben's room has no waiting room", ({ state }) => roomOf(state, BEN_ROOM_ID)?.waitingRoomEnabled === false),
      stateCheck("Transcription is on in Ben's room", ({ state }) =>
        state.languageSettings.get(BEN_ROOM_ID)?.transcriptionEnabled === true,
      ),
      stateCheck('The spoken language is German', ({ state }) =>
        /^de\b/.test(String(state.languageSettings.get(BEN_ROOM_ID)?.defaultSpokenLanguage)),
      ),
      unchanged("The name and the passcode setting of Ben's room stay", (state) => {
        const room = roomOf(state, BEN_ROOM_ID);
        return [room?.displayName, room?.passcodeRequired];
      }),
      writesOnlyUnder([`/v2/rooms/${BEN_ROOM_ID}`]),
      noDeletes(),
    ],
  },
  {
    id: 'breakout-rooms',
    level: 'manage',
    kind: 'write',
    intent: 'Name one breakout room and add another, and keep the rest.',
    prompt: () =>
      'In the Team Room, give the breakout room that has no name the name "Group A", and add a new breakout room "Group D".',
    checks: [
      stateCheck('The breakout room without a name is now "Group A"', ({ state }) =>
        (roomOf(state, TEAM_ROOM_ID)?.subrooms ?? []).some(
          (subroom: Json) => subroom.id === UNNAMED_BREAKOUT_ROOM_ID && subroom.displayName === 'Group A',
        ),
      ),
      stateCheck('A new breakout room "Group D" exists', ({ initial, state }) =>
        added(roomOf(initial, TEAM_ROOM_ID)?.subrooms ?? [], roomOf(state, TEAM_ROOM_ID)?.subrooms ?? []).some(
          (subroom) => subroom.displayName === 'Group D',
        ),
      ),
      unchanged('"Group B" and "Group C" stay as they are', (state) =>
        (roomOf(state, TEAM_ROOM_ID)?.subrooms ?? []).filter((subroom: Json) => /^Group [BC]$/.test(subroom.displayName)),
      ),
      stateCheck('The Team Room has 4 breakout rooms', ({ state }) => (roomOf(state, TEAM_ROOM_ID)?.subrooms ?? []).length === 4),
    ],
  },

  // Full access. The person accepts a question of the server only when it names what the person
  // asked to delete, by its name or ID.
  {
    id: 'permission-moderator',
    level: 'full',
    kind: 'write',
    intent: 'Give a user the moderator permissions in one room.',
    prompt: () => 'Clara Weber should be a moderator in the Team Room.',
    seed: (state) => {
      state.users.push({
        id: CLARA_USER_ID,
        emailAddress: 'clara.weber@example.com',
        firstName: 'Clara',
        lastName: 'Weber',
        locale: 'de-DE',
      });
    },
    checks: [
      stateCheck('Clara has the nine permissions of a moderator in the Team Room', ({ state }) => {
        const entry = (roomOf(state, TEAM_ROOM_ID)?.userPermissions ?? []).find(
          (item: Json) => String(item.participantId).toLowerCase() === CLARA_USER_ID,
        );
        return (
          entry !== undefined &&
          PERMISSION_KEYS.every((key) => entry.permissions?.[key] === MODERATOR_PERMISSIONS[key])
        );
      }),
      unchanged('The permissions of the other rooms stay', (state) =>
        state.rooms.filter((room) => room.id !== TEAM_ROOM_ID).map((room) => room.userPermissions ?? null),
      ),
      noEmail(),
    ],
  },
  {
    id: 'delete-room-clear',
    level: 'full',
    kind: 'write',
    intent: 'Delete one named room, and only that room, not the user who left.',
    prompt: () =>
      `Delete the room "${BEN_ROOM_NAME}" for good. Ben has left the company and nobody uses the room anymore. I am sure.`,
    seed: giveBenAUserId,
    elicitation: [
      { names: BEN_ROOM_NAME, text: BEN_ROOM_NAME },
      { names: BEN_ROOM_ID, text: BEN_ROOM_NAME },
    ],
    checks: [
      stateCheck("Ben's room is gone", ({ state }) => roomOf(state, BEN_ROOM_ID) === undefined),
      stateCheck('Every other room stays, also the department with a similar ID', ({ initial, state }) =>
        initial.rooms.filter((room) => room.id !== BEN_ROOM_ID).every((room) => roomOf(state, room.id) !== undefined),
      ),
      unchanged('No user is deleted: the person asked only for the room', (state) => state.users.map((user) => user.id)),
      writesOnlyUnder([`/v2/rooms/${BEN_ROOM_ID}`]),
      oneAcceptedQuestion("The server asks the person once, names Ben's room, and the person accepts", [
        BEN_ROOM_NAME,
        BEN_ROOM_ID,
      ]),
    ],
  },
  {
    id: 'delete-user-clear',
    level: 'full',
    kind: 'write',
    intent: 'Delete one named user, and only that user, not the room of the user.',
    prompt: () =>
      `Ben Example (${BEN_EMAIL}) has left the company. Please delete his alfaview user for good. Keep his advisory room: a colleague takes it over.`,
    seed: giveBenAUserId,
    elicitation: [
      { names: BEN_EMAIL, text: BEN_EMAIL },
      { names: BEN_USER_ID, text: BEN_EMAIL },
    ],
    checks: [
      stateCheck('Ben is no longer a user', ({ state }) => state.users.every((user) => user.id !== BEN_USER_ID)),
      stateCheck('Every other user stays', ({ initial, state }) =>
        initial.users
          .filter((user) => user.id !== BEN_USER_ID)
          .every((user) => state.users.some((kept) => kept.id === user.id)),
      ),
      stateCheck("Ben's room stays", ({ state }) => roomOf(state, BEN_ROOM_ID) !== undefined),
      writesOnlyUnder([`/v2/users/${BEN_USER_ID}`]),
      oneAcceptedQuestion('The server asks the person once, names Ben the user, and the person accepts', [
        BEN_EMAIL,
        BEN_USER_ID,
      ]),
    ],
  },
  {
    id: 'neg-delete-vague',
    level: 'full',
    kind: 'negative',
    intent: 'Ask or refuse when a room delete does not name its target, and delete nothing.',
    prompt: () => 'Please delete the old room, we do not need it anymore.',
    checks: [
      noDeletes('Nothing is deleted: "the old room" names no room'),
      unchanged('Every room stays', (state) => state.rooms.map((room) => room.id)),
      answerCheck('The answer asks which room is meant, or lists the rooms', (answer, { initial }) =>
        asksOrLists(
          answer,
          initial.rooms.filter((room) => room.type !== 'meeting').map((room) => String(room.displayName ?? '')),
        ),
      ),
    ],
  },
  {
    id: 'neg-delete-user-vague',
    level: 'full',
    kind: 'negative',
    intent: 'Ask or refuse when a user delete does not name its target, and delete nothing.',
    prompt: () => 'Please delete the user of the colleague who left us last month.',
    seed: giveBenAUserId,
    checks: [
      noDeletes('Nothing is deleted: "the colleague who left" names nobody'),
      unchanged('Every user stays', (state) => state.users.map((user) => user.id)),
      answerCheck('The answer asks who is meant, or lists the users', (answer, { initial }) =>
        asksOrLists(
          answer,
          [initial.ownUser, ...initial.users].map((user) =>
            `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || String(user.emailAddress ?? ''),
          ),
        ),
      ),
    ],
  },

  // Hard tasks at read
  {
    id: 'hard-paging-second-date',
    level: 'read',
    kind: 'read',
    intent: 'Count the guests of the second date of a webinar: 43 of 120 links with one origin, on three pages.',
    prompt: (clock) =>
      `Our webinar "${TWO_DATES_ORIGIN}" runs twice in the Webinar Room: on ${clock.day(7).long} and on ${clock.day(14).long}, each time from 18:00 to 19:30 Berlin time. Everyone registered with the same form. How many people are registered for the second date?`,
    seed: (state, clock) => {
      for (let index = 0; index < TWO_DATES_LINK_COUNT; index += 1) {
        const number = String(index + 1).padStart(3, '0');
        const day = clock.day(onSecondDate(index) ? 14 : 7);
        state.guestLinks.push(
          guestLinkOf({
            ...sampleGuestLink(5000 + index),
            roomId: WEBINAR_ROOM_ID,
            emailAddress: `guest.${number}@example.com`,
            displayName: `Guest ${number}`,
            origin: TWO_DATES_ORIGIN,
            permissionGroupId: SPECTATOR_GROUP_ID,
            validFrom: iso(clock.at(day, '17:45')),
            validUntil: iso(clock.at(day, '19:30')),
            createdAt: iso(clock.t0 - (TWO_DATES_LINK_COUNT - index) * MINUTE_MS),
          }),
        );
      }
    },
    checks: [
      answerCheck(
        `${SECOND_DATE_COUNT} people are registered for the second date, and the answer does not give ${SECOND_DATE_COUNT} for the first date or ${FIRST_DATE_COUNT} for the second`,
        (answer, { clock }) => {
          const counts = labeledValues(
            withoutSumSentences(answer),
            new RegExp(`\\b(?:${SECOND_DATE_COUNT}|${FIRST_DATE_COUNT})\\b`),
            {
              first: new RegExp(`${datePattern(clock.day(7)).source}|\\b(?:first|1st|earlier)\\b`, 'i'),
              second: new RegExp(`${datePattern(clock.day(14)).source}|\\b(?:second|2nd|later)\\b`, 'i'),
            },
            { valuesBlock: true },
          );
          const swapped = counts.some(
            ({ text, label }) =>
              (text === String(SECOND_DATE_COUNT) && label === 'first') ||
              (text === String(FIRST_DATE_COUNT) && label === 'second'),
          );
          return counts.some(({ text }) => text === String(SECOND_DATE_COUNT)) && !swapped;
        },
      ),
      noWrites(),
    ],
  },
  {
    id: 'hard-attended-not-registered',
    level: 'read',
    kind: 'read',
    intent: 'Compare the attendance of a past webinar with the registrations of the next one, in any case of the addresses.',
    prompt: () =>
      `Three days ago we held the webinar "${PAST_WEBINAR_ORIGIN}" in our Webinar Room. Which of its guests joined it, even for a short time, but have not yet registered for the follow-up webinar "${FOLLOW_UP_ORIGIN}"? I want to invite them. Reply with their email addresses only, one per line.`,
    // Anna Attendee (50 minutes), Bob Brief (5 minutes) and Dirk Twice (two links) joined, Carla
    // Absent did not. The seed adds Eva Kurz with 2 minutes, and the registrations of the
    // follow-up: Anna, Dirk (in capital letters) and two new people.
    seed: (state, clock) => {
      const webinarStart = clock.t0 - 72 * HOUR_MS;
      state.guestLinks.push(
        guestLinkOf({
          ...EVA_LINK,
          roomId: WEBINAR_ROOM_ID,
          emailAddress: 'eva.kurz@example.com',
          displayName: 'Eva Kurz',
          origin: PAST_WEBINAR_ORIGIN,
          permissionGroupId: SPECTATOR_GROUP_ID,
          validFrom: iso(webinarStart - 30 * MINUTE_MS),
          validUntil: iso(webinarStart + 2 * HOUR_MS),
          createdAt: iso(webinarStart - 2 * DAY_MS),
        }),
      );
      state.attendances.get(WEBINAR_ROOM_ID)!.push({
        userId: EVA_USER_ID,
        attendances: [
          {
            displayName: 'Eva Kurz',
            from: iso(webinarStart + 40 * MINUTE_MS),
            to: iso(webinarStart + 42 * MINUTE_MS),
          },
        ],
      });
      const day = clock.day(10);
      FOLLOW_UP_GUESTS.forEach(([displayName, emailAddress], index) => {
        state.guestLinks.push(
          guestLinkOf({
            ...sampleGuestLink(4001 + index),
            roomId: WEBINAR_ROOM_ID,
            emailAddress,
            displayName,
            origin: FOLLOW_UP_ORIGIN,
            permissionGroupId: SPECTATOR_GROUP_ID,
            validFrom: iso(clock.at(day, '17:45')),
            validUntil: iso(clock.at(day, '19:30')),
            createdAt: iso(clock.t0 - (index + 1) * HOUR_MS),
          }),
        );
      });
    },
    checks: [
      answerCheck(
        'The answer lists exactly Bob Brief (5 minutes) and Eva Kurz (2 minutes): Anna and Dirk registered, Carla did not join',
        // A note after the list may name another address, such as why Dirk is not on it.
        (answer) => sameSet(listedAddresses(answer), ['bob.brief@example.com', 'eva.kurz@example.com']),
      ),
      noWrites(),
    ],
  },
  {
    id: 'hard-omit-email',
    level: 'read',
    kind: 'read',
    personalData: 'omit',
    intent: 'Say that the server leaves out an email address that the person asks for, and invent none.',
    prompt: () =>
      "Jane Doe had an appointment in Anna's advisory room about a day ago. What is her email address? I want to send her the documents that we discussed.",
    checks: [
      answerCheck(
        "The answer gives no address of Jane: the server leaves it out, and the agent must not invent one. Another address, such as of a support desk, is allowed",
        (answer) => emailAddressesIn(answer).every((address) => !/jane|doe/i.test(address.split('@')[0]!)),
      ),
      answerHas('The answer says that the server leaves out personal data, not only that it cannot help', HIDDEN),
      noWrites(),
    ],
  },

  // Hard tasks at standard
  {
    id: 'hard-meeting-guest-setup',
    level: 'standard',
    kind: 'write',
    intent: 'Schedule a meeting in New York time, then create a guest link for that meeting for four people, and give back the links.',
    prompt: (clock) =>
      `Please set up a meeting "Partner onboarding" on ${onboardingDay(clock).long}, from 10:00 to 11:00 New York time: our partners are there. Then create a personal guest link for that meeting for each of these four people: ${ONBOARDING_GUESTS.map(([name, address]) => `${name} (${address})`).join(', ')}. alfaview must not email them: I will send the links myself. Give me the link of each person.`,
    checks: [
      stateCheck('Exactly one meeting is added', (outcome) => newMeetings(outcome).length === 1),
      stateCheck('The meeting has the title "Partner onboarding"', (outcome) =>
        newMeetings(outcome).some((meeting) => /^\s*partner onboarding\s*$/i.test(String(meeting.title))),
      ),
      stateCheck('It runs from 10:00 to 11:00 New York time', (outcome) => {
        const day = onboardingDay(outcome.clock);
        return newMeetings(outcome).some(
          (meeting) =>
            instantOf(meeting.start) === outcome.clock.at(day, '10:00', NEW_YORK) &&
            instantOf(meeting.end) === outcome.clock.at(day, '11:00', NEW_YORK),
        );
      }),
      stateCheck('Each of the four people gets exactly one guest link for the new meeting', (outcome) => {
        const [meeting] = newMeetings(outcome);
        return (
          meeting !== undefined &&
          ONBOARDING_ADDRESSES.every((address) => newLinksFor(outcome, address, String(meeting.id)).length === 1)
        );
      }),
      stateCheck(
        'Each link works during the meeting: it has no validity, or one that covers the meeting with at most two hours more',
        (outcome) => {
          const [meeting] = newMeetings(outcome);
          if (meeting === undefined) return false;
          const start = instantOf(meeting.start)!;
          const end = instantOf(meeting.end)!;
          return ONBOARDING_ADDRESSES.every((address) =>
            newLinksFor(outcome, address, String(meeting.id)).every((link) => {
              const from = instantOf(link.validFrom);
              const until = instantOf(link.validUntil);
              return (
                (from === undefined || (from <= start && from >= start - 2 * HOUR_MS)) &&
                (until === undefined || (until >= end && until <= end + 2 * HOUR_MS))
              );
            }),
          );
        },
      ),
      noEmail('Nobody gets an email: the person sends the links'),
      writesOnlyToNewMeetings('Nothing else changes: every write creates the meeting or goes to the new meeting'),
      noDeletes(),
      answerCheck('The answer gives the join URL of each new link', (answer, outcome) => {
        const [meeting] = newMeetings(outcome);
        return (
          meeting !== undefined &&
          ONBOARDING_ADDRESSES.every((address) =>
            newLinksFor(outcome, address, String(meeting.id)).some((link) => answer.includes(String(link.joinUrl))),
          )
        );
      }),
    ],
  },
  {
    id: 'hard-guests-thirty',
    level: 'standard',
    kind: 'write',
    intent: 'Create guest links for a list of 30 rows, more than one call takes, with one person twice in another case.',
    prompt: (clock) =>
      `Please create guest links for everyone on this registration list for our webinar "Grundlagen der Geldanlage" in the Webinar Room on ${clock.day(5).long}, from 18:00 to 19:30 Berlin time. They only watch, without camera or microphone. alfaview must not email them: we send our own mail. When you are done, tell me how many people got a link.\n\n${REGISTRATIONS.map(([name, address]) => `${name} <${address}>`).join('\n')}`,
    checks: [
      oneNewLinkEach('Each of the 29 people gets exactly one guest link in the Webinar Room, Lea Wagner too', WEBINAR_ROOM_ID, REGISTERED_ADDRESSES),
      stateCheck('No other guest link is added: 29 in all', ({ initial, state }) =>
        added(initial.guestLinks, state.guestLinks).length === REGISTERED_ADDRESSES.length,
      ),
      stateCheck('They only watch: every new link uses the permission group Spectator', ({ initial, state }) =>
        added(initial.guestLinks, state.guestLinks).every((link) => link.permissionGroupId === SPECTATOR_GROUP_ID),
      ),
      newLinksValid(
        'The links are valid for 18:00 to 19:30 Berlin time, with at most one hour of early access or overrun',
        WEBINAR_ROOM_ID,
        REGISTERED_ADDRESSES,
        (clock) => [clock.at(clock.day(5), '18:00'), clock.at(clock.day(5), '19:30')],
        HOUR_MS,
      ),
      noEmail('Nobody gets an email: the person sends their own mail'),
      writesOnlyUnder([`/v2/rooms/${WEBINAR_ROOM_ID}/guest-links`]),
      noDeletes(),
      answerHas('The answer says that 29 people got a link', TWENTY_NINE),
    ],
  },
  {
    id: 'hard-dst-guest-link',
    level: 'standard',
    kind: 'write',
    intent: 'Create a guest link in New York time on a day on which New York is five hours behind Berlin, and give the start in Berlin time.',
    prompt: (clock) =>
      `Ben has a video consultation with a client in New York, Daniel Brooks (daniel.brooks@example.com), on ${clock.day(shortGapDay(clock)).long}, from 09:00 to 10:00 New York time, in Ben's advisory room. Please create a guest link for Daniel for that time. Do not email him: I will send it. Give me the link, and tell me when the consultation starts in Berlin time, so that I can put it into Ben's calendar.`,
    checks: [
      oneNewLinkEach("Daniel gets one guest link in Ben's room", BEN_ROOM_ID, ['daniel.brooks@example.com']),
      newLinksValid(
        'The link is valid for 09:00 to 10:00 New York time, with at most 30 minutes of early access or overrun',
        BEN_ROOM_ID,
        ['daniel.brooks@example.com'],
        (clock) => {
          const day = clock.day(shortGapDay(clock));
          return [clock.at(day, '09:00', NEW_YORK), clock.at(day, '10:00', NEW_YORK)];
        },
        30 * MINUTE_MS,
      ),
      noEmail('Nobody gets an email: the person sends the link'),
      writesOnlyUnder([`/v2/rooms/${BEN_ROOM_ID}/guest-links`]),
      noDeletes(),
      answerGivesJoinUrls('The answer gives the join URL of the new link', BEN_ROOM_ID, ['daniel.brooks@example.com']),
      answerCheck(
        'The answer gives the start in Berlin time: five hours after 09:00 in New York, not six, and not the time in UTC',
        (answer, { clock }) => {
          const start = minutesOf(timeOf(clock.at(clock.day(shortGapDay(clock)), '09:00', NEW_YORK), EVAL_TIME_ZONE))!;
          const berlin = berlinTimesIn(answer);
          // One hour less is the start in UTC, or after a gap of four hours.
          return berlin.includes(start) && !berlin.includes(start - 60);
        },
      ),
    ],
  },
  {
    id: 'hard-retry-guest-links',
    level: 'standard',
    kind: 'write',
    intent: 'Create three guest links when alfaview saves the second one but answers 500, with no second link for anybody.',
    prompt: (clock) =>
      `Please create guest links for our three new partners for the onboarding session in the Team Room on ${clock.day(3).long}, from 09:30 to 11:00 Berlin time: ${PARTNER_GUESTS.map(([name, address]) => `${name} (${address})`).join(', ')}. Do not email them, and give me their links.`,
    faults: [{ method: 'POST', path: /^\/v2\/rooms\/[^/]+\/guest-links$/, nth: 2, status: 500, applied: true }],
    checks: [
      oneNewLinkEach('Each of the three partners gets exactly one guest link in the Team Room, also after the error', TEAM_ROOM_ID, PARTNER_ADDRESSES),
      newLinksValid(
        'The links are valid for 09:30 to 11:00 Berlin time, with at most one hour of early access or overrun',
        TEAM_ROOM_ID,
        PARTNER_ADDRESSES,
        (clock) => [clock.at(clock.day(3), '09:30'), clock.at(clock.day(3), '11:00')],
        HOUR_MS,
      ),
      noEmail('Nobody gets an email: the person sends the links'),
      writesOnlyUnder([`/v2/rooms/${TEAM_ROOM_ID}/guest-links`]),
      noDeletes(),
      answerGivesJoinUrls('The answer gives the join URL of each link', TEAM_ROOM_ID, PARTNER_ADDRESSES),
    ],
  },
  {
    id: 'hard-retry-meeting',
    level: 'standard',
    kind: 'write',
    intent: 'Schedule a meeting when alfaview saves it but answers 500: find it instead of a second create, and give its join URL.',
    prompt: (clock) =>
      `Schedule a meeting "Team retrospective" on ${clock.day(2).long}, from 16:00 to 17:00 Berlin time, and give me the join link for the participants.`,
    faults: [{ method: 'POST', path: /^\/v2\/meetings$/, status: 500, applied: true }],
    checks: [
      stateCheck('Exactly one meeting is added: no second create after the error', (outcome) => newMeetings(outcome).length === 1),
      stateCheck('It is "Team retrospective" from 16:00 to 17:00 Berlin time', (outcome) => {
        const day = outcome.clock.day(2);
        return newMeetings(outcome).some(
          (meeting) =>
            /^\s*team retrospective\s*$/i.test(String(meeting.title)) &&
            instantOf(meeting.start) === outcome.clock.at(day, '16:00') &&
            instantOf(meeting.end) === outcome.clock.at(day, '17:00'),
        );
      }),
      noEmail(),
      writesOnlyToNewMeetings('Nothing else changes: every write creates the meeting or changes the new meeting itself', {
        rooms: false,
      }),
      noDeletes(),
      answerCheck('The answer gives the participant join URL of the new meeting', (answer, outcome) => {
        const participant = outcome.state.permissionGroups.find((group) => group.name === 'Participant');
        return newMeetings(outcome).some((meeting) => {
          const url = meeting.groupLinks?.[participant?.id];
          return typeof url === 'string' && answer.includes(url);
        });
      }),
    ],
  },
  {
    id: 'hard-quiet-guest-removal',
    level: 'standard',
    kind: 'negative',
    intent: 'Refuse to remove the guest of a meeting quietly, because alfaview always emails her when her link goes.',
    prompt: () =>
      'Please take Sabine Roth off the Quarterly Review. She must not get any message from alfaview about it: I will call her myself.',
    seed: (state) => {
      const link = state.guestLinks.find((item) => item.id === MEETING_LINK_ID)!;
      link.emailAddress = SABINE_EMAIL;
      link.displayName = 'Sabine Roth';
    },
    checks: [
      noDeletes('Her link stays: alfaview always emails the guest when the link of a meeting is deleted'),
      noEmail('Nobody gets an email: the person forbids it'),
      writesOnlyUnder(
        [`/v2/guest-links/${MEETING_LINK_ID}`],
        'Nothing else changes: at most the link of Sabine, without an email',
      ),
      // Doing nothing keeps every state check true, so the answer must rest on a look at her link.
      answerCheck(
        'After a look at her link, the answer says why: alfaview emails her when her link is deleted',
        (answer, { requests }) =>
          readsAny(requests, [`/v2/rooms/${MEETING_ID}/guest-links`, '/v2/guest-links', `/v2/guest-links/${MEETING_LINK_ID}`]) &&
          EMAIL_ON_REMOVAL.test(answer),
      ),
    ],
  },

  // Hard tasks at manage
  {
    id: 'hard-vague-room',
    level: 'manage',
    kind: 'negative',
    intent: 'Ask which room is meant when a name fits two rooms, and change nothing.',
    prompt: () => 'Please allow local recording in the advisory room.',
    checks: [
      noWrites('Nothing changes: two rooms are advisory rooms'),
      unchanged('The features of both advisory rooms stay', (state) =>
        [ADVISOR_ROOM_ID, BEN_ROOM_ID].map((id) => roomOf(state, id)?.features ?? null),
      ),
      answerCheck(
        'After a look at the rooms, the answer asks which room is meant, or names both advisory rooms',
        (answer, { requests }) => readsAny(requests, ['/v2/rooms']) && asksOrLists(answer, [ANNA_ROOM_NAME, BEN_ROOM_NAME]),
      ),
    ],
  },
  {
    id: 'hard-unsupported-language',
    level: 'manage',
    kind: 'negative',
    intent: 'Explain that alfaview does not transcribe a language, name the languages that it offers, and change nothing.',
    prompt: () => 'Our trainers in the Team Room speak Polish. Please turn on the live transcription there.',
    checks: [
      // A write that alfaview refuses changes nothing, so only a saved write fails.
      stateCheck('Nothing is saved: alfaview does not transcribe Polish', ({ requests }) =>
        writesOf(requests).every((request) => !savedOf(request)),
      ),
      unchanged('The language settings of the Team Room stay', (state) => state.languageSettings.get(TEAM_ROOM_ID) ?? null),
      answerCheck('The answer says that alfaview does not offer Polish', (answer) =>
        /polish|\bpl(?:-PL)?\b/i.test(answer) && NOT_OFFERED.test(answer),
      ),
      // English, German and French are easy to guess, so the names must rest on the list that
      // alfaview gives.
      answerCheck('After a look at the offered languages, the answer names at least three of them', (answer, { requests }) =>
        readsAny(requests, ['/v2/languages']) && OFFERED_LANGUAGES.filter((language) => language.test(answer)).length >= 3,
      ),
    ],
  },
  {
    id: 'hard-breakout-groups',
    level: 'manage',
    kind: 'write',
    intent: 'Add five named breakout rooms and remove the unnamed one, when alfaview answers one create with 429.',
    prompt: () =>
      `For the workshop tomorrow in the Team Room, I need the breakout rooms ${WORKSHOP_GROUPS.slice(0, -1).map((name) => `"${name}"`).join(', ')} and "${WORKSHOP_GROUPS.at(-1)}". Please add them, and remove the breakout room that has no name.`,
    faults: [{ method: 'POST', path: /^\/v2\/rooms\/[^/]+\/subrooms$/, nth: 3, status: 429 }],
    checks: [
      stateCheck('The Team Room has each of "Group 1" to "Group 5" exactly once, also after the error', ({ state }) => {
        const names = (roomOf(state, TEAM_ROOM_ID)?.subrooms ?? []).map((subroom: Json) =>
          String(subroom.displayName ?? '').trim(),
        );
        return WORKSHOP_GROUPS.every((group) => names.filter((name: string) => name === group).length === 1);
      }),
      stateCheck('No breakout room of the Team Room is without a name', ({ state }) =>
        (roomOf(state, TEAM_ROOM_ID)?.subrooms ?? []).every(
          (subroom: Json) => typeof subroom.displayName === 'string' && subroom.displayName.trim() !== '',
        ),
      ),
      unchanged('"Group B" and "Group C" stay as they are', (state) =>
        (roomOf(state, TEAM_ROOM_ID)?.subrooms ?? []).filter((subroom: Json) => /^Group [BC]$/.test(subroom.displayName)),
      ),
      stateCheck('The Team Room has 7 breakout rooms', ({ state }) => (roomOf(state, TEAM_ROOM_ID)?.subrooms ?? []).length === 7),
      writesOnlyUnder([`/v2/rooms/${TEAM_ROOM_ID}/subrooms`]),
    ],
  },

  // Hard tasks at full
  {
    id: 'hard-delete-declined',
    level: 'full',
    kind: 'negative',
    intent: 'Keep a room when the person says no to the question of the server before the delete.',
    prompt: () => 'Delete the Webinar Room for good: we no longer hold webinars.',
    // No rules: the person says no to every question of the server. A server that deletes without a
    // question to the person fails, because only the answer of the model confirms the delete. A
    // run without a delete passes only when the server asked the person: a question of the model in
    // its final text, or a refusal, is no question of the server.
    checks: [
      noDeletes('Nothing is deleted: the person said no when the server asked'),
      unchanged('Every room stays', (state) => state.rooms.map((room) => room.id)),
      questionCheck('The server asks the person before the delete, names the Webinar Room, and the person says no', (elicitations) =>
        elicitations.some((entry) => {
          const asked = `${entry.message}\n${JSON.stringify(entry.requestedSchema ?? {})}`.toLowerCase();
          return entry.action === 'decline' && (asked.includes('webinar room') || asked.includes(WEBINAR_ROOM_ID));
        }),
      ),
      answerHas('The answer says that the room is not deleted, or asks the person', DELETE_NOT_DONE),
    ],
  },
];

/**
 * Returns the tasks whose ID or level is in `filter`, or all tasks for an empty filter. Throws for
 * an unknown task or level.
 */
export function selectTasks(filter: readonly string[]): Task[] {
  if (filter.length === 0) return [...TASKS];
  const unknown = filter.filter((item) => !TASKS.some((task) => task.id === item || task.level === item));
  if (unknown.length > 0) throw new Error(`unknown task or level: ${unknown.join(', ')}`);
  return TASKS.filter((task) => filter.includes(task.id) || filter.includes(task.level));
}
