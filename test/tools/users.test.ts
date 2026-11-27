// find_users, invite_user and delete_user through an MCP SDK client.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CANCELED_MESSAGE } from '../../src/alfaview/client.ts';
import { PROFILE_NOT_RETURNED_MESSAGE } from '../../src/domain/account.ts';
import {
  confirmEmailMessage,
  INVITE_EMAIL_MESSAGE,
  INVITE_UNCERTAIN_MESSAGE,
  INVITED_NOT_LISTED_WARNING,
  NOT_A_USER_ID_MESSAGE,
  ONLY_API_KEY_USER_WARNING,
  selfDeleteMessage,
  USER_EXISTS_MESSAGE,
  userNotListedMessage,
  USERS_UNEXPECTED_MESSAGE,
  userWithoutAddressMessage,
} from '../../src/domain/users.ts';
import { createLogger } from '../../src/log.ts';
import { inputErrorWithoutPersonalData } from '../../src/shared/personalData.ts';
import {
  CREATE_ANNOTATIONS,
  IDEMPOTENT_CHANGE_ANNOTATIONS,
  READ_ANNOTATIONS,
  USER_ID_MESSAGE,
  type ToolContext,
} from '../../src/tools/tool.ts';
import {
  CONFIRM_EMAIL_TEXT,
  CONFIRM_EMAIL_TEXT_WITHOUT_PERSONAL_DATA,
  deleteUserTool,
  findUsersTool,
  FULL_USER_TOOLS,
  inviteUserTool,
  USER_TOOLS,
} from '../../src/tools/users.ts';
import {
  loginRequest,
  testApi,
  toolErrorOf,
  untilRequests,
  type ExpectedRequest,
  type FakeAnswer,
} from '../helpers/fakeFetch.ts';
import { fixture } from '../helpers/fixtures.ts';
import { toolHarness, type HarnessOptions } from '../helpers/mcpClient.ts';
import { noQuestions, outputOf } from '../helpers/toolContext.ts';

type Json = Record<string, unknown>;

/** The user of core/user-profile.json, the API key's user, and Anna in users/users.json. */
const API_KEY_USER_ID = '6c1d9e4f-2a7b-5c3d-9e8f-0a1b2c3d4e5f';
const ZAPIER_SERVICE_ID = '7e8f9a0b-1c2d-5e3f-8a4b-5c6d7e8f9a0b';
const MAX_ID = '1a2b3c4d-5e6f-5a7b-8c9d-0e1f2a3b4c5d';
const BEN_ID = '3b4c5d6e-7f8a-5b9c-8d0e-1f2a3b4c5d6e';

/** IDs of users in the form of alfaview: version 5 with the kind 18 (hex 12) in byte 10. */
const OWN_USER_ID = 'c0ffee00-0000-5000-8000-120000000001';
const TARGET_USER_ID = 'c0ffee00-0000-5000-8000-120000000002';
const NEW_USER_ID = 'c0ffee00-0000-5000-8000-120000000003';

const FORBIDDEN = /^The API key's user is not allowed to do this/;

/** The users of users/users.json in the order of find_users, without city and initials. */
const LISTED = [
  {
    id: ZAPIER_SERVICE_ID,
    emailAddress: 'zapier-service@example.com',
    firstName: null,
    lastName: null,
    title: null,
    locale: 'en-US',
  },
  {
    id: API_KEY_USER_ID,
    emailAddress: 'anna.example@example.com',
    firstName: 'Anna',
    lastName: 'Example',
    title: null,
    locale: 'de-DE',
  },
  {
    id: BEN_ID,
    emailAddress: 'ben.example@example.com',
    firstName: 'Ben',
    lastName: 'Example',
    title: null,
    locale: 'en-US',
  },
  {
    id: MAX_ID,
    emailAddress: 'max.mustermann@example.com',
    firstName: 'Max',
    lastName: 'Mustermann',
    title: 'Dr.',
    locale: 'de-DE',
  },
];

function usersRequest(
  respond: FakeAnswer = { status: 200, body: fixture('users/users.json') },
): ExpectedRequest {
  return { method: 'GET', path: '/v2/users', respond };
}

function profileRequest(
  respond: FakeAnswer = { status: 200, body: fixture('core/user-profile.json') },
): ExpectedRequest {
  return { method: 'GET', path: '/v2/users/me', respond };
}

/** The profile of the API key's user with the ID `id`. */
function profileOf(id: string): FakeAnswer {
  return { status: 200, body: { ...fixture<Json>('core/user-profile.json'), id } };
}

/** The context of a direct call of `run`, for the tests of a cancel. */
function context(api: ToolContext['api'], signal: AbortSignal): ToolContext {
  return {
    api,
    now: Date.parse('2026-10-07T08:00:00Z'),
    timeZone: 'Europe/Berlin',
    signal,
    log: createLogger(() => undefined),
    personalData: 'include',
    level: 'full',
    confirmation: noQuestions(),
  };
}

