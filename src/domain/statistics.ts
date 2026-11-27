// The statistics of the company (`GET /v2/stats`): the use of its rooms and meetings per period.
import type { CallApi } from '../alfaview/client.ts';
import { invalidInput, invalidResponse, ToolError } from '../alfaview/errors.ts';
import { platform } from '../platform.ts';
import {
  createStatisticsChecks,
  readStatisticsPeriods,
  STATISTICS_DENIED_MESSAGE,
  statisticsCounts,
  type ApiStatsPeriod,
  type StatisticsCounts,
  type StatisticsWindow,
} from '../shared/statistics.ts';
import { formatTimestamp, normalizeTimestamp } from '../values/time.ts';
import { HOUR_MS } from './attendance.ts';

export {
  MAX_PERIOD_HOURS,
  MAX_STATISTICS_RANGE_MS,
  STATISTICS_DENIED_MESSAGE,
  STATISTICS_LOOKBACK_MS,
} from '../shared/statistics.ts';
export type { ApiStatsPeriod, StatisticsWindow } from '../shared/statistics.ts';

/** The most periods that get_company_statistics returns, so that its result stays small. */
export const MAX_STATISTICS_PERIODS = 100;

// Window

const { checkStatisticsRange } = createStatisticsChecks(platform, {
  from: 'from',
  to: 'to',
  periodLength: 'stepDurationHours',
});

/**
 * Returns the window of a statistics request. It throws InvalidInput, in this order, for `to` not
 * after `from`, a range over MAX_STATISTICS_RANGE_MS, a `from` more than STATISTICS_LOOKBACK_MS
 * before `now`, and more than MAX_STATISTICS_PERIODS periods. The first three follow the limits of
 * alfaview. `from` and `to` are UTC ISO strings, and zod keeps `stepDurationHours` between 1 and
 * MAX_PERIOD_HOURS.
 */
export function checkStatisticsWindow(
  from: string,
  to: string,
  stepDurationHours: number,
  now: number,
): StatisticsWindow {
  const start = Date.parse(from);
  const end = Date.parse(to);
  checkStatisticsRange(start, end, now);
  const periods = Math.ceil((end - start) / (stepDurationHours * HOUR_MS));
  if (periods > MAX_STATISTICS_PERIODS) {
    throw invalidInput(
      `This gives ${periods} periods, and the tool returns at most ${MAX_STATISTICS_PERIODS}. Raise stepDurationHours or shorten the time range.`,
    );
  }
  return { from, to, stepDurationHours };
}

// Request

/**
 * Returns the periods of `window` (`GET /v2/stats`). A 403 gives STATISTICS_DENIED_MESSAGE, an
 * answer of `null` gives no periods, and entries that are not objects are left out.
 */
export async function listStatistics(
  api: CallApi,
  window: StatisticsWindow,
): Promise<ApiStatsPeriod[]> {
  const { status, data } = await api.request<unknown>({
    method: 'GET',
    path: '/v2/stats',
    query: { from: window.from, to: window.to, stepDurationHours: window.stepDurationHours },
    allowStatuses: [403],
  });
  if (status === 403) throw new ToolError('Forbidden', STATISTICS_DENIED_MESSAGE, 403);
  const periods = readStatisticsPeriods(data);
  if (periods === undefined) {
    throw invalidResponse('alfaview sent an unexpected statistics response.');
  }
  return periods;
}

// Output shapes and mappers

export type StatisticsPeriod = { from: string | null; to: string | null } & StatisticsCounts;

export type CompanyStatistics = {
  from: string;
  to: string;
  stepDurationHours: number;
  periodCount: number;
  periods: StatisticsPeriod[];
};

/** Returns one period. Absent values are `null`, and the times have the offset of `timeZone`. */
export function mapStatisticsPeriod(period: ApiStatsPeriod, timeZone: string): StatisticsPeriod {
  return {
    from: formatTimestamp(period.from, timeZone),
    to: formatTimestamp(period.to, timeZone),
    ...statisticsCounts(period),
  };
}

/** Compares two periods by start: earliest first, and a period without a readable start last. */
function byPeriodStart(left: ApiStatsPeriod, right: ApiStatsPeriod): number {
  const leftStart = normalizeTimestamp(left.from);
  const rightStart = normalizeTimestamp(right.from);
  if (leftStart === rightStart) return 0;
  if (leftStart === null) return 1;
  if (rightStart === null) return -1;
  return leftStart < rightStart ? -1 : 1;
}

/** Returns the company statistics: the window of the request, and its periods sorted by start. */
export function mapCompanyStatistics(
  window: StatisticsWindow,
  periods: readonly ApiStatsPeriod[],
  timeZone: string,
): CompanyStatistics {
  const sorted = [...periods].sort(byPeriodStart);
  return {
    from: formatTimestamp(window.from, timeZone)!,
    to: formatTimestamp(window.to, timeZone)!,
    stepDurationHours: window.stepDurationHours,
    periodCount: sorted.length,
    periods: sorted.map((period) => mapStatisticsPeriod(period, timeZone)),
  };
}
