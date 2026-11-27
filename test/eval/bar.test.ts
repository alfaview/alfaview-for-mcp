// The acceptance bar of eval/bar.ts, which eval/README.md describes.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ACCESS_LEVELS } from '../../src/levels.ts';
import {
  ASKING_TASKS,
  barReport,
  FRICTION_TARGETS,
  HAIKU,
  NO_DELETE_CHECK,
  scoreBar,
  TOKEN_CUTS,
  type BarModel,
} from '../../eval/bar.ts';
import { summarize, type RunRecord, type Summary } from '../../eval/report.ts';
import { TASKS } from '../../eval/tasks.ts';

const SONNET = 'claude-sonnet-5-5';
const MODELS = [SONNET, HAIKU];

/** A small eval: one task each of read, standard and manage, and the tasks of ASKING_TASKS. */
const LEVELS: Record<string, string> = {
  'read-a': 'read',
  'guest-links-cleanup-calendly': 'standard',
  'settings-file-sharing': 'manage',
  'delete-room-clear': 'full',
  'delete-user-clear': 'full',
  'hard-delete-declined': 'full',
};
const TASK_IDS = Object.keys(LEVELS);

const NO_DELETE = { reason: 'Nothing is deleted: the person said no when the server asked', kind: 'state' as const, passed: true };

function question(action: 'accept' | 'decline'): RunRecord['elicitations'][number] {
  return { server: 'alfaview', message: 'Delete the room for good?', action };
}

/**
 * Returns a run of `taskId` that passes with 2 tool calls and 2 model requests. With `after`, the
 * run has 8,000 input tokens for each model request, 20 percent fewer than the 10,000 of the
 * baseline, and asks the person as the bar wants. The baseline asks nothing, as a server that does
 * not ask the person before a delete.
 */
function run(taskId: string, model: string, repeat: number, after: boolean): RunRecord {
  const questions: Record<string, RunRecord['elicitations']> = {
    'delete-room-clear': [question('accept')],
    'delete-user-clear': [question('accept')],
    'hard-delete-declined': [question('decline')],
  };
  return {
    taskId,
    level: LEVELS[taskId] ?? 'read',
    kind: 'write',
    model,
    repeat,
    prompt: 'A task.',
    startedAt: '2026-10-29T09:00:00.000Z',
    valid: true,
    invalidReasons: [],
    runProblems: [],
    passed: true,
    checks: taskId === 'hard-delete-declined' ? [NO_DELETE] : [],
    toolCalls: [
      { name: 'find_rooms', isError: false, resultChars: 100 },
      { name: 'get_room', isError: false, resultChars: 100 },
    ],
    modelRequests: 2,
    turns: 3,
    tokens: { input: 0, output: 100, cacheRead: after ? 16_000 : 20_000, cacheCreation: 0 },
    costUsd: 0.01,
    durationMs: 4000,
    wallMs: 5000,
    resultSubtype: 'success',
    finalText: 'Done.',
    claudeCodeVersion: '2.1.312',
    toolsOffered: 9,
    mcpProtocolVersion: after ? '2026-07-28' : '2025-11-25',
    featureFlags: ['mcp runtime arm: v2 (source: default)'],
    elicitations: after ? (questions[taskId] ?? []) : [],
    requestCount: 3,
    writeCount: 1,
    emails: [],
    contractProblems: [],
    exitCode: 0,
    timedOut: false,
    streamFile: `${model}/${taskId}-run${repeat}.stream.jsonl`,
  };
}

type Edit = (record: RunRecord) => Partial<RunRecord> | undefined;

function summaryOf(records: RunRecord[], label: string, options: Record<string, unknown> = {}): Summary {
  const models = MODELS.filter((model) => records.some((record) => record.model === model));
  return {
    label,
    startedAt: '2026-10-29T09:00:00.000Z',
    finishedAt: '2026-10-29T09:30:00.000Z',
    options: {
      models,
      tasks: [...new Set(records.map((record) => record.taskId))],
      repeat: 3,
      effort: 'medium',
      maxTurns: 15,
      maxBudgetUsd: 0.5,
      timeoutS: 300,
      ...options,
    },
    environment: {},
    models: summarize(records, models),
    runs: records,
  };
}

