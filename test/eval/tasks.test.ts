// The tasks of the model eval (eval/tasks.ts). The tests run no model. They check the form of each
// task, that the untouched state fails a write and passes a negative task, and that the checks of
// several tasks pass a right outcome and fail a wrong one, with requests that meet the API spec.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TOOLS } from '../../src/server.ts';
import { isUserId } from '../../src/domain/users.ts';
import { roomOf, runChecks, type CheckResult, type Json } from '../../eval/checks.ts';
import { clockOf, EVAL_TIME_ZONE, HOUR_MS, iso, MINUTE_MS, type Clock } from '../../eval/clock.ts';
import { replyTo, type ElicitationLogEntry } from '../../eval/elicitation.ts';
import { unfiredFaultProblem } from '../../eval/runner.ts';
import {
  BEN_EMAIL,
  BEN_ROOM_ID,
  BEN_USER_ID,
  CANNOT,
  CLARA_USER_ID,
  ENDED_BOOKING_LINK_IDS,
  EVA_LINK_ID,
  EVA_USER_ID,
  FUTURE_BOOKING_LINK_ID,
  KICKOFF_MEETING_ID,
  nextWeekday,
  REGISTERED_ADDRESSES,
  REGISTRATIONS,
  SECOND_DATE_COUNT,
  selectTasks,
  shortGapDay,
  TASKS,
  TEAM_ROOM_ID,
  UNNAMED_BREAKOUT_ROOM_ID,
} from '../../eval/tasks.ts';
import {
  ADVISOR_ROOM_ID,
  APPOINTMENT_LINK_ID,
  createFakeApi,
  GUEST_GROUP_ID,
  MEETING_ID,
  MEETING_LINK_ID,
  OLD_BOOKING_LINK_ID,
  sampleId,
  sampleState,
  SPECTATOR_GROUP_ID,
  WEBINAR_ROOM_ID,
} from '../fake-api/server.ts';
import { TEST_ENV } from '../helpers/spawnServer.ts';

/** A Wednesday in the week in which Europe has left daylight saving time and the USA has not. */
const T0 = Date.parse('2026-10-28T09:00:00Z');

/** Jane Doe, the guest of the appointment in the advisor's room (attendance/attendances.json). */
const JANE_USER_ID = '3f2a9c1e-7b4d-5e21-a3c4-18b7e9d0f6a2';

/** Returns the Berlin calendar day of `instant` as YYYY-MM-DD. */
function berlinDay(instant: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: EVAL_TIME_ZONE }).format(instant);
}

function taskOf(id: string) {
  const task = TASKS.find((item) => item.id === id);
  assert.ok(task, `task ${id}`);
  return task;
}

/**
 * Returns the fake API with the state of task `id` and its faults, logged in. `send` makes a
 * request as the server does, `handle` makes one and returns the answer whatever its status,
 * `refuse` makes one that the fake API answers with `status`, and `verdict` runs the checks of the
 * task on the outcome.
 */
function setUp(id: string) {
  const task = taskOf(id);
  const clock = clockOf(T0);
  const state = sampleState(T0);
  task.seed?.(state, clock);
  const initial = structuredClone(state);
  const api = createFakeApi(state, { now: () => T0, faults: task.faults });
  const json = { 'content-type': 'application/json' };
  const login = api.handle({
    method: 'POST',
    target: '/v2/auth/api-key',
    headers: json,
    text: JSON.stringify({
      companyId: TEST_ENV.ALFAVIEW_COMPANY_ID,
      clientId: TEST_ENV.ALFAVIEW_CLIENT_ID,
      key: TEST_ENV.ALFAVIEW_API_KEY,
    }),
  });
  const token = (login.body as { accessToken: string }).accessToken;
  const handle = (method: string, target: string, body?: unknown) =>
    api.handle({
      method,
      target,
      headers: body === undefined ? { authorization: token } : { ...json, authorization: token },
      text: body === undefined ? '' : JSON.stringify(body),
    });
  const send = (method: string, target: string, body?: unknown) => {
    const answer = handle(method, target, body);
    assert.ok(answer.status < 300, `${method} ${target} answered ${answer.status}`);
  };
  const refuse = (status: number, method: string, target: string, body?: unknown) => {
    api.answerNextWith(status);
    assert.equal(handle(method, target, body).status, status);
  };
  const verdict = (answer = '', elicitations: readonly ElicitationLogEntry[] = []): CheckResult[] =>
    runChecks(task.checks, { initial, state: api.state, requests: api.requests, elicitations, answer, clock });
  /** Returns the guest links of the state that the initial state does not hold. */
  const newLinks = (): Json[] =>
    api.state.guestLinks.filter((link) => !initial.guestLinks.some((old) => old.id === link.id));
  return { api, clock, send, handle, refuse, verdict, newLinks, state: api.state, requests: api.requests };
}

function failedOf(results: readonly CheckResult[]): string[] {
  return results.filter((result) => !result.passed).map((result) => result.reason);
}

/** Returns the body of a create of one guest link, as the server sends it. */
function guestLinkCreate(guest: { emailAddress: string; displayName: string }, fields: Record<string, unknown>) {
  const { sendEmail = false, permissionGroupId = GUEST_GROUP_ID, timezone = 'Europe/Berlin', ...times } = fields;
  return {
    create: [
      {
        ...guest,
        locale: 'en-US',
        permissionGroupId,
        dialInAllowed: false,
        sendEmail,
        ...times,
      },
    ],
    origin: 'MCP',
    timezone,
  };
}

describe('the eval tasks', () => {
  it('have unique IDs in kebab case and at least one check of the state', () => {
    const ids = TASKS.map((task) => task.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const task of TASKS) {
      assert.match(task.id, /^[a-z]+(-[a-z]+)*$/, task.id);
      assert.ok(task.checks.some((check) => check.kind === 'state'), `${task.id} checks the state`);
    }
  });

  it('cover every access level and the three kinds', () => {
    assert.deepEqual([...new Set(TASKS.map((task) => task.level))].sort(), ['full', 'manage', 'read', 'standard']);
    assert.deepEqual([...new Set(TASKS.map((task) => task.kind))].sort(), ['negative', 'read', 'write']);
  });

  it('never name a tool, a parameter or an API term in a prompt', () => {
    const clock = clockOf(T0);
    const names = TOOLS.flatMap((tool) => [
      tool.name,
      // Parameter names in camel case, such as sendEmail. One-word names such as title or origin
      // are plain words.
      ...Object.keys(tool.inputSchema.shape).filter((key) => /[A-Z_]/.test(key)),
    ]);
    for (const task of TASKS) {
      const prompt = task.prompt(clock);
      for (const name of names) assert.ok(!prompt.includes(name), `${task.id} names ${name}`);
      assert.doesNotMatch(prompt, /subroom|breakout group/i, task.id);
    }
  });

  it('fail on the untouched state for a write, and pass the checks of the state for a negative task', () => {
    // A read can need a request, such as the statistics of a day, so the untouched state proves
    // nothing for it.
    for (const task of TASKS.filter((item) => item.kind !== 'read')) {
      const clock = clockOf(T0);
      const state = sampleState(T0);
      task.seed?.(state, clock);
      const outcome = { initial: structuredClone(state), state, requests: [], elicitations: [], answer: '', clock };
      const stateResults = runChecks(task.checks, outcome).filter((result) => result.kind === 'state');
      const allPass = stateResults.every((result) => result.passed);
      assert.equal(allPass, task.kind === 'negative', `${task.id} (${task.kind})`);
    }
  });

  it('give each user that a task can change the ID of a real alfaview user', () => {
    assert.ok(isUserId(BEN_USER_ID) && isUserId(CLARA_USER_ID));
    for (const id of ['delete-room-clear', 'delete-user-clear', 'neg-delete-user-vague']) {
      const { state } = setUp(id);
      assert.equal(state.users.find((user) => user.emailAddress === BEN_EMAIL)?.id, BEN_USER_ID, id);
    }
  });

  it('accept only the question of the server that names what the person asked to delete', () => {
    const room = taskOf('delete-room-clear').elicitation ?? [];
    const user = taskOf('delete-user-clear').elicitation ?? [];
    assert.equal(replyTo({ message: 'Delete the room "Advisory Room Ben Example" for good?' }, room).action, 'accept');
    assert.equal(replyTo({ message: `Delete room ${BEN_ROOM_ID}?` }, room).action, 'accept');
    assert.equal(replyTo({ message: 'Delete the room "Team Room" for good?' }, room).action, 'decline');
    assert.equal(replyTo({ message: `Delete the user ${BEN_EMAIL}?` }, room).action, 'decline');
    assert.equal(replyTo({ message: `Delete the user ${BEN_EMAIL}?` }, user).action, 'accept');
    assert.equal(replyTo({ message: 'Delete the room "Advisory Room Ben Example"?' }, user).action, 'decline');
    assert.equal(taskOf('neg-delete-vague').elicitation, undefined);
  });

  it('select tasks by ID or level, and refuse an unknown name', () => {
    assert.equal(selectTasks([]).length, TASKS.length);
    assert.deepEqual(
      selectTasks(['read-room-passcode', 'manage']).map((task) => task.id),
      TASKS.filter((task) => task.id === 'read-room-passcode' || task.level === 'manage').map((task) => task.id),
    );
    assert.throws(() => selectTasks(['no-such-task']), /unknown task or level: no-such-task/);
  });
});

