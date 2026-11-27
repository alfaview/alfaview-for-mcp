// The records of the runs, the summary of an invocation, the printed tables and the comparison of
// two summaries.
import { ACCESS_LEVELS } from '../src/levels.ts';
import type { CheckResult } from './checks.ts';
import { EVAL_TIME_ZONE } from './clock.ts';
import type { ElicitationLogEntry } from './elicitation.ts';
import { LIMIT_SUBTYPE_PREFIX, type Tokens } from './stream.ts';

/** What the eval keeps of one run of one task with one model. */
export type RunRecord = {
  taskId: string;
  level: string;
  kind: string;
  model: string;
  /** 1 for the first run of the task with the model. */
  repeat: number;
  prompt: string;
  startedAt: string;
  /** False when a cause outside the server spoiled the run, see invalidReasons of stream.ts. */
  valid: boolean;
  invalidReasons: string[];
  /** Problems that make a valid run fail, such as a timeout or a fault that never fired. */
  runProblems: string[];
  /** True when the run is valid, has no run problem, and every check passed. */
  passed: boolean;
  checks: CheckResult[];
  /**
   * The tool calls. `server` is false for a tool of Claude Code, such as Skill or Read in the arms
   * plain and skill. A record without `server` holds only calls of the server.
   */
  toolCalls: { name: string; isError: boolean; resultChars: number | null; server?: boolean }[];
  /** The requests to the model: the distinct message IDs of the assistant events. */
  modelRequests: number | null;
  /** num_turns of Claude Code: the tool calls plus one. */
  turns: number | null;
  tokens: Tokens;
  costUsd: number | null;
  /** The duration that Claude Code reports. */
  durationMs: number | null;
  /** The time from the start of claude to its exit. */
  wallMs: number;
  resultSubtype: string | null;
  finalText: string;
  claudeCodeVersion: string | null;
  /** The number of alfaview tools that the model got. */
  toolsOffered: number;
  /** The MCP protocol version that Claude Code and the server agreed on, from the debug log. */
  mcpProtocolVersion: string | null;
  /** The feature flags of Claude Code with their source, from the debug log (featureFlagsOf). */
  featureFlags: string[];
  /** The questions of the server to the person (MCP elicitation) and the answers of the hook. */
  elicitations: ElicitationLogEntry[];
  /** The count of the requests that reached the fake API, the login included. */
  requestCount: number;
  writeCount: number;
  /** The requests with which alfaview would email someone (checks.ts, emailsOf). */
  emails: string[];
  /** The requests that do not fit spec/openapi-v2.json: a problem of the server, not the model. */
  contractProblems: string[];
  exitCode: number | null;
  timedOut: boolean;
  /** The file of the raw stream, relative to the folder of the summary. */
  streamFile: string;
};

export type Means = {
  /** The calls of the tools of the server. */
  toolCalls: number;
  /** The calls of the tools of Claude Code, such as Skill, Read and ToolSearch. */
  clientCalls: number;
  /** The results of the tools of the server that were errors. */
  errorResults: number;
  modelRequests: number;
  turns: number;
  /** Input tokens with the cache reads and writes. */
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationS: number;
};

/**
 * The input tokens for each model request at one access level, over the valid runs of the level
 * with at least one model request (levelTokensOf).
 */
export type LevelTokens = {
  level: string;
  runs: number;
  /** The model requests of those runs. */
  modelRequests: number;
  /**
   * The input tokens of each run divided by its model requests, then the mean of the runs: the
   * method of item 5 of the acceptance bar (README.md). Null without a run.
   */
  meanOfRuns: number | null;
  /** The input tokens of all the runs divided by all their model requests. Null without a run. */
  pooled: number | null;
};

/** The questions of the server to the person in the valid runs of a task (questionsOf). */
export type Questions = {
  /** The answers of the person to those questions. */
  accept: number;
  decline: number;
  cancel: number;
  /** The questions of each valid run, in the order of the repeats. */
  perRun: number[];
};

export type TaskSummary = {
  taskId: string;
  level: string;
  kind: string;
  /** The valid runs. */
  runs: number;
  passed: number;
  invalid: number;
  means: Means;
  questions: Questions;
};

