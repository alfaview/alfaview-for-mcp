// get_company_statistics through an MCP SDK client.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STATISTICS_DENIED_MESSAGE } from '../../src/domain/statistics.ts';
import { STATISTICS_TOOLS } from '../../src/tools/statistics.ts';
import { READ_ANNOTATIONS } from '../../src/tools/tool.ts';
import { testClock } from '../helpers/clock.ts';
import { unrecognizedDateTime } from '../helpers/dateTimeMessages.ts';
import { loginRequest, type ExpectedRequest, type FakeAnswer } from '../helpers/fakeFetch.ts';
import { fixture } from '../helpers/fixtures.ts';
import { toolHarness, type HarnessOptions } from '../helpers/mcpClient.ts';

const NOW = '2026-09-26T12:00:00Z';

/** The first week of September in Berlin, as the stats fixture covers it: 2 hours ahead of UTC. */
const WEEK = { from: '2026-09-01T02:00', to: '2026-09-08T14:00' };

function statsRequest(
  query: { from: string; to: string; stepDurationHours: string },
  respond: FakeAnswer,
): ExpectedRequest {
  return { method: 'GET', path: '/v2/stats', query, respond };
}

const weekQuery = {
  from: '2026-09-01T00:00:00.000Z',
  to: '2026-09-08T12:00:00.000Z',
  stepDurationHours: '24',
};

function harness(expected: readonly ExpectedRequest[], options: HarnessOptions = {}) {
  return toolHarness(STATISTICS_TOOLS, expected, { now: testClock(NOW).now, ...options });
}

