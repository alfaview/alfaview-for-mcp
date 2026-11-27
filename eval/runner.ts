// One run of one task with one model: a fresh fake alfaview API on 127.0.0.1, an MCP config in a
// temporary folder, and `claude -p` with only the alfaview server (in the arms plain and skill,
// also the tools of a skill, see Arm). Claude Code starts the built server (dist/main.js) with the
// preload route-fetch.ts, which sends the requests for https://apis.alfaview.com to the fake API
// and refuses every other URL. So no run reaches alfaview.
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleState, startFakeApi, type FakeFault, type FakeRequest } from '../test/fake-api/server.ts';
import { serverLaunch, TEST_ENV } from '../test/helpers/spawnServer.ts';
import { createContractCheck } from '../test/shared/contract.ts';
import { emailsOf, runChecks, writesOf } from './checks.ts';
import { clockOf, EVAL_TIME_ZONE, MINUTE_MS } from './clock.ts';
import { parseElicitationLog, type ElicitationLogEntry } from './elicitation.ts';
import type { RunRecord } from './report.ts';
import { ARM_TOOLS, invalidReasons, parseStream, runProblems, TOOL_PREFIX, type Arm } from './stream.ts';
import type { Task } from './tasks.ts';

export { ARM_TOOLS, ARMS, PLUGIN_SKILL, type Arm } from './stream.ts';

export type RunOptions = {
  /** The claude binary. */
  claudeBin: string;
  /** CLAUDE_CONFIG_DIR of the login to use, or undefined for the default of Claude Code. */
  configDir: string | undefined;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
  /** The effort of Claude Code, or undefined for its default. */
  effort: string | undefined;
  arm: Arm;
};

/** The absolute path of the Claude Code plugin of this package. */
export const PLUGIN_DIR = fileURLToPath(new URL('../plugins/alfaview-mcp', import.meta.url));

/** The environment variables that the eval passes on to claude. No credential is among them. */
export const PASSED_ENV = ['HOME', 'PATH', 'USER', 'LOGNAME', 'TMPDIR', 'LANG'];

/**
 * The login of Claude Code itself, for a profile that logs in with a long-lived token of
 * `claude setup-token` instead of the keychain. It is the subscription login of the person who
 * runs the eval, never an API key: ANTHROPIC_API_KEY stays out, and a run whose API key source is
 * not "none" is invalid. A token holds no whitespace, but a copy pasted from a wrapped terminal
 * line can, so the eval removes it.
 */
export const LOGIN_ENV = ['CLAUDE_CODE_OAUTH_TOKEN'];

/**
 * The settings that keep the run free of the person's setup: no instruction files, no memory, no
 * MCP servers of claude.ai, no update and no title request, no advisor model next to the model
 * under test, and no traffic that the run does not need (telemetry, the event log and feature
 * flags from the network). The login and the model API still work.
 */
export const RUN_ENV = {
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
  CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};

/** The OpenAPI spec of the alfaview API v2 in this package. */
const SPEC_URL = new URL('../spec/openapi-v2.json', import.meta.url);
const HOOK_SCRIPT = fileURLToPath(new URL('./elicitation-hook.ts', import.meta.url));
let contractCheck: ReturnType<typeof createContractCheck> | undefined;

/** Returns the problems of the requests against spec/openapi-v2.json, one line each. */
function contractProblemsOf(requests: readonly FakeRequest[]): string[] {
  contractCheck ??= createContractCheck(JSON.parse(readFileSync(SPEC_URL, 'utf8')));
  return requests.flatMap((request) => {
    const query = new URLSearchParams(request.query).toString();
    const problems = contractCheck!({
      method: request.method,
      path: query === '' ? request.path : `${request.path}?${query}`,
      headers: undefined,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });
    return problems.map(
      (problem) => `${request.method} ${request.path}: ${problem.rule}: ${problem.message}`,
    );
  });
}

/** Returns the environment of the alfaview server: fake credentials and the task's settings. */
function serverEnv(task: Task): Record<string, string> {
  return {
    ...TEST_ENV,
    ALFAVIEW_ACCESS_LEVEL: task.level,
    ALFAVIEW_TIME_ZONE: EVAL_TIME_ZONE,
    ALFAVIEW_PERSONAL_DATA: task.personalData ?? 'include',
    // The opt-in of the level full names the company of the key, and only full tasks get it.
    ...(task.level === 'full' ? { ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS: TEST_ENV.ALFAVIEW_COMPANY_ID } : {}),
  };
}

