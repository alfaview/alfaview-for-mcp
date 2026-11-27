import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ApiRequest, ApiResponse, CallApi } from '../../src/alfaview/client.ts';
import { PROFILE_NOT_RETURNED_MESSAGE } from '../../src/domain/account.ts';
import {
  deleteUser,
  findInvitedUser,
  hasAnEmailAddress,
  hasEmailAddress,
  INVITE_UNCERTAIN_MESSAGE,
  inviteUser,
  isUserId,
  listUsers,
  mapListedUser,
  readApiKeyUserId,
  sameId,
  userDeleteQuestion,
  userNames,
  USERS_UNEXPECTED_MESSAGE,
  usersMatching,
  type ApiUser,
} from '../../src/domain/users.ts';
import { LOOKUP_STATUSES_WITHOUT_USER } from '../../src/shared/users.ts';
import { loginRequest, testApi, toolErrorOf, type FakeAnswer } from '../helpers/fakeFetch.ts';
import { fixture } from '../helpers/fixtures.ts';

const users = () => fixture<ApiUser[]>('users/users.json');

describe('isUserId', () => {
  it('takes a version 5 UUID with the kind 18 (hex 12) and a version 4 UUID, in any case', () => {
    for (const id of [
      'c0ffee00-0000-5000-8000-120000000001',
      'C0FFEE00-0000-5000-8000-12000000000A',
      '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e',
      '0f1e2d3c-4b5a-4968-8778-120000000001',
    ]) {
      assert.equal(isUserId(id), true, id);
    }
  });

  it('refuses the IDs of guest links, group links, guests and rooms, and the key of the default permissions', () => {
    for (const id of [
      'c0ffee00-0000-5000-8000-140000000001',
      'c0ffee00-0000-5000-8000-150000000001',
      'c0ffee00-0000-5000-8000-180000000001',
      'c0ffee00-0000-5000-8000-210000000001',
      '11111111-1111-1111-1111-111111111111',
      'c0ffee00-0000-1000-8000-120000000001',
      'c0ffee00-0000-5000-8000-12000000001',
      'Anna Example',
    ]) {
      assert.equal(isUserId(id), false, id);
    }
  });
});

describe('sameId and hasEmailAddress', () => {
  it('compare IDs in any case', () => {
    assert.equal(sameId('C0FFEE00-0000-5000-8000-120000000001', 'c0ffee00-0000-5000-8000-120000000001'), true);
    assert.equal(sameId('c0ffee00-0000-5000-8000-120000000001', 'c0ffee00-0000-5000-8000-120000000002'), false);
  });

  it('compare the trimmed email address in any case, and never match a user without one', () => {
    const user = { id: 'u1', emailAddress: ' Anna.Example@Example.com ' };
    assert.equal(hasEmailAddress(user, 'anna.example@example.COM'), true);
    assert.equal(hasEmailAddress(user, ' anna.example@example.com '), true);
    assert.equal(hasEmailAddress(user, 'anna@example.com'), false);
    assert.equal(hasEmailAddress({ id: 'u2' }, 'anna@example.com'), false);
  });

  it('tell a user with an address from a user whose address is missing or blank', () => {
    assert.equal(hasAnEmailAddress({ id: 'u1', emailAddress: 'anna@example.com' }), true);
    for (const user of [{ id: 'u2' }, { id: 'u3', emailAddress: '' }, { id: 'u4', emailAddress: ' \t' }]) {
      assert.equal(hasAnEmailAddress(user), false, user.id);
    }
  });
});

describe('userDeleteQuestion', () => {
  it('names a user without a name and without an address by the ID', () => {
    const id = 'c0ffee00-0000-5000-8000-120000000002';
    assert.equal(
      userDeleteQuestion({ id, firstName: ' ' }, id, 'include'),
      `Delete the user with the ID ${id} for good? The user can no longer sign in, also not with an API key, and access can last up to one hour. Rooms and room permissions of the user stay. This cannot be undone.`,
    );
  });
});

describe('mapListedUser', () => {
  it('gives the user without city and initials, in the documented key order', () => {
    const output = mapListedUser(users()[2]!);
    assert.deepEqual(output, {
      id: '1a2b3c4d-5e6f-5a7b-8c9d-0e1f2a3b4c5d',
      emailAddress: 'max.mustermann@example.com',
      firstName: 'Max',
      lastName: 'Mustermann',
      title: 'Dr.',
      locale: 'de-DE',
    });
    assert.deepEqual(Object.keys(output), ['id', 'emailAddress', 'firstName', 'lastName', 'title', 'locale']);
  });

  it('gives null for absent and empty values', () => {
    assert.deepEqual(mapListedUser({ id: 'u1', firstName: '' }), {
      id: 'u1',
      emailAddress: null,
      firstName: null,
      lastName: null,
      title: null,
      locale: null,
    });
  });

  // alfaview answers `unknown` for a user without a language (spec: User, `locale`).
  it('gives a null locale for unknown, in any case, and for an empty or blank one', () => {
    for (const locale of ['unknown', 'Unknown', '', '  ']) {
      assert.equal(mapListedUser({ ...users()[2]!, locale }).locale, null, JSON.stringify(locale));
    }
    assert.equal(mapListedUser({ ...users()[2]!, locale: 'en-US' }).locale, 'en-US');
  });
});