describe('get_company_statistics', () => {
  it('is a read tool', async () => {
    const tools = await harness([]);
    const { tools: listed } = await tools.client.listTools();
    await tools.done();

    assert.deepEqual(
      listed.map((tool) => [tool.name, tool.annotations]),
      [['get_company_statistics', READ_ANNOTATIONS]],
    );
  });

  it('returns one period per day with minutes, in local time, with the default period length', async () => {
    const tools = await harness([
      loginRequest(),
      statsRequest(weekQuery, { status: 200, body: fixture('statistics/stats.json') }),
    ]);
    const result = await tools.call('get_company_statistics', WEEK);
    await tools.done();

    assert.equal(
      result.summary,
      '8 periods of 24 hours from 2026-09-01 02:00 Europe/Berlin to 2026-09-08 14:00 Europe/Berlin.',
    );
    const { periods, ...rest } = result.data;
    assert.deepEqual(rest, {
      from: '2026-09-01T02:00:00+02:00',
      to: '2026-09-08T14:00:00+02:00',
      stepDurationHours: 24,
      periodCount: 8,
      warnings: [],
    });
    assert.equal(periods.length, 8);
    assert.deepEqual(periods[0], {
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
    assert.deepEqual(
      [periods[5].roomOnlineMinutes, periods[5].roomUserMinutes, periods[7].to],
      [1, 2, '2026-09-08T14:00:00+02:00'],
    );
  });

  it('sorts the periods by their start', async () => {
    const tools = await harness([
      loginRequest(),
      statsRequest(weekQuery, { status: 200, body: fixture<unknown[]>('statistics/stats.json').reverse() }),
    ]);
    const result = await tools.call('get_company_statistics', { ...WEEK, stepDurationHours: 24 });
    await tools.done();

    assert.deepEqual(
      result.data.periods.map((period: { from: string }) => period.from.slice(0, 10)),
      ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08'],
    );
  });

  it('gives one total in the singular, with times that have an offset', async () => {
    const tools = await harness([
      loginRequest(),
      statsRequest(
        { from: '2026-09-25T08:00:00.000Z', to: '2026-09-25T09:00:00.000Z', stepDurationHours: '1' },
        { status: 200, body: [fixture<unknown[]>('statistics/stats.json')[0]] },
      ),
    ]);
    const result = await tools.call('get_company_statistics', {
      from: '2026-09-25T08:00:00Z',
      to: '2026-09-25T11:00:00+02:00',
      stepDurationHours: 1,
    });
    await tools.done();

    assert.equal(
      result.summary,
      '1 period of 1 hour from 2026-09-25 10:00 Europe/Berlin to 2026-09-25 11:00 Europe/Berlin.',
    );
  });

  // get_company_statistics has no timezone parameter: each parameter costs tokens in every
  // session, and a model can give an offset.
  it("reads from and to and gives every time in the server's time zone", async () => {
    const tools = await harness(
      [loginRequest(), statsRequest(weekQuery, { status: 200, body: fixture('statistics/stats.json') })],
      { timeZone: 'Australia/Sydney' },
    );
    const result = await tools.call('get_company_statistics', {
      from: '01.09.2026 10:00',
      to: '2026-09-08 22:00',
    });
    await tools.done();

    assert.equal(
      result.summary,
      '8 periods of 24 hours from 2026-09-01 10:00 Australia/Sydney to 2026-09-08 22:00 Australia/Sydney.',
    );
    assert.deepEqual(
      [result.data.from, result.data.to, result.data.periods[0].to],
      ['2026-09-01T10:00:00+10:00', '2026-09-08T22:00:00+10:00', '2026-09-02T10:00:00+10:00'],
    );
  });

  it('gives no periods for an empty answer', async () => {
    const tools = await harness([loginRequest(), statsRequest(weekQuery, { status: 200, body: null })]);
    const result = await tools.call('get_company_statistics', WEEK);
    await tools.done();

    assert.match(result.summary, /^0 periods of 24 hours from /);
    assert.deepEqual([result.data.periodCount, result.data.periods], [0, []]);
  });

  it('gives a winter time with its own offset', async () => {
    const tools = await harness(
      [
        loginRequest(),
        statsRequest(
          { from: '2026-12-01T23:00:00.000Z', to: '2026-12-02T23:00:00.000Z', stepDurationHours: '24' },
          { status: 200, body: [] },
        ),
      ],
      { now: testClock('2026-12-10T12:00:00Z').now },
    );
    const result = await tools.call('get_company_statistics', {
      from: '2026-12-02T00:00',
      to: '2026-12-03T00:00',
    });
    await tools.done();

    assert.deepEqual(
      [result.data.from, result.data.to],
      ['2026-12-02T00:00:00+01:00', '2026-12-03T00:00:00+01:00'],
    );
  });

  it('explains the missing user permission Manage Company', async () => {
    const tools = await harness([
      loginRequest(),
      statsRequest(weekQuery, { status: 403, body: fixture('core/problem-403.json') }),
    ]);
    const result = await tools.call('get_company_statistics', WEEK);
    await tools.done();

    assert.deepEqual([result.isError, result.summary], [true, STATISTICS_DENIED_MESSAGE]);
    assert.equal(
      STATISTICS_DENIED_MESSAGE,
      "alfaview did not return company statistics. The API key's user needs the user permission Manage Company.",
    );
  });

  it('checks the time range and the number of periods in order before any request', async () => {
    const tools = await harness([]);
    const cases: [Record<string, unknown>, string][] = [
      [{ from: 'last week', to: '2026-09-08T14:00' }, unrecognizedDateTime('from')],
      [{ from: '2026-09-08T14:00', to: '2026-09-01T02:00' }, 'to must be after from.'],
      [{ from: '2026-09-01T02:00', to: '2026-09-01T02:00' }, 'to must be after from.'],
      [{ from: '2026-08-01T00:00', to: '2026-09-03T00:00' }, 'to must be at most 32 days after from.'],
      [
        { from: '2026-07-20T00:00', to: '2026-07-21T00:00' },
        'from is more than 61 days ago. alfaview reports company statistics for the last 62 days.',
      ],
      [
        { from: '2026-09-01T00:00', to: '2026-09-06T00:00', stepDurationHours: 1 },
        'This gives 120 periods, and the tool returns at most 100. Raise stepDurationHours or shorten the time range.',
      ],
    ];
    for (const [input, message] of cases) {
      const result = await tools.call('get_company_statistics', input);
      assert.deepEqual([result.isError, result.summary], [true, message], JSON.stringify(input));
    }
    const schemaCases: Record<string, unknown>[] = [
      { from: '2026-09-01T02:00' },
      { ...WEEK, stepDurationHours: 0 },
      { ...WEEK, stepDurationHours: 769 },
      { ...WEEK, stepDurationHours: 1.5 },
      { ...WEEK, from: '  ' },
    ];
    for (const input of schemaCases) {
      const result = await tools.call('get_company_statistics', input);
      assert.equal(result.isError, true, JSON.stringify(input));
    }
    await tools.done();
  });
});
