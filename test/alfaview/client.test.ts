import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AlfaviewClient,
  answerTooLargeMessage,
  CANCELED_MESSAGE,
  INACTIVE_ACCOUNT_MESSAGE,
  INVALID_CREDENTIALS_MESSAGE,
  LOGIN_REFUSAL_HOLD_MS,
  MAX_ANSWER_BYTES,
  MinuteWindow,
  NEW_TOKEN_REFUSED_MESSAGE,
  NO_ACCESS_TOKEN_MESSAGE,
  RATE_WINDOW_MS,
  REQUESTS_AT_A_TIME,
  REQUESTS_PER_MINUTE,
  REQUESTS_RATE_LIMITED_MESSAGE,
  REVOKED_CREDENTIALS_MESSAGE,
  UNUSABLE_ACCESS_TOKEN_MESSAGE,
  type ApiRequest,
} from '../../src/alfaview/client.ts';
import { ToolError } from '../../src/alfaview/errors.ts';
import { createLogger } from '../../src/log.ts';
import { testClock } from '../helpers/clock.ts';
import {
  fakeFetch,
  flush,
  loginRequest,
  TEST_CONFIG,
  testApi,
  toolErrorOf,
  untilRequests,
  type ExpectedRequest,
  type FakeAnswer,
} from '../helpers/fakeFetch.ts';
import { fixture } from '../helpers/fixtures.ts';

const GET_ROOMS: ApiRequest = { method: 'GET', path: '/v2/rooms' };

function getRooms(respond: FakeAnswer, token?: string): ExpectedRequest {
  return { method: 'GET', path: '/v2/rooms', respond, ...(token === undefined ? {} : { token }) };
}

const OK: FakeAnswer = { status: 200, body: { data: [] } };

function refusedLogin(status: number): ExpectedRequest {
  return { ...loginRequest(), respond: { status, body: fixture('core/problem-401.json') } };
}

/** Returns a login that answers with `then` once the test calls `release`. */
function gatedLogin(then: FakeAnswer = loginRequest().respond) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const request: ExpectedRequest = { ...loginRequest(), respond: { waitFor: gate, then } };
  return { request, release };
}