describe('usersMatching', () => {
  const ids = (matches: ApiUser[]) => matches.map((user) => user.emailAddress);

  it('gives every user without a filter', () => {
    assert.equal(usersMatching(users(), {}).length, 4);
  });

  it('matches the whole email address in any case', () => {
    assert.deepEqual(ids(usersMatching(users(), { emailAddress: 'BEN.example@example.com' })), [
      'ben.example@example.com',
    ]);
    assert.deepEqual(usersMatching(users(), { emailAddress: 'example.com' }), []);
  });

  it('matches a part of the first name, of the last name, or of both joined by a space', () => {
    const named = [
      ...users(),
      { id: 'u5', firstName: '  Clara ', lastName: ' Zetkin  ', emailAddress: 'clara@example.com' },
    ];
    assert.deepEqual(ids(usersMatching(named, { name: 'NNA' })), ['anna.example@example.com']);
    assert.deepEqual(ids(usersMatching(named, { name: 'mann' })), ['max.mustermann@example.com']);
    assert.deepEqual(ids(usersMatching(named, { name: 'clara zet' })), ['clara@example.com']);
    assert.deepEqual(ids(usersMatching(named, { name: ' x mu ' })), ['max.mustermann@example.com']);
    assert.deepEqual(usersMatching(named, { name: 'service' }), []);
  });

  it('needs both filters to match when both are given', () => {
    assert.deepEqual(ids(usersMatching(users(), { name: 'example', emailAddress: 'anna.example@example.com' })), [
      'anna.example@example.com',
    ]);
    assert.deepEqual(usersMatching(users(), { name: 'max', emailAddress: 'anna.example@example.com' }), []);
  });
});

describe('userNames', () => {
  it('maps the lowercase user ID to the first and last name, or null without a name', () => {
    const names = userNames([
      ...users(),
      { id: 'C0FFEE00-0000-5000-8000-120000000009', firstName: ' Clara ', lastName: '' },
      { id: 'c0ffee00-0000-5000-8000-12000000000a', lastName: 'Zetkin' },
    ]);
    assert.deepEqual([...names], [
      ['7e8f9a0b-1c2d-5e3f-8a4b-5c6d7e8f9a0b', null],
      ['6c1d9e4f-2a7b-5c3d-9e8f-0a1b2c3d4e5f', 'Anna Example'],
      ['1a2b3c4d-5e6f-5a7b-8c9d-0e1f2a3b4c5d', 'Max Mustermann'],
      ['3b4c5d6e-7f8a-5b9c-8d0e-1f2a3b4c5d6e', 'Ben Example'],
      ['c0ffee00-0000-5000-8000-120000000009', 'Clara'],
      ['c0ffee00-0000-5000-8000-12000000000a', 'Zetkin'],
    ]);
  });
});

