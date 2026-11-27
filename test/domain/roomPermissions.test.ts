import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addRoomPermission,
  grantedPermissions,
  listRoomPermissions,
  permissionExistsMessage,
  permissionNotFoundMessage,
  PERMISSIONS_UNEXPECTED_MESSAGE,
  permissionText,
  readRoomPermissions,
  removeRoomPermission,
  updateRoomPermission,
  userPermissionPath,
  userPermissionsOf,
} from '../../src/domain/roomPermissions.ts';
import { loginRequest, testApi, toolErrorOf, type FakeAnswer } from '../helpers/fakeFetch.ts';
import { fixture } from '../helpers/fixtures.ts';

const ROOM_ID = '0b7c5d2e-91a4-5f3b-8e27-0f4a6c9d1e22';
const USER_ID = 'c0ffee00-0000-5000-8000-120000000002';
const PERMISSIONS_PATH = `/v2/rooms/${ROOM_ID}/permissions`;
const ALL_TRUE = {
  admin: true,
  voice: true,
  video: true,
  promote: true,
  join: true,
  screen: true,
  vip: true,
  chat: true,
  upload: true,
};

describe('readRoomPermissions', () => {
  it('gives the entries of users and the counts of the guest link and group link entries', () => {
    const list = readRoomPermissions(fixture('rooms/permissions.json'));

    assert.deepEqual(
      list?.userPermissions.map((entry) => entry.participantId),
      ['9a8b7c6d-5e4f-5a3b-9c2d-1e0f9a8b7c6d', '6c1d9e4f-2a7b-5c3d-9e8f-0a1b2c3d4e5f'],
    );
    assert.equal(list?.guestLinkPermissionCount, 1);
    assert.equal(list?.groupLinkPermissionCount, 0);
  });

  it('reads a missing or null list as an empty one, and leaves out entries without a text participantId', () => {
    const list = readRoomPermissions({
      userPermissions: [{ participantId: USER_ID, permissions: {} }, { permissions: {} }, null, 'x'],
      groupLinkPermissions: [{ participantId: 7 }, { participantId: 'g1' }],
    });

    assert.deepEqual(list, {
      userPermissions: [{ participantId: USER_ID, permissions: {} }],
      guestLinkPermissionCount: 0,
      groupLinkPermissionCount: 1,
    });
    assert.deepEqual(readRoomPermissions({}), {
      userPermissions: [],
      guestLinkPermissionCount: 0,
      groupLinkPermissionCount: 0,
    });
  });

  it('gives undefined for an answer that is no object or has a list that is no list', () => {
    for (const data of [
      undefined,
      null,
      [],
      'text',
      { userPermissions: {} },
      { guestLinkPermissions: 'x' },
      { groupLinkPermissions: 1 },
    ]) {
      assert.equal(readRoomPermissions(data), undefined, JSON.stringify(data));
    }
  });
});

describe('userPermissionsOf', () => {
  const answer = fixture('rooms/permissions.json');

  it('gives the permissions of the entry of the user in any case', () => {
    assert.deepEqual(userPermissionsOf(answer, '9A8B7C6D-5E4F-5A3B-9C2D-1E0F9A8B7C6D'), ALL_TRUE);
  });

  it('gives undefined without an entry, also for the ID of a guest link entry', () => {
    assert.equal(userPermissionsOf(answer, USER_ID), undefined);
    assert.equal(userPermissionsOf(answer, '3f2a9c1e-7b4d-5e21-a3c4-14b7e9d0f6a2'), undefined);
    assert.equal(userPermissionsOf({ userPermissions: null }, USER_ID), undefined);
    assert.equal(userPermissionsOf({}, USER_ID), undefined);
  });

  it('gives an empty object for an entry without permissions', () => {
    assert.deepEqual(userPermissionsOf({ userPermissions: [{ participantId: USER_ID }] }, USER_ID), {});
  });
});