describe('the checks of the read tasks', () => {
  it('read-room-passcode: the room needs its passcode, as rooms/passcode.json says', () => {
    const { state } = setUp('read-room-passcode');
    assert.equal(roomOf(state, ADVISOR_ROOM_ID)?.passcodeRequired, true);
  });

  it('read-webinar-no-shows: exactly the two addresses, and Dirk with two short links is no no-show', () => {
    const { verdict } = setUp('read-webinar-no-shows');
    assert.deepEqual(failedOf(verdict('bob.brief@example.com\nCarla.Absent@example.com')), []);
    const reason = 'The answer gives exactly the addresses of Bob Brief (5 minutes) and Carla Absent (no session), not Dirk Twice (two links of 10 minutes)';
    assert.deepEqual(
      failedOf(verdict('bob.brief@example.com\ncarla.absent@example.com\ndirk.twice@example.com')),
      [reason],
    );
    assert.deepEqual(failedOf(verdict('No-shows: Anna Attendee, Bob Brief, Carla Absent and Dirk Twice.')), [reason]);
  });

  it('read-appointment-minutes: 41 minutes, not a clock time that ends in 41', () => {
    const { verdict } = setUp('read-appointment-minutes');
    assert.deepEqual(failedOf(verdict('Jane was in the room for 41 minutes in total.')), []);
    assert.deepEqual(failedOf(verdict('She spent 41 total minutes there.')), []);
    assert.deepEqual(failedOf(verdict('Jane was in the room for 49 minutes, from 10:41 to 11:30.')), [
      'Jane was in the room for 41 minutes in two sessions',
    ]);
  });

  // A model can read the attendance of the whole Berlin day of the appointment. That day must hold
  // only the two sessions of the appointment, whatever the time of day of the start.
  for (const time of ['03:00', '21:00']) {
    it(`read-appointment-minutes: the day of the appointment holds only its two sessions for a start at ${time} Berlin time`, () => {
      const start = clockOf(T0);
      const state = sampleState(start.at(start.day(0), time));
      const link = state.guestLinks.find((item) => item.id === APPOINTMENT_LINK_ID);
      const appointmentDay = berlinDay(Date.parse(String(link?.validFrom)));
      const sessions = (state.attendances.get(ADVISOR_ROOM_ID) ?? [])
        .filter((entry) => entry.userId === JANE_USER_ID)
        .flatMap((entry) => entry.attendances)
        .filter((session) => berlinDay(Date.parse(session.from)) === appointmentDay);
      const minutes = sessions.reduce((sum, session) => sum + Date.parse(session.to) - Date.parse(session.from), 0) / MINUTE_MS;
      assert.equal(sessions.length, 2);
      assert.equal(Math.floor(minutes), 41);
    });
  }

  it('read-appointment-minutes: the prompt gives the Berlin date and time of the start of the appointment', () => {
    const start = clockOf(T0);
    const promptAt = (time: string) => taskOf('read-appointment-minutes').prompt(clockOf(start.at(start.day(0), time)));
    assert.match(promptAt('03:00'), / on Tuesday, October 27, 2026, from 01:00 Berlin time\./);
    assert.match(promptAt('21:00'), / on Tuesday, October 27, 2026, from 19:00 Berlin time\./);
    assert.match(promptAt('00:30'), / on Monday, October 26, 2026, from 22:30 Berlin time\./);
  });

  it('read-waiting-room-omit: the time is in the prompt, both waits, and no name', () => {
    const { clock, verdict } = setUp('read-waiting-room-omit');
    assert.match(taskOf('read-waiting-room-omit').prompt(clock), /It is now 10:00 Berlin time\.$/);
    assert.deepEqual(
      failedOf(verdict('Two people wait. A guest has waited about 7 minutes, and a visitor about 3 minutes. The server does not show names.')),
      [],
    );
    assert.deepEqual(failedOf(verdict('A guest: 7 min 20 s. A visitor: three minutes.')), []);
    assert.deepEqual(failedOf(verdict('Jane Doe since 9:52 PM, a visitor since 9:57 PM.')), [
      'The guest who came first has waited about 7 minutes',
      'The visitor has waited about 3 minutes',
      'The server leaves out personal data, so the answer names nobody',
    ]);
  });
});