/** Returns `text` in single quotes for sh. */
function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The settings of the arms plain and skill that remove the skills of Claude Code itself: the
 * bundled skills, the skill doctor (which disableBundledSkills keeps), and the built-in plugin with
 * the skill plugin-authoring. The arm server turns off all skills with --disable-slash-commands
 * instead.
 */
export const ARM_SETTINGS = {
  disableBundledSkills: true,
  skillOverrides: { doctor: 'off' },
  enabledPlugins: { 'cc-plugin-plugin-authoring@builtin': false },
};

/**
 * Returns the settings of Claude Code for a run: the Elicitation hook, which answers each question
 * of the server as the person of the task (elicitation-hook.ts), and in the arms plain and skill
 * also ARM_SETTINGS.
 */
export function runSettings(files: { rules: string; elicitationLog: string }, arm: Arm = 'server'): object {
  const command = [process.execPath, HOOK_SCRIPT, files.rules, files.elicitationLog].map(shellQuote).join(' ');
  const hooks = { Elicitation: [{ hooks: [{ type: 'command', command, timeout: 30 }] }] };
  return arm === 'server' ? { hooks } : { hooks, ...ARM_SETTINGS };
}

/**
 * Returns the arguments of claude. The prompt comes right after -p, before the options with lists.
 */
export function claudeArgs(
  prompt: string,
  model: string,
  files: { mcpConfig: string; settings: string; debugLog: string },
  options: RunOptions,
): string[] {
  const server = options.arm === 'server';
  return [
    '-p',
    prompt,
    '--model',
    model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--mcp-config',
    files.mcpConfig,
    // Only the server of the MCP config, also in the arm skill. The plugin must not start the
    // server of its manifest, which runs the published package against alfaview.
    '--strict-mcp-config',
    // The arm server gets no built-in tools, so the model has only the alfaview tools, and all of
    // them load at the start (without ToolSearch). The other arms get the tools of a skill, and a
    // Read only of the files of the plugin (a path with two slashes is absolute).
    '--tools',
    server ? '' : ARM_TOOLS.join(','),
    '--allowedTools',
    server ? 'mcp__alfaview' : `mcp__alfaview,Skill,Read(/${PLUGIN_DIR}/**)`,
    '--permission-mode',
    'dontAsk',
    // No settings of the person or the project: only the settings of the run.
    '--setting-sources',
    '',
    '--settings',
    files.settings,
    // The option turns off all skills, so only the arm server gets it.
    ...(server ? ['--disable-slash-commands'] : []),
    '--no-session-persistence',
    '--max-turns',
    String(options.maxTurns),
    '--max-budget-usd',
    String(options.maxBudgetUsd),
    '--debug-file',
    files.debugLog,
    ...(options.effort === undefined ? [] : ['--effort', options.effort]),
    ...(options.arm === 'skill' ? ['--plugin-dir', PLUGIN_DIR] : []),
  ];
}

/**
 * Returns the environment of claude: RUN_ENV, the PASSED_ENV and LOGIN_ENV variables of `source`,
 * and the login folder.
 */
export function claudeEnv(source: NodeJS.ProcessEnv, configDir: string | undefined): Record<string, string> {
  const env: Record<string, string> = { ...RUN_ENV };
  for (const name of PASSED_ENV) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  for (const name of LOGIN_ENV) {
    const value = source[name]?.replace(/\s+/g, '');
    if (value) env[name] = value;
  }
  if (configDir !== undefined) env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

type ClaudeExit = { stdout: string; stderr: string; code: number | null; timedOut: boolean; wallMs: number };

/** The children that run now, so that a stop can end them. */
const runningChildren = new Set<ReturnType<typeof spawn>>();
/** The temporary folders of the runs that run now, so that a stop can remove them. */
const openTempDirs = new Set<string>();
/** True after stopRuns: no new claude starts, and a run that it ended is invalid. */
let stopping = false;

function runClaude(args: string[], cwd: string, options: RunOptions): Promise<ClaudeExit> {
  if (stopping) return Promise.reject(new Error('the eval was stopped before the run'));
  const env = claudeEnv(process.env, options.configDir);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(options.claudeBin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    runningChildren.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, options.timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      runningChildren.delete(child);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      runningChildren.delete(child);
      resolve({ stdout, stderr, code, timedOut, wallMs: Date.now() - started });
    });
  });
}

