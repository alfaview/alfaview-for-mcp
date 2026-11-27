import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CallApi } from '../../src/alfaview/client.ts';
import { ToolError } from '../../src/alfaview/errors.ts';
import {
  DEFAULT_GUEST_GROUP_NAME,
  listPermissionGroups,
  readGroupNames,
  refuseAdminGroup,
  refuseStoredAdminGroup,
  resolvePermissionGroup,
  type PermissionGroup,
} from '../../src/domain/permissionGroups.ts';
import {
  loginRequest,
  testApi,
  toolErrorOf,
  untilRequests,
  type ExpectedRequest,
  type FakeAnswer,
} from '../helpers/fakeFetch.ts';
import { fixture } from '../helpers/fixtures.ts';
import { keepApiRequestProblems, testFileLine } from '../helpers/spec.ts';

const GUEST_ID = 'd2b3c4d5-e6f7-5081-9a2b-c3d4e5f6a7b8';
const SPECTATOR_ID = 'f4a5b6c7-d8e9-5f0a-9b1c-2d3e4f5a6b7c';
const GROUP_NAMES = 'Admin, Moderator, Participant, Spectator, Guest';

const groups = () => fixture<PermissionGroup[]>('rooms/permission-groups.json');

function groupsRequest(respond: FakeAnswer): ExpectedRequest {
  return { method: 'GET', path: '/v2/permission-groups', respond };
}

/** Returns the ToolError that `resolve` throws, and fails the test when it throws none. */
function errorOf(resolve: () => unknown): ToolError {
  try {
    resolve();
  } catch (error) {
    assert.ok(error instanceof ToolError);
    return error;
  }
  throw new assert.AssertionError({ message: 'Expected an error.' });
}

describe('listPermissionGroups', () => {
  it('returns the groups in the order the company configured', async () => {
    const { api, fake } = testApi([loginRequest(), groupsRequest({ status: 200, body: groups() })]);
    const list = await listPermissionGroups(api);
    assert.deepEqual(
      list.map((group) => group.name),
      ['Admin', 'Moderator', 'Participant', 'Spectator', 'Guest'],
    );
    fake.assertDone();
  });

  it('treats null as an empty list and drops entries without ID or name', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      groupsRequest({ status: 200, body: 'null' }),
      groupsRequest({ status: 200, body: [{ id: 'g1' }, { name: 'Nameless' }, null, { id: 'g2', name: 'Kept' }] }),
    ]);
    assert.deepEqual(await listPermissionGroups(api), []);
    assert.deepEqual(await listPermissionGroups(api), [{ id: 'g2', name: 'Kept' }]);
    fake.assertDone();
  });

  it('fails with InvalidResponse when the body is not a list', async () => {
    const { api, fake } = testApi([loginRequest(), groupsRequest({ status: 200, body: { data: [] } })]);
    const error = await toolErrorOf(listPermissionGroups(api));
    assert.deepEqual([error.code, error.message], [
      'InvalidResponse',
      'alfaview sent an unexpected response for /v2/permission-groups.',
    ]);
    fake.assertDone();
  });
});

describe('readGroupNames', () => {
  it('reads the names with one request', async () => {
    const { api, fake } = testApi([loginRequest(), groupsRequest({ status: 200, body: groups() })]);
    const names = await readGroupNames(api);
    assert.equal(names.get(GUEST_ID), 'Guest');
    assert.equal(names.size, 5);
    fake.assertDone();
  });

  it('gives no names when the read fails', async () => {
    const { api, fake } = testApi([loginRequest(), groupsRequest({ status: 503 })]);
    assert.deepEqual([...(await readGroupNames(api))], []);
    fake.assertDone();
  });

  it('still ends the call on a cancel', async () => {
    const canceling = new AbortController();
    const { api, fake } = testApi([loginRequest(), groupsRequest({ hang: true })], {
      signal: canceling.signal,
    });
    const read = readGroupNames(api);
    await untilRequests(fake, 2);
    canceling.abort();
    assert.equal((await toolErrorOf(read)).code, 'Canceled');
    fake.assertDone();
  });

  it('rethrows an error that is not a ToolError', async () => {
    const { api } = testApi([]);
    const site = testFileLine();
    const failing: CallApi = {
      ...api,
      request: (request) => {
        keepApiRequestProblems(request, site);
        return Promise.reject(new TypeError('bug'));
      },
    };
    await assert.rejects(readGroupNames(failing), TypeError);
  });
});