describe('AlfaviewClient login', () => {
  it('logs in at the first request of a call, never before', async () => {
    const { api, client, fake, logLines } = testApi([
      loginRequest(),
      { method: 'GET', path: '/v2/users/me', respond: { status: 200, body: { id: 'u1' } } },
    ]);
    client.forCall(new AbortController().signal);
    assert.equal(fake.requests.length, 0);

    assert.deepEqual(await api.request({ method: 'GET', path: '/v2/users/me' }), {
      status: 200,
      data: { id: 'u1' },
    });
    assert.equal(fake.requests[0]?.headers.get('authorization'), null);
    assert.equal(api.requestCount, 2);
    assert.deepEqual(logLines, ['alfaview-mcp: logged in\n']);
    fake.assertDone();
  });

  it('sends the token raw, without Bearer, and reuses it in later requests and calls', async () => {
    const { api, client, fake } = testApi([loginRequest(), getRooms(OK), getRooms(OK)]);
    await api.request(GET_ROOMS);
    const later = client.forCall(new AbortController().signal);
    await later.request(GET_ROOMS);

    assert.equal(fake.requests[1]?.headers.get('authorization'), 'token-1');
    assert.equal(api.requestCount, 2);
    assert.equal(later.requestCount, 1);
    fake.assertDone();
  });

  it('shares one login between concurrent requests', async () => {
    const { api, fake } = testApi([loginRequest(), getRooms(OK), getRooms(OK)]);
    await Promise.all([api.request(GET_ROOMS), api.request(GET_ROOMS)]);
    assert.equal(api.requestCount, 3);
    fake.assertDone();
  });

  it('logs in again once after a 401 and repeats the request', async () => {
    const { api, fake, logLines } = testApi([
      loginRequest(),
      getRooms({ status: 401, body: fixture('core/problem-401.json') }),
      loginRequest('token-2'),
      getRooms(OK, 'token-2'),
    ]);
    assert.deepEqual(await api.request(GET_ROOMS), { status: 200, data: { data: [] } });
    assert.equal(api.requestCount, 4);
    assert.deepEqual(logLines, [
      'alfaview-mcp: logged in\n',
      'alfaview-mcp: logged in again after HTTP 401\n',
    ]);
    fake.assertDone();
  });

  it('gives Unauthorized when the new token gets a 401 too', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      getRooms({ status: 401 }),
      loginRequest('token-2'),
      getRooms({ status: 401 }, 'token-2'),
    ]);
    const error = await toolErrorOf(api.request(GET_ROOMS));
    assert.deepEqual([error.code, error.message, error.status], [
      'Unauthorized',
      NEW_TOKEN_REFUSED_MESSAGE,
      401,
    ]);
    fake.assertDone();
  });

  it('lets two requests that both get a 401 share one new login', async () => {
    const { api, fake } = testApi(
      [
        loginRequest(),
        getRooms({ status: 401 }),
        getRooms({ status: 401 }),
        loginRequest('token-2'),
        getRooms(OK, 'token-2'),
        getRooms(OK, 'token-2'),
      ],
      { anyOrder: true },
    );
    await Promise.all([api.request(GET_ROOMS), api.request(GET_ROOMS)]);
    assert.equal(fake.requests.filter((request) => request.url.endsWith('/api-key')).length, 2);
    fake.assertDone();
  });

  it('refuses a first login with 401 for 5 minutes, then logs in again', async () => {
    const clock = testClock();
    const { api, client, fake, logLines } = testApi(
      [refusedLogin(401), loginRequest(), getRooms(OK)],
      { now: clock.now },
    );

    const first = await toolErrorOf(api.request(GET_ROOMS));
    assert.deepEqual([first.code, first.message, first.status], [
      'LoginRefused',
      INVALID_CREDENTIALS_MESSAGE,
      401,
    ]);
    clock.advance(LOGIN_REFUSAL_HOLD_MS - 1);
    const held = await toolErrorOf(client.forCall(new AbortController().signal).request(GET_ROOMS));
    assert.deepEqual([held.code, held.message], ['LoginRefused', INVALID_CREDENTIALS_MESSAGE]);
    assert.equal(fake.requests.length, 1);

    clock.advance(1);
    const later = client.forCall(new AbortController().signal);
    await later.request(GET_ROOMS);
    assert.equal(later.requestCount, 2);
    assert.deepEqual(logLines, [
      'alfaview-mcp: login refused (HTTP 401)\n',
      'alfaview-mcp: login allowed again after 5 minutes\n',
      'alfaview-mcp: logged in\n',
    ]);
    fake.assertDone();
  });

  it('refuses a later login with 401 as revoked credentials', async () => {
    const { api, fake } = testApi([loginRequest(), getRooms({ status: 401 }), refusedLogin(401)]);
    const error = await toolErrorOf(api.request(GET_ROOMS));
    assert.deepEqual([error.code, error.message], ['LoginRefused', REVOKED_CREDENTIALS_MESSAGE]);
    fake.assertDone();
  });

  it('refuses a login with 403 as an inactive account', async () => {
    const { api, fake, logLines } = testApi([refusedLogin(403)]);
    const error = await toolErrorOf(api.request(GET_ROOMS));
    assert.deepEqual([error.code, error.message, error.status], [
      'LoginRefused',
      INACTIVE_ACCOUNT_MESSAGE,
      403,
    ]);
    assert.deepEqual(logLines, ['alfaview-mcp: login refused (HTTP 403)\n']);
    fake.assertDone();
  });

  it('keeps no refusal after a 500, a login without a token or one that is not JSON', async () => {
    const { api, fake } = testApi([
      { ...loginRequest(), respond: { status: 500, body: fixture('core/problem-500.json') } },
      { ...loginRequest(), respond: { status: 200, body: {} } },
      { ...loginRequest(), respond: { status: 200, body: { accessToken: '' } } },
      { ...loginRequest(), respond: { status: 200, body: 'not json' } },
      { ...loginRequest(), respond: { status: 200, body: 'null' } },
      loginRequest(),
      getRooms(OK),
    ]);
    const serverError = await toolErrorOf(api.request(GET_ROOMS));
    assert.deepEqual([serverError.code, serverError.status], ['ServerError', 500]);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const error = await toolErrorOf(api.request(GET_ROOMS));
      assert.deepEqual([error.code, error.message], ['InvalidResponse', NO_ACCESS_TOKEN_MESSAGE]);
    }
    await api.request(GET_ROOMS);
    fake.assertDone();
  });

  // The client keeps only a token of visible ASCII characters. fetch refuses a header value with a
  // line break before the request goes out, so such a token would make each later request fail,
  // and no 401 would drop it.
  it('keeps no token outside visible ASCII, and logs in again at the next call', async () => {
    const { api, fake } = testApi([
      { ...loginRequest(), respond: { status: 200, body: { accessToken: 'abc\ndef' } } },
      { ...loginRequest(), respond: { status: 200, body: { accessToken: 'abc def' } } },
      { ...loginRequest(), respond: { status: 200, body: { accessToken: 'tökén' } } },
      loginRequest(),
      getRooms(OK),
    ]);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const error = await toolErrorOf(api.request(GET_ROOMS));
      assert.deepEqual([error.code, error.message, error.status], ['InvalidResponse', UNUSABLE_ACCESS_TOKEN_MESSAGE, 200]);
    }
    await api.request(GET_ROOMS);
    fake.assertDone();
    assert.equal(
      UNUSABLE_ACCESS_TOKEN_MESSAGE,
      'alfaview returned an access token that the server cannot send in a request. Try again later.',
    );
  });

  it('reports a login whose answer is too large to read, and keeps no token', async () => {
    const { api, fake } = testApi(
      [
        { ...loginRequest(), respond: { status: 200, body: { accessToken: 'x'.repeat(2048) } } },
        loginRequest(),
        getRooms(OK),
      ],
      { maxAnswerBytes: 1024 },
    );
    const error = await toolErrorOf(api.request(GET_ROOMS));
    await api.request(GET_ROOMS);
    fake.assertDone();

    assert.deepEqual([error.code, error.message], [
      'AnswerTooLarge',
      'alfaview sent an answer larger than 1024 bytes (POST /v2/auth/api-key), so the server did not read it. Try again later.',
    ]);
  });

  it('reports a login that does not answer in time', async () => {
    const { api, fake } = testApi([{ ...loginRequest(), respond: { hang: true } }], {
      timeoutMs: 50,
    });
    const error = await toolErrorOf(api.request(GET_ROOMS));
    assert.deepEqual([error.code, error.message], [
      'Timeout',
      'alfaview did not answer within 0.05 seconds (POST /v2/auth/api-key). Try again later.',
    ]);
    fake.assertDone();
  });

  it('reports a login that cannot reach alfaview', async () => {
    const { api, fake } = testApi([{ ...loginRequest(), respond: { networkError: 'ENOTFOUND' } }]);
    const error = await toolErrorOf(api.request(GET_ROOMS));
    assert.deepEqual([error.code, error.message], [
      'NetworkError',
      'alfaview could not be reached (POST /v2/auth/api-key, ENOTFOUND). Check the network connection, then try again.',
    ]);
    fake.assertDone();
  });

  it('lets a canceled call leave a shared login without stopping it for another call', async () => {
    const login = gatedLogin();
    const fake = fakeFetch([login.request, getRooms(OK)]);
    const client = new AlfaviewClient({ config: TEST_CONFIG, fetch: fake.fetch, log: createLogger(() => undefined) });
    const canceling = new AbortController();
    const first = client.forCall(canceling.signal);
    const second = client.forCall(new AbortController().signal);

    const firstRequest = first.request(GET_ROOMS);
    const secondRequest = second.request(GET_ROOMS);
    await flush();
    canceling.abort(new Error('any reason'));
    const error = await toolErrorOf(firstRequest);
    assert.deepEqual([error.code, error.message], ['Canceled', CANCELED_MESSAGE]);

    login.release();
    assert.equal((await secondRequest).status, 200);
    assert.equal(first.requestCount, 1);
    assert.equal(second.requestCount, 1);
    fake.assertDone();
  });

  it('gives every waiter the error of a failed login', async () => {
    const login = gatedLogin({ status: 401 });
    const fake = fakeFetch([login.request]);
    const client = new AlfaviewClient({ config: TEST_CONFIG, fetch: fake.fetch, log: createLogger(() => undefined) });
    const requests = [1, 2].map(() => client.forCall(new AbortController().signal).request(GET_ROOMS));
    await flush();
    login.release();
    for (const request of requests) {
      const error = await toolErrorOf(request);
      assert.deepEqual([error.code, error.message], ['LoginRefused', INVALID_CREDENTIALS_MESSAGE]);
    }
    fake.assertDone();
  });

  it('raises no unhandled rejection when a login fails after its only waiter left', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      const login = gatedLogin({ status: 503 });
      const canceling = new AbortController();
      const { api, fake } = testApi([login.request], { signal: canceling.signal });
      const request = api.request(GET_ROOMS);
      await flush();
      canceling.abort();
      assert.equal((await toolErrorOf(request)).code, 'Canceled');
      login.release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      fake.assertDone();
    } finally {
      process.off('unhandledRejection', listener);
    }
    assert.deepEqual(unhandled, []);
  });

  it('lets a waiter of a slow login leave at the call time limit', async () => {
    const { api, fake } = testApi([{ ...loginRequest(), respond: { hang: true } }], {
      callTimeLimitMs: 1_100,
      timeoutMs: 1_500,
    });
    const error = await toolErrorOf(api.request(GET_ROOMS));
    assert.deepEqual([error.code, error.message], [
      'Timeout',
      'The tool call reached its time limit of 1.1 seconds (GET /v2/rooms). alfaview answers slowly. Call the tool again.',
    ]);
    fake.assertDone();
  });

  it('never logs the key, the token or the credentials', async () => {
    const { api, fake, logLines } = testApi([
      loginRequest(),
      getRooms({ status: 401 }),
      loginRequest('token-2'),
      getRooms({ status: 401 }, 'token-2'),
      getRooms({ status: 401 }, 'token-2'),
      refusedLogin(401),
    ]);
    assert.equal((await toolErrorOf(api.request(GET_ROOMS))).code, 'Unauthorized');
    assert.equal((await toolErrorOf(api.request(GET_ROOMS))).code, 'LoginRefused');
    assert.equal(logLines.length, 3);
    const text = logLines.join('');
    for (const secret of ['secret-key-1', 'token-1', 'token-2', 'company-1', 'mcp-test']) {
      assert.ok(!text.includes(secret), `the log holds ${secret}`);
    }
    fake.assertDone();
  });
});

