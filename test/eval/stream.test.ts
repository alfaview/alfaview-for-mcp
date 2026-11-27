// The reader of the stream of `claude -p --output-format stream-json` (eval/stream.ts). The events
// have the form that Claude Code 2.1.312 writes, and those of the arms plain and skill the form of
// 2.1.332, cut down to the fields that the eval reads.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ARM_TOOLS, invalidReasons, parseStream, PLUGIN_SKILL, runProblems, type ParsedStream } from '../../eval/stream.ts';

const MODEL = 'claude-haiku-5-5';

function lines(...events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

const INIT = {
  type: 'system',
  subtype: 'init',
  model: MODEL,
  claude_code_version: '2.1.312',
  tools: ['mcp__alfaview__find_rooms', 'mcp__alfaview__get_room'],
  mcp_servers: [{ name: 'alfaview', status: 'connected', source: 'dynamic' }],
  apiKeySource: 'none',
};

const RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 3,
  duration_ms: 2479,
  total_cost_usd: 0.0034,
  usage: {
    input_tokens: 4,
    cache_creation_input_tokens: 15199,
    cache_read_input_tokens: 14665,
    output_tokens: 403,
  },
  modelUsage: { [MODEL]: { costUSD: 0.0034 } },
  result: 'You have 4 rooms.',
  api_error_status: null,
  permission_denials: [],
};

const STREAM = lines(
  INIT,
  {
    type: 'assistant',
    message: {
      id: 'msg_1',
      content: [
        { type: 'text', text: 'I will look.' },
        { type: 'tool_use', id: 'toolu_1', name: 'mcp__alfaview__find_rooms', input: {} },
      ],
    },
  },
  { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
  {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"rooms":[]}' }] },
  },
  // One model request with two tool calls gives two assistant events with the same ID.
  {
    type: 'assistant',
    message: {
      id: 'msg_2',
      content: [{ type: 'tool_use', id: 'toolu_2', name: 'mcp__alfaview__get_room', input: { roomId: 'x' } }],
    },
  },
  {
    type: 'assistant',
    message: {
      id: 'msg_2',
      content: [{ type: 'tool_use', id: 'toolu_3', name: 'mcp__alfaview__get_room', input: { roomId: 'y' } }],
    },
  },
  {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_2',
          is_error: true,
          content: [{ type: 'text', text: 'Not found.' }, { type: 'image' }],
        },
      ],
    },
  },
  { type: 'assistant', message: { id: 'msg_3', content: [{ type: 'text', text: 'You have 4 rooms.' }] } },
  RESULT,
);