/**
 * Stops the runs that run now: SIGTERM to each claude, SIGKILL after `graceMs` to each that still
 * runs, then removes the temporary folders of the runs. No claude starts after it.
 */
export async function stopRuns(graceMs = 3000): Promise<void> {
  stopping = true;
  for (const child of runningChildren) child.kill('SIGTERM');
  const deadline = Date.now() + graceMs;
  while (runningChildren.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const child of runningChildren) child.kill('SIGKILL');
  for (const dir of openTempDirs) rmSync(dir, { recursive: true, force: true });
  openTempDirs.clear();
}

const PROBE_SERVER = fileURLToPath(new URL('./elicitation-probe-server.ts', import.meta.url));

/**
 * Returns the JSON objects of a text with one object per line. Lines that are not JSON objects are
 * skipped.
 */
function jsonLines(text: string): Record<string, any>[] {
  return text.split('\n').flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return typeof value === 'object' && value !== null ? [value as Record<string, any>] : [];
    } catch {
      return [];
    }
  });
}

/** The outcome of one probe run (probeElicitation). */
export type ProbeResult = {
  /** What the person of the probe answers: accept, or decline as in hard-delete-declined. */
  expected: 'accept' | 'decline';
  /** The protocol version that Claude Code asked for at initialize, or null. */
  protocolVersion: string | null;
  /** True when Claude Code told the server at initialize that it can ask the person. */
  canAsk: boolean;
  /** The questions that reached the Elicitation hook, with its answers. */
  hookEntries: ElicitationLogEntry[];
  /** The answers to the question that reached the server: a result or an error. */
  serverAnswers: unknown[];
  /** Empty when the question went from the server through the hook and back. */
  problems: string[];
};

/**
 * Returns the problems of a run of the probe: what did not go from the server through the hook and
 * back.
 */
export function probeProblems(result: Omit<ProbeResult, 'problems'>): string[] {
  const problems: string[] = [];
  if (!result.canAsk) problems.push('Claude Code did not tell the server that it can ask the person (capability elicitation)');
  if (result.hookEntries.length !== 1) {
    problems.push(`the Elicitation hook got ${result.hookEntries.length} questions, not 1`);
  } else if (!result.hookEntries[0]!.message.includes('Webinar Room')) {
    problems.push('the question that reached the hook does not name the Webinar Room');
  }
  const hookAction = result.hookEntries[0]?.action;
  if (hookAction !== undefined && hookAction !== result.expected) {
    problems.push(`the hook answered ${hookAction}, not ${result.expected}`);
  }
  const serverAction = (result.serverAnswers[0] as { answer?: { action?: unknown } } | undefined)?.answer?.action;
  if (serverAction !== result.expected) {
    problems.push(`the server got the answer ${JSON.stringify(result.serverAnswers[0] ?? null)}, not ${result.expected}`);
  }
  return problems;
}

/**
 * Runs claude once with the stub server elicitation-probe-server.ts and the Elicitation hook of
 * the eval, whose person answers `expected`. It shows whether a question of a server reaches the
 * hook in `claude -p` and whether the answer comes back, before a run relies on it.
 */
