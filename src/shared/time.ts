/**
 * Timestamps from the API and time zone names. Nothing here reads the time zone of the process:
 * the time zone of the platform comes in as a value.
 */
import { formatLocalDateTime } from './dateTime.ts';

/** Timestamps before this year mean "not set": alfaview renders missing times as year 1. */
const FIRST_REAL_YEAR = 1971;

/**
 * Returns an ISO 8601 UTC string for a timestamp from the API, or `null` when the value is absent,
 * empty, unparsable or before 1971.
 */
export function normalizeTimestamp(value: unknown): string | null {
  let date: Date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    date = new Date(value.trim());
  } else {
    return null;
  }

  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < FIRST_REAL_YEAR) {
    return null;
  }
  return date.toISOString();
}

/** The time zone for defaults and labels when the platform has none, or one that is not valid. */
export const DEFAULT_TIME_ZONE = 'Europe/Berlin';

/** The form of a time zone name, such as `Europe/Berlin`, `UTC` or `Etc/GMT-1`. */
const TIME_ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

/**
 * Returns `name` as a time zone that `Intl` knows, or `undefined` when `name` does not have the
 * form of a time zone name or `Intl` refuses it. The form check comes first, because the `Intl` of
 * Node 24 also accepts an offset such as `+01:00`. The case of a name that `Intl` resolves to
 * itself is fixed (`europe/berlin` gives `Europe/Berlin`), so that the result does not depend on
 * how alfaview compares time zone names. Other accepted spellings, such as the alias `Etc/UTC`,
 * stay as given. `Local` is refused in any case, without asking `Intl`: alfaview reads it as the
 * time zone of its own server, so it names no zone that can read a time.
 */
export function knownTimeZone(name: string): string | undefined {
  if (!TIME_ZONE_NAME.test(name) || name.toLowerCase() === 'local') return undefined;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
  return resolved.toLowerCase() === name.toLowerCase() ? resolved : name;
}

/**
 * Returns the time zone of the platform as knownTimeZone gives it, else Europe/Berlin. `value` is
 * the time zone that the platform reports, such as that of a workflow. A placeholder such as
 * `DEFAULT` names no zone, so it gives Europe/Berlin too. Defaults of time zone fields, times in
 * dropdown labels and the outputs of operations without a time zone field use it.
 */
export function platformTimeZone(value: unknown): string {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return knownTimeZone(candidate) ?? DEFAULT_TIME_ZONE;
}

/**
 * Returns the time zone of a step: the time zone field when it names a zone, else the time zone of
 * the platform (platformTimeZone of `platformZone`). `chosen` is the result of readTimeZone.
 * `Local`, which alfaview reads as the time zone of its own server, names no zone here. Date and
 * time fields without an offset are read in this zone.
 */
export function stepTimeZone(chosen: string | undefined, platformZone: unknown): string {
  return chosen === undefined || chosen === 'Local' ? platformTimeZone(platformZone) : chosen;
}

/**
 * Formats a timestamp from the API as local time in `timeZone` with the zone name, for the
 * `...Local` outputs, for example `2026-10-27 10:00 Europe/Berlin`. Values that
 * normalizeTimestamp treats as not set give `null`. The text is for display: the parser refuses
 * it as input.
 */
export function formatLocalTimestamp(value: unknown, timeZone: string): string | null {
  const iso = normalizeTimestamp(value);
  return iso === null ? null : formatLocalDateTime(Date.parse(iso), timeZone);
}

/**
 * Formats a timestamp from the API as `YYYY-MM-DD HH:mm` in `timeZone`, for dropdown labels.
 * Values that `normalizeTimestamp` treats as not set give `null`. `timeZone` must be a name that
 * `Intl` accepts, for example the result of `platformTimeZone`.
 */
export function formatZonedDateTime(value: unknown, timeZone: string): string | null {
  const iso = normalizeTimestamp(value);
  if (iso === null) return null;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}
