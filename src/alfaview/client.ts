// The alfaview API client of the server. It keeps one access token in memory, shares one login
// among concurrent requests, and limits how many requests run at a time and start in a minute, so
// that a looping agent cannot flood the account.
import type { Config } from '../config.ts';
import type { Logger } from '../log.ts';
import { inputErrorWithoutPersonalData, type PersonalDataMode } from '../shared/personalData.ts';
import { describeApiError, ToolError } from './errors.ts';

export const REQUEST_TIMEOUT_MS = 30_000;

/** The time limit of a whole tool call, below the 60-second timeout of the MCP SDK client. */
export const CALL_TIME_LIMIT_MS = 50_000;

/** A request with less time left in its call is not sent. */
export const MIN_REQUEST_TIME_MS = 1_000;

/** How long requests fail at once after alfaview refused a login with 401 or 403. */
export const LOGIN_REFUSAL_HOLD_MS = 300_000;

/** The most requests to alfaview that run at the same time. */
export const REQUESTS_AT_A_TIME = 8;

/** The most requests to alfaview that start in a minute. */
export const REQUESTS_PER_MINUTE = 600;

/** The window of REQUESTS_PER_MINUTE, in milliseconds. */
export const RATE_WINDOW_MS = 60_000;

export const REQUESTS_RATE_LIMITED_MESSAGE = `The alfaview MCP server sends at most ${REQUESTS_PER_MINUTE} requests a minute to alfaview. Wait a minute and call again.`;

const LOGIN_PATH = '/v2/auth/api-key';

export const INVALID_CREDENTIALS_MESSAGE =
  'alfaview rejected the Company ID, Client ID or API key. Check ALFAVIEW_COMPANY_ID, ALFAVIEW_CLIENT_ID and ALFAVIEW_API_KEY in the server configuration, then restart the server.';

export const REVOKED_CREDENTIALS_MESSAGE =
  'alfaview rejected the Company ID, Client ID or API key, for example because the key was revoked. Fix the values in the server configuration, then restart the server.';

export const INACTIVE_ACCOUNT_MESSAGE =
  'The alfaview account that owns this API key is not active. The server tries to log in again 5 minutes after this refusal.';

export const NO_ACCESS_TOKEN_MESSAGE = 'alfaview did not return an access token.';

export const UNUSABLE_ACCESS_TOKEN_MESSAGE =
  'alfaview returned an access token that the server cannot send in a request. Try again later.';

/**
 * An access token that fetch takes as the value of a header: visible ASCII characters, without a
 * space. A token with a line break would make each later request fail before it goes out, so no
 * 401 would ever drop it.
 */
const USABLE_TOKEN = /^[\x21-\x7e]+$/;

/**
 * The most bytes of an answer that the client reads, far more than the largest page (500 guest
 * links). The client stops reading at this cap, so a huge answer cannot fill the memory.
 */
export const MAX_ANSWER_BYTES = 16 * 1024 * 1024;

/**
 * Returns the error text for an answer above `maxBytes`. The status comes before the body, so a
 * write may have taken effect, and the text says to check it first. A read and the login change
 * nothing.
 */
export function answerTooLargeMessage(method: ApiMethod, path: string, maxBytes: number): string {
  const mebibyte = 1024 * 1024;
  const size = maxBytes % mebibyte === 0 ? `${maxBytes / mebibyte} MB` : `${maxBytes} bytes`;
  const next =
    method === 'GET' || path === LOGIN_PATH
      ? 'Try again later.'
      : 'alfaview may have done the change: check it before you try again.';
  return `alfaview sent an answer larger than ${size} (${method} ${path}), so the server did not read it. ${next}`;
}

export const NEW_TOKEN_REFUSED_MESSAGE =
  'alfaview did not accept a new access token (HTTP 401). Try again. If it happens again, check the API key.';

export const CANCELED_MESSAGE = 'The request was canceled.';

