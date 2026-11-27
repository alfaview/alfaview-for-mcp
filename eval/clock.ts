// The dates and times of the eval tasks. Each run starts at its own time t0, and the fake API moves
// its state to t0. A task names days relative to t0 in Berlin time, such as "yesterday" or "in
// three days", and gives the date in its prompt, so that the model does not have to guess "today".
// The checks compute the expected instants from the same clock.

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** The time zone of the server in every run (ALFAVIEW_TIME_ZONE) and of the task prompts. */
export const EVAL_TIME_ZONE = 'Europe/Berlin';

/** A date of the calendar, without a time. */
export type CalendarDay = {
  year: number;
  month: number;
  day: number;
  /** 2026-10-31 */
  iso: string;
  /** Saturday, October 31, 2026 */
  long: string;
};

export type Clock = {
  /** The start of the run: a whole minute, the time of the fake API's state. */
  t0: number;
  /** Returns the day `offset` days after the day of t0 in Berlin time. 0 is today, -1 yesterday. */
  day(offset: number): CalendarDay;
  /** Returns the instant of `time` (HH:MM) on `day` in `timeZone`, Berlin time when not given. */
  at(day: CalendarDay, time: string, timeZone?: string): number;
};

/**
 * Returns the calendar day of `year`, `month` and `day`. `day` can be out of range: 32 is a day of
 * the next month.
 */
function calendarDay(year: number, month: number, day: number): CalendarDay {
  const noon = new Date(Date.UTC(year, month - 1, day, 12));
  const long = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(noon);
  return {
    year: noon.getUTCFullYear(),
    month: noon.getUTCMonth() + 1,
    day: noon.getUTCDate(),
    iso: noon.toISOString().slice(0, 10),
    long,
  };
}

/** Returns the date and time fields of `instant` on the wall clock of `timeZone`. */
function wallClock(instant: number, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(instant);
  return Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]),
  );
}

/** Returns how far the wall clock of `timeZone` is ahead of UTC at `instant`, in milliseconds. */
export function offsetMs(instant: number, timeZone: string): number {
  const wall = wallClock(instant, timeZone);
  const asUtc = Date.UTC(wall.year!, wall.month! - 1, wall.day!, wall.hour!, wall.minute!, wall.second!);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * Returns the instant of `time` (HH:MM) on `day` on the wall clock of `timeZone`. Throws when
 * `time` is not HH:MM.
 */
export function zonedInstant(day: CalendarDay, time: string, timeZone: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (match === null) throw new Error(`expected a time HH:MM, got ${time}`);
  const local = Date.UTC(day.year, day.month - 1, day.day, Number(match[1]), Number(match[2]));
  // The second pass finds the offset at the instant itself, which differs near a change of the
  // daylight saving time.
  const first = local - offsetMs(local, timeZone);
  return local - offsetMs(first, timeZone);
}

/** Returns the clock of a run that starts at `t0`. */
export function clockOf(t0: number): Clock {
  const today = wallClock(t0, EVAL_TIME_ZONE);
  return {
    t0,
    day: (offset) => calendarDay(today.year!, today.month!, today.day! + offset),
    at: (day, time, timeZone = EVAL_TIME_ZONE) => zonedInstant(day, time, timeZone),
  };
}

/** Returns the wall clock time of `instant` in `timeZone` as HH:MM, Berlin time when not given. */
export function timeOf(instant: number, timeZone = EVAL_TIME_ZONE): string {
  const wall = wallClock(instant, timeZone);
  return `${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}`;
}

/** Returns the ISO text of an instant, as the fake API stores times. */
export function iso(instant: number): string {
  return new Date(instant).toISOString();
}
