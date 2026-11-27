/**
 * Readers of the values that a user types or maps into a field. An empty value gives `undefined`,
 * except in readRequiredString. A value that a reader cannot use, also one of the wrong type,
 * throws the input error of the platform, with a message that names the field.
 */
import { DateTimeError, parseDateTime } from './dateTime.ts';
import type { Platform } from './platform.ts';
import { knownTimeZone } from './time.ts';

/** The readers of createInputReaders. */
export type InputReaders = {
  /** Trims text. Numbers and booleans become text. Blank text and `null` give `undefined`. */
  readString: (value: unknown, label?: string) => string | undefined;
  /** Reads a required text field, for example Email Address or Guest Link. */
  readRequiredString: (value: unknown, label: string) => string;
  /**
   * Reads a list field of values that never contain a comma, such as language codes. A list gives
   * its trimmed text entries without the empty ones, and a text counts as a list of one entry.
   * Each entry is split at commas: a value mapped from another step often arrives as one text,
   * also as one entry of a list field. No entry left gives `undefined`.
   */
  readStringList: (value: unknown, label: string) => string[] | undefined;
  /** Accepts true, false, yes, no, 1 and 0 in any case. */
  readBoolean: (value: unknown, label: string) => boolean | undefined;
  /** Accepts a whole number, also as a digit string, optionally from `min` to `max` inclusive. */
  readInteger: (
    value: unknown,
    label: string,
    range?: { min?: number; max?: number },
  ) => number | undefined;
  /**
   * Reads a date and time field with parseDateTime and returns the instant as a UTC ISO string. A
   * value without an offset is local time in `timeZone`, the time zone of the step
   * (stepTimeZone). Empty means an empty value as given: a value that converts to nothing is
   * refused, so an optional Valid Until never turns into "no end limit" by mistake. A refused
   * value gives the parser's message, which names the field. `timeZone` must be a name that
   * `Intl` accepts: any other name throws the RangeError of `Intl`.
   */
  readDateTime: (value: unknown, label: string, timeZone: string) => string | undefined;
  /**
   * Accepts an IANA time zone name, `UTC` or `Local`, the values alfaview accepts. Fixes the case
   * of a known name (`europe/berlin` gives `Europe/Berlin`) and keeps other accepted spellings
   * (knownTimeZone).
   */
  readTimeZone: (value: unknown, label: string) => string | undefined;
};

function isEmpty(value: unknown): boolean {
  return (
    value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
  );
}

const TRUE_VALUES = new Set(['true', 'yes', '1']);
const FALSE_VALUES = new Set(['false', 'no', '0']);

/** Returns whether `value` has a `toISO()` function, such as a luxon DateTime. */
function hasToIso(value: unknown): value is { toISO: () => unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toISO?: unknown }).toISO === 'function'
  );
}

/**
 * Returns the text that readDateTime gives to the parser: text as it is, a number as its decimal
 * text (Unix time), a valid Date as its UTC ISO text, and the text that `toISO()` returns.
 * Anything else, also an invalid Date or a `toISO()` that returns no text (an invalid luxon
 * DateTime), becomes empty text, which no form accepts.
 */
function dateTimeText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (hasToIso(value)) {
    const iso = value.toISO();
    return typeof iso === 'string' ? iso : '';
  }
  return '';
}

/** Returns the readers bound to `platform`: its input error and the words of its yes/no fields. */
export function createInputReaders(platform: Platform): InputReaders {
  function readString(value: unknown, label = 'This field'): string | undefined {
    if (isEmpty(value)) return undefined;
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    throw platform.invalidInput(`${label} must be text.`);
  }

  function readRequiredString(value: unknown, label: string): string {
    const text = readString(value, label);
    if (text === undefined) throw platform.invalidInput(`${label} is required.`);
    return text;
  }

  function readStringList(value: unknown, label: string): string[] | undefined {
    const notAList = () => platform.invalidInput(`${label} must be a list of text values.`);
    let entries: unknown[];
    if (Array.isArray(value)) {
      entries = value;
    } else if (isEmpty(value)) {
      return undefined;
    } else if (typeof value === 'string') {
      entries = [value];
    } else {
      throw notAList();
    }

    const result: string[] = [];
    for (const entry of entries) {
      if (isEmpty(entry)) continue;
      if (typeof entry !== 'string') throw notAList();
      for (const part of entry.split(',')) {
        if (part.trim() !== '') result.push(part.trim());
      }
    }
    return result.length > 0 ? result : undefined;
  }

  function readBoolean(value: unknown, label: string): boolean | undefined {
    if (isEmpty(value)) return undefined;
    if (typeof value === 'boolean') return value;
    const text = String(value).trim().toLowerCase();
    if (TRUE_VALUES.has(text)) return true;
    if (FALSE_VALUES.has(text)) return false;
    throw platform.invalidInput(`${label} must be ${platform.booleanWords}.`);
  }

  function readInteger(
    value: unknown,
    label: string,
    range: { min?: number; max?: number } = {},
  ): number | undefined {
    if (isEmpty(value)) return undefined;
    const notWhole = () => platform.invalidInput(`${label} must be a whole number.`);

    let number: number;
    if (typeof value === 'number') {
      number = value;
    } else if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) {
      number = Number(value.trim());
    } else {
      throw notWhole();
    }
    if (!Number.isSafeInteger(number)) throw notWhole();

    const { min, max } = range;
    const tooSmall = min !== undefined && number < min;
    const tooLarge = max !== undefined && number > max;
    if (tooSmall || tooLarge) {
      if (min !== undefined && max !== undefined) {
        throw platform.invalidInput(`${label} must be between ${min} and ${max}.`);
      }
      if (min !== undefined) throw platform.invalidInput(`${label} must be ${min} or more.`);
      throw platform.invalidInput(`${label} must be ${max} or less.`);
    }
    return number;
  }

  /**
   * Returns the error of readDateTime for an error of the parser: a DateTimeError becomes the
   * input error of its message. Any other error, such as the RangeError of an unknown time zone,
   * is a programming error and stays as it is.
   */
  function dateTimeInputError(error: unknown): unknown {
    return error instanceof DateTimeError ? platform.invalidInput(error.message) : error;
  }

  function readDateTime(value: unknown, label: string, timeZone: string): string | undefined {
    if (isEmpty(value)) return undefined;
    try {
      return parseDateTime(dateTimeText(value), label, timeZone).utc;
    } catch (error) {
      throw dateTimeInputError(error);
    }
  }

  function readTimeZone(value: unknown, label: string): string | undefined {
    const text = readString(value, label);
    if (text === undefined) return undefined;
    if (text.toLowerCase() === 'local') return 'Local';

    const name = knownTimeZone(text);
    if (name === undefined) {
      throw platform.invalidInput(
        `${label} is not a valid time zone. Use a name such as Europe/Berlin.`,
      );
    }
    return name;
  }

  return {
    readString,
    readRequiredString,
    readStringList,
    readBoolean,
    readInteger,
    readDateTime,
    readTimeZone,
  };
}

/** Returns a copy of `object` without the keys whose value is `undefined`. */
export function compact<T extends Record<string, unknown>>(
  object: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) result[key] = value;
  }
  return result as { [K in keyof T]?: Exclude<T[K], undefined> };
}
