import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  ConfigError,
  PRODUCTION_BASE_URL,
  readConfig,
  REPLACED_TOOLS,
  type ToolLevel,
} from '../src/config.ts';

/** A tool list with tools at each level, so that the tests do not depend on the server's tools. */
const TOOLS: readonly ToolLevel[] = [
  { name: 'find_rooms', level: 'read' },
  { name: 'get_room', level: 'read' },
  { name: 'create_guest_links', level: 'standard' },
  { name: 'create_room', level: 'manage' },
  { name: 'delete_room', level: 'full' },
];
const STANDARD_TOOLS = ['find_rooms', 'get_room', 'create_guest_links'];
const ALL_TOOLS =
  'find_rooms (read), get_room (read), create_guest_links (standard), create_room (manage), delete_room (full)';

const VALID_ENV = {
  ALFAVIEW_COMPANY_ID: 'company-1',
  ALFAVIEW_CLIENT_ID: 'mcp-test',
  ALFAVIEW_API_KEY: 'secret-key-1',
};

const MISSING_ALL =
  'Missing configuration: ALFAVIEW_COMPANY_ID, ALFAVIEW_CLIENT_ID, ALFAVIEW_API_KEY. Set them in the env block of the alfaview server entry of your MCP client (README.md of the package, Configuration).';
const BASE_URL_PROBLEM = 'ALFAVIEW_API_BASE_URL must be empty or https://apis.alfaview.com.';
const TLS_PROBLEM =
  'NODE_TLS_REJECT_UNAUTHORIZED is 0, which turns off the certificate check of HTTPS. The server does not send the API key without that check. Remove the variable from the environment of the MCP client.';
const TIME_ZONE_PROBLEM =
  'ALFAVIEW_TIME_ZONE is not a valid time zone. Use an IANA name such as America/New_York, or leave it empty for Europe/Berlin.';
/** The problem that readPersonalDataMode reports, with the variable's name. */
const PERSONAL_DATA_PROBLEM =
  'ALFAVIEW_PERSONAL_DATA must be include or omit, or empty for include.';
const LEVEL_PROBLEM =
  'ALFAVIEW_ACCESS_LEVEL must be read, standard, manage or full. Leave it empty for standard.';
const FULL_PROBLEM =
  'ALFAVIEW_ACCESS_LEVEL is full, which can delete rooms and users for good and change who has access to rooms. To allow it, set ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS to the company ID of this server entry.';
const MISMATCH_PROBLEM =
  'ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS does not match ALFAVIEW_COMPANY_ID. Set it to the company ID of this server entry.';
const CONFIRMATION_PROBLEM =
  'ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS is set, but ALFAVIEW_ACCESS_LEVEL is not full. Remove the variable from this server entry and from the shell environment of the MCP client.';

/** The variables of an entry at the level `full` for the company of VALID_ENV. */
const FULL_ENV = {
  ...VALID_ENV,
  ALFAVIEW_ACCESS_LEVEL: 'full',
  ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS: 'company-1',
};

/** Returns the problems of a configuration that readConfig refuses. */
function problemsOf(env: Record<string, string | undefined>): readonly string[] {
  try {
    readConfig(env, TOOLS);
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.message, error.problems.join('\n'));
    return error.problems;
  }
  throw new Error('Expected readConfig to throw.');
}

