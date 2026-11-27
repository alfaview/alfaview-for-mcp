/**
 * Reads a date and time that a user typed or mapped, and turns a local time into an instant with
 * `Intl` only. Nothing here reads the time zone of the process.
 */

/** A local date and time, without an offset. `month` counts from 1. */
export type WallTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export type DateTimeErrorCode =
  | 'unrecognized'
  | 'ambiguous_date'
  | 'two_digit_year'
  | 'missing_time'
  | 'out_of_range'
  | 'nonexistent_local_time';

/** Thrown when the parser refuses a value. `message` names the field and is shown to the user. */
export class DateTimeError extends Error {
  readonly code: DateTimeErrorCode;

  constructor(code: DateTimeErrorCode, message: string) {
    super(message);
    this.name = 'DateTimeError';
    this.code = code;
  }
}

/** The result of parseDateTime. */
export type ParsedDateTime = {
  /** The instant, UTC ISO 8601 with milliseconds, for example 2026-10-27T09:00:00.000Z. */
  utc: string;
  /** The instant as local time in `timeZone`, for example 2026-10-27 10:00 Europe/Berlin. */
  local: string;
  /** The IANA time zone that read a value without an offset, and that `local` uses. */
  timeZone: string;
};

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * The first year and the range of instants that the parser accepts. alfaview writes a missing
 * time as year 1, so the outputs treat every time before 1971 as not set. The grammar allows at
 * most four digits, so no year is above 9999.
 */
const FIRST_YEAR = 1971;
const FIRST_INSTANT = Date.UTC(FIRST_YEAR, 0, 1);
const LAST_INSTANT = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/**
 * The range of the offsets of real time zones, in minutes. It is narrower than RFC 3339, so that a
 * time range such as `2026-10-27 10:00-13:00` is refused, not read as the offset -13:00.
 */
const SMALLEST_OFFSET_MINUTES = -12 * 60;
const LARGEST_OFFSET_MINUTES = 14 * 60;

// Without the u flag, \d matches only ASCII digits, and the i flag of the ISO form lets no
// character outside ASCII pass as T or Z. The dotted and slash forms match a two-digit year and
// a date without a time only to give them their own messages.
const TIME = '(\\d{1,2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d{1,9}))?)?';
const YEAR_AND_TIME = `(?:(\\d{4})|(\\d{2}))(?:(?:, ?| )${TIME})?$`;
const UNIX_SECONDS = /^([1-9]\d{9})(?:\.(\d{1,9}))?$/;
const UNIX_MILLISECONDS = /^[1-9]\d{12}$/;
const ISO_FORM = new RegExp(
  `^(\\d{4})-(\\d{2})-(\\d{2})(?:[T ]${TIME}(?: ?(Z|([+-])(\\d{2})(?::?(\\d{2}))?))?)?$`,
  'i',
);
const DOTTED_FORM = new RegExp(`^(\\d{1,2})\\.(\\d{1,2})\\.${YEAR_AND_TIME}`);
const SLASHED_FORM = new RegExp(`^(\\d{1,2})/(\\d{1,2})/${YEAR_AND_TIME}`);

/** A value that matched a form, before the range checks. */
type DateTimeParts = {
  year: number;
  month: number;
  day: number;
  /** Undefined when the value has no time. */
  hour: string | undefined;
  minute: string | undefined;
  second: string | undefined;
  fraction: string | undefined;
  /** The offset from UTC in minutes; undefined for a local time. */
  offsetMinutes: number | undefined;
};

/**
 * Reads `text` as ISO 8601 with or without an offset (`2026-10-27 10:00`), as a dotted date
 * (`27.10.2026 10:00`), as a slash date whose day is above 12 (`27/10/2026 10:00` or
 * `10/27/2026 10:00`), or as Unix time in seconds (10 digits) or milliseconds (13 digits). A
 * value without an offset is local time in `timeZone`. A local time that the clocks skip is
 * refused, and one that the clocks show twice gives the earlier instant. Throws a DateTimeError
 * for every refused value. `timeZone` must be a name that `Intl` accepts: for any other name this
 * throws the RangeError of `Intl` before it reads `text`, because the caller must check the name.
 */
export function parseDateTime(text: string, label: string, timeZone: string): ParsedDateTime {
  // Creating the formatter throws for an unknown zone, whatever the text is.
  wallTimeFormat(timeZone);
  const shown = text.trim().replace(/\s+/g, ' ');
  const instant = readInstant(shown, label, timeZone);
  return {
    utc: new Date(instant).toISOString(),
    local: formatLocalDateTime(instant, timeZone),
    timeZone,
  };
}

