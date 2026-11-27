import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  describeApiError,
  invalidInput,
  invalidResponse,
  missingCreatedIdMessage,
  PROBLEM_ERRORS_MAX,
  PROBLEM_TEXT_MAX_CHARACTERS,
  readAfterSavedWrite,
  sendCreate,
  ToolError,
  UNCERTAIN_CREATE_CODES,
} from '../../src/alfaview/errors.ts';
import { loginRequest, testApi, toolErrorOf, type FakeAnswer } from '../helpers/fakeFetch.ts';
import { fixture } from '../helpers/fixtures.ts';

const problem = (name: string): string => JSON.stringify(fixture(`core/${name}.json`));
const PATH_GUEST_LINK = '/v2/guest-links/3f2a9c1e-7b4d-5e21-a3c4-14b7e9d0f6a2';

describe('ToolError', () => {
  it('keeps the code, the message, the status and the field locations', () => {
    const error = new ToolError('ValidationFailed', 'bad input.', 422, ['body.create[0].locale']);
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'ToolError');
    assert.equal(error.code, 'ValidationFailed');
    assert.equal(error.message, 'bad input.');
    assert.equal(error.status, 422);
    assert.deepEqual(error.fieldLocations, ['body.create[0].locale']);
  });

  it('has no status and no field locations by default', () => {
    const error = new ToolError('Timeout', 'slow.');
    assert.equal(error.status, undefined);
    assert.deepEqual(error.fieldLocations, []);
  });

  it('has short forms for invalid input and invalid responses', () => {
    assert.deepEqual(
      [invalidInput('wrong.').code, invalidInput('wrong.').message],
      ['InvalidInput', 'wrong.'],
    );
    assert.deepEqual(
      [invalidResponse('odd.').code, invalidResponse('odd.').message],
      ['InvalidResponse', 'odd.'],
    );
    assert.equal(
      missingCreatedIdMessage('guest link'),
      'alfaview did not return the ID of the new guest link.',
    );
  });
});

describe('sendCreate', () => {
  const UNCERTAIN = 'alfaview may have created it. Check before you create it again.';
  const BODY = { displayName: 'Project Room', type: 'room', waitingRoomEnabled: false };
  const create = (respond: FakeAnswer) => ({
    method: 'POST',
    path: '/v2/rooms',
    body: BODY,
    respond,
  });
  const send = (api: Parameters<typeof sendCreate>[0]) =>
    sendCreate<{ id: string }>(api, { method: 'POST', path: '/v2/rooms', body: BODY }, UNCERTAIN);

  it('returns the answer of a create', async () => {
    const { api, fake } = testApi([loginRequest(), create({ status: 201, body: { id: 'new' } })]);
    assert.deepEqual(await send(api), { status: 201, data: { id: 'new' } });
    fake.assertDone();
  });

  it('gives the uncertain message with ServerError and the status for 500, 502, 503 and 504', async () => {
    for (const status of [500, 502, 503, 504]) {
      const { api, fake } = testApi([loginRequest(), create({ status, body: fixture('core/problem-500.json') })]);
      const error = await toolErrorOf(send(api));
      assert.deepEqual([error.code, error.message, error.status], ['ServerError', UNCERTAIN, status]);
      fake.assertDone();
    }
  });

  it('gives the uncertain message with the code of a timeout and of a network error', async () => {
    const { api, fake } = testApi(
      [loginRequest(), create({ hang: true }), create({ networkError: 'ECONNRESET' })],
      { timeoutMs: 20 },
    );
    const timeout = await toolErrorOf(send(api));
    const network = await toolErrorOf(send(api));
    fake.assertDone();

    assert.deepEqual([timeout.code, timeout.message], ['Timeout', UNCERTAIN]);
    assert.deepEqual([network.code, network.message], ['NetworkError', UNCERTAIN]);
  });

  // The status of the answer comes before its body, so a create that alfaview saved can still
  // have an answer that is too large to read.
  it('gives the uncertain message for a success whose answer is too large to read', async () => {
    const { api, fake } = testApi(
      [loginRequest(), create({ status: 201, body: { id: 'new', padding: 'x'.repeat(2048) } })],
      { maxAnswerBytes: 1024 },
    );
    const error = await toolErrorOf(send(api));
    fake.assertDone();

    assert.deepEqual([error.code, error.message], ['AnswerTooLarge', UNCERTAIN]);
    assert.ok(UNCERTAIN_CREATE_CODES.includes('AnswerTooLarge'));
  });

  it('keeps every other error, after which nothing was created', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      create({ status: 422, body: fixture('core/problem-422.json') }),
    ]);
    const error = await toolErrorOf(send(api));
    fake.assertDone();

    assert.equal(error.code, 'ValidationFailed');
    assert.notEqual(error.message, UNCERTAIN);
  });
});