describe('readConfig', () => {
  it('reads a valid configuration with the defaults', () => {
    assert.deepEqual(readConfig(VALID_ENV, TOOLS), {
      companyId: 'company-1',
      clientId: 'mcp-test',
      apiKey: 'secret-key-1',
      baseUrl: 'https://apis.alfaview.com',
      level: 'standard',
      tools: STANDARD_TOOLS,
      timeZone: 'Europe/Berlin',
      personalData: 'include',
    });
    assert.equal(PRODUCTION_BASE_URL, 'https://apis.alfaview.com');
  });

  it('trims every value', () => {
    const config = readConfig(
      {
        ALFAVIEW_COMPANY_ID: ' company-1 ',
        ALFAVIEW_CLIENT_ID: '\tmcp-test\n',
        ALFAVIEW_API_KEY: '  secret-key-1',
        ALFAVIEW_API_BASE_URL: ' https://apis.alfaview.com/v2 ',
        ALFAVIEW_ACCESS_LEVEL: ' full\t',
        ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS: ' company-1\n',
        ALFAVIEW_TOOLS: ' get_room ',
        ALFAVIEW_TIME_ZONE: ' America/New_York\n',
        ALFAVIEW_PERSONAL_DATA: ' omit\n',
      },
      TOOLS,
    );
    assert.deepEqual(config, {
      companyId: 'company-1',
      clientId: 'mcp-test',
      apiKey: 'secret-key-1',
      baseUrl: 'https://apis.alfaview.com',
      level: 'full',
      tools: ['get_room'],
      timeZone: 'America/New_York',
      personalData: 'omit',
    });
  });

  for (const name of ['ALFAVIEW_COMPANY_ID', 'ALFAVIEW_CLIENT_ID', 'ALFAVIEW_API_KEY'] as const) {
    it(`names ${name} when it is missing, empty or only whitespace`, () => {
      for (const value of [undefined, '', '   ']) {
        assert.deepEqual(problemsOf({ ...VALID_ENV, [name]: value }), [
          `Missing configuration: ${name}. Set them in the env block of the alfaview server entry of your MCP client (README.md of the package, Configuration).`,
        ]);
      }
    });
  }

  it('names every missing variable in the order of the documentation', () => {
    assert.deepEqual(problemsOf({}), [MISSING_ALL]);
    assert.deepEqual(problemsOf({ ALFAVIEW_CLIENT_ID: 'mcp-test' }), [
      'Missing configuration: ALFAVIEW_COMPANY_ID, ALFAVIEW_API_KEY. Set them in the env block of the alfaview server entry of your MCP client (README.md of the package, Configuration).',
    ]);
  });

  // The npm package and its copy on GitHub have the README at their root.
  it('points to a section of the README of the package that exists', () => {
    const [problem] = problemsOf({});
    const section = /\(README\.md of the package, ([^)]+)\)\.$/.exec(problem ?? '')?.[1];
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    assert.equal(section, 'Configuration');
    assert.match(readme, new RegExp(`^## ${section}$`, 'm'));
  });

  describe('ALFAVIEW_API_BASE_URL', () => {
    const baseUrl = (value: string | undefined) =>
      readConfig({ ...VALID_ENV, ALFAVIEW_API_BASE_URL: value }, TOOLS).baseUrl;

    it('defaults to production when unset or empty', () => {
      assert.equal(baseUrl(undefined), 'https://apis.alfaview.com');
      assert.equal(baseUrl(''), 'https://apis.alfaview.com');
      assert.equal(baseUrl('   '), 'https://apis.alfaview.com');
    });

    it('accepts production and drops any path', () => {
      assert.equal(baseUrl('https://apis.alfaview.com'), 'https://apis.alfaview.com');
      assert.equal(baseUrl('https://apis.alfaview.com/v2/'), 'https://apis.alfaview.com');
    });

    // The server takes only the production host.
    for (const [name, value] of [
      ['another alfaview host', 'https://app.alfaview.com'],
      ['plain http', 'http://apis.alfaview.com'],
      ['an unknown host', 'https://apis.example.com'],
      ['a look-alike host', 'https://apis.alfaview.com.example.com'],
      // Built at run time, so that the source names no made-up alfaview host.
      ['a subdomain of an allowed host', `https://evil.${new URL(PRODUCTION_BASE_URL).hostname}`],
      ['a port', 'https://apis.alfaview.com:8443'],
      ['a user', 'https://user@apis.alfaview.com'],
      ['a user and a password', 'https://user:pass@apis.alfaview.com'],
      ['a value that is not a URL', 'apis.alfaview.com'],
    ] as const) {
      it(`refuses ${name} without printing the value`, () => {
        const problems = problemsOf({ ...VALID_ENV, ALFAVIEW_API_BASE_URL: value });
        assert.deepEqual(problems, [BASE_URL_PROBLEM]);
      });
    }
  });

  // The confirmation holds the company ID, so that an entry copied for another company does not
  // unlock `full` there.
  describe('ALFAVIEW_ACCESS_LEVEL and ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS', () => {
    const configOf = (env: Record<string, string | undefined>) =>
      readConfig({ ...VALID_ENV, ...env }, TOOLS);

    it('gives standard with its tools when the level is unset, empty or only whitespace', () => {
      for (const value of [undefined, '', '  ']) {
        const config = configOf({ ALFAVIEW_ACCESS_LEVEL: value });
        assert.equal(config.level, 'standard');
        assert.deepEqual(config.tools, STANDARD_TOOLS);
      }
    });

    it('gives each level the tools of its level and of the levels before it', () => {
      const toolsAt = (level: string) => configOf({ ALFAVIEW_ACCESS_LEVEL: level }).tools;
      assert.deepEqual(toolsAt('read'), ['find_rooms', 'get_room']);
      assert.deepEqual(toolsAt('standard'), STANDARD_TOOLS);
      assert.deepEqual(toolsAt('manage'), [...STANDARD_TOOLS, 'create_room']);
      assert.deepEqual(readConfig(FULL_ENV, TOOLS).tools, [
        ...STANDARD_TOOLS,
        'create_room',
        'delete_room',
      ]);
      assert.equal(readConfig(FULL_ENV, TOOLS).level, 'full');
    });

    for (const value of ['Full', 'STANDARD', 'admin', 'all', 'read,standard']) {
      it(`refuses the level ${JSON.stringify(value)} and never names it`, () => {
        assert.deepEqual(problemsOf({ ...VALID_ENV, ALFAVIEW_ACCESS_LEVEL: value }), [LEVEL_PROBLEM]);
      });
    }

    it('refuses full without the confirmation, also when it is only whitespace', () => {
      for (const value of [undefined, '', '   ']) {
        const env = { ...FULL_ENV, ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS: value };
        assert.deepEqual(problemsOf(env), [FULL_PROBLEM]);
      }
    });

    it('takes the company ID as the confirmation in any case', () => {
      const config = readConfig(
        { ...FULL_ENV, ALFAVIEW_COMPANY_ID: 'Company-1', ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS: 'COMPANY-1' },
        TOOLS,
      );
      assert.equal(config.level, 'full');
    });

    it('refuses full with a confirmation of another company, and never names either value', () => {
      for (const value of ['company-2', 'true', '1', 'yes']) {
        const env = { ...FULL_ENV, ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS: value };
        assert.deepEqual(problemsOf(env), [MISMATCH_PROBLEM]);
      }
    });

    it('refuses full when the company ID is missing, with both problems', () => {
      const env = { ...FULL_ENV, ALFAVIEW_COMPANY_ID: undefined };
      assert.deepEqual(problemsOf(env), [
        'Missing configuration: ALFAVIEW_COMPANY_ID. Set them in the env block of the alfaview server entry of your MCP client (README.md of the package, Configuration).',
        MISMATCH_PROBLEM,
      ]);
    });

    // A shell that exports the variable gives it to each entry of the MCP client. A leftover
    // confirmation would unlock `full` later with a change of the level alone.
    it('refuses the confirmation at every level other than full, also at the default level', () => {
      for (const level of [undefined, 'read', 'standard', 'manage']) {
        const env = {
          ...VALID_ENV,
          ALFAVIEW_ACCESS_LEVEL: level,
          ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS: 'company-1',
        };
        assert.deepEqual(problemsOf(env), [CONFIRMATION_PROBLEM], String(level));
      }
    });

    it('checks no confirmation against a level that it does not know', () => {
      const env = { ...FULL_ENV, ALFAVIEW_ACCESS_LEVEL: 'FULL' };
      assert.deepEqual(problemsOf(env), [LEVEL_PROBLEM]);
    });
  });

  describe('ALFAVIEW_TOOLS', () => {
    const tools = (value: string | undefined, env: Record<string, string> = VALID_ENV) =>
      readConfig({ ...env, ALFAVIEW_TOOLS: value }, TOOLS).tools;

    it('gives every tool of the level when unset or empty', () => {
      assert.deepEqual(tools(undefined), STANDARD_TOOLS);
      assert.deepEqual(tools(''), STANDARD_TOOLS);
      assert.deepEqual(tools('  '), STANDARD_TOOLS);
      assert.deepEqual(tools(undefined, { ...VALID_ENV, ALFAVIEW_ACCESS_LEVEL: 'read' }), [
        'find_rooms',
        'get_room',
      ]);
    });

    it('keeps the order of the tool list, whatever the order of the variable', () => {
      assert.deepEqual(tools('create_guest_links,find_rooms'), ['find_rooms', 'create_guest_links']);
      assert.deepEqual(tools('delete_room,get_room,create_room', FULL_ENV), [
        'get_room',
        'create_room',
        'delete_room',
      ]);
    });

    it('ignores spaces around names, empty entries and a name given twice', () => {
      assert.deepEqual(tools(' get_room , find_rooms,,get_room, '), ['find_rooms', 'get_room']);
    });

    it('names the unknown tools, each once, and every tool with its level', () => {
      assert.deepEqual(problemsOf({ ...VALID_ENV, ALFAVIEW_TOOLS: 'find_room, get_room,delete_rooms,find_room' }), [
        `ALFAVIEW_TOOLS names unknown tools: find_room, delete_rooms. The tools are: ${ALL_TOOLS}.`,
      ]);
    });

    it('refuses a list without a name', () => {
      assert.deepEqual(problemsOf({ ...VALID_ENV, ALFAVIEW_TOOLS: ' , ,' }), [
        `ALFAVIEW_TOOLS names no tools. Leave it empty for all tools of the access level, or name some of: ${ALL_TOOLS}.`,
      ]);
    });

    // A silent drop would give a server without a tool that its entry names.
    it('names the tools above the level, each once with its level, in the order of the tool list', () => {
      assert.deepEqual(
        problemsOf({
          ...VALID_ENV,
          ALFAVIEW_TOOLS: 'delete_room,find_rooms,create_room,delete_room',
        }),
        [
          'ALFAVIEW_TOOLS names tools above the level standard: create_room (manage), delete_room (full). Set ALFAVIEW_ACCESS_LEVEL to the level of the tools, or remove their names.',
        ],
      );
      assert.deepEqual(
        problemsOf({ ...VALID_ENV, ALFAVIEW_ACCESS_LEVEL: 'read', ALFAVIEW_TOOLS: 'get_room,create_guest_links' }),
        [
          'ALFAVIEW_TOOLS names tools above the level read: create_guest_links (standard). Set ALFAVIEW_ACCESS_LEVEL to the level of the tools, or remove their names.',
        ],
      );
    });

    it('names unknown tools and tools above the level together', () => {
      assert.deepEqual(problemsOf({ ...VALID_ENV, ALFAVIEW_TOOLS: 'create_room,find_room' }), [
        `ALFAVIEW_TOOLS names unknown tools: find_room. The tools are: ${ALL_TOOLS}.`,
        'ALFAVIEW_TOOLS names tools above the level standard: create_room (manage). Set ALFAVIEW_ACCESS_LEVEL to the level of the tools, or remove their names.',
      ]);
    });

    it('names the tools that a newer tool replaces, with the newer tool, after the unknown tools', () => {
      assert.deepEqual(
        problemsOf({
          ...VALID_ENV,
          ALFAVIEW_TOOLS: 'update_room_file_sharing,find_room,create_room,update_room_features,update_room_file_sharing',
        }),
        [
          `ALFAVIEW_TOOLS names unknown tools: find_room. The tools are: ${ALL_TOOLS}.`,
          'ALFAVIEW_TOOLS names tools that update_room_settings replaces: update_room_file_sharing, update_room_features. Name update_room_settings instead.',
          'ALFAVIEW_TOOLS names tools above the level standard: create_room (manage). Set ALFAVIEW_ACCESS_LEVEL to the level of the tools, or remove their names.',
        ],
      );
      assert.deepEqual(
        problemsOf({ ...VALID_ENV, ALFAVIEW_ACCESS_LEVEL: 'manage', ALFAVIEW_TOOLS: 'find_rooms, update_room_language_settings' }),
        [
          'ALFAVIEW_TOOLS names tools that update_room_settings replaces: update_room_language_settings. Name update_room_settings instead.',
        ],
      );
      assert.deepEqual(Object.keys(REPLACED_TOOLS), [
        'update_room_features',
        'update_room_language_settings',
        'update_room_file_sharing',
      ]);
    });

    it('names no level that the entry did not set when the level has a problem', () => {
      assert.deepEqual(
        problemsOf({ ...VALID_ENV, ALFAVIEW_ACCESS_LEVEL: 'Full', ALFAVIEW_TOOLS: 'create_room' }),
        [LEVEL_PROBLEM],
      );
      assert.deepEqual(
        problemsOf({
          ...FULL_ENV,
          ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS: undefined,
          ALFAVIEW_TOOLS: 'delete_room,find_room',
        }),
        [FULL_PROBLEM, `ALFAVIEW_TOOLS names unknown tools: find_room. The tools are: ${ALL_TOOLS}.`],
      );
    });
  });

  describe('ALFAVIEW_TIME_ZONE', () => {
    const timeZone = (value: string | undefined) =>
      readConfig({ ...VALID_ENV, ALFAVIEW_TIME_ZONE: value }, TOOLS).timeZone;

    // Not the computer's time zone: a server in a container or a CI runner usually runs in UTC.
    it('gives Europe/Berlin when unset or empty', () => {
      assert.equal(timeZone(undefined), 'Europe/Berlin');
      assert.equal(timeZone(''), 'Europe/Berlin');
      assert.equal(timeZone('  '), 'Europe/Berlin');
    });

    it('accepts an IANA name and UTC, and fixes the case of a known name', () => {
      assert.equal(timeZone('America/New_York'), 'America/New_York');
      assert.equal(timeZone('australia/sydney'), 'Australia/Sydney');
      assert.equal(timeZone('UTC'), 'UTC');
    });

    for (const [name, value] of [
      ['an unknown name', 'Europe/Berlni'],
      ['a city without its region', 'Berlin'],
      ['an offset', '+01:00'],
      ['Local, which alfaview reads as the time zone of its own server', 'Local'],
    ] as const) {
      it(`refuses ${name} without printing the value`, () => {
        const problems = problemsOf({ ...VALID_ENV, ALFAVIEW_TIME_ZONE: value });
        assert.deepEqual(problems, [TIME_ZONE_PROBLEM]);
      });
    }
  });

  // Include is the default, so that an entry without the variable keeps every value.
  describe('ALFAVIEW_PERSONAL_DATA', () => {
    const personalData = (value: string | undefined) =>
      readConfig({ ...VALID_ENV, ALFAVIEW_PERSONAL_DATA: value }, TOOLS).personalData;

    it('gives include when unset, empty or only whitespace', () => {
      assert.equal(personalData(undefined), 'include');
      assert.equal(personalData(''), 'include');
      assert.equal(personalData('  '), 'include');
    });

    it('takes include and omit', () => {
      assert.equal(personalData('include'), 'include');
      assert.equal(personalData('omit'), 'omit');
    });

    for (const value of ['Omit', 'INCLUDE', 'leave out', 'exclude', 'false', '0']) {
      it(`refuses ${JSON.stringify(value)}, names the valid values and never the given one`, () => {
        const problems = problemsOf({ ...VALID_ENV, ALFAVIEW_PERSONAL_DATA: value });
        assert.deepEqual(problems, [PERSONAL_DATA_PROBLEM]);
      });
    }
  });

  describe('NODE_TLS_REJECT_UNAUTHORIZED', () => {
    it('refuses 0, also with spaces', () => {
      assert.deepEqual(problemsOf({ ...VALID_ENV, NODE_TLS_REJECT_UNAUTHORIZED: '0' }), [TLS_PROBLEM]);
      assert.deepEqual(problemsOf({ ...VALID_ENV, NODE_TLS_REJECT_UNAUTHORIZED: ' 0 ' }), [
        TLS_PROBLEM,
      ]);
    });

    it('accepts 1 and no value', () => {
      assert.equal(readConfig({ ...VALID_ENV, NODE_TLS_REJECT_UNAUTHORIZED: '1' }, TOOLS).apiKey, 'secret-key-1');
      assert.equal(readConfig({ ...VALID_ENV, NODE_TLS_REJECT_UNAUTHORIZED: '' }, TOOLS).apiKey, 'secret-key-1');
    });
  });

  it('reports every problem on its own line, in the documented order', () => {
    const problems = problemsOf({
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      ALFAVIEW_PERSONAL_DATA: 'none',
      ALFAVIEW_TIME_ZONE: 'Mars/Olympus_Mons',
      ALFAVIEW_TOOLS: 'nothing',
      ALFAVIEW_ACCESS_LEVEL: 'everything',
      ALFAVIEW_API_BASE_URL: 'https://apis.example.com',
    });
    assert.deepEqual(problems, [
      MISSING_ALL,
      BASE_URL_PROBLEM,
      LEVEL_PROBLEM,
      `ALFAVIEW_TOOLS names unknown tools: nothing. The tools are: ${ALL_TOOLS}.`,
      TIME_ZONE_PROBLEM,
      PERSONAL_DATA_PROBLEM,
      TLS_PROBLEM,
    ]);
  });

  it('never puts a value into a message, except tool names', () => {
    const secrets = {
      ALFAVIEW_COMPANY_ID: 'company-secret-marker',
      ALFAVIEW_CLIENT_ID: 'client-secret-marker',
      ALFAVIEW_API_KEY: 'key-secret-marker',
      ALFAVIEW_API_BASE_URL: 'https://base-secret-marker.example.com',
      ALFAVIEW_TIME_ZONE: 'Zone/secret-marker',
      ALFAVIEW_PERSONAL_DATA: 'secret-marker',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    };
    for (const level of [
      { ALFAVIEW_ACCESS_LEVEL: 'level-secret-marker' },
      { ALFAVIEW_ACCESS_LEVEL: 'full', ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS: 'full-secret-marker' },
      { ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS: 'company-secret-marker' },
    ]) {
      // The base URL, the level or its confirmation, the time zone, the option Personal data and
      // the TLS check.
      const problems = problemsOf({ ...secrets, ...level });
      assert.equal(problems.length, 5);
      assert.doesNotMatch(problems.join('\n'), /secret-marker/);
    }
  });
});