/** Returns the instant of the normalized text `shown`, in milliseconds since the epoch. */
function readInstant(shown: string, label: string, timeZone: string): number {
  const unixSeconds = UNIX_SECONDS.exec(shown);
  if (unixSeconds) return Number(unixSeconds[1]) * SECOND_MS + milliseconds(unixSeconds[2]);
  if (UNIX_MILLISECONDS.test(shown)) return Number(shown);

  const iso = ISO_FORM.exec(shown);
  if (iso) {
    const [, year, month, day, hour, minute, second, fraction, zone, sign, hours, minutes] = iso;
    // This reads the offset before the calendar and clock checks of instantOf. The order does not
    // change the result: an offset comes only with a time, and those checks give out_of_range too.
    const offsetMinutes =
      zone === undefined ? undefined : readOffsetMinutes(sign, hours, minutes, shown, label);
    const date = { year: Number(year), month: Number(month), day: Number(day) };
    const parts = { ...date, hour, minute, second, fraction, offsetMinutes };
    return instantOf(parts, shown, label, timeZone);
  }

  const dotted = DOTTED_FORM.exec(shown);
  if (dotted) {
    const [, day, month, year, shortYear, hour, minute, second, fraction] = dotted;
    if (shortYear !== undefined) throw twoDigitYear(shown, label);
    const date = { year: Number(year), month: Number(month), day: Number(day) };
    const parts = { ...date, hour, minute, second, fraction, offsetMinutes: undefined };
    return instantOf(parts, shown, label, timeZone);
  }

  const slashed = SLASHED_FORM.exec(shown);
  if (slashed) {
    const [, first, second, year, shortYear, hour, minute, seconds, fraction] = slashed;
    if (shortYear !== undefined) throw twoDigitYear(shown, label);
    const date = slashDate(Number(first), Number(second), Number(year), shown, label);
    const parts = { ...date, hour, minute, second: seconds, fraction, offsetMinutes: undefined };
    return instantOf(parts, shown, label, timeZone);
  }

  throw new DateTimeError(
    'unrecognized',
    `${label} is not a valid date and time. Use 2026-10-27 10:00 or 27.10.2026 10:00 (local time), 2026-10-27T10:00:00+01:00 (with an offset), 27/10/2026 10:00 or 10/27/2026 10:00 (only when the day is above 12), or Unix time in seconds or milliseconds.`,
  );
}

/**
 * Returns the offset of the ISO form in minutes: 0 for Z, else from the sign and the digits.
 * Refuses minutes above 59 and an offset outside the range of real time zones.
 */
function readOffsetMinutes(
  sign: string | undefined,
  hours: string | undefined,
  minutes: string | undefined,
  shown: string,
  label: string,
): number {
  if (sign === undefined) return 0;
  const minuteNumber = Number(minutes ?? '0');
  const offset = (sign === '-' ? -1 : 1) * (Number(hours) * 60 + minuteNumber);
  if (minuteNumber > 59 || offset < SMALLEST_OFFSET_MINUTES || offset > LARGEST_OFFSET_MINUTES) {
    throw outOfRange(shown, label);
  }
  return offset;
}

/**
 * Returns the date of a slash form: day first when the first part is above 12, month first when
 * only the second part is. Both parts between 1 and 12 are refused, also when they are equal: a
 * step that works on 5 May would fail on 5 June. A part of 0 is not ambiguous: it reads day first,
 * and the calendar check refuses it.
 */
function slashDate(
  first: number,
  second: number,
  year: number,
  shown: string,
  label: string,
): { year: number; month: number; day: number } {
  // The year check comes first, so that the suggestion never names a year that is refused.
  if (year < FIRST_YEAR) throw outOfRange(shown, label);
  if (isMonthNumber(first) && isMonthNumber(second)) {
    const day = twoDigits(first);
    const month = twoDigits(second);
    throw new DateTimeError(
      'ambiguous_date',
      `${label}: ${datePart(shown)} is ambiguous. Use ${day}.${month}.${year} or ${year}-${month}-${day}.`,
    );
  }
  const monthFirst = first <= 12 && second > 12;
  return monthFirst
    ? { year, month: first, day: second }
    : { year, month: second, day: first };
}

function isMonthNumber(value: number): boolean {
  return value >= 1 && value <= 12;
}

/**
 * Checks the parts and returns the instant. The first failing check gives the error: the calendar,
 * then a missing time, the clock, a local time that the clocks skip, and the range of instants.
 */
function instantOf(parts: DateTimeParts, shown: string, label: string, timeZone: string): number {
  const { year, month, day } = parts;
  if (year < FIRST_YEAR || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw outOfRange(shown, label);
  }
  if (parts.hour === undefined) {
    throw new DateTimeError(
      'missing_time',
      `${label}: ${shown} has a date but no time. Add the time, for example ${shown} 10:00.`,
    );
  }
  const wall: WallTime = {
    year,
    month,
    day,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second ?? '0'),
  };
  if (wall.hour > 23 || wall.minute > 59 || wall.second > 59) throw outOfRange(shown, label);

  let instant: number;
  if (parts.offsetMinutes === undefined) {
    const [earliest] = instantsOfWallTime(wall, timeZone);
    if (earliest === undefined) {
      throw new DateTimeError(
        'nonexistent_local_time',
        `${label}: ${shown} does not exist in ${timeZone}, because the clocks go forward at that time. Use a later time, or give the time with an offset.`,
      );
    }
    instant = earliest;
  } else {
    instant = wallTimeAsUtc(wall) - parts.offsetMinutes * MINUTE_MS;
  }

  instant += milliseconds(parts.fraction);
  if (instant < FIRST_INSTANT || instant > LAST_INSTANT) throw outOfRange(shown, label);
  return instant;
}

