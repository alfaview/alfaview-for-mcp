// get_account and update_own_user through an MCP SDK client.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CANCELED_MESSAGE } from '../../src/alfaview/client.ts';
import {
  companyNotReadWarning,
  PROFILE_NOT_RETURNED_MESSAGE,
  PROFILE_SAVED_BUT_NOT_READ_MESSAGE,
} from '../../src/domain/account.ts';
import { createLogger } from '../../src/log.ts';
import { ACCOUNT_TOOLS, getAccountTool, updateOwnUserTool } from '../../src/tools/account.ts';
import { IDEMPOTENT_CHANGE_ANNOTATIONS, READ_ANNOTATIONS } from '../../src/tools/tool.ts';
import {
  loginRequest,
  testApi,
  toolErrorOf,
  untilRequests,
  type ExpectedRequest,
  type FakeAnswer,
} from '../helpers/fakeFetch.ts';
import { fixture } from '../helpers/fixtures.ts';
import { toolHarness } from '../helpers/mcpClient.ts';
import { noQuestions } from '../helpers/toolContext.ts';

const USER_ID = '6c1d9e4f-2a7b-5c3d-9e8f-0a1b2c3d4e5f';

type Json = Record<string, unknown>;

const profile = (overrides: Json = {}): Json => ({
  ...fixture<Json>('core/user-profile.json'),
  ...overrides,
});

function profileRequest(respond: FakeAnswer, token?: string): ExpectedRequest {
  return { method: 'GET', path: '/v2/users/me', respond, ...(token === undefined ? {} : { token }) };
}

function companyRequest(respond: FakeAnswer, token?: string): ExpectedRequest {
  return {
    method: 'GET',
    path: '/v2/users/me/company',
    respond,
    ...(token === undefined ? {} : { token }),
  };
}

const PROFILE_OUTPUT = {
  id: USER_ID,
  emailAddress: 'zapier.integration@example.com',
  firstName: 'Zapier',
  lastName: 'Integration',
  title: null,
  city: 'Berlin',
  initials: 'ZI',
  locale: 'en-US',
};

describe('the account tools', () => {
  it('are listed in their fixed order, at the level manage, with their annotations', async () => {
    const harness = await toolHarness(ACCOUNT_TOOLS, []);
    const { tools } = await harness.client.listTools();
    await harness.done();

    assert.deepEqual(
      tools.map((tool) => [tool.name, tool.title, tool.annotations]),
      [
        ['get_account', 'Get the account', READ_ANNOTATIONS],
        ['update_own_user', 'Update your own profile', IDEMPOTENT_CHANGE_ANNOTATIONS],
      ],
    );
    assert.deepEqual(
      ACCOUNT_TOOLS.map((tool) => tool.level),
      ['manage', 'manage'],
    );
  });
});