/** Returns the summary of 3 runs of each task with each model, changed by `edit`. */
function set(label: string, after: boolean, edit: Edit = () => undefined, options: Record<string, unknown> = {}): Summary {
  const records = MODELS.flatMap((model) =>
    TASK_IDS.flatMap((taskId) =>
      [1, 2, 3].map((repeat) => {
        const record = run(taskId, model, repeat, after);
        return { ...record, ...edit(record) };
      }),
    ),
  );
  return summaryOf(records, label, options);
}

const BASE = set('base', false);
const AFTER = set('after', true);

/** Returns a summary of more runs of `taskId` with Haiku: one run for each item of `passes`. */
function moreRuns(taskId: string, passes: readonly boolean[], options: Record<string, unknown> = {}): Summary {
  const records = passes.map((passed, index) => ({ ...run(taskId, HAIKU, index + 1, true), passed }));
  return summaryOf(records, 'more', { repeat: passes.length, ...options });
}

/** Returns the result and the text of item `item` of `model`, and fails when the bar lacks it. */
function itemOf(bar: BarModel[], model: string, item: number) {
  const found = bar.find((entry) => entry.model === model)?.items.find((entry) => entry.item === item);
  assert.ok(found, `item ${item} of ${model}`);
  return { result: found.result, text: found.lines.join('\n') };
}

const is = (model: string, taskId: string, repeats: readonly number[] = [1, 2, 3]) => (record: RunRecord) =>
  record.model === model && record.taskId === taskId && repeats.includes(record.repeat);

