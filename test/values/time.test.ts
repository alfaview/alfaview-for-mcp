// Each output time has the offset of its time zone and no fraction of a second.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatInstant, formatTimestamp } from '../../src/values/time.ts';

describe('formatTimestamp', () => {
  for (const [name, value, timeZone, expected] of [
    ['summer time in Berlin', '2026-10-07T16:00:00Z', 'Europe/Berlin', '2026-10-07T18:00:00+02:00'],
    ['winter time in Berlin', '2026-12-12T08:00:00Z', 'Europe/Berlin', '2026-12-12T09:00:00+01:00'],
    ['a zone at UTC', '2026-10-07T16:00:00Z', 'UTC', '2026-10-07T16:00:00+00:00'],
    ['a zone behind UTC', '2026-10-07T16:00:00Z', 'America/New_York', '2026-10-07T12:00:00-04:00'],
    ['a half-hour offset', '2026-10-07T16:00:00Z', 'Asia/Kolkata', '2026-10-07T21:30:00+05:30'],
    ['a 45-minute offset', '2026-10-07T16:00:00Z', 'Asia/Kathmandu', '2026-10-07T21:45:00+05:45'],
    ['a change of the date', '2026-10-12T23:30:00Z', 'Europe/Berlin', '2026-10-13T01:30:00+02:00'],
    ['midnight as 00, not 24', '2026-10-12T22:00:00Z', 'Europe/Berlin', '2026-10-13T00:00:00+02:00'],
    ['the last second of summer time', '2026-10-25T00:59:59Z', 'Europe/Berlin', '2026-10-25T02:59:59+02:00'],
    ['the first second of winter time', '2026-10-25T01:00:00Z', 'Europe/Berlin', '2026-10-25T02:00:00+01:00'],
    ['a fraction of a second, which is cut off', '2026-10-07T16:00:00.999Z', 'Europe/Berlin', '2026-10-07T18:00:00+02:00'],
    ['an input with an offset', '2026-10-07T18:00:00+02:00', 'UTC', '2026-10-07T16:00:00+00:00'],
  ] as const) {
    it(`formats ${name}`, () => {
      assert.equal(formatTimestamp(value, timeZone), expected);
    });
  }

  for (const [name, value] of [
    ['null', null],
    ['an unparsable value', 'soon'],
    ['the year-1 value', '0001-01-01T00:00:00Z'],
    ['a time in 1970', '1970-06-01T00:00:00Z'],
  ] as const) {
    it(`returns null for ${name}`, () => {
      assert.equal(formatTimestamp(value, 'Europe/Berlin'), null);
    });
  }
});

describe('formatInstant', () => {
  it('formats an instant in milliseconds', () => {
    assert.equal(formatInstant(Date.parse('2026-10-07T16:00:00Z'), 'Europe/Berlin'), '2026-10-07T18:00:00+02:00');
  });

  it('gives the offset of the zone in the southern hemisphere, in its summer and its winter', () => {
    assert.equal(formatInstant(Date.parse('2026-01-15T00:00:00Z'), 'Australia/Sydney'), '2026-01-15T11:00:00+11:00');
    assert.equal(formatInstant(Date.parse('2026-07-15T00:00:00Z'), 'Australia/Sydney'), '2026-07-15T10:00:00+10:00');
  });
});