export type ApiMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export type ApiRequest = {
  method: ApiMethod;
  /** Starts with /v2/. IDs go in with encodeURIComponent, room IDs in lowercase. */
  path: string;
  /** Undefined values are left out. */
  query?: Record<string, string | number | undefined>;
  /** Sent as JSON. Built from an explicit field list, never by spreading input. */
  body?: unknown;
  /** These error statuses return { status, data: undefined } instead of throwing. */
  allowStatuses?: readonly number[];
  /**
   * The request sends personal input, such as an email address, which alfaview can repeat in the
   * texts of a 422. In a call with Personal data set to Leave out, a 422 that is not in
   * `allowStatuses` then gives the text of inputErrorWithoutPersonalData, with the field locations
   * of the problem, instead of alfaview's texts. A request that gets no answer needs nothing: its
   * text names the method and the path, never the query or the body.
   */
  personalInput?: boolean;
};

export type ApiResponse<T> = { status: number; data: T | undefined };

/** The API of one tool call: its requests use the call's signal, time limit and count. */
export type CallApi = {
  request<T>(request: ApiRequest): Promise<ApiResponse<T>>;
  readonly requestCount: number;
  /** Milliseconds since forCall, by the client's clock. */
  elapsedMs(): number;
};

export type ClientOptions = {
  config: Pick<Config, 'companyId' | 'clientId' | 'apiKey' | 'baseUrl'>;
  fetch: typeof fetch;
  log: Logger;
  timeoutMs?: number;
  callTimeLimitMs?: number;
  /** REQUESTS_AT_A_TIME by default. Tests pass a smaller number. */
  requestsAtATime?: number;
  /** REQUESTS_PER_MINUTE by default. Tests pass a smaller number. */
  requestsPerMinute?: number;
  /** Date.now by default. Tests pass a clock that they move. */
  now?: () => number;
  /** MAX_ANSWER_BYTES by default. Tests pass a smaller number. */
  maxAnswerBytes?: number;
};

/**
 * A sliding window of the request starts of the last minute: a start is in the limit when fewer
 * than `max` starts lie in the minute before it.
 */
export class MinuteWindow {
  private readonly max: number;
  private readonly now: () => number;
  private readonly starts: number[] = [];

  constructor(max: number, now: () => number = Date.now) {
    this.max = max;
    this.now = now;
  }

  /**
   * Returns the earliest time at which a start is in the limit: now, or when the oldest start
   * leaves the minute.
   */
  nextStart(): number {
    const now = this.now();
    this.dropOld(now);
    return this.starts.length < this.max ? now : this.starts[0]! + RATE_WINDOW_MS;
  }

  /** Counts a start now when it is in the limit, and returns whether it was. */
  tryStart(): boolean {
    const now = this.now();
    this.dropOld(now);
    if (this.starts.length >= this.max) return false;
    this.starts.push(now);
    return true;
  }

  /** Forgets the starts that lie a minute or more before `now`. */
  private dropOld(now: number): void {
    while (this.starts.length > 0 && this.starts[0]! <= now - RATE_WINDOW_MS) this.starts.shift();
  }
}

/** A request that waits for its start inside the limits. */
type Waiter = { start(): void };

type CallState = {
  signal: AbortSignal;
  deadline: number;
  requestCount: number;
  personalData: PersonalDataMode;
};

export type CallOptions = {
  /** The option Personal data of the server (ALFAVIEW_PERSONAL_DATA). Default `include`. */
  personalData?: PersonalDataMode;
};

type RawResponse = { status: number; text: string };

type LoginReason = 'first' | 'after401';

/** What the calls that share a login know about it. */
type LoginState = {
  /** The calls that wait for the token now. */
  waiters: number;
  /** True once the login request is on its way. */
  sent: boolean;
  /** Ends the wait of the login for its turn when no call waits for it any more. */
  unwanted: AbortController;
};

/** The login that the calls of the client share. */
type SharedLogin = LoginState & { token: Promise<string> };

type Refusal = { message: string; status: number; at: number };

function seconds(milliseconds: number): string {
  return `${milliseconds / 1000} seconds`;
}

function canceled(): ToolError {
  return new ToolError('Canceled', CANCELED_MESSAGE);
}

function rateLimited(): ToolError {
  return new ToolError('RateLimited', REQUESTS_RATE_LIMITED_MESSAGE);
}

