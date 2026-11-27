// The isolation of each run of the model eval (eval/runner.ts): the arguments and the environment
// of claude, the settings of the run, and what the runner reads from the debug log.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import {
  ARM_TOOLS,
  claudeArgs,
  claudeEnv,
  crashedRecord,
  featureFlagsOf,
  LOGIN_ENV,
  PASSED_ENV,
  PLUGIN_DIR,
  PLUGIN_SKILL,
  probeProblems,
  RUN_ENV,
  runSettings,
  type RunOptions,
} from '../../eval/runner.ts';
import { TASKS } from '../../eval/tasks.ts';

const OPTIONS: RunOptions = {
  claudeBin: 'claude',
  configDir: '/home/person/.claude-team',
  maxTurns: 15,
  maxBudgetUsd: 0.5,
  timeoutMs: 300_000,
  effort: 'medium',
  arm: 'server',
};
const FILES = { mcpConfig: '/tmp/run/mcp.json', settings: '/tmp/run/settings.json', debugLog: '/tmp/run/debug.log' };

/** Returns the value after `flag` in `args`. */
function valueOf(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe('the arguments of claude', () => {
  const args = claudeArgs('What is the passcode?', 'claude-haiku-5-5', FILES, OPTIONS);

  it('give the prompt and the model, and ask for the stream', () => {
    assert.deepEqual(args.slice(0, 4), ['-p', 'What is the passcode?', '--model', 'claude-haiku-5-5']);
    assert.equal(valueOf(args, '--output-format'), 'stream-json');
    assert.ok(args.includes('--verbose'));
  });

  it('give the model only the alfaview server, no built-in tool, and no settings of the person', () => {
    assert.equal(valueOf(args, '--mcp-config'), FILES.mcpConfig);
    assert.ok(args.includes('--strict-mcp-config'));
    assert.equal(valueOf(args, '--tools'), '');
    assert.equal(valueOf(args, '--allowedTools'), 'mcp__alfaview');
    assert.equal(valueOf(args, '--permission-mode'), 'dontAsk');
    assert.equal(valueOf(args, '--setting-sources'), '');
    assert.equal(valueOf(args, '--settings'), FILES.settings);
    assert.ok(args.includes('--disable-slash-commands'));
    assert.ok(args.includes('--no-session-persistence'));
    assert.ok(!args.includes('--bare'), 'the run uses the login of the person');
  });

  it('give the limits, the debug log and the effort', () => {
    assert.equal(valueOf(args, '--max-turns'), '15');
    assert.equal(valueOf(args, '--max-budget-usd'), '0.5');
    assert.equal(valueOf(args, '--debug-file'), FILES.debugLog);
    assert.equal(valueOf(args, '--effort'), 'medium');
    assert.ok(!claudeArgs('p', 'm', FILES, { ...OPTIONS, effort: undefined }).includes('--effort'));
  });
});

describe('the arguments of the arms with and without the skill', () => {
  const server = claudeArgs('What is the passcode?', 'claude-haiku-5-5', FILES, OPTIONS);
  const plain = claudeArgs('What is the passcode?', 'claude-haiku-5-5', FILES, { ...OPTIONS, arm: 'plain' });
  const skill = claudeArgs('What is the passcode?', 'claude-haiku-5-5', FILES, { ...OPTIONS, arm: 'skill' });
  // A Read rule with two slashes names an absolute path from the root of the file system.
  const readRule = `Read(/${PLUGIN_DIR}/**)`;

  it('name the plugin folder of the package and its skill', () => {
    assert.equal(PLUGIN_DIR, fileURLToPath(new URL('../../plugins/alfaview-mcp', import.meta.url)));
    assert.ok(PLUGIN_DIR.startsWith('/'));
    assert.deepEqual(ARM_TOOLS, ['Skill', 'Read', 'ToolSearch']);
    assert.equal(PLUGIN_SKILL, 'alfaview-mcp:alfaview-meetings');
  });

  it('give the arm plain the tools of a skill, the skills of Claude Code and no plugin', () => {
    assert.equal(valueOf(plain, '--tools'), 'Skill,Read,ToolSearch');
    assert.equal(valueOf(plain, '--allowedTools'), `mcp__alfaview,Skill,${readRule}`);
    assert.ok(!plain.includes('--disable-slash-commands'));
    assert.ok(!plain.includes('--plugin-dir'));
    // Apart from these, the arguments are those of the arm server.
    const expected = server.filter((arg) => arg !== '--disable-slash-commands');
    expected[expected.indexOf('--tools') + 1] = 'Skill,Read,ToolSearch';
    expected[expected.indexOf('--allowedTools') + 1] = `mcp__alfaview,Skill,${readRule}`;
    assert.deepEqual(plain, expected);
  });

  it('give the arm skill the arguments of plain and the plugin folder, and nothing else', () => {
    assert.deepEqual(skill, [...plain, '--plugin-dir', PLUGIN_DIR]);
    assert.ok(!server.includes('--plugin-dir'));
  });
});

describe('the environment of claude', () => {
  it('holds only the run settings, the passed variables and the login folder', () => {
    const env = claudeEnv(
      {
        HOME: '/home/person',
        PATH: '/usr/bin',
        LANG: 'en_US.UTF-8',
        ANTHROPIC_API_KEY: 'sk-ant-secret',
        ALFAVIEW_API_KEY: 'secret',
        CLAUDE_CONFIG_DIR: '/home/person/.claude-other',
        CLAUDE_CODE_SESSION_ID: 'outer-session',
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-lo  gin',
      },
      OPTIONS.configDir,
    );
    const allowed = new Set([...Object.keys(RUN_ENV), ...PASSED_ENV, ...LOGIN_ENV, 'CLAUDE_CONFIG_DIR']);
    assert.deepEqual(Object.keys(env).filter((key) => !allowed.has(key)), []);
    assert.equal(env.CLAUDE_CONFIG_DIR, '/home/person/.claude-team');
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-login');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(claudeEnv({ CLAUDE_CODE_OAUTH_TOKEN: ' \n' }, undefined).CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(env.HOME, '/home/person');
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
    assert.equal(env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL, '1');
    assert.equal(claudeEnv({}, undefined).CLAUDE_CONFIG_DIR, undefined);
  });
});

describe('the settings of a run', () => {
  it('hold only the Elicitation hook, with each path in quotes', () => {
    const settings = runSettings({ rules: "/tmp/it's/rules.json", elicitationLog: '/tmp/run/log.jsonl' }) as {
      hooks: Record<string, { hooks: { type: string; command: string }[] }[]>;
    };
    assert.deepEqual(Object.keys(settings), ['hooks']);
    assert.deepEqual(Object.keys(settings.hooks), ['Elicitation']);
    const [hook] = settings.hooks.Elicitation![0]!.hooks;
    assert.equal(hook?.type, 'command');
    assert.match(hook!.command, /^'[^']+node[^']*' '[^']+\/eval\/elicitation-hook\.ts' '\/tmp\/it'\\''s\/rules\.json' '\/tmp\/run\/log\.jsonl'$/);
    assert.deepEqual(runSettings({ rules: '/r', elicitationLog: '/l' }, 'server'), runSettings({ rules: '/r', elicitationLog: '/l' }));
  });

  it('turn off the skills of Claude Code itself in the arms plain and skill', () => {
    const files = { rules: '/tmp/run/rules.json', elicitationLog: '/tmp/run/log.jsonl' };
    const server = runSettings(files, 'server') as Record<string, unknown>;
    for (const arm of ['plain', 'skill'] as const) {
      const settings = runSettings(files, arm) as Record<string, unknown>;
      assert.deepEqual(settings.hooks, server.hooks);
      assert.equal(settings.disableBundledSkills, true);
      assert.deepEqual(settings.skillOverrides, { doctor: 'off' });
      assert.deepEqual(settings.enabledPlugins, { 'cc-plugin-plugin-authoring@builtin': false });
    }
  });
});

