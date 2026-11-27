import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  COMPANY_NOT_RETURNED_MESSAGE,
  getOwnCompany,
  getOwnUser,
  mapCompany,
  PROFILE_NOT_RETURNED_MESSAGE,
  updateOwnUser,
} from '../../src/domain/account.ts';
import { loginRequest, testApi, toolErrorOf } from '../helpers/fakeFetch.ts';
import { fixture } from '../helpers/fixtures.ts';

describe('mapCompany', () => {
  it('gives the company ID and the name, without the creation time', () => {
    assert.deepEqual(mapCompany(fixture('core/own-company.json')), {
      id: 'company-1',
      displayName: 'Example Training GmbH',
    });
  });

  it('gives null for absent and empty values', () => {
    assert.deepEqual(mapCompany({ displayName: '' }), { id: null, displayName: null });
  });
});

describe('account requests', () => {
  it('getOwnUser reads GET /v2/users/me', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      {
        method: 'GET',
        path: '/v2/users/me',
        respond: { status: 200, body: fixture('core/user-profile.json') },
      },
    ]);
    assert.equal((await getOwnUser(api)).id, '6c1d9e4f-2a7b-5c3d-9e8f-0a1b2c3d4e5f');
    fake.assertDone();
  });

  it('getOwnUser fails with InvalidResponse when the body is not a profile with an ID', async () => {
    for (const body of ['null', [], {}, { id: 7 }]) {
      const { api, fake } = testApi([
        loginRequest(),
        { method: 'GET', path: '/v2/users/me', respond: { status: 200, body } },
      ]);
      const error = await toolErrorOf(getOwnUser(api));
      assert.deepEqual([error.code, error.message], ['InvalidResponse', PROFILE_NOT_RETURNED_MESSAGE]);
      fake.assertDone();
    }
    assert.equal(PROFILE_NOT_RETURNED_MESSAGE, 'alfaview did not return the user profile.');
  });

  it('getOwnCompany reads GET /v2/users/me/company and fails for a body that is no object', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      {
        method: 'GET',
        path: '/v2/users/me/company',
        respond: { status: 200, body: fixture('core/own-company.json') },
      },
      { method: 'GET', path: '/v2/users/me/company', respond: { status: 200 } },
      { method: 'GET', path: '/v2/users/me/company', respond: { status: 200, body: [] } },
    ]);
    assert.equal((await getOwnCompany(api)).companyId, 'company-1');
    for (let index = 0; index < 2; index += 1) {
      const error = await toolErrorOf(getOwnCompany(api));
      assert.deepEqual([error.code, error.message], ['InvalidResponse', COMPANY_NOT_RETURNED_MESSAGE]);
    }
    fake.assertDone();
  });

  it('updateOwnUser sends PATCH /v2/users with the change as it is', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      {
        method: 'PATCH',
        path: '/v2/users',
        body: { title: 'Dr.', locale: 'de-DE' },
        respond: { status: 204 },
      },
    ]);
    await updateOwnUser(api, { title: 'Dr.', locale: 'de-DE' });
    fake.assertDone();
  });
});
