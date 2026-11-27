// The 422 answers of `GET /v2/stats` that no test of a tool reaches: the MCP server refuses such a
// range before the request. The spec of the API (spec/openapi-v2.json) lists the cases.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { TEST_ENV } from '../helpers/spawnServer.ts';
import { createFakeApi, newCompanyState } from './server.ts';

const FROM = '2026-10-27T09:00:00.000Z';
const TO = '2026-10-28T09:00:00.000Z';

const spec = JSON.parse(readFileSync(new URL('../../spec/openapi-v2.json', import.meta.url), 'utf8'));

/** Returns the answer of a fake API with the state of a new company to `GET <target>`. */
function get(target: string) {
  const api = createFakeApi(newCompanyState());
  const login = api.handle({
    method: 'POST',
    target: '/v2/auth/api-key',
    headers: { 'content-type': 'application/json' },
    text: JSON.stringify({
      companyId: TEST_ENV.ALFAVIEW_COMPANY_ID,
      clientId: TEST_ENV.ALFAVIEW_CLIENT_ID,
      key: TEST_ENV.ALFAVIEW_API_KEY,
    }),
  });
  const { accessToken } = login.body as { accessToken: string };
  return api.handle({ method: 'GET', target, headers: { authorization: accessToken }, text: '' });
}

function statistics(from: string, to: string) {
  return get(`/v2/stats?${new URLSearchParams({ from, to, stepDurationHours: '24' })}`);
}

describe('GET /v2/stats of the fake API', () => {
  for (const [detail, from, to, fromMessage, toMessage] of [
    ['`from` equals `to`', FROM, FROM, 'equals `to`', 'equals `from`'],
    ['`from` is after `to`', TO, FROM, 'after `to`', 'before `from`'],
  ] as const) {
    it(`answers 422 with an error for each bound when ${detail}`, () => {
      const { description } = spec.paths['/v2/stats'].get.responses['422'];
      assert.ok(description.split('\n').includes(`- ${detail}`), description);

      assert.deepEqual(statistics(from, to), {
        status: 422,
        body: {
          title: 'Unprocessable Entity',
          status: 422,
          detail,
          errors: [
            { message: fromMessage, location: 'query.from' },
            { message: toMessage, location: 'query.to' },
          ],
        },
      });
    });
  }
});