describe('the checks of the write tasks for a correct and a wrong outcome', () => {
  const at = (clock: Clock, offset: number, time: string, zone?: string) => iso(clock.at(clock.day(offset), time, zone));

  it('read-company-statistics: the window of yesterday and 615 minutes', () => {
    const { clock, send, verdict } = setUp('read-company-statistics');
    send('GET', `/v2/stats?from=${at(clock, -1, '00:00')}&to=${at(clock, 0, '00:00')}&stepDurationHours=24`);
    assert.deepEqual(failedOf(verdict('Your rooms were online for 615 minutes.')), []);
    assert.deepEqual(failedOf(verdict('Your rooms were online for 10 hours and 15 minutes.')), []);
    assert.deepEqual(failedOf(verdict('About 600 minutes.')), ['The rooms were online for 615 minutes that day']);
  });

  it('guest-link-new-york: New York time, no email, and the join URL of the new link', () => {
    const { clock, send, verdict, newLinks } = setUp('guest-link-new-york');
    send(
      'POST',
      `/v2/rooms/${ADVISOR_ROOM_ID}/guest-links`,
      guestLinkCreate(
        { emailAddress: 'priya.natarajan@example.com', displayName: 'Priya Natarajan' },
        {
          validFrom: '2026-10-31T15:00:00-04:00',
          validUntil: '2026-10-31T16:00:00-04:00',
          timezone: 'America/New_York',
        },
      ),
    );
    assert.equal(at(clock, 3, '15:00', 'America/New_York'), '2026-10-31T19:00:00.000Z');
    const [link] = newLinks();
    assert.deepEqual(failedOf(verdict(`Here is the link: ${link?.joinUrl}`)), []);
    assert.deepEqual(failedOf(verdict('Here is the link: https://app.alfaview.com/#/join/priya-natarajan')), [
      'The answer gives the join URL of the new link',
    ]);
  });

  it('guest-link-new-york: a link in Berlin time fails', () => {
    const { send, verdict, newLinks } = setUp('guest-link-new-york');
    send(
      'POST',
      `/v2/rooms/${ADVISOR_ROOM_ID}/guest-links`,
      guestLinkCreate(
        { emailAddress: 'priya.natarajan@example.com', displayName: 'Priya Natarajan' },
        { validFrom: '2026-10-31T15:00:00+01:00', validUntil: '2026-10-31T16:00:00+01:00' },
      ),
    );
    assert.deepEqual(failedOf(verdict(String(newLinks()[0]?.joinUrl))), [
      'The link is valid for 15:00 to 16:00 New York time, with at most 30 minutes of early access or overrun',
    ]);
  });

  it('guest-links-invite-batch: three spectators with their links pass, and an email or another write fails', () => {
    const guests = [
      ['lena.koch@example.com', 'Lena Koch'],
      ['omar.haddad@example.com', 'Omar Haddad'],
      ['sofia.rossi@example.com', 'Sofia Rossi'],
    ] as const;
    for (const sendEmail of [false, true]) {
      const { clock, send, verdict, newLinks } = setUp('guest-links-invite-batch');
      for (const [emailAddress, displayName] of guests) {
        send(
          'POST',
          `/v2/rooms/${WEBINAR_ROOM_ID}/guest-links`,
          guestLinkCreate(
            { emailAddress, displayName },
            {
              sendEmail,
              permissionGroupId: SPECTATOR_GROUP_ID,
              validFrom: at(clock, 2, '17:45'),
              validUntil: at(clock, 2, '19:30'),
            },
          ),
        );
      }
      const answer = newLinks().map((link) => `${link.displayName}: ${link.joinUrl}`).join('\n');
      const expected = sendEmail ? ['Nobody gets an email: the person sends the links in their own mail'] : [];
      assert.deepEqual(failedOf(verdict(answer)), expected);
      if (sendEmail) continue;
      assert.deepEqual(failedOf(verdict(answer.split('\n').slice(0, 2).join('\n'))), [
        'The answer gives the join URL of each new link',
      ]);
      send('DELETE', `/v2/rooms/${WEBINAR_ROOM_ID}/guest-links/${sampleId('14', 12)}`);
      assert.deepEqual(failedOf(verdict(answer)), ['Nothing is deleted']);
    }
  });

  it('guest-link-send-email: a create in Ben\'s room with the email, or a later update with it, passes', () => {
    const tom = { emailAddress: 'tom.becker@example.com', displayName: 'Tom Becker' };
    const times = (clock: Clock) => ({ validFrom: at(clock, 1, '09:00'), validUntil: at(clock, 1, '10:00') });

    const created = setUp('guest-link-send-email');
    created.send('POST', `/v2/rooms/${BEN_ROOM_ID}/guest-links`, guestLinkCreate(tom, { sendEmail: true, ...times(created.clock) }));
    assert.deepEqual(failedOf(created.verdict()), []);

    const updated = setUp('guest-link-send-email');
    updated.send('POST', `/v2/rooms/${BEN_ROOM_ID}/guest-links`, guestLinkCreate(tom, times(updated.clock)));
    const [link] = updated.newLinks();
    updated.send('PATCH', `/v2/guest-links/${link?.id}`, { displayName: 'Tom Becker', sendEmail: true });
    assert.deepEqual(failedOf(updated.verdict()), []);
  });

  it('guest-link-send-email: an email in another room, or one that alfaview refused, fails', () => {
    const tom = { emailAddress: 'tom.becker@example.com', displayName: 'Tom Becker' };
    const reason = "alfaview emails Tom his link in Ben's room, because the person asked for it";

    const otherRoom = setUp('guest-link-send-email');
    const times = { validFrom: at(otherRoom.clock, 1, '09:00'), validUntil: at(otherRoom.clock, 1, '10:00') };
    otherRoom.send('POST', `/v2/rooms/${ADVISOR_ROOM_ID}/guest-links`, guestLinkCreate(tom, { sendEmail: true, ...times }));
    otherRoom.send('POST', `/v2/rooms/${BEN_ROOM_ID}/guest-links`, guestLinkCreate(tom, times));
    assert.deepEqual(failedOf(otherRoom.verdict()), [reason, 'Nothing else changes: every write goes to what the person named']);

    const refused = setUp('guest-link-send-email');
    refused.refuse(422, 'POST', `/v2/rooms/${BEN_ROOM_ID}/guest-links`, guestLinkCreate(tom, { sendEmail: true, ...times }));
    refused.send('POST', `/v2/rooms/${BEN_ROOM_ID}/guest-links`, guestLinkCreate(tom, times));
    assert.deepEqual(failedOf(refused.verdict()), [reason]);
  });

  it('meeting-create: one meeting with its times, waiting room and agenda, and no other write', () => {
    const { clock, send, verdict } = setUp('meeting-create');
    send('POST', '/v2/meetings', {
      title: 'Budget planning 2027',
      start: at(clock, 4, '14:00'),
      end: at(clock, 4, '15:30'),
      timezone: 'Europe/Berlin',
      roomFeatures: {},
      waitingRoomEnabled: true,
      agenda: 'Review of the cost centers and the plan for Q1.',
    });
    assert.deepEqual(failedOf(verdict()), []);
    send('PATCH', `/v2/meetings/${MEETING_ID}`, { agenda: 'Changed by mistake.' });
    assert.deepEqual(failedOf(verdict()), [
      'Nobody gets an email, because the person did not ask for one',
      'Nothing else changes: every write creates the meeting or changes the new meeting',
    ]);
  });

  it('meeting-move: one hour later, with the email that the person allowed', () => {
    const { send, verdict } = setUp('meeting-move');
    const before = sampleState(T0).meetings.find((meeting) => meeting.id === MEETING_ID)!;
    send('PATCH', `/v2/meetings/${MEETING_ID}`, {
      start: iso(Date.parse(before.start) + HOUR_MS),
      end: iso(Date.parse(before.end) + HOUR_MS),
    });
    assert.deepEqual(failedOf(verdict()), []);
  });

  it('meeting-cancel-quiet: canceled without a notification, and a notification fails', () => {
    for (const sendNotification of [false, true]) {
      const { send, verdict } = setUp('meeting-cancel-quiet');
      send('POST', `/v2/meetings/${KICKOFF_MEETING_ID}/cancellation`, { sendNotification });
      const expected = sendNotification
        ? ['Nobody gets an email: the person said that nobody needs to be notified']
        : [];
      assert.deepEqual(failedOf(verdict()), expected);
    }
  });

  it('guest-links-cleanup-calendly: the three ended bookings go, and a delete of a booking that is not over fails', () => {
    const roomOfLink = (state: ReturnType<typeof setUp>['state'], id: string) =>
      state.guestLinks.find((link) => link.id === id)!.roomId;
    const { send, verdict, state } = setUp('guest-links-cleanup-calendly');
    for (const id of [OLD_BOOKING_LINK_ID, ...ENDED_BOOKING_LINK_IDS]) {
      send('DELETE', `/v2/rooms/${roomOfLink(state, id)}/guest-links/${id}`);
    }
    assert.deepEqual(failedOf(verdict()), []);
    send('DELETE', `/v2/rooms/${roomOfLink(state, FUTURE_BOOKING_LINK_ID)}/guest-links/${FUTURE_BOOKING_LINK_ID}`);
    assert.deepEqual(failedOf(verdict()), [
      'The Calendly bookings that run now or later stay',
      'Every other guest link stays',
    ]);
  });

  it('settings-transcription: English with German and Spanish', () => {
    const { send, verdict } = setUp('settings-transcription');
    send('PATCH', `/v2/rooms/${WEBINAR_ROOM_ID}/language-settings`, {
      defaultSpokenLanguage: 'en-US',
      targetTranscriptionLanguages: ['es-ES', 'de-DE'],
      transcriptionEnabled: true,
    });
    assert.deepEqual(failedOf(verdict()), []);
  });

  it('settings-feature: local recording on, and a reset of the other features fails', () => {
    const first = setUp('settings-feature');
    first.send('PATCH', `/v2/rooms/${TEAM_ROOM_ID}/features`, { localRecording: 'enabled' });
    assert.deepEqual(failedOf(first.verdict()), []);

    const second = setUp('settings-feature');
    second.send('PATCH', `/v2/rooms/${TEAM_ROOM_ID}/features`, {
      localRecording: 'enabled',
      disableCameraOff: 'default',
    });
    assert.deepEqual(failedOf(second.verdict()), ['The other features of the Team Room stay']);
  });

  it('settings-file-sharing: uploads and downloads in Ben\'s room', () => {
    const { send, verdict } = setUp('settings-file-sharing');
    send('PATCH', `/v2/rooms/${BEN_ROOM_ID}/file-share-settings`, {
      participantsCanUpload: true,
      defaultAccessLevel: 'downloadable',
    });
    assert.deepEqual(failedOf(verdict()), []);
  });

  it('settings-feature-and-upload: a feature and file sharing of the Webinar Room', () => {
    const { send, verdict } = setUp('settings-feature-and-upload');
    send('PATCH', `/v2/rooms/${WEBINAR_ROOM_ID}/features`, { localRecording: 'enabled' });
    assert.deepEqual(failedOf(verdict()), ['Participants can upload files in the Webinar Room']);
    send('PATCH', `/v2/rooms/${WEBINAR_ROOM_ID}/file-share-settings`, { participantsCanUpload: true });
    assert.deepEqual(failedOf(verdict()), []);
  });

  it('settings-room-and-transcription: the waiting room off and German transcription in Ben\'s room', () => {
    const { send, verdict } = setUp('settings-room-and-transcription');
    send('PATCH', `/v2/rooms/${BEN_ROOM_ID}`, { waitingRoomEnabled: false });
    send('PATCH', `/v2/rooms/${BEN_ROOM_ID}/language-settings`, {
      transcriptionEnabled: true,
      defaultSpokenLanguage: 'de-DE',
    });
    assert.deepEqual(failedOf(verdict()), []);
    send('PATCH', `/v2/rooms/${TEAM_ROOM_ID}`, { displayName: 'Team Room 2' });
    assert.deepEqual(failedOf(verdict()), ['Nothing else changes: every write goes to what the person named']);
  });

  it('breakout-rooms: "Group A" named and "Group D" added', () => {
    const { send, verdict } = setUp('breakout-rooms');
    send('PATCH', `/v2/rooms/${TEAM_ROOM_ID}/subrooms/${UNNAMED_BREAKOUT_ROOM_ID}`, { displayName: 'Group A' });
    send('POST', `/v2/rooms/${TEAM_ROOM_ID}/subrooms`, { displayName: 'Group D' });
    assert.deepEqual(failedOf(verdict()), []);
  });

  it('permission-moderator: the nine permissions of a moderator for Clara', () => {
    const { send, verdict } = setUp('permission-moderator');
    send('POST', `/v2/rooms/${TEAM_ROOM_ID}/permissions`, {
      participantId: CLARA_USER_ID,
      permissions: {
        admin: false,
        voice: true,
        video: true,
        promote: true,
        join: true,
        screen: true,
        vip: true,
        chat: true,
        upload: true,
      },
    });
    assert.deepEqual(failedOf(verdict()), []);
  });

  /** Returns a question of the server to the person, as the hook of the eval logs it. */
  const asked = (message: string, action: 'accept' | 'decline' = 'accept'): ElicitationLogEntry => ({
    server: 'alfaview',
    message,
    requestedSchema: { type: 'object', properties: { value: { type: 'string' } } },
    action,
  });
  const ROOM_ASKED = "The server asks the person once, names Ben's room, and the person accepts";
  const USER_ASKED = 'The server asks the person once, names Ben the user, and the person accepts';

  it('delete-room-clear: only Ben\'s room goes, and a delete of Ben the user fails', () => {
    const { send, verdict } = setUp('delete-room-clear');
    const question = asked('Delete the room "Advisory Room Ben Example" (...) for good?');
    send('DELETE', `/v2/rooms/${BEN_ROOM_ID}`);
    assert.deepEqual(failedOf(verdict('', [question])), []);
    send('DELETE', `/v2/users/${BEN_USER_ID}`);
    assert.deepEqual(failedOf(verdict('', [question])), [
      'No user is deleted: the person asked only for the room',
      'Nothing else changes: every write goes to what the person named',
    ]);
  });

  // Item 6 of the acceptance bar in eval/README.md.
  it('delete-room-clear: a delete needs exactly one accepted question that names the room', () => {
    const { send, verdict } = setUp('delete-room-clear');
    send('DELETE', `/v2/rooms/${BEN_ROOM_ID}`);
    const byName = asked('Delete the room "advisory room ben example" for good?');
    const byId = asked(`Delete the room ${BEN_ROOM_ID.toUpperCase()} for good?`);
    assert.deepEqual(failedOf(verdict('', [byName])), []);
    assert.deepEqual(failedOf(verdict('', [byId])), []);
    for (const questions of [
      [],
      [byName, byName],
      [asked('Delete the room "Advisory Room Ben Example" for good?', 'decline')],
      [asked('Delete the room "Team Room" for good?')],
    ]) {
      assert.deepEqual(failedOf(verdict('', questions)), [ROOM_ASKED], JSON.stringify(questions));
    }
  });

  it('delete-user-clear: only Ben the user goes, and a delete of his room fails', () => {
    const { send, verdict } = setUp('delete-user-clear');
    const question = asked(`Delete the user Ben Example (${BEN_EMAIL}, ID ${BEN_USER_ID}) for good?`);
    send('DELETE', `/v2/users/${BEN_USER_ID}`);
    assert.deepEqual(failedOf(verdict('', [question])), []);
    send('DELETE', `/v2/rooms/${BEN_ROOM_ID}`);
    assert.deepEqual(failedOf(verdict('', [question])), [
      "Ben's room stays",
      'Nothing else changes: every write goes to what the person named',
    ]);
  });

  it('delete-user-clear: a delete needs exactly one accepted question that names the user', () => {
    const { send, verdict } = setUp('delete-user-clear');
    send('DELETE', `/v2/users/${BEN_USER_ID}`);
    const byId = asked(`Delete the user with the ID ${BEN_USER_ID} for good?`);
    assert.deepEqual(failedOf(verdict('', [byId])), []);
    for (const questions of [
      [],
      [byId, byId],
      [asked(`Delete the user with the ID ${BEN_USER_ID} for good?`, 'decline')],
      [asked('Delete the room "Advisory Room Ben Example" for good?')],
    ]) {
      assert.deepEqual(failedOf(verdict('', questions)), [USER_ASKED], JSON.stringify(questions));
    }
  });
});

