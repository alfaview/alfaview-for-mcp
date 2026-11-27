// The error texts of create_guest_links and update_guest_link with Include and Leave out, and the
// key `index` of create_guest_links. A 422 of these tools can repeat an email address of the
// input, so Leave out hides the texts of alfaview in a 422. The texts of a 400, and of a 422 of
// create_meeting, stay the same in both modes.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EXISTING_LINK_MESSAGE,
  NOT_ATTEMPTED_MESSAGE,
  OTHER_RIGHTS_MESSAGE,
  UNCERTAIN_CREATE_MESSAGE,
} from '../../src/domain/guestLinks.ts';
import { TOOLS } from '../../src/server.ts';
import type { PersonalDataMode } from '../../src/shared/personalData.ts';
import { loginRequest, type ExpectedRequest, type FakeAnswer } from '../helpers/fakeFetch.ts';
import { fixture } from '../helpers/fixtures.ts';
import { toolHarness, type ToolCallResult } from '../helpers/mcpClient.ts';
import { holds } from './markerChecks.ts';
import { markedEmail, markedName, PERSONAL_MARKER } from './markerState.ts';

const ROOM_ID = '0b7c5d2e-91a4-5f3b-8e27-0f4a6c9d1e22';
const LINK_ID = '3f2a9c1e-7b4d-5e21-a3c4-14b7e9d0f6a2';
const GUEST_GROUP_ID = 'd2b3c4d5-e6f7-5081-9a2b-c3d4e5f6a7b8';
const SPECTATOR_GROUP_ID = 'f4a5b6c7-d8e9-5f0a-9b1c-2d3e4f5a6b7c';
const NEW_ID = 'aa000000-0000-5000-8000-000000000001';
/** The userId of the guest of NEW_ID: the ID with 18 in byte 10, as for a guest. */
const NEW_USER_ID = 'aa000000-0000-5000-8000-180000000001';
const OTHER_RIGHTS_LINK_ID = 'aa000000-0000-5000-8000-000000000009';

/** 2026-10-07T18:00 and 20:00 in Berlin. */
const EVENT_FROM = '2026-10-07T16:00:00.000Z';
const EVENT_UNTIL = '2026-10-07T18:00:00.000Z';
const EVENT = {
  roomId: ROOM_ID,
  locale: 'de-DE',
  validFrom: '2026-10-07T18:00',
  validUntil: '2026-10-07T20:00',
};

type Guest = { emailAddress: string; displayName: string };

const guest = (name: string): Guest => ({
  emailAddress: markedEmail(name.toLowerCase()),
  displayName: markedName(name),
});

const MODES: readonly PersonalDataMode[] = ['include', 'omit'];

function apiLink(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...fixture<Record<string, unknown>>('guestLinks/guest-link.json'), ...overrides };
}

/**
 * Returns the 201 answer to the request that creates `entry`, with the ID NEW_ID. alfaview answers
 * with the created guest links, with the join URL, the address and the name of the guest, so the
 * tool reads nothing back.
 */
function created(entry: Guest): FakeAnswer {
  return { status: 201, body: [apiLink({ id: NEW_ID, userId: NEW_USER_ID, ...entry })] };
}

const groupsRequest: ExpectedRequest = {
  method: 'GET',
  path: '/v2/permission-groups',
  respond: { status: 200, body: fixture('rooms/permission-groups.json') },
};

function linksPage(links: unknown[]): ExpectedRequest {
  return {
    method: 'GET',
    path: `/v2/rooms/${ROOM_ID}/guest-links`,
    query: { limit: '500' },
    respond: { status: 200, body: { data: links } },
  };
}

function createRequest(entry: Guest, respond: FakeAnswer): ExpectedRequest {
  return {
    method: 'POST',
    path: `/v2/rooms/${ROOM_ID}/guest-links`,
    body: {
      create: [
        {
          ...entry,
          locale: 'de-DE',
          permissionGroupId: GUEST_GROUP_ID,
          dialInAllowed: false,
          sendEmail: false,
          validFrom: EVENT_FROM,
          validUntil: EVENT_UNTIL,
        },
      ],
      origin: 'MCP',
      timezone: 'Europe/Berlin',
    },
    respond,
  };
}

/** Returns a 422 whose texts repeat `email`, as the email address check of alfaview does. */
function echoingProblem(email: string, location?: string): FakeAnswer {
  const message = `expected string to be RFC 5322 email: mail: expected single address, got ", ${email}"`;
  return {
    status: 422,
    body: {
      title: 'Unprocessable Entity',
      status: 422,
      detail: `ACTION_INVALID: invalid email address: '${email}'`,
      errors: [location === undefined ? { message } : { message, location }],
    },
  };
}

