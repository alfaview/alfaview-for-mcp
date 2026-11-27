/**
 * Company statistics of `GET /v2/stats?from=&to=&stepDurationHours=`: the checks of the request
 * and the output of its periods.
 */
import { formatLocalDateTime } from './dateTime.ts';
import { createInputReaders } from './inputs.ts';
import { integerOrNull } from './outputValues.ts';
import type { Platform } from './platform.ts';
import { normalizeTimestamp } from './time.ts';

// Constants

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The longest range that alfaview accepts. */
export const MAX_STATISTICS_RANGE_MS = 32 * DAY_MS;

/**
 * How far back From may be. alfaview accepts 62 days against its own clock. One day of margin
 * keeps a From that passes this check from failing at alfaview on a small clock difference.
 */
export const STATISTICS_LOOKBACK_MS = 61 * DAY_MS;

/** The longest period that fits in the longest range: 32 days of hours. */
export const MAX_PERIOD_HOURS = 32 * 24;

/** The message for a 403: the statistics need the user permission Manage Company. */
export const STATISTICS_DENIED_MESSAGE =
  "alfaview did not return company statistics. The API key's user needs the user permission Manage Company.";

const SECONDS_PER_MINUTE = 60;

// API shapes (spec: StatsPeriod, Stats)

export type ApiStats = {
  activeCount?: number;
  sessionCount?: number;
  roomOnlineSeconds?: number;
  usersOnlineSeconds?: number;
};

export type ApiStatsPeriod = { from?: string; to?: string; rooms?: ApiStats; meetings?: ApiStats };

/** The checked request of the statistics: UTC ISO strings and whole hours. */
export type StatisticsWindow = { from: string; to: string; stepDurationHours: number };

/**
 * Reads the periods of a `GET /v2/stats` answer. A missing or `null` body gives no periods, and
 * entries that are not objects are left out. Returns `undefined` for a body that is not a list, so
 * that the caller throws its response error.
 */
export function readStatisticsPeriods(data: unknown): ApiStatsPeriod[] | undefined {
  if (data === undefined || data === null) return [];
  if (!Array.isArray(data)) return undefined;
  return data.filter(
    (entry): entry is ApiStatsPeriod =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  );
}

// Output shapes and mappers

/** The counts of a period, with the seconds of the API as minutes. */
export type StatisticsCounts = {
  roomActiveCount: number | null;
  roomSessionCount: number | null;
  roomOnlineMinutes: number | null;
  roomUserMinutes: number | null;
  meetingActiveCount: number | null;
  meetingSessionCount: number | null;
  meetingOnlineMinutes: number | null;
  meetingUserMinutes: number | null;
};

/**
 * One period of the statistics. alfaview returns one period per `stepDurationHours` from `from`,
 * and the last one ends at `to`, so it can be shorter. A session that spans the edge of two
 * periods counts in both.
 */
export type StatisticsPeriodOutput = { from: string | null; to: string | null } & StatisticsCounts;

/**
 * The Company Statistics output. `fromLocal` and `toLocal` show the requested range as local time
 * in the time zone of the step, with the zone name. The periods keep UTC only: they follow from
 * the range.
 */
export type CompanyStatisticsOutput = {
  id: string;
  from: string;
  fromLocal: string;
  to: string;
  toLocal: string;
  stepDurationHours: number;
  periodCount: number;
  periods: StatisticsPeriodOutput[];
};

/** Returns seconds as whole minutes, rounded to the nearest minute as the attendance totals are. */
function minutes(seconds: unknown): number | null {
  const value = integerOrNull(seconds);
  return value === null ? null : Math.round(value / SECONDS_PER_MINUTE);
}

/** Returns the counts of one period, with the seconds as minutes. Absent values are `null`. */
export function statisticsCounts(period: ApiStatsPeriod): StatisticsCounts {
  return {
    roomActiveCount: integerOrNull(period.rooms?.activeCount),
    roomSessionCount: integerOrNull(period.rooms?.sessionCount),
    roomOnlineMinutes: minutes(period.rooms?.roomOnlineSeconds),
    roomUserMinutes: minutes(period.rooms?.usersOnlineSeconds),
    meetingActiveCount: integerOrNull(period.meetings?.activeCount),
    meetingSessionCount: integerOrNull(period.meetings?.sessionCount),
    meetingOnlineMinutes: minutes(period.meetings?.roomOnlineSeconds),
    meetingUserMinutes: minutes(period.meetings?.usersOnlineSeconds),
  };
}