describe('get_account', () => {
  it('returns the profile and the company of the API key', async () => {
    const harness = await toolHarness(ACCOUNT_TOOLS, [
      loginRequest(),
      profileRequest({ status: 200, body: profile() }),
      companyRequest({ status: 200, body: fixture('core/own-company.json') }),
    ]);
    const result = await harness.call('get_account');
    await harness.done();

    assert.equal(result.summary, `The API key belongs to user ${USER_ID} in company company-1.`);
    assert.deepEqual(result.data, {
      user: PROFILE_OUTPUT,
      company: { id: 'company-1', displayName: 'Example Training GmbH' },
      warnings: [],
    });
  });

  // alfaview answers `unknown` for a user without a language (spec: UserProfile, `locale`).
  it('gives a null locale for a profile whose language alfaview answers as unknown', async () => {
    const harness = await toolHarness(ACCOUNT_TOOLS, [
      loginRequest(),
      profileRequest({ status: 200, body: profile({ locale: 'unknown' }) }),
      companyRequest({ status: 200, body: fixture('core/own-company.json') }),
    ]);
    const result = await harness.call('get_account');
    await harness.done();

    assert.deepEqual(result.data.user, { ...PROFILE_OUTPUT, locale: null });
  });

  it('says unknown for a company without its ID', async () => {
    const harness = await toolHarness(ACCOUNT_TOOLS, [
      loginRequest(),
      profileRequest({ status: 200, body: profile() }),
      companyRequest({ status: 200, body: { displayName: 'Example Training GmbH' } }),
    ]);
    const result = await harness.call('get_account');
    await harness.done();

    assert.equal(result.summary, `The API key belongs to user ${USER_ID} in company unknown.`);
    assert.deepEqual(result.data.company, { id: null, displayName: 'Example Training GmbH' });
  });

  it('reports a profile answer that is not an object or has no ID, without the company read', async () => {
    const harness = await toolHarness(ACCOUNT_TOOLS, [
      loginRequest(),
      profileRequest({ status: 200, body: 'null' }),
      profileRequest({ status: 200, body: profile({ id: undefined }) }),
      profileRequest({ status: 200, body: profile({ id: 7 }) }),
    ]);
    const results = [
      await harness.call('get_account'),
      await harness.call('get_account'),
      await harness.call('get_account'),
    ];
    await harness.done();

    for (const result of results) {
      assert.equal(result.isError, true);
      assert.equal(result.summary, PROFILE_NOT_RETURNED_MESSAGE);
    }
    assert.match(harness.logLines.at(-1)!, /: InvalidResponse, /);
  });

  it('gives company null and a warning with the code when the company read fails', async () => {
    const harness = await toolHarness(ACCOUNT_TOOLS, [
      loginRequest(),
      profileRequest({ status: 200, body: profile() }),
      companyRequest({ status: 500, body: fixture('core/problem-500.json') }),
      profileRequest({ status: 200, body: profile() }),
      companyRequest({ status: 403, body: fixture('core/problem-403.json') }),
      profileRequest({ status: 200, body: profile() }),
      companyRequest({ networkError: 'ECONNRESET' }),
      profileRequest({ status: 200, body: profile() }),
      companyRequest({ status: 200, body: [] }),
    ]);
    const results = [];
    for (let index = 0; index < 4; index += 1) results.push(await harness.call('get_account'));
    await harness.done();

    const codes = ['ServerError', 'Forbidden', 'NetworkError', 'InvalidResponse'];
    results.forEach((result, index) => {
      const warning = companyNotReadWarning(codes[index]!);
      assert.equal(result.isError, false);
      assert.equal(result.summary, `The API key belongs to user ${USER_ID}. ${warning}`);
      assert.deepEqual(result.data, { user: PROFILE_OUTPUT, company: null, warnings: [warning] });
    });
    assert.equal(
      companyNotReadWarning('ServerError'),
      'alfaview did not return the company (ServerError), so company is null.',
    );
  });

  it('ends the call when it is canceled during the company read', async () => {
    const controller = new AbortController();
    const { api, fake } = testApi(
      [loginRequest(), profileRequest({ status: 200, body: profile() }), companyRequest({ hang: true })],
      { signal: controller.signal },
    );
    const run = getAccountTool.run(
      {},
      {
        api,
        now: Date.parse('2026-10-07T08:00:00Z'),
        timeZone: 'Europe/Berlin',
        signal: controller.signal,
        log: createLogger(() => undefined),
        personalData: 'include',
        level: 'manage',
        confirmation: noQuestions(),
      },
    );
    await untilRequests(fake, 3);
    controller.abort();
    const error = await toolErrorOf(run);
    fake.assertDone();

    assert.deepEqual([error.code, error.message], ['Canceled', CANCELED_MESSAGE]);
  });

  it('logs in again once and repeats the profile read after a 401', async () => {
    const harness = await toolHarness(ACCOUNT_TOOLS, [
      loginRequest(),
      profileRequest({ status: 401, body: fixture('core/problem-401.json') }),
      loginRequest('token-2'),
      profileRequest({ status: 200, body: profile() }, 'token-2'),
      companyRequest({ status: 200, body: fixture('core/own-company.json') }, 'token-2'),
    ]);
    const result = await harness.call('get_account');
    await harness.done();

    assert.equal(result.isError, false);
    assert.equal(result.data.user.id, USER_ID);
    assert.match(harness.logLines.at(-1)!, /tool get_account: ok, 5 requests, /);
  });

  it('describes the values that Leave out removes in each mode', async () => {
    const descriptions: string[] = [];
    for (const personalData of ['include', 'omit'] as const) {
      const harness = await toolHarness(ACCOUNT_TOOLS, [], { personalData });
      const { tools } = await harness.client.listTools();
      await harness.done();
      descriptions.push(tools[0]!.description ?? '');
    }

    assert.deepEqual(descriptions, [
      "Returns the alfaview user and company of the API key: the user's ID, name, email address, title, city, initials and language, and the company's ID and name. Use it to check the account of this server.",
      "Returns the alfaview user and company of the API key: the user's ID and language, and the company's ID and name. Use it to check the account of this server. This server leaves out personal data: the user's name, email address, title, city and initials are null.",
    ]);
  });
});