/** Calls the tool in each mode against the same expected requests. */
async function inEachMode(
  name: string,
  args: Record<string, unknown>,
  expected: () => readonly ExpectedRequest[],
  options: { timeoutMs?: number } = {},
): Promise<Record<PersonalDataMode, ToolCallResult & { logLines: string[] }>> {
  const results = {} as Record<PersonalDataMode, ToolCallResult & { logLines: string[] }>;
  for (const mode of MODES) {
    const harness = await toolHarness(TOOLS, expected(), { ...options, personalData: mode });
    const result = await harness.call(name, args);
    await harness.done();
    results[mode] = { ...result, logLines: harness.logLines };
  }
  return results;
}

describe('the texts of create_guest_links and update_guest_link with Personal data', () => {
  it('leaves the address out of the error of a guest list with an address twice', async () => {
    const jane = guest('Jane');
    const twice = { ...jane, emailAddress: ` ${jane.emailAddress.toUpperCase()} ` };
    const results = await inEachMode('create_guest_links', { ...EVENT, guests: [jane, twice] }, () => []);

    assert.equal(results.include.isError, true);
    assert.equal(
      results.include.summary,
      `The guest list has ${twice.emailAddress.trim()} more than once. Give each email address once per call.`,
    );
    assert.equal(results.omit.isError, true);
    assert.equal(
      results.omit.summary,
      'The guest list has an email address more than once. Give each email address once per call.',
    );
  });

  it('names the field of a 422 of one guest instead of alfaview texts, which repeat the address', async () => {
    const jane = guest('Jane');
    const max = guest('Max');
    const results = await inEachMode('create_guest_links', { ...EVENT, guests: [jane, max] }, () => [
      loginRequest(),
      groupsRequest,
      linksPage([]),
      createRequest(jane, echoingProblem(jane.emailAddress, 'body.create[0].emailAddress')),
      createRequest(max, created(max)),
    ]);

    assert.equal(
      results.include.data.results[0].message,
      `alfaview could not process the input: ACTION_INVALID: invalid email address: '${jane.emailAddress}'. create[0].emailAddress: expected string to be RFC 5322 email: mail: expected single address, got ", ${jane.emailAddress}".`,
    );
    assert.equal(
      results.omit.data.results[0].message,
      'alfaview could not process the input. Check create[0].emailAddress. The reason from alfaview is hidden because Personal data is set to Leave out.',
    );
    for (const mode of MODES) {
      assert.deepEqual(
        results[mode].data.results.map((result: { status: string }) => result.status),
        ['failed', 'created'],
      );
    }
    assert.ok(!holds([results.omit.summary, results.omit.text], PERSONAL_MARKER));
    assert.deepEqual(results.omit.logLines, results.include.logLines);
  });

  it('gives the text without a location when the first create fails for the whole request', async () => {
    const jane = guest('Jane');
    const results = await inEachMode('create_guest_links', { ...EVENT, guests: [jane] }, () => [
      loginRequest(),
      groupsRequest,
      linksPage([]),
      createRequest(jane, echoingProblem(jane.emailAddress)),
    ]);

    assert.equal(results.include.isError, true);
    assert.ok(holds(results.include.summary, PERSONAL_MARKER));
    assert.equal(results.omit.isError, true);
    assert.equal(
      results.omit.summary,
      'alfaview could not process the input. The reason from alfaview is hidden because Personal data is set to Leave out.',
    );
    assert.deepEqual(results.omit.logLines, results.include.logLines);
  });

  it('names the field of a 422 of update_guest_link instead of alfaview texts', async () => {
    const email = markedEmail('jane.new');
    const results = await inEachMode('update_guest_link', { guestLinkId: LINK_ID, emailAddress: email }, () => [
      loginRequest(),
      { method: 'GET', path: `/v2/guest-links/${LINK_ID}`, respond: { status: 200, body: apiLink() } },
      groupsRequest,
      {
        method: 'PATCH',
        path: `/v2/guest-links/${LINK_ID}`,
        body: { emailAddress: email, displayName: 'Jane Doe', sendEmail: false, timezone: 'Europe/Berlin' },
        respond: echoingProblem(email, 'body.emailAddress'),
      },
    ]);

    assert.equal(results.include.isError, true);
    assert.ok(holds(results.include.summary, PERSONAL_MARKER));
    assert.equal(
      results.omit.summary,
      'alfaview could not process the input. Check emailAddress. The reason from alfaview is hidden because Personal data is set to Leave out.',
    );
  });

  it('gives the texts of a request without an answer, which name no value of the input, in both modes', async () => {
    const jane = guest('Jane');
    const network = await inEachMode('update_guest_link', { guestLinkId: LINK_ID, displayName: jane.displayName }, () => [
      loginRequest(),
      { method: 'GET', path: `/v2/guest-links/${LINK_ID}`, respond: { status: 200, body: apiLink() } },
      groupsRequest,
      {
        method: 'PATCH',
        path: `/v2/guest-links/${LINK_ID}`,
        body: { displayName: jane.displayName, sendEmail: false, timezone: 'Europe/Berlin' },
        respond: { networkError: 'ECONNRESET' },
      },
    ]);
    const timeout = await inEachMode(
      'create_guest_links',
      { ...EVENT, guests: [jane] },
      () => [loginRequest(), groupsRequest, linksPage([]), createRequest(jane, { hang: true })],
      { timeoutMs: 20 },
    );

    for (const mode of MODES) {
      assert.equal(
        network[mode].summary,
        `alfaview could not be reached (PATCH /v2/guest-links/${LINK_ID}, ECONNRESET). Check the network connection, then try again.`,
      );
      assert.equal(timeout[mode].summary, UNCERTAIN_CREATE_MESSAGE);
      for (const result of [network[mode], timeout[mode]]) {
        assert.ok(!holds([result.summary, result.logLines], PERSONAL_MARKER), mode);
      }
    }
  });

  it('passes the texts of alfaview for another status and for another operation', async () => {
    const jane = guest('Jane');
    const badRequest = await inEachMode('create_guest_links', { ...EVENT, guests: [jane] }, () => [
      loginRequest(),
      groupsRequest,
      linksPage([]),
      createRequest(jane, {
        status: 400,
        body: { title: 'Bad Request', status: 400, detail: 'unexpected end of JSON input' },
      }),
    ]);
    const meeting = await inEachMode(
      'create_meeting',
      { title: `Review ${PERSONAL_MARKER}`, start: '2026-10-08T10:00', end: '2026-10-08T11:00' },
      () => [
        loginRequest(),
        {
          method: 'POST',
          path: '/v2/meetings',
          body: {
            title: `Review ${PERSONAL_MARKER}`,
            start: '2026-10-08T08:00:00.000Z',
            end: '2026-10-08T09:00:00.000Z',
            timezone: 'Europe/Berlin',
            roomFeatures: {},
            waitingRoomEnabled: false,
          },
          respond: {
            status: 422,
            body: {
              title: 'Unprocessable Entity',
              status: 422,
              detail: 'meeting start time (2026-10-08T08:00:00Z) must be before end time (2026-10-08T09:00:00Z)',
            },
          },
        },
      ],
    );

    assert.equal(badRequest.omit.summary, 'alfaview rejected the request: unexpected end of JSON input.');
    assert.equal(badRequest.omit.summary, badRequest.include.summary);
    assert.equal(
      meeting.omit.summary,
      'alfaview could not process the input: meeting start time (2026-10-08T08:00:00Z) must be before end time (2026-10-08T09:00:00Z).',
    );
    assert.equal(meeting.omit.summary, meeting.include.summary);
  });
});