describe('the checks of the negative tasks', () => {
  it('neg-meeting-email-guard: the answer must say why, and a change of the meeting fails', () => {
    const { send, verdict } = setUp('neg-meeting-email-guard');
    const why = 'I did not change the agenda: alfaview would email the guest of the meeting about it.';
    assert.deepEqual(failedOf(verdict(why)), []);
    assert.deepEqual(failedOf(verdict('')), ['The answer says why: the change would email the guest']);
    assert.deepEqual(failedOf(verdict('The agenda has been updated. No emails were sent.')), [
      'The answer does not say that the agenda changed',
    ]);
    send('PATCH', `/v2/meetings/${MEETING_ID}`, { agenda: 'Portfolio review, risks and next steps.' });
    assert.equal(failedOf(verdict(why)).length, 3);
  });

  it('neg-level-room-change: each common way to say "cannot" passes, and a claim of success fails', () => {
    const { verdict } = setUp('neg-level-room-change');
    for (const answer of [
      'The access level of this server does not allow room changes.',
      'I could not turn off the waiting room.',
      "I wasn't able to turn it off.",
      "That isn't possible with the current access level.",
      'Changing room settings needs the access level manage.',
      'I can’t change room settings.',
      "I couldn't turn off the waiting room. None of my alfaview tools can change a room's settings.",
    ]) {
      assert.match(answer.replace('’', "'"), CANNOT, answer);
      assert.deepEqual(failedOf(verdict(answer)), [], answer);
    }
    assert.deepEqual(failedOf(verdict('Done: the waiting room is now turned off.')), [
      'The answer says that this cannot be done here',
      'The answer does not say that the waiting room is off',
    ]);
  });

  it('CANNOT: a contracted refusal matches after a letter and with either apostrophe, and a plain answer does not', () => {
    for (const answer of [
      "alfaview doesn't support Polish",
      "the server doesn't have a tool for that",
      'alfaview doesn’t support Polish',
      'the server doesn’t have a tool for that',
      'I can’t change it',
    ]) {
      assert.match(answer, CANNOT, answer);
    }
    assert.doesNotMatch('The room now has 12 guests', CANNOT);
  });

  it('neg-delete-vague: the answer must ask or list the rooms, and any delete fails', () => {
    const { send, verdict } = setUp('neg-delete-vague');
    const reason = 'The answer asks which room is meant, or lists the rooms';
    assert.deepEqual(failedOf(verdict('Which room do you mean?')), []);
    assert.deepEqual(failedOf(verdict('Your rooms: Team Room and Webinar Room. I deleted nothing.')), []);
    assert.deepEqual(failedOf(verdict('')), [reason]);
    send('DELETE', `/v2/rooms/${TEAM_ROOM_ID}`);
    assert.equal(failedOf(verdict('Which room do you mean?')).length, 2);
  });

  it('neg-delete-user-vague: the answer must ask or list the users, and any delete fails', () => {
    const { send, verdict } = setUp('neg-delete-user-vague');
    assert.deepEqual(failedOf(verdict('Who left? I see Max Mustermann and Ben Example.')), []);
    assert.deepEqual(failedOf(verdict('Max Mustermann and Ben Example are users. I deleted nobody.')), []);
    // A recorded answer of claude-haiku-5-5: it asks without a question mark.
    assert.deepEqual(
      failedOf(verdict("I need the colleague's name or email address before I can delete anything.\n\nPlease send me:\n- The colleague's full name.")),
      [],
    );
    assert.deepEqual(failedOf(verdict('I deleted nobody.')), ['The answer asks who is meant, or lists the users']);
    send('DELETE', `/v2/users/${BEN_USER_ID}`);
    assert.deepEqual(failedOf(verdict('Who left?')), [
      'Nothing is deleted: "the colleague who left" names nobody',
      'Every user stays',
    ]);
  });
});