describe('resolvePermissionGroup', () => {
  it('uses the group named Guest without a value', () => {
    assert.equal(DEFAULT_GUEST_GROUP_NAME, 'Guest');
    for (const value of [undefined, '', '   ']) {
      assert.equal(resolvePermissionGroup(value, groups()).id, GUEST_ID);
    }
  });

  it('finds the Guest group in any case and with surrounding spaces', () => {
    const renamed = [{ id: 'g1', name: 'Admin' }, { id: 'g2', name: '  gUeSt ' }];
    assert.equal(resolvePermissionGroup(undefined, renamed).id, 'g2');
  });

  it('takes the first of two groups named Guest', () => {
    const doubled = [{ id: 'g1', name: 'Guest' }, { id: 'g2', name: 'guest' }];
    assert.equal(resolvePermissionGroup(undefined, doubled).id, 'g1');
  });

  it('matches a group ID in any case', () => {
    assert.equal(resolvePermissionGroup(SPECTATOR_ID.toUpperCase(), groups()).id, SPECTATOR_ID);
  });

  it('matches a group name in any case, trimmed', () => {
    assert.equal(resolvePermissionGroup(' spectator ', groups()).id, SPECTATOR_ID);
  });

  it('prefers an ID over a group whose name is that ID', () => {
    const tricky = [{ id: 'g1', name: 'g2' }, { id: 'g2', name: 'Other' }];
    assert.equal(resolvePermissionGroup('g2', tricky).id, 'g2');
  });

  it('lists the group names for an unknown value', () => {
    const error = errorOf(() => resolvePermissionGroup('Speaker', groups()));
    assert.deepEqual([error.code, error.message], [
      'UnknownPermissionGroup',
      `This company has no permission group Speaker. Its groups: ${GROUP_NAMES}.`,
    ]);
  });

  it('lists the IDs when several groups have the name', () => {
    const doubled = [{ id: 'g1', name: 'Speaker' }, { id: 'g2', name: 'speaker ' }];
    const error = errorOf(() => resolvePermissionGroup('SPEAKER', doubled));
    assert.deepEqual([error.code, error.message], [
      'UnknownPermissionGroup',
      'More than one permission group is named SPEAKER. Give the ID of one: g1, g2.',
    ]);
  });

  it('asks for a group when the company has no group named Guest', () => {
    const error = errorOf(() => resolvePermissionGroup(undefined, groups().slice(0, 2)));
    assert.deepEqual([error.code, error.message], [
      'UnknownPermissionGroup',
      'Give permissionGroup. This company has no permission group named Guest. Its groups: Admin, Moderator.',
    ]);
    assert.equal(
      errorOf(() => resolvePermissionGroup('Guest', [])).message,
      'This company has no permission group Guest. Its groups: none.',
    );
  });
});

// Whoever joins with a link of a group with admin can change and delete the room.
describe('refuseAdminGroup', () => {
  it('refuses a group whose permissions have admin, with the given message', () => {
    const admin = groups().find((group) => group.name === 'Admin')!;
    const error = errorOf(() => refuseAdminGroup(admin, 'No admin here.'));
    assert.deepEqual([error.code, error.message, error.status], ['AdminGroupRefused', 'No admin here.', undefined]);
  });

  it('takes a group without admin, and a group whose permissions alfaview left out', () => {
    for (const group of [
      ...groups().filter((group) => group.name !== 'Admin'),
      { id: 'g1', name: 'Speaker' },
      { id: 'g2', name: 'Host', permissions: { join: true } },
    ]) {
      assert.equal(refuseAdminGroup(group, 'No admin here.'), undefined, group.name);
    }
  });
});

// A change that gives no other group keeps the stored group of the link, and so its admin rights.
describe('refuseStoredAdminGroup', () => {
  const ADMIN_ID = 'a0b1c2d3-e4f5-5061-8728-394a5b6c7d8e';

  it('refuses the ID of a group with admin, in any case', () => {
    for (const id of [ADMIN_ID, ADMIN_ID.toUpperCase()]) {
      const error = errorOf(() => refuseStoredAdminGroup(id, groups(), 'Not this link.'));
      assert.deepEqual([error.code, error.message], ['AdminGroupRefused', 'Not this link.'], id);
    }
  });

  it('takes a group without admin, an ID that the list does not hold and a missing ID', () => {
    for (const id of [SPECTATOR_ID, '00000000-0000-5000-8000-000000000999', undefined, null, 7]) {
      assert.equal(refuseStoredAdminGroup(id, groups(), 'Not this link.'), undefined, String(id));
    }
  });
});
