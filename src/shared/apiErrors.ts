/**
 * Messages and codes for alfaview error answers, read from their problem+json body. The caller
 * builds its own error from them and passes the HTTP status texts that it has.
 */

/**
 * The texts of an alfaview error body. alfaview answers an error with problem+json that holds
 * `title`, `status`, `detail` and `errors[]` with `message` and `location`. The code shows these
 * texts and never branches on what they say.
 */
export type Problem = {
  title?: string;
  detail?: string;
  errors: { message: string; location?: string }[];
};

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Reads a problem+json body. Never throws: anything unreadable gives an empty problem. */
export function parseProblem(content: unknown): Problem {
  let body: unknown = content;
  if (typeof content === 'string') {
    try {
      body = JSON.parse(content);
    } catch {
      return { errors: [] };
    }
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { errors: [] };
  }

  const record = body as Record<string, unknown>;
  const problem: Problem = { errors: [] };
  const title = nonEmptyString(record.title);
  const detail = nonEmptyString(record.detail);
  if (title !== undefined) problem.title = title;
  if (detail !== undefined) problem.detail = detail;

  if (Array.isArray(record.errors)) {
    for (const entry of record.errors) {
      if (typeof entry !== 'object' || entry === null) continue;
      const message = nonEmptyString((entry as Record<string, unknown>).message);
      if (message === undefined) continue;
      const location = nonEmptyString((entry as Record<string, unknown>).location);
      problem.errors.push(location === undefined ? { message } : { message, location });
    }
  }
  return problem;
}

/** Returns the `location` of each entry of a problem's `errors[]` that has one, as sent. */
export function fieldLocations(problem: Problem): string[] {
  return problem.errors.flatMap((entry) => (entry.location === undefined ? [] : [entry.location]));
}

/** Removes trailing periods and whitespace, so a template can add exactly one period. */
function clause(text: string): string {
  return text.trim().replace(/[.\s]+$/, '');
}

/** The name of each API collection in a 404 message. The API calls breakout rooms `subrooms`. */
const RESOURCE_NAMES: Record<string, string> = {
  rooms: 'room',
  subrooms: 'breakout room',
  meetings: 'meeting',
  'guest-links': 'guest link',
  'group-links': 'group link',
  users: 'user',
  permissions: 'room permission',
  'permission-groups': 'permission group',
};

function resourceName(segment: string | undefined): string | undefined {
  return segment !== undefined && Object.prototype.hasOwnProperty.call(RESOURCE_NAMES, segment)
    ? RESOURCE_NAMES[segment]
    : undefined;
}

/**
 * Names the resource that a 404 refers to: the innermost collection in the path that is followed
 * by an ID. `/v2/rooms/{id}/guest-links` is the room, `/v2/rooms/{id}/guest-links/{id}` the guest
 * link. A query string is ignored.
 */
export function resourceFromPath(path: string | undefined): string {
  let segments = (path ?? '')
    .split('?')[0]!
    .split('/')
    .filter((segment) => segment !== '');
  if (segments[0] === 'v2') segments = segments.slice(1);

  let resource: string | undefined;
  for (let index = 0; index + 1 < segments.length; index += 2) {
    resource = resourceName(segments[index]) ?? resource;
  }
  return resource ?? resourceName(segments[0]) ?? 'requested item';
}

/** The text of an HTTP status, for example `Not Found` for 404. */
export type StatusTexts = Readonly<Record<number, string | undefined>>;

/**
 * Texts for the statuses alfaview answers, for a caller that cannot read Node's `STATUS_CODES`.
 * Any other status reads `HTTP {status}`.
 */
export const STATUS_TEXTS: StatusTexts = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

/**
 * Builds the user-facing message and a short code for an alfaview error answer. `path` is the
 * request path, for the resource of a 404. `statusTexts` gives the text of a status whose
 * problem has no detail and no title. A status that it does not know reads `HTTP {status}`.
 */
export function describeApiError(
  status: number,
  content: unknown,
  path: string | undefined,
  statusTexts: StatusTexts,
): { message: string; code: string } {
  const problem = parseProblem(content);
  const statusText = statusTexts[status] ?? `HTTP ${status}`;
  const detail = clause(problem.detail ?? problem.title ?? statusText);

  if (status === 400) {
    return { code: 'BadRequest', message: `alfaview rejected the request: ${detail}.` };
  }
  if (status === 403) {
    return {
      code: 'Forbidden',
      message: `The API key's user is not allowed to do this (${detail}). Give that user the needed room or user permission.`,
    };
  }
  if (status === 404) {
    return {
      code: 'NotFound',
      message: `alfaview could not find the ${resourceFromPath(path)}. It was deleted, or the API key's user cannot see it.`,
    };
  }
  if (status === 409) {
    return { code: 'Conflict', message: `${detail}.` };
  }
  if (status === 422) {
    const details = problem.errors
      .map(({ message, location }) => {
        const where = location?.replace(/^body\./, '');
        return where ? ` ${where}: ${clause(message)}.` : ` ${clause(message)}.`;
      })
      .join('');
    return {
      code: 'ValidationFailed',
      message: `alfaview could not process the input: ${detail}.${details}`,
    };
  }
  if (status === 429) {
    return {
      code: 'TooManyRequests',
      message: 'alfaview received too many requests (HTTP 429). Try again later.',
    };
  }
  if (status >= 500 && status <= 599) {
    return {
      code: 'ServerError',
      message: `alfaview had a temporary problem (HTTP ${status}). Try again later.`,
    };
  }
  return { code: 'HttpError', message: `alfaview answered with HTTP ${status}: ${detail}.` };
}
