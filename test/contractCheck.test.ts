// Tests of the spec contract check of helpers/spec.ts, which compares each faked request with the
// alfaview API spec.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeFetch, loginRequest, testApi, toolErrorOf } from './helpers/fakeFetch.ts';

const PROBE = fileURLToPath(new URL('./helpers/contractHookProbe.ts', import.meta.url));

describe('the contract check of the fake fetch', () => {
  it('fails assertDone for a request that does not fit the spec', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'GET', path: '/v2/rooms/r1', query: { limit: '5' }, respond: { status: 200, body: {} } },
    ]);
    await api.request({ method: 'GET', path: '/v2/rooms/r1', query: { limit: 5 } });
    assert.throws(
      () => fake.assertDone(),
      /GET \/v2\/rooms\/r1\?limit=5 \(test\/contractCheck\.test\.ts:\d+\): GetRoom, query: The operation has no query parameter limit\./,
    );
  });

  it('fails assertDone also when the code catches the error of the answer', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'GET', path: '/v2/no-such-path', respond: { status: 404, body: {} } },
    ]);
    await toolErrorOf(api.request({ method: 'GET', path: '/v2/no-such-path' }));
    assert.throws(
      () => fake.assertDone(),
      /GET \/v2\/no-such-path .*: no operation, operation: No path of the spec matches \/v2\/no-such-path\./,
    );
  });

  it('checks nothing for an entry that gives a reason to skip the check', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      {
        method: 'GET',
        path: '/v2/no-such-path',
        contract: { skip: 'The path is invalid on purpose.' },
        respond: { status: 200, body: {} },
      },
    ]);
    await api.request({ method: 'GET', path: '/v2/no-such-path' });
    fake.assertDone();
  });

  it('refuses an entry that skips the check without a reason', () => {
    assert.throws(
      () => fakeFetch([{ method: 'GET', path: '/v2/users/me', contract: { skip: ' ' }, respond: { status: 200 } }]),
      { message: 'The mock of GET /v2/users/me skips the contract check without a reason in contract.skip.' },
    );
  });
});

describe('the root hooks of the contract check', () => {
  it('fail a test for a problem that no fake took', () => {
    // An empty environment: the child must not see the variables of this test run.
    const child = spawnSync(process.execPath, ['--test', PROBE], { encoding: 'utf8', env: {} });
    assert.equal(child.status, 1, child.stdout + child.stderr);
    assert.match(
      child.stdout,
      /GET \/v2\/no-such-path \(test\/helpers\/contractHookProbe\.ts:8\): no operation, operation: No path of the spec matches \/v2\/no-such-path\./,
    );
  });
});
