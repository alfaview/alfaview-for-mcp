// A fake fetch for the unit tests: it answers the expected requests in order and refuses every
// other request, so no test reaches the network. It checks each request against
// spec/openapi-v2.json (spec.ts), unless its expected entry opts out.
import assert from 'node:assert/strict';
import { AlfaviewClient, type CallApi, type ClientOptions } from '../../src/alfaview/client.ts';
import { ToolError } from '../../src/alfaview/errors.ts';
import type { Config } from '../../src/config.ts';
import { createLogger } from '../../src/log.ts';
import { keepContractProblems, takeContractProblems, testFileLine } from './spec.ts';

/**
 * Returns the ToolError that `promise` rejects with. Fails when it resolves or rejects otherwise.
 */
export async function toolErrorOf(promise: Promise<unknown>): Promise<ToolError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ToolError, `expected a ToolError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'Expected a rejection.' });
}

/** Lets pending promise callbacks and I/O callbacks run. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Waits until the fake has received `count` requests, and fails after 100 rounds of `flush`. */
export async function untilRequests(fake: { requests: readonly unknown[] }, count: number) {
  for (let round = 0; fake.requests.length < count; round += 1) {
    if (round === 100) {
      throw new assert.AssertionError({ message: `${count} requests did not arrive` });
    }
    await flush();
  }
}

export const PRODUCTION_ORIGIN = 'https://apis.alfaview.com';
export const TEST_TOKEN = 'token-1';

export const TEST_CONFIG: Config = {
  companyId: 'company-1',
  clientId: 'mcp-test',
  apiKey: 'secret-key-1',
  baseUrl: PRODUCTION_ORIGIN,
  level: 'standard',
  tools: [],
  timeZone: 'Europe/Berlin',
  personalData: 'include',
};

export type FakeAnswer =
  | { status: number; body?: unknown; contentType?: string }
  | { networkError: string | undefined }
  /** Waits until the request's signal aborts, and keeps the process alive as a socket would. */
  | { hang: true }
  | { throws: unknown }
  /** Answers with `then` once `waitFor` resolves. */
  | { waitFor: Promise<unknown>; then: FakeAnswer };

export type ExpectedRequest = {
  method: string;
  path: string;
  /** The query without regard to order. Omitted means no query. */
  query?: Record<string, string>;
  /** The body as parsed JSON. Omitted means no body. */
  body?: unknown;
  /** Default: https://apis.alfaview.com. */
  origin?: string;
  /** The Authorization header. Default TEST_TOKEN. The login never has one. */
  token?: string;
  /**
   * Skips the spec contract check of the request that this entry answers, for a request that is
   * invalid on purpose. `skip` says why, and must not be blank.
   */
  contract?: { skip: string };
  respond: FakeAnswer;
};

export type RecordedRequest = {
  method: string;
  url: string;
  headers: Headers;
  body: string | undefined;
  signal: AbortSignal | undefined;
};

/** Returns the expected request of a successful login that gives `token`. */
export function loginRequest(token = TEST_TOKEN): ExpectedRequest {
  return {
    method: 'POST',
    path: '/v2/auth/api-key',
    body: { companyId: 'company-1', clientId: 'mcp-test', key: 'secret-key-1' },
    respond: { status: 200, body: { accessToken: token } },
  };
}

function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal === undefined) return;
    const keepAlive = setInterval(() => undefined, 1000);
    const stop = () => {
      clearInterval(keepAlive);
      reject(signal.reason);
    };
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
}

function answer(respond: FakeAnswer, signal: AbortSignal | undefined): Promise<Response> {
  if ('waitFor' in respond) {
    return respond.waitFor.then(() => answer(respond.then, signal));
  }
  if ('hang' in respond) return waitForAbort(signal);
  if ('throws' in respond) return Promise.reject(respond.throws);
  if ('networkError' in respond) {
    const cause = Object.assign(new Error('connect failed'), { code: respond.networkError });
    return Promise.reject(new TypeError('fetch failed', { cause }));
  }
  const { status, body, contentType } = respond;
  const text = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
  const headers = { 'Content-Type': contentType ?? 'application/json' };
  return Promise.resolve(new Response(text, { status, headers }));
}

function queryOf(url: URL): Record<string, string> {
  return Object.fromEntries(
    [...url.searchParams].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function sortedQuery(query: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(query ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );
}

/** Checks one request against its expected entry. Returns the problems. */
function check(expected: ExpectedRequest, request: RecordedRequest): string[] {
  const problems: string[] = [];
  const url = new URL(request.url);
  const what = `${request.method} ${url.pathname}`;
  const expectProblem = (condition: boolean, text: string) => {
    if (!condition) problems.push(`${what}: ${text}`);
  };
  expectProblem(url.origin === (expected.origin ?? PRODUCTION_ORIGIN), `origin ${url.origin}`);
  expectProblem(request.method === expected.method, `expected ${expected.method} ${expected.path}`);
  expectProblem(url.pathname === expected.path, `expected the path ${expected.path}`);
  try {
    assert.deepEqual(queryOf(url), sortedQuery(expected.query));
  } catch {
    problems.push(`${what}: query ${url.search}`);
  }
  try {
    assert.deepEqual(
      request.body === undefined ? undefined : JSON.parse(request.body),
      expected.body,
    );
  } catch {
    problems.push(`${what}: body ${request.body}`);
  }
  expectProblem(request.signal instanceof AbortSignal, 'no signal');
  expectProblem(request.headers.get('accept') === 'application/json', 'Accept header');
  expectProblem(
    request.headers.get('content-type') ===
      (request.body === undefined ? null : 'application/json'),
    'Content-Type header',
  );
  const isLogin = expected.path === '/v2/auth/api-key';
  expectProblem(
    request.headers.get('authorization') === (isLogin ? null : (expected.token ?? TEST_TOKEN)),
    `Authorization header ${request.headers.get('authorization')}`,
  );
  return problems;
}

export type FakeFetch = {
  fetch: typeof fetch;
  /** Every request, in the order they arrived. */
  requests: RecordedRequest[];
  /**
   * Throws for every refused request, every expected request that did not arrive and every
   * contract problem of a request (spec.ts).
   */
  assertDone(): void;
};

/**
 * Returns a fetch that answers `expected` in order. With `anyOrder`, a request takes the first
 * unused entry with the same method and path, for tests of concurrent requests. An entry that
 * skips the contract check without a reason throws at once.
 */
export function fakeFetch(
  expected: readonly ExpectedRequest[],
  options: { anyOrder?: boolean } = {},
): FakeFetch {
  for (const entry of expected) {
    if (entry.contract !== undefined && entry.contract.skip.trim() === '') {
      throw new Error(
        `The mock of ${entry.method} ${entry.path} skips the contract check without a reason in contract.skip.`,
      );
    }
  }
  const unused = [...expected];
  const requests: RecordedRequest[] = [];
  const failures: string[] = [];
  /** This fake, as the owner of the contract problems of its requests. */
  const owner = {};
  const site = testFileLine();

  const fetch = (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const request: RecordedRequest = {
      method: init.method ?? 'GET',
      url: String(input),
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : undefined,
      signal: init.signal ?? undefined,
    };
    requests.push(request);
    if (init.redirect !== 'error') failures.push(`${request.method} ${request.url}: redirect`);

    const url = new URL(request.url);
    const index = options.anyOrder
      ? unused.findIndex((entry) => entry.method === request.method && entry.path === url.pathname)
      : 0;
    const entry = index === -1 ? undefined : unused[index];
    if (entry?.contract === undefined) {
      const contractRequest = {
        method: request.method,
        path: url.pathname + url.search,
        headers: Object.fromEntries(request.headers),
        body: request.body,
      };
      keepContractProblems(contractRequest, site, owner);
    }
    if (entry === undefined) {
      failures.push(`unexpected request ${request.method} ${request.url}`);
      return Promise.reject(new Error(`unexpected request ${request.method} ${request.url}`));
    }
    unused.splice(index, 1);
    const problems = check(entry, request);
    if (problems.length > 0) {
      failures.push(...problems);
      return Promise.reject(new Error(problems.join('; ')));
    }
    return answer(entry.respond, request.signal);
  };

  return {
    fetch: fetch as typeof globalThis.fetch,
    requests,
    assertDone() {
      const open = unused.map(
        (entry) => `expected request did not arrive: ${entry.method} ${entry.path}`,
      );
      assert.deepEqual([...failures, ...open, ...takeContractProblems(owner)], []);
    },
  };
}

export type TestApi = {
  api: CallApi;
  client: AlfaviewClient;
  fake: FakeFetch;
  logLines: string[];
};

/** Returns a client on a fake fetch with a collecting logger, and the API of one call. */
export function testApi(
  expected: readonly ExpectedRequest[],
  options: Partial<Omit<ClientOptions, 'fetch' | 'log'>> & {
    signal?: AbortSignal;
    anyOrder?: boolean;
  } = {},
): TestApi {
  const { signal, anyOrder, ...clientOptions } = options;
  const fake = fakeFetch(expected, { anyOrder });
  const logLines: string[] = [];
  const client = new AlfaviewClient({
    config: TEST_CONFIG,
    fetch: fake.fetch,
    log: createLogger((text) => logLines.push(text)),
    ...clientOptions,
  });
  const api = client.forCall(signal ?? new AbortController().signal);
  return { api, client, fake, logLines };
}
