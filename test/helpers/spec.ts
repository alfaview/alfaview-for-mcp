// The contract check of the tests: each fake gives it the requests that it receives, and it checks
// them against spec/openapi-v2.json, a copy of the published alfaview API spec. Importing this
// module registers two root hooks of node:test, which fail a test for the problems of its requests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { after, afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ApiRequest } from '../../src/alfaview/client.ts';
import {
  createContractCheck,
  type ContractProblem,
  type ContractRequest,
} from '../shared/contract.ts';

const SPEC_URL = new URL('../../spec/openapi-v2.json', import.meta.url);

/** The package folder, which the file names of the problems are relative to. */
const PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url));

/** A frame of a test file in a stack: the file URL and the line. */
const TEST_FILE_FRAME = /(file:\/\/[^\s()]+?\.test\.ts):(\d+):\d+/g;

/** The check of one request against spec/openapi-v2.json. */
export const checkContract = createContractCheck(JSON.parse(readFileSync(SPEC_URL, 'utf8')));

type KeptProblem = {
  /** The mock that received the request, so that its own assertion can take the problem. */
  owner: object | undefined;
  /** The line of the test file that made the mock, or undefined when it is not known. */
  site: string | undefined;
  /** `METHOD /path?query` */
  request: string;
  problem: ContractProblem;
};

const kept: KeptProblem[] = [];

/**
 * Returns the outermost line of a test file on the current stack, such as
 * `test/tools/rooms.test.ts:42`: the line of the test that calls the helpers. Undefined when no
 * test file is on the stack.
 */
export function testFileLine(): string | undefined {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 100;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = limit;
  let line: string | undefined;
  for (const match of stack.matchAll(TEST_FILE_FRAME)) {
    line = `${relative(PACKAGE_DIR, fileURLToPath(match[1]!))}:${match[2]}`;
  }
  return line;
}

/**
 * Checks `request` and keeps its problems until the end of the test. `site` is the line of the test
 * file that made the mock, and `owner` the mock that received the request.
 */
export function keepContractProblems(
  request: ContractRequest,
  site: string | undefined,
  owner: object | undefined,
): void {
  for (const problem of checkContract(request)) {
    kept.push({ owner, site, request: `${request.method} ${request.path}`, problem });
  }
}

/**
 * Checks a request of the call API (`CallApi.request` of src/alfaview/client.ts) and keeps its
 * problems until the end of the test, for a fake of the call API. The query is added to the path
 * as the client adds it to the URL, and the body is its JSON. The headers are not checked, because
 * the client adds them after the call API. `site` is the line of the test file that made the fake.
 */
export function keepApiRequestProblems(request: ApiRequest, site: string | undefined): void {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined) query.append(name, String(value));
  }
  const search = query.toString();
  const contractRequest = {
    method: request.method,
    path: search === '' ? request.path : `${request.path}?${search}`,
    headers: undefined,
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
  };
  keepContractProblems(contractRequest, site, undefined);
}

/** Removes the kept problems of `owner`, or all of them, and returns them. */
function take(owner: object | undefined): KeptProblem[] {
  const taken = kept.filter((item) => owner === undefined || item.owner === owner);
  const rest = kept.filter((item) => !taken.includes(item));
  kept.splice(0, kept.length, ...rest);
  return taken;
}

function lineOf(item: KeptProblem, fallbackSite: string | undefined): string {
  const { operation, rule, message } = item.problem;
  const site = item.site ?? fallbackSite ?? 'an unknown test file';
  return `${item.request} (${site}): ${operation ?? 'no operation'}, ${rule}: ${message}`;
}

/**
 * Removes the kept problems of the requests that `owner` received and returns them as lines for
 * its assertion.
 */
export function takeContractProblems(owner: object): string[] {
  return take(owner).map((item) => lineOf(item, undefined));
}

/** Fails the test `testName` in `file` for the problems that are left. */
function settle(testName: string, file: string | undefined): void {
  const problems = take(undefined);
  if (problems.length === 0) return;
  const fallbackSite = file === undefined ? undefined : relative(PACKAGE_DIR, file);
  const lines = problems.map((item) => `- ${lineOf(item, fallbackSite)}`);
  throw new assert.AssertionError({
    message: `Requests of ${testName} do not fit spec/openapi-v2.json:\n${lines.join('\n')}`,
  });
}

// The problems of a request are kept until the end of its test, so that they fail it also when the
// code under test caught the error of the answer. node:test runs a root `afterEach` after every
// test of the file, also inside `describe` and for subtests, and a throw in it fails that test.
// The root `after` runs before the root `after` hooks of the test file itself. It takes a problem
// that arrives after the last `afterEach`, such as one from an `after` hook of the last `describe`.
afterEach((context) => {
  const name = 'fullName' in context ? context.fullName : context.name;
  settle(`the test "${name}"`, context.filePath);
});
after((context) => settle('the hooks after the last test', context.filePath));