describe('user requests', () => {
  const list = (respond: FakeAnswer) => ({ method: 'GET', path: '/v2/users', respond });
  const lookup = (respond: FakeAnswer) => ({
    method: 'GET',
    path: '/v2/users',
    query: { emailAddress: 'max.mustermann@example.com' },
    respond,
  });

  it('listUsers reads GET /v2/users, leaves out entries without an ID and reads null as no users', async () => {
    const withoutId = [...users(), { emailAddress: 'no.id@example.com' }];
    const { api, fake } = testApi([
      loginRequest(),
      list({ status: 200, body: withoutId }),
      list({ status: 200, body: 'null' }),
    ]);
    assert.equal((await listUsers(api)).length, 4);
    assert.deepEqual(await listUsers(api), []);
    fake.assertDone();
  });

  it('listUsers fails with InvalidResponse for an answer that is no list', async () => {
    const { api, fake } = testApi([loginRequest(), list({ status: 200, body: { data: [] } })]);
    const error = await toolErrorOf(listUsers(api));
    fake.assertDone();

    assert.deepEqual([error.code, error.message], ['InvalidResponse', USERS_UNEXPECTED_MESSAGE]);
  });

  it('readApiKeyUserId gives the ID of GET /v2/users/me, and the profile message without one', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'GET', path: '/v2/users/me', respond: { status: 200, body: fixture('core/user-profile.json') } },
      { method: 'GET', path: '/v2/users/me', respond: { status: 200, body: { emailAddress: 'a@example.com' } } },
    ]);
    assert.equal(await readApiKeyUserId(api), '6c1d9e4f-2a7b-5c3d-9e8f-0a1b2c3d4e5f');
    const error = await toolErrorOf(readApiKeyUserId(api));
    fake.assertDone();

    assert.deepEqual([error.code, error.message], ['InvalidResponse', PROFILE_NOT_RETURNED_MESSAGE]);
  });

  it('findInvitedUser finds the user with the address in any case', async () => {
    const max = { ...users()[2]!, emailAddress: 'Max.Mustermann@Example.com' };
    const { api, fake } = testApi([
      loginRequest(),
      lookup({ status: 200, body: [max] }),
      lookup({ status: 200, body: [users()[1]] }),
      lookup({ status: 200, body: null }),
    ]);
    assert.equal((await findInvitedUser(api, 'max.mustermann@example.com'))?.id, max.id);
    assert.equal(await findInvitedUser(api, 'max.mustermann@example.com'), undefined);
    assert.equal(await findInvitedUser(api, 'max.mustermann@example.com'), undefined);
    fake.assertDone();
  });

  it('findInvitedUser gives undefined for 403, 404 and 422, and fails for another error or a body that is no list', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      ...[403, 404, 422].map((status) => lookup({ status, body: fixture(`core/problem-${status}.json`) })),
      lookup({ status: 500, body: fixture('core/problem-500.json') }),
      lookup({ status: 200, body: {} }),
    ]);
    for (let index = 0; index < 3; index += 1) {
      assert.equal(await findInvitedUser(api, 'max.mustermann@example.com'), undefined);
    }
    const server = await toolErrorOf(findInvitedUser(api, 'max.mustermann@example.com'));
    const unexpected = await toolErrorOf(findInvitedUser(api, 'max.mustermann@example.com'));
    fake.assertDone();

    assert.equal(server.code, 'ServerError');
    assert.deepEqual([unexpected.code, unexpected.message], ['InvalidResponse', USERS_UNEXPECTED_MESSAGE]);
  });

  it('findInvitedUser marks its lookup as a personal input, because a 422 can repeat the address', async () => {
    // The invite tool drops every ToolError of the lookup, so only the request shows the mark.
    const requests: ApiRequest[] = [];
    const api: CallApi = {
      async request<T>(request: ApiRequest): Promise<ApiResponse<T>> {
        requests.push(request);
        return { status: 200, data: undefined };
      },
      requestCount: 0,
      elapsedMs: () => 0,
    };
    assert.equal(await findInvitedUser(api, 'max.mustermann@example.com'), undefined);

    assert.deepEqual(requests, [
      {
        method: 'GET',
        path: '/v2/users',
        query: { emailAddress: 'max.mustermann@example.com' },
        allowStatuses: LOOKUP_STATUSES_WITHOUT_USER,
        personalInput: true,
      },
    ]);
  });

  it('inviteUser sends POST /v2/users/invitation with the user without empty values, and the permissions', async () => {
    const permissions = {
      manageCompany: false,
      userAdmin: false,
      userList: true,
      userShow: false,
      roomAdmin: false,
      roomList: false,
      roomCreate: true,
    };
    const { api, fake } = testApi([
      loginRequest(),
      {
        method: 'POST',
        path: '/v2/users/invitation',
        body: { user: { emailAddress: 'nina@example.com', firstName: 'Nina', lastName: 'New' }, permissions },
        respond: { status: 202 },
      },
      {
        method: 'POST',
        path: '/v2/users/invitation',
        body: { user: { emailAddress: 'nina@example.com', firstName: 'Nina', lastName: 'New' }, permissions },
        respond: { status: 503, body: fixture('core/problem-500.json') },
      },
    ]);
    const user = { emailAddress: 'nina@example.com', firstName: 'Nina', lastName: 'New', title: undefined };
    await inviteUser(api, user, permissions);
    const error = await toolErrorOf(inviteUser(api, user, permissions));
    fake.assertDone();

    assert.deepEqual([error.code, error.message, error.status], ['ServerError', INVITE_UNCERTAIN_MESSAGE, 503]);
  });

  it('deleteUser sends DELETE /v2/users/{id} with the ID in lowercase', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'DELETE', path: '/v2/users/c0ffee00-0000-5000-8000-12000000000a', respond: { status: 204 } },
    ]);
    await deleteUser(api, 'C0FFEE00-0000-5000-8000-12000000000A');
    fake.assertDone();
  });
});