describe('the user tools', () => {
  it('are listed in their fixed order, with their levels, titles and annotations', async () => {
    const harness = await toolHarness([...USER_TOOLS, ...FULL_USER_TOOLS], []);
    const { tools } = await harness.client.listTools();
    await harness.done();

    assert.deepEqual(
      tools.map((tool) => [tool.name, tool.title, tool.annotations]),
      [
        ['find_users', 'Find users', READ_ANNOTATIONS],
        ['invite_user', 'Invite a user', CREATE_ANNOTATIONS],
        ['delete_user', 'Delete a user', IDEMPOTENT_CHANGE_ANNOTATIONS],
      ],
    );
    assert.deepEqual(
      [...USER_TOOLS, ...FULL_USER_TOOLS].map((tool) => tool.level),
      ['manage', 'full', 'full'],
    );
  });
});

describe('find_users', () => {
  function harness(expected: readonly ExpectedRequest[], options: HarnessOptions = {}) {
    return toolHarness(USER_TOOLS, expected, options);
  }

  /** The requests of one call: the list, then the profile. */
  const call = (respond?: FakeAnswer): ExpectedRequest[] => [usersRequest(respond), profileRequest()];

  it('lists the users by last name, first name, email address and ID, without city and initials', async () => {
    const tools = await harness([loginRequest(), ...call()]);
    const result = await tools.call('find_users');
    await tools.done();

    assert.equal(result.summary, 'Found 4 users. Showing 1 to 4.');
    assert.deepEqual(result.data, {
      apiKeyUserId: API_KEY_USER_ID,
      totalMatches: 4,
      offset: 0,
      nextOffset: null,
      users: LISTED,
      warnings: [],
    });
    assert.match(tools.logLines.at(-1)!, /tool find_users: ok, 3 requests, /);
  });

  it('matches the email address in another case and with spaces', async () => {
    const users = fixture<Json[]>('users/users.json');
    users[2]!.emailAddress = ' Max.Mustermann@Example.com ';
    const tools = await harness([loginRequest(), ...call(), ...call({ status: 200, body: users })]);
    const upper = await tools.call('find_users', { emailAddress: ' MAX.MUSTERMANN@example.COM ' });
    const stored = await tools.call('find_users', { emailAddress: 'max.mustermann@example.com' });
    await tools.done();

    assert.equal(upper.summary, 'Found 1 user that matches. Showing 1 to 1.');
    assert.deepEqual(upper.data.users, [LISTED[3]]);
    assert.deepEqual(
      stored.data.users.map((user: Json) => user.id),
      [MAX_ID],
    );
  });

  it('matches a part of the first name, of the last name and of both, in any case', async () => {
    const tools = await harness([loginRequest(), ...call(), ...call(), ...call(), ...call()]);
    const results = [
      await tools.call('find_users', { name: 'NNA' }),
      await tools.call('find_users', { name: 'muster' }),
      await tools.call('find_users', { name: ' anna exa ' }),
      await tools.call('find_users', { name: 'example' }),
    ];
    await tools.done();

    assert.deepEqual(
      results.map((result) => result.data.users.map((user: Json) => user.id)),
      [[API_KEY_USER_ID], [MAX_ID], [API_KEY_USER_ID], [API_KEY_USER_ID, BEN_ID]],
    );
    assert.equal(results[3]!.summary, 'Found 2 users that match. Showing 1 to 2.');
  });

  // alfaview gives an invited user who is not set up yet the locale `unknown` when the invitation
  // had no language. The tool gives null for it, as for an empty locale.
  it('returns a null locale for an invited user whose locale alfaview answers as unknown', async () => {
    const invited = { id: NEW_USER_ID, emailAddress: 'nina.new@example.com', firstName: '', lastName: '', locale: 'unknown' };
    const users = [...fixture<Json[]>('users/users.json'), invited];
    const tools = await harness([loginRequest(), ...call({ status: 200, body: users })]);
    const result = await tools.call('find_users', { emailAddress: 'nina.new@example.com' });
    await tools.done();

    assert.deepEqual(result.data.users, [
      { id: NEW_USER_ID, emailAddress: 'nina.new@example.com', firstName: null, lastName: null, title: null, locale: null },
    ]);
  });

  it('needs both filters to match when both are given', async () => {
    const tools = await harness([loginRequest(), ...call(), ...call()]);
    const ben = await tools.call('find_users', { name: 'example', emailAddress: 'ben.example@example.com' });
    const none = await tools.call('find_users', { name: 'max', emailAddress: 'ben.example@example.com' });
    await tools.done();

    assert.deepEqual(
      ben.data.users.map((user: Json) => user.id),
      [BEN_ID],
    );
    assert.equal(none.summary, 'Found no users that match.');
    assert.deepEqual(none.data, {
      apiKeyUserId: API_KEY_USER_ID,
      totalMatches: 0,
      offset: 0,
      nextOffset: null,
      users: [],
      warnings: [],
    });
  });

  it('pages with limit and offset', async () => {
    const tools = await harness([loginRequest(), ...call(), ...call(), ...call()]);
    const first = await tools.call('find_users', { limit: 2 });
    const second = await tools.call('find_users', { limit: 2, offset: 2 });
    const beyond = await tools.call('find_users', { offset: 10 });
    await tools.done();

    assert.equal(first.summary, 'Found 4 users. Showing 1 to 2. Call again with offset 2 for the next ones.');
    assert.equal(first.data.nextOffset, 2);
    assert.deepEqual(first.data.users, LISTED.slice(0, 2));
    assert.equal(second.summary, 'Found 4 users. Showing 3 to 4.');
    assert.equal(second.data.nextOffset, null);
    assert.deepEqual(second.data.users, LISTED.slice(2));
    assert.equal(beyond.summary, 'Found 4 users. Nothing at offset 10.');
    assert.deepEqual(beyond.data.users, []);
  });

  it('refuses a limit above 100 and a name of only spaces without a request', async () => {
    const tools = await harness([]);
    const limit = await tools.call('find_users', { limit: 101 });
    const blank = await tools.call('find_users', { name: '   ' });
    await tools.done();

    assert.equal(limit.isError, true);
    assert.equal(blank.isError, true);
    assert.ok(findUsersTool.inputSchema.safeParse({ limit: 100 }).success);
  });

  it('reports an answer that is no list, without the profile read, and reads null as no users', async () => {
    const tools = await harness([
      loginRequest(),
      usersRequest({ status: 200, body: { data: [] } }),
      ...call({ status: 200, body: 'null' }),
    ]);
    const unexpected = await tools.call('find_users');
    const empty = await tools.call('find_users');
    await tools.done();

    assert.equal(unexpected.isError, true);
    assert.equal(unexpected.summary, USERS_UNEXPECTED_MESSAGE);
    assert.equal(USERS_UNEXPECTED_MESSAGE, 'alfaview sent an unexpected response for /v2/users.');
    assert.match(tools.logLines[1]!, /: InvalidResponse, 2 requests, /);
    assert.equal(empty.summary, 'Found no users.');
    assert.deepEqual(empty.data.users, []);
    assert.deepEqual(empty.data.warnings, []);
  });

  it('leaves out an entry without an ID', async () => {
    const users = [...fixture<Json[]>('users/users.json'), { emailAddress: 'no.id@example.com' }];
    const tools = await harness([loginRequest(), ...call({ status: 200, body: users })]);
    const result = await tools.call('find_users');
    await tools.done();

    assert.equal(result.data.totalMatches, 4);
  });

  it('gives the message of an error status of the list', async () => {
    const tools = await harness([
      loginRequest(),
      usersRequest({ status: 403, body: fixture('core/problem-403.json') }),
    ]);
    const result = await tools.call('find_users');
    await tools.done();

    assert.equal(result.isError, true);
    assert.match(result.summary, FORBIDDEN);
  });

  it('gives apiKeyUserId null and still a result when the profile read fails', async () => {
    const own = [fixture<Json[]>('users/users.json')[1]];
    const tools = await harness([
      loginRequest(),
      usersRequest({ status: 200, body: own }),
      profileRequest({ status: 500, body: fixture('core/problem-500.json') }),
      usersRequest({ status: 200, body: own }),
      profileRequest({ status: 200, body: {} }),
    ]);
    const failed = await tools.call('find_users');
    const unreadable = await tools.call('find_users');
    await tools.done();

    for (const result of [failed, unreadable]) {
      assert.equal(result.isError, false, result.summary);
      assert.equal(result.data.apiKeyUserId, null);
      assert.deepEqual(result.data.warnings, []);
      assert.equal(result.summary, 'Found 1 user. Showing 1 to 1.');
    }
  });

  it('ends the call when it is canceled during the profile read', async () => {
    const controller = new AbortController();
    const { api, fake } = testApi([loginRequest(), usersRequest(), profileRequest({ hang: true })], {
      signal: controller.signal,
    });
    const run = findUsersTool.run({ limit: 50, offset: 0 }, context(api, controller.signal));
    await untilRequests(fake, 3);
    controller.abort();
    const error = await toolErrorOf(run);
    fake.assertDone();

    assert.deepEqual([error.code, error.message], ['Canceled', CANCELED_MESSAGE]);
  });

  it("warns when alfaview lists only the API key's user, and not for another user or with a filter", async () => {
    const users = fixture<Json[]>('users/users.json');
    const own = [{ ...users[1], id: API_KEY_USER_ID.toUpperCase() }];
    const other = [users[2]];
    const tools = await harness([
      loginRequest(),
      ...call({ status: 200, body: own }),
      ...call({ status: 200, body: other }),
      ...call({ status: 200, body: own }),
    ]);
    const onlyOwn = await tools.call('find_users');
    const onlyOther = await tools.call('find_users');
    const filtered = await tools.call('find_users', { name: 'anna' });
    await tools.done();

    assert.equal(onlyOwn.summary, `Found 1 user. Showing 1 to 1. ${ONLY_API_KEY_USER_WARNING}`);
    assert.deepEqual(onlyOwn.data.warnings, [ONLY_API_KEY_USER_WARNING]);
    assert.equal(
      ONLY_API_KEY_USER_WARNING,
      "alfaview listed only the API key's user. The company has no other user, or the API key's user lacks the user permission List Users.",
    );
    assert.deepEqual(onlyOther.data.warnings, []);
    assert.deepEqual(filtered.data.warnings, []);
    assert.equal(filtered.summary, 'Found 1 user that matches. Showing 1 to 1.');
  });

  it('describes the values that Leave out removes in each mode', async () => {
    const descriptions: string[] = [];
    for (const personalData of ['include', 'omit'] as const) {
      const tools = await harness([], { personalData });
      const listed = await tools.client.listTools();
      await tools.done();
      descriptions.push(listed.tools[0]!.description ?? '');
    }

    assert.deepEqual(descriptions, [
      'Lists the users of the alfaview company by last name, with their IDs for the other tools. Filter by name or email address.',
      'Lists the users of the alfaview company by last name, with their IDs for the other tools. Filter by name or email address: the filters still match. This server leaves out personal data: names, titles and email addresses are null.',
    ]);
  });
});