export async function probeElicitation(
  model: string,
  expected: 'accept' | 'decline',
  options: RunOptions,
): Promise<ProbeResult> {
  const temp = await mkdtemp(join(tmpdir(), 'alfaview-mcp-eval-probe-'));
  openTempDirs.add(temp);
  try {
    const work = join(temp, 'work');
    await mkdir(work);
    const files = {
      mcpConfig: join(temp, 'mcp.json'),
      settings: join(temp, 'settings.json'),
      rules: join(temp, 'elicitation-rules.json'),
      elicitationLog: join(temp, 'elicitations.jsonl'),
      debugLog: join(temp, 'debug.log'),
      probeLog: join(temp, 'probe.jsonl'),
    };
    const server = { type: 'stdio', command: process.execPath, args: [PROBE_SERVER, files.probeLog] };
    await writeFile(files.mcpConfig, JSON.stringify({ mcpServers: { alfaview: server } }, null, 2));
    const rules = expected === 'accept' ? [{ names: 'Webinar Room' }] : [];
    await writeFile(files.rules, JSON.stringify(rules));
    await writeFile(files.settings, JSON.stringify(runSettings(files, options.arm), null, 2));
    const prompt = 'Delete the Webinar Room with the tool of the alfaview server. Call it once, then tell me what the person answered.';
    const exit = await runClaude(claudeArgs(prompt, model, files, options), work, options);
    const lines = jsonLines(await readFile(files.probeLog, 'utf8').catch(() => ''));
    const initialize = lines.find((line) => 'initialize' in line)?.initialize;
    const result = {
      expected,
      protocolVersion: typeof initialize?.protocolVersion === 'string' ? initialize.protocolVersion : null,
      canAsk: typeof initialize?.capabilities?.elicitation === 'object' && initialize.capabilities.elicitation !== null,
      hookEntries: parseElicitationLog(await readFile(files.elicitationLog, 'utf8').catch(() => '')),
      serverAnswers: lines.filter((line) => 'answer' in line),
    };
    const problems = probeProblems(result);
    if (exit.timedOut) problems.unshift(`the probe took longer than ${options.timeoutMs / 1000} s`);
    return { ...result, problems };
  } finally {
    openTempDirs.delete(temp);
    await rm(temp, { recursive: true, force: true });
  }
}

/** Returns the MCP protocol version in the debug log of Claude Code, or null. */
function protocolVersionOf(debugLog: string): string | null {
  return /negotiatedProtocolVersion\W+(\d{4}-\d{2}-\d{2})/.exec(debugLog)?.[1] ?? null;
}

/**
 * Returns the lines of the debug log that name the source of a feature flag of Claude Code, such
 * as "mcp runtime arm: v2 (source: default)" or "act_dont_rederive_arm_active source=growthbook",
 * without their time, each once.
 */
export function featureFlagsOf(debugLog: string): string[] {
  const lines = debugLog
    .split('\n')
    .filter((line) => /source[:=] ?growthbook|\(source: \w+\)/.test(line))
    .map((line) => line.replace(/^\S+\s+\[\w+\]\s+/, '').trim());
  return [...new Set(lines)].sort();
}

/** Returns the run problem of a fault of the task that never fired in the run. */
export function unfiredFaultProblem(fault: FakeFault): string {
  return `the fault ${fault.status} on request ${fault.nth ?? 1} of ${fault.method} ${fault.path.source} never fired, so the run did not test the recovery from it`;
}

export type RunSpec = {
  task: Task;
  model: string;
  /** 1 for the first run of the task with the model. */
  repeat: number;
  /** The folder of the invocation's results. */
  outDir: string;
};

/**
 * Returns the invalid record of a run that the eval could not do, such as when claude does not
 * start.
 */
export function crashedRecord(spec: RunSpec, error: unknown): RunRecord {
  return {
    taskId: spec.task.id,
    level: spec.task.level,
    kind: spec.task.kind,
    model: spec.model,
    repeat: spec.repeat,
    prompt: '',
    startedAt: new Date().toISOString(),
    valid: false,
    invalidReasons: [`the eval could not do the run: ${error instanceof Error ? error.message : String(error)}`],
    runProblems: [],
    passed: false,
    checks: [],
    toolCalls: [],
    modelRequests: null,
    turns: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    costUsd: null,
    durationMs: null,
    wallMs: 0,
    resultSubtype: null,
    finalText: '',
    claudeCodeVersion: null,
    toolsOffered: 0,
    mcpProtocolVersion: null,
    featureFlags: [],
    elicitations: [],
    requestCount: 0,
    writeCount: 0,
    emails: [],
    contractProblems: [],
    exitCode: null,
    timedOut: false,
    streamFile: '',
  };
}

