// The question to the person before delete_room and delete_user. The tests run on the 2025 era,
// where the SDK's shim sends elicitation/create, and on revision 2026-07-28, where the client
// fulfills the input_required result and calls the tool again with the request state.
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import type { Client, ElicitResult } from '@modelcontextprotocol/client';
import type { McpServerFactory, ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { AlfaviewClient } from '../../src/alfaview/client.ts';
import {
  CONFIRM_ROOM_NAME_MISSING_MESSAGE,
  confirmRoomNameMessage,
  DEPARTMENT_DELETE_WARNING,
} from '../../src/domain/rooms.ts';
import {
  CONFIRM_EMAIL_MISSING_MESSAGE,
  confirmEmailMessage,
  userWithoutAddressMessage,
} from '../../src/domain/users.ts';
import { createLogger } from '../../src/log.ts';
import {
  INPUT_ROUND_TIMEOUT_MS,
  INPUT_ROUNDS,
  protocolOptions,
  stdioServerFactory,
  type ServerDeps,
} from '../../src/server.ts';
import {
  canAskInForm,
  CONFIRMATION_TTL_SECONDS,
  Confirmations,
  invalidConfirmationMessage,
  noAnswerMessage,
  PersonConfirmation,
  RENAME_NOTE_MS,
} from '../../src/tools/confirmation.ts';
import { toolOutput } from '../../src/tools/outputs.ts';
import { FULL_ROOM_TOOLS, ROOM_ADMIN_TOOLS } from '../../src/tools/rooms.ts';
import {
  defineTool,
  INTERNAL_ERROR_MESSAGE,
  READ_ANNOTATIONS,
  runTool,
} from '../../src/tools/tool.ts';
import { FULL_USER_TOOLS } from '../../src/tools/users.ts';
import { testClock, type TestClock } from '../helpers/clock.ts';
import {
  fakeFetch,
  loginRequest,
  TEST_CONFIG,
  untilRequests,
  type ExpectedRequest,
  type FakeAnswer,
  type FakeFetch,
} from '../helpers/fakeFetch.ts';
import { fixture } from '../helpers/fixtures.ts';
import {
  callTool,
  connectModern,
  toolHarness,
  type Asking,
  type HarnessOptions,
  type ModernConnection,
  type Question,
} from '../helpers/mcpClient.ts';

type Json = Record<string, unknown>;

/** The room of rooms/room.json, and its name. */
const ROOM_ID = '0b7c5d2e-91a4-5f3b-8e27-0f4a6c9d1e22';
const NAME = 'Advisory Room Anna Example';
const DEPARTMENT_ID = '9c8b7a6d-5e4f-5a3b-8c2d-201f0e9d8c7b';

/** IDs of users in the form of alfaview: version 5 with the kind 18 (hex 12) in byte 10. */
const OWN_USER_ID = 'c0ffee00-0000-5000-8000-120000000001';
const TARGET_USER_ID = 'c0ffee00-0000-5000-8000-120000000002';
const EMAIL = 'leaving.user@example.com';
const TARGET = { id: TARGET_USER_ID, emailAddress: EMAIL, firstName: 'Leaving', lastName: 'User', locale: 'de-DE' };

const ROOM_EFFECT =
  'alfaview disconnects everyone in it and deletes its breakout rooms, guest links, group links, files and polls. Its attendance can no longer be read. This cannot be undone.';
/** The createdAt of rooms/room.json in the zone of the server. */
const ROOM_CREATED = 'alfaview created this room at 2026-09-01 10:30 Europe/Berlin.';
/** The question of the room, with the notes of this server before its name, which comes last. */
const roomQuestion = (...notes: string[]): string =>
  [`Delete the room with the ID ${ROOM_ID} for good?`, ROOM_EFFECT, ROOM_CREATED, ...notes, `Its name: "${NAME}".`].join(' ');
const ROOM_QUESTION = roomQuestion();
const USER_EFFECT =
  'The user can no longer sign in, also not with an API key, and access can last up to one hour. Rooms and room permissions of the user stay. This cannot be undone.';
const USER_QUESTION = `Delete the user with the ID ${TARGET_USER_ID} for good? ${USER_EFFECT} Name: "Leaving User". Email address: "${EMAIL}".`;

const ROOM_SCHEMA = {
  type: 'object',
  properties: {
    roomName: { type: 'string', title: 'Room name', description: 'Type the name of the room to delete it.' },
  },
  required: ['roomName'],
};
const USER_SCHEMA = {
  type: 'object',
  properties: {
    emailAddress: {
      type: 'string',
      title: 'Email address',
      description: 'Type the email address of the user to delete the user.',
      format: 'email',
    },
  },
  required: ['emailAddress'],
};

const KEPT = 'Nothing was deleted. Do not call this tool again unless the person asks.';

/** The tools of these tests: the rename of update_room, and the two deletes. */
const TOOLS = [...ROOM_ADMIN_TOOLS, ...FULL_ROOM_TOOLS, ...FULL_USER_TOOLS];

const room = (overrides: Json = {}): Json => ({ ...fixture<Json>('rooms/room.json'), ...overrides });

function roomRead(body: Json = room(), id = ROOM_ID): ExpectedRequest {
  return { method: 'GET', path: `/v2/rooms/${id}`, respond: { status: 200, body } };
}

function roomDelete(id = ROOM_ID): ExpectedRequest {
  return { method: 'DELETE', path: `/v2/rooms/${id}`, respond: { status: 204 } };
}

/** The two reads of each round of delete_user: the API key's user, then the list. */
function userReads(list: Json[] = [...fixture<Json[]>('users/users.json'), TARGET]): ExpectedRequest[] {
  return [
    {
      method: 'GET',
      path: '/v2/users/me',
      respond: { status: 200, body: { ...fixture<Json>('core/user-profile.json'), id: OWN_USER_ID } },
    },
    { method: 'GET', path: '/v2/users', respond: { status: 200, body: list } },
  ];
}

function userDelete(): ExpectedRequest {
  return { method: 'DELETE', path: `/v2/users/${TARGET_USER_ID}`, respond: { status: 204 } };
}

/**
 * A person who answers each question with `answer` and keeps each question in `questions`. The
 * client declares form mode, or `capability`.
 */
function person(answer: (question: Question) => ElicitResult, capability?: Asking['capability']) {
  const questions: Question[] = [];
  const asking: Asking = {
    ...(capability === undefined ? {} : { capability }),
    answer(question) {
      questions.push(question);
      return answer(question);
    },
  };
  return { asking, questions };
}

const types = (field: string, value: string) => () =>
  ({ action: 'accept', content: { [field]: value } }) as ElicitResult;
const declines = () => ({ action: 'decline' }) as ElicitResult;
const cancels = () => ({ action: 'cancel' }) as ElicitResult;

/** The 2025 era: a client over the in-memory transport, with the protocol options of the server. */
async function legacy(expected: readonly ExpectedRequest[], options: HarnessOptions = {}) {
  return toolHarness(TOOLS, expected, { level: 'full', ...options });
}

type Modern = {
  modern: ModernConnection;
  fake: FakeFetch;
  logLines: string[];
  clock: TestClock;
  /** The factory of the connection, which serves each client of the process. */
  factory: McpServerFactory;
  call(name: string, args: Json): ReturnType<typeof callTool>;
  /** Closes the connection, then checks that every expected request arrived and no other. */
  done(): Promise<void>;
};

/**
 * Revision 2026-07-28: a client pinned to it, connected through serveStdio to the factory of the
 * command at the level full, as Claude Code connects. With `asking`, the client fulfills each
 * question. With `autoFulfill` false, it declares the capability and fulfills none.
 */
async function modern(
  expected: readonly ExpectedRequest[],
  options: { asking?: Asking; autoFulfill?: boolean; personalData?: 'include' | 'omit' } = {},
): Promise<Modern> {
  const fake = fakeFetch(expected);
  const logLines: string[] = [];
  const log = createLogger((text) => logLines.push(text));
  const clock = testClock();
  const deps: ServerDeps = {
    client: new AlfaviewClient({ config: TEST_CONFIG, fetch: fake.fetch, log, now: clock.now }),
    log,
    level: 'full',
    timeZone: 'Europe/Berlin',
    now: clock.now,
    ...(options.personalData === undefined ? {} : { personalData: options.personalData }),
  };
  const factory = stdioServerFactory(deps);
  const connection = await connectModern(factory, options);
  return {
    modern: connection,
    fake,
    logLines,
    clock,
    factory,
    call: (name, args) => callTool(connection.client, name, args),
    async done() {
      await connection.close();
      fake.assertDone();
    },
  };
}

type InputRequired = {
  resultType: 'input_required';
  inputRequests: Record<string, { method: string; params: { message: string; requestedSchema: unknown } }>;
  requestState: string;
};

/**
 * One round of a tool call on 2026-07-28 by hand, as a client that does not fulfill it: the
 * answer as sent, an input_required result or a complete one.
 */
async function round(
  client: Client,
  name: string,
  args: Json,
  retry: { inputResponses?: Json; requestState?: string } = {},
): Promise<Json> {
  return (await client.request(
    { method: 'tools/call', params: { name, arguments: args, ...retry } } as never,
    { allowInputRequired: true },
  )) as Json;
}

/** The payload of a request state, which the client can read in clear. */
function payloadOf(state: string): { p: Json; exp: number } {
  return JSON.parse(Buffer.from(state.slice(3, state.lastIndexOf('.')), 'base64url').toString('utf8'));
}

const ERAS = ['2025', '2026-07-28'] as const;

describe('the question before delete_room', () => {
  for (const era of ERAS) {
    describe(`on the era ${era}`, () => {
      /**
       * A server at full on `era` with a person who answers with `asking`, or with a client that
       * cannot ask when `asking` is left out.
       */
      async function connect(expected: readonly ExpectedRequest[], asking?: Asking) {
        const options = asking === undefined ? {} : { asking };
        if (era === '2025') {
          const harness = await legacy(expected, options);
          return { call: harness.call, logLines: harness.logLines, done: harness.done };
        }
        return modern(expected, options);
      }

      it('deletes when the person types the name, in any case, and logs who confirmed', async () => {
        const { asking, questions } = person(types('roomName', ' advisory ROOM anna example '));
        const tools = await connect([loginRequest(), roomRead(), roomRead(), roomDelete()], asking);
        const result = await tools.call('delete_room', { roomId: ROOM_ID.toUpperCase() });
        await tools.done();

        assert.equal(result.isError, false, result.summary);
        assert.equal(result.summary, `Deleted room ${ROOM_ID} for good.`);
        assert.deepEqual(result.data, {
          roomId: ROOM_ID,
          type: 'room',
          deleted: true,
          confirmation: 'person',
          warnings: [],
        });
        assert.equal(questions.length, 1);
        assert.equal(questions[0]!.message, ROOM_QUESTION);
        assert.deepEqual((questions[0] as { requestedSchema: unknown }).requestedSchema, ROOM_SCHEMA);
        const calls = tools.logLines.filter((line) => line.includes('tool delete_room'));
        assert.match(calls[0]!, /: asks the person \(round 1\), 2 requests, /);
        assert.match(calls[1]!, /: ok, confirmed by the person, 2 requests, /);
        assert.equal(calls.length, 2);
      });

      it('ignores confirmRoomName and asks the person, whose answer decides', async () => {
        const { asking, questions } = person(declines);
        const tools = await connect([loginRequest(), roomRead(), roomRead()], asking);
        const result = await tools.call('delete_room', { roomId: ROOM_ID, confirmRoomName: NAME });
        await tools.done();

        assert.equal(questions.length, 1);
        assert.equal(result.data.deleted, false);
        assert.equal(result.data.confirmation, 'declined');
      });

      for (const [action, answer, confirmation, reason] of [
        ['declines', declines, 'declined', 'The person declined.'],
        ['cancels', cancels, 'canceled', 'The person canceled the question.'],
        [
          'types another name',
          types('roomName', 'Advisory Room'),
          'mismatch',
          'The person typed a name that is not the name of the room.',
        ],
        [
          'types a blank name',
          types('roomName', '   '),
          'mismatch',
          'The person typed a name that is not the name of the room.',
        ],
      ] as const) {
        it(`deletes nothing when the person ${action}, without an error`, async () => {
          const { asking } = person(answer);
          const tools = await connect([loginRequest(), roomRead(), roomRead()], asking);
          const result = await tools.call('delete_room', { roomId: ROOM_ID });
          await tools.done();

          assert.equal(result.isError, false, result.summary);
          assert.equal(result.summary, `Did not delete room ${ROOM_ID}. ${reason} ${KEPT}`);
          assert.deepEqual(result.data, {
            roomId: ROOM_ID,
            type: 'room',
            deleted: false,
            confirmation,
            warnings: [`${reason} ${KEPT}`],
          });
          assert.ok(!result.summary.includes(NAME), 'the warning never names the expected name');
          const verb = { declined: 'declined', canceled: 'canceled', mismatch: 'not confirmed' }[confirmation];
          assert.match(tools.logLines.at(-1)!, new RegExp(`: ok, ${verb} by the person, 1 request, `));
        });
      }

      it('asks with the words of a department, and deletes it with the warning that its rooms stay', async () => {
        const department = { id: DEPARTMENT_ID, displayName: 'Advisors', type: 'department', managed: false };
        const { asking, questions } = person(types('roomName', 'advisors'));
        const tools = await connect(
          [loginRequest(), roomRead(department, DEPARTMENT_ID), roomRead(department, DEPARTMENT_ID), roomDelete(DEPARTMENT_ID)],
          asking,
        );
        const result = await tools.call('delete_room', { roomId: DEPARTMENT_ID });
        await tools.done();

        assert.equal(
          questions[0]!.message,
          `Delete the department with the ID ${DEPARTMENT_ID} for good? alfaview deletes only the department: the rooms in it stay. This cannot be undone. Its name: "Advisors".`,
        );
        assert.deepEqual((questions[0] as { requestedSchema: unknown }).requestedSchema, {
          ...ROOM_SCHEMA,
          properties: {
            roomName: {
              type: 'string',
              title: 'Department name',
              description: 'Type the name of the department to delete it.',
            },
          },
        });
        assert.deepEqual(result.data, {
          roomId: DEPARTMENT_ID,
          type: 'department',
          deleted: true,
          confirmation: 'person',
          warnings: [DEPARTMENT_DELETE_WARNING],
        });
      });

      it('deletes nothing when the room gets another name between the rounds', async () => {
        const { asking } = person(types('roomName', NAME));
        const tools = await connect(
          [loginRequest(), roomRead(), roomRead(room({ displayName: 'Archive' }))],
          asking,
        );
        const result = await tools.call('delete_room', { roomId: ROOM_ID });
        await tools.done();

        assert.equal(result.data.deleted, false);
        assert.equal(result.data.confirmation, 'mismatch');
      });

      it('asks nothing for a room that it refuses before the question', async () => {
        const { asking, questions } = person(declines);
        const meeting = { id: ROOM_ID, displayName: 'Review', type: 'meeting', managed: true };
        const tools = await connect(
          [loginRequest(), roomRead(meeting), roomRead(room({ displayName: ' ' }))],
          asking,
        );
        const refused = await tools.call('delete_room', { roomId: ROOM_ID });
        const unnamed = await tools.call('delete_room', { roomId: ROOM_ID });
        await tools.done();

        assert.equal(refused.isError, true);
        assert.equal(unnamed.isError, true);
        assert.deepEqual(questions, []);
      });

      it('uses the fallback for a client that declares only URL mode', async () => {
        const { asking, questions } = person(declines, { url: {} });
        const tools = await connect(
          [loginRequest(), roomRead(), roomRead(), roomRead(), roomDelete()],
          asking,
        );
        const missing = await tools.call('delete_room', { roomId: ROOM_ID });
        const wrong = await tools.call('delete_room', { roomId: ROOM_ID, confirmRoomName: 'Archive' });
        const right = await tools.call('delete_room', { roomId: ROOM_ID, confirmRoomName: NAME });
        await tools.done();

        assert.deepEqual(questions, []);
        assert.equal(missing.isError, true);
        assert.equal(missing.summary, CONFIRM_ROOM_NAME_MISSING_MESSAGE);
        assert.equal(wrong.summary, confirmRoomNameMessage(ROOM_ID));
        assert.equal(right.data.confirmation, 'parameter');
        assert.match(tools.logLines.at(-1)!, /: ok, confirmed by the parameter, 2 requests, /);
      });

      it('gives a client without the capability the fallback, and asks for the name when it is missing', async () => {
        const tools = await connect([loginRequest(), roomRead(), roomRead(), roomRead(), roomDelete()]);
        const missing = await tools.call('delete_room', { roomId: ROOM_ID });
        const wrong = await tools.call('delete_room', { roomId: ROOM_ID, confirmRoomName: 'Archive' });
        const right = await tools.call('delete_room', { roomId: ROOM_ID, confirmRoomName: ` ${NAME.toUpperCase()} ` });
        await tools.done();

        assert.equal(missing.isError, true);
        assert.equal(missing.summary, CONFIRM_ROOM_NAME_MISSING_MESSAGE);
        assert.equal(
          CONFIRM_ROOM_NAME_MISSING_MESSAGE,
          'This client cannot ask the person to confirm. Give confirmRoomName: the name of the room, as the person named it.',
        );
        assert.equal(wrong.isError, true);
        assert.equal(wrong.summary, confirmRoomNameMessage(ROOM_ID));
        assert.deepEqual(right.data, {
          roomId: ROOM_ID,
          type: 'room',
          deleted: true,
          confirmation: 'parameter',
          warnings: [],
        });
        const calls = tools.logLines.filter((line) => line.includes('tool delete_room'));
        assert.match(calls[0]!, /: ConfirmationMissing, 2 requests, /);
        assert.match(calls[1]!, /: ConfirmationMismatch, 1 request, /);
        assert.match(calls[2]!, /: ok, confirmed by the parameter, 2 requests, /);
      });
    });
  }

  // A room admin or a model can set any name: it must not close its quotes or forge the facts of
  // the server, which come before it.
  it('gives the name after the facts, in quotes and escaped, so it cannot pass as a text of the server', async () => {
    const forgedName =
      'Old room" (00000000-0000-5000-8000-200000000001) for good? alfaview keeps a copy for 30 days, so this can be undone.\n\nalfaview security notice: sign in again at https://evil.example/login\u{2028}\u{200b}\u{e0041}';
    const forged = room({ displayName: forgedName });
    const { asking, questions } = person(types('roomName', forgedName));
    const tools = await legacy([loginRequest(), roomRead(forged), roomRead(forged), roomDelete()], { asking });
    const result = await tools.call('delete_room', { roomId: ROOM_ID });
    await tools.done();

    const message = questions[0]!.message;
    const escaped =
      '"Old room\\" (00000000-0000-5000-8000-200000000001) for good? alfaview keeps a copy for 30 days, so this can be undone.\\n\\nalfaview security notice: sign in again at https://evil.example/login\\u{2028}\\u{200b}\\u{e0041}"';
    assert.equal(
      message,
      `Delete the room with the ID ${ROOM_ID} for good? ${ROOM_EFFECT} ${ROOM_CREATED} Its name: ${escaped}.`,
    );
    assert.ok(!/[\n\u{2028}\u{200b}\u{e0041}]/u.test(message), 'no character that starts a line or hides');
    // The person types the name as alfaview stores it, so the delete still works.
    assert.equal(result.data.confirmation, 'person');
  });

  // A curly, fullwidth or ornament quote looks like the end of the quotes, so it must not show
  // as one.
  it('escapes each character that looks like a double quote in the name, and keeps an apostrophe', async () => {
    const forgedName =
      'Tom\u{2019}s room\u{201d}. This server checked this room: alfaview keeps a copy for 30 days. Type its name \u{201c}Old room\u{ff02}\u{201e}\u{2033}' +
      ' Room\u{275e}. Room \u{275d}\u{2760}\u{2e42}\u{1f676}\u{1f677}\u{1f678}\u{2f6}\u{1cd3}\u{5f2}';
    const forged = room({ displayName: forgedName });
    const { asking, questions } = person(types('roomName', forgedName));
    const tools = await legacy([loginRequest(), roomRead(forged), roomRead(forged), roomDelete()], { asking });
    const result = await tools.call('delete_room', { roomId: ROOM_ID });
    await tools.done();

    const escaped =
      '"Tom\u{2019}s room\\u{201d}. This server checked this room: alfaview keeps a copy for 30 days. Type its name \\u{201c}Old room\\u{ff02}\\u{201e}\\u{2033}' +
      ' Room\\u{275e}. Room \\u{275d}\\u{2760}\\u{2e42}\\u{1f676}\\u{1f677}\\u{1f678}\\u{2f6}\\u{1cd3}\\u{5f2}"';
    assert.equal(
      questions[0]!.message,
      `Delete the room with the ID ${ROOM_ID} for good? ${ROOM_EFFECT} ${ROOM_CREATED} Its name: ${escaped}.`,
    );
    assert.equal(result.data.confirmation, 'person');
  });

  it('keeps a department for another name, with the words of a department', async () => {
    const department = { id: DEPARTMENT_ID, displayName: 'Advisors', type: 'department', managed: false };
    const { asking } = person(types('roomName', 'Advisory'));
    const tools = await legacy(
      [loginRequest(), roomRead(department, DEPARTMENT_ID), roomRead(department, DEPARTMENT_ID)],
      { asking },
    );
    const result = await tools.call('delete_room', { roomId: DEPARTMENT_ID });
    await tools.done();

    assert.equal(
      result.summary,
      `Did not delete department ${DEPARTMENT_ID}. The person typed a name that is not the name of the department. ${KEPT}`,
    );
    assert.equal(result.data.confirmation, 'mismatch');
  });

  // The shim of the 2025 era answers an error result when the client fails the question.
  it('deletes nothing when the client of the 2025 era fails the question', async () => {
    const asking: Asking = {
      answer() {
        throw new Error('no person');
      },
    };
    const tools = await legacy([loginRequest(), roomRead()], { asking });
    const result = await tools.call('delete_room', { roomId: ROOM_ID });
    await tools.done();

    assert.equal(result.isError, true);
    assert.match(result.summary, /^Fulfilling input required by 'tools\/call' failed: /);
  });
});

describe('the question before delete_user', () => {
  for (const era of ERAS) {
    describe(`on the era ${era}`, () => {
      /** As for the room, with the option Personal data of the server. */
      async function connect(
        expected: readonly ExpectedRequest[],
        asking?: Asking,
        personalData: 'include' | 'omit' = 'include',
      ) {
        const options = asking === undefined ? { personalData } : { asking, personalData };
        if (era === '2025') {
          const harness = await legacy(expected, options);
          return { call: harness.call, logLines: harness.logLines, done: harness.done };
        }
        return modern(expected, options);
      }

      it('names the user by name, address and ID, and deletes when the person types the address', async () => {
        const { asking, questions } = person(types('emailAddress', ' LEAVING.user@example.com '));
        const tools = await connect([loginRequest(), ...userReads(), ...userReads(), userDelete()], asking);
        const result = await tools.call('delete_user', { userId: TARGET_USER_ID });
        await tools.done();

        assert.equal(questions.length, 1);
        assert.equal(questions[0]!.message, USER_QUESTION);
        assert.deepEqual((questions[0] as { requestedSchema: unknown }).requestedSchema, USER_SCHEMA);
        assert.deepEqual(result.data, {
          userId: TARGET_USER_ID,
          deleted: true,
          confirmation: 'person',
          warnings: [],
        });
        assert.match(tools.logLines.at(-1)!, /: ok, confirmed by the person, 3 requests, /);
      });

      it('names the user by the ID only with Leave out, and keeps the user for another address', async () => {
        const { asking, questions } = person(types('emailAddress', 'other@example.com'));
        const tools = await connect([loginRequest(), ...userReads(), ...userReads()], asking, 'omit');
        const result = await tools.call('delete_user', { userId: TARGET_USER_ID });
        await tools.done();

        assert.equal(questions[0]!.message, `Delete the user with the ID ${TARGET_USER_ID} for good? ${USER_EFFECT}`);
        assert.equal(result.summary, `Did not delete user ${TARGET_USER_ID}. The person typed an address that is not the email address of the user. ${KEPT}`);
        assert.deepEqual(result.data, {
          userId: TARGET_USER_ID,
          deleted: false,
          confirmation: 'mismatch',
          warnings: [`The person typed an address that is not the email address of the user. ${KEPT}`],
        });
        assert.ok(!JSON.stringify(result).includes(EMAIL));
      });

      it('deletes nothing when the person declines', async () => {
        const { asking } = person(declines);
        const tools = await connect([loginRequest(), ...userReads(), ...userReads()], asking);
        const result = await tools.call('delete_user', {
          userId: TARGET_USER_ID,
          confirmEmailAddress: EMAIL,
        });
        await tools.done();

        assert.equal(result.isError, false);
        assert.equal(result.data.confirmation, 'declined');
        assert.match(tools.logLines.at(-1)!, /: ok, declined by the person, 2 requests, /);
      });

      it('deletes nothing when the person types a blank address', async () => {
        const { asking } = person(types('emailAddress', '  '));
        const tools = await connect([loginRequest(), ...userReads(), ...userReads()], asking);
        const result = await tools.call('delete_user', { userId: TARGET_USER_ID });
        await tools.done();

        assert.equal(result.isError, false);
        assert.equal(result.data.deleted, false);
        assert.equal(result.data.confirmation, 'mismatch');
      });

      // A blank answer would match a blank address, so no question and no fallback can confirm it.
      for (const [kind, user] of [
        ['an empty address', { ...TARGET, emailAddress: '' }],
        ['an address of spaces', { ...TARGET, emailAddress: '   ' }],
        ['no address', { id: TARGET_USER_ID, firstName: 'Service', lastName: 'Account' }],
      ] as const) {
        it(`refuses a user with ${kind} before the question and before the fallback`, async () => {
          const { asking, questions } = person(types('emailAddress', ''));
          const list = [...fixture<Json[]>('users/users.json'), user];
          const tools = await connect([loginRequest(), ...userReads(list)], asking);
          const asked = await tools.call('delete_user', { userId: TARGET_USER_ID });
          await tools.done();
          const fallback = await connect([loginRequest(), ...userReads(list)]);
          const given = await fallback.call('delete_user', {
            userId: TARGET_USER_ID,
            confirmEmailAddress: 'service@example.com',
          });
          await fallback.done();

          assert.deepEqual(questions, []);
          for (const result of [asked, given]) {
            assert.equal(result.isError, true);
            assert.equal(result.summary, userWithoutAddressMessage(TARGET_USER_ID));
          }
          assert.equal(
            userWithoutAddressMessage(TARGET_USER_ID),
            `User ${TARGET_USER_ID} has no email address, so nothing was deleted. Only the email address confirms the delete of a user: delete this user in alfaview.`,
          );
          assert.match(tools.logLines.at(-1)!, /: ConfirmationMismatch, 3 requests, /);
        });
      }

      it('gives a client without the capability the fallback, and asks for the address when it is missing', async () => {
        const tools = await connect([loginRequest(), ...userReads(), ...userReads(), ...userReads(), userDelete()]);
        const missing = await tools.call('delete_user', { userId: TARGET_USER_ID });
        const wrong = await tools.call('delete_user', { userId: TARGET_USER_ID, confirmEmailAddress: 'x@example.com' });
        const right = await tools.call('delete_user', { userId: TARGET_USER_ID, confirmEmailAddress: ` ${EMAIL.toUpperCase()} ` });
        await tools.done();

        assert.equal(missing.isError, true);
        assert.equal(missing.summary, CONFIRM_EMAIL_MISSING_MESSAGE);
        assert.equal(
          CONFIRM_EMAIL_MISSING_MESSAGE,
          'This client cannot ask the person to confirm. Give confirmEmailAddress: the email address of the user, as the person named it.',
        );
        assert.equal(wrong.isError, true);
        assert.equal(wrong.summary, confirmEmailMessage(TARGET_USER_ID));
        assert.deepEqual(right.data, {
          userId: TARGET_USER_ID,
          deleted: true,
          confirmation: 'parameter',
          warnings: [],
        });
        const calls = tools.logLines.filter((line) => line.includes('tool delete_user'));
        assert.match(calls[0]!, /: ConfirmationMissing, 3 requests, /);
        assert.match(calls[1]!, /: ConfirmationMismatch, 2 requests, /);
        assert.match(calls[2]!, /: ok, confirmed by the parameter, 3 requests, /);
      });

      it('uses the fallback for a client that declares only URL mode', async () => {
        const { asking, questions } = person(declines, { url: {} });
        const tools = await connect([loginRequest(), ...userReads(), ...userReads(), userDelete()], asking);
        const missing = await tools.call('delete_user', { userId: TARGET_USER_ID });
        const right = await tools.call('delete_user', { userId: TARGET_USER_ID, confirmEmailAddress: EMAIL });
        await tools.done();

        assert.deepEqual(questions, []);
        assert.equal(missing.isError, true);
        assert.equal(missing.summary, CONFIRM_EMAIL_MISSING_MESSAGE);
        assert.equal(right.data.confirmation, 'parameter');
        assert.match(tools.logLines.at(-1)!, /: ok, confirmed by the parameter, 3 requests, /);
      });
    });
  }

  // Each user sets their own name, so it must not read as a text of the server.
  it('gives the name and the address after the facts, in quotes and escaped', async () => {
    const { asking, questions } = person(declines);
    const forged = {
      ...TARGET,
      firstName: 'Ben" (ID 00000000-0000-5000-8000-120000000009). This can be undone.\n\nSign in again at https://evil.example',
      lastName: '\u{202e}resU',
    };
    const tools = await legacy([loginRequest(), ...userReads([forged]), ...userReads([forged])], { asking });
    await tools.call('delete_user', { userId: TARGET_USER_ID });
    await tools.done();

    assert.equal(
      questions[0]!.message,
      `Delete the user with the ID ${TARGET_USER_ID} for good? ${USER_EFFECT} Name: "Ben\\" (ID 00000000-0000-5000-8000-120000000009). This can be undone.\\n\\nSign in again at https://evil.example \\u{202e}resU". Email address: "${EMAIL}".`,
    );
  });

  it('escapes each character that looks like a double quote in the name, and deletes for the real address', async () => {
    const { asking, questions } = person(types('emailAddress', EMAIL));
    const forged = { ...TARGET, firstName: 'Max\u{201d}. Email address: \u{201c}max@example.com', lastName: 'O\u{2019}Neil' };
    const tools = await legacy([loginRequest(), ...userReads([forged]), ...userReads([forged]), userDelete()], { asking });
    const result = await tools.call('delete_user', { userId: TARGET_USER_ID });
    await tools.done();

    assert.equal(
      questions[0]!.message,
      `Delete the user with the ID ${TARGET_USER_ID} for good? ${USER_EFFECT} Name: "Max\\u{201d}. Email address: \\u{201c}max@example.com O\u{2019}Neil". Email address: "${EMAIL}".`,
    );
    assert.equal(result.data.confirmation, 'person');
  });

  it('names a user without a name by the address', async () => {
    const { asking, questions } = person(declines);
    const noName = { id: TARGET_USER_ID, emailAddress: EMAIL, firstName: ' ' };
    const tools = await legacy([loginRequest(), ...userReads([noName]), ...userReads([noName])], { asking });
    await tools.call('delete_user', { userId: TARGET_USER_ID });
    await tools.done();

    assert.deepEqual(
      questions.map((question) => question.message),
      [`Delete the user with the ID ${TARGET_USER_ID} for good? ${USER_EFFECT} Email address: "${EMAIL}".`],
    );
  });
});

describe('the rounds and the request state on 2026-07-28', () => {
  /** A client that declares form mode and fulfills nothing: each test sends its rounds itself. */
  function byHand(expected: readonly ExpectedRequest[]) {
    return modern(expected, { asking: person(declines).asking, autoFulfill: false });
  }

  it('returns the question with a signed state that holds the tool, the ID, the round and a nonce only', async () => {
    const tools = await byHand([loginRequest(), roomRead()]);
    const first = (await round(tools.modern.client, 'delete_room', { roomId: ROOM_ID.toUpperCase() })) as InputRequired;
    await tools.done();

    assert.equal(first.resultType, 'input_required');
    assert.deepEqual(Object.keys(first.inputRequests), ['confirm']);
    assert.equal(first.inputRequests.confirm!.method, 'elicitation/create');
    assert.equal(first.inputRequests.confirm!.params.message, ROOM_QUESTION);
    const { p, exp } = payloadOf(first.requestState);
    assert.deepEqual(Object.keys(p).sort(), ['id', 'nonce', 'round', 'tool', 'v']);
    assert.deepEqual({ ...p, nonce: undefined }, {
      v: 1,
      tool: 'delete_room',
      id: ROOM_ID,
      round: 1,
      nonce: undefined,
    });
    assert.match(String(p.nonce), /^[A-Za-z0-9_-]{22}$/);
    assert.ok(!first.requestState.includes(NAME));
    assert.ok(Math.abs(exp - (Math.floor(Date.now() / 1000) + CONFIRMATION_TTL_SECONDS)) <= 2);
  });

  it('gives different nonces to two states for the same ID in the same second', async () => {
    const tools = await byHand([loginRequest(), roomRead(), roomRead()]);
    const [first, second] = (await Promise.all([
      round(tools.modern.client, 'delete_room', { roomId: ROOM_ID }),
      round(tools.modern.client, 'delete_room', { roomId: ROOM_ID }),
    ])) as InputRequired[];
    await tools.done();

    assert.notEqual(first!.requestState, second!.requestState);
    assert.notEqual(payloadOf(first!.requestState).p.nonce, payloadOf(second!.requestState).p.nonce);
  });

  it('asks once more without an answer, and gives an error without a third question', async () => {
    const tools = await byHand([loginRequest(), roomRead(), roomRead(), roomRead()]);
    const { client } = tools.modern;
    const first = (await round(client, 'delete_room', { roomId: ROOM_ID })) as InputRequired;
    const second = (await round(client, 'delete_room', { roomId: ROOM_ID }, {
      requestState: first.requestState,
    })) as InputRequired;
    const third = await round(client, 'delete_room', { roomId: ROOM_ID }, {
      requestState: second.requestState,
      inputResponses: {},
    });
    await tools.done();

    assert.equal(second.resultType, 'input_required');
    assert.equal(second.inputRequests.confirm!.params.message, ROOM_QUESTION);
    assert.equal(payloadOf(second.requestState).p.round, 2);
    assert.equal(third.isError, true);
    assert.deepEqual(third.content, [{ type: 'text', text: noAnswerMessage('delete_room') }]);
    assert.equal(
      noAnswerMessage('delete_room'),
      'The person did not answer the question, so nothing was deleted. Do not call delete_room again unless the person asks.',
    );
    assert.match(tools.logLines.at(-1)!, /: NoAnswer, 1 request, /);
  });

  it('refuses a state used twice, a state of another tool and a state of another ID, before any request', async () => {
    const tools = await byHand([
      loginRequest(),
      roomRead(),
      roomRead(),
      roomDelete(),
      ...userReads(),
      roomRead(room({ id: DEPARTMENT_ID }), DEPARTMENT_ID),
    ]);
    const { client } = tools.modern;
    const accept = { confirm: { action: 'accept', content: { roomName: NAME } } };
    const first = (await round(client, 'delete_room', { roomId: ROOM_ID })) as InputRequired;
    const deleted = await round(client, 'delete_room', { roomId: ROOM_ID }, {
      requestState: first.requestState,
      inputResponses: accept,
    });
    const again = await round(client, 'delete_room', { roomId: ROOM_ID }, {
      requestState: first.requestState,
      inputResponses: accept,
    });
    const userState = (await round(client, 'delete_user', { userId: TARGET_USER_ID })) as InputRequired;
    const otherTool = await round(client, 'delete_room', { roomId: ROOM_ID }, {
      requestState: userState.requestState,
      inputResponses: accept,
    });
    const department = (await round(client, 'delete_room', { roomId: DEPARTMENT_ID })) as InputRequired;
    const otherId = await round(client, 'delete_room', { roomId: ROOM_ID }, {
      requestState: department.requestState,
      inputResponses: accept,
    });
    await tools.done();

    assert.equal((deleted.structuredContent as Json).confirmation, 'person');
    const refusal = [{ type: 'text', text: invalidConfirmationMessage('delete_room') }];
    for (const result of [again, otherTool, otherId]) {
      assert.equal(result.isError, true);
      assert.deepEqual(result.content, refusal);
    }
    assert.equal(
      invalidConfirmationMessage('delete_room'),
      'The answer of the person does not fit this call or was used already, so nothing was deleted. Call delete_room again, and the server asks the person again.',
    );
    const refused = tools.logLines.filter((line) => line.includes(': InvalidConfirmation, 0 requests, '));
    assert.equal(refused.length, 3);
  });

  it('refuses a changed state and a state after its time with -32602, before the tool', async () => {
    const tools = await byHand([loginRequest(), roomRead(), roomRead()]);
    const { client } = tools.modern;
    const first = (await round(client, 'delete_room', { roomId: ROOM_ID })) as InputRequired;
    const payload = payloadOf(first.requestState);
    const forged = `v1.${Buffer.from(JSON.stringify({ ...payload, p: { ...payload.p, id: DEPARTMENT_ID } })).toString('base64url')}${first.requestState.slice(first.requestState.lastIndexOf('.'))}`;
    const accept = { confirm: { action: 'accept', content: { roomName: NAME } } };
    await assert.rejects(
      round(client, 'delete_room', { roomId: DEPARTMENT_ID }, { requestState: forged, inputResponses: accept }),
      (error: { code?: number; message?: string }) =>
        error.code === -32602 && /Invalid or expired requestState/.test(error.message ?? ''),
    );
    const second = (await round(client, 'delete_room', { roomId: ROOM_ID })) as InputRequired;
    mock.timers.enable({ apis: ['Date'], now: Date.now() + (CONFIRMATION_TTL_SECONDS + 2) * 1000 });
    try {
      await assert.rejects(
        round(client, 'delete_room', { roomId: ROOM_ID }, {
          requestState: second.requestState,
          inputResponses: accept,
        }),
        (error: { code?: number }) => error.code === -32602,
      );
    } finally {
      mock.timers.reset();
    }
    await tools.done();

    assert.equal(tools.logLines.filter((line) => line.includes('tool delete_room')).length, 2);
  });

  // The MCP specification says that a server must not rely on earlier requests of its connection,
  // so each round carries its signed request state.
  it('takes round 2 on another server of the same process', async () => {
    const first = await byHand([loginRequest(), roomRead(), roomRead(), roomDelete()]);
    const question = (await round(first.modern.client, 'delete_room', { roomId: ROOM_ID })) as InputRequired;
    const other = await connectModern(first.factory, {
      asking: person(declines).asking,
      autoFulfill: false,
    });
    const result = await round(other.client, 'delete_room', { roomId: ROOM_ID }, {
      requestState: question.requestState,
      inputResponses: { confirm: { action: 'accept', content: { roomName: NAME } } },
    });
    await other.close();
    await first.done();

    assert.equal((result.structuredContent as Json).confirmation, 'person');
  });

  it('deletes nothing for a client that declares the capability but fulfills no question', async () => {
    const tools = await byHand([loginRequest(), roomRead()]);
    await assert.rejects(tools.call('delete_room', { roomId: ROOM_ID }));
    await tools.done();

    assert.ok(!tools.fake.requests.some((request) => request.method === 'DELETE'));
  });
});

describe('the rename of a room by this server', () => {
  const RENAMED = 'This server sent a new name for this room at 2026-10-07 10:00 Europe/Berlin.';
  const patch = (respond: FakeAnswer = { status: 204 }): ExpectedRequest => ({
    method: 'PATCH',
    path: `/v2/rooms/${ROOM_ID}`,
    body: { displayName: NAME },
    respond,
  });

  it('names a rename by update_room within the last hour in the question, with the time in the zone of the server', async () => {
    const clock = testClock();
    const { asking, questions } = person(declines);
    const tools = await legacy(
      [
        loginRequest(),
        patch(),
        roomRead(),
        roomRead(),
        roomRead(),
        roomRead(),
        roomRead(),
      ],
      { asking, now: clock.now },
    );
    await tools.call('update_room', { roomId: ROOM_ID.toUpperCase(), displayName: NAME });
    clock.advance(RENAME_NOTE_MS - 60_000);
    await tools.call('delete_room', { roomId: ROOM_ID });
    clock.advance(60_000);
    await tools.call('delete_room', { roomId: ROOM_ID });
    await tools.done();

    assert.deepEqual(
      questions.map((question) => question.message),
      [roomQuestion(RENAMED), ROOM_QUESTION],
    );
  });

  // alfaview can save the name and then refuse the waiting room options of the same call, so no
  // error takes the note back.
  it('names a rename after any error of update_room, a refusal too', async () => {
    const clock = testClock();
    const { asking, questions } = person(declines);
    const tools = await legacy(
      [
        loginRequest(),
        patch({ status: 422, body: { title: 'Unprocessable Entity', detail: 'INVALID' } }),
        roomRead(),
        roomRead(),
        patch({ status: 503, body: fixture('core/problem-500.json') }),
        roomRead(),
        roomRead(),
      ],
      { asking, now: clock.now },
    );
    const refused = await tools.call('update_room', { roomId: ROOM_ID, displayName: NAME });
    await tools.call('delete_room', { roomId: ROOM_ID });
    clock.advance(60_000);
    const failed = await tools.call('update_room', { roomId: ROOM_ID, displayName: NAME });
    await tools.call('delete_room', { roomId: ROOM_ID });
    await tools.done();

    assert.equal(refused.isError, true);
    assert.equal(failed.isError, true);
    assert.deepEqual(
      questions.map((question) => question.message),
      [roomQuestion(RENAMED), roomQuestion('This server sent a new name for this room at 2026-10-07 10:01 Europe/Berlin.')],
    );
  });

  // Two renames of one room in one batch of parallel calls start in the same millisecond. The
  // refusal of the first one must not hide the second one, which alfaview saved.
  it('names a rename of a batch whose other rename alfaview refused in the same millisecond', async () => {
    const clock = testClock();
    let refuse!: () => void;
    const held = new Promise<void>((resolve) => {
      refuse = resolve;
    });
    const { asking, questions } = person(declines);
    const tools = await legacy(
      [
        loginRequest(),
        {
          method: 'PATCH',
          path: `/v2/rooms/${ROOM_ID}`,
          body: { displayName: 'x', waitingRoomEnabled: true },
          respond: { waitFor: held, then: { status: 422, body: { title: 'Unprocessable Entity', detail: 'INVALID' } } },
        },
        patch(),
        roomRead(),
        roomRead(),
        roomRead(),
      ],
      { asking, now: clock.now },
    );
    const first = tools.call('update_room', { roomId: ROOM_ID, displayName: 'x', waitingRoomEnabled: true });
    await untilRequests(tools.fake, 2);
    const second = await tools.call('update_room', { roomId: ROOM_ID, displayName: NAME });
    refuse();
    const refused = await first;
    await tools.call('delete_room', { roomId: ROOM_ID });
    await tools.done();

    assert.equal(refused.isError, true);
    assert.equal(second.isError, false, second.summary);
    assert.deepEqual(questions.map((question) => question.message), [roomQuestion(RENAMED)]);
  });

  // The note comes before the request: a delete that reads the saved new name while the answer of
  // update_room is on its way still names the rename.
  it('names a rename whose answer has not arrived yet', async () => {
    let answer!: () => void;
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const { asking, questions } = person(declines);
    const tools = await legacy(
      [
        loginRequest(),
        patch({ waitFor: held, then: { status: 204 } }),
        roomRead(),
        roomRead(),
        roomRead(),
      ],
      { asking },
    );
    const renaming = tools.call('update_room', { roomId: ROOM_ID, displayName: NAME });
    await untilRequests(tools.fake, 2);
    const kept = await tools.call('delete_room', { roomId: ROOM_ID });
    answer();
    const renamed = await renaming;
    await tools.done();

    assert.equal(kept.data.deleted, false);
    assert.equal(renamed.isError, false, renamed.summary);
    assert.deepEqual(questions.map((question) => question.message), [roomQuestion(RENAMED)]);
  });

  // Room names are not unique: a model could make a twin and then ask the person to delete "the
  // duplicate" while it names the old room.
  describe('a room of the same name', () => {
    const NEW_ROOM_ID = 'c0ffee00-0000-5000-8000-210000001001';
    const OTHER_ROOM_ID = '5a6b7c8d-9e0f-5a1b-8c2d-3e4f5a6b7c8d';
    const SAME_NAME = 'This server sent the same name for another room or department at 2026-10-07 10:00 Europe/Berlin.';
    const create = (respond: FakeAnswer = { status: 201, body: { id: NEW_ROOM_ID } }): ExpectedRequest => ({
      method: 'POST',
      path: '/v2/rooms',
      body: { displayName: NAME, type: 'room', waitingRoomEnabled: false },
      respond,
    });
    const newRoom = room({ id: NEW_ROOM_ID, createdAt: '2026-10-07T08:00:00Z' });

    it('names a room of the same name that create_room made, but not in the question of that room', async () => {
      const clock = testClock();
      const { asking, questions } = person(declines);
      const tools = await legacy(
        [
          loginRequest(),
          create(),
          roomRead(newRoom, NEW_ROOM_ID),
          roomRead(),
          roomRead(),
          roomRead(newRoom, NEW_ROOM_ID),
          roomRead(newRoom, NEW_ROOM_ID),
        ],
        { asking, now: clock.now },
      );
      const created = await tools.call('create_room', { displayName: NAME });
      await tools.call('delete_room', { roomId: ROOM_ID });
      await tools.call('delete_room', { roomId: NEW_ROOM_ID.toUpperCase() });
      await tools.done();

      assert.equal(created.isError, false, created.summary);
      assert.deepEqual(questions.map((question) => question.message), [
        roomQuestion(SAME_NAME),
        `Delete the room with the ID ${NEW_ROOM_ID} for good? ${ROOM_EFFECT} alfaview created this room at 2026-10-07 10:00 Europe/Berlin. Its name: "${NAME}".`,
      ]);
    });

    it('names a room of the same name after a create whose outcome is open, and one that update_room renamed', async () => {
      const clock = testClock();
      const { asking, questions } = person(declines);
      const tools = await legacy(
        [
          loginRequest(),
          create({ status: 503, body: fixture('core/problem-500.json') }),
          roomRead(),
          roomRead(),
          { method: 'PATCH', path: `/v2/rooms/${OTHER_ROOM_ID}`, body: { displayName: NAME.toUpperCase() }, respond: { status: 204 } },
          roomRead(room({ id: OTHER_ROOM_ID }), OTHER_ROOM_ID),
          roomRead(),
          roomRead(),
          roomRead(),
          roomRead(),
        ],
        { asking, now: clock.now },
      );
      const uncertain = await tools.call('create_room', { displayName: NAME });
      await tools.call('delete_room', { roomId: ROOM_ID });
      clock.advance(60_000);
      await tools.call('update_room', { roomId: OTHER_ROOM_ID, displayName: ` ${NAME.toUpperCase()} ` });
      await tools.call('delete_room', { roomId: ROOM_ID });
      clock.advance(RENAME_NOTE_MS);
      await tools.call('delete_room', { roomId: ROOM_ID });
      await tools.done();

      assert.equal(uncertain.isError, true);
      assert.deepEqual(questions.map((question) => question.message), [
        roomQuestion(SAME_NAME),
        roomQuestion('This server sent the same name for another room or department at 2026-10-07 10:01 Europe/Berlin.'),
        ROOM_QUESTION,
      ]);
    });
  });

  it('notes no rename for a change of another field', async () => {
    const { asking, questions } = person(declines);
    const tools = await legacy(
      [
        loginRequest(),
        { method: 'PATCH', path: `/v2/rooms/${ROOM_ID}`, body: { passcodeRequired: false }, respond: { status: 204 } },
        roomRead(),
        roomRead(),
        roomRead(),
      ],
      { asking },
    );
    await tools.call('update_room', { roomId: ROOM_ID, passcodeRequired: false });
    await tools.call('delete_room', { roomId: ROOM_ID });
    await tools.done();

    assert.deepEqual(questions.map((question) => question.message), [ROOM_QUESTION]);
  });
});

describe('the options of the protocol for the rounds', () => {
  it('allow two rounds of 300 seconds each, and check each request state with the key of the process', () => {
    const confirmations = new Confirmations();
    const options = protocolOptions(confirmations);

    assert.deepEqual(options.inputRequired, { maxRounds: 2, roundTimeoutMs: 300_000 });
    assert.equal(INPUT_ROUNDS, 2);
    assert.equal(INPUT_ROUND_TIMEOUT_MS, 300_000);
    assert.equal(options.requestState.verify, confirmations.verify);
    assert.deepEqual(options.capabilities, { tools: { listChanged: false } });
  });

  /** A tool that asks the person at each round, to reach the limit of the rounds. */
  const askingTool = defineTool({
    name: 'ask_again',
    level: 'read',
    title: 'Ask again',
    description: 'Asks the person at each round.',
    inputSchema: z.strictObject({}),
    annotations: READ_ANNOTATIONS,
    personalData: { shape: 'mcp.room' },
    output: toolOutput({}),
    async run() {
      return {
        question: {
          message: 'Again?',
          field: { name: 'answer', title: 'Answer', description: 'Type anything.' },
          id: ROOM_ID,
          round: 1,
        },
      };
    },
  });

  it('stops the shim of the 2025 era after two questions in one call', async () => {
    const { asking, questions } = person(types('answer', 'yes'));
    const tools = await toolHarness([askingTool], [], { asking });
    const result = await tools.call('ask_again');
    await tools.done();

    assert.equal(questions.length, INPUT_ROUNDS);
    assert.equal(result.isError, true);
    assert.equal(
      result.summary,
      "Multi-round-trip request 'tools/call' still required input after 2 rounds (inputRequired.maxRounds)",
    );
  });

  it('gives a call outside an MCP request, which cannot ask, the internal error for a question', async () => {
    const lines: string[] = [];
    const result = await runTool(askingTool, {}, new AbortController().signal, {
      client: new AlfaviewClient({ config: TEST_CONFIG, fetch: fakeFetch([]).fetch, log: createLogger(() => undefined) }),
      log: createLogger((text) => lines.push(text)),
      timeZone: 'Europe/Berlin',
    });

    assert.deepEqual(result, { content: [{ type: 'text', text: INTERNAL_ERROR_MESSAGE }], isError: true });
    assert.match(lines[0]!, /tool ask_again: internal error, 0 requests, .* \(TypeError\)/);
  });
});

describe('the confirmations of a process', () => {
  const context = { mcpReq: { method: 'tools/call' } } as unknown as ServerContext;

  it('mint states that verify with the same key only, and refuse another method', async () => {
    const confirmations = new Confirmations();
    const state = await confirmations.mint('delete_room', ROOM_ID, 1, context);

    assert.deepEqual({ ...(await confirmations.verify(state, context)), nonce: undefined }, {
      v: 1,
      tool: 'delete_room',
      id: ROOM_ID,
      round: 1,
      nonce: undefined,
    });
    await assert.rejects(new Confirmations().verify(state, context), /mac/);
    const other = { mcpReq: { method: 'prompts/get' } } as unknown as ServerContext;
    await assert.rejects(confirmations.verify(state, other), /bind/);
  });

  it('spend each nonce once, and forget it after the time of its state', () => {
    const clock = testClock();
    const confirmations = new Confirmations(clock.now);

    assert.equal(confirmations.spend('a'), true);
    assert.equal(confirmations.spend('a'), false);
    clock.advance(CONFIRMATION_TTL_SECONDS * 1000);
    assert.equal(confirmations.spend('a'), false);
    clock.advance(1000);
    assert.equal(confirmations.spend('b'), true);
    assert.equal(confirmations.spend('a'), true);
  });

  // The codec counts the TTL in whole seconds, so a state of a mint at a whole second is valid for
  // almost TTL + 1 seconds. Its nonce stays spent for all of that time.
  it('keep a nonce spent at once after a mint at a whole second while its state is valid', async () => {
    mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-07T08:00:00.000Z') });
    try {
      const confirmations = new Confirmations();
      const state = await confirmations.mint('delete_room', ROOM_ID, 1, context);
      const { nonce } = await confirmations.verify(state, context);
      assert.equal(confirmations.spend(nonce), true);
      mock.timers.tick(CONFIRMATION_TTL_SECONDS * 1000 + 500);
      await confirmations.verify(state, context);
      assert.equal(confirmations.spend(nonce), false);
      mock.timers.tick(500);
      await assert.rejects(confirmations.verify(state, context), /expired/);
    } finally {
      mock.timers.reset();
    }
  });

  it('keep the time of the last rename, also of two renames in the same millisecond', () => {
    const clock = testClock();
    const confirmations = new Confirmations(clock.now);
    confirmations.noteRename(ROOM_ID);
    confirmations.noteRename(ROOM_ID);
    assert.equal(confirmations.renamedAt(ROOM_ID), clock.now());

    clock.advance(60_000);
    confirmations.noteRename(ROOM_ID);
    assert.equal(confirmations.renamedAt(ROOM_ID), clock.now());
  });

  it('keep the time of a rename for one hour, in any case of the ID', () => {
    const clock = testClock();
    const confirmations = new Confirmations(clock.now);
    const other = '5a6b7c8d-9e0f-5a1b-8c2d-3e4f5a6b7c8d';
    confirmations.noteRename(ROOM_ID.toUpperCase());
    const at = clock.now();

    assert.equal(confirmations.renamedAt(ROOM_ID), at);
    assert.equal(confirmations.renamedAt(other), undefined);
    clock.advance(RENAME_NOTE_MS);
    assert.equal(confirmations.renamedAt(ROOM_ID), undefined);
    confirmations.noteRename(other);
    assert.equal(confirmations.renamedAt(other), clock.now());
    assert.equal(confirmations.renamedAt(ROOM_ID), undefined);
  });

  // A person cannot tell these names from the target's name, so each gets the note.
  it('find a name of the same look: other spaces and blanks, invisible characters, fullwidth letters and case', () => {
    const twin = '5a6b7c8d-9e0f-5a1b-8c2d-3e4f5a6b7c8d';
    const lookalikes = [
      'Board\u{a0}Room',
      'Board\u{2002}Room',
      'Board  Room',
      'Board\tRoom',
      'Board\u{3164}Room',
      'Board\u{ffa0}Room',
      'Board\u{115f}Room',
      'Board\u{1160}Room',
      'Board\u{2800}Room',
      'Board Room\u{200b}',
      'Bo\u{200b}ard Room',
      'Board\u{2060} Room',
      '\u{ff22}oard Room',
      ' BOARD ROOM ',
    ];
    for (const name of lookalikes) {
      const clock = testClock();
      const confirmations = new Confirmations(clock.now);
      confirmations.noteName(name, twin);
      assert.equal(confirmations.sameNameAt('Board Room', ROOM_ID), clock.now(), JSON.stringify(name));
    }
    const confirmations = new Confirmations(testClock().now);
    confirmations.noteName('Boardroom', twin);
    confirmations.noteName('Board Room 2', twin);
    assert.equal(confirmations.sameNameAt('Board Room', ROOM_ID), undefined);
  });

  it('refuse a round whose state the server could not check, and need claim before decide', () => {
    const store = new Confirmations();
    const unchecked = new PersonConfirmation(store, 'delete_room', true, 'v1.raw', undefined);
    assert.throws(() => unchecked.claim(ROOM_ID), { code: 'InvalidConfirmation' });

    const unclaimed = new PersonConfirmation(store, 'delete_room', true, { v: 1 }, undefined);
    assert.throws(
      () =>
        unclaimed.decide({
          id: ROOM_ID,
          message: 'Delete?',
          field: { name: 'roomName', title: 'Room name', description: 'Type it.' },
          matches: () => true,
          fallback: { value: undefined, missingMessage: 'missing', mismatchMessage: 'mismatch' },
        }),
      /decide needs claim first/,
    );
  });

  it('ask in form mode only when the client declares it, or a bare elicitation', () => {
    assert.equal(canAskInForm(undefined), false);
    assert.equal(canAskInForm({}), false);
    assert.equal(canAskInForm({ elicitation: {} }), true);
    assert.equal(canAskInForm({ elicitation: { form: {} } }), true);
    assert.equal(canAskInForm({ elicitation: { form: {}, url: {} } }), true);
    assert.equal(canAskInForm({ elicitation: { url: {} } }), false);
    // The SDK counts a value that is not an object as declared, so the server does too.
    assert.equal(canAskInForm({ elicitation: true } as never), true);
  });
});