export type ModelSummary = {
  model: string;
  /** The valid runs. */
  runs: number;
  passed: number;
  invalid: number;
  /** passed / runs, or null without a valid run. */
  successRate: number | null;
  means: Means;
  /** The input tokens for each model request at each level that the runs have. */
  levels: LevelTokens[];
  totalCostUsd: number;
  tasks: TaskSummary[];
  /** The failed checks and the run problems of the valid runs. */
  failedChecks: { taskId: string; repeat: number; reason: string }[];
  invalidRuns: { taskId: string; repeat: number; reasons: string[] }[];
  /** The valid runs that ended on a limit of the run (endedOnLimit), with the result subtype. */
  limitRuns: { taskId: string; repeat: number; subtype: string }[];
};

export type Summary = {
  label: string;
  startedAt: string;
  finishedAt: string;
  options: Record<string, unknown>;
  environment: Record<string, unknown>;
  models: ModelSummary[];
  runs: RunRecord[];
};

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Returns the input tokens of a run with the cache reads and writes. */
function inputTokensOf(record: RunRecord): number {
  return record.tokens.input + record.tokens.cacheRead + record.tokens.cacheCreation;
}

/**
 * Returns true when a run ended on a limit of the run, such as --max-turns or --max-budget-usd.
 * Such a run counts, has no run problem (runProblems of stream.ts), and fails each check that it
 * did not meet up to the limit.
 */
export function endedOnLimit(record: RunRecord): boolean {
  return (record.resultSubtype ?? '').startsWith(LIMIT_SUBTYPE_PREFIX);
}

/** Returns the calls of the tools of the server in a record (RunRecord.toolCalls). */
function serverCallsOf(record: RunRecord): RunRecord['toolCalls'] {
  return record.toolCalls.filter((call) => call.server !== false);
}

/** Returns the means over the valid runs of `records`, each 0 without a valid run. */
export function meansOf(records: readonly RunRecord[]): Means {
  const valid = records.filter((record) => record.valid);
  return {
    toolCalls: mean(valid.map((record) => serverCallsOf(record).length)),
    clientCalls: mean(valid.map((record) => record.toolCalls.length - serverCallsOf(record).length)),
    errorResults: mean(valid.map((record) => serverCallsOf(record).filter((call) => call.isError).length)),
    modelRequests: mean(valid.map((record) => record.modelRequests ?? 0)),
    turns: mean(valid.map((record) => record.turns ?? 0)),
    inputTokens: mean(valid.map(inputTokensOf)),
    outputTokens: mean(valid.map((record) => record.tokens.output)),
    costUsd: mean(valid.map((record) => record.costUsd ?? 0)),
    durationS: mean(valid.map((record) => (record.durationMs ?? record.wallMs) / 1000)),
  };
}

/** Returns the place of a level in ACCESS_LEVELS. A level that is not there comes last. */
function levelRank(level: string): number {
  const rank = (ACCESS_LEVELS as readonly string[]).indexOf(level);
  return rank === -1 ? ACCESS_LEVELS.length : rank;
}

/**
 * Returns the input tokens for each model request at each level of `records`, from `read` to
 * `full`, by two methods (LevelTokens). Each counts only the valid runs with a model request. The
 * two methods differ most at `read`, where the runs have few model requests, because a run with
 * more model requests weighs more in the pooled figure.
 */
export function levelTokensOf(records: readonly RunRecord[]): LevelTokens[] {
  const levels = [...new Set(records.map((record) => record.level))].sort((x, y) => levelRank(x) - levelRank(y));
  return levels.map((level) => {
    const runs = records.filter((record) => record.level === level && record.valid && (record.modelRequests ?? 0) > 0);
    const modelRequests = runs.reduce((sum, record) => sum + (record.modelRequests ?? 0), 0);
    const none = runs.length === 0;
    return {
      level,
      runs: runs.length,
      modelRequests,
      meanOfRuns: none ? null : mean(runs.map((record) => inputTokensOf(record) / (record.modelRequests ?? 1))),
      pooled: none ? null : runs.reduce((sum, record) => sum + inputTokensOf(record), 0) / modelRequests,
    };
  });
}