describe('AlfaviewClient requests', () => {
  async function requestWith(respond: FakeAnswer, request: ApiRequest = GET_ROOMS) {
    const { api, fake } = testApi([loginRequest(), getRooms(respond)]);
    try {
      return await api.request(request);
    } finally {
      fake.assertDone();
    }
  }

  it('sends the query without undefined values', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'GET', path: '/v2/rooms', query: { roomTypes: 'room', limit: '50' }, respond: OK },
    ]);
    await api.request({
      method: 'GET',
      path: '/v2/rooms',
      query: { roomTypes: 'room', pageToken: undefined, limit: 50 },
    });
    fake.assertDone();
  });

  it('sends a body as JSON, also an empty object', async () => {
    const meeting = {
      title: 'Review',
      start: '2026-10-05T09:00:00+02:00',
      end: '2026-10-05T10:00:00+02:00',
      timezone: 'Europe/Berlin',
      roomFeatures: {},
      waitingRoomEnabled: false,
    };
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'POST', path: '/v2/meetings', body: meeting, respond: { status: 201, body: { id: 'm1' } } },
      { method: 'PATCH', path: '/v2/meetings/m1', body: {}, respond: { status: 200, body: { id: 'm1' } } },
    ]);
    assert.deepEqual(await api.request({ method: 'POST', path: '/v2/meetings', body: meeting }), {
      status: 201,
      data: { id: 'm1' },
    });
    await api.request({ method: 'PATCH', path: '/v2/meetings/m1', body: {} });
    fake.assertDone();
  });

  it('gives undefined for an empty body', async () => {
    assert.deepEqual(await requestWith({ status: 204 }), { status: 204, data: undefined });
    assert.deepEqual(await requestWith({ status: 200, body: '  ' }), {
      status: 200,
      data: undefined,
    });
  });

  it('parses JSON whatever the content type says', async () => {
    assert.deepEqual(
      await requestWith({ status: 200, body: '{"a":1}', contentType: 'text/plain' }),
      { status: 200, data: { a: 1 } },
    );
  });

  it('refuses a successful answer that is not JSON', async () => {
    const error = await toolErrorOf(requestWith({ status: 200, body: '<html></html>' }));
    assert.deepEqual([error.code, error.message, error.status], [
      'InvalidResponse',
      'alfaview sent a response that is not JSON (HTTP 200).',
      200,
    ]);
  });

  it('reads an error answer that is not JSON as an empty problem', async () => {
    const error = await toolErrorOf(requestWith({ status: 400, body: '<html>Bad</html>' }));
    assert.deepEqual([error.code, error.message], [
      'BadRequest',
      'alfaview rejected the request: Bad Request.',
    ]);
  });

  it('returns an allowed error status without data', async () => {
    assert.deepEqual(
      await requestWith(
        { status: 404, body: fixture('core/problem-404.json') },
        { ...GET_ROOMS, allowStatuses: [403, 404] },
      ),
      { status: 404, data: undefined },
    );
  });

  for (const [status, name, code, message, fieldLocations] of [
    [400, 'problem-400', 'BadRequest', 'alfaview rejected the request: from must not be after to.', []],
    [403, 'problem-403', 'Forbidden', "The API key's user is not allowed to do this (missing room join permissions). Give that user the needed room or user permission.", []],
    [404, 'problem-404', 'NotFound', "alfaview could not find the room. It was deleted, or the API key's user cannot see it.", []],
    [409, 'problem-409', 'Conflict', 'Permissions for this participant already exist.', []],
    [422, 'problem-422', 'ValidationFailed', 'alfaview could not process the input: validation failed. create[0].emailAddress: expected string to be RFC 5322 email. create[0].locale: expected value to be one of "de-DE, en-US".', ['body.create[0].emailAddress', 'body.create[0].locale']],
    [429, 'problem-500', 'TooManyRequests', 'alfaview received too many requests (HTTP 429). Try again later.', []],
    [503, 'problem-500', 'ServerError', 'alfaview had a temporary problem (HTTP 503). Try again later.', []],
    [418, 'problem-500', 'HttpError', 'alfaview answered with HTTP 418: Internal Server Error.', []],
  ] as const) {
    it(`throws ${code} for HTTP ${status}`, async () => {
      const { api, fake } = testApi([
        loginRequest(),
        {
          method: 'GET',
          path: '/v2/rooms/r1',
          respond: { status, body: fixture(`core/${name}.json`), contentType: 'application/problem+json' },
        },
      ]);
      const error = await toolErrorOf(api.request({ method: 'GET', path: '/v2/rooms/r1' }));
      assert.deepEqual(
        [error.code, error.message, error.status, error.fieldLocations],
        [code, message, status, fieldLocations],
      );
      fake.assertDone();
    });
  }

  // alfaview can repeat an email address of the input in the texts of a 422. So with Leave out, the
  // error of a request with a personal input names only the fields.
  describe('a 422 of a request with a personal input', () => {
    const problem: FakeAnswer = {
      status: 422,
      body: fixture('core/problem-422.json'),
      contentType: 'application/problem+json',
    };

    async function errorOf(
      personalData: 'include' | 'omit' | undefined,
      request: Partial<ApiRequest>,
      respond: FakeAnswer = problem,
    ) {
      const { client, fake } = testApi([
        loginRequest(),
        { method: 'GET', path: '/v2/rooms/r1', respond },
      ]);
      const api = client.forCall(
        new AbortController().signal,
        personalData === undefined ? {} : { personalData },
      );
      const error = await toolErrorOf(api.request({ method: 'GET', path: '/v2/rooms/r1', ...request }));
      fake.assertDone();
      return error;
    }

    it('gives the field locations without the texts of alfaview with Leave out', async () => {
      const error = await errorOf('omit', { personalInput: true });
      assert.deepEqual(
        [error.code, error.message, error.status, error.fieldLocations],
        [
          'ValidationFailed',
          'alfaview could not process the input. Check create[0].emailAddress, create[0].locale. The reason from alfaview is hidden because Personal data is set to Leave out.',
          422,
          ['body.create[0].emailAddress', 'body.create[0].locale'],
        ],
      );
    });

    it('keeps the texts of alfaview with Include, without the option and without a personal input', async () => {
      const today =
        'alfaview could not process the input: validation failed. create[0].emailAddress: expected string to be RFC 5322 email. create[0].locale: expected value to be one of "de-DE, en-US".';
      for (const [personalData, personalInput] of [
        ['include', true],
        [undefined, true],
        ['omit', false],
      ] as const) {
        const error = await errorOf(personalData, { personalInput });
        assert.equal(error.message, today, `${personalData} ${personalInput}`);
      }
    });

    it('keeps the texts of alfaview for another status with Leave out', async () => {
      const error = await errorOf(
        'omit',
        { personalInput: true },
        { status: 400, body: fixture('core/problem-400.json') },
      );
      assert.equal(error.message, 'alfaview rejected the request: from must not be after to.');
    });
  });

  it('sends requests only to the base URL of its configuration', async () => {
    const origin = 'https://apis.example.com';
    const fake = fakeFetch([{ ...loginRequest(), origin }, { ...getRooms(OK), origin }]);
    const client = new AlfaviewClient({
      config: { ...TEST_CONFIG, baseUrl: origin },
      fetch: fake.fetch,
      log: createLogger(() => undefined),
    });
    await client.forCall(new AbortController().signal).request(GET_ROOMS);
    fake.assertDone();
  });

  for (const path of [
    '/v1/rooms',
    'v2/rooms',
    '/v2/rooms/../guest-links',
    '/v2/rooms/%2e%2e/guest-links',
    '/v2/meetings/./cancellation',
    '/v2/rooms?limit=1',
    '/v2/rooms#top',
  ]) {
    it(`refuses the path ${path} before any request`, async () => {
      const { api, fake } = testApi([]);
      await assert.rejects(api.request({ method: 'GET', path }), (error) => {
        assert.ok(!(error instanceof ToolError));
        assert.match((error as Error).message, /^Refused an API path/);
        return true;
      });
      assert.equal(fake.requests.length, 0);
      fake.assertDone();
    });
  }

  it('accepts an upper-case ID and an encoded slash in a segment', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'GET', path: '/v2/guest-links/ABC%2FDEF', respond: { status: 200, body: {} } },
    ]);
    await api.request({ method: 'GET', path: '/v2/guest-links/ABC%2FDEF' });
    fake.assertDone();
  });
});