describe('invite_user', () => {
  const EMAIL = 'nina.new@example.com';
  const INPUT = { emailAddress: EMAIL, firstName: 'Nina', lastName: 'New', sendEmail: true };
  const NO_PERMISSIONS = {
    manageCompany: false,
    userAdmin: false,
    userList: false,
    userShow: false,
    roomAdmin: false,
    roomList: false,
    roomCreate: false,
  };
  const NEW_USER = {
    id: NEW_USER_ID,
    emailAddress: EMAIL,
    firstName: 'Nina',
    lastName: 'New',
    city: 'Berlin',
    initials: 'NN',
    locale: 'en-US',
  };

  function harness(expected: readonly ExpectedRequest[], options: HarnessOptions = {}) {
    return toolHarness(FULL_USER_TOOLS, expected, options);
  }

  function inviteRequest(
    user: Json = { emailAddress: EMAIL, firstName: 'Nina', lastName: 'New' },
    permissions: Json = NO_PERMISSIONS,
    respond: FakeAnswer = { status: 202 },
  ): ExpectedRequest {
    return { method: 'POST', path: '/v2/users/invitation', body: { user, permissions }, respond };
  }

  function lookupRequest(respond: FakeAnswer = { status: 200, body: [NEW_USER] }): ExpectedRequest {
    return { method: 'GET', path: '/v2/users', query: { emailAddress: EMAIL }, respond };
  }

  it('refuses sendEmail false before any request', async () => {
    const tools = await harness([]);
    const result = await tools.call('invite_user', { ...INPUT, sendEmail: false });
    await tools.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, INVITE_EMAIL_MESSAGE);
    assert.equal(
      INVITE_EMAIL_MESSAGE,
      'alfaview always emails the invitation to the new user. Call invite_user again with sendEmail true to invite and send that email.',
    );
    assert.match(tools.logLines[0]!, /tool invite_user: InviteEmail, 0 requests, /);
  });

  it('refuses a call without sendEmail and a title of 21 characters in the schema', async () => {
    const tools = await harness([]);
    const { sendEmail: _sendEmail, ...withoutSendEmail } = INPUT;
    const missing = await tools.call('invite_user', withoutSendEmail);
    const long = await tools.call('invite_user', { ...INPUT, title: 'T'.repeat(21) });
    await tools.done();

    assert.equal(missing.isError, true);
    assert.match(missing.summary, /sendEmail/);
    assert.equal(long.isError, true);
    assert.match(long.summary, /title/);
    assert.ok(inviteUserTool.inputSchema.safeParse({ ...INPUT, title: 'T'.repeat(20) }).success);
  });

  it('reads the list, invites with every permission false by default, then looks the user up', async () => {
    const tools = await harness([loginRequest(), usersRequest(), inviteRequest(), lookupRequest()]);
    const result = await tools.call('invite_user', INPUT);
    await tools.done();

    assert.equal(
      result.summary,
      `Invited a new user without user permissions. alfaview emails the invitation. The new user has ID ${NEW_USER_ID}.`,
    );
    assert.deepEqual(result.data, {
      id: NEW_USER_ID,
      emailAddress: EMAIL,
      firstName: 'Nina',
      lastName: 'New',
      title: null,
      locale: 'en-US',
      invited: true,
      userPermissions: [],
      warnings: [],
    });
    assert.match(tools.logLines.at(-1)!, /: ok, 4 requests, /);
  });

  it('sends the given permissions, the title and the language', async () => {
    const given = { roomCreate: true, userList: true, roomAdmin: true };
    const tools = await harness([
      loginRequest(),
      usersRequest(),
      inviteRequest(
        { emailAddress: EMAIL, firstName: 'Nina', lastName: 'New', title: 'Dr.', locale: 'de-DE' },
        { ...NO_PERMISSIONS, ...given },
      ),
      lookupRequest(),
      usersRequest(),
      inviteRequest(undefined, { ...NO_PERMISSIONS, userShow: true }),
      lookupRequest(),
    ]);
    const several = await tools.call('invite_user', {
      ...INPUT,
      ...given,
      title: 'Dr.',
      locale: 'de-DE',
    });
    const one = await tools.call('invite_user', { ...INPUT, userShow: true });
    await tools.done();

    assert.equal(
      several.summary,
      `Invited a new user with the user permissions userList, roomAdmin and roomCreate. alfaview emails the invitation. The new user has ID ${NEW_USER_ID}.`,
    );
    assert.deepEqual(several.data.userPermissions, ['userList', 'roomAdmin', 'roomCreate']);
    assert.match(one.summary, /^Invited a new user with the user permission userShow\. /);
    assert.deepEqual(one.data.userPermissions, ['userShow']);
  });

  it('refuses an address that the list holds in another case and with spaces, before the invitation', async () => {
    const users = fixture<Json[]>('users/users.json');
    users[2]!.emailAddress = ' Nina.New@Example.com ';
    const tools = await harness([loginRequest(), usersRequest({ status: 200, body: users })]);
    const result = await tools.call('invite_user', { ...INPUT, emailAddress: 'NINA.NEW@example.com' });
    await tools.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, USER_EXISTS_MESSAGE);
    assert.match(tools.logLines.at(-1)!, /: UserExists, 2 requests, /);
  });

  it('reports a list answer that is no list before the invitation', async () => {
    const tools = await harness([loginRequest(), usersRequest({ status: 200, body: {} })]);
    const result = await tools.call('invite_user', INPUT);
    await tools.done();

    assert.equal(result.summary, USERS_UNEXPECTED_MESSAGE);
  });

  it('gives the detail of a 403, which names the permission that the API key\'s user lacks', async () => {
    const denied = {
      title: 'Forbidden',
      status: 403,
      detail: 'you are not allowed to assign permissions you do not have: ROOM_ADMIN',
    };
    const tools = await harness([
      loginRequest(),
      usersRequest(),
      inviteRequest(undefined, { ...NO_PERMISSIONS, roomAdmin: true }, { status: 403, body: denied }),
    ]);
    const result = await tools.call('invite_user', { ...INPUT, roomAdmin: true });
    await tools.done();

    assert.equal(result.isError, true);
    assert.match(result.summary, FORBIDDEN);
    assert.match(result.summary, /you are not allowed to assign permissions you do not have: ROOM_ADMIN/);
    assert.ok(result.summary.endsWith(` ${inviteUserTool.forbiddenHint}`), result.summary);
  });

  for (const status of [500, 502, 503, 504]) {
    it(`says that the invitation may be queued after HTTP ${status}, without a lookup`, async () => {
      const tools = await harness([
        loginRequest(),
        usersRequest(),
        inviteRequest(undefined, undefined, { status, body: fixture('core/problem-500.json') }),
      ]);
      const result = await tools.call('invite_user', INPUT);
      await tools.done();

      assert.equal(result.isError, true);
      assert.equal(result.summary, INVITE_UNCERTAIN_MESSAGE);
      assert.match(tools.logLines.at(-1)!, /: ServerError, 3 requests, /);
    });
  }

  it('says that the invitation may be queued after a timeout or a network error', async () => {
    const tools = await harness(
      [
        loginRequest(),
        usersRequest(),
        inviteRequest(undefined, undefined, { hang: true }),
        usersRequest(),
        inviteRequest(undefined, undefined, { networkError: 'ECONNRESET' }),
      ],
      { timeoutMs: 20 },
    );
    const timeout = await tools.call('invite_user', INPUT);
    const network = await tools.call('invite_user', INPUT);
    await tools.done();

    assert.equal(timeout.summary, INVITE_UNCERTAIN_MESSAGE);
    assert.equal(network.summary, INVITE_UNCERTAIN_MESSAGE);
    assert.match(tools.logLines[1]!, /: Timeout, /);
    assert.match(tools.logLines[2]!, /: NetworkError, /);
    assert.equal(
      INVITE_UNCERTAIN_MESSAGE,
      'alfaview may have accepted the invitation before the error. Check with find_users and emailAddress in a few minutes before you invite again: a second invitation sends a second email.',
    );
  });

  it('says that the invitation may be queued after a cancel', async () => {
    const controller = new AbortController();
    const { api, fake } = testApi(
      [loginRequest(), usersRequest(), inviteRequest(undefined, undefined, { hang: true })],
      { signal: controller.signal },
    );
    const input = inviteUserTool.inputSchema.parse(INPUT);
    const run = inviteUserTool.run(input, context(api, controller.signal));
    await untilRequests(fake, 3);
    controller.abort();
    const error = await toolErrorOf(run);
    fake.assertDone();

    assert.deepEqual([error.code, error.message], ['Canceled', INVITE_UNCERTAIN_MESSAGE]);
  });

  it('gives id null and a warning, never an error, when the lookup finds no user', async () => {
    const answers: FakeAnswer[] = [
      { status: 404, body: fixture('core/problem-404.json') },
      { status: 403, body: fixture('core/problem-403.json') },
      { status: 422, body: fixture('core/problem-422.json') },
      { status: 500, body: fixture('core/problem-500.json') },
      { status: 200, body: [] },
      { status: 200, body: {} },
      { status: 200, body: [{ ...NEW_USER, emailAddress: 'other@example.com' }] },
    ];
    const tools = await harness([
      loginRequest(),
      ...answers.flatMap((respond) => [usersRequest(), inviteRequest(), lookupRequest(respond)]),
    ]);
    const results = [];
    for (let index = 0; index < answers.length; index += 1) {
      results.push(await tools.call('invite_user', INPUT));
    }
    await tools.done();

    for (const result of results) {
      assert.equal(result.isError, false, result.summary);
      assert.equal(
        result.summary,
        `Invited a new user without user permissions. alfaview emails the invitation. ${INVITED_NOT_LISTED_WARNING}`,
      );
      assert.deepEqual(result.data, {
        id: null,
        emailAddress: EMAIL,
        firstName: 'Nina',
        lastName: 'New',
        title: null,
        locale: null,
        invited: true,
        userPermissions: [],
        warnings: [INVITED_NOT_LISTED_WARNING],
      });
    }
  });

  it('gives id null and a warning when the lookup is canceled', async () => {
    const controller = new AbortController();
    const { api, fake } = testApi(
      [loginRequest(), usersRequest(), inviteRequest(), lookupRequest({ hang: true })],
      { signal: controller.signal },
    );
    const run = inviteUserTool.run(inviteUserTool.inputSchema.parse(INPUT), context(api, controller.signal));
    await untilRequests(fake, 4);
    controller.abort();
    const output = outputOf(await run);
    fake.assertDone();

    assert.equal(output.data.id, null);
    assert.deepEqual(output.warnings, [INVITED_NOT_LISTED_WARNING]);
  });

  it('gives the field locations of a 422 of the invitation without the text of alfaview with Leave out', async () => {
    const problem = {
      title: 'Unprocessable Entity',
      status: 422,
      detail: `${EMAIL} is not valid`,
      errors: [{ message: `${EMAIL} is not valid`, location: 'body.user.emailAddress' }],
    };
    const tools = await harness(
      [loginRequest(), usersRequest(), inviteRequest(undefined, undefined, { status: 422, body: problem })],
      { personalData: 'omit' },
    );
    const result = await tools.call('invite_user', INPUT);
    await tools.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, inputErrorWithoutPersonalData(['body.user.emailAddress']));
    assert.ok(!result.summary.includes(EMAIL));
  });

  // The tool definition holds only what the model needs before the call: the text of sendEmail
  // names the email. The hint on the user permission comes with a 403, and the refusal of a user
  // that exists comes with its error.
  it('describes the email in sendEmail and the user permissions that it gives', async () => {
    const tools = await harness([]);
    const { tools: listed } = await tools.client.listTools();
    await tools.done();

    assert.equal(
      listed[0]!.description,
      'Changes who has access: invites a person to the alfaview company as a user, with the permissions that you give. An invitation cannot be taken back. Call it only when the user asked for it.',
    );
    const properties = listed[0]!.inputSchema.properties as Record<string, { description: string }>;
    assert.equal(properties.sendEmail!.description, 'Must be true: alfaview always emails the invitation.');
    assert.equal(
      inviteUserTool.forbiddenHint,
      "Inviting needs the user permission User Admin, and the API key's user can give only the user permissions that it has.",
    );
    assert.deepEqual((listed[0]!.inputSchema as { required?: string[] }).required, [
      'emailAddress',
      'firstName',
      'lastName',
      'sendEmail',
    ]);
  });
});

