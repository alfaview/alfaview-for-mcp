// A test file that contractCheck.test.ts runs in a child process. Its one test keeps a contract
// problem that no fake owns, so only the root hooks of spec.ts can report it. Its name does not
// end in .test.ts, so the test run of the package does not start it.
import { it } from 'node:test';
import { keepContractProblems } from './spec.ts';

it('sends a request that does not fit the spec', () => {
  const request = { method: 'GET', path: '/v2/no-such-path', headers: undefined, body: undefined };
  keepContractProblems(request, 'test/helpers/contractHookProbe.ts:8', undefined);
});