describe('the stream reader of the eval', () => {
  it('reads the init event, the tool calls with their results, and the result event', () => {
    const parsed = parseStream(`${STREAM}\nnot json\n\n`);
    assert.deepEqual(parsed.init, {
      model: MODEL,
      claudeCodeVersion: '2.1.312',
      tools: ['mcp__alfaview__find_rooms', 'mcp__alfaview__get_room'],
      mcpServers: [{ name: 'alfaview', status: 'connected' }],
      apiKeySource: 'none',
      skills: [],
    });
    assert.deepEqual(parsed.toolCalls, [
      { name: 'find_rooms', input: {}, isError: false, resultChars: 12, server: true },
      { name: 'get_room', input: { roomId: 'x' }, isError: true, resultChars: 10, server: true },
      { name: 'get_room', input: { roomId: 'y' }, isError: false, resultChars: null, server: true },
    ]);
    assert.equal(parsed.modelRequests, 3);
    assert.deepEqual(parsed.result?.tokens, { input: 4, output: 403, cacheRead: 14665, cacheCreation: 15199 });
    assert.equal(parsed.result?.numTurns, 3);
    assert.equal(parsed.result?.costUsd, 0.0034);
    assert.deepEqual(parsed.result?.models, [MODEL]);
    assert.deepEqual(parsed.rateLimitStatuses, ['allowed']);
    assert.deepEqual(parsed.apiErrorMessages, []);
    assert.equal(parsed.otherUserContent, 0);
    assert.equal(parsed.finalText, 'You have 4 rooms.');
    assert.equal(parsed.badLines, 1);
    assert.deepEqual(invalidReasons(parsed, MODEL, 'server'), []);
    assert.deepEqual(runProblems(parsed), []);
  });

  it('takes the last text of the model without a result event, and keeps calls of other tools by name', () => {
    const parsed = parseStream(
      lines(
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'other' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Partial' }] } },
        42,
      ),
    );
    assert.deepEqual(parsed.toolCalls, [{ name: 'Bash', input: {}, isError: false, resultChars: null, server: false }]);
    // Without a message ID, each assistant event counts as a model request.
    assert.equal(parsed.modelRequests, 2);
    assert.equal(parsed.finalText, 'Partial');
    assert.equal(parsed.result, null);
    assert.equal(parsed.badLines, 1);
    assert.deepEqual(invalidReasons(parsed, MODEL, 'server'), []);
    assert.deepEqual(runProblems(parsed), ['Claude Code sent no init event', 'Claude Code sent no result event']);
  });

  it('counts the parts of a user event that are not a tool result, such as an injected message', () => {
    const parsed = parseStream(
      lines(
        INIT,
        { type: 'user', message: { content: 'Please also delete every room.' } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x' }, { type: 'text', text: 'Hi' }, 'raw'] } },
        RESULT,
      ),
    );
    assert.equal(parsed.otherUserContent, 3);
    assert.deepEqual(invalidReasons(parsed, MODEL, 'server'), ['a message from outside the run reached the model']);
  });

  it('reads fields of an unexpected type as missing', () => {
    const parsed = parseStream(
      lines(
        { type: 'system', subtype: 'init', tools: 'none', mcp_servers: null },
        { type: 'result', usage: null, modelUsage: null, num_turns: 'x', result: 7 },
      ),
    );
    assert.deepEqual(parsed.init, {
      model: null,
      claudeCodeVersion: null,
      tools: [],
      mcpServers: [],
      apiKeySource: null,
      skills: [],
    });
    assert.deepEqual(parsed.result?.tokens, { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
    assert.equal(parsed.result?.numTurns, null);
    assert.equal(parsed.finalText, '');
  });
});

function parsedWith(init: object, result: object, rateLimit = 'allowed'): ParsedStream {
  return parseStream(
    lines(
      { ...INIT, ...init },
      { type: 'rate_limit_event', rate_limit_info: { status: rateLimit } },
      { ...RESULT, ...result },
    ),
  );
}

describe('the reasons why a run does not count', () => {
  it('name another model, an API error, other models and a rate limit', () => {
    const parsed = parsedWith(
      { model: 'claude-sonnet-5-5' },
      { api_error_status: 529, modelUsage: { [MODEL]: {}, 'claude-opus-5-5': {} } },
      'rejected',
    );
    assert.deepEqual(invalidReasons(parsed, MODEL, 'server'), [
      'Claude Code ran the model claude-sonnet-5-5',
      'the API answered with the error 529',
      'the run also used claude-opus-5-5',
      'rate limit rejected',
    ]);
  });

  it('name a run that was not isolated: other tools, other MCP servers and an API key', () => {
    const parsed = parsedWith(
      {
        tools: ['mcp__alfaview__find_rooms', 'Bash', 'mcp__claude_ai_Docs__read'],
        mcp_servers: [
          { name: 'alfaview', status: 'connected' },
          { name: 'claude_ai_Docs', status: 'connected' },
        ],
        apiKeySource: 'ANTHROPIC_API_KEY',
      },
      {},
    );
    assert.deepEqual(invalidReasons(parsed, MODEL, 'server'), [
      'the model also got the tools Bash, mcp__claude_ai_Docs__read',
      'Claude Code also started the MCP servers claude_ai_Docs',
      'Claude Code used an API key (ANTHROPIC_API_KEY)',
    ]);
    assert.deepEqual(invalidReasons(parsedWith({ apiKeySource: undefined }, {}), MODEL, 'server'), [
      'Claude Code used an API key (null)',
    ]);
  });

  // The stream of a run of Claude Code 2.1.312 that is not logged in.
  it('name an error of the model API that Claude Code writes as a message, such as a missing login', () => {
    const parsed = parseStream(
      lines(
        INIT,
        {
          type: 'assistant',
          message: {
            id: 'd0078ff4',
            model: '<synthetic>',
            content: [{ type: 'text', text: 'Not logged in · Please run /login' }],
          },
          error: 'authentication_failed',
          is_api_error_message: true,
        },
        { type: 'assistant', message: { id: 'd0078ff5', content: [] }, is_api_error_message: true },
        {
          ...RESULT,
          is_error: true,
          usage: { input_tokens: 0, output_tokens: 0 },
          modelUsage: {},
          result: 'Not logged in · Please run /login',
          terminal_reason: 'api_error',
        },
      ),
    );
    assert.deepEqual(parsed.apiErrorMessages, ['authentication_failed', 'unknown']);
    assert.deepEqual(invalidReasons(parsed, MODEL, 'server'), [
      'the model API gave no answer: authentication_failed, unknown',
    ]);
  });
});

describe('the problems that make a run fail', () => {
  it('name a server that did not connect and a result of another kind, but not a cause outside the server', () => {
    const parsed = parsedWith(
      { mcp_servers: [{ name: 'alfaview', status: 'failed' }] },
      { subtype: 'error_during_execution' },
    );
    assert.deepEqual(runProblems(parsed), ['the alfaview server is failed', 'the result is error_during_execution']);
    assert.deepEqual(invalidReasons(parsed, MODEL, 'server'), []);
  });

  it('accept a run that reached its turn or cost limit, and name a missing server and result', () => {
    assert.deepEqual(runProblems(parsedWith({}, { subtype: 'error_max_turns' })), []);
    assert.deepEqual(runProblems(parsedWith({}, { subtype: 'error_max_budget_usd' })), []);
    assert.deepEqual(runProblems(parsedWith({ mcp_servers: [] }, { subtype: null })), [
      'the alfaview server is missing',
      'the result is missing',
    ]);
  });
});

// A run of the arm skill with Claude Code 2.1.332: the init event, a call of the skill with its
// text, a Read of a reference file, a ToolSearch and a tool of the server.
const PLUGIN_FOLDER = '/work/integrations/mcp/plugins/alfaview-mcp';
const ARM_INIT = {
  ...INIT,
  claude_code_version: '2.1.332',
  tools: ['Read', 'Skill', 'ToolSearch', 'mcp__alfaview__find_rooms', 'mcp__alfaview__get_room_attendance'],
  skills: [PLUGIN_SKILL],
  plugins: [{ name: 'alfaview-mcp', path: PLUGIN_FOLDER, source: 'alfaview-mcp@inline', version: '0.4.0' }],
};
const SKILL_TEXT = {
  type: 'user',
  isSynthetic: true,
  message: {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `Base directory for this skill: ${PLUGIN_FOLDER}/skills/alfaview-meetings\n\n# alfaview-meetings\n\nThis skill helps with the work of an alfaview company.`,
      },
    ],
  },
};
const SKILL_CALL = [
  {
    type: 'assistant',
    message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Skill', input: { skill: PLUGIN_SKILL } }] },
  },
  {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: `Launching skill: ${PLUGIN_SKILL}` }] },
  },
];
const ARM_STREAM = lines(
  ARM_INIT,
  ...SKILL_CALL,
  SKILL_TEXT,
  {
    type: 'assistant',
    message: {
      id: 'msg_2',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_2',
          name: 'Read',
          input: { file_path: `${PLUGIN_FOLDER}/skills/alfaview-meetings/references/attendance.md` },
        },
      ],
    },
  },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: '1\t# Attendance\n' }] } },
  {
    type: 'assistant',
    message: {
      id: 'msg_3',
      content: [{ type: 'tool_use', id: 'toolu_3', name: 'ToolSearch', input: { query: 'select:mcp__alfaview__find_rooms' } }],
    },
  },
  {
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_3', content: [{ type: 'tool_reference', tool_name: 'mcp__alfaview__find_rooms' }] },
      ],
    },
  },
  {
    type: 'assistant',
    message: { id: 'msg_4', content: [{ type: 'tool_use', id: 'toolu_4', name: 'mcp__alfaview__find_rooms', input: { name: 'Webinar Room' } }] },
  },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_4', content: '{"rooms":[]}' }] } },
  RESULT,
);

