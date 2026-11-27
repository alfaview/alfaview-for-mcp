// The statistics tool get_company_statistics. It needs the user permission Manage Company, which
// the recommended API key does not have, so docs/access-levels.md sets it up in a server entry of
// its own.
import * as z from 'zod';
import {
  checkStatisticsWindow,
  listStatistics,
  mapCompanyStatistics,
  MAX_PERIOD_HOURS,
} from '../domain/statistics.ts';
import { readDateTime } from '../values/inputs.ts';
import { formatLocalTimestamp } from '../values/time.ts';
import { toolOutput } from './outputs.ts';
import { count, dateTimeParameter, defineTool, READ_ANNOTATIONS } from './tool.ts';

const nullableCount = z.int().nullable();

export const getCompanyStatisticsTool = defineTool({
  name: 'get_company_statistics',
  level: 'read',
  title: 'Get company statistics',
  description:
    "Returns the use of the alfaview company's rooms and meetings per period: how many were used, the visits, and the minutes.",
  inputSchema: z.strictObject({
    from: dateTimeParameter('Start of the time range, at most 61 days ago.', 'server'),
    to: dateTimeParameter('End of the time range, at most 32 days after from.', 'server'),
    stepDurationHours: z
      .number()
      .int()
      .min(1)
      .max(MAX_PERIOD_HOURS)
      .default(24)
      .describe(
        'Hours of each period: 24 gives one period per day, and the hours between from and to give one total.',
      ),
  }),
  annotations: READ_ANNOTATIONS,
  personalData: { shape: 'mcp.statistics' },
  output: toolOutput({
    from: z.string(),
    to: z.string(),
    stepDurationHours: z.int(),
    periodCount: z.int(),
    periods: z.array(
      z.strictObject({
        from: z.string().nullable(),
        to: z.string().nullable(),
        roomActiveCount: nullableCount,
        roomSessionCount: nullableCount,
        roomOnlineMinutes: nullableCount,
        roomUserMinutes: nullableCount,
        meetingActiveCount: nullableCount,
        meetingSessionCount: nullableCount,
        meetingOnlineMinutes: nullableCount,
        meetingUserMinutes: nullableCount,
      }),
    ),
  }),
  async run(input, { api, now, timeZone }) {
    // readDateTime returns undefined only for an undefined value, and both times are required.
    const from = readDateTime(input.from, 'from', timeZone)!;
    const to = readDateTime(input.to, 'to', timeZone)!;
    const window = checkStatisticsWindow(from, to, input.stepDurationHours, now);
    const statistics = mapCompanyStatistics(window, await listStatistics(api, window), timeZone);
    const periods = count(statistics.periodCount, 'period');
    const hours = count(statistics.stepDurationHours, 'hour');
    // checkStatisticsWindow accepted both times, so neither local text is null.
    const shownFrom = formatLocalTimestamp(window.from, timeZone)!;
    const shownTo = formatLocalTimestamp(window.to, timeZone)!;
    return {
      summary: `${periods} of ${hours} from ${shownFrom} to ${shownTo}.`,
      data: statistics,
    };
  },
});

/** The statistics tools, in the order of the tool list. */
export const STATISTICS_TOOLS = [getCompanyStatisticsTool] as const;