describe('readAfterSavedWrite', () => {
  const SAVED = 'alfaview saved it. Do not repeat it.';

  it('returns what the read gives', async () => {
    assert.equal(await readAfterSavedWrite(async () => 'meeting', SAVED), 'meeting');
  });

  it('keeps the code of a ToolError but gives the message that the write is saved', async () => {
    const read = async () => {
      throw new ToolError('ServerError', 'alfaview had a temporary problem (HTTP 503). Try again later.', 503);
    };
    await assert.rejects(readAfterSavedWrite(read, SAVED), (error) => {
      assert.ok(error instanceof ToolError);
      assert.deepEqual([error.code, error.message, error.status], ['ServerError', SAVED, undefined]);
      return true;
    });
  });

  it('gives any other error the code InvalidResponse', async () => {
    const read = async () => {
      throw new TypeError('marker');
    };
    await assert.rejects(readAfterSavedWrite(read, SAVED), (error) => {
      assert.ok(error instanceof ToolError);
      assert.deepEqual([error.code, error.message], ['InvalidResponse', SAVED]);
      return true;
    });
  });
});

describe('describeApiError', () => {
  it('maps 400 to BadRequest with the detail', () => {
    assert.deepEqual(describeApiError(400, problem('problem-400'), undefined), {
      code: 'BadRequest',
      message: 'alfaview rejected the request: from must not be after to.',
      fieldLocations: [],
    });
  });

  it('falls back to the title, then to the status text of node:http', () => {
    assert.equal(
      describeApiError(400, JSON.stringify({ title: 'Bad Request' }), undefined).message,
      'alfaview rejected the request: Bad Request.',
    );
    assert.equal(
      describeApiError(400, '', undefined).message,
      'alfaview rejected the request: Bad Request.',
    );
  });

  it('maps 403 to Forbidden and names the detail', () => {
    assert.deepEqual(describeApiError(403, problem('problem-403'), undefined), {
      code: 'Forbidden',
      message:
        "The API key's user is not allowed to do this (missing room join permissions). Give that user the needed room or user permission.",
      fieldLocations: [],
    });
  });

  it('maps 404 to NotFound and names the resource from the path', () => {
    assert.deepEqual(describeApiError(404, problem('problem-404'), PATH_GUEST_LINK), {
      code: 'NotFound',
      message:
        "alfaview could not find the guest link. It was deleted, or the API key's user cannot see it.",
      fieldLocations: [],
    });
  });

  it('maps 409 to Conflict with the detail and exactly one period', () => {
    assert.deepEqual(describeApiError(409, problem('problem-409'), undefined), {
      code: 'Conflict',
      message: 'Permissions for this participant already exist.',
      fieldLocations: [],
    });
  });

  it('maps 422 to ValidationFailed with every location without the body prefix', () => {
    assert.deepEqual(describeApiError(422, problem('problem-422'), undefined), {
      code: 'ValidationFailed',
      message:
        'alfaview could not process the input: validation failed. create[0].emailAddress: expected string to be RFC 5322 email. create[0].locale: expected value to be one of "de-DE, en-US".',
      fieldLocations: ['body.create[0].emailAddress', 'body.create[0].locale'],
    });
  });

  it('maps 422 errors without a location to their message and gives no location for them', () => {
    const content = JSON.stringify({
      detail: 'quota exceeded.',
      errors: [{ message: 'no dial-in.' }, { message: 'late.', location: 'body.timezone' }],
    });
    assert.deepEqual(describeApiError(422, content, undefined), {
      code: 'ValidationFailed',
      message: 'alfaview could not process the input: quota exceeded. no dial-in. timezone: late.',
      fieldLocations: ['body.timezone'],
    });
  });

  it('maps 429 to TooManyRequests', () => {
    assert.deepEqual(describeApiError(429, '', undefined), {
      code: 'TooManyRequests',
      message: 'alfaview received too many requests (HTTP 429). Try again later.',
      fieldLocations: [],
    });
  });

  for (const status of [500, 502, 503, 599]) {
    it(`maps ${status} to ServerError`, () => {
      assert.deepEqual(describeApiError(status, problem('problem-500'), undefined), {
        code: 'ServerError',
        message: `alfaview had a temporary problem (HTTP ${status}). Try again later.`,
        fieldLocations: [],
      });
    });
  }

  it('maps other statuses to HttpError', () => {
    assert.deepEqual(describeApiError(401, problem('problem-401'), undefined), {
      code: 'HttpError',
      message:
        'alfaview answered with HTTP 401: An invalid access token was provided in the Authorization header.',
      fieldLocations: [],
    });
    assert.equal(
      describeApiError(418, '', undefined).message,
      "alfaview answered with HTTP 418: I'm a Teapot.",
    );
    assert.equal(
      describeApiError(499, '', undefined).message,
      'alfaview answered with HTTP 499: HTTP 499.',
    );
  });

  it('ends every message with exactly one period', () => {
    const content = JSON.stringify({ detail: 'something failed...  ' });
    for (const status of [400, 403, 404, 409, 422, 429, 500, 418]) {
      assert.match(describeApiError(status, content, PATH_GUEST_LINK).message, /[^.]\.$/);
    }
  });

  // The texts go to the model word for word. The trim of their final periods and spaces takes a
  // time that grows with the square of a long run of spaces or periods inside a text, so each text
  // is cut first.
  it('cuts each text of the answer and keeps at most 20 entries of errors[], in well under 100 ms', () => {
    const long = `a${' '.repeat(100_000)}b`;
    const dots = `a${'.'.repeat(100_000)}b`;
    const content = JSON.stringify({
      title: dots,
      detail: long,
      errors: Array.from({ length: 30 }, (_, index) => ({
        message: index === 0 ? dots : `bad ${index}.`,
        location: index === 1 ? `body.${'x'.repeat(1000)}` : `body.field${index}`,
      })),
    });
    const started = performance.now();
    const rejected = describeApiError(400, content, undefined);
    const invalid = describeApiError(422, content, undefined);
    const elapsed = performance.now() - started;

    assert.ok(elapsed < 100, `${elapsed} ms`);
    const cutText = `a${' '.repeat(PROBLEM_TEXT_MAX_CHARACTERS - 1)} (shortened)`;
    assert.equal(rejected.message, `alfaview rejected the request: ${cutText}.`);
    assert.equal(invalid.fieldLocations.length, PROBLEM_ERRORS_MAX);
    assert.equal(invalid.fieldLocations[1], `${`body.${'x'.repeat(1000)}`.slice(0, PROBLEM_TEXT_MAX_CHARACTERS)} (shortened)`);
    assert.ok(invalid.message.includes(' field19: bad 19.'), invalid.message);
    assert.ok(!invalid.message.includes('field20'), 'the 21st entry is left out');
    assert.ok(invalid.message.length < 15_000, String(invalid.message.length));
    assert.equal(
      describeApiError(400, JSON.stringify({ title: dots }), undefined).message,
      `alfaview rejected the request: a${'.'.repeat(PROBLEM_TEXT_MAX_CHARACTERS - 1)} (shortened).`,
    );
  });
});
