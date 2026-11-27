// The clock and the check helpers of the model eval (eval/clock.ts, eval/checks.ts).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  added,
  answerCheck,
  answerHas,
  answerHasAll,
  answerLacks,
  carriesTrue,
  emailAddressesIn,
  emailsOf,
  labeledValues,
  listedAddresses,
  noWrites,
  plainText,
  questionCheck,
  readsAny,
  runChecks,
  sameSet,
  savedOf,
  stateCheck,
  validFor,
  writesOf,
  writesOnlyUnder,
  type RunOutcome,
} from '../../eval/checks.ts';
import { clockOf, HOUR_MS, MINUTE_MS, offsetMs, timeOf, zonedInstant } from '../../eval/clock.ts';
import {
  ADVISOR_ROOM_ID,
  MEETING_ID,
  MEETING_LINK_ID,
  sampleState,
  type FakeRequest,
} from '../fake-api/server.ts';

const T0 = Date.parse('2026-10-28T09:00:00Z');

function request(method: string, path: string, body?: unknown): FakeRequest {
  return { method, path, query: {}, authorization: 'fake-token-1', body, status: 200 };
}

function outcomeWith(requests: FakeRequest[], answer = ''): RunOutcome {
  const state = sampleState(T0);
  return { initial: structuredClone(state), state, requests, elicitations: [], answer, clock: clockOf(T0) };
}

describe('the clock of the eval', () => {
  it('gives days relative to t0 in Berlin time, across a month end', () => {
    const clock = clockOf(T0);
    assert.equal(clock.day(0).iso, '2026-10-28');
    assert.equal(clock.day(-1).long, 'Tuesday, October 27, 2026');
    assert.equal(clock.day(4).iso, '2026-11-01');
    // 23:30 UTC is already the next day in Berlin.
    assert.equal(clockOf(Date.parse('2026-10-28T23:30:00Z')).day(0).iso, '2026-10-29');
  });

  it('finds the instant of a wall clock time in a time zone, also around a change of daylight saving time', () => {
    const day = clockOf(T0).day(3);
    assert.equal(zonedInstant(day, '15:00', 'America/New_York'), Date.parse('2026-10-31T19:00:00Z'));
    assert.equal(zonedInstant(day, '15:00', 'Europe/Berlin'), Date.parse('2026-10-31T14:00:00Z'));
    const summer = { ...day, year: 2026, month: 7, day: 1 };
    assert.equal(zonedInstant(summer, '12:00', 'Europe/Berlin'), Date.parse('2026-07-01T10:00:00Z'));
    // 2026-11-01 is the day on which New York leaves daylight saving time.
    const change = clockOf(T0).day(4);
    assert.equal(zonedInstant(change, '00:30', 'America/New_York'), Date.parse('2026-11-01T04:30:00Z'));
    assert.equal(zonedInstant(change, '09:00', 'America/New_York'), Date.parse('2026-11-01T14:00:00Z'));
    assert.equal(offsetMs(T0, 'Europe/Berlin'), HOUR_MS);
    assert.throws(() => zonedInstant(day, '9:00', 'Europe/Berlin'), /expected a time HH:MM/);
  });

  it('gives the wall clock time of an instant', () => {
    assert.equal(timeOf(T0), '10:00');
    assert.equal(timeOf(T0 - 7 * MINUTE_MS, 'America/New_York'), '04:53');
  });
});

