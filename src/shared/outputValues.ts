/**
 * Converters from API response values to output values. Every output mapper emits every
 * documented key, so a value that is absent, empty or of an unexpected type becomes `null`
 * instead of being left out. Timestamps go through `normalizeTimestamp` in time.ts.
 */

/** Returns text as is. Empty strings and anything that is not text give `null`. */
export function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Returns `true` or `false` as is. Anything else gives `null`. */
export function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Returns whole numbers as is. Anything else gives `null`. */
export function integerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/** Returns the non-empty text entries of a list. Anything that is not a list gives `[]`. */
export function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}