/**
 * Returns the server's questions to the person in the valid runs of `records`, with the answers.
 * The Elicitation hook of the eval answers accept or decline only, and it writes each question
 * with its answer to the log of the run. An answer that Claude Code gives without the hook, such
 * as cancel, does not reach that log.
 */
export function questionsOf(records: readonly RunRecord[]): Questions {
  const valid = records.filter((record) => record.valid).sort((x, y) => x.repeat - y.repeat);
  const entries = valid.flatMap((record) => record.elicitations ?? []);
  const answers = (action: string) => entries.filter((entry) => String(entry.action) === action).length;
  return {
    accept: answers('accept'),
    decline: answers('decline'),
    cancel: answers('cancel'),
    perRun: valid.map((record) => (record.elicitations ?? []).length),
  };
}

/** Returns the summary of each model in `models`, in that order, over `records`. */
export function summarize(records: readonly RunRecord[], models: readonly string[]): ModelSummary[] {
  return models.map((model) => {
    const own = records.filter((record) => record.model === model);
    const valid = own.filter((record) => record.valid);
    const passed = valid.filter((record) => record.passed).length;
    const taskIds = [...new Set(own.map((record) => record.taskId))];
    return {
      model,
      runs: valid.length,
      passed,
      invalid: own.length - valid.length,
      successRate: valid.length === 0 ? null : passed / valid.length,
      means: meansOf(own),
      levels: levelTokensOf(own),
      totalCostUsd: own.reduce((sum, record) => sum + (record.costUsd ?? 0), 0),
      tasks: taskIds.map((taskId) => {
        const runs = own.filter((record) => record.taskId === taskId);
        const first = runs[0]!;
        const validRuns = runs.filter((record) => record.valid);
        return {
          taskId,
          level: first.level,
          kind: first.kind,
          runs: validRuns.length,
          passed: validRuns.filter((record) => record.passed).length,
          invalid: runs.length - validRuns.length,
          means: meansOf(runs),
          questions: questionsOf(runs),
        };
      }),
      failedChecks: valid.flatMap((record) => [
        ...(record.runProblems ?? []).map((problem) => ({
          taskId: record.taskId,
          repeat: record.repeat,
          reason: `Run problem: ${problem}`,
        })),
        ...record.checks
          .filter((check) => !check.passed)
          .map((check) => ({ taskId: record.taskId, repeat: record.repeat, reason: check.reason })),
      ]),
      invalidRuns: own
        .filter((record) => !record.valid)
        .map((record) => ({ taskId: record.taskId, repeat: record.repeat, reasons: record.invalidReasons })),
      limitRuns: valid
        .filter(endedOnLimit)
        .map((record) => ({ taskId: record.taskId, repeat: record.repeat, subtype: String(record.resultSubtype) })),
    };
  });
}

// Text output

/** Returns the rows as columns: the first column aligned to the left, the others to the right. */
export function table(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => (widths[index] = Math.max(widths[index] ?? 0, cell.length)));
  }
  return rows.map((row) =>
    row
      .map((cell, index) => (index === 0 ? cell.padEnd(widths[index]!) : cell.padStart(widths[index]!)))
      .join('  ')
      .trimEnd(),
  );
}

const fixed = (value: number, digits: number) => value.toFixed(digits);
export const whole = (value: number) => Math.round(value).toLocaleString('en-US');
const percent = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const tokensCell = (value: number | null) => (value === null ? 'n/a' : whole(value));

/** Returns the questions of each run, then the answers that were given, as "1 1 1: 3 accept". */
export function questionsText(questions: Questions): string {
  if (questions.perRun.length === 0) return 'no valid run';
  const answers = (['accept', 'decline', 'cancel'] as const)
    .filter((action) => questions[action] > 0)
    .map((action) => `${questions[action]} ${action}`);
  return `${questions.perRun.join(' ')}${answers.length > 0 ? `: ${answers.join(', ')}` : ''}`;
}

const LEVEL_NOTE = [
  '"mean of runs" divides the input tokens of each run by its model requests and takes the mean of',
  'the runs of the level: the method that item 5 of the bar uses (eval/README.md).',
  '"pooled" divides all the input tokens of the level by all its model requests.',
];