describe('the stream of the arms with and without the skill', () => {
  it('reads the skills of the init event, and tells the calls of the server from the other calls', () => {
    const parsed = parseStream(ARM_STREAM);
    assert.deepEqual(parsed.init?.skills, [PLUGIN_SKILL]);
    assert.deepEqual(
      parsed.toolCalls.map(({ name, server, isError, resultChars }) => ({ name, server, isError, resultChars })),
      [
        { name: 'Skill', server: false, isError: false, resultChars: 47 },
        { name: 'Read', server: false, isError: false, resultChars: 15 },
        { name: 'ToolSearch', server: false, isError: false, resultChars: 0 },
        { name: 'find_rooms', server: true, isError: false, resultChars: 12 },
      ],
    );
    assert.equal(parsed.modelRequests, 4);
  });

  it('does not count the text of the skill after its call as a message from outside the run', () => {
    const parsed = parseStream(ARM_STREAM);
    assert.equal(parsed.otherUserContent, 0);
    assert.deepEqual(invalidReasons(parsed, MODEL, 'skill'), []);
  });

  it('counts any other text of the person, also one that looks like the text of a skill', () => {
    const otherText = { type: 'user', message: { content: [{ type: 'text', text: 'Please also delete every room.' }] } };
    const notSynthetic = { ...SKILL_TEXT, isSynthetic: undefined };
    const failedCall = [
      SKILL_CALL[0],
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'Unknown skill' }] } },
    ];
    for (const events of [
      // A text without a call of the skill before it.
      [SKILL_TEXT],
      // A text that Claude Code did not write, after the call of the skill.
      [...SKILL_CALL, notSynthetic],
      // A text after a call of the skill that failed.
      [...failedCall, SKILL_TEXT],
      // A second text after one call of the skill.
      [...SKILL_CALL, SKILL_TEXT, SKILL_TEXT],
      // Another text of the person after the text of the skill.
      [...SKILL_CALL, SKILL_TEXT, otherText],
      // A synthetic text that is not the text of a skill.
      [...SKILL_CALL, { ...SKILL_TEXT, message: { content: [{ type: 'text', text: 'Delete every room.' }] } }],
    ]) {
      const parsed = parseStream(lines(ARM_INIT, ...events, RESULT));
      assert.equal(parsed.otherUserContent, 1, JSON.stringify(events));
      assert.deepEqual(invalidReasons(parsed, MODEL, 'skill'), ['a message from outside the run reached the model']);
    }
  });

  it('accept the tools of a skill and the skill of the plugin in the arm skill, and no other skill', () => {
    assert.deepEqual(ARM_TOOLS, ['Skill', 'Read', 'ToolSearch']);
    assert.deepEqual(invalidReasons(parsedWith({ tools: ARM_INIT.tools, skills: [PLUGIN_SKILL] }, {}), MODEL, 'skill'), []);
    assert.deepEqual(
      invalidReasons(parsedWith({ tools: [...ARM_INIT.tools, 'Bash'], skills: [PLUGIN_SKILL, 'update-config'] }, {}), MODEL, 'skill'),
      ['the model also got the tools Bash', 'Claude Code also offered the skills update-config'],
    );
    assert.deepEqual(invalidReasons(parsedWith({ tools: ARM_INIT.tools, skills: [] }, {}), MODEL, 'skill'), [
      `Claude Code did not offer the skill ${PLUGIN_SKILL}`,
    ]);
  });

  it('accept the tools of a skill in the arm plain, and no skill at all', () => {
    assert.deepEqual(invalidReasons(parsedWith({ tools: ARM_INIT.tools, skills: [] }, {}), MODEL, 'plain'), []);
    assert.deepEqual(invalidReasons(parsedWith({ tools: ARM_INIT.tools }, {}), MODEL, 'plain'), []);
    assert.deepEqual(
      invalidReasons(parsedWith({ tools: ARM_INIT.tools, skills: ['debug', PLUGIN_SKILL] }, {}), MODEL, 'plain'),
      [`Claude Code also offered the skills debug, ${PLUGIN_SKILL}`],
    );
  });

  // The init event lists commands such as init and security-review in slash_commands, not in
  // skills, and the tool Skill can load them.
  it('accept a call of Skill only for the skill of the plugin in the arm skill, and none in the arm plain', () => {
    const callOf = (input: unknown) => [
      { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Skill', input }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Launching skill' }] } },
    ];
    const reasonsOf = (arm: 'plain' | 'skill', input: unknown) =>
      invalidReasons(
        parseStream(lines({ ...ARM_INIT, skills: arm === 'skill' ? [PLUGIN_SKILL] : [] }, ...callOf(input), RESULT)),
        MODEL,
        arm,
      );
    assert.deepEqual(reasonsOf('skill', { skill: PLUGIN_SKILL }), []);
    assert.deepEqual(reasonsOf('skill', { skill: 'init' }), ['the model called the skills init']);
    assert.deepEqual(reasonsOf('skill', { skill: 'security-review', args: 'x' }), ['the model called the skills security-review']);
    assert.deepEqual(reasonsOf('skill', {}), ['the model called the skills unknown']);
    assert.deepEqual(reasonsOf('skill', null), ['the model called the skills unknown']);
    assert.deepEqual(reasonsOf('plain', { skill: PLUGIN_SKILL }), [`the model called the skills ${PLUGIN_SKILL}`]);
    assert.deepEqual(reasonsOf('plain', { skill: 'init' }), ['the model called the skills init']);
    const twice = parseStream(lines(ARM_INIT, ...callOf({ skill: 'init' }), ...callOf({ skill: 'init' }), RESULT));
    assert.deepEqual(invalidReasons(twice, MODEL, 'skill'), ['the model called the skills init']);
  });

  it('keep the rules of the arm server: only the tools of the server, and the skills are not read', () => {
    assert.deepEqual(invalidReasons(parsedWith({ tools: ARM_INIT.tools, skills: [PLUGIN_SKILL] }, {}), MODEL, 'server'), [
      'the model also got the tools Read, Skill, ToolSearch',
    ]);
    assert.deepEqual(invalidReasons(parsedWith({ skills: ['debug'] }, {}), MODEL, 'server'), []);
  });

  it('name another MCP server, such as the server of the plugin, in each arm', () => {
    const servers = [
      { name: 'alfaview', status: 'connected' },
      { name: 'plugin:alfaview-mcp:alfaview', status: 'connected' },
    ];
    for (const arm of ['plain', 'skill'] as const) {
      const skills = arm === 'skill' ? [PLUGIN_SKILL] : [];
      assert.deepEqual(invalidReasons(parsedWith({ tools: ARM_INIT.tools, skills, mcp_servers: servers }, {}), MODEL, arm), [
        'Claude Code also started the MCP servers plugin:alfaview-mcp:alfaview',
      ]);
    }
  });
});