/** Returns the output of one period: its UTC times and its counts. Absent values are `null`. */
export function mapStatisticsPeriod(period: ApiStatsPeriod): StatisticsPeriodOutput {
  return {
    from: normalizeTimestamp(period.from),
    to: normalizeTimestamp(period.to),
    ...statisticsCounts(period),
  };
}

/** Sorts the earliest period first. A period without a readable start goes last. */
function byPeriodStart(left: StatisticsPeriodOutput, right: StatisticsPeriodOutput): number {
  if (left.from === right.from) return 0;
  if (left.from === null) return 1;
  if (right.from === null) return -1;
  return left.from < right.from ? -1 : 1;
}

/**
 * Returns the Company Statistics output: the request with its local times in `timeZone`, the time
 * zone of the step, and its periods sorted by start.
 */
export function mapCompanyStatistics(
  window: StatisticsWindow,
  periods: readonly ApiStatsPeriod[],
  timeZone: string,
): CompanyStatisticsOutput {
  const lineItems = periods.map(mapStatisticsPeriod).sort(byPeriodStart);
  return {
    id: `${window.from}|${window.to}|${window.stepDurationHours}`,
    from: window.from,
    fromLocal: formatLocalDateTime(Date.parse(window.from), timeZone),
    to: window.to,
    toLocal: formatLocalDateTime(Date.parse(window.to), timeZone),
    stepDurationHours: window.stepDurationHours,
    periodCount: lineItems.length,
    periods: lineItems,
  };
}

// Checks

/** The names of the statistics fields in the messages of createStatisticsChecks. */
export type StatisticsLabels = {
  from: string;
  to: string;
  /** The period length field, read by checkStatisticsWindow. */
  periodLength: string;
};

/** The checks of createStatisticsChecks. */
export type StatisticsChecks = {
  /**
   * Refuses, in this order: To not after From, a range longer than MAX_STATISTICS_RANGE_MS, and a
   * From more than STATISTICS_LOOKBACK_MS before `now`. `start`, `end` and `now` are times in
   * milliseconds.
   */
  checkStatisticsRange: (start: number, end: number, now: number) => void;
  /**
   * Reads From, To and the period length, and refuses in this order: a missing or invalid From or
   * To, the rules of checkStatisticsRange, and a period length that is missing, not a whole number
   * or outside 1 to MAX_PERIOD_HOURS. The first failing rule gives the message. From and To
   * without an offset are local time in `timeZone`, the time zone of the step.
   */
  checkStatisticsWindow: (
    from: unknown,
    to: unknown,
    stepHours: unknown,
    now: number,
    timeZone: string,
  ) => StatisticsWindow;
};

/** Returns the statistics checks bound to `platform`, with the field names of `labels`. */
export function createStatisticsChecks(
  platform: Platform,
  labels: StatisticsLabels,
): StatisticsChecks {
  const { readDateTime, readInteger } = createInputReaders(platform);

  function checkStatisticsRange(start: number, end: number, now: number): void {
    // Strict on purpose: with To equal to From the statistics have no period to fill, and
    // alfaview answers 422. This check refuses it before the request, with the field names.
    if (end <= start) throw platform.invalidInput(`${labels.to} must be after ${labels.from}.`);
    if (end - start > MAX_STATISTICS_RANGE_MS) {
      throw platform.invalidInput(`${labels.to} must be at most 32 days after ${labels.from}.`);
    }
    if (start < now - STATISTICS_LOOKBACK_MS) {
      throw platform.invalidInput(
        `${labels.from} is more than 61 days ago. alfaview reports company statistics for the last 62 days.`,
      );
    }
  }

  return {
    checkStatisticsRange,
    checkStatisticsWindow(from, to, stepHours, now, timeZone) {
      const fromIso = readDateTime(from, labels.from, timeZone);
      if (fromIso === undefined) throw platform.invalidInput(`${labels.from} is required.`);
      const toIso = readDateTime(to, labels.to, timeZone);
      if (toIso === undefined) throw platform.invalidInput(`${labels.to} is required.`);

      checkStatisticsRange(Date.parse(fromIso), Date.parse(toIso), now);

      const stepDurationHours = readInteger(stepHours, labels.periodLength, {
        min: 1,
        max: MAX_PERIOD_HOURS,
      });
      if (stepDurationHours === undefined) {
        throw platform.invalidInput(`${labels.periodLength} is required.`);
      }
      return { from: fromIso, to: toIso, stepDurationHours };
    },
  };
}
