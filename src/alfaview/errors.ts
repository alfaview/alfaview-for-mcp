// The errors of the server: ToolError, whose message goes to the model, the texts of alfaview error
// answers, and the handling of a write whose outcome is unknown.
import { STATUS_CODES } from 'node:http';
import {
  describeApiError as describeAnswer,
  fieldLocations,
  parseProblem,
  type Problem,
} from '../shared/apiErrors.ts';
import type { ApiRequest, ApiResponse, CallApi } from './client.ts';

/**
 * The error that a tool call reports to the model. The message goes to the model word for word,
 * the code goes to the log line. Every error of the client and the domain functions is a
 * ToolError, except an error that shows a bug, such as a refused API path or a page size that is
 * not a positive integer.
 */
export class ToolError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  /**
   * The `location` of each entry of a problem's `errors[]`, as sent, for example
   * `body.create[0].emailAddress`. Empty when the problem has none.
   */
  readonly fieldLocations: readonly string[];

  constructor(
    code: string,
    message: string,
    status?: number,
    fieldLocations: readonly string[] = [],
  ) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.status = status;
    this.fieldLocations = fieldLocations;
  }
}

/** Returns a ToolError with the code InvalidInput: the input cannot be used. */
export function invalidInput(message: string): ToolError {
  return new ToolError('InvalidInput', message);
}

/**
 * Returns a ToolError with the code InvalidResponse: alfaview sent an answer that cannot be used.
 */
export function invalidResponse(message: string): ToolError {
  return new ToolError('InvalidResponse', message);
}

/**
 * Returns whether alfaview refused the request of `error` with a status of 400 to 499. For a
 * request of one step, alfaview then saved nothing of it. A status of 500 and up, a timeout or a
 * lost answer can come after the save. An error without a status, such as a local request limit
 * or a login that timed out, counts as not refused, which is the safe side. A login that alfaview
 * refused counts as refused: the request did not go out. An update of a room is the exception:
 * alfaview can save the room and then refuse its waiting room options.
 */
export function refusedByAlfaview(error: unknown): error is ToolError {
  return (
    error instanceof ToolError &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500
  );
}

/** Returns the error text of a create answer without the ID of the new resource. */
export function missingCreatedIdMessage(noun: string): string {
  return `alfaview did not return the ID of the new ${noun}.`;
}

/**
 * The statuses of a create request after which alfaview may have saved the new resource: alfaview
 * answers 500 also for a timeout, and a step after the save can fail.
 */
const UNCERTAIN_CREATE_STATUSES: readonly number[] = [500, 502, 503, 504];

/**
 * The errors of a create request that may have reached alfaview. AnswerTooLarge comes after the
 * status of the answer, which can be a success.
 */
export const UNCERTAIN_CREATE_CODES: readonly string[] = [
  'Timeout',
  'NetworkError',
  'Canceled',
  'AnswerTooLarge',
];

/**
 * Sends a create request whose outcome can be unknown. A status of UNCERTAIN_CREATE_STATUSES or an
 * error of UNCERTAIN_CREATE_CODES gives a ToolError with `uncertainMessage`, which tells the model
 * to check before it creates the resource again, because a second create makes a second resource.
 * Its code is the code of the error, or ServerError for a status. Other errors pass unchanged.
 */
export async function sendCreate<T>(
  api: CallApi,
  request: Omit<ApiRequest, 'allowStatuses'>,
  uncertainMessage: string,
): Promise<ApiResponse<T>> {
  let answer: ApiResponse<T>;
  try {
    answer = await api.request<T>({ ...request, allowStatuses: UNCERTAIN_CREATE_STATUSES });
  } catch (error) {
    if (error instanceof ToolError && UNCERTAIN_CREATE_CODES.includes(error.code)) {
      throw new ToolError(error.code, uncertainMessage, error.status);
    }
    throw error;
  }
  if (UNCERTAIN_CREATE_STATUSES.includes(answer.status)) {
    throw new ToolError('ServerError', uncertainMessage, answer.status);
  }
  return answer;
}

/**
 * Runs the read back after a write that alfaview saved. When `read` fails, the function throws a
 * ToolError with `message` in its place, which says that the write is saved. Its code is the code
 * of the read error, or
 * InvalidResponse for an error that is not a ToolError. The message of the read error, such as
 * "Try again later.", would make the model repeat the write, and a repeat can create a second
 * resource or send a second email.
 */
export async function readAfterSavedWrite<T>(read: () => Promise<T>, message: string): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const code = error instanceof ToolError ? error.code : 'InvalidResponse';
    throw new ToolError(code, message);
  }
}

export type ApiErrorDescription = {
  code: string;
  message: string;
  fieldLocations: string[];
};

/**
 * The most characters that the server keeps of each text of an error answer: the title, the
 * detail, and the message and the location of each entry of `errors[]`.
 */
export const PROBLEM_TEXT_MAX_CHARACTERS = 500;

/** The most entries of `errors[]` of an error answer that the server keeps. */
export const PROBLEM_ERRORS_MAX = 20;

/** The end of a text of an error answer that the server cut. */
const CUT_MARK = ' (shortened)';

function cut(text: string): string {
  return text.length > PROBLEM_TEXT_MAX_CHARACTERS
    ? `${text.slice(0, PROBLEM_TEXT_MAX_CHARACTERS)}${CUT_MARK}`
    : text;
}

/**
 * Returns the problem of an error answer with each text cut to PROBLEM_TEXT_MAX_CHARACTERS and at
 * most PROBLEM_ERRORS_MAX entries of `errors[]`. alfaview or a proxy can send texts of any length,
 * which go to the model word for word. Also, the end trim of describeAnswer takes a time that grows
 * with the square of a long run of spaces or periods, and no time limit of a call stops it.
 */
function boundedProblem(content: unknown): Problem {
  const problem = parseProblem(content);
  const bounded: Problem = {
    errors: problem.errors.slice(0, PROBLEM_ERRORS_MAX).map(({ message, location }) =>
      location === undefined ? { message: cut(message) } : { message: cut(message), location: cut(location) },
    ),
  };
  if (problem.title !== undefined) bounded.title = cut(problem.title);
  if (problem.detail !== undefined) bounded.detail = cut(problem.detail);
  return bounded;
}

/**
 * Builds the message for the model, a short code and the field locations of an error answer to
 * the request `path`, from its problem with bounded texts (boundedProblem). A problem without a
 * detail and a title shows the status text of Node.
 */
export function describeApiError(
  status: number,
  content: unknown,
  path: string | undefined,
): ApiErrorDescription {
  const problem = boundedProblem(content);
  return {
    ...describeAnswer(status, problem, path, STATUS_CODES),
    fieldLocations: fieldLocations(problem),
  };
}
