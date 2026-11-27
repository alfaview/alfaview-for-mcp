import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  mapPasscode,
  passcodeNotReturnedMessage,
  readPasscode,
  regeneratePasscode,
} from '../../src/domain/passcode.ts';
import { loginRequest, testApi, toolErrorOf } from '../helpers/fakeFetch.ts';
import { fixture } from '../helpers/fixtures.ts';

const ROOM_ID = '0b7c5d2e-91a4-5f3b-8e27-0f4a6c9d1e22';
const PATH = `/v2/rooms/${ROOM_ID}/passcode`;

describe('mapPasscode', () => {
  it('maps the spec Passcode to the Passcode output without a room name', () => {
    assert.deepEqual(mapPasscode(ROOM_ID, fixture('rooms/passcode.json')), {
      roomId: ROOM_ID,
      passcode: 'Kx7#mQ2p',
      passcodeRequired: true,
    });
  });

  it('gives null for a missing, empty or mistyped value', () => {
    assert.deepEqual(mapPasscode(ROOM_ID, undefined), {
      roomId: ROOM_ID,
      passcode: null,
      passcodeRequired: null,
    });
    assert.deepEqual(
      mapPasscode(ROOM_ID, { passcode: '', required: 'yes' } as unknown as { passcode: string }),
      { roomId: ROOM_ID, passcode: null, passcodeRequired: null },
    );
  });
});

describe('readPasscode', () => {
  it('reads the current passcode', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'GET', path: PATH, respond: { status: 200, body: fixture('rooms/passcode.json') } },
    ]);
    assert.equal(await readPasscode(api, ROOM_ID), 'Kx7#mQ2p');
    fake.assertDone();
  });

  // alfaview answers 200 with an empty passcode for a room that has no passcode and does not
  // require one.
  it('gives null for the empty passcode of a room without one, and for an answer without a passcode', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'GET', path: PATH, respond: { status: 200, body: { passcode: '', required: false } } },
      { method: 'GET', path: PATH, respond: { status: 200, body: { required: false } } },
    ]);
    assert.equal(await readPasscode(api, ROOM_ID), null);
    assert.equal(await readPasscode(api, ROOM_ID), null);
    fake.assertDone();
  });

  // alfaview answers 404 only for a room that it does not find or that the API key's user cannot
  // see.
  it('fails with the not-found error for a 404', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'GET', path: PATH, respond: { status: 404, body: fixture('core/problem-404.json') } },
    ]);
    const error = await toolErrorOf(readPasscode(api, ROOM_ID));
    assert.deepEqual(
      [error.code, error.status, error.message],
      [
        'NotFound',
        404,
        "alfaview could not find the room. It was deleted, or the API key's user cannot see it.",
      ],
    );
    fake.assertDone();
  });
});

describe('regeneratePasscode', () => {
  it('makes a new passcode with a POST without a body', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'POST', path: PATH, respond: { status: 200, body: fixture('rooms/passcode.json') } },
    ]);
    assert.deepEqual(await regeneratePasscode(api, ROOM_ID), {
      roomId: ROOM_ID,
      passcode: 'Kx7#mQ2p',
      passcodeRequired: true,
    });
    fake.assertDone();
  });

  it('fails when alfaview does not return the new passcode', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'POST', path: PATH, respond: { status: 200, body: {} } },
    ]);
    const error = await toolErrorOf(regeneratePasscode(api, ROOM_ID));
    assert.deepEqual([error.code, error.message], [
      'InvalidResponse',
      passcodeNotReturnedMessage(ROOM_ID),
    ]);
    assert.equal(
      error.message,
      `alfaview made a new passcode for the room ${ROOM_ID}, but did not return it. Use get_room with includePasscode true to read it.`,
    );
    fake.assertDone();
  });
});