describe('AlfaviewClient failures and limits', () => {
  it('reports a request that does not answer in time', async () => {
    const { api, fake } = testApi([loginRequest(), getRooms({ hang: true })], { timeoutMs: 50 });
    const error = await toolErrorOf(api.request(GET_ROOMS));
    assert.deepEqual([error.code, error.message], [
      'Timeout',
      'alfaview did not answer within 0.05 seconds (GET /v2/rooms). Try again later.',
    ]);
    fake.assertDone();
  });

  it('reports a canceled request by the state of the signal, whatever the reason', async () => {
    const canceling = new AbortController();
    const { api, fake } = testApi([loginRequest(), getRooms({ hang: true })], {
      signal: canceling.signal,
    });
    const request = api.request(GET_ROOMS);
    await untilRequests(fake, 2);
    canceling.abort('a text reason');
    const error = await toolErrorOf(request);
    assert.deepEqual([error.code, error.message], ['Canceled', CANCELED_MESSAGE]);
    assert.equal(CANCELED_MESSAGE, 'The request was canceled.');
    fake.assertDone();
  });

  it('sends nothing for a call that is already canceled', async () => {
    const canceling = new AbortController();
    canceling.abort();
    const { api, fake } = testApi([], { signal: canceling.signal });
    assert.equal((await toolErrorOf(api.request(GET_ROOMS))).code, 'Canceled');
    fake.assertDone();
  });

  for (const [name, respond, suffix] of [
    ['with a code', { networkError: 'ECONNREFUSED' }, ', ECONNREFUSED'],
    ['with a code that is not a word of capitals', { networkError: 'econnrefused' }, ''],
    ['without a code', { networkError: undefined }, ''],
    ['of a thrown text', { throws: 'socket closed' }, ''],
  ] as const) {
    it(`reports a network error ${name}`, async () => {
      const { api, fake } = testApi([loginRequest(), getRooms(respond)]);
      const error = await toolErrorOf(api.request(GET_ROOMS));
      assert.deepEqual([error.code, error.message], [
        'NetworkError',
        `alfaview could not be reached (GET /v2/rooms${suffix}). Check the network connection, then try again.`,
      ]);
      fake.assertDone();
    });
  }

  it('starts no request with less than 1 second of the call time left', async () => {
    const clock = testClock();
    const { api, fake } = testApi([loginRequest(), getRooms(OK)], { now: clock.now });
    clock.advance(49_000);
    await api.request(GET_ROOMS);
    clock.advance(1);
    const error = await toolErrorOf(api.request({ method: 'GET', path: '/v2/users/me' }));
    assert.deepEqual([error.code, error.message], [
      'Timeout',
      'The tool call reached its time limit of 50 seconds (GET /v2/users/me). alfaview answers slowly. Call the tool again.',
    ]);
    fake.assertDone();
  });

  it('gives a request the rest of the call time as its timeout', async () => {
    const clock = testClock();
    const { api, fake } = testApi([loginRequest(), getRooms(OK), getRooms({ hang: true })], {
      now: clock.now,
    });
    await api.request(GET_ROOMS);
    clock.advance(48_900);
    const started = Date.now();
    const error = await toolErrorOf(api.request(GET_ROOMS));
    assert.equal(error.code, 'Timeout');
    assert.match(error.message, /^The tool call reached its time limit of 50 seconds \(GET \/v2\/rooms\)/);
    assert.ok(Date.now() - started < 5_000);
    fake.assertDone();
  });

  it('measures the time of the call with the client clock', () => {
    const clock = testClock();
    const { api } = testApi([], { now: clock.now });
    assert.equal(api.elapsedMs(), 0);
    clock.advance(1_234);
    assert.equal(api.elapsedMs(), 1_234);
  });
});