describe('the check helpers of the eval', () => {
  it('count every request but GET and the login as a write', () => {
    const requests = [
      request('POST', '/v2/auth/api-key'),
      request('GET', '/v2/rooms'),
      request('POST', '/v2/meetings'),
      request('DELETE', '/v2/rooms/x'),
    ];
    assert.deepEqual(
      writesOf(requests).map((item) => item.method),
      ['POST', 'DELETE'],
    );
  });

  it('find a flag that is true at any depth', () => {
    assert.equal(carriesTrue({ create: [{ sendEmail: true }] }, ['sendEmail']), true);
    assert.equal(carriesTrue({ create: [{ sendEmail: false }] }, ['sendEmail']), false);
    assert.equal(carriesTrue('sendEmail', ['sendEmail']), false);
  });

  it('find every request with which alfaview emails someone', () => {
    const emails = emailsOf(
      outcomeWith([
        request('POST', `/v2/rooms/${ADVISOR_ROOM_ID}/guest-links`, { create: [{ sendEmail: true }] }),
        request('POST', '/v2/meetings/x/cancellation', { sendNotification: true }),
        request('POST', '/v2/users/invitation', { user: {} }),
        request('PATCH', `/v2/meetings/${MEETING_ID}`, { agenda: 'New' }),
        request('DELETE', `/v2/rooms/${MEETING_ID}/guest-links/${MEETING_LINK_ID}`),
      ]),
    );
    assert.equal(emails.length, 5);
    assert.match(emails[3]!, /changes a meeting with guest links/);
    assert.match(emails[4]!, /deletes a guest link of a meeting room/);
  });

  it('find no email for flags that are false, a meeting without guest links or a link of a room', () => {
    const outcome = outcomeWith([
      request('POST', `/v2/rooms/${ADVISOR_ROOM_ID}/guest-links`, { create: [{ sendEmail: false }] }),
      request('PATCH', '/v2/meetings/meeting-without-guests', { agenda: 'New' }),
      request('DELETE', `/v2/rooms/${ADVISOR_ROOM_ID}/guest-links/x`),
    ]);
    outcome.initial.meetings.push({ id: 'meeting-without-guests', guestLinks: null });
    assert.deepEqual(emailsOf(outcome), []);
  });

  it('count the change of a meeting that the run added, once a create of guest links in its room was saved', () => {
    const meeting = 'c0ffee00-0000-5000-8000-220000001001';
    const links = `/v2/rooms/${meeting}/guest-links`;
    const change = request('PATCH', `/v2/meetings/${meeting}`, { start: '2026-11-03T15:00:00Z' });
    const outcomeOf = (requests: FakeRequest[]) => {
      const outcome = outcomeWith(requests);
      outcome.state.meetings.push({ id: meeting, guestLinks: ['x'] });
      return outcome;
    };
    // Before the links, alfaview has nobody to email.
    assert.deepEqual(emailsOf(outcomeOf([change, request('POST', links, { create: [{}] })])), []);
    assert.deepEqual(emailsOf(outcomeOf([{ ...request('POST', links), status: 422 }, change])), []);
    for (const create of [request('POST', links), { ...request('POST', links), status: 500, fault: { applied: true } }]) {
      const emails = emailsOf(outcomeOf([create, change]));
      assert.equal(emails.length, 1);
      assert.match(emails[0]!, /changes a meeting with guest links/);
    }
    assert.match(emailsOf(outcomeOf([request('DELETE', `${links}/x`)]))[0]!, /deletes a guest link of a meeting room/);
  });

  it('tell a saved request, and a read of a path with success', () => {
    assert.equal(savedOf(request('POST', '/v2/meetings')), true);
    assert.equal(savedOf({ ...request('POST', '/v2/meetings'), status: 500 }), false);
    assert.equal(savedOf({ ...request('POST', '/v2/meetings'), status: 500, fault: { applied: true } }), true);
    assert.equal(savedOf({ ...request('POST', '/v2/meetings'), status: 429, fault: { applied: false } }), false);
    const requests = [request('GET', '/v2/Rooms'), { ...request('GET', '/v2/languages'), status: 500 }, request('POST', '/v2/meetings')];
    assert.equal(readsAny(requests, ['/v2/rooms']), true);
    assert.equal(readsAny(requests, ['/v2/languages']), false);
    assert.equal(readsAny(requests, ['/v2/meetings']), false);
  });

  it('read only the lines that list an address, or every address without such a line', () => {
    const answer = '- bob.brief@example.com\n2. `Eva.Kurz@example.com`\n\nDirk is already registered (as DIRK.TWICE@example.com).';
    assert.deepEqual(listedAddresses(answer), ['bob.brief@example.com', 'eva.kurz@example.com']);
    assert.deepEqual(listedAddresses('Bob (bob.brief@example.com) and Eva (eva.kurz@example.com).'), [
      'bob.brief@example.com',
      'eva.kurz@example.com',
    ]);
  });

  it('give each value the nearest label in its sentence, and no label for a tie', () => {
    const zones = { berlin: /Berlin|CET/, utc: /UTC/ };
    const labels = (text: string, options?: { valuesBlock?: boolean }) =>
      labeledValues(text, /\d{2}:\d{2}/, zones, options).map((value) => `${value.text} ${value.label}`);
    assert.deepEqual(labels('Berlin: 14:00 to 15:00 (CET). That is 13:00 to 14:00 UTC.'), [
      '14:00 berlin',
      '15:00 berlin',
      '13:00 utc',
      '14:00 utc',
    ]);
    assert.deepEqual(labels('At 10:00.\nBerlin then.'), ['10:00 undefined']);
    assert.deepEqual(labels('Berlin 10:00 UTC'), ['10:00 undefined']);
    // "Nov. 11" ends no sentence.
    assert.deepEqual(
      labeledValues('Nov. 11 has 43 people.', /\b43\b/, { second: /Nov\. 11/ }).map((value) => value.label),
      ['second'],
    );
    const counts = { first: /first/, second: /second/ };
    const text = 'For the second date: 43 people (77 for the first date).';
    assert.deepEqual(
      labeledValues(text, /\b(?:43|77)\b/, counts).map((value) => `${value.text} ${value.label}`),
      ['43 second', '77 first'],
    );
    // Without valuesBlock, 43 takes the label of 77, the only label in the sentence.
    assert.deepEqual(
      labeledValues('43 people (77 for the first date).', /\b(?:43|77)\b/, counts).map((value) => `${value.text} ${value.label}`),
      ['43 first', '77 first'],
    );
    assert.deepEqual(
      labeledValues('43 people (77 for the first date).', /\b(?:43|77)\b/, counts, { valuesBlock: true }).map(
        (value) => `${value.text} ${value.label}`,
      ),
      ['43 undefined', '77 first'],
    );
  });

  it('give a check of the questions of the server the log of the hook', () => {
    const check = questionCheck('asked', (elicitations) => elicitations.some((entry) => entry.action === 'decline'));
    assert.equal(check.kind, 'question');
    assert.equal(check.test(outcomeWith([])), false);
    const outcome = { ...outcomeWith([]), elicitations: [{ server: 'alfaview', message: 'Delete?', action: 'decline' as const }] };
    assert.equal(check.test(outcome), true);
  });

  it('find the added items by ID in any case', () => {
    assert.deepEqual(added([{ id: 'A' }], [{ id: 'a' }, { id: 'b' }]), [{ id: 'b' }]);
  });

  it('read typographic apostrophes as plain ones, and find the email addresses of a text', () => {
    assert.equal(plainText('I can’t do it, “the old room”'), 'I can\'t do it, "the old room"');
    assert.deepEqual(
      emailAddressesIn('Bob.Brief@Example.com\n- carla.absent@example.com.\nbob.brief@example.com'),
      ['bob.brief@example.com', 'carla.absent@example.com'],
    );
    assert.deepEqual(emailAddressesIn('nobody'), []);
  });

  it('allow writes only under the given paths, in any case, also paths from the outcome', () => {
    const outcome = outcomeWith([
      request('GET', '/v2/rooms'),
      request('POST', `/v2/rooms/${ADVISOR_ROOM_ID.toUpperCase()}/guest-links`),
    ]);
    assert.equal(writesOnlyUnder([`/v2/rooms/${ADVISOR_ROOM_ID}/guest-links`]).test(outcome), true);
    assert.equal(writesOnlyUnder(['/v2/meetings']).test(outcome), false);
    assert.equal(writesOnlyUnder(() => [`/v2/rooms/${ADVISOR_ROOM_ID}`]).test(outcome), true);
  });

  it('give a check of the answer the plain text and the outcome', () => {
    const check = answerCheck('reads both', (answer, outcome) => answer === "can't" && outcome.requests.length === 0);
    assert.equal(check.kind, 'answer');
    assert.equal(check.test(outcomeWith([], 'can’t')), true);
    assert.equal(answerHas('apostrophe', /can't/).test(outcomeWith([], 'I can’t')), true);
  });

  it('accept a validity that covers the time with at most the slack', () => {
    const from = Date.parse('2026-10-31T19:00:00Z');
    const until = from + HOUR_MS;
    const link = (start: number, end: number) => ({
      validFrom: new Date(start).toISOString(),
      validUntil: new Date(end).toISOString(),
    });
    const slack = 30 * MINUTE_MS;
    assert.equal(validFor(link(from, until), from, until, slack), true);
    assert.equal(validFor(link(from - slack, until + slack), from, until, slack), true);
    assert.equal(validFor(link(from - slack - MINUTE_MS, until), from, until, slack), false);
    assert.equal(validFor(link(from + MINUTE_MS, until), from, until, slack), false);
    assert.equal(validFor(link(from, until - MINUTE_MS), from, until, slack), false);
    assert.equal(validFor({ validFrom: '0001-01-01T00:00:00Z', validUntil: '' }, from, until, slack), false);
  });

  it('compare lists as sets', () => {
    assert.equal(sameSet(['b', 'a'], ['a', 'b']), true);
    assert.equal(sameSet(['a', 'a'], ['a', 'b']), false);
    assert.equal(sameSet(['a'], ['a', 'b']), false);
    assert.equal(sameSet(undefined, []), false);
  });

  it('run the checks of the answer and the state, and fail a check that throws', () => {
    const outcome = outcomeWith([request('POST', '/v2/meetings')], 'The passcode is Kx7#mQ2p.');
    const results = runChecks(
      [
        answerHas('has the passcode', /Kx7#mQ2p/),
        answerHasAll('has both words', ['PASSCODE', 'kx7']),
        answerLacks('names nobody', /Jane/),
        noWrites(),
        stateCheck('throws', () => {
          throw new Error('broken check');
        }),
      ],
      outcome,
    );
    assert.deepEqual(
      results.map((result) => [result.kind, result.passed]),
      [
        ['answer', true],
        ['answer', true],
        ['answer', true],
        ['state', false],
        ['state', false],
      ],
    );
  });
});