/** The heading of the list of the valid runs that ended on a limit of the run. */
const LIMIT_HEADING = 'Runs that ended on a limit (they count):';

const MEAN_HEADERS = ['calls', 'client calls', 'errors', 'requests', 'cc turns', 'in tok', 'out tok', 'cost $', 'time s'];

function meanCells(means: Means): string[] {
  return [
    fixed(means.toolCalls, 1),
    fixed(means.clientCalls, 1),
    fixed(means.errorResults, 1),
    fixed(means.modelRequests, 1),
    fixed(means.turns, 1),
    whole(means.inputTokens),
    whole(means.outputTokens),
    fixed(means.costUsd, 4),
    fixed(means.durationS, 1),
  ];
}

/**
 * Returns the report of one model: a row per task and a row for all tasks, then the input tokens
 * by level, the questions to the person, the failed checks and the invalid runs.
 */
export function modelReport(summary: ModelSummary): string[] {
  const lines = [
    `${summary.model}: ${summary.passed} of ${summary.runs} valid runs passed (${percent(summary.successRate)}), ${summary.invalid} invalid, ${summary.limitRuns.length} ended on a limit, total cost $${summary.totalCostUsd.toFixed(4)}`,
    '',
  ];
  const rows = [
    ['task', 'level', 'pass', ...MEAN_HEADERS],
    ...summary.tasks.map((task) => [
      task.taskId,
      task.level,
      `${task.passed}/${task.runs}${task.invalid > 0 ? ` (+${task.invalid} invalid)` : ''}`,
      ...meanCells(task.means),
    ]),
    ['all tasks', '', `${summary.passed}/${summary.runs}`, ...meanCells(summary.means)],
  ];
  lines.push(...table(rows));
  lines.push(
    '',
    'Means are per valid run. "calls" counts the calls of the tools of the server, "client calls" the',
    'calls of the tools of Claude Code (such as Skill, Read and ToolSearch), "errors" the results of the',
    'tools of the server that were errors, "requests" the requests to the model, and "cc turns" the',
    'turns of Claude Code (all tool calls plus one).',
  );
  lines.push(
    '',
    'Input tokens for each model request, by level (valid runs with a model request):',
    ...table([
      ['level', 'runs', 'requests', 'mean of runs', 'pooled'],
      ...summary.levels.map((level) => [
        level.level,
        String(level.runs),
        String(level.modelRequests),
        tokensCell(level.meanOfRuns),
        tokensCell(level.pooled),
      ]),
    ]).map((line) => `  ${line}`),
    ...LEVEL_NOTE,
  );
  const asking = summary.tasks.filter((task) => task.questions.perRun.some((count) => count > 0));
  if (asking.length === 0) {
    lines.push('', 'Questions to the person: none in the valid runs.');
  } else {
    lines.push('', 'Questions to the person (the questions of each valid run, then the answers):');
    for (const task of asking) lines.push(`  - ${task.taskId}: ${questionsText(task.questions)}`);
  }
  if (summary.limitRuns.length > 0) {
    lines.push('', LIMIT_HEADING);
    for (const run of summary.limitRuns) lines.push(`  - ${run.taskId} run ${run.repeat}: ${run.subtype}`);
  }
  if (summary.failedChecks.length > 0) {
    lines.push('', 'Failed checks:');
    for (const failed of summary.failedChecks) {
      lines.push(`  - ${failed.taskId} run ${failed.repeat}: ${failed.reason}`);
    }
  }
  if (summary.invalidRuns.length > 0) {
    lines.push('', 'Invalid runs (not counted):');
    for (const run of summary.invalidRuns) {
      lines.push(`  - ${run.taskId} run ${run.repeat}: ${run.reasons.join('; ')}`);
    }
  }
  return lines;
}

// Comparison

function signed(value: number, digits: number, unit = ''): string {
  const text = value.toFixed(digits);
  return `${value > 0 ? '+' : ''}${text}${unit}`;
}