/** Returns an answer that comes once the test calls `release`. */
function gated(then: FakeAnswer = OK) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { respond: { waitFor: gate, then } satisfies FakeAnswer, release };
}

/** Returns a room ID that ends with `index`, so that the test can tell its requests apart. */
function roomIdOf(index: number): string {
  return `0b7c5d2e-91a4-5f3b-8e27-${String(index).padStart(12, '0')}`;
}

/** Returns the path of the room with the ID `roomIdOf(index)`. */
function roomPathOf(index: number): string {
  return `/v2/rooms/${roomIdOf(index)}`;
}

/** Returns whether `promise` settles in a few rounds of the event loop, before a timer can fire. */
async function settledAfterFlushes(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let round = 0; round < 5 && !settled; round += 1) await flush();
  return settled;
}

// alfaview or a proxy between can send an answer of any size, which would stay in memory as a
// whole: the client reads at most MAX_ANSWER_BYTES of each answer.
describe('AlfaviewClient answer size', () => {
  const LIMIT = 1024;

  /**
   * Returns the call API of a client whose fetch answers the login, then `answer()` for each other
   * request.
   */
  function clientWith(answer: () => Response) {
    const client = new AlfaviewClient({
      config: TEST_CONFIG,
      fetch: async (input) =>
        String(input).endsWith('/v2/auth/api-key')
          ? new Response(JSON.stringify({ accessToken: 'token-1' }), { status: 200 })
          : answer(),
      log: createLogger(() => undefined),
      maxAnswerBytes: LIMIT,
    });
    return client.forCall(new AbortController().signal);
  }

  /**
   * Returns a body that gives the chunks of `chunks` one at a time, and counts its reads and its
   * cancel. Its cancel throws, as on a broken connection, and that must not hide the size error.
   */
  function streamed(chunks: () => Uint8Array | undefined) {
    const state = { reads: 0, canceled: false };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        state.reads += 1;
        const chunk = chunks();
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
      cancel() {
        state.canceled = true;
        throw new Error('socket closed');
      },
    });
    return { body, state };
  }

  it('reads an answer of the most bytes, also a character split between two chunks', async () => {
    // The two bytes of the umlaut make the text one byte longer than its characters.
    const bytes = new TextEncoder().encode(JSON.stringify({ data: [{ displayName: 'Müller' }] }).padEnd(LIMIT - 1, ' '));
    assert.equal(bytes.length, LIMIT);
    const split = bytes.indexOf(0xc3) + 1;
    const parts = [bytes.slice(0, split), bytes.slice(split)];
    const { body } = streamed(() => parts.shift());
    const api = clientWith(() => new Response(body, { status: 200 }));

    assert.deepEqual(await api.request(GET_ROOMS), { status: 200, data: { data: [{ displayName: 'Müller' }] } });
  });

  it('stops the read of a longer answer, cancels the rest, and names the request', async () => {
    const { body, state } = streamed(() => new Uint8Array(512).fill(0x20));
    const api = clientWith(() => new Response(body, { status: 200 }));
    const error = await toolErrorOf(api.request(GET_ROOMS));

    assert.deepEqual([error.code, error.message, error.status], [
      'AnswerTooLarge',
      'alfaview sent an answer larger than 1024 bytes (GET /v2/rooms), so the server did not read it. Try again later.',
      undefined,
    ]);
    assert.ok(state.canceled);
    assert.ok(state.reads <= 4, String(state.reads));
  });

  it('refuses an answer by its Content-Length before it reads it, also one without a body', async () => {
    const { body, state } = streamed(() => new Uint8Array(1));
    const answers = [
      new Response(body, { status: 200, headers: { 'content-length': String(LIMIT + 1) } }),
      new Response(null, { status: 200, headers: { 'content-length': String(LIMIT + 1) } }),
    ];
    const api = clientWith(() => answers.shift()!);
    const withBody = await toolErrorOf(api.request(GET_ROOMS));
    const withoutBody = await toolErrorOf(api.request(GET_ROOMS));

    assert.deepEqual([withBody.code, withoutBody.code], ['AnswerTooLarge', 'AnswerTooLarge']);
    assert.ok(state.canceled);
  });

  it('says that a write may be done, and names the limit of 16 MB', async () => {
    const api = clientWith(() => new Response('x'.repeat(LIMIT + 1), { status: 200 }));
    const error = await toolErrorOf(api.request({ method: 'PATCH', path: '/v2/rooms/abc', body: {} }));

    assert.equal(
      error.message,
      'alfaview sent an answer larger than 1024 bytes (PATCH /v2/rooms/abc), so the server did not read it. alfaview may have done the change: check it before you try again.',
    );
    assert.equal(MAX_ANSWER_BYTES, 16 * 1024 * 1024);
    assert.equal(
      answerTooLargeMessage('GET', '/v2/guest-links', MAX_ANSWER_BYTES),
      'alfaview sent an answer larger than 16 MB (GET /v2/guest-links), so the server did not read it. Try again later.',
    );
  });
});