describe('delete_user', () => {
  const TARGET = {
    id: TARGET_USER_ID,
    emailAddress: 'leaving.user@example.com',
    firstName: 'Leaving',
    lastName: 'User',
    locale: 'de-DE',
  };
  const LIST = { status: 200, body: [...fixture<Json[]>('users/users.json'), TARGET] };
  const INPUT = { userId: TARGET_USER_ID, confirmEmailAddress: 'leaving.user@example.com' };

  function harness(expected: readonly ExpectedRequest[], options: HarnessOptions = {}) {
    return toolHarness(FULL_USER_TOOLS, expected, options);
  }

  const deleteRequest = (respond: FakeAnswer = { status: 204 }): ExpectedRequest => ({
    method: 'DELETE',
    path: `/v2/users/${TARGET_USER_ID}`,
    respond,
  });

  it('reads the API key\'s user and the list, then deletes the user with the address of a client that cannot ask', async () => {
    const tools = await harness([
      loginRequest(),
      profileRequest(profileOf(OWN_USER_ID)),
      usersRequest(LIST),
      deleteRequest(),
    ]);
    const result = await tools.call('delete_user', INPUT);
    await tools.done();

    assert.equal(
      result.summary,
      `Deleted user ${TARGET_USER_ID}. The user can no longer sign in, and access can last up to one hour.`,
    );
    assert.deepEqual(result.data, {
      userId: TARGET_USER_ID,
      deleted: true,
      confirmation: 'parameter',
      warnings: [],
    });
    assert.match(tools.logLines.at(-1)!, /: ok, confirmed by the parameter, 4 requests, /);
  });

  it('sends an uppercase userId in lowercase, and matches the address in another case and with spaces', async () => {
    const list = { status: 200, body: [{ ...TARGET, emailAddress: ' Leaving.User@Example.com ' }] };
    const tools = await harness([
      loginRequest(),
      profileRequest(profileOf(OWN_USER_ID)),
      usersRequest(list),
      deleteRequest(),
    ]);
    const result = await tools.call('delete_user', {
      userId: ` ${TARGET_USER_ID.toUpperCase()} `,
      confirmEmailAddress: ' LEAVING.user@example.com ',
    });
    await tools.done();

    assert.equal(result.isError, false, result.summary);
    assert.equal(result.data.userId, TARGET_USER_ID);
  });

  it('takes a user ID of version 4, and refuses every other ID before any request', async () => {
    const oldUserId = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';
    const refused = [
      'c0ffee00-0000-5000-8000-140000000001',
      'c0ffee00-0000-5000-8000-150000000001',
      'c0ffee00-0000-5000-8000-180000000001',
      '11111111-1111-1111-1111-111111111111',
      '0b7c5d2e-91a4-5f3b-8e27-0f4a6c9d1e22',
    ];
    const tools = await harness([
      loginRequest(),
      profileRequest(profileOf(OWN_USER_ID)),
      usersRequest({ status: 200, body: [{ ...TARGET, id: oldUserId }] }),
      { method: 'DELETE', path: `/v2/users/${oldUserId}`, respond: { status: 204 } },
    ]);
    const results = [];
    for (const userId of refused) {
      results.push(await tools.call('delete_user', { ...INPUT, userId }));
    }
    const old = await tools.call('delete_user', { ...INPUT, userId: oldUserId });
    await tools.done();

    for (const result of results) {
      assert.equal(result.isError, true);
      assert.equal(result.summary, NOT_A_USER_ID_MESSAGE);
    }
    assert.match(tools.logLines[0]!, /: InvalidInput, 0 requests, /);
    assert.equal(old.isError, false, old.summary);
  });

  it('refuses a name in place of the ID with the message that names find_users', async () => {
    const tools = await harness([]);
    const result = await tools.call('delete_user', { ...INPUT, userId: 'Leaving User' });
    await tools.done();

    assert.equal(result.isError, true);
    assert.match(result.summary, new RegExp(USER_ID_MESSAGE));
  });

  it("refuses the API key's user, in another case, after the profile read and before the list", async () => {
    const tools = await harness([loginRequest(), profileRequest(profileOf(TARGET_USER_ID))]);
    const result = await tools.call('delete_user', { ...INPUT, userId: TARGET_USER_ID.toUpperCase() });
    await tools.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, selfDeleteMessage(TARGET_USER_ID));
    assert.equal(
      result.summary,
      `User ${TARGET_USER_ID} is the API key's user. Deleting it would also delete the API key of this server, so this tool refuses. Do it in alfaview.`,
    );
    assert.match(tools.logLines.at(-1)!, /: OwnUserRefused, 2 requests, /);
  });

  it('ends the call when the profile read fails', async () => {
    const tools = await harness([
      loginRequest(),
      profileRequest({ status: 500, body: fixture('core/problem-500.json') }),
      profileRequest({ status: 200, body: {} }),
    ]);
    const failed = await tools.call('delete_user', INPUT);
    const unreadable = await tools.call('delete_user', INPUT);
    await tools.done();

    assert.equal(failed.isError, true);
    assert.match(tools.logLines[1]!, /: ServerError, 2 requests, /);
    assert.equal(unreadable.summary, PROFILE_NOT_RETURNED_MESSAGE);
  });

  it('reports a user that the list does not hold, without a delete', async () => {
    const tools = await harness([
      loginRequest(),
      profileRequest(profileOf(OWN_USER_ID)),
      usersRequest(),
    ]);
    const result = await tools.call('delete_user', INPUT);
    await tools.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, userNotListedMessage(TARGET_USER_ID));
    assert.equal(
      result.summary,
      `alfaview does not list a user ${TARGET_USER_ID} in this company, so nothing was deleted. The user is already deleted, or the API key's user lacks the user permission User Admin. Find the ID with find_users.`,
    );
    assert.match(tools.logLines.at(-1)!, /: NotFound, 3 requests, /);
  });

  it('refuses a wrong confirmEmailAddress, a part of the address and a user without an address, without a delete', async () => {
    // The last call reads a user without an address, which the tool refuses before the fallback.
    const withoutAddress = { status: 200, body: [{ ...TARGET, emailAddress: undefined }] };
    const tools = await harness([
      loginRequest(),
      profileRequest(profileOf(OWN_USER_ID)),
      usersRequest(LIST),
      profileRequest(profileOf(OWN_USER_ID)),
      usersRequest(LIST),
      profileRequest(profileOf(OWN_USER_ID)),
      usersRequest(LIST),
      profileRequest(profileOf(OWN_USER_ID)),
      usersRequest(withoutAddress),
    ]);
    const wrong = await tools.call('delete_user', { ...INPUT, confirmEmailAddress: 'other@example.com' });
    // Only the whole address confirms the delete.
    const domain = await tools.call('delete_user', { ...INPUT, confirmEmailAddress: 'example.com' });
    const prefix = await tools.call('delete_user', {
      ...INPUT,
      confirmEmailAddress: 'leaving.user@example',
    });
    const missing = await tools.call('delete_user', INPUT);
    await tools.done();

    for (const result of [wrong, domain, prefix]) {
      assert.equal(result.isError, true);
      assert.equal(result.summary, confirmEmailMessage(TARGET_USER_ID));
      assert.ok(!result.summary.includes('leaving.user@example.com'));
    }
    // Nothing can confirm a user without an address.
    assert.equal(missing.isError, true);
    assert.equal(missing.summary, userWithoutAddressMessage(TARGET_USER_ID));
    assert.equal(
      wrong.summary,
      `confirmEmailAddress is not the email address of user ${TARGET_USER_ID}, so nothing was deleted. Check with find_users that this is the user to delete.`,
    );
    assert.match(tools.logLines[1]!, /: ConfirmationMismatch, 3 requests, /);
  });

  // The description does not name the permission, so the 403 does.
  it('gives the message of a 403 of the delete with the permission that it needs', async () => {
    const tools = await harness([
      loginRequest(),
      profileRequest(profileOf(OWN_USER_ID)),
      usersRequest(LIST),
      deleteRequest({ status: 403, body: fixture('core/problem-403.json') }),
    ]);
    const result = await tools.call('delete_user', INPUT);
    await tools.done();

    assert.equal(result.isError, true);
    assert.match(result.summary, FORBIDDEN);
    assert.match(result.summary, / Deleting a user needs the user permission User Admin\.$/);
  });

  // The delete of a user keeps the rooms and the room permissions of the user. The server asks
  // the person, and confirmEmailAddress is the optional fallback of a client that cannot ask.
  it('says what stays and that the server asks, and leaves the refusal of the own user to its error', async () => {
    const tools = await harness([]);
    const { tools: listed } = await tools.client.listTools();
    await tools.done();

    const tool = listed.find((entry) => entry.name === 'delete_user')!;
    assert.equal(
      tool.description,
      'Cannot be undone: deletes a user of the alfaview company. The user can no longer sign in, also not with an API key, and access can last up to one hour. Rooms and room permissions of the user stay. The server asks the person to confirm.',
    );
    assert.deepEqual((tool.inputSchema as { required?: string[] }).required, ['userId']);
  });

  it('describes confirmEmailAddress for each mode, and changes nothing else', async () => {
    const schemas = [];
    const descriptions = [];
    for (const personalData of ['include', 'omit'] as const) {
      const tools = await harness([], { personalData });
      const { tools: listed } = await tools.client.listTools();
      await tools.done();
      const tool = listed.find((entry) => entry.name === 'delete_user')!;
      schemas.push(tool.inputSchema as { properties: Record<string, { description?: string }> });
      descriptions.push(tool.description);
    }
    const [include, omit] = schemas;

    assert.equal(include!.properties.confirmEmailAddress!.description, CONFIRM_EMAIL_TEXT);
    assert.equal(omit!.properties.confirmEmailAddress!.description, CONFIRM_EMAIL_TEXT_WITHOUT_PERSONAL_DATA);
    assert.equal(
      CONFIRM_EMAIL_TEXT,
      'Only for a client that cannot ask the person: the email address, as the person named it (any case).',
    );
    assert.equal(
      CONFIRM_EMAIL_TEXT_WITHOUT_PERSONAL_DATA,
      'Only for a client that cannot ask the person: the email address, as the person named it (any case). Results leave it out.',
    );
    delete include!.properties.confirmEmailAddress!.description;
    delete omit!.properties.confirmEmailAddress!.description;
    assert.deepEqual(omit, include);
    assert.equal(descriptions[1], descriptions[0]);
    assert.equal(deleteUserTool.descriptionWithoutPersonalData, undefined);
  });
});
