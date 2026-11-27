// The summary, the tables and the comparison of the model eval (eval/report.ts).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compareSummaries,
  endedOnLimit,
  levelTokensOf,
  meansOf,
  modelReport,
  pairedTaskIds,
  promptShape,
  questionsOf,
  questionsText,
  summarize,
  table,
  type RunRecord,
  type Summary,
} from '../../eval/report.ts';

function record(fields: Partial<RunRecord>): RunRecord {
  return {
    taskId: 'read-room-passcode',
    level: 'read',
    kind: 'read',
    model: 'claude-haiku-5-5',
    repeat: 1,
    prompt: 'What is the passcode?',
    startedAt: '2026-10-28T09:00:00.000Z',
    valid: true,
    invalidReasons: [],
    runProblems: [],
    passed: true,
    checks: [{ reason: 'The answer gives the passcode', kind: 'answer', passed: true }],
    toolCalls: [
      { name: 'find_rooms', isError: false, resultChars: 100 },
      { name: 'get_room', isError: false, resultChars: 50 },
    ],
    modelRequests: 2,
    turns: 3,
    tokens: { input: 10, output: 200, cacheRead: 1000, cacheCreation: 500 },
    costUsd: 0.01,
    durationMs: 4000,
    wallMs: 5000,
    resultSubtype: 'success',
    finalText: 'Kx7#mQ2p',
    claudeCodeVersion: '2.1.312',
    toolsOffered: 9,
    mcpProtocolVersion: '2025-11-25',
    featureFlags: [],
    elicitations: [],
    requestCount: 3,
    writeCount: 0,
    emails: [],
    contractProblems: [],
    exitCode: 0,
    timedOut: false,
    streamFile: 'claude-haiku-5-5/read-room-passcode-run1.stream.jsonl',
    ...fields,
  };
}

const FAILED = record({
  repeat: 2,
  passed: false,
  checks: [{ reason: 'The answer gives the passcode', kind: 'answer', passed: false }],
  toolCalls: [{ name: 'find_rooms', isError: true, resultChars: 30 }],
  modelRequests: 4,
  turns: 5,
  tokens: { input: 30, output: 400, cacheRead: 3000, cacheCreation: 1500 },
  costUsd: 0.03,
  durationMs: null,
  wallMs: 8000,
});

const INVALID = record({
  repeat: 3,
  valid: false,
  passed: false,
  invalidReasons: ['rate limit rejected'],
  costUsd: 0.5,
});

const TIMED_OUT = record({
  repeat: 4,
  passed: false,
  runProblems: ['the run took longer than 300 s', 'Claude Code sent no result event'],
  timedOut: true,
});

function summaryOf(
  label: string,
  records: RunRecord[],
  environment: Record<string, unknown> = {},
  options: Record<string, unknown> = {},
): Summary {
  return {
    label,
    startedAt: '2026-10-28T09:00:00.000Z',
    finishedAt: '2026-10-28T09:10:00.000Z',
    options: {
      tasks: [...new Set(records.map((item) => item.taskId))],
      repeat: 1,
      effort: 'medium',
      maxTurns: 15,
      maxBudgetUsd: 0.5,
      timeoutS: 300,
      ...options,
    },
    environment: { claudeCodeVersions: ['2.1.312'], featureFlags: [], ...environment },
    models: summarize(records, ['claude-haiku-5-5']),
    runs: records,
  };
}

