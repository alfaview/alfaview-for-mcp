// The readers of src/values/inputs.ts. The tests of readDateTime check what it adds to
// parseDateTime: the ToolError, undefined, and an unknown zone as a programming error. The tests of
// readTimeZone also run the time zone vectors of test/vectors/date-time.json.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ToolError } from '../../src/alfaview/errors.ts';
import { readDateTime, readTimeZone } from '../../src/values/inputs.ts';

type TimeZoneVector = {
  input: string;
  name?: string;
  error?: 'invalid_time_zone';
  note: string;
};

const vectors = JSON.parse(
  readFileSync(new URL('../vectors/date-time.json', import.meta.url), 'utf8'),
) as { timeZones: TimeZoneVector[] };

/** Returns the ToolError that `read` throws, and fails the test when it throws none. */
function errorOf(read: () => unknown): ToolError {
  try {
    read();
  } catch (error) {
    assert.ok(error instanceof ToolError);
    return error;
  }
  throw new assert.AssertionError({ message: 'Expected the reader to throw.' });
}

const UNRECOGNIZED_VALID_UNTIL =
  'validUntil is not a valid date and time. Use 2026-10-27 10:00 or 27.10.2026 10:00 (local time), 2026-10-27T10:00:00+01:00 (with an offset), 27/10/2026 10:00 or 10/27/2026 10:00 (only when the day is above 12), or Unix time in seconds or milliseconds.';

describe('readDateTime', () => {
  for (const [value, expected] of [
    ['2026-10-07T10:45:00+02:00', '2026-10-07T08:45:00.000Z'],
    ['2026-10-07T08:45:00Z', '2026-10-07T08:45:00.000Z'],
    ['2026-10-07 10:45:00+0200', '2026-10-07T08:45:00.000Z'],
    ['2026-10-07T03:45:00.5-05:00', '2026-10-07T08:45:00.500Z'],
    [' 2026-10-07T08:45:00Z ', '2026-10-07T08:45:00.000Z'],
    ['1791362700', '2026-10-07T08:45:00.000Z'],
  ] as const) {
    it(`reads ${value} as ${expected}, whatever the time zone`, () => {
      assert.equal(readDateTime(value, 'validFrom', 'Asia/Tokyo'), expected);
    });
  }

  for (const [value, timeZone, expected] of [
    ['2026-10-07T18:00', 'Europe/Berlin', '2026-10-07T16:00:00.000Z'],
    ['07.10.2026 18:00', 'Europe/Berlin', '2026-10-07T16:00:00.000Z'],
    ['2026-12-12 09:00', 'Europe/Berlin', '2026-12-12T08:00:00.000Z'],
    ['2026-10-07T18:00', 'America/New_York', '2026-10-07T22:00:00.000Z'],
    ['2026-10-07T18:00', 'Asia/Kolkata', '2026-10-07T12:30:00.000Z'],
    ['2026-10-07T18:00', 'Australia/Sydney', '2026-10-07T07:00:00.000Z'],
  ] as const) {
    it(`reads the local time ${value} in ${timeZone} as ${expected}`, () => {
      assert.equal(readDateTime(value, 'start', timeZone), expected);
    });
  }

  it('reads a local time that the clocks show twice as the earlier instant', () => {
    assert.equal(
      readDateTime('2026-10-25T02:30', 'validFrom', 'Europe/Berlin'),
      '2026-10-25T00:30:00.000Z',
    );
    assert.equal(
      readDateTime('2026-10-25T02:30:00+01:00', 'validFrom', 'Europe/Berlin'),
      '2026-10-25T01:30:00.000Z',
    );
  });

  it('gives undefined for undefined', () => {
    assert.equal(readDateTime(undefined, 'validFrom', 'Europe/Berlin'), undefined);
  });

  for (const [name, value, message] of [
    ['free text', 'tomorrow 9am', UNRECOGNIZED_VALID_UNTIL],
    // zod refuses blank text before a tool runs, so the reader gives empty text to the parser too.
    ['an empty text', '', UNRECOGNIZED_VALID_UNTIL],
    [
      'an ambiguous slash date',
      '05/10/2026 10:00',
      'validUntil: 05/10/2026 is ambiguous. Use 05.10.2026 or 2026-10-05.',
    ],
    [
      'a date without a time',
      '2026-10-07',
      'validUntil: 2026-10-07 has a date but no time. Add the time, for example 2026-10-07 10:00.',
    ],
    [
      'February 29 in a common year',
      '2027-02-29T10:00:00Z',
      'validUntil: 2027-02-29T10:00:00Z is out of range. Check the year, the day, the month, the time and the offset.',
    ],
    [
      'a local time that the clocks skip',
      '2026-03-29T02:30',
      'validUntil: 2026-03-29T02:30 does not exist in Europe/Berlin, because the clocks go forward at that time. Use a later time, or give the time with an offset.',
    ],
  ] as const) {
    it(`refuses ${name} with the message of the parser`, () => {
      const error = errorOf(() => readDateTime(value, 'validUntil', 'Europe/Berlin'));
      assert.deepEqual([error.code, error.message], ['InvalidInput', message]);
    });
  }

  // Every caller passes a checked zone, so an unknown one is a programming error, which the tool
  // wrapper answers with its internal error.
  it('lets the RangeError of Intl through for a zone that Intl refuses', () => {
    assert.throws(
      () => readDateTime('2026-10-07T18:00', 'start', 'Mars/Olympus_Mons'),
      (error) => error instanceof RangeError && !(error instanceof ToolError),
    );
  });
});

describe('readTimeZone', () => {
  for (const [value, expected] of [
    ['Europe/Berlin', 'Europe/Berlin'],
    ['europe/berlin', 'Europe/Berlin'],
    ['America/New_York', 'America/New_York'],
    ['UTC', 'UTC'],
    ['utc', 'UTC'],
    [' Europe/Berlin ', 'Europe/Berlin'],
  ] as const) {
    it(`reads ${value} as ${expected}`, () => {
      assert.equal(readTimeZone(value, 'timezone'), expected);
    });
  }

  it('keeps an accepted alias as typed', () => {
    assert.equal(readTimeZone('Etc/UTC', 'timezone'), 'Etc/UTC');
  });

  it('gives undefined for undefined', () => {
    assert.equal(readTimeZone(undefined, 'timezone'), undefined);
  });

  for (const value of ['Mars/Olympus_Mons', '+02:00', 'Europe Berlin', 'Berlin/', 'Local', 'local']) {
    it(`refuses ${value} and names the parameter`, () => {
      const error = errorOf(() => readTimeZone(value, 'timezone'));
      assert.deepEqual([error.code, error.message], [
        'InvalidInput',
        'timezone is not a valid time zone. Use a name such as Europe/Berlin.',
      ]);
    });
  }
});

describe('readTimeZone with the time zone vectors', () => {
  for (const [index, vector] of vectors.timeZones.entries()) {
    it(`${index + 1}: ${JSON.stringify(vector.input)}, ${vector.note}`, () => {
      const read = () => readTimeZone(vector.input, 'timezone');
      if (vector.error === undefined) {
        assert.equal(read(), vector.name);
        return;
      }
      assert.equal(vector.error, 'invalid_time_zone');
      const error = errorOf(read);
      assert.ok(error instanceof ToolError);
      assert.deepEqual(
        [error.code, error.message],
        ['InvalidInput', 'timezone is not a valid time zone. Use a name such as Europe/Berlin.'],
      );
    });
  }
});