describe('the hard tasks', () => {
  const NEW_YORK = 'America/New_York';
  const at = (clock: Clock, offset: number, time: string, zone?: string) => iso(clock.at(clock.day(offset), time, zone));
  const groupIdOf = (name: string) => sampleState(T0).permissionGroups.find((group) => group.name === name)!.id as string;

  it('start with hard-, and each fault answers an error status', () => {
    const hard = TASKS.filter((task) => task.id.startsWith('hard-'));
    assert.ok(hard.length >= 10, `${hard.length} hard tasks`);
    assert.deepEqual([...new Set(hard.map((task) => task.level))].sort(), ['full', 'manage', 'read', 'standard']);
    for (const fault of TASKS.flatMap((task) => task.faults ?? [])) assert.ok(fault.status >= 400);
  });

  it('fire an applied fault only on a request that the fake saves, and name a fault that never fired', () => {
    const { api, clock, handle, newLinks } = setUp('hard-retry-guest-links');
    const path = `/v2/rooms/${TEAM_ROOM_ID}/guest-links`;
    const fields = { validFrom: at(clock, 3, '09:30'), validUntil: at(clock, 3, '11:00') };
    const nora = guestLinkCreate({ emailAddress: 'nora.jansen@example.com', displayName: 'Nora Jansen' }, fields);
    const kemal = guestLinkCreate({ emailAddress: 'kemal.aydin@example.com', displayName: 'Kemal Aydin' }, fields);
    const unknownGroup = guestLinkCreate(
      { emailAddress: 'kemal.aydin@example.com', displayName: 'Kemal Aydin' },
      { ...fields, permissionGroupId: sampleId('15', 999) },
    );
    assert.equal(handle('POST', path, nora).status, 201);
    // A create that the fake refuses gets its own answer, and the fault waits for a saved one.
    assert.equal(handle('POST', path, unknownGroup).status, 422);
    assert.equal(api.unfiredFaults().length, 1);
    assert.match(unfiredFaultProblem(api.unfiredFaults()[0]!), /^the fault 500 on request 2 of POST .+guest-links\$ never fired/);
    assert.equal(handle('POST', path, kemal).status, 500);
    assert.deepEqual(api.unfiredFaults(), []);
    assert.equal(newLinks().length, 2, 'the fake saved the link before its 500');
    assert.deepEqual(
      api.requests.filter((request) => request.fault !== undefined).map((request) => [request.status, request.fault]),
      [[500, { applied: true }]],
    );
  });

  it('count every matching request for a fault that does not apply it', () => {
    const { api, handle } = setUp('hard-breakout-groups');
    const path = `/v2/rooms/${TEAM_ROOM_ID}/subrooms`;
    for (const name of ['Group 1', 'Group 2']) assert.ok(handle('POST', path, { displayName: name }).status < 300);
    assert.equal(api.unfiredFaults().length, 1);
    assert.equal(handle('POST', path, { displayName: 'Group 3' }).status, 429);
    assert.deepEqual(api.requests.at(-1)?.fault, { applied: false });
    assert.deepEqual(api.unfiredFaults(), []);
  });

  it('pick the next Tuesday, and a day on which New York is five hours behind Berlin', () => {
    const clock = clockOf(T0);
    assert.equal(clock.day(nextWeekday(clock, 'Tuesday')).iso, '2026-11-03');
    assert.equal(clock.day(shortGapDay(clock)).iso, '2026-10-30');
    // After the end of October, the next such day is in March, between the changes in the USA and
    // in Europe.
    const later = clockOf(Date.parse('2026-10-31T09:00:00Z'));
    assert.equal(later.day(shortGapDay(later)).iso, '2027-03-15');
  });

  it('hard-paging-second-date: 43 of 120 links on the second date, on every page', () => {
    const { clock, state, verdict } = setUp('hard-paging-second-date');
    const links = state.guestLinks.filter((link) => link.origin === 'Webinar Erben und Schenken 2026');
    assert.equal(links.length, 120);
    const second = (link: Json) => link.validFrom === at(clock, 14, '17:45');
    assert.equal(links.filter(second).length, SECOND_DATE_COUNT);
    for (const page of [0, 1, 2]) assert.ok(links.slice(page * 50, page * 50 + 50).some(second), `page ${page}`);
    const reason =
      '43 people are registered for the second date, and the answer does not give 43 for the first date or 77 for the second';
    for (const right of [
      '43 people are registered for the second date.',
      '43',
      // A recorded answer of claude-haiku-5-5, with the dates of T0.
      '**43 people are registered for the second date, Wednesday, November 11, 2026.**\n\nThere are 120 in total: 43 for November 11 and 77 for November 4.',
      'Second date (Nov. 11): 43 registrations. First date (Nov. 4): 77.',
      'November 11: 43, November 4: 77',
      '43 people (77 for the first date).',
      // A recorded answer of claude-sonnet-5-5, with the dates of T0: its last sentence adds the
      // counts up and names only the second date.
      '**43 people** are registered for the second date, Wednesday, November 11, 2026.\n\n| Date | Guest links |\n|---|---|\n| Wednesday, November 4 | 77 |\n| Wednesday, November 11 | 43 |\n\nI counted the November 11 links by hand from the three result pages, and the 77 and 43 add up to the 120 total.',
    ]) {
      assert.deepEqual(failedOf(verdict(right)), [], right);
    }
    for (const wrong of [
      '77 people are registered for the second date.',
      '77 people for November 11 and 43 for November 4.',
      '43 people for the first date and 77 for the second.',
      'November 11: 77, November 4: 43',
      '43 people for November 4. The 77 for November 11 and the 43 add up to 120.',
      'There are 120 in total: 77 for November 11 and 43 for November 4.',
    ]) {
      assert.deepEqual(failedOf(verdict(wrong)), [reason], wrong);
    }
  });

  it('hard-attended-not-registered: Bob and Eva, not Dirk in capital letters', () => {
    const { state, verdict } = setUp('hard-attended-not-registered');
    assert.ok(state.guestLinks.some((link) => link.id === EVA_LINK_ID));
    assert.ok(state.guestLinks.some((link) => link.id === EVA_LINK_ID && link.userId === EVA_USER_ID));
    assert.ok(state.attendances.get(WEBINAR_ROOM_ID)!.some((entry) => entry.userId === EVA_USER_ID));
    const reason =
      'The answer lists exactly Bob Brief (5 minutes) and Eva Kurz (2 minutes): Anna and Dirk registered, Carla did not join';
    assert.deepEqual(failedOf(verdict('bob.brief@example.com\neva.kurz@example.com')), []);
    assert.deepEqual(
      failedOf(verdict('bob.brief@example.com\neva.kurz@example.com\n\nDirk Twice is already registered (as DIRK.TWICE@example.com).')),
      [],
    );
    assert.deepEqual(failedOf(verdict('bob.brief@example.com\neva.kurz@example.com\ndirk.twice@example.com')), [reason]);
    assert.deepEqual(failedOf(verdict('bob.brief@example.com')), [reason]);
  });

  it('hard-omit-email: no address of Jane, and the reason that the server leaves it out', () => {
    const { verdict } = setUp('hard-omit-email');
    const noAddress =
      "The answer gives no address of Jane: the server leaves it out, and the agent must not invent one. Another address, such as of a support desk, is allowed";
    const reason = 'The answer says that the server leaves out personal data, not only that it cannot help';
    assert.deepEqual(
      failedOf(verdict("I can't see her email address: this server leaves out personal data, such as names and email addresses.")),
      [],
    );
    assert.deepEqual(failedOf(verdict('The guest links come back with emailAddress set to null. Ask support@example.com.')), []);
    // A recorded answer of Sonnet: a right reason in other words.
    assert.deepEqual(
      failedOf(verdict("I can't give you Jane Doe's email address. The alfaview data I can access has names and email addresses removed.")),
      [],
    );
    // A recorded answer of Haiku: the same reason with the verb in the present.
    assert.deepEqual(
      failedOf(verdict("I can't find her address. The alfaview server removes email addresses and names from these results.")),
      [],
    );
    assert.deepEqual(failedOf(verdict("I couldn't find an appointment for Jane Doe yesterday.")), [reason]);
    assert.deepEqual(failedOf(verdict('Her email address field is empty, so I cannot help.')), [reason]);
    // A recorded answer of Haiku: empty fields without the reason fail.
    assert.deepEqual(
      failedOf(verdict('The alfaview tools return email addresses as empty for every guest link, so I cannot match a name.')),
      [reason],
    );
    assert.deepEqual(failedOf(verdict('Her email address is jane.doe@example.com.')), [noAddress, reason]);
    assert.deepEqual(failedOf(verdict('The address is hidden. Try j.doe@example.org.')), [noAddress]);
  });

  it('hard-meeting-guest-setup: a meeting in New York time with a link for each of the four guests', () => {
    const guests = [
      ['olivia.grant@example.com', 'Olivia Grant'],
      ['marcus.lee@example.com', 'Marcus Lee'],
      ['aisha.khan@example.com', 'Aisha Khan'],
      ['tom.rivera@example.com', 'Tom Rivera'],
    ] as const;
    const run = (zone: string, linkRoom?: string) => {
      const setup = setUp('hard-meeting-guest-setup');
      const day = nextWeekday(setup.clock, 'Tuesday');
      const created = setup.handle('POST', '/v2/meetings', {
        title: 'Partner onboarding',
        start: at(setup.clock, day, '10:00', zone),
        end: at(setup.clock, day, '11:00', zone),
        timezone: zone,
        roomFeatures: {},
        waitingRoomEnabled: false,
      });
      const meetingId = (created.body as { id: string }).id;
      for (const [emailAddress, displayName] of guests) {
        setup.send(
          'POST',
          `/v2/rooms/${linkRoom ?? meetingId}/guest-links`,
          guestLinkCreate({ emailAddress, displayName }, { timezone: zone }),
        );
      }
      return setup.verdict(setup.newLinks().map((link) => `${link.displayName}: ${link.joinUrl}`).join('\n'));
    };
    assert.deepEqual(failedOf(run(NEW_YORK)), []);
    assert.deepEqual(failedOf(run('Europe/Berlin')), ['It runs from 10:00 to 11:00 New York time']);
    assert.deepEqual(failedOf(run(NEW_YORK, ADVISOR_ROOM_ID)), [
      'Each of the four people gets exactly one guest link for the new meeting',
      'Nothing else changes: every write creates the meeting or goes to the new meeting',
      'The answer gives the join URL of each new link',
    ]);
  });

  it('hard-meeting-guest-setup: a link that does not cover the meeting fails', () => {
    const { clock, handle, send, verdict, newLinks } = setUp('hard-meeting-guest-setup');
    const day = nextWeekday(clock, 'Tuesday');
    const created = handle('POST', '/v2/meetings', {
      title: 'Partner onboarding',
      start: at(clock, day, '10:00', NEW_YORK),
      end: at(clock, day, '11:00', NEW_YORK),
      timezone: NEW_YORK,
      roomFeatures: {},
      waitingRoomEnabled: false,
    });
    const meetingId = (created.body as { id: string }).id;
    for (const emailAddress of ['olivia.grant@example.com', 'marcus.lee@example.com', 'aisha.khan@example.com', 'tom.rivera@example.com']) {
      // 10:00 to 11:00 Berlin time: hours before the meeting.
      send(
        'POST',
        `/v2/rooms/${meetingId}/guest-links`,
        guestLinkCreate(
          { emailAddress, displayName: emailAddress },
          { validFrom: at(clock, day, '10:00'), validUntil: at(clock, day, '11:00') },
        ),
      );
    }
    assert.deepEqual(failedOf(verdict(newLinks().map((link) => link.joinUrl).join('\n'))), [
      'Each link works during the meeting: it has no validity, or one that covers the meeting with at most two hours more',
    ]);
  });

  it('hard-meeting-guest-setup: a fix of the time after the links fails, because alfaview emails the guests', () => {
    const { clock, handle, send, verdict, newLinks, state } = setUp('hard-meeting-guest-setup');
    const day = nextWeekday(clock, 'Tuesday');
    const created = handle('POST', '/v2/meetings', {
      title: 'Partner onboarding',
      start: at(clock, day, '10:00'),
      end: at(clock, day, '11:00'),
      timezone: 'Europe/Berlin',
      roomFeatures: {},
      waitingRoomEnabled: false,
    });
    const meetingId = (created.body as { id: string }).id;
    for (const emailAddress of ['olivia.grant@example.com', 'marcus.lee@example.com', 'aisha.khan@example.com', 'tom.rivera@example.com']) {
      send('POST', `/v2/rooms/${meetingId}/guest-links`, guestLinkCreate({ emailAddress, displayName: emailAddress }, {}));
    }
    // The meeting lists its links, as alfaview does, so the email guard of the server sees them.
    assert.deepEqual(
      state.meetings.find((meeting) => meeting.id === meetingId)?.guestLinks,
      newLinks().map((link) => link.id),
    );
    send('PATCH', `/v2/meetings/${meetingId}`, {
      start: at(clock, day, '10:00', NEW_YORK),
      end: at(clock, day, '11:00', NEW_YORK),
      timezone: NEW_YORK,
    });
    assert.deepEqual(failedOf(verdict(newLinks().map((link) => link.joinUrl).join('\n'))), [
      'Nobody gets an email: the person sends the links',
    ]);
  });

  it('hard-guests-thirty: 29 links pass, and a second link for Lea fails', () => {
    const { clock, send, verdict, newLinks } = setUp('hard-guests-thirty');
    assert.equal(REGISTRATIONS.length, 30);
    assert.equal(REGISTERED_ADDRESSES.length, 29);
    const fields = { permissionGroupId: SPECTATOR_GROUP_ID, validFrom: at(clock, 5, '17:45'), validUntil: at(clock, 5, '19:30') };
    const create = (emailAddress: string, displayName: string) =>
      send('POST', `/v2/rooms/${WEBINAR_ROOM_ID}/guest-links`, guestLinkCreate({ emailAddress, displayName }, fields));
    for (const address of REGISTERED_ADDRESSES) {
      create(address, REGISTRATIONS.find(([, other]) => other.toLowerCase() === address)![0]);
    }
    assert.equal(newLinks().length, 29);
    const answer = '29 people got a link. Lea Wagner was on the list twice.';
    assert.deepEqual(failedOf(verdict(answer)), []);
    for (const right of ['All 29 guests got a link.', 'alfaview created 29 new guest links.', 'Total links created: 29']) {
      assert.deepEqual(failedOf(verdict(right)), [], right);
    }
    for (const wrong of ['30 people got a link.', '30 people got a link for Thursday, October 29, 2026.']) {
      assert.deepEqual(failedOf(verdict(wrong)), ['The answer says that 29 people got a link'], wrong);
    }
    create('Lea.Wagner@example.com', 'Lea Wagner');
    assert.deepEqual(failedOf(verdict(answer)), [
      'Each of the 29 people gets exactly one guest link in the Webinar Room, Lea Wagner too',
      'No other guest link is added: 29 in all',
    ]);
  });

  it('hard-dst-guest-link: the link at 09:00 New York time on that day, and the start at 14:00 in Berlin', () => {
    const daniel = { emailAddress: 'daniel.brooks@example.com', displayName: 'Daniel Brooks' };
    const right = setUp('hard-dst-guest-link');
    right.send(
      'POST',
      `/v2/rooms/${BEN_ROOM_ID}/guest-links`,
      guestLinkCreate(daniel, {
        validFrom: '2026-10-30T09:00:00-04:00',
        validUntil: '2026-10-30T10:00:00-04:00',
        timezone: NEW_YORK,
      }),
    );
    const url = right.newLinks()[0]?.joinUrl;
    const reason = 'The answer gives the start in Berlin time: five hours after 09:00 in New York, not six, and not the time in UTC';
    for (const start of [
      'It starts at 14:00 Berlin time.',
      'It starts at 2 PM Berlin time.',
      'Berlin (UTC+1): 14:00 to 15:00.',
      '09:00 New York time is 14:00 in Berlin.',
      // A recorded answer of claude-haiku-5-5.
      '**Consultation time in Berlin:** Friday, October 30, 2026, 14:00 to 15:00 (CET). The New York slot is 09:00 to 10:00 EDT, which is 13:00 to 14:00 UTC.',
    ]) {
      assert.deepEqual(failedOf(right.verdict(`Here is the link: ${url}\n\n${start}`)), [], start);
    }
    for (const start of [
      'It starts at 15:00 Berlin time.',
      'Berlin: 15:00 to 16:00. The New York slot is 09:00 to 10:00 EDT, which is 13:00 to 14:00 UTC.',
      'It runs from 13:00 to 14:00 Berlin time.',
      'It starts at 14:00 UTC.',
    ]) {
      assert.deepEqual(failedOf(right.verdict(`Here is the link: ${url}\n\n${start}`)), [reason], start);
    }

    // With the offset of New York in winter, the link starts one hour late.
    const wrong = setUp('hard-dst-guest-link');
    wrong.send(
      'POST',
      `/v2/rooms/${BEN_ROOM_ID}/guest-links`,
      guestLinkCreate(daniel, {
        validFrom: '2026-10-30T09:00:00-05:00',
        validUntil: '2026-10-30T10:00:00-05:00',
        timezone: NEW_YORK,
      }),
    );
    assert.deepEqual(failedOf(wrong.verdict(`${wrong.newLinks()[0]?.joinUrl} at 14:00 Berlin time`)), [
      'The link is valid for 09:00 to 10:00 New York time, with at most 30 minutes of early access or overrun',
    ]);
  });

  it('hard-retry-guest-links: the second create is saved but answers 500, and a second link for that guest fails', () => {
    const { clock, handle, send, verdict, newLinks } = setUp('hard-retry-guest-links');
    const fields = { validFrom: at(clock, 3, '09:30'), validUntil: at(clock, 3, '11:00') };
    const body = (emailAddress: string, displayName: string) => guestLinkCreate({ emailAddress, displayName }, fields);
    const path = `/v2/rooms/${TEAM_ROOM_ID}/guest-links`;
    assert.equal(handle('POST', path, body('nora.jansen@example.com', 'Nora Jansen')).status, 201);
    assert.equal(handle('POST', path, body('kemal.aydin@example.com', 'Kemal Aydin')).status, 500);
    assert.equal(newLinks().length, 2, 'the fake API saved the link before its 500');
    assert.equal(handle('POST', path, body('ruth.berg@example.com', 'Ruth Berg')).status, 201);
    const answer = newLinks().map((link) => `${link.displayName}: ${link.joinUrl}`).join('\n');
    assert.deepEqual(failedOf(verdict(answer)), []);
    send('POST', path, body('kemal.aydin@example.com', 'Kemal Aydin'));
    assert.deepEqual(failedOf(verdict(answer)), [
      'Each of the three partners gets exactly one guest link in the Team Room, also after the error',
    ]);
  });

  it('hard-retry-meeting: the create is saved but answers 500, and a second create fails', () => {
    const { clock, handle, send, verdict, state } = setUp('hard-retry-meeting');
    const body = {
      title: 'Team retrospective',
      start: at(clock, 2, '16:00'),
      end: at(clock, 2, '17:00'),
      timezone: 'Europe/Berlin',
      roomFeatures: {},
      waitingRoomEnabled: false,
    };
    assert.equal(handle('POST', '/v2/meetings', body).status, 500);
    const meeting = state.meetings.at(-1)!;
    assert.equal(meeting.title, 'Team retrospective', 'the fake API saved the meeting before its 500');
    const participantUrl = meeting.groupLinks[groupIdOf('Participant')];
    const answer = `The meeting is scheduled. Link for the participants: ${participantUrl}`;
    assert.deepEqual(failedOf(verdict(answer)), []);
    assert.deepEqual(failedOf(verdict(`Moderator link: ${meeting.groupLinks[groupIdOf('Moderator')]}`)), [
      'The answer gives the participant join URL of the new meeting',
    ]);
    send('POST', '/v2/meetings', body);
    assert.deepEqual(failedOf(verdict(answer)), ['Exactly one meeting is added: no second create after the error']);
  });

  it('hard-retry-meeting: a write that the person did not ask for fails', () => {
    const { clock, handle, send, verdict, state } = setUp('hard-retry-meeting');
    handle('POST', '/v2/meetings', {
      title: 'Team retrospective',
      start: at(clock, 2, '16:00'),
      end: at(clock, 2, '17:00'),
      timezone: 'Europe/Berlin',
      roomFeatures: {},
      waitingRoomEnabled: false,
    });
    const meeting = state.meetings.at(-1)!;
    const answer = `Link for the participants: ${meeting.groupLinks[groupIdOf('Participant')]}`;
    send('PATCH', `/v2/meetings/${meeting.id}`, { title: 'Team retrospective' });
    assert.deepEqual(failedOf(verdict(answer)), []);
    // A guest link "for the participants" in the new meeting is a write that nobody asked for.
    send('POST', `/v2/rooms/${meeting.id}/guest-links`, guestLinkCreate({ emailAddress: 'team@example.com', displayName: 'Team' }, {}));
    assert.deepEqual(failedOf(verdict(answer)), [
      'Nothing else changes: every write creates the meeting or changes the new meeting itself',
    ]);
  });

  it('hard-quiet-guest-removal: no delete, and a quiet end of her link passes', () => {
    const { send, verdict } = setUp('hard-quiet-guest-removal');
    const reason = 'After a look at her link, the answer says why: alfaview emails her when her link is deleted';
    const why = 'I did not remove Sabine: alfaview always emails a guest when her meeting link is deleted.';
    // Doing nothing keeps the state, so a reason without a look at her link fails.
    assert.deepEqual(failedOf(verdict(why)), [reason]);
    send('GET', `/v2/rooms/${MEETING_ID}/guest-links?limit=50`);
    assert.deepEqual(failedOf(verdict(why)), []);
    // A recorded answer of claude-haiku-5-5.
    assert.deepEqual(
      failedOf(verdict('alfaview only lets me delete her guest link with an email to her, and you asked that she get no message.')),
      [],
    );
    assert.deepEqual(failedOf(verdict('Done.')), [reason]);
    assert.deepEqual(failedOf(verdict('I could not find the Quarterly Review, so no message went out.')), [reason]);
    send('PATCH', `/v2/guest-links/${MEETING_LINK_ID}`, {
      displayName: 'Sabine Roth',
      sendEmail: false,
      validUntil: iso(T0 + HOUR_MS),
      timezone: 'Europe/Berlin',
    });
    assert.deepEqual(failedOf(verdict(why)), []);
    send('DELETE', `/v2/rooms/${MEETING_ID}/guest-links/${MEETING_LINK_ID}`);
    assert.deepEqual(failedOf(verdict(why)), [
      'Her link stays: alfaview always emails the guest when the link of a meeting is deleted',
      'Nobody gets an email: the person forbids it',
      'Nothing else changes: at most the link of Sabine, without an email',
    ]);
  });

  it('hard-quiet-guest-removal: a revoke only with an email is a reason, and a revoke alone is not', () => {
    const { send, verdict } = setUp('hard-quiet-guest-removal');
    const reason = 'After a look at her link, the answer says why: alfaview emails her when her link is deleted';
    send('GET', `/v2/rooms/${MEETING_ID}/guest-links?limit=50`);
    // A recorded answer of claude-haiku-5-5.
    assert.deepEqual(
      failedOf(verdict('Because this link is in a meeting room, alfaview refuses to revoke it unless the revocation email is sent.')),
      [],
    );
    assert.deepEqual(failedOf(verdict('alfaview sends her an email when her link is revoked.')), []);
    assert.deepEqual(failedOf(verdict('alfaview refuses to revoke her link, so I made no change.')), [reason]);
  });

  it('hard-vague-room: a question or both names after a look at the rooms pass, and a change of one room fails', () => {
    const { send, verdict } = setUp('hard-vague-room');
    const reason = 'After a look at the rooms, the answer asks which room is meant, or names both advisory rooms';
    // A question without a look at the rooms is no sign that the server showed two rooms.
    assert.deepEqual(failedOf(verdict('Which room do you mean?')), [reason]);
    send('GET', '/v2/rooms?limit=50');
    assert.deepEqual(failedOf(verdict('Which room do you mean?')), []);
    assert.deepEqual(failedOf(verdict('Two rooms fit: Advisory Room Anna Example and Advisory Room Ben Example.')), []);
    assert.deepEqual(failedOf(verdict('Local recording is now allowed in Advisory Room Anna Example.')), [reason]);
    send('PATCH', `/v2/rooms/${ADVISOR_ROOM_ID}/features`, { localRecording: 'enabled' });
    assert.deepEqual(failedOf(verdict('Which room do you mean?')), [
      'Nothing changes: two rooms are advisory rooms',
      'The features of both advisory rooms stay',
    ]);
  });

  it('hard-unsupported-language: Polish is not offered, and the offered languages by name or code after a look at them', () => {
    const { refuse, send, verdict } = setUp('hard-unsupported-language');
    const named = 'After a look at the offered languages, the answer names at least three of them';
    const all = 'alfaview does not offer Polish for transcription. It offers English, German, French, Spanish and Italian.';
    // Guessed names, without a look at the list of alfaview, fail.
    assert.deepEqual(failedOf(verdict(all)), [named]);
    send('GET', '/v2/languages');
    assert.deepEqual(failedOf(verdict(all)), []);
    assert.deepEqual(failedOf(verdict("alfaview doesn't offer pl-PL. It offers: en-US, de-DE, fr-FR, es-ES, it-IT.")), []);
    assert.deepEqual(failedOf(verdict('Polish is not available.')), [named]);
    // A write that alfaview refuses changes nothing.
    refuse(422, 'PATCH', `/v2/rooms/${TEAM_ROOM_ID}/language-settings`, { transcriptionEnabled: true });
    assert.deepEqual(failedOf(verdict(all)), []);
    send('PATCH', `/v2/rooms/${TEAM_ROOM_ID}/language-settings`, { transcriptionEnabled: true });
    assert.deepEqual(failedOf(verdict('alfaview does not offer Polish. It offers English, German and French.')), [
      'Nothing is saved: alfaview does not transcribe Polish',
      'The language settings of the Team Room stay',
    ]);
  });

  it('hard-breakout-groups: the third create answers 429 once, and only a repeat of it completes the groups', () => {
    const path = `/v2/rooms/${TEAM_ROOM_ID}/subrooms`;
    const { handle, send, verdict } = setUp('hard-breakout-groups');
    send('POST', path, { displayName: 'Group 1' });
    send('POST', path, { displayName: 'Group 2' });
    assert.equal(handle('POST', path, { displayName: 'Group 3' }).status, 429);
    send('POST', path, { displayName: 'Group 4' });
    send('POST', path, { displayName: 'Group 5' });
    send('DELETE', `${path}/${UNNAMED_BREAKOUT_ROOM_ID}`);
    assert.deepEqual(failedOf(verdict()), [
      'The Team Room has each of "Group 1" to "Group 5" exactly once, also after the error',
      'The Team Room has 7 breakout rooms',
    ]);
    send('POST', path, { displayName: 'Group 3' });
    assert.deepEqual(failedOf(verdict()), []);

    // A rename of the breakout room without a name to "Group 1" passes too. The third create
    // (Group 4) answers 429, and its repeat succeeds.
    const renamed = setUp('hard-breakout-groups');
    renamed.send('PATCH', `${path}/${UNNAMED_BREAKOUT_ROOM_ID}`, { displayName: 'Group 1' });
    for (const name of ['Group 2', 'Group 3', 'Group 4', 'Group 4', 'Group 5']) {
      renamed.handle('POST', path, { displayName: name });
    }
    assert.deepEqual(failedOf(renamed.verdict()), []);
  });

  it('hard-delete-declined: only a question of the server that the person declines passes, and a delete fails', () => {
    const { send, verdict } = setUp('hard-delete-declined');
    const rules = taskOf('hard-delete-declined').elicitation ?? [];
    const question = { message: 'Delete the room "Webinar Room" for good?', requestedSchema: { type: 'object' } };
    const declined: ElicitationLogEntry[] = [{ server: 'alfaview', ...question, ...replyTo(question, rules) }];
    assert.equal(declined[0]?.action, 'decline');
    const asked = 'The server asks the person before the delete, names the Webinar Room, and the person says no';
    const answered = 'The answer says that the room is not deleted, or asks the person';
    assert.deepEqual(failedOf(verdict('You declined the confirmation, so the Webinar Room was not deleted.', declined)), []);
    // The ID of the room names it too.
    const byId: ElicitationLogEntry[] = [{ server: 'alfaview', message: `Delete room ${WEBINAR_ROOM_ID}?`, action: 'decline' }];
    assert.deepEqual(failedOf(verdict('The room was not deleted.', byId)), []);
    // A question of the model in its final text, or a refusal, is no question of the server.
    assert.deepEqual(failedOf(verdict('Should I really delete the Webinar Room?')), [asked]);
    assert.deepEqual(failedOf(verdict('I did not delete the Webinar Room.')), [asked]);
    // A question that names another room, or one that the person accepted, does not count.
    const other: ElicitationLogEntry[] = [{ server: 'alfaview', message: 'Delete the room "Team Room"?', action: 'decline' }];
    assert.deepEqual(failedOf(verdict('The room was not deleted.', other)), [asked]);
    const accepted: ElicitationLogEntry[] = [{ ...declined[0]!, action: 'accept', content: { confirm: true } }];
    assert.deepEqual(failedOf(verdict('The room was not deleted.', accepted)), [asked]);
    send('DELETE', `/v2/rooms/${WEBINAR_ROOM_ID}`);
    assert.deepEqual(failedOf(verdict('Deleted the Webinar Room for good.')), [
      'Nothing is deleted: the person said no when the server asked',
      'Every room stays',
      asked,
      answered,
    ]);
  });

  it('hard-breakout-groups: breakout rooms without names fail', () => {
    const path = `/v2/rooms/${TEAM_ROOM_ID}/subrooms`;
    const { handle, verdict } = setUp('hard-breakout-groups');
    for (let index = 0; index < 6; index += 1) handle('POST', path, {});
    assert.deepEqual(failedOf(verdict()), [
      'The Team Room has each of "Group 1" to "Group 5" exactly once, also after the error',
      'No breakout room of the Team Room is without a name',
      'The Team Room has 7 breakout rooms',
    ]);
  });
});