describe('update_own_user', () => {
  const patch = (body: Json, respond: FakeAnswer = { status: 204 }): ExpectedRequest => ({
    method: 'PATCH',
    path: '/v2/users',
    body,
    respond,
  });

  const ALL = {
    firstName: 'Anna',
    lastName: 'Example',
    title: 'Dr.',
    city: 'Hamburg',
    initials: 'AE',
    locale: 'de-DE',
  };

  it('sends only the given field, then reads the profile back', async () => {
    const fields = Object.entries(ALL);
    const harness = await toolHarness(ACCOUNT_TOOLS, [
      loginRequest(),
      ...fields.flatMap(([key, value]) => [
        patch({ [key]: value }),
        profileRequest({ status: 200, body: profile({ [key]: value }) }),
      ]),
    ]);
    const results = [];
    for (const [key, value] of fields) {
      results.push(await harness.call('update_own_user', { [key]: value }));
    }
    await harness.done();

    results.forEach((result, index) => {
      const [key, value] = fields[index]!;
      assert.equal(result.summary, `Updated the profile of user ${USER_ID}.`);
      assert.deepEqual(result.data, { ...PROFILE_OUTPUT, [key]: value, warnings: [] });
    });
  });

  it('sends all six fields trimmed, in one request', async () => {
    const harness = await toolHarness(ACCOUNT_TOOLS, [
      loginRequest(),
      patch(ALL),
      profileRequest({ status: 200, body: profile(ALL) }),
    ]);
    const result = await harness.call('update_own_user', { ...ALL, firstName: ' Anna ' });
    await harness.done();

    assert.equal(result.summary, `Updated the profile of user ${USER_ID}.`);
    assert.deepEqual(result.data, {
      id: USER_ID,
      emailAddress: 'zapier.integration@example.com',
      ...ALL,
      warnings: [],
    });
  });

  it('refuses a call without a field, a long title or initials, and blank text, without a request', async () => {
    const harness = await toolHarness(ACCOUNT_TOOLS, []);
    const none = await harness.call('update_own_user', {});
    const refused = [
      await harness.call('update_own_user', { title: 'T'.repeat(21) }),
      await harness.call('update_own_user', { initials: 'ABCD' }),
      await harness.call('update_own_user', { firstName: '   ' }),
      await harness.call('update_own_user', { locale: 'fr-FR' }),
      await harness.call('update_own_user', { initials: '' }),
    ];
    await harness.done();

    assert.equal(none.isError, true);
    assert.equal(none.summary, 'Give at least one field to change.');
    for (const result of refused) assert.equal(result.isError, true, result.summary);
    const schema = updateOwnUserTool.inputSchema;
    assert.ok(schema.safeParse({ title: 'T'.repeat(20), initials: 'ABC' }).success);
  });

  it('gives the text of a refused change', async () => {
    const harness = await toolHarness(ACCOUNT_TOOLS, [
      loginRequest(),
      patch({ firstName: 'Anna' }, { status: 422, body: { title: 'Unprocessable Entity', detail: 'ACTION_INVALID' } }),
      patch({ firstName: 'Anna' }, { status: 403, body: fixture('core/problem-403.json') }),
    ]);
    const invalid = await harness.call('update_own_user', { firstName: 'Anna' });
    const forbidden = await harness.call('update_own_user', { firstName: 'Anna' });
    await harness.done();

    assert.equal(invalid.summary, 'alfaview could not process the input: ACTION_INVALID.');
    assert.match(forbidden.summary, /^The API key's user is not allowed to do this/);
  });

  it('says that the change is saved when reading the profile back fails', async () => {
    const harness = await toolHarness(ACCOUNT_TOOLS, [
      loginRequest(),
      patch({ city: 'Hamburg' }),
      profileRequest({ status: 503, body: fixture('core/problem-500.json') }),
      patch({ city: 'Hamburg' }),
      profileRequest({ status: 200, body: {} }),
    ]);
    const failed = await harness.call('update_own_user', { city: 'Hamburg' });
    const unreadable = await harness.call('update_own_user', { city: 'Hamburg' });
    await harness.done();

    assert.equal(failed.summary, PROFILE_SAVED_BUT_NOT_READ_MESSAGE);
    assert.match(harness.logLines[1]!, /: ServerError, /);
    assert.equal(unreadable.summary, PROFILE_SAVED_BUT_NOT_READ_MESSAGE);
    assert.match(harness.logLines[2]!, /: InvalidResponse, /);
  });
});