const MEAN_ROWS: { key: keyof Means; label: string; digits: number }[] = [
  { key: 'toolCalls', label: 'tool calls', digits: 2 },
  { key: 'clientCalls', label: 'client calls', digits: 2 },
  { key: 'errorResults', label: 'error results', digits: 2 },
  { key: 'modelRequests', label: 'model requests', digits: 2 },
  { key: 'turns', label: 'cc turns', digits: 2 },
  { key: 'inputTokens', label: 'input tokens', digits: 0 },
  { key: 'outputTokens', label: 'output tokens', digits: 0 },
  { key: 'costUsd', label: 'cost USD', digits: 4 },
  { key: 'durationS', label: 'time s', digits: 1 },
];

/** The options that change what a run measures. The comparison warns when one differs. */
export const COMPARED_OPTIONS = ['tasks', 'repeat', 'effort', 'maxTurns', 'maxBudgetUsd', 'timeoutS'];

/** Environment values that change what a run measures. The comparison warns when one differs. */
const COMPARED_ENVIRONMENT: { key: string; label: string }[] = [
  { key: 'claudeCodeVersions', label: 'the versions of Claude Code' },
  { key: 'featureFlags', label: 'the feature flags of Claude Code' },
  // The questions of the server to the person go another way in another protocol version.
  { key: 'mcpProtocolVersions', label: 'the MCP protocol versions' },
];

/** Returns the arm of a summary (runner.ts). A summary without `options.arm` ran the arm server. */
export function armOf(summary: Summary): string {
  return String(summary.options.arm ?? 'server');
}

/** Returns the day of an ISO time in Berlin time, as 2026-10-28. */
function berlinDay(time: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: EVAL_TIME_ZONE }).format(new Date(time));
}

/**
 * Returns `prompt` with a placeholder for each weekday, month name and number. Prompts of the runs
 * of two days then compare equal, and only a change of the text of a task makes them differ.
 */
export function promptShape(prompt: string): string {
  return prompt
    .replace(/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/g, '<day>')
    .replace(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/g, '<month>')
    .replace(/\d+/g, '<n>');
}

/**
 * Returns the tasks that both summaries ran, but with prompts that differ in more than their dates
 * and times.
 */
function tasksWithOtherPrompts(a: Summary, b: Summary): string[] {
  const shapes = (summary: Summary, taskId: string) =>
    new Set(summary.runs.filter((run) => run.taskId === taskId && run.prompt !== '').map((run) => promptShape(run.prompt)));
  const taskIds = [...new Set(a.runs.map((run) => run.taskId))].filter((taskId) => b.runs.some((run) => run.taskId === taskId));
  return taskIds.filter((taskId) => {
    const shapesA = shapes(a, taskId);
    const shapesB = shapes(b, taskId);
    return shapesA.size > 0 && shapesB.size > 0 && ![...shapesA].some((shape) => shapesB.has(shape));
  });
}

/** Returns the IDs of the tasks with at least one valid run of `model` in `summary`. */
function tasksWithValidRuns(summary: Summary, model: string): Set<string> {
  return new Set(
    summary.runs.filter((record) => record.model === model && record.valid).map((record) => record.taskId),
  );
}

/**
 * Returns the IDs of the tasks with valid runs of `model` in both summaries, in the order of `a`.
 */
export function pairedTaskIds(a: Summary, b: Summary, model: string): string[] {
  const validB = tasksWithValidRuns(b, model);
  return [...tasksWithValidRuns(a, model)].filter((taskId) => validB.has(taskId));
}

/**
 * Returns the change from `before` to `after` in percent, as "-15.9%", or n/a when a value is
 * missing or `before` is 0.
 */
function percentChange(before: number | null | undefined, after: number | null | undefined): string {
  if (before === null || before === undefined || after === null || after === undefined || before === 0) return 'n/a';
  return signed(((after - before) / before) * 100, 1, '%');
}

/**
 * Returns the table of the input tokens for each model request by level, of two paired summaries
 * of a model.
 */