describe('what the runner reads from the debug log', () => {
  it('keeps the lines that name the source of a feature flag, without their time', () => {
    const log = [
      '2026-10-28T12:05:30.433Z [DEBUG] mcp runtime arm: v2 (source: default)',
      '2026-10-28T12:05:30.562Z [DEBUG] act_dont_rederive_arm_active source=growthbook',
      '2026-10-28T12:05:30.582Z [DEBUG] [API REQUEST] /v1/messages x-client-request-id=abc source=sdk',
      '2026-10-28T12:05:31.562Z [DEBUG] act_dont_rederive_arm_active source=growthbook',
    ].join('\n');
    assert.deepEqual(featureFlagsOf(log), [
      'act_dont_rederive_arm_active source=growthbook',
      'mcp runtime arm: v2 (source: default)',
    ]);
  });
});

describe('the probe of the questions to the person', () => {
  const question = { server: 'alfaview', message: 'Delete the room "Webinar Room" for good?' };

  it('finds no problem when the question went through the hook and back', () => {
    const result = {
      expected: 'decline' as const,
      protocolVersion: '2025-11-25',
      canAsk: true,
      hookEntries: [{ ...question, action: 'decline' as const }],
      serverAnswers: [{ answer: { action: 'decline' }, error: null }],
    };
    assert.deepEqual(probeProblems(result), []);
  });

  it('names a client that cannot ask, a hook that got nothing, and an answer that did not come back', () => {
    const problems = probeProblems({
      expected: 'accept',
      protocolVersion: '2025-11-25',
      canAsk: false,
      hookEntries: [],
      serverAnswers: [{ answer: { action: 'cancel' }, error: null }],
    });
    assert.deepEqual(problems, [
      'Claude Code did not tell the server that it can ask the person (capability elicitation)',
      'the Elicitation hook got 0 questions, not 1',
      'the server got the answer {"answer":{"action":"cancel"},"error":null}, not accept',
    ]);
    assert.match(
      probeProblems({
        expected: 'accept',
        protocolVersion: null,
        canAsk: true,
        hookEntries: [{ ...question, action: 'decline' }],
        serverAnswers: [],
      }).join('\n'),
      /the hook answered decline, not accept\nthe server got the answer null, not accept/,
    );
  });

  const folder = mkdtempSync(join(tmpdir(), 'alfaview-mcp-eval-probe-test-'));
  after(() => rmSync(folder, { recursive: true, force: true }));

  it('has a stub server that asks the person in a tool call and logs the answer', async () => {
    const log = join(folder, 'probe.jsonl');
    const server = spawn(process.execPath, [fileURLToPath(new URL('../../eval/elicitation-probe-server.ts', import.meta.url)), log], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const lines = createInterface({ input: server.stdout })[Symbol.asyncIterator]();
    const next = async () => JSON.parse((await lines.next()).value as string);
    const write = (message: object) => server.stdin.write(`${JSON.stringify(message)}\n`);

    write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { elicitation: {} } } });
    assert.equal((await next()).result.protocolVersion, '2025-11-25');
    write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    write({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual((await next()).result.tools.map((tool: { name: string }) => tool.name), ['delete_room']);
    write({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'delete_room', arguments: {} } });
    const asked = await next();
    assert.equal(asked.method, 'elicitation/create');
    assert.match(asked.params.message, /"Webinar Room"/);
    write({ jsonrpc: '2.0', id: asked.id, result: { action: 'decline' } });
    const called = await next();
    assert.equal(called.id, 3);
    assert.match(called.result.content[0].text, /^The person answered: \{"action":"decline"\}/);
    write({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
    assert.equal((await next()).error.code, -32601);
    server.stdin.end();
    await new Promise((resolve) => server.on('close', resolve));

    const entries = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(entries[0].initialize.capabilities, { elicitation: {} });
    assert.deepEqual(entries[1], { answer: { action: 'decline' }, error: null });
  });
});

describe('the record of a run that the eval could not do', () => {
  it('is invalid and names the error', () => {
    const task = TASKS[0]!;
    const record = crashedRecord({ task, model: 'claude-haiku-5-5', repeat: 2, outDir: '/tmp/out' }, new Error('spawn claude ENOENT'));
    assert.equal(record.taskId, task.id);
    assert.equal(record.repeat, 2);
    assert.equal(record.valid, false);
    assert.equal(record.passed, false);
    assert.deepEqual(record.invalidReasons, ['the eval could not do the run: spawn claude ENOENT']);
    assert.deepEqual(crashedRecord({ task, model: 'm', repeat: 1, outDir: '/tmp' }, 'text').invalidReasons, [
      'the eval could not do the run: text',
    ]);
  });
});
