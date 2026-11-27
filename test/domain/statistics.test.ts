import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../../src/alfaview/errors.ts';
import { DAY_MS, HOUR_MS } from '../../src/domain/attendance.ts';
import {
  checkStatisticsWindow,
  listStatistics,
  mapCompanyStatistics,
  mapStatisticsPeriod,
  MAX_PERIOD_HOURS,
  MAX_STATISTICS_PERIODS,
  MAX_STATISTICS_RANGE_MS,
  STATISTICS_DENIED_MESSAGE,
  STATISTICS_LOOKBACK_MS,
  type ApiStatsPeriod,
  type StatisticsWindow,
} from '../../src/domain/statistics.ts';
import { loginRequest, testApi, toolErrorOf, type ExpectedRequest } from '../helpers/fakeFetch.ts';
import { fixture } from '../helpers/fixtures.ts';

const NOW = Date.parse('2026-09-26T12:00:00.000Z');
const BERLIN = 'Europe/Berlin';
const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
const stats = () => fixture<ApiStatsPeriod[]>('statistics/stats.json');

const WINDOW: StatisticsWindow = {
  from: '2026-09-01T00:00:00.000Z',
  to: '2026-09-08T12:00:00.000Z',
  stepDurationHours: 24,
};

/** Returns the ToolError that `run` throws, and fails the test when it throws none. */
function errorOf(run: () => unknown): ToolError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ToolError);
    return error;
  }
  throw new assert.AssertionError({ message: 'Expected an error.' });
}

describe('constants', () => {
  it('keep the range at 32 days, the lookback one day inside the 62 days of alfaview, and periods at 768 hours', () => {
    assert.equal(MAX_STATISTICS_RANGE_MS, 32 * DAY_MS);
    assert.equal(STATISTICS_LOOKBACK_MS, 61 * DAY_MS);
    assert.equal(MAX_PERIOD_HOURS, 768);
    assert.equal(MAX_STATISTICS_PERIODS, 100);
  });
});

describe('checkStatisticsWindow', () => {
  const check = (from: string, to: string, stepHours: number) =>
    checkStatisticsWindow(from, to, stepHours, NOW);
  const recent = NOW - 10 * DAY_MS;
  const old = NOW - 70 * DAY_MS;

  it('keeps the UTC times and the period length', () => {
    assert.deepEqual(check(WINDOW.from, WINDOW.to, 24), WINDOW);
  });

  for (const [name, from, to, stepHours, message] of [
    ['to before from, before the range and the lookback', iso(old), iso(old - HOUR_MS), 24, 'to must be after from.'],
    ['to equal to from, which alfaview fails with 500', iso(recent), iso(recent), 24, 'to must be after from.'],
    [
      '32 days and 1 ms, before the lookback',
      iso(old),
      iso(old + MAX_STATISTICS_RANGE_MS + 1),
      24,
      'to must be at most 32 days after from.',
    ],
    [
      'from 61 days and 1 ms ago',
      iso(NOW - STATISTICS_LOOKBACK_MS - 1),
      iso(NOW - STATISTICS_LOOKBACK_MS - 1 + HOUR_MS),
      24,
      'from is more than 61 days ago. alfaview reports company statistics for the last 62 days.',
    ],
    [
      'more than 100 periods',
      iso(recent),
      iso(recent + 101 * HOUR_MS),
      1,
      'This gives 101 periods, and the tool returns at most 100. Raise stepDurationHours or shorten the time range.',
    ],
    [
      'a last period that is shorter, which counts as a period',
      iso(recent),
      iso(recent + 100 * HOUR_MS + 1),
      1,
      'This gives 101 periods, and the tool returns at most 100. Raise stepDurationHours or shorten the time range.',
    ],
  ] as const) {
    it(`refuses ${name}`, () => {
      const error = errorOf(() => check(from, to, stepHours));
      assert.deepEqual([error.code, error.message], ['InvalidInput', message]);
    });
  }

  it('accepts exactly 32 days, from exactly 61 days ago, and exactly 100 periods', () => {
    const oldest = NOW - STATISTICS_LOOKBACK_MS;
    assert.deepEqual(check(iso(oldest), iso(oldest + MAX_STATISTICS_RANGE_MS), 24), {
      from: iso(oldest),
      to: iso(oldest + MAX_STATISTICS_RANGE_MS),
      stepDurationHours: 24,
    });
    assert.equal(check(iso(recent), iso(recent + 100 * HOUR_MS), 1).stepDurationHours, 1);
    assert.equal(check(iso(recent), iso(recent + 1), 768).stepDurationHours, 768);
  });

  it('accepts a to in the future', () => {
    assert.equal(check(iso(NOW - HOUR_MS), iso(NOW + DAY_MS), 1).to, iso(NOW + DAY_MS));
  });
});

