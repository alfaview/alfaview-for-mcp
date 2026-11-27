// The messages of the date and time parser (src/shared/dateTime.ts) for a parameter name, as the
// tool tests expect them. The vectors in test/vectors/date-time.json pin every message with the
// label Start.

/** Returns the message for a value that has none of the accepted forms. */
export function unrecognizedDateTime(parameter: string): string {
  return `${parameter} is not a valid date and time. Use 2026-10-27 10:00 or 27.10.2026 10:00 (local time), 2026-10-27T10:00:00+01:00 (with an offset), 27/10/2026 10:00 or 10/27/2026 10:00 (only when the day is above 12), or Unix time in seconds or milliseconds.`;
}

/** Returns the message for a date or time that does not exist, for example a month 13. */
export function outOfRangeDateTime(parameter: string, value: string): string {
  return `${parameter}: ${value} is out of range. Check the year, the day, the month, the time and the offset.`;
}

/** Returns the message for a local time that the clocks skip in `timeZone`. */
export function nonexistentLocalTime(parameter: string, value: string, timeZone: string): string {
  return `${parameter}: ${value} does not exist in ${timeZone}, because the clocks go forward at that time. Use a later time, or give the time with an offset.`;
}