describe('the key index of create_guest_links', () => {
  // `index` is the position of the guest in `guests`, counted from 0.
  it('gives each result the position of its guest, for every status and in both modes', async () => {
    const [anna, bob, carla, dora, erik, fiona] = ['Anna', 'Bob', 'Carla', 'Dora', 'Erik', 'Fiona'].map(guest) as [
      Guest,
      Guest,
      Guest,
      Guest,
      Guest,
      Guest,
    ];
    const matching = { origin: 'MCP', validFrom: '2026-10-07T16:00:00Z', validUntil: '2026-10-07T18:00:00Z' };
    const results = await inEachMode(
      'create_guest_links',
      { ...EVENT, guests: [anna, bob, carla, dora, erik, fiona] },
      () => [
        loginRequest(),
        groupsRequest,
        linksPage([
          apiLink({ ...matching, id: LINK_ID, ...anna }),
          apiLink({ ...matching, id: OTHER_RIGHTS_LINK_ID, ...bob, permissionGroupId: SPECTATOR_GROUP_ID }),
        ]),
        createRequest(carla, created(carla)),
        createRequest(dora, echoingProblem(dora.emailAddress, 'body.create[0].emailAddress')),
        createRequest(erik, { status: 500, body: fixture('core/problem-500.json') }),
      ],
    );

    // The 422 of Dora has the message of each mode, which the test above checks.
    const expected = [
      [0, 'existing', EXISTING_LINK_MESSAGE],
      [1, 'failed', OTHER_RIGHTS_MESSAGE],
      [2, 'created', null],
      [3, 'failed', 'the message of the 422'],
      [4, 'uncertain', UNCERTAIN_CREATE_MESSAGE],
      [5, 'not_attempted', NOT_ATTEMPTED_MESSAGE],
    ];
    for (const mode of MODES) {
      type Result = { index: number; status: string; message: string | null };
      const listed = results[mode].data.results.map((result: Result) => {
        assert.equal(Object.keys(result)[0], 'index', mode);
        const message = result.index === 3 ? 'the message of the 422' : result.message;
        return [result.index, result.status, message];
      });
      assert.deepEqual(listed, expected, mode);
    }
    assert.deepEqual(
      results.omit.data.results.map((result: Guest) => [result.emailAddress, result.displayName]),
      Array.from({ length: 6 }, () => [null, null]),
    );
    assert.ok(!holds(results.omit.text, PERSONAL_MARKER));
  });
});