/** Returns the date part of `shown` as written: the text up to its first space or comma. */
function datePart(shown: string): string {
  return shown.replace(/[ ,].*$/, '');
}

function twoDigitYear(shown: string, label: string): DateTimeError {
  return new DateTimeError(
    'two_digit_year',
    `${label}: ${datePart(shown)} has a two-digit year. Write the year with four digits, for example 27.10.2026.`,
  );
}

function outOfRange(shown: string, label: string): DateTimeError {
  return new DateTimeError(
    'out_of_range',
    `${label}: ${shown} is out of range. Check the year, the day, the month, the time and the offset.`,
  );
}

/** Returns the milliseconds of a fraction of a second, cut, not rounded: `123456789` gives 123. */
function milliseconds(fraction: string | undefined): number {
  return Number((fraction ?? '').padEnd(3, '0').slice(0, 3));
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leapYear ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

/** Formatters by zone name in lowercase. */
const wallTimeFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * Returns the formatter of a zone. `Intl` throws a RangeError for a zone that it does not know.
 *
 * `Intl` reads zone names without case, so every spelling of a name shares one formatter. The
 * cache then holds at most one entry for each name, whatever case the callers send.
 */
function wallTimeFormat(timeZone: string): Intl.DateTimeFormat {
  const key = timeZone.toLowerCase();
  let format = wallTimeFormats.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    });
    wallTimeFormats.set(key, format);
  }
  return format;
}

/** Returns the local date and time of `instant` (milliseconds since the epoch) in `timeZone`. */
export function wallTimeAt(instant: number, timeZone: string): WallTime {
  const wall: WallTime = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const { type, value } of wallTimeFormat(timeZone).formatToParts(instant)) {
    if (type in wall) wall[type as keyof WallTime] = Number(value);
  }
  return wall;
}

/** Returns `wall` read as if it were UTC, in milliseconds since the epoch. */
export function wallTimeAsUtc(wall: WallTime): number {
  // setUTCFullYear keeps years below 100, which Date.UTC would move into the 1900s.
  const date = new Date(Date.UTC(2000, 0, 1, wall.hour, wall.minute, wall.second));
  return date.setUTCFullYear(wall.year, wall.month - 1, wall.day);
}

function sameWallTime(left: WallTime, right: WallTime): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
  );
}

/**
 * Returns the offset of `timeZone` from UTC at `instant`, in milliseconds. `instant` must be a
 * whole second: then the result is exact, also for an offset with seconds such as -00:44:30.
 */
function offsetAt(instant: number, timeZone: string): number {
  return wallTimeAsUtc(wallTimeAt(instant, timeZone)) - instant;
}

/**
 * Returns the instants at which the clocks in `timeZone` show `wall`: none, one or two, earliest
 * first. Every such instant is within 14 hours of `wall` read as UTC. When a zone changes its
 * offset at most once in two days, the offsets in force one day before and one day after include
 * every offset in that window. `Intl` checks each candidate by formatting it back.
 */
export function instantsOfWallTime(wall: WallTime, timeZone: string): number[] {
  const asUtc = wallTimeAsUtc(wall);
  const offsets = new Set(
    [asUtc - DAY_MS, asUtc, asUtc + DAY_MS].map((instant) => offsetAt(instant, timeZone)),
  );
  const instants: number[] = [];
  for (const offset of offsets) {
    const instant = asUtc - offset;
    if (sameWallTime(wallTimeAt(instant, timeZone), wall)) instants.push(instant);
  }
  return instants.sort((left, right) => left - right);
}

/**
 * Formats `instant` as local time in `timeZone`: `YYYY-MM-DD HH:mm`, then `:ss` only when the
 * second is not 0, then a space and `timeZone` as given, for example
 * `2026-10-27 10:00 Europe/Berlin`. Milliseconds are not shown.
 */
export function formatLocalDateTime(instant: number, timeZone: string): string {
  const wall = wallTimeAt(instant, timeZone);
  const year = String(wall.year).padStart(4, '0');
  const date = `${year}-${twoDigits(wall.month)}-${twoDigits(wall.day)}`;
  const seconds = wall.second === 0 ? '' : `:${twoDigits(wall.second)}`;
  return `${date} ${twoDigits(wall.hour)}:${twoDigits(wall.minute)}${seconds} ${timeZone}`;
}