describe('listStatistics', () => {
  const statsRequest = (respond: ExpectedRequest['respond']): ExpectedRequest => ({
    method: 'GET',
    path: '/v2/stats',
    query: { from: WINDOW.from, to: WINDOW.to, stepDurationHours: '24' },
    respond,
  });

  it('asks for the window and the period length and returns the periods', async () => {
    const { api, fake } = testApi([loginRequest(), statsRequest({ status: 200, body: stats() })]);
    assert.deepEqual(await listStatistics(api, WINDOW), stats());
    fake.assertDone();
  });

  it('treats null and an empty body as no periods, and leaves out entries that are not objects', async () => {
    const [first] = stats();
    const { api, fake } = testApi([
      loginRequest(),
      statsRequest({ status: 200, body: 'null' }),
      statsRequest({ status: 200, body: '' }),
      statsRequest({ status: 200, body: [null, 'text', 3, [first], first] }),
    ]);
    assert.deepEqual(await listStatistics(api, WINDOW), []);
    assert.deepEqual(await listStatistics(api, WINDOW), []);
    assert.deepEqual(await listStatistics(api, WINDOW), [first]);
    fake.assertDone();
  });

  it('refuses a body that is not a list', async () => {
    const { api, fake } = testApi([loginRequest(), statsRequest({ status: 200, body: { from: WINDOW.from } })]);
    const error = await toolErrorOf(listStatistics(api, WINDOW));
    assert.deepEqual([error.code, error.message], [
      'InvalidResponse',
      'alfaview sent an unexpected statistics response.',
    ]);
    fake.assertDone();
  });

  it('explains a 403 with the user permission Manage Company, and keeps the messages of 400 and 422', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      statsRequest({ status: 403, body: { title: 'Forbidden', status: 403, detail: 'missing permission' } }),
      statsRequest({ status: 400, body: fixture('core/problem-400.json') }),
      statsRequest({ status: 422, body: { detail: 'from is too far in the past' } }),
    ]);
    const denied = await toolErrorOf(listStatistics(api, WINDOW));
    assert.deepEqual([denied.code, denied.message, denied.status], ['Forbidden', STATISTICS_DENIED_MESSAGE, 403]);
    assert.equal(
      STATISTICS_DENIED_MESSAGE,
      "alfaview did not return company statistics. The API key's user needs the user permission Manage Company.",
    );
    assert.equal(
      (await toolErrorOf(listStatistics(api, WINDOW))).message,
      'alfaview rejected the request: from must not be after to.',
    );
    assert.equal(
      (await toolErrorOf(listStatistics(api, WINDOW))).message,
      'alfaview could not process the input: from is too far in the past.',
    );
    fake.assertDone();
  });
});

describe('mapStatisticsPeriod', () => {
  it('maps a period with the seconds in minutes and the times in the time zone', () => {
    assert.deepEqual(mapStatisticsPeriod(stats()[0]!, BERLIN), {
      from: '2026-09-01T02:00:00+02:00',
      to: '2026-09-02T02:00:00+02:00',
      roomActiveCount: 4,
      roomSessionCount: 17,
      roomOnlineMinutes: 615,
      roomUserMinutes: 1020,
      meetingActiveCount: 1,
      meetingSessionCount: 3,
      meetingOnlineMinutes: 60,
      meetingUserMinutes: 150,
    });
  });

  it('rounds seconds to the nearest minute: 89 s gives 1, 90 s gives 2', () => {
    const period = mapStatisticsPeriod(stats()[5]!, BERLIN);
    assert.deepEqual([period.roomOnlineMinutes, period.roomUserMinutes], [1, 2]);
  });

  it('gives null for missing values, numbers that are not whole and times that are not set', () => {
    const empty = {
      from: null,
      to: null,
      roomActiveCount: null,
      roomSessionCount: null,
      roomOnlineMinutes: null,
      roomUserMinutes: null,
      meetingActiveCount: null,
      meetingSessionCount: null,
      meetingOnlineMinutes: null,
      meetingUserMinutes: null,
    };
    assert.deepEqual(mapStatisticsPeriod({}, BERLIN), empty);
    const sparse = {
      from: '0001-01-01T00:00:00Z',
      to: '2026-09-02T00:00:00Z',
      rooms: { activeCount: 1.5, sessionCount: 2, roomOnlineSeconds: '600' },
      meetings: null,
    } as unknown as ApiStatsPeriod;
    assert.deepEqual(mapStatisticsPeriod(sparse, 'UTC'), {
      ...empty,
      to: '2026-09-02T00:00:00+00:00',
      roomSessionCount: 2,
    });
  });
});

describe('mapCompanyStatistics', () => {
  it('gives the request without an ID and one period per period, the last one ending at to', () => {
    const output = mapCompanyStatistics(WINDOW, stats(), BERLIN);
    assert.deepEqual(
      [output.from, output.to, output.stepDurationHours, output.periodCount, output.periods.length],
      ['2026-09-01T02:00:00+02:00', '2026-09-08T14:00:00+02:00', 24, 8, 8],
    );
    assert.ok(!('id' in output));
    assert.deepEqual(Object.keys(output), ['from', 'to', 'stepDurationHours', 'periodCount', 'periods']);
    assert.deepEqual(
      [output.periods[7]?.from, output.periods[7]?.to],
      ['2026-09-08T02:00:00+02:00', '2026-09-08T14:00:00+02:00'],
    );
  });

  it('sorts the periods by start, a period without a start last, in whatever order they come', () => {
    const [first, second, third] = stats() as [ApiStatsPeriod, ApiStatsPeriod, ApiStatsPeriod];
    const unstarted = { ...third, from: undefined };
    const starts = (periods: ApiStatsPeriod[]) =>
      mapCompanyStatistics(WINDOW, periods, 'UTC').periods.map((period) => period.from);
    const expected = ['2026-09-01T00:00:00+00:00', '2026-09-01T00:00:00+00:00', '2026-09-02T00:00:00+00:00', null];
    assert.deepEqual(starts([unstarted, second, first, { ...first }]), expected);
    assert.deepEqual(starts([first, unstarted, { ...first }, second]), expected);
  });

  it('gives no periods for no periods', () => {
    assert.deepEqual(mapCompanyStatistics(WINDOW, [], 'UTC'), {
      from: '2026-09-01T00:00:00+00:00',
      to: '2026-09-08T12:00:00+00:00',
      stepDurationHours: 24,
      periodCount: 0,
      periods: [],
    });
  });
});