describe('the summary of the eval', () => {
  it('counts the valid runs, and takes the means over them only', () => {
    const [summary] = summarize([record({}), FAILED, INVALID], ['claude-haiku-5-5']);
    assert.ok(summary);
    assert.equal(summary.runs, 2);
    assert.equal(summary.passed, 1);
    assert.equal(summary.invalid, 1);
    assert.equal(summary.successRate, 0.5);
    assert.deepEqual(summary.means, {
      toolCalls: 1.5,
      clientCalls: 0,
      errorResults: 0.5,
      modelRequests: 3,
      turns: 4,
      inputTokens: (1510 + 4530) / 2,
      outputTokens: 300,
      costUsd: 0.02,
      durationS: (4 + 8) / 2,
    });
    assert.equal(summary.totalCostUsd, 0.54);
    assert.deepEqual(summary.failedChecks, [
      { taskId: 'read-room-passcode', repeat: 2, reason: 'The answer gives the passcode' },
    ]);
    assert.deepEqual(summary.invalidRuns, [
      { taskId: 'read-room-passcode', repeat: 3, reasons: ['rate limit rejected'] },
    ]);
    assert.equal(summary.tasks.length, 1);
    assert.equal(summary.tasks[0]?.invalid, 1);
  });

  it('counts a run with a run problem, such as a timeout, as a valid run that failed', () => {
    const [summary] = summarize([record({}), TIMED_OUT], ['claude-haiku-5-5']);
    assert.equal(summary?.runs, 2);
    assert.equal(summary?.passed, 1);
    assert.equal(summary?.successRate, 0.5);
    assert.deepEqual(summary?.failedChecks, [
      { taskId: 'read-room-passcode', repeat: 4, reason: 'Run problem: the run took longer than 300 s' },
      { taskId: 'read-room-passcode', repeat: 4, reason: 'Run problem: Claude Code sent no result event' },
    ]);
  });

  it('gives no success rate and means of 0 without a valid run', () => {
    const [summary] = summarize([INVALID], ['claude-haiku-5-5', 'claude-sonnet-5-5']);
    assert.equal(summary?.successRate, null);
    assert.equal(meansOf([INVALID]).toolCalls, 0);
    assert.deepEqual(summarize([], ['claude-sonnet-5-5'])[0]?.tasks, []);
    assert.equal(meansOf([record({ modelRequests: null, turns: null, costUsd: null })]).modelRequests, 0);
  });

  it('prints a table per model with the failed checks and the invalid runs', () => {
    const [summary] = summarize([record({}), FAILED, INVALID], ['claude-haiku-5-5']);
    const text = modelReport(summary!).join('\n');
    assert.match(text, /^claude-haiku-5-5: 1 of 2 valid runs passed \(50\.0%\), 1 invalid, 0 ended on a limit, total cost \$0\.5400/);
    assert.match(text, /task\s+level\s+pass\s+calls\s+client calls\s+errors\s+requests\s+cc turns\s+in tok/);
    assert.match(
      text,
      /read-room-passcode\s+read\s+1\/2 \(\+1 invalid\)\s+1\.5\s+0\.0\s+0\.5\s+3\.0\s+4\.0\s+3,020\s+300\s+0\.0200\s+6\.0/,
    );
    assert.match(text, /all tasks\s+1\/2/);
    assert.match(text, /Failed checks:\n {2}- read-room-passcode run 2: The answer gives the passcode/);
    assert.match(text, /Invalid runs \(not counted\):\n {2}- read-room-passcode run 3: rate limit rejected/);
    assert.doesNotMatch(modelReport(summarize([record({})], ['claude-haiku-5-5'])[0]!).join('\n'), /Failed checks/);
  });

  it('counts only the calls of the server as tool calls, and the calls of the tools of Claude Code apart', () => {
    const withSkill = record({
      toolCalls: [
        { name: 'Skill', isError: false, resultChars: 47, server: false },
        { name: 'Read', isError: true, resultChars: 20, server: false },
        { name: 'ToolSearch', isError: false, resultChars: 0, server: false },
        { name: 'find_rooms', isError: false, resultChars: 100, server: true },
        { name: 'get_room', isError: true, resultChars: 50, server: true },
      ],
    });
    const means = meansOf([withSkill, record({})]);
    // The record without the field server has two calls of the server.
    assert.equal(means.toolCalls, (2 + 2) / 2);
    assert.equal(means.clientCalls, (3 + 0) / 2);
    assert.equal(means.errorResults, (1 + 0) / 2);
    const text = modelReport(summarize([withSkill], ['claude-haiku-5-5'])[0]!).join('\n');
    assert.match(text, /read-room-passcode\s+read\s+1\/1\s+2\.0\s+3\.0\s+1\.0\s/);
    assert.match(text, /"calls" counts the calls of the tools of the server, "client calls" the\ncalls of the tools of Claude Code/);
  });

  it('counts and lists the valid runs that ended on a limit of the run', () => {
    const turns = record({ repeat: 2, passed: false, resultSubtype: 'error_max_turns' });
    const budget = record({ taskId: 'meeting-create', resultSubtype: 'error_max_budget_usd' });
    const invalid = { ...INVALID, resultSubtype: 'error_max_turns' };
    assert.equal(endedOnLimit(turns), true);
    assert.equal(endedOnLimit(record({ resultSubtype: null })), false);
    const [summary] = summarize([record({}), turns, budget, invalid], ['claude-haiku-5-5']);
    assert.deepEqual(summary?.limitRuns, [
      { taskId: 'read-room-passcode', repeat: 2, subtype: 'error_max_turns' },
      { taskId: 'meeting-create', repeat: 1, subtype: 'error_max_budget_usd' },
    ]);
    const text = modelReport(summary!).join('\n');
    assert.match(text, /, 1 invalid, 2 ended on a limit, total cost/);
    assert.match(
      text,
      /Runs that ended on a limit \(they count\):\n {2}- read-room-passcode run 2: error_max_turns\n {2}- meeting-create run 1: error_max_budget_usd/,
    );
    assert.doesNotMatch(modelReport(summarize([record({})], ['claude-haiku-5-5'])[0]!).join('\n'), /Runs that ended on a limit/);
  });

  it('aligns the first column to the left and the others to the right', () => {
    assert.deepEqual(table([['a', '1'], ['long', '100']]), ['a       1', 'long  100']);
  });
});

