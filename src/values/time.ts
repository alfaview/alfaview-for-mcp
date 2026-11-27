// The times of tool results: ISO 8601 with the offset of a time zone and whole seconds, so that a
// model reads the local time without a conversion from UTC. The other time rules come from
// ../shared/time.ts.
import { wallTimeAsUtc, wallTimeAt } from '../shared/dateTime.ts';
import { normalizeTimestamp } from '../shared/time.ts';

export {
  DEFAULT_TIME_ZONE,
  formatLocalTimestamp,
  knownTimeZone,
  normalizeTimestamp,
} from '../shared/time.ts';

const MINUTE_MS = 60 * 1000;

/** Returns the whole second at or before `instant`. */
function wholeSecond(instant: number): number {
  return instant - (((instant % 1000) + 1000) % 1000);
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

/** Formats an offset in minutes as `+02:00`, `-05:00`, `+05:45` or `+00:00`. */
function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

/**
 * Formats `instant` (milliseconds since the epoch) as ISO 8601 in `timeZone`, with its offset and
 * whole seconds, for example `2026-10-07T18:00:00+02:00`. A fraction of a second is cut off.
 */
export function formatInstant(instant: number, timeZone: string): string {
  const second = wholeSecond(instant);
  const wall = wallTimeAt(second, timeZone);
  const offset = Math.round((wallTimeAsUtc(wall) - second) / MINUTE_MS);
  const date = `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`;
  const time = `${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`;
  return `${date}T${time}${formatOffset(offset)}`;
}

/** Returns the instant of an alfaview timestamp in milliseconds, or `null` when it is not set. */
export function instantOf(value: unknown): number | null {
  const iso = normalizeTimestamp(value);
  return iso === null ? null : Date.parse(iso);
}

/**
 * Formats a timestamp from the API or an ISO string as ISO 8601 in `timeZone`, as formatInstant
 * does. Values that `normalizeTimestamp` treats as not set give `null`.
 */
export function formatTimestamp(value: unknown, timeZone: string): string | null {
  const instant = instantOf(value);
  return instant === null ? null : formatInstant(instant, timeZone);
}