/**
 * Returns the `code` of the error's cause, such as ECONNREFUSED, when it holds only capital letters
 * and underscores.
 */
function causeCode(error: unknown): string | undefined {
  const cause =
    typeof error === 'object' && error !== null ? (error as { cause?: unknown }).cause : undefined;
  const code =
    typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : undefined;
}

function networkError(method: ApiMethod, path: string, error: unknown): ToolError {
  const code = causeCode(error);
  const where = `${method} ${path}${code === undefined ? '' : `, ${code}`}`;
  return new ToolError(
    'NetworkError',
    `alfaview could not be reached (${where}). Check the network connection, then try again.`,
  );
}

/**
 * Reads the text of `answer`, at most `maxBytes` bytes, decoded as UTF-8 as `Response.text()` does.
 * A larger answer, by its Content-Length or by the bytes that arrive, throws AnswerTooLarge without
 * reading the rest.
 */
async function readText(
  answer: Response,
  request: Pick<ApiRequest, 'method' | 'path'>,
  maxBytes: number,
): Promise<string> {
  const tooLarge = () =>
    new ToolError('AnswerTooLarge', answerTooLargeMessage(request.method, request.path, maxBytes));
  if (Number(answer.headers.get('content-length')) > maxBytes) {
    await answer.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (answer.body === null) return '';
  const reader = answer.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
}

/**
 * Parses a body as JSON. An empty body gives the value `undefined`, and a body that is not JSON
 * gives `{ ok: false }`.
 */
function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * The alfaview API client of the server: one token for the credentials of the configuration,
 * requests through the per-call API of `forCall`.
 */
export class AlfaviewClient {
  private readonly credentials: { companyId: string; clientId: string; key: string };
  private readonly baseUrl: string;
  private readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
  private readonly log: Logger;
  private readonly timeoutMs: number;
  private readonly callTimeLimitMs: number;
  private readonly requestsAtATime: number;
  private readonly now: () => number;
  private readonly maxAnswerBytes: number;

  private token: string | null = null;
  private login: SharedLogin | null = null;
  private refusal: Refusal | null = null;
  private loggedInBefore = false;

  // The requests that run now, the starts of the last minute and the requests that wait.
  private running = 0;
  private readonly minute: MinuteWindow;
  private readonly waiting: Waiter[] = [];
  /** The timer that starts the next waiter when the oldest start of a full minute leaves it. */
  private wake: ReturnType<typeof setTimeout> | undefined;

  constructor(options: ClientOptions) {
    const { config } = options;
    this.credentials = {
      companyId: config.companyId,
      clientId: config.clientId,
      key: config.apiKey,
    };
    this.baseUrl = config.baseUrl;
    const fetchFunction = options.fetch;
    this.fetch = (input, init) => fetchFunction(input, init);
    this.log = options.log;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.callTimeLimitMs = options.callTimeLimitMs ?? CALL_TIME_LIMIT_MS;
    this.requestsAtATime = options.requestsAtATime ?? REQUESTS_AT_A_TIME;
    this.now = options.now ?? Date.now;
    this.maxAnswerBytes = options.maxAnswerBytes ?? MAX_ANSWER_BYTES;
    this.minute = new MinuteWindow(options.requestsPerMinute ?? REQUESTS_PER_MINUTE, this.now);
  }

  /** Returns the API of one tool call. Its time limit starts now. */
  forCall(signal: AbortSignal, options: CallOptions = {}): CallApi {
    const start = this.now();
    const call: CallState = {
      signal,
      deadline: start + this.callTimeLimitMs,
      requestCount: 0,
      personalData: options.personalData ?? 'include',
    };
    return {
      request: <T>(request: ApiRequest) => this.request<T>(call, request),
      get requestCount() {
        return call.requestCount;
      },
      elapsedMs: () => this.now() - start,
    };
  }

  private callTimeLimitMessage(request: ApiRequest): string {
    const limit = seconds(this.callTimeLimitMs);
    const where = `${request.method} ${request.path}`;
    return `The tool call reached its time limit of ${limit} (${where}). alfaview answers slowly. Call the tool again.`;
  }

  private requestTimeoutMessage(method: ApiMethod, path: string): string {
    const limit = seconds(this.timeoutMs);
    return `alfaview did not answer within ${limit} (${method} ${path}). Try again later.`;
  }

  private async request<T>(call: CallState, request: ApiRequest): Promise<ApiResponse<T>> {
    const url = this.urlOf(request);
    let token = await this.tokenFor(call, request, 'first');
    let response = await this.send(call, request, url, token);
    if (response.status === 401) {
      if (this.token === token) this.token = null;
      token = await this.tokenFor(call, request, 'after401');
      response = await this.send(call, request, url, token);
      if (response.status === 401) {
        throw new ToolError('Unauthorized', NEW_TOKEN_REFUSED_MESSAGE, 401);
      }
    }
    return this.result<T>(call, request, response);
  }

  /**
   * Returns the absolute URL of a request. The path must start with /v2/ and must stay the path of
   * the URL: no dot segment may resolve, so an ID such as `..` cannot reach another endpoint. The
   * origin is always the base URL, so the token goes only to an allowed host. A refused path throws
   * a plain Error, because it is a bug: the tool inputs take only IDs in the UUID form.
   */
  private urlOf(request: ApiRequest): string {
    const refused = () =>
      new Error(
        'Refused an API path that does not start with /v2/ or that resolves to another path.',
      );
    if (!request.path.startsWith('/v2/')) throw refused();
    const url = new URL(this.baseUrl + request.path);
    if (url.origin !== this.baseUrl || url.pathname !== request.path) throw refused();
    for (const [name, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.append(name, String(value));
    }
    return url.toString();
  }

  /** Throws when the call was canceled or has less than MIN_REQUEST_TIME_MS left. */
  private checkCall(call: CallState, request: ApiRequest): void {
    if (call.signal.aborted) throw canceled();
    if (call.deadline - this.now() < MIN_REQUEST_TIME_MS) {
      throw new ToolError('Timeout', this.callTimeLimitMessage(request));
    }
  }

  /**
   * Waits until a request can start within the limits on running requests and on starts in a
   * minute, counts its start, and returns the function that ends it. The requests start in the
   * order in which they came. A request that cannot start by `startBy` gives RateLimited, at once
   * when the minute is full until then, and a cancel of `signal` gives Canceled.
   */
  private startRequest(startBy: number, signal?: AbortSignal): Promise<() => void> {
    if (this.waiting.length === 0 && this.running < this.requestsAtATime && this.minute.tryStart()) {
      return Promise.resolve(this.started());
    }
    if (this.minute.nextStart() > startBy) return Promise.reject(rateLimited());
    return new Promise((resolve, reject) => {
      const leave = () => {
        clearTimeout(limit);
        signal?.removeEventListener('abort', onAbort);
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        if (this.waiting.length === 0) clearTimeout(this.wake);
      };
      const onAbort = () => {
        leave();
        reject(canceled());
      };
      const waiter: Waiter = {
        start: () => {
          leave();
          resolve(this.started());
        },
      };
      const limit = setTimeout(
        () => {
          leave();
          reject(rateLimited());
        },
        Math.max(startBy - this.now(), 0),
      );
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(waiter);
      this.startWaiting();
    });
  }

  /** Counts a request that runs, and returns the function that ends it. */
  private started(): () => void {
    this.running += 1;
    return () => {
      this.running -= 1;
      this.startWaiting();
    };
  }

  /**
   * Starts the waiting requests in their order while fewer than `requestsAtATime` run and the
   * minute has room. When the minute is full, it tries again when its oldest start leaves it.
   */
  private startWaiting(): void {
    clearTimeout(this.wake);
    this.wake = undefined;
    while (this.waiting.length > 0 && this.running < this.requestsAtATime) {
      if (!this.minute.tryStart()) {
        this.wake = setTimeout(() => this.startWaiting(), this.minute.nextStart() - this.now());
        return;
      }
      this.waiting.shift()!.start();
    }
  }

  /**
   * Returns the current token, or the token of a login: the one in progress, or a new one that this
   * call starts and counts. For LOGIN_REFUSAL_HOLD_MS after a refused login, it throws LoginRefused
   * without a request.
   */
  private async tokenFor(
    call: CallState,
    request: ApiRequest,
    reason: LoginReason,
  ): Promise<string> {
    this.checkCall(call, request);
    if (this.token !== null) return this.token;
    this.checkRefusal();
    let login = this.login;
    if (login === null) {
      login = this.startLogin(reason);
      call.requestCount += 1;
    }
    return this.waitForLogin(call, request, login);
  }

  private checkRefusal(): void {
    if (this.refusal === null) return;
    if (this.now() - this.refusal.at < LOGIN_REFUSAL_HOLD_MS) {
      throw new ToolError('LoginRefused', this.refusal.message, this.refusal.status);
    }
    this.refusal = null;
    this.log.info('login allowed again after 5 minutes');
  }

  /**
   * Starts the shared login. The promise has a handler that does nothing, so a login that fails
   * after every waiter has left is not an unhandled rejection, which would end the process.
   */
  private startLogin(reason: LoginReason): SharedLogin {
    const state: LoginState = { waiters: 0, sent: false, unwanted: new AbortController() };
    const token = this.logIn(reason, state).finally(() => {
      if (this.login === login) this.login = null;
    });
    token.catch(() => undefined);
    const login: SharedLogin = Object.assign(state, { token });
    this.login = login;
    return login;
  }

  /**
   * Waits for the shared login, but only as long as the call's signal and time allow. A waiter
   * that leaves does not stop a sent login for the others. When the last waiter leaves a login
   * that still waits for its turn, the login is dropped, so that the client sends no login that no
   * call needs.
   */
  private waitForLogin(call: CallState, request: ApiRequest, login: SharedLogin): Promise<string> {
    const limit = AbortSignal.timeout(Math.max(call.deadline - this.now(), 0));
    login.waiters += 1;
    return new Promise<string>((resolve, reject) => {
      let waiting = true;
      /** Ends the wait once, and returns whether this call ended it. */
      const stop = (): boolean => {
        if (!waiting) return false;
        waiting = false;
        call.signal.removeEventListener('abort', onAbort);
        limit.removeEventListener('abort', onAbort);
        login.waiters -= 1;
        return true;
      };
      const onAbort = () => {
        stop();
        if (login.waiters === 0 && !login.sent) this.dropLogin(login);
        reject(
          call.signal.aborted
            ? canceled()
            : new ToolError('Timeout', this.callTimeLimitMessage(request)),
        );
      };
      call.signal.addEventListener('abort', onAbort, { once: true });
      limit.addEventListener('abort', onAbort, { once: true });
      login.token.then(
        (token) => {
          if (stop()) resolve(token);
        },
        (error: unknown) => {
          if (stop()) reject(error);
        },
      );
    });
  }

  /** Ends the wait of a login that no call waits for, and lets the next call start a new one. */
  private dropLogin(login: SharedLogin): void {
    login.unwanted.abort();
    if (this.login === login) this.login = null;
  }

  /**
   * Sends `POST /v2/auth/api-key` with its own timeout, not the signal of a call, because several
   * calls can wait for it. It starts inside the request limits within the time of its timeout, and
   * then gets the whole timeout. A login that no call waits for when its turn comes gives Canceled
   * and sends nothing.
   */
  private async logIn(reason: LoginReason, login: LoginState): Promise<string> {
    const end = await this.startRequest(this.now() + this.timeoutMs, login.unwanted.signal);
    if (login.unwanted.signal.aborted) {
      end();
      throw canceled();
    }
    login.sent = true;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let response: RawResponse;
    try {
      const answer = await this.fetch(this.baseUrl + LOGIN_PATH, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(this.credentials),
        redirect: 'error',
        signal: timeout,
      });
      const login = { method: 'POST', path: LOGIN_PATH } as const;
      response = { status: answer.status, text: await readText(answer, login, this.maxAnswerBytes) };
    } catch (error) {
      if (timeout.aborted) {
        throw new ToolError('Timeout', this.requestTimeoutMessage('POST', LOGIN_PATH));
      }
      if (error instanceof ToolError) throw error;
      throw networkError('POST', LOGIN_PATH, error);
    } finally {
      end();
    }

    const { status } = response;
    if (status === 401 || status === 403) {
      const message =
        status === 403
          ? INACTIVE_ACCOUNT_MESSAGE
          : this.loggedInBefore
            ? REVOKED_CREDENTIALS_MESSAGE
            : INVALID_CREDENTIALS_MESSAGE;
      this.refusal = { message, status, at: this.now() };
      this.log.info(`login refused (HTTP ${status})`);
      throw new ToolError('LoginRefused', message, status);
    }
    if (status >= 400) {
      const described = describeApiError(status, response.text, LOGIN_PATH);
      throw new ToolError(described.code, described.message, status, described.fieldLocations);
    }

    const body = parseJson(response.text);
    const token = body.ok
      ? (body.value as { accessToken?: unknown } | null)?.accessToken
      : undefined;
    if (typeof token !== 'string' || token === '') {
      throw new ToolError('InvalidResponse', NO_ACCESS_TOKEN_MESSAGE, status);
    }
    if (!USABLE_TOKEN.test(token)) {
      throw new ToolError('InvalidResponse', UNUSABLE_ACCESS_TOKEN_MESSAGE, status);
    }
    this.token = token;
    this.loggedInBefore = true;
    this.log.info(reason === 'after401' ? 'logged in again after HTTP 401' : 'logged in');
    return token;
  }

  /**
   * Sends one request with the call's signal and a timeout of at most the rest of the call time. It
   * starts inside the request limits, and only with at least MIN_REQUEST_TIME_MS left. On every
   * path after its start, it frees its place among the running requests. Its start stays in the
   * count of the minute.
   */
  private async send(
    call: CallState,
    request: ApiRequest,
    url: string,
    token: string,
  ): Promise<RawResponse> {
    this.checkCall(call, request);
    const end = await this.startRequest(call.deadline - MIN_REQUEST_TIME_MS, call.signal);
    try {
      // The turn of a waiting request can come after the limit of its wait, for example after a
      // stall of the event loop. Such a request did not start in time.
      const remaining = call.deadline - this.now();
      if (remaining < MIN_REQUEST_TIME_MS) throw rateLimited();
      const limitedByCall = remaining < this.timeoutMs;
      const timeout = AbortSignal.timeout(limitedByCall ? remaining : this.timeoutMs);
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (request.body !== undefined) headers['Content-Type'] = 'application/json';
      headers.Authorization = token;

      call.requestCount += 1;
      try {
        const answer = await this.fetch(url, {
          method: request.method,
          headers,
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          redirect: 'error',
          signal: AbortSignal.any([call.signal, timeout]),
        });
        return { status: answer.status, text: await readText(answer, request, this.maxAnswerBytes) };
      } catch (error) {
        if (call.signal.aborted) throw canceled();
        if (timeout.aborted) {
          throw new ToolError(
            'Timeout',
            limitedByCall
              ? this.callTimeLimitMessage(request)
              : this.requestTimeoutMessage(request.method, request.path),
          );
        }
        if (error instanceof ToolError) throw error;
        throw networkError(request.method, request.path, error);
      }
    } finally {
      end();
    }
  }

  /**
   * Returns the answer of a request, or throws its ToolError. A 422 of a request with
   * `personalInput` in a call with Personal data set to Leave out names the field locations without
   * alfaview's texts, which can repeat an email address of the input.
   */
  private result<T>(call: CallState, request: ApiRequest, response: RawResponse): ApiResponse<T> {
    const { status } = response;
    if (status >= 400) {
      if (request.allowStatuses?.includes(status)) return { status, data: undefined };
      const { code, message, fieldLocations } = describeApiError(
        status,
        response.text,
        request.path,
      );
      const hidesInput =
        status === 422 && request.personalInput === true && call.personalData === 'omit';
      const text = hidesInput ? inputErrorWithoutPersonalData(fieldLocations) : message;
      throw new ToolError(code, text, status, fieldLocations);
    }
    const body = parseJson(response.text);
    if (!body.ok) {
      throw new ToolError(
        'InvalidResponse',
        `alfaview sent a response that is not JSON (HTTP ${status}).`,
        status,
      );
    }
    return { status, data: body.value as T | undefined };
  }
}
