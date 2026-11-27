// The modules of src/shared work in the server: they load with their .ts imports, compile with the
// server's compiler, and give a ToolError through the MCP platform.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeApiError, ToolError } from '../src/alfaview/errors.ts';
import { fetchAllPages } from '../src/alfaview/pagination.ts';
import { checkWindow } from '../src/domain/attendance.ts';
import { checkValidity, PAST_VALID_UNTIL_MESSAGE } from '../src/domain/guestLinks.ts';
import { checkSchedule } from '../src/domain/meetings.ts';
import { checkStatisticsWindow } from '../src/domain/statistics.ts';
import { platform } from '../src/platform.ts';
import { guestUserIdOf } from '../src/shared/attendance.ts';
import { formatLocalTimestamp } from '../src/shared/time.ts';
import { readDateTime } from '../src/values/inputs.ts';
import { loginRequest, testApi, toolErrorOf } from './helpers/fakeFetch.ts';

describe('the modules of src/shared', () => {
  it('read the userId of the guest from the guest link, not from its ID', () => {
    assert.equal(
      guestUserIdOf({ id: '3f2a9c1e-7b4d-5e21-a3c4-14b7e9d0f6a2', userId: '5D6E7F80-91A2-5B3C-8D4E-2F5A6B7C8D9E' }),
      '5d6e7f80-91a2-5b3c-8d4e-2f5a6b7c8d9e',
    );
    assert.equal(guestUserIdOf({ id: '3f2a9c1e-7b4d-5e21-a3c4-14b7e9d0f6a2', userId: '' }), null);
  });

  it('load time.ts with its import of ./dateTime.ts', () => {
    assert.equal(
      formatLocalTimestamp('2026-10-27T09:00:00Z', 'Europe/Berlin'),
      '2026-10-27 10:00 Europe/Berlin',
    );
  });

  it('read a date and time with the shared parser', () => {
    assert.equal(
      readDateTime('27.10.2026 10:00', 'start', 'Europe/Berlin'),
      '2026-10-27T09:00:00.000Z',
    );
  });

  it('refuse a value with a ToolError of the code InvalidInput', () => {
    assert.throws(
      () => readDateTime('27.10.26 10:00', 'start', 'Europe/Berlin'),
      (error) =>
        error instanceof ToolError &&
        error.code === 'InvalidInput' &&
        error.message ===
          'start: 27.10.26 has a two-digit year. Write the year with four digits, for example 27.10.2026.',
    );
  });

  it('give the input error of the MCP platform as a ToolError of the code InvalidInput', () => {
    const error = platform.invalidInput('start must be after now.');
    assert.ok(error instanceof ToolError);
    assert.deepEqual([error.code, error.message], ['InvalidInput', 'start must be after now.']);
    assert.equal(platform.booleanWords, 'true or false');
  });

  it('bind the statistics range check to the MCP parameter names', () => {
    const now = Date.parse('2026-09-26T12:00:00Z');
    assert.throws(
      () => checkStatisticsWindow('2026-09-08T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 24, now),
      (error) =>
        error instanceof ToolError &&
        error.code === 'InvalidInput' &&
        error.message === 'to must be after from.',
    );
  });

  it('bind the schedule check of the meetings to the MCP parameter names', () => {
    const now = Date.parse('2026-10-07T08:00:00Z');
    const start = new Date(now + 60 * 60 * 1000).toISOString();
    assert.throws(
      () => checkSchedule(start, start, now),
      (error) =>
        error instanceof ToolError &&
        error.code === 'InvalidInput' &&
        error.message === 'end must be after start.',
    );
  });

  it('bind the validity check of the guest links to the MCP parameter names and past message', () => {
    const now = Date.parse('2026-09-25T12:00:00.000Z');
    assert.throws(
      () =>
        checkValidity(
          '2026-10-02T10:00:00.000Z',
          '2026-10-01T10:00:00.000Z',
          now,
          PAST_VALID_UNTIL_MESSAGE,
        ),
      (error) =>
        error instanceof ToolError &&
        error.code === 'InvalidInput' &&
        error.message === 'validUntil must be after validFrom.',
    );
    assert.throws(
      () => checkValidity(undefined, '2026-09-25T11:59:59.000Z', now, PAST_VALID_UNTIL_MESSAGE),
      (error) =>
        error instanceof ToolError &&
        error.message ===
          'validUntil is in the past, so the guest could not join. Check the event time.',
    );
  });

  it('bind the attendance window check to the MCP parameter names', () => {
    const now = Date.parse('2026-10-07T12:00:00Z');
    assert.throws(
      () => checkWindow(now + 1, now, now),
      (error) =>
        error instanceof ToolError &&
        error.code === 'InvalidInput' &&
        error.message === 'to must be after from.',
    );
  });

  it('give the page loop the MCP TooManyResults error', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      {
        method: 'GET',
        path: '/v2/group-links',
        query: { limit: '1' },
        respond: { status: 200, body: { data: [{ id: 'l1' }], nextPageToken: 't1' } },
      },
      {
        method: 'GET',
        path: '/v2/group-links',
        query: { limit: '1', pageToken: 't1' },
        respond: { status: 200, body: { data: [{ id: 'l2' }], nextPageToken: 't2' } },
      },
    ]);
    const error = await toolErrorOf(fetchAllPages(api, '/v2/group-links', { pageSize: 1, maxPages: 1 }));
    assert.deepEqual([error.code, error.message], [
      'TooManyResults',
      'alfaview returned more than 1 pages of group links.',
    ]);
    fake.assertDone();
  });

  it('give the error texts the status texts of Node', () => {
    assert.deepEqual(describeApiError(405, '', '/v2/rooms'), {
      code: 'HttpError',
      message: 'alfaview answered with HTTP 405: Method Not Allowed.',
      fieldLocations: [],
    });
  });
});