describe('the acceptance bar', () => {
  it('passes each item for each model when the run after holds them, and item 7 only with Haiku', () => {
    const bar = scoreBar(BASE, AFTER, TASK_IDS);
    assert.deepEqual(
      bar.map((model) => [model.model, model.result, model.items.map((item) => `${item.item} ${item.result}`)]),
      [
        [SONNET, 'pass', ['1 pass', '2 pass', '3 pass', '4 pass', '5 pass', '6 pass']],
        [HAIKU, 'pass', ['1 pass', '2 pass', '3 pass', '4 pass', '5 pass', '6 pass', '7 pass']],
      ],
    );
    assert.deepEqual(bar[0]?.needMoreRuns, []);
    const text = barReport(BASE, AFTER, TASK_IDS).join('\n');
    assert.match(text, /The acceptance bar of eval\/README\.md, with the baseline base and the run after after\./);
    assert.match(text, /claude-haiku-5-5: pass\n {2}1\. Valid runs: pass\n {5}invalid runs: 0 in base, 0 in after/);
    assert.match(text, /7\. Friction of Haiku: pass/);
    assert.match(text, /The bar: pass$/);
  });

  describe('item 1, valid runs', () => {
    it('is open with an invalid run, and names it with its reasons', () => {
      const after = set('after', true, (record) =>
        is(HAIKU, 'read-a', [3])(record) ? { valid: false, passed: false, invalidReasons: ['rate limit rejected'] } : undefined,
      );
      const bar = scoreBar(BASE, after, TASK_IDS);
      const { result, text } = itemOf(bar, HAIKU, 1);
      assert.equal(result, 'open');
      assert.match(text, /invalid runs: 0 in base, 1 in after/);
      assert.match(text, /Read the stream of each invalid run to confirm/);
      assert.match(text, / {2}after: read-a run 3: rate limit rejected/);
      assert.equal(itemOf(bar, SONNET, 1).result, 'pass');
    });

    it('misses a contract problem, another Claude Code, other feature flags and another option', () => {
      const contract = set('after', true, (record) =>
        is(SONNET, 'read-a', [1])(record) ? { contractProblems: ['GET /v2/rooms does not fit'] } : undefined,
      );
      assert.equal(itemOf(scoreBar(BASE, contract, TASK_IDS), SONNET, 1).result, 'miss');
      assert.match(itemOf(scoreBar(BASE, contract, TASK_IDS), SONNET, 1).text, /contract problems: 0 in base, 1 in after: MISS/);

      const version = set('after', true, () => ({ claudeCodeVersion: '2.1.320' }));
      assert.match(itemOf(scoreBar(BASE, version, TASK_IDS), SONNET, 1).text, /Claude Code: MISS, \["2\.1\.312"\] in base, \["2\.1\.320"\] in after/);

      const flags = set('after', true, () => ({ featureFlags: ['mcp runtime arm: v3 (source: growthbook)'] }));
      const flagged = itemOf(scoreBar(BASE, flags, TASK_IDS), HAIKU, 1);
      assert.equal(flagged.result, 'miss');
      assert.match(flagged.text, /its feature flags: MISS/);

      const effort = set('after', true, undefined, { effort: 'high' });
      const other = itemOf(scoreBar(BASE, effort, TASK_IDS), HAIKU, 1);
      assert.equal(other.result, 'miss');
      assert.match(other.text, /the options tasks, repeat, effort, maxTurns, maxBudgetUsd, timeoutS: MISS, effort is "medium" in base and "high" in after/);
    });

    it('compares the more runs too, but not their tasks and repeats', () => {
      const failed = set('after', true, (record) => (is(HAIKU, 'read-a', [1])(record) ? { passed: false } : undefined));
      const bar = scoreBar(BASE, failed, TASK_IDS, [moreRuns('read-a', [true, true, true, true, true])]);
      const same = itemOf(bar, HAIKU, 1);
      assert.equal(same.result, 'pass');
      assert.match(same.text, /invalid runs: 0 in base, 0 in after, 0 in more/);
      assert.match(same.text, /\(for the more runs without tasks and repeat\): the same/);
      // The more runs have no run of Sonnet, so they do not count for it.
      const sonnet = itemOf(bar, SONNET, 1);
      assert.equal(sonnet.result, 'pass');
      assert.doesNotMatch(sonnet.text, /more/);
      const other = scoreBar(BASE, failed, TASK_IDS, [moreRuns('read-a', [true, true, true, true, true], { timeoutS: 600 })]);
      assert.match(itemOf(other, HAIKU, 1).text, /MISS, timeoutS is 300 in base and 600 in more/);
    });

    it('misses a summary of another arm than server, and takes a summary without an arm as the arm server', () => {
      // BASE has no arm, so it counts as the arm server.
      const server = itemOf(scoreBar(BASE, set('after', true, undefined, { arm: 'server' }), TASK_IDS), HAIKU, 1);
      assert.equal(server.result, 'pass');
      assert.match(server.text, /the arm: server in each summary$/);

      const pair = itemOf(scoreBar(set('plain', false, undefined, { arm: 'plain' }), set('skill', true, undefined, { arm: 'skill' }), TASK_IDS), SONNET, 1);
      assert.equal(pair.result, 'miss');
      assert.match(pair.text, /the arm: MISS, the bar needs the arm server in each summary, and it is plain in plain, skill in skill$/);

      const after = itemOf(scoreBar(BASE, set('after', true, undefined, { arm: 'skill' }), TASK_IDS), HAIKU, 1);
      assert.equal(after.result, 'miss');
      assert.match(after.text, /and it is skill in after$/);

      const failed = set('after', true, (record) => (is(HAIKU, 'read-a', [1])(record) ? { passed: false } : undefined));
      const more = scoreBar(BASE, failed, TASK_IDS, [moreRuns('read-a', [true, true, true, true, true], { arm: 'plain' })]);
      assert.equal(itemOf(more, HAIKU, 1).result, 'miss');
      assert.match(itemOf(more, HAIKU, 1).text, /and it is plain in more$/);
    });
  });

  describe('item 2, success', () => {
    it('names a task that passed 3 of 3 before and fails a run after: it runs 5 more times', () => {
      const failed = set('after', true, (record) => (is(HAIKU, 'read-a', [2])(record) ? { passed: false } : undefined));
      const bar = scoreBar(BASE, failed, TASK_IDS);
      const { result, text } = itemOf(bar, HAIKU, 2);
      assert.equal(result, 'open');
      assert.match(text, /passed runs over the 6 paired tasks: 18 in base, 17 in after \(at least 17\)/);
      assert.match(text, /read-a: 3 of 3 in base, 2 of 3 in after: open, it runs 5 more times, and its 8 runs need 7 passes/);
      assert.deepEqual(bar.find((model) => model.model === HAIKU)?.needMoreRuns, ['read-a']);
      const report = barReport(BASE, failed, TASK_IDS).join('\n');
      assert.match(report, /Item 2 needs 5 more runs of read-a with claude-haiku-5-5 on the server of after:/);
      assert.match(report, /node eval\/main\.ts --label more-runs --models claude-haiku-5-5 --tasks read-a --repeat 5/);
      assert.match(report, /The bar: open$/);
    });

    it('decides that task with its 5 more runs: its 8 runs need 7 passes', () => {
      const failed = set('after', true, (record) => (is(HAIKU, 'read-a', [2])(record) ? { passed: false } : undefined));
      const seven = itemOf(scoreBar(BASE, failed, TASK_IDS, [moreRuns('read-a', [true, true, true, true, true])]), HAIKU, 2);
      assert.equal(seven.result, 'pass');
      assert.match(seven.text, /read-a: 3 of 3 in base, 2 of 3 in after, with the 5 more runs 7 of 8 \(at least 7\)$/m);
      const six = itemOf(scoreBar(BASE, failed, TASK_IDS, [moreRuns('read-a', [true, false, true, true, true])]), HAIKU, 2);
      assert.equal(six.result, 'miss');
      assert.match(six.text, /with the 5 more runs 6 of 8 \(at least 7\): MISS/);
      const three = itemOf(scoreBar(BASE, failed, TASK_IDS, [moreRuns('read-a', [true, true, true])]), HAIKU, 2);
      assert.equal(three.result, 'open');
      assert.match(three.text, /and 3 more valid runs: open, its 8 runs are 3 runs and 5 more/);
      assert.deepEqual(scoreBar(BASE, failed, TASK_IDS, [moreRuns('read-a', [true, true, true])])[1]?.needMoreRuns, []);
    });

    it('misses a set with 2 passed runs fewer, and a task that passes fewer runs than in its baseline', () => {
      const twoFewer = set('after', true, (record) =>
        is(SONNET, 'read-a', [1])(record) || is(SONNET, 'delete-room-clear', [1])(record) ? { passed: false } : undefined,
      );
      const set2 = itemOf(scoreBar(BASE, twoFewer, TASK_IDS), SONNET, 2);
      assert.equal(set2.result, 'miss');
      assert.match(set2.text, /18 in base, 16 in after \(at least 17\): MISS/);

      const before = set('base', false, (record) => (is(SONNET, 'read-a', [1])(record) ? { passed: false } : undefined));
      const after = set('after', true, (record) => (is(SONNET, 'read-a', [1, 2])(record) ? { passed: false } : undefined));
      const fewer = itemOf(scoreBar(before, after, TASK_IDS), SONNET, 2);
      assert.equal(fewer.result, 'miss');
      assert.match(fewer.text, /read-a: 2 of 3 in base, 1 of 3 in after: MISS, it passes fewer runs than in its baseline/);
    });

    it('needs at least 2 of 3 of guest-links-cleanup-calendly with Haiku', () => {
      const calendly = is(HAIKU, 'guest-links-cleanup-calendly', [1, 2]);
      const before = set('base', false, (record) => (calendly(record) ? { passed: false } : undefined));
      const after = set('after', true, (record) => (calendly(record) ? { passed: false } : undefined));
      const floor = itemOf(scoreBar(before, after, TASK_IDS), HAIKU, 2);
      assert.equal(floor.result, 'miss');
      assert.match(floor.text, /guest-links-cleanup-calendly: 1 of 3 in after \(at least 2 of 3\): MISS/);
      assert.doesNotMatch(itemOf(scoreBar(before, after, TASK_IDS), SONNET, 2).text, /calendly/);
      assert.match(itemOf(scoreBar(BASE, AFTER, TASK_IDS), HAIKU, 2).text, /guest-links-cleanup-calendly: 3 of 3 in after \(at least 2 of 3\)$/m);

      const gone = set('after', true, (record) =>
        is(HAIKU, 'guest-links-cleanup-calendly')(record) ? { valid: false, passed: false, invalidReasons: ['rate limit rejected'] } : undefined,
      );
      const open = itemOf(scoreBar(BASE, gone, TASK_IDS), HAIKU, 2);
      assert.equal(open.result, 'open');
      assert.match(open.text, /guest-links-cleanup-calendly: open, it has no valid runs in both summaries/);
    });
  });

  describe('items 3 and 4, tool calls and error results', () => {
    it('miss a higher mean', () => {
      const more = set('after', true, (record) =>
        is(SONNET, 'read-a', [1])(record)
          ? { toolCalls: [...record.toolCalls, { name: 'get_room', isError: true, resultChars: 20 }] }
          : undefined,
      );
      const bar = scoreBar(BASE, more, TASK_IDS);
      const calls = itemOf(bar, SONNET, 3);
      assert.equal(calls.result, 'miss');
      assert.match(calls.text, /mean for each run over the 6 paired tasks: 2\.00 in base, 2\.06 in after, higher: MISS/);
      assert.equal(itemOf(bar, SONNET, 4).result, 'miss');
      assert.match(itemOf(bar, SONNET, 4).text, /0\.00 in base, 0\.06 in after, higher: MISS/);
      assert.match(itemOf(bar, HAIKU, 3).text, /2\.00 in base, 2\.00 in after, not higher$/);
    });

    it('are open while a summary lacks a task of the eval', () => {
      const bar = scoreBar(BASE, AFTER, [...TASK_IDS, 'hard-other']);
      const calls = itemOf(bar, SONNET, 3);
      assert.equal(calls.result, 'open');
      assert.match(calls.text, /open: the item counts the 7 tasks of the eval, and base ran 6 of them, after 6/);
      assert.equal(itemOf(bar, HAIKU, 4).result, 'open');
    });
  });

  describe('item 5, input tokens for each model request', () => {
    it('misses a level below its cut, and gives the pooled figures', () => {
      const after = set('after', true, (record) =>
        record.level === 'read' ? { tokens: { input: 0, output: 100, cacheRead: 19_000, cacheCreation: 0 } } : undefined,
      );
      const { result, text } = itemOf(scoreBar(BASE, after, TASK_IDS), SONNET, 5);
      assert.equal(result, 'miss');
      assert.match(text, /over the 5 paired base tasks, by the mean of the runs of each level: the method of the bar\./);
      assert.match(text, /read: 10,000 in base, 9,500 in after, 5\.00 percent lower \(at least 8 percent lower\): MISS; pooled 10,000 and 9,500, 5\.00 percent lower/);
      assert.match(text, /full: 10,000 in base, 8,000 in after, 20\.00 percent lower \(at least 18 percent lower\); pooled/);
    });

    it('does not count the hard tasks, and names a level with more tokens as higher', () => {
      const after = set('after', true, (record) =>
        record.taskId === 'hard-delete-declined' ? { tokens: { input: 0, output: 100, cacheRead: 90_000, cacheCreation: 0 } } : undefined,
      );
      assert.equal(itemOf(scoreBar(BASE, after, TASK_IDS), HAIKU, 5).result, 'pass');
      const higher = set('after', true, (record) =>
        record.level === 'manage' ? { tokens: { input: 0, output: 100, cacheRead: 22_000, cacheCreation: 0 } } : undefined,
      );
      assert.match(itemOf(scoreBar(BASE, higher, TASK_IDS), HAIKU, 5).text, /manage: 10,000 in base, 11,000 in after, 10\.00 percent higher/);
    });

    it('is open for a level without a run with a model request, and while a base task is missing', () => {
      const after = set('after', true, (record) => (record.level === 'read' ? { modelRequests: 0 } : undefined));
      const level = itemOf(scoreBar(BASE, after, TASK_IDS), SONNET, 5);
      assert.equal(level.result, 'open');
      assert.match(level.text, /read: open, a summary has no figure of the level \(no valid run with a model request/);
      const missing = itemOf(scoreBar(BASE, AFTER, [...TASK_IDS, 'standard-other']), SONNET, 5);
      assert.equal(missing.result, 'open');
      assert.match(missing.text, /open: the cuts assume the mix of levels of all 6 base tasks, and base ran 5 of them, after 5/);
      // A level below its cut does not decide the item while a base task is missing.
      const lowRead = set('after', true, (record) =>
        record.level === 'read' ? { tokens: { input: 0, output: 100, cacheRead: 19_000, cacheCreation: 0 } } : undefined,
      );
      const partial = itemOf(scoreBar(BASE, lowRead, [...TASK_IDS, 'standard-other']), SONNET, 5);
      assert.equal(partial.result, 'open');
      assert.match(partial.text, /read: [^\n]*5\.00 percent lower \(at least 8 percent lower\): below the cut; pooled/);
    });

    it('is open for a level without input tokens in the baseline, which gives no percent', () => {
      const before = set('base', false, (record) =>
        record.level === 'read' ? { tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } } : undefined,
      );
      const { result, text } = itemOf(scoreBar(before, AFTER, TASK_IDS), SONNET, 5);
      assert.equal(result, 'open');
      assert.match(text, /read: open, a summary has no figure of the level \([^)]*no input tokens in the baseline\)/);
    });
  });

  describe('item 6, questions to the person', () => {
    it('shows one accepted question in each run of the two clear deletes, and one declined question and no delete', () => {
      const { result, text } = itemOf(scoreBar(BASE, AFTER, TASK_IDS), SONNET, 6);
      assert.equal(result, 'pass');
      assert.match(text, /delete-room-clear: the questions of each run in after: 1 1 1: 3 accept$/m);
      assert.match(text, /hard-delete-declined: the questions of each run in after: 1 1 1: 3 decline; no delete in 3 of 3 runs$/m);
      assert.match(text, /no other paired task asks in after/);
    });

    it('misses a second question, a declined clear delete, an accepted question, a delete and a question of another task', () => {
      const after = set('after', true, (record) => {
        if (is(SONNET, 'delete-room-clear', [1])(record)) return { elicitations: [question('accept'), question('accept')] };
        if (is(SONNET, 'delete-user-clear', [2])(record)) return { elicitations: [question('decline')] };
        if (is(SONNET, 'hard-delete-declined', [3])(record)) return { elicitations: [question('accept')], checks: [{ ...NO_DELETE, passed: false }] };
        if (is(SONNET, 'read-a', [1])(record)) return { elicitations: [question('accept')] };
        return undefined;
      });
      const { result, text } = itemOf(scoreBar(BASE, after, TASK_IDS), SONNET, 6);
      assert.equal(result, 'miss');
      assert.match(text, /delete-room-clear: the questions of each run in after: 2 1 1: 4 accept; MISS, not one accepted question in each run/);
      assert.match(text, /delete-user-clear: [^\n]*1 decline; MISS, not one accepted question in each run/);
      assert.match(text, /hard-delete-declined: [^\n]*MISS, not one declined question in each run; no delete in 2 of 3 runs: MISS/);
      assert.match(text, /MISS, other tasks ask in after: read-a \(1 0 0: 1 accept\)/);
      assert.equal(itemOf(scoreBar(BASE, after, TASK_IDS), HAIKU, 6).result, 'pass');
    });

    it('is open without the check of the deletes, and for a task without valid runs in both', () => {
      const unchecked = set('after', true, (record) => (record.taskId === 'hard-delete-declined' ? { checks: [] } : undefined));
      const check = itemOf(scoreBar(BASE, unchecked, TASK_IDS), HAIKU, 6);
      assert.equal(check.result, 'open');
      assert.match(check.text, /open, a record has no check of the deletes/);
      const withoutHard = (summary: Summary) =>
        summaryOf(summary.runs.filter((record) => record.taskId !== 'hard-delete-declined'), summary.label);
      const gone = itemOf(scoreBar(withoutHard(BASE), withoutHard(AFTER), TASK_IDS), HAIKU, 6);
      assert.equal(gone.result, 'open');
      assert.match(gone.text, /hard-delete-declined: open, it has no valid runs in both summaries/);
      const invalid = set('after', true, (record) =>
        record.taskId === 'delete-user-clear' ? { valid: false, passed: false, invalidReasons: ['rate limit rejected'] } : undefined,
      );
      const open = itemOf(scoreBar(BASE, invalid, TASK_IDS), HAIKU, 6);
      assert.equal(open.result, 'open');
      assert.match(open.text, /delete-user-clear: open, it has no valid runs in both summaries/);
    });
  });

  describe('item 7, friction of Haiku', () => {
    const calls = (count: number, errors = 0) => ({
      toolCalls: Array.from({ length: count }, (_, index) => ({ name: 'get_room', isError: index < errors, resultChars: 10 })),
    });

    it('is open for a missed target when the task is not worse than in its baseline', () => {
      const before = set('base', false, (record) => (is(HAIKU, 'settings-file-sharing')(record) ? calls(4, 1) : undefined));
      const after = set('after', true, (record) => (is(HAIKU, 'settings-file-sharing')(record) ? calls(3, 1) : undefined));
      const { result, text } = itemOf(scoreBar(before, after, TASK_IDS), HAIKU, 7);
      assert.equal(result, 'open');
      assert.match(
        text,
        /settings-file-sharing in after: 3\.00 tool calls \(at most 2\.67, 4\.00 in base\), 1\.00 error results \(at most 0, 1\.00 in base\): open, the miss does not block/,
      );
      assert.match(text, /delete-room-clear in after: 2\.00 tool calls \(at most 3, 2\.00 in base\): met/);
    });

    it('misses a missed target when a figure of the target is higher than in the baseline', () => {
      const after = set('after', true, (record) => (is(HAIKU, 'delete-user-clear')(record) ? calls(2, 1) : undefined));
      const { result, text } = itemOf(scoreBar(BASE, after, TASK_IDS), HAIKU, 7);
      assert.equal(result, 'miss');
      assert.match(text, /delete-user-clear in after: [^\n]*: MISS, it misses the target and has more error results than in its baseline/);
      const both = set('after', true, (record) => (is(HAIKU, 'delete-room-clear')(record) ? calls(5) : undefined));
      assert.match(itemOf(scoreBar(BASE, both, TASK_IDS), HAIKU, 7).text, /has more tool calls than in its baseline/);
    });

    it('is open for a task without valid runs in both', () => {
      const after = set('after', true, (record) =>
        is(HAIKU, 'delete-room-clear')(record) ? { valid: false, passed: false, invalidReasons: ['rate limit rejected'] } : undefined,
      );
      const { result, text } = itemOf(scoreBar(BASE, after, TASK_IDS), HAIKU, 7);
      assert.equal(result, 'open');
      assert.match(text, /delete-room-clear: open, it has no valid runs in both summaries/);
    });
  });

  it('is open for a model that only one summary has, and misses when an item misses', () => {
    const haikuOnly = summaryOf(
      AFTER.runs.filter((record) => record.model === HAIKU),
      'after',
    );
    const text = barReport(BASE, haikuOnly, TASK_IDS).join('\n');
    assert.match(text, /claude-sonnet-5-5: only in base, so the bar is open for it/);
    assert.match(text, /The bar: open$/);
    assert.match(barReport(haikuOnly, BASE, TASK_IDS).join('\n'), /claude-sonnet-5-5: only in base, so the bar is open for it/);
    const effort = set('after', true, undefined, { effort: 'high' });
    assert.match(barReport(BASE, effort, TASK_IDS).join('\n'), /The bar: miss$/);
    assert.match(
      barReport(BASE, AFTER, TASK_IDS, [moreRuns('read-a', [true])]).join('\n'),
      /with the baseline base and the run after after, with the more runs of more\./,
    );
  });

  it('names the tasks, the levels and the check that the eval has', () => {
    const levelOf = (taskId: string) => TASKS.find((task) => task.id === taskId)?.level;
    for (const { taskId } of [...ASKING_TASKS, ...FRICTION_TARGETS]) assert.ok(levelOf(taskId), taskId);
    assert.equal(levelOf('guest-links-cleanup-calendly'), 'standard');
    assert.deepEqual(Object.keys(TOKEN_CUTS), [...ACCESS_LEVELS]);
    const declined = TASKS.find((task) => task.id === 'hard-delete-declined');
    assert.ok(declined?.checks.some((check) => NO_DELETE_CHECK.test(check.reason)));
    assert.equal(TASKS.filter((task) => !task.id.startsWith('hard-')).length, 26);
  });
});