describe('grantedPermissions and permissionText', () => {
  it('name the true permissions in the order of PERMISSION_INPUT_ORDER', () => {
    assert.deepEqual(grantedPermissions(ALL_TRUE), [
      'admin',
      'join',
      'voice',
      'video',
      'screen',
      'chat',
      'upload',
      'promote',
      'vip',
    ]);
    assert.deepEqual(grantedPermissions({ chat: true, join: true, voice: false, admin: null }), ['join', 'chat']);
  });

  it('join the names, or say that there is no permission', () => {
    assert.equal(permissionText([]), 'no permission');
    assert.equal(permissionText(['join']), 'join');
    assert.equal(permissionText(['join', 'chat']), 'join and chat');
    assert.equal(permissionText(['join', 'voice', 'chat']), 'join, voice and chat');
  });
});

describe('userPermissionPath', () => {
  it('gives the path of the entry with both IDs in lowercase', () => {
    assert.equal(
      userPermissionPath(ROOM_ID.toUpperCase(), USER_ID.toUpperCase()),
      `/v2/rooms/${ROOM_ID}/permissions/${USER_ID}`,
    );
  });
});

describe('room permission requests', () => {
  const list = (respond: FakeAnswer) => ({ method: 'GET', path: PERMISSIONS_PATH, respond });

  it('listRoomPermissions reads GET /v2/rooms/{id}/permissions with the room ID in lowercase', async () => {
    const { api, fake } = testApi([loginRequest(), list({ status: 200, body: fixture('rooms/permissions.json') })]);
    const permissions = await listRoomPermissions(api, ROOM_ID.toUpperCase());
    fake.assertDone();

    assert.equal(permissions.userPermissions.length, 2);
  });

  it('listRoomPermissions fails with InvalidResponse for an answer that is no object', async () => {
    const { api, fake } = testApi([loginRequest(), list({ status: 200, body: [] })]);
    const error = await toolErrorOf(listRoomPermissions(api, ROOM_ID));
    fake.assertDone();

    assert.deepEqual([error.code, error.message], ['InvalidResponse', PERMISSIONS_UNEXPECTED_MESSAGE]);
    assert.equal(PERMISSIONS_UNEXPECTED_MESSAGE, 'alfaview sent an unexpected response for the room permissions.');
  });

  it('addRoomPermission sends the nine permissions with the user ID in lowercase, and 409 gives Conflict', async () => {
    const add = (respond: FakeAnswer) => ({
      method: 'POST',
      path: PERMISSIONS_PATH,
      body: { participantId: USER_ID, permissions: ALL_TRUE },
      respond,
    });
    const { api, fake } = testApi([
      loginRequest(),
      add({ status: 204 }),
      add({ status: 409, body: fixture('core/problem-409.json') }),
    ]);
    await addRoomPermission(api, ROOM_ID, USER_ID.toUpperCase(), ALL_TRUE);
    const error = await toolErrorOf(addRoomPermission(api, ROOM_ID, USER_ID, ALL_TRUE));
    fake.assertDone();

    assert.deepEqual([error.code, error.message, error.status], ['Conflict', permissionExistsMessage(USER_ID), 409]);
  });

  it('updateRoomPermission sends the given permissions to the entry, and 404 says that nothing changed', async () => {
    const update = (respond: FakeAnswer) => ({
      method: 'PATCH',
      path: `${PERMISSIONS_PATH}/${USER_ID}`,
      body: { join: false },
      respond,
    });
    const { api, fake } = testApi([
      loginRequest(),
      update({ status: 204 }),
      update({ status: 404, body: fixture('core/problem-404.json') }),
    ]);
    await updateRoomPermission(api, ROOM_ID, USER_ID.toUpperCase(), { join: false });
    const error = await toolErrorOf(updateRoomPermission(api, ROOM_ID, USER_ID, { join: false }));
    fake.assertDone();

    assert.deepEqual([error.code, error.message, error.status], ['NotFound', permissionNotFoundMessage(USER_ID), 404]);
  });

  it('removeRoomPermission sends DELETE to the entry with the user ID in lowercase', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'DELETE', path: `${PERMISSIONS_PATH}/${USER_ID}`, respond: { status: 204 } },
    ]);
    await removeRoomPermission(api, ROOM_ID, USER_ID.toUpperCase());
    fake.assertDone();
  });
});