function levelComparison(a: Summary, b: Summary, pairedA: ModelSummary, pairedB: ModelSummary): string[] {
  const levels = [...new Set([...pairedA.levels, ...pairedB.levels].map((level) => level.level))].sort(
    (x, y) => levelRank(x) - levelRank(y),
  );
  if (levels.length === 0) return [];
  const rows = [['level', a.label, b.label, 'change', `pooled ${a.label}`, `pooled ${b.label}`, 'change']];
  for (const level of levels) {
    const before = pairedA.levels.find((item) => item.level === level);
    const after = pairedB.levels.find((item) => item.level === level);
    rows.push([
      level,
      tokensCell(before?.meanOfRuns ?? null),
      tokensCell(after?.meanOfRuns ?? null),
      percentChange(before?.meanOfRuns, after?.meanOfRuns),
      tokensCell(before?.pooled ?? null),
      tokensCell(after?.pooled ?? null),
      percentChange(before?.pooled, after?.pooled),
    ]);
  }
  return [
    '',
    'Input tokens for each model request, by level, over the paired tasks: the mean of runs, then pooled.',
    ...table(rows).map((line) => `  ${line}`),
    ...LEVEL_NOTE,
  ];
}

/**
 * Returns the questions to the person of each paired task that asked in one of two paired
 * summaries of a model.
 */
function questionComparison(a: Summary, b: Summary, pairedA: ModelSummary, pairedB: ModelSummary): string[] {
  const questionsIn = (summary: ModelSummary, taskId: string) =>
    summary.tasks.find((task) => task.taskId === taskId)?.questions;
  const asking = pairedA.tasks
    .map((task) => task.taskId)
    .filter((taskId) =>
      [pairedA, pairedB].some((summary) => (questionsIn(summary, taskId)?.perRun ?? []).some((count) => count > 0)),
    );
  if (asking.length === 0) return ['', 'Questions to the person: none in the valid runs of the paired tasks.'];
  const cell = (questions: Questions | undefined) => (questions === undefined ? 'none' : questionsText(questions));
  return [
    '',
    'Questions to the person (the questions of each valid run, then the answers):',
    ...table([
      ['task', a.label, b.label],
      ...asking.map((taskId) => [taskId, cell(questionsIn(pairedA, taskId)), cell(questionsIn(pairedB, taskId))]),
    ]).map((line) => `  ${line}`),
  ];
}

/**
 * Returns the differences from summary `a` to summary `b`, per model that both have. The success
 * rate and the means of a model are paired: they cover only the tasks with valid runs in both
 * summaries, so that a task that one summary lacks, or whose runs are all invalid on one side,
 * does not move them.
 */