/** Runs `spec` and writes its raw stream and its record into the folder of its model. */
export async function runOne(spec: RunSpec, options: RunOptions): Promise<RunRecord> {
  const { task, model, repeat } = spec;
  const t0 = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
  const clock = clockOf(t0);
  const state = sampleState(t0);
  task.seed?.(state, clock);
  const initial = structuredClone(state);
  const prompt = task.prompt(clock);

  const name = `${task.id}-run${repeat}`;
  const modelDir = join(spec.outDir, model);
  await mkdir(modelDir, { recursive: true });
  const streamFile = join(model, `${name}.stream.jsonl`);

  const api = await startFakeApi(state, { faults: task.faults });
  const temp = await mkdtemp(join(tmpdir(), 'alfaview-mcp-eval-'));
  openTempDirs.add(temp);
  try {
    const work = join(temp, 'work');
    await mkdir(work);
    const files = {
      mcpConfig: join(temp, 'mcp.json'),
      settings: join(temp, 'settings.json'),
      rules: join(temp, 'elicitation-rules.json'),
      elicitationLog: join(temp, 'elicitations.jsonl'),
      debugLog: join(temp, 'debug.log'),
    };
    const launch = serverLaunch({ env: serverEnv(task), fakeApiOrigin: api.origin });
    const config = {
      mcpServers: {
        alfaview: { type: 'stdio', command: launch.command, args: launch.args, env: launch.env },
      },
    };
    await writeFile(files.mcpConfig, JSON.stringify(config, null, 2));
    await writeFile(files.rules, JSON.stringify(task.elicitation ?? []));
    await writeFile(files.settings, JSON.stringify(runSettings(files, options.arm), null, 2));

    const startedAt = new Date().toISOString();
    const exit = await runClaude(claudeArgs(prompt, model, files, options), work, options);
    await writeFile(join(spec.outDir, streamFile), exit.stdout);
    if (exit.stderr.trim() !== '') await writeFile(join(modelDir, `${name}.stderr.txt`), exit.stderr);

    const parsed = parseStream(exit.stdout);
    const debugText = await readFile(files.debugLog, 'utf8').catch(() => '');
    const elicitations = parseElicitationLog(await readFile(files.elicitationLog, 'utf8').catch(() => ''));
    const reasons = invalidReasons(parsed, model, options.arm);
    if (/\[AdvisorTool\]/.test(debugText)) reasons.push('Claude Code enabled the advisor tool');
    if (stopping) reasons.push('the eval was stopped during the run');
    // A run that does not end in time, or ends without its result, counts as a failure: a server
    // that hangs or does not start must lower the success rate, not leave the summary.
    const problems = runProblems(parsed);
    if (exit.timedOut) problems.unshift(`the run took longer than ${options.timeoutMs / 1000} s`);
    // A fault that never fired leaves a task that tests the recovery from an error without the
    // error, such as when a server sends fewer requests than the task expects.
    problems.push(...api.unfiredFaults().map(unfiredFaultProblem));

    const outcome = {
      initial,
      state: api.state,
      requests: api.requests,
      elicitations,
      answer: parsed.finalText,
      clock,
    };
    const checks = runChecks(task.checks, outcome);
    const valid = reasons.length === 0;
    const record: RunRecord = {
      taskId: task.id,
      level: task.level,
      kind: task.kind,
      model,
      repeat,
      prompt,
      startedAt,
      valid,
      invalidReasons: reasons,
      runProblems: problems,
      passed: valid && problems.length === 0 && checks.every((check) => check.passed),
      checks,
      toolCalls: parsed.toolCalls.map(({ name: tool, isError, resultChars, server }) => ({
        name: tool,
        isError,
        resultChars,
        server,
      })),
      modelRequests: parsed.modelRequests,
      turns: parsed.result?.numTurns ?? null,
      tokens: parsed.result?.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      costUsd: parsed.result?.costUsd ?? null,
      durationMs: parsed.result?.durationMs ?? null,
      wallMs: exit.wallMs,
      resultSubtype: parsed.result?.subtype ?? null,
      finalText: parsed.finalText,
      claudeCodeVersion: parsed.init?.claudeCodeVersion ?? null,
      toolsOffered: (parsed.init?.tools ?? []).filter((tool) => tool.startsWith(TOOL_PREFIX)).length,
      mcpProtocolVersion: protocolVersionOf(debugText),
      featureFlags: featureFlagsOf(debugText),
      elicitations,
      requestCount: api.requests.length,
      writeCount: writesOf(api.requests).length,
      emails: emailsOf(outcome),
      contractProblems: contractProblemsOf(api.requests),
      exitCode: exit.code,
      timedOut: exit.timedOut,
      streamFile,
    };
    await writeFile(join(modelDir, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  } finally {
    await api.close();
    openTempDirs.delete(temp);
    await rm(temp, { recursive: true, force: true });
  }
}