describe('the comparison of two summaries', () => {
  it('prints the counts, the paired change of each metric and the tasks whose pass rate changed', () => {
    const before = summaryOf('baseline', [FAILED, record({ taskId: 'neg-delete-vague', passed: true })]);
    const after = summaryOf('after', [record({}), record({ taskId: 'meeting-create' })], {
      claudeCodeVersions: ['2.1.320'],
    });
    const text = compareSummaries(before, after).join('\n');
    assert.match(text, /^Compare baseline \(the arm server, 2026-10-28T09:00:00\.000Z, 2 runs\) with after \(the arm server,/);
    assert.match(text, /Warning: the versions of Claude Code differ: \["2\.1\.312"\] and \["2\.1\.320"\]/);
    assert.match(text, /Warning: the option tasks differs/);
    assert.match(text, /claude-haiku-5-5: paired over 1 tasks with valid runs in both/);
    assert.match(text, /valid runs\s+2\s+2\s+0/);
    assert.match(text, /success rate\s+0\.0%\s+100\.0%\s+\+100\.0 pts/);
    assert.match(text, /tool calls\s+1\.00\s+2\.00\s+\+1\.00/);
    assert.match(text, /client calls\s+0\.00\s+0\.00\s+0\.00/);
    assert.match(text, /error results\s+1\.00\s+0\.00\s+-1\.00/);
    assert.match(text, /model requests\s+4\.00\s+2\.00\s+-2\.00/);
    assert.match(text, /Not paired \(no valid run in one summary\): neg-delete-vague, meeting-create/);
    assert.match(text, /read-room-passcode\s+0\/1\s+1\/1/);
    assert.match(text, /meeting-create\s+none\s+1\/1/);
    assert.match(text, /neg-delete-vague\s+1\/1\s+none/);
  });

  it('does not count a task that only one summary ran in the success rate', () => {
    const tasks = ['a', 'b', 'c', 'd'];
    const before = summaryOf(
      'before',
      tasks.map((taskId, index) => record({ taskId, passed: index < 2 })),
    );
    const after = summaryOf('after', [record({ taskId: 'a' }), record({ taskId: 'b' })]);
    const text = compareSummaries(before, after).join('\n');
    assert.match(text, /Warning: the option tasks differs: \["a","b","c","d"\] and \["a","b"\]/);
    assert.match(text, /paired over 2 tasks/);
    assert.match(text, /success rate\s+100\.0%\s+100\.0%\s+0\.0 pts/);
  });

  it('prints n/a, not a gain, when one summary has no valid run', () => {
    const before = summaryOf('a', [record({})]);
    const after = summaryOf('b', [INVALID]);
    const text = compareSummaries(before, after).join('\n');
    assert.match(text, /paired over 0 tasks/);
    assert.match(text, /valid runs\s+1\s+0\s+-1/);
    assert.match(text, /invalid runs\s+0\s+1\s+\+1/);
    assert.match(text, /success rate\s+n\/a\s+n\/a\s+n\/a/);
    assert.match(text, /tool calls\s+n\/a\s+n\/a\s+n\/a/);
    assert.match(text, /cost USD\s+n\/a\s+n\/a\s+n\/a/);
  });

  it('warns about other options and feature flags, and names the models that only one summary has', () => {
    const before = summaryOf('a', [record({})]);
    const after = {
      ...summaryOf(
        'b',
        [record({ model: 'claude-sonnet-5-5' })],
        { featureFlags: ['mcp runtime arm: v2 (source: growthbook)'] },
        { effort: 'high', repeat: 3, timeoutS: 600 },
      ),
      models: summarize([record({ model: 'claude-sonnet-5-5' })], ['claude-sonnet-5-5']),
    };
    const text = compareSummaries(before, after).join('\n');
    assert.match(text, /Warning: the feature flags of Claude Code differ: \[\] and \["mcp runtime arm/);
    assert.match(text, /Warning: the option effort differs: "medium" and "high"/);
    assert.match(text, /Warning: the option repeat differs: 1 and 3/);
    assert.match(text, /Warning: the option timeoutS differs: 300 and 600/);
    assert.match(text, /claude-haiku-5-5: only in a/);
    assert.match(text, /claude-sonnet-5-5: only in b/);
  });

  it('prints the arm of each summary, the arm server for a summary without an arm, and no warning for it', () => {
    const plain = summaryOf('plain', [record({})], {}, { arm: 'plain' });
    const skill = summaryOf('skill', [record({})], {}, { arm: 'skill' });
    const text = compareSummaries(plain, skill).join('\n');
    assert.match(text, /^Compare plain \(the arm plain, [^)]+\) with skill \(the arm skill, [^)]+\)$/m);
    assert.doesNotMatch(text, /Warning/);
    assert.match(compareSummaries(summaryOf('a', [record({})]), skill).join('\n'), /^Compare a \(the arm server, .+\(the arm skill,/);
  });

  it('counts and lists the valid runs of each summary that ended on a limit', () => {
    const plain = summaryOf('plain', [record({}), record({ repeat: 2 })], {}, { arm: 'plain' });
    const skill = summaryOf(
      'skill',
      [
        record({ passed: false, resultSubtype: 'error_max_turns' }),
        record({ repeat: 2, valid: false, passed: false, invalidReasons: ['rate limit rejected'], resultSubtype: 'error_max_turns' }),
      ],
      {},
      { arm: 'skill' },
    );
    // A summary without limitRuns in its models: the count reads the runs.
    const old = { ...skill, models: skill.models.map(({ limitRuns, ...rest }) => rest) } as unknown as Summary;
    for (const after of [skill, old]) {
      const text = compareSummaries(plain, after).join('\n');
      assert.match(text, /runs on a limit\s+0\s+1\s+\+1/);
      assert.match(text, /Runs that ended on a limit \(they count\):\n {2}skill: read-room-passcode run 1: error_max_turns$/m);
      assert.doesNotMatch(text, /run 2: error_max_turns/);
    }
  });

  it('prints no task list without a change', () => {
    const text = compareSummaries(summaryOf('a', [record({})]), summaryOf('b', [record({})])).join('\n');
    assert.doesNotMatch(text, /Tasks whose pass rate changed|Not paired|Warning|Runs that ended on a limit/);
    assert.match(text, /runs on a limit\s+0\s+0\s+0/);
  });

  it('warns about other MCP protocol versions, another day and another text of a prompt', () => {
    const prompt = (date: string) => `Create a link on ${date}, from 09:00 to 10:00 New York time.`;
    const before = summaryOf(
      'a',
      [record({ prompt: prompt('Friday, October 30, 2026') }), record({ taskId: 'other', prompt: 'Old text 1.' })],
      { mcpProtocolVersions: ['2025-11-25'] },
    );
    const after = {
      ...summaryOf(
        'b',
        [record({ prompt: prompt('Monday, March 15, 2027') }), record({ taskId: 'other', prompt: 'New text 1.' })],
        { mcpProtocolVersions: ['2026-07-28'] },
      ),
      startedAt: '2026-10-31T09:00:00.000Z',
    };
    const text = compareSummaries(before, after).join('\n');
    assert.match(text, /Warning: the MCP protocol versions differ: \["2025-11-25"\] and \["2026-07-28"\]/);
    assert.match(text, /Warning: the summaries started on other days, 2026-10-28 and 2026-10-31\./);
    // The date in the prompt of read-room-passcode differs, but its text does not.
    assert.match(text, /Warning: the prompts of these tasks differ in more than their dates and times: other\./);
    assert.equal(promptShape(prompt('Friday, October 30, 2026')), promptShape(prompt('Monday, March 15, 2027')));
  });

  it('takes 23:30 UTC as the next day in Berlin', () => {
    const before = { ...summaryOf('a', [record({})]), startedAt: '2026-10-28T23:30:00.000Z' };
    const after = { ...summaryOf('b', [record({})]), startedAt: '2026-10-29T08:00:00.000Z' };
    assert.doesNotMatch(compareSummaries(before, after).join('\n'), /other days/);
  });

  it('prints the input tokens for each model request by level, by both methods, with the change', () => {
    const before = summaryOf('a', [
      record({ tokens: { input: 0, output: 0, cacheRead: 3000, cacheCreation: 0 }, modelRequests: 3 }),
      record({ repeat: 2, tokens: { input: 0, output: 0, cacheRead: 1000, cacheCreation: 0 }, modelRequests: 1 }),
      record({ taskId: 'full-task', level: 'full', tokens: { input: 0, output: 0, cacheRead: 2000, cacheCreation: 0 } }),
    ]);
    const after = summaryOf('b', [
      record({ tokens: { input: 0, output: 0, cacheRead: 1800, cacheCreation: 0 }, modelRequests: 3 }),
      record({ repeat: 2, tokens: { input: 0, output: 0, cacheRead: 900, cacheCreation: 0 }, modelRequests: 1 }),
      record({ taskId: 'full-task', level: 'full', tokens: { input: 0, output: 0, cacheRead: 2200, cacheCreation: 0 } }),
    ]);
    const text = compareSummaries(before, after).join('\n');
    // read: the mean of runs goes from (1000 + 1000) / 2 to (600 + 900) / 2, pooled from 4000 / 4
    // to 2700 / 4.
    assert.match(text, /level\s+a\s+b\s+change\s+pooled a\s+pooled b\s+change/);
    assert.match(text, /read\s+1,000\s+750\s+-25\.0%\s+1,000\s+675\s+-32\.5%/);
    assert.match(text, /full\s+1,000\s+1,100\s+\+10\.0%\s+1,000\s+1,100\s+\+10\.0%/);
    assert.ok(text.indexOf('  read') < text.indexOf('  full'));
    assert.match(text, /the method that item 5 of the bar uses \(eval\/README\.md\)\./);
  });

  it('prints n/a for a level that one summary lacks, and no table without paired tasks', () => {
    const before = summaryOf('a', [record({}), record({ taskId: 'only-a', level: 'manage' })]);
    const after = summaryOf('b', [record({}), record({ taskId: 'only-a', level: 'manage', modelRequests: 0 })]);
    assert.match(compareSummaries(before, after).join('\n'), /manage\s+755\s+n\/a\s+n\/a\s+755\s+n\/a\s+n\/a/);
    const none = compareSummaries(summaryOf('a', [record({})]), summaryOf('b', [INVALID])).join('\n');
    assert.doesNotMatch(none, /Input tokens for each model request/);
  });

  it('prints the questions to the person of each task that asked in one summary', () => {
    const asked = (action: 'accept' | 'decline') => [{ server: 'alfaview', message: 'Delete the room?', action }];
    const before = summaryOf('a', [record({}), record({ taskId: 'delete', repeat: 1 }), record({ taskId: 'delete', repeat: 2 })]);
    const after = summaryOf('b', [
      record({}),
      record({ taskId: 'delete', repeat: 2, elicitations: asked('decline') }),
      record({ taskId: 'delete', repeat: 1, elicitations: [...asked('accept'), ...asked('accept')] }),
    ]);
    const text = compareSummaries(before, after).join('\n');
    assert.match(text, /Questions to the person \(the questions of each valid run, then the answers\):/);
    assert.match(text, /delete\s+0 0\s+2 1: 2 accept, 1 decline/);
    assert.doesNotMatch(text, /read-room-passcode\s+0/);
    const quiet = compareSummaries(summaryOf('a', [record({})]), summaryOf('b', [record({})])).join('\n');
    assert.match(quiet, /Questions to the person: none in the valid runs of the paired tasks\./);
  });
});

describe('the input tokens for each model request by level', () => {
  it('gives the mean of the runs and the pooled figure over the valid runs with a model request', () => {
    const levels = levelTokensOf([
      record({ level: 'full', tokens: { input: 100, output: 5, cacheRead: 800, cacheCreation: 100 }, modelRequests: 4 }),
      record({ level: 'full', tokens: { input: 0, output: 5, cacheRead: 600, cacheCreation: 0 }, modelRequests: 1 }),
      record({ level: 'full', valid: false, tokens: { input: 0, output: 0, cacheRead: 9000, cacheCreation: 0 } }),
      record({ level: 'full', modelRequests: 0 }),
      record({ level: 'full', modelRequests: null }),
      record({ level: 'other' }),
      record({ level: 'read', valid: false }),
      record({ level: 'read' }),
    ]);
    assert.deepEqual(
      levels.map((level) => level.level),
      ['read', 'full', 'other'],
    );
    // (1000 / 4 + 600 / 1) / 2 and 1600 / 5.
    assert.deepEqual(levels[1], { level: 'full', runs: 2, modelRequests: 5, meanOfRuns: 425, pooled: 320 });
    assert.deepEqual(levels[0], { level: 'read', runs: 1, modelRequests: 2, meanOfRuns: 755, pooled: 755 });
  });

  it('gives null without a run that counts', () => {
    assert.deepEqual(levelTokensOf([record({ valid: false })]), [
      { level: 'read', runs: 0, modelRequests: 0, meanOfRuns: null, pooled: null },
    ]);
    assert.deepEqual(levelTokensOf([]), []);
  });

  it('is part of the summary of each model', () => {
    assert.deepEqual(summarize([record({})], ['claude-haiku-5-5'])[0]?.levels, [
      { level: 'read', runs: 1, modelRequests: 2, meanOfRuns: 755, pooled: 755 },
    ]);
  });

  it('is in the table of each model, with the questions of each task', () => {
    const asked = { server: 'alfaview', message: 'Delete?', action: 'accept' as const };
    const [summary] = summarize(
      [record({}), record({ taskId: 'delete-room-clear', level: 'full', elicitations: [asked] }), INVALID],
      ['claude-haiku-5-5'],
    );
    const text = modelReport(summary!).join('\n');
    assert.match(text, /Input tokens for each model request, by level \(valid runs with a model request\):/);
    assert.match(text, /level\s+runs\s+requests\s+mean of runs\s+pooled/);
    assert.match(text, /read\s+1\s+2\s+755\s+755/);
    assert.match(text, /full\s+1\s+2\s+755\s+755/);
    assert.match(text, /Questions to the person \(the questions of each valid run, then the answers\):\n {2}- delete-room-clear: 1: 1 accept/);
    const quiet = modelReport(summarize([record({}), record({ level: 'manage', modelRequests: 0 })], ['claude-haiku-5-5'])[0]!);
    assert.match(quiet.join('\n'), /Questions to the person: none in the valid runs\./);
    assert.match(quiet.join('\n'), /manage\s+0\s+0\s+n\/a\s+n\/a/);
  });
});

describe('the questions to the person of a task', () => {
  const entry = (action: string) => ({ server: 'alfaview', message: 'Delete?', action }) as RunRecord['elicitations'][number];

  it('counts the answers and the questions of each valid run, in the order of the repeats', () => {
    const questions = questionsOf([
      record({ repeat: 3, elicitations: [entry('decline')] }),
      record({ repeat: 1, elicitations: [entry('accept'), entry('cancel')] }),
      record({ repeat: 2 }),
      record({ repeat: 4, valid: false, elicitations: [entry('accept')] }),
      { ...record({ repeat: 5 }), elicitations: undefined } as unknown as RunRecord,
    ]);
    assert.deepEqual(questions, { accept: 1, decline: 1, cancel: 1, perRun: [2, 0, 1, 0] });
  });

  it('is part of the summary of each task', () => {
    const [summary] = summarize([record({ elicitations: [entry('accept')] })], ['claude-haiku-5-5']);
    assert.deepEqual(summary?.tasks[0]?.questions, { accept: 1, decline: 0, cancel: 0, perRun: [1] });
  });

  it('prints the questions of each run, then the answers that were given', () => {
    assert.equal(questionsText({ accept: 3, decline: 0, cancel: 1, perRun: [2, 1, 1] }), '2 1 1: 3 accept, 1 cancel');
    assert.equal(questionsText({ accept: 0, decline: 0, cancel: 0, perRun: [0, 0] }), '0 0');
    assert.equal(questionsText({ accept: 0, decline: 0, cancel: 0, perRun: [] }), 'no valid run');
  });
});

describe('the paired tasks of two summaries', () => {
  it('are the tasks with valid runs of the model in both, in the order of the first', () => {
    const before = summaryOf('a', [record({ taskId: 'b' }), record({ taskId: 'a' }), record({ taskId: 'c' })]);
    const after = summaryOf('b', [record({ taskId: 'a' }), record({ taskId: 'b' }), record({ taskId: 'c', valid: false })]);
    assert.deepEqual(pairedTaskIds(before, after, 'claude-haiku-5-5'), ['b', 'a']);
    assert.deepEqual(pairedTaskIds(before, after, 'claude-sonnet-5-5'), []);
  });
});
