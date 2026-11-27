// The readers of the dates, times and time zones of tool inputs. zod checks the types of the
// inputs first, so the readers take text only. Their errors are ToolError with code InvalidInput.
import { invalidInput } from '../alfaview/errors.ts';
import { DateTimeError, parseDateTime } from '../shared/dateTime.ts';
import { knownTimeZone } from '../shared/time.ts';

export { compact } from '../shared/inputs.ts';

/**
 * Reads a date and time in a form that parseDateTime accepts, and returns the instant as UTC ISO
 * 8601 with milliseconds. A value without an offset is local time in `timeZone`: a local time that
 * the clocks skip is refused, and one that they show twice gives the earlier instant. The message
 * of a refused value names `parameter`. Undefined gives undefined. zod refuses blank text before a
 * tool runs, so every text goes to the parser. `timeZone` must be a checked name (readTimeZone or
 * the configuration).
 */
export function readDateTime(
  value: string | undefined,
  parameter: string,
  timeZone: string,
): string | undefined {
  if (value === undefined) return undefined;
  try {
    return parseDateTime(value, parameter, timeZone).utc;
  } catch (error) {
    if (error instanceof DateTimeError) throw invalidInput(error.message);
    throw error;
  }
}

/**
 * Returns the time zone that `value` names: an IANA time zone name or `UTC` (knownTimeZone). Fixes
 * the case of a known name (`europe/berlin` gives `Europe/Berlin`) and keeps other accepted
 * spellings. `Local` is refused: alfaview reads it as the time zone of its own server. This server
 * does not know that zone, so it cannot read a local time of a call. Undefined gives undefined.
 */
export function readTimeZone(value: string | undefined, parameter: string): string | undefined {
  if (value === undefined) return undefined;
  const name = knownTimeZone(value.trim());
  if (name === undefined) {
    throw invalidInput(`${parameter} is not a valid time zone. Use a name such as Europe/Berlin.`);
  }
  return name;
}