// The client sends at most 8 requests at a time and 600 a minute, so that a looping agent cannot
// flood the account. The login counts as a request.
describe('AlfaviewClient rate limits', () => {
  it('has the limits of 8 at a time and 600 a minute, and their message', () => {
    assert.deepEqual([REQUESTS_AT_A_TIME, REQUESTS_PER_MINUTE, RATE_WINDOW_MS], [8, 600, 60_000]);
    assert.equal(
      REQUESTS_RATE_LIMITED_MESSAGE,
      'The alfaview MCP server sends at most 600 requests a minute to alfaview. Wait a minute and call again.',
    );
  });

  it('counts the starts of the last minute', () => {
    const clock = testClock();
    const window = new MinuteWindow(2, clock.now);
    const start = clock.now();
    assert.equal(window.tryStart(), true);
    clock.advance(10_000);
    assert.equal(window.tryStart(), true);
    assert.equal(window.tryStart(), false);
    assert.equal(window.nextStart(), start + 60_000);
    clock.advance(50_000);
    assert.equal(window.nextStart(), clock.now());
    assert.equal(window.tryStart(), true);
    assert.equal(window.tryStart(), false);
    assert.equal(window.nextStart(), start + 70_000);
  });

  it('sends at most 8 requests at a time, and starts the ninth when one ends', async () => {
    const answers = Array.from({ length: 9 }, () => gated());
    const { api, fake } = testApi(
      [
        loginRequest(),
        ...answers.map((answer, index) => ({
          method: 'GET',
          path: `/v2/rooms/${roomIdOf(index)}`,
          respond: answer.respond,
        })),
      ],
      { anyOrder: true },
    );
    const requests = answers.map((_, index) =>
      api.request({ method: 'GET', path: `/v2/rooms/${roomIdOf(index)}` }),
    );
    await untilRequests(fake, 9);
    for (let round = 0; round < 5; round += 1) await flush();
    assert.equal(fake.requests.length, 9);

    answers[3]!.release();
    await untilRequests(fake, 10);
    assert.match(fake.requests[9]!.url, new RegExp(`${roomIdOf(8)}$`));
    for (const answer of answers) answer.release();
    await Promise.all(requests);
    assert.equal(api.requestCount, 10);
    fake.assertDone();
  });

  it('refuses at once a request that the minute cannot take before the time limit of its call', async () => {
    const clock = testClock();
    const { api, client, fake } = testApi([loginRequest(), getRooms(OK), getRooms(OK), getRooms(OK)], {
      now: clock.now,
      requestsPerMinute: 3,
    });
    await api.request(GET_ROOMS);
    await api.request(GET_ROOMS);
    // The test clock stands still, so a request that waited would wait for a timer of 49 seconds.
    const refused = toolErrorOf(api.request(GET_ROOMS));
    assert.equal(await settledAfterFlushes(refused), true, 'the request waited');
    const error = await refused;
    assert.deepEqual([error.code, error.message], ['RateLimited', REQUESTS_RATE_LIMITED_MESSAGE]);
    assert.equal(api.requestCount, 3);

    // A minute after the first start, a call can send again.
    clock.advance(60_000);
    const later = client.forCall(new AbortController().signal);
    const answer = await later.request(GET_ROOMS);
    assert.equal(answer.status, 200);
    fake.assertDone();
  });

  it('lets a request wait for the minute when it frees before the time limit of the call', async () => {
    const clock = testClock();
    const { api, client, fake } = testApi([loginRequest(), getRooms(OK)], {
      now: clock.now,
      requestsPerMinute: 1,
    });
    // The login takes the one start of the minute, so the request of the first call cannot start
    // before the call time limit, and it is refused at once.
    const refused = toolErrorOf(api.request(GET_ROOMS));
    assert.equal(await settledAfterFlushes(refused), true, 'the request waited');
    assert.equal((await refused).code, 'RateLimited');

    clock.advance(59_950);
    const later = client.forCall(new AbortController().signal);
    const request = later.request(GET_ROOMS);
    for (let round = 0; round < 5; round += 1) await flush();
    assert.equal(fake.requests.length, 1);
    clock.advance(50);
    assert.equal((await request).status, 200);
    fake.assertDone();
  });

  it('gives RateLimited to a request that gets no turn before the time limit of its call', async () => {
    const { api, fake } = testApi([loginRequest(), getRooms({ hang: true })], {
      requestsAtATime: 1,
      callTimeLimitMs: 1_200,
    });
    const running = toolErrorOf(api.request(GET_ROOMS));
    await untilRequests(fake, 2);
    const waiting = await toolErrorOf(api.request(GET_ROOMS));
    assert.deepEqual([waiting.code, waiting.message], ['RateLimited', REQUESTS_RATE_LIMITED_MESSAGE]);
    assert.equal((await running).code, 'Timeout');
    assert.equal(api.requestCount, 2);
    fake.assertDone();
  });

  it('gives Canceled to a waiting request whose call is canceled, and never sends it', async () => {
    const answer = gated();
    const { api, client, fake } = testApi([loginRequest(), getRooms(answer.respond)], {
      requestsAtATime: 1,
    });
    const running = api.request(GET_ROOMS);
    await untilRequests(fake, 2);
    const canceling = new AbortController();
    const waiting = client.forCall(canceling.signal).request(GET_ROOMS);
    await flush();
    canceling.abort();
    assert.deepEqual((await toolErrorOf(waiting)).code, 'Canceled');
    answer.release();
    assert.equal((await running).status, 200);
    fake.assertDone();
  });

  it('lets a login wait for its turn, as each request does', async () => {
    const first = gated({ status: 401, body: fixture('core/problem-401.json') });
    const second = gated();
    const roomPath = (index: number) => `/v2/rooms/${roomIdOf(index)}`;
    const { client, fake } = testApi(
      [
        loginRequest(),
        { method: 'GET', path: roomPath(1), respond: first.respond },
        { method: 'GET', path: roomPath(2), respond: second.respond },
        { ...loginRequest('token-2') },
        { method: 'GET', path: roomPath(1), token: 'token-2', respond: OK },
      ],
      { requestsAtATime: 1 },
    );
    const callA = client.forCall(new AbortController().signal);
    const callB = client.forCall(new AbortController().signal);
    const a = callA.request({ method: 'GET', path: roomPath(1) });
    await untilRequests(fake, 2);
    const b = callB.request({ method: 'GET', path: roomPath(2) });
    await flush();

    // The 401 ends the request of A. B takes the turn, so the new login of A waits for B.
    first.release();
    await untilRequests(fake, 3);
    for (let round = 0; round < 5; round += 1) await flush();
    assert.equal(fake.requests.length, 3);
    second.release();
    assert.equal((await b).status, 200);
    assert.equal((await a).status, 200);
    // The first login, the request, the new login and the repeat.
    assert.equal(callA.requestCount, 4);
    fake.assertDone();
  });

  it('starts the requests in the order in which they came, also when the minute frees before its timer', async () => {
    const clock = testClock();
    const { api, client, fake } = testApi(
      [loginRequest(), { method: 'GET', path: roomPathOf(1), respond: OK }],
      { now: clock.now, requestsPerMinute: 1 },
    );
    // The login takes the one start of the minute.
    assert.equal((await toolErrorOf(api.request(GET_ROOMS))).code, 'RateLimited');
    clock.advance(59_950);
    const first = client.forCall(new AbortController().signal).request({ method: 'GET', path: roomPathOf(1) });
    await flush();

    // The minute frees by the clock of the client before the timer that starts the waiting request
    // runs. A new request must not take the start of the request that waits.
    clock.advance(50);
    const canceling = new AbortController();
    const second = client.forCall(canceling.signal).request({ method: 'GET', path: roomPathOf(2) });
    await untilRequests(fake, 2);
    assert.match(fake.requests[1]!.url, new RegExp(`${roomIdOf(1)}$`));
    assert.equal((await first).status, 200);
    canceling.abort();
    assert.equal((await toolErrorOf(second)).code, 'Canceled');
    fake.assertDone();
  });

  it('gives RateLimited to a request whose turn comes after the limit of its wait, and frees its place', async () => {
    const clock = testClock();
    const running = gated();
    const { api, client, fake } = testApi([loginRequest(), getRooms(running.respond), getRooms(OK)], {
      now: clock.now,
      requestsAtATime: 1,
    });
    const first = api.request(GET_ROOMS);
    await untilRequests(fake, 2);
    const late = client.forCall(new AbortController().signal).request(GET_ROOMS);
    await flush();

    // The call time of the waiting request runs out by the clock of the client before its timer
    // runs, as after a stall of the event loop. Then the running request ends and gives the turn.
    clock.advance(51_000);
    running.release();
    assert.equal((await first).status, 200);
    const error = await toolErrorOf(late);
    assert.deepEqual([error.code, error.message], ['RateLimited', REQUESTS_RATE_LIMITED_MESSAGE]);

    // The late request gave its place back: the next call sends at once.
    const next = client.forCall(new AbortController().signal).request(GET_ROOMS);
    assert.equal(await settledAfterFlushes(next), true, 'the next request waited');
    assert.equal((await next).status, 200);
    fake.assertDone();
  });

  it('sends no login when its only call is canceled before the login gets its turn', async () => {
    const canceling = new AbortController();
    const { api, client, fake, logLines } = testApi([loginRequest(), getRooms(OK)], {
      signal: canceling.signal,
    });
    const request = api.request(GET_ROOMS);
    canceling.abort();
    assert.equal((await toolErrorOf(request)).code, 'Canceled');
    for (let round = 0; round < 5; round += 1) await flush();
    assert.equal(fake.requests.length, 0);

    // The next call starts a login of its own.
    const answer = await client.forCall(new AbortController().signal).request(GET_ROOMS);
    assert.equal(answer.status, 200);
    assert.deepEqual(logLines, ['alfaview-mcp: logged in\n']);
    fake.assertDone();
  });

  it('drops a login that waits for its turn when every call that needs it has left', async () => {
    const first = gated({ status: 401, body: fixture('core/problem-401.json') });
    const { client, fake, logLines } = testApi(
      [
        loginRequest(),
        { method: 'GET', path: roomPathOf(1), respond: first.respond },
        { method: 'GET', path: roomPathOf(2), respond: { hang: true } },
      ],
      { requestsAtATime: 1 },
    );
    const cancelA = new AbortController();
    const cancelB = new AbortController();
    const a = client.forCall(cancelA.signal).request({ method: 'GET', path: roomPathOf(1) });
    await untilRequests(fake, 2);
    const b = client.forCall(cancelB.signal).request({ method: 'GET', path: roomPathOf(2) });
    await flush();

    // The 401 ends the request of A. B takes the turn, so the new login of A waits for B.
    first.release();
    await untilRequests(fake, 3);
    for (let round = 0; round < 5; round += 1) await flush();

    // The close of stdin cancels both calls. B gives its place back, and no call waits for the
    // login of A any more, so the login does not start.
    cancelA.abort();
    cancelB.abort();
    assert.equal((await toolErrorOf(a)).code, 'Canceled');
    assert.equal((await toolErrorOf(b)).code, 'Canceled');
    for (let round = 0; round < 5; round += 1) await flush();
    assert.equal(fake.requests.length, 3);
    assert.deepEqual(logLines, ['alfaview-mcp: logged in\n']);
    fake.assertDone();
  });
});