export function compareSummaries(a: Summary, b: Summary): string[] {
  const head = (summary: Summary) =>
    `${summary.label} (the arm ${armOf(summary)}, ${summary.startedAt}, ${summary.runs.length} runs)`;
  const lines = [`Compare ${head(a)} with ${head(b)}`];
  for (const { key, label } of COMPARED_ENVIRONMENT) {
    const valueA = JSON.stringify(a.environment[key] ?? null);
    const valueB = JSON.stringify(b.environment[key] ?? null);
    if (valueA !== valueB) lines.push(`Warning: ${label} differ: ${valueA} and ${valueB}.`);
  }
  for (const key of COMPARED_OPTIONS) {
    const valueA = JSON.stringify(a.options[key] ?? null);
    const valueB = JSON.stringify(b.options[key] ?? null);
    if (valueA !== valueB) lines.push(`Warning: the option ${key} differs: ${valueA} and ${valueB}.`);
  }
  const [dayA, dayB] = [berlinDay(a.startedAt), berlinDay(b.startedAt)];
  if (dayA !== dayB) {
    lines.push(
      `Warning: the summaries started on other days, ${dayA} and ${dayB}. The prompts name other dates, and a task in New York time can get another gap between New York and Berlin. Compare runs of one day, or at least of one period of daylight saving time in Europe and the USA.`,
    );
  }
  const otherPrompts = tasksWithOtherPrompts(a, b);
  if (otherPrompts.length > 0) {
    lines.push(`Warning: the prompts of these tasks differ in more than their dates and times: ${otherPrompts.join(', ')}.`);
  }

  for (const modelA of a.models) {
    const modelB = b.models.find((item) => item.model === modelA.model);
    if (modelB === undefined) {
      lines.push('', `${modelA.model}: only in ${a.label}`);
      continue;
    }
    const model = modelA.model;
    const paired = pairedTaskIds(a, b, model);
    const pairedOf = (summary: Summary) =>
      summarize(
        summary.runs.filter((record) => record.model === model && paired.includes(record.taskId)),
        [model],
      )[0]!;
    const pairedA = pairedOf(a);
    const pairedB = pairedOf(b);
    const none = paired.length === 0;
    // From the runs, because a model of a summary can lack `limitRuns`.
    const limitRunsOf = (summary: Summary) =>
      summary.runs.filter((record) => record.model === model && record.valid && endedOnLimit(record));
    const [limitedA, limitedB] = [limitRunsOf(a), limitRunsOf(b)];

    lines.push('', `${model}: paired over ${paired.length} tasks with valid runs in both`);
    const rows = [
      ['metric', a.label, b.label, 'change'],
      [
        'valid runs',
        String(modelA.runs),
        String(modelB.runs),
        signed(modelB.runs - modelA.runs, 0),
      ],
      [
        'invalid runs',
        String(modelA.invalid),
        String(modelB.invalid),
        signed(modelB.invalid - modelA.invalid, 0),
      ],
      [
        'runs on a limit',
        String(limitedA.length),
        String(limitedB.length),
        signed(limitedB.length - limitedA.length, 0),
      ],
      [
        'success rate',
        percent(pairedA.successRate),
        percent(pairedB.successRate),
        pairedA.successRate === null || pairedB.successRate === null
          ? 'n/a'
          : signed((pairedB.successRate - pairedA.successRate) * 100, 1, ' pts'),
      ],
      ...MEAN_ROWS.map(({ key, label, digits }) =>
        none
          ? [label, 'n/a', 'n/a', 'n/a']
          : [
              label,
              pairedA.means[key].toFixed(digits),
              pairedB.means[key].toFixed(digits),
              signed(pairedB.means[key] - pairedA.means[key], digits),
            ],
      ),
    ];
    lines.push(...table(rows));
    if (limitedA.length + limitedB.length > 0) {
      const limitLine = (label: string, record: RunRecord) =>
        `  ${label}: ${record.taskId} run ${record.repeat}: ${record.resultSubtype}`;
      lines.push(
        '',
        LIMIT_HEADING,
        ...limitedA.map((record) => limitLine(a.label, record)),
        ...limitedB.map((record) => limitLine(b.label, record)),
      );
    }
    lines.push(...levelComparison(a, b, pairedA, pairedB), ...questionComparison(a, b, pairedA, pairedB));

    const unpaired = [...new Set([...modelA.tasks, ...modelB.tasks].map((task) => task.taskId))].filter(
      (taskId) => !paired.includes(taskId),
    );
    if (unpaired.length > 0) {
      lines.push('', `Not paired (no valid run in one summary): ${unpaired.join(', ')}`);
    }

    const changed: string[][] = [];
    for (const taskB of modelB.tasks) {
      const taskA = modelA.tasks.find((item) => item.taskId === taskB.taskId);
      const before = taskA === undefined ? 'none' : `${taskA.passed}/${taskA.runs}`;
      const after = `${taskB.passed}/${taskB.runs}`;
      const rateA = taskA === undefined || taskA.runs === 0 ? null : taskA.passed / taskA.runs;
      const rateB = taskB.runs === 0 ? null : taskB.passed / taskB.runs;
      if (rateA !== rateB) changed.push([`  ${taskB.taskId}`, before, after]);
    }
    for (const taskA of modelA.tasks) {
      if (!modelB.tasks.some((item) => item.taskId === taskA.taskId)) {
        changed.push([`  ${taskA.taskId}`, `${taskA.passed}/${taskA.runs}`, 'none']);
      }
    }
    if (changed.length > 0) {
      lines.push('', 'Tasks whose pass rate changed:', ...table(changed));
    }
  }
  for (const modelB of b.models) {
    if (!a.models.some((item) => item.model === modelB.model)) {
      lines.push('', `${modelB.model}: only in ${b.label}`);
    }
  }
  return lines;
}
