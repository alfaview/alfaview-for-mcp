// The acceptance bar of a change of the server: `--compare <baseline> <after> --bar` scores items
// 1 to 6 for each model and item 7 for Haiku. The rules follow "The acceptance bar" of README.md,
// so a change of an item there needs the same change here.
import { ACCESS_LEVELS } from '../src/levels.ts';
import {
  armOf,
  COMPARED_OPTIONS,
  levelTokensOf,
  meansOf,
  pairedTaskIds,
  questionsOf,
  questionsText,
  whole,
  type Means,
  type RunRecord,
  type Summary,
} from './report.ts';

/** The result of an item, a model or the bar. Open means that the summaries cannot decide it. */
export type BarResult = 'pass' | 'miss' | 'open';

export type BarItem = {
  /** The number of the item, 1 to 7. */
  item: number;
  name: string;
  result: BarResult;
  /** The figures of the item, and the reason of each miss and of each open part. */
  lines: string[];
};

export type BarModel = {
  model: string;
  result: BarResult;
  items: BarItem[];
  /** The tasks that item 2 runs 5 more times, and whose more runs the bar did not get. */
  needMoreRuns: string[];
};

/** The model of item 7, and of the floor of guest-links-cleanup-calendly in item 2. */
export const HAIKU = 'claude-haiku-5-5';

/**
 * Item 5: by level, the least percent by which the input tokens for each model request must fall
 * below the baseline.
 */
export const TOKEN_CUTS: Record<string, number> = { read: 8, standard: 14, manage: 17, full: 18 };

/** Item 7: the targets of Haiku, as the most tool calls and error results for each run. */
export const FRICTION_TARGETS: readonly { taskId: string; toolCalls: number; errorResults?: number }[] = [
  { taskId: 'delete-user-clear', toolCalls: 4.5, errorResults: 0.34 },
  { taskId: 'settings-file-sharing', toolCalls: 2.67, errorResults: 0 },
  { taskId: 'delete-room-clear', toolCalls: 3 },
];

/** Item 6: the tasks that ask the person once in each run, with the answer of the person. */
export const ASKING_TASKS = [
  { taskId: 'delete-room-clear', action: 'accept' },
  { taskId: 'delete-user-clear', action: 'accept' },
  { taskId: 'hard-delete-declined', action: 'decline' },
] as const;

/** Matches the reason of a noDeletes check (checks.ts), such as that of hard-delete-declined. */
export const NO_DELETE_CHECK = /^Nothing is deleted\b/;

/** Returns the worst result: miss before open before pass. */
function worst(results: readonly BarResult[]): BarResult {
  if (results.includes('miss')) return 'miss';
  return results.includes('open') ? 'open' : 'pass';
}

type Context = {
  model: string;
  /**
   * The IDs of all tasks of the eval (TASKS of tasks.ts). The base tasks are those whose ID does
   * not start with "hard-".
   */
  taskIds: readonly string[];
  a: Summary;
  b: Summary;
  more: readonly Summary[];
  /** The runs of the model in `a`, in `b` and in the summaries of `more`. */
  runsA: RunRecord[];
  runsB: RunRecord[];
  runsMore: RunRecord[];
  /** The tasks with valid runs of the model in both `a` and `b`. */
  paired: string[];
};

function validRunsOf(runs: readonly RunRecord[], taskId: string): RunRecord[] {
  return runs.filter((record) => record.taskId === taskId && record.valid);
}

function passesOf(runs: readonly RunRecord[]): number {
  return runs.filter((record) => record.passed).length;
}

/** Returns how many of `taskIds` the `runs` ran, and whether they ran all of them. */
function ranOf(runs: readonly RunRecord[], taskIds: readonly string[]): { ran: number; all: boolean } {
  const ran = taskIds.filter((taskId) => runs.some((record) => record.taskId === taskId)).length;
  return { ran, all: ran === taskIds.length };
}

/**
 * Scores item 1: no invalid run, no contract problem, the Claude Code version, its feature flags
 * and the options of the baseline, and the arm server in each summary.
 */
function validRunsItem({ model, a, b, more }: Context): BarItem {
  const own = (summary: Summary) => summary.runs.filter((record) => record.model === model);
  const ownMore = more.filter((summary) => own(summary).length > 0);
  const summaries = [a, b, ...ownMore];
  const lines: string[] = [];
  const results: BarResult[] = [];

  const invalid = summaries.map((summary) => own(summary).filter((record) => !record.valid));
  lines.push(`invalid runs: ${summaries.map((summary, index) => `${invalid[index]!.length} in ${summary.label}`).join(', ')}`);
  if (invalid.flat().length > 0) {
    results.push('open');
    lines.push(
      'open: the eval marks a run invalid only for a cause outside the server. Read the stream of each invalid run to confirm',
      'its cause, then run it again:',
    );
    invalid.forEach((records, index) => {
      for (const record of records) {
        lines.push(`  ${summaries[index]!.label}: ${record.taskId} run ${record.repeat}: ${record.invalidReasons.join('; ')}`);
      }
    });
  }

  const contract = summaries.map((summary) =>
    own(summary).reduce((sum, record) => sum + (record.contractProblems ?? []).length, 0),
  );
  const noContractProblem = contract.every((count) => count === 0);
  results.push(noContractProblem ? 'pass' : 'miss');
  lines.push(
    `contract problems: ${summaries.map((summary, index) => `${contract[index]} in ${summary.label}`).join(', ')}${noContractProblem ? '' : ': MISS, they stay at 0'}`,
  );

  const versionsOf = (summary: Summary) =>
    JSON.stringify([...new Set(own(summary).filter((record) => record.valid).map((record) => String(record.claudeCodeVersion)))].sort());
  const flagsOf = (summary: Summary) =>
    JSON.stringify([...new Set(own(summary).filter((record) => record.valid).flatMap((record) => record.featureFlags ?? []))].sort());
  for (const [name, valueOf] of [
    ['Claude Code', versionsOf],
    ['its feature flags', flagsOf],
  ] as const) {
    const other = summaries.slice(1).filter((summary) => valueOf(summary) !== valueOf(a));
    results.push(other.length === 0 ? 'pass' : 'miss');
    lines.push(
      other.length === 0
        ? `${name}: the same in each summary, ${valueOf(a)}`
        : `${name}: MISS, ${valueOf(a)} in ${a.label}, ${other.map((summary) => `${valueOf(summary)} in ${summary.label}`).join(', ')}`,
    );
  }

  // The more runs run fewer tasks with another repeat, so only the other options compare.
  const moreKeys = COMPARED_OPTIONS.filter((key) => key !== 'tasks' && key !== 'repeat');
  const optionText = (summary: Summary, key: string) => JSON.stringify(summary.options[key] ?? null);
  const differences = summaries.slice(1).flatMap((summary, index) =>
    (index === 0 ? COMPARED_OPTIONS : moreKeys)
      .filter((key) => optionText(summary, key) !== optionText(a, key))
      .map((key) => `${key} is ${optionText(a, key)} in ${a.label} and ${optionText(summary, key)} in ${summary.label}`),
  );
  results.push(differences.length === 0 ? 'pass' : 'miss');
  const compared = `the options ${COMPARED_OPTIONS.join(', ')}${ownMore.length > 0 ? ` (for the more runs without tasks and repeat)` : ''}`;
  lines.push(differences.length === 0 ? `${compared}: the same` : `${compared}: MISS, ${differences.join('; ')}`);

  // The arms plain and skill add the tools of a skill, deferred schemas and a skill, so their runs
  // do not measure the server alone. The arm is no compared option, because the comparison of the
  // two arms must not warn about it.
  const otherArms = summaries.filter((summary) => armOf(summary) !== 'server');
  results.push(otherArms.length === 0 ? 'pass' : 'miss');
  lines.push(
    otherArms.length === 0
      ? 'the arm: server in each summary'
      : `the arm: MISS, the bar needs the arm server in each summary, and it is ${otherArms.map((summary) => `${armOf(summary)} in ${summary.label}`).join(', ')}`,
  );

  return { item: 1, name: 'Valid runs', result: worst(results), lines };
}

/**
 * Scores item 2: the passed runs of the set, the 5 more runs of a task that passed 3 of 3 in the
 * baseline and fails a run after, no task with fewer passes than in its baseline, and the floor of
 * guest-links-cleanup-calendly with Haiku.
 */
function successItem({ model, a, b, runsA, runsB, runsMore, paired }: Context): { item: BarItem; needMoreRuns: string[] } {
  const lines: string[] = [];
  const results: BarResult[] = [];
  const needMoreRuns: string[] = [];

  const pairedPasses = (runs: readonly RunRecord[]) =>
    passesOf(runs.filter((record) => record.valid && paired.includes(record.taskId)));
  const [passedA, passedB] = [pairedPasses(runsA), pairedPasses(runsB)];
  const enough = passedB >= passedA - 1;
  results.push(enough ? 'pass' : 'miss');
  lines.push(
    `passed runs over the ${paired.length} paired tasks: ${passedA} in ${a.label}, ${passedB} in ${b.label} (at least ${passedA - 1})${enough ? '' : ': MISS'}`,
  );

  const taskLines: string[] = [];
  for (const taskId of paired) {
    const before = validRunsOf(runsA, taskId);
    const after = validRunsOf(runsB, taskId);
    const [passesBefore, passesAfter] = [passesOf(before), passesOf(after)];
    const counts = `${passesBefore} of ${before.length} in ${a.label}, ${passesAfter} of ${after.length} in ${b.label}`;
    if (before.length === 3 && passesBefore === 3 && passesAfter < after.length) {
      const moreRuns = validRunsOf(runsMore, taskId);
      if (moreRuns.length === 0) {
        needMoreRuns.push(taskId);
        results.push('open');
        taskLines.push(`${taskId}: ${counts}: open, it runs 5 more times, and its 8 runs need 7 passes`);
      } else if (moreRuns.length !== 5 || after.length + moreRuns.length !== 8) {
        results.push('open');
        taskLines.push(`${taskId}: ${counts}, and ${moreRuns.length} more valid runs: open, its 8 runs are 3 runs and 5 more`);
      } else {
        const passes = passesAfter + passesOf(moreRuns);
        results.push(passes >= 7 ? 'pass' : 'miss');
        taskLines.push(`${taskId}: ${counts}, with the 5 more runs ${passes} of 8 (at least 7)${passes >= 7 ? '' : ': MISS'}`);
      }
    } else if (passesAfter < passesBefore) {
      results.push('miss');
      taskLines.push(`${taskId}: ${counts}: MISS, it passes fewer runs than in its baseline`);
    }
  }
  lines.push(...(taskLines.length > 0 ? taskLines : ['no task passes fewer runs than in its baseline']));

  if (model === HAIKU) {
    const taskId = 'guest-links-cleanup-calendly';
    if (!paired.includes(taskId)) {
      results.push('open');
      lines.push(`${taskId}: open, it has no valid runs in both summaries, and it needs at least 2 of 3`);
    } else {
      const after = validRunsOf(runsB, taskId);
      const passes = passesOf(after);
      results.push(passes >= 2 ? 'pass' : 'miss');
      lines.push(`${taskId}: ${passes} of ${after.length} in ${b.label} (at least 2 of 3)${passes >= 2 ? '' : ': MISS'}`);
    }
  }
  return { item: { item: 2, name: 'Success', result: worst(results), lines }, needMoreRuns };
}

/**
 * Scores item 3 or 4: the mean for each run over all tasks of the eval is not higher than in the
 * baseline.
 */
function meanItem(
  { taskIds, a, b, runsA, runsB, paired }: Context,
  item: number,
  name: string,
  key: keyof Pick<Means, 'toolCalls' | 'errorResults'>,
): BarItem {
  const pairedRuns = (runs: readonly RunRecord[]) => runs.filter((record) => paired.includes(record.taskId));
  const before = meansOf(pairedRuns(runsA))[key];
  const after = meansOf(pairedRuns(runsB))[key];
  const [ranA, ranB] = [ranOf(runsA, taskIds), ranOf(runsB, taskIds)];
  const notHigher = after <= before;
  const figures = `mean for each run over the ${paired.length} paired tasks: ${before.toFixed(2)} in ${a.label}, ${after.toFixed(2)} in ${b.label}, ${notHigher ? 'not higher' : 'higher'}`;
  if (!ranA.all || !ranB.all) {
    return {
      item,
      name,
      result: 'open',
      lines: [
        figures,
        `open: the item counts the ${taskIds.length} tasks of the eval, and ${a.label} ran ${ranA.ran} of them, ${b.label} ${ranB.ran}`,
      ],
    };
  }
  return { item, name, result: notHigher ? 'pass' : 'miss', lines: [`${figures}${notHigher ? '' : ': MISS'}`] };
}

/**
 * Returns the change from `before` to `after` as "15.86 percent lower" or "2.00 percent higher".
 */
function lowerText(before: number, after: number): string {
  const lower = ((before - after) / before) * 100;
  return lower >= 0 ? `${lower.toFixed(2)} percent lower` : `${(-lower).toFixed(2)} percent higher`;
}

/**
 * Scores item 5: the input tokens for each model request of each level, over the base tasks,
 * against the cuts.
 */
function tokenItem({ taskIds, a, b, runsA, runsB, paired }: Context): BarItem {
  const base = taskIds.filter((taskId) => !taskId.startsWith('hard-'));
  const pairedBase = paired.filter((taskId) => base.includes(taskId));
  const levelsOf = (runs: readonly RunRecord[]) => levelTokensOf(runs.filter((record) => pairedBase.includes(record.taskId)));
  const [levelsA, levelsB] = [levelsOf(runsA), levelsOf(runsB)];
  // The cuts assume the mix of levels of all base tasks, so without all of them the item is open.
  const [ranA, ranB] = [ranOf(runsA, base), ranOf(runsB, base)];
  const decidable = ranA.all && ranB.all;
  const lines = [
    `over the ${pairedBase.length} paired base tasks, by the mean of the runs of each level: the method of the bar.`,
    'The pooled figures (the input tokens of the level over its model requests) are for information only.',
  ];
  const results: BarResult[] = [];
  for (const level of ACCESS_LEVELS) {
    const cut = TOKEN_CUTS[level]!;
    const beforeLevel = levelsA.find((item) => item.level === level);
    const afterLevel = levelsB.find((item) => item.level === level);
    const before = beforeLevel?.meanOfRuns ?? null;
    const after = afterLevel?.meanOfRuns ?? null;
    if (before === null || after === null || before === 0) {
      results.push('open');
      lines.push(
        `${level}: open, a summary has no figure of the level (no valid run with a model request, or no input tokens in the baseline)`,
      );
      continue;
    }
    const lower = ((before - after) / before) * 100;
    results.push(lower >= cut ? 'pass' : 'miss');
    // A level with a mean of runs has a pooled figure too, and both are above 0 in the baseline.
    const pooledBefore = beforeLevel?.pooled ?? before;
    const pooledAfter = afterLevel?.pooled ?? after;
    const pooled = `; pooled ${whole(pooledBefore)} and ${whole(pooledAfter)}, ${lowerText(pooledBefore, pooledAfter)}`;
    const verdict = lower >= cut ? '' : decidable ? ': MISS' : ': below the cut';
    lines.push(
      `${level}: ${whole(before)} in ${a.label}, ${whole(after)} in ${b.label}, ${lowerText(before, after)} (at least ${cut} percent lower)${verdict}${pooled}`,
    );
  }
  if (!decidable) {
    lines.push(
      `open: the cuts assume the mix of levels of all ${base.length} base tasks, and ${a.label} ran ${ranA.ran} of them, ${b.label} ${ranB.ran}`,
    );
  }
  return { item: 5, name: 'Input tokens for each model request', result: decidable ? worst(results) : 'open', lines };
}

/**
 * Scores item 6: one accepted question in each run of the two clear deletes, one declined question
 * and no delete in each run of hard-delete-declined, and no question in the other tasks.
 */
function questionItem({ b, runsB, paired }: Context): BarItem {
  const lines: string[] = [];
  const results: BarResult[] = [];
  for (const { taskId, action } of ASKING_TASKS) {
    if (!paired.includes(taskId)) {
      results.push('open');
      lines.push(`${taskId}: open, it has no valid runs in both summaries`);
      continue;
    }
    const runs = validRunsOf(runsB, taskId);
    const parts = [`${taskId}: the questions of each run in ${b.label}: ${questionsText(questionsOf(runs))}`];
    const once = runs.every(
      (record) => (record.elicitations ?? []).length === 1 && String(record.elicitations?.[0]?.action) === action,
    );
    if (!once) {
      results.push('miss');
      parts.push(`MISS, not one ${action === 'accept' ? 'accepted' : 'declined'} question in each run`);
    } else {
      results.push('pass');
    }
    if (action === 'decline') {
      const checks = runs.map((record) => record.checks.find((check) => NO_DELETE_CHECK.test(check.reason)));
      if (checks.some((check) => check === undefined)) {
        results.push('open');
        parts.push('open, a record has no check of the deletes');
      } else {
        const kept = checks.filter((check) => check?.passed === true).length;
        results.push(kept === runs.length ? 'pass' : 'miss');
        parts.push(`no delete in ${kept} of ${runs.length} runs${kept === runs.length ? '' : ': MISS'}`);
      }
    }
    lines.push(parts.join('; '));
  }
  const named: readonly string[] = ASKING_TASKS.map((task) => task.taskId);
  const asking = paired
    .filter((taskId) => !named.includes(taskId))
    .filter((taskId) => validRunsOf(runsB, taskId).some((record) => (record.elicitations ?? []).length > 0));
  results.push(asking.length === 0 ? 'pass' : 'miss');
  lines.push(
    asking.length === 0
      ? `no other paired task asks in ${b.label}`
      : `MISS, other tasks ask in ${b.label}: ${asking.map((taskId) => `${taskId} (${questionsText(questionsOf(validRunsOf(runsB, taskId)))})`).join(', ')}`,
  );
  return { item: 6, name: 'Questions to the person', result: worst(results), lines };
}

/**
 * Scores item 7, with Haiku only: the targets of three tasks. A miss blocks only when the task is
 * worse than in its baseline, here: when a figure that its target names is higher than in the
 * baseline. A miss that does not block stays open, because a person must find its cause in the
 * streams.
 */
function frictionItem({ a, b, runsA, runsB, paired }: Context): BarItem {
  const lines = ['a task is worse when a figure of its target is higher than in its baseline'];
  const results: BarResult[] = [];
  for (const target of FRICTION_TARGETS) {
    if (!paired.includes(target.taskId)) {
      results.push('open');
      lines.push(`${target.taskId}: open, it has no valid runs in both summaries`);
      continue;
    }
    const before = meansOf(validRunsOf(runsA, target.taskId));
    const after = meansOf(validRunsOf(runsB, target.taskId));
    const figures: { label: string; key: 'toolCalls' | 'errorResults'; most: number }[] = [
      { label: 'tool calls', key: 'toolCalls', most: target.toolCalls },
    ];
    if (target.errorResults !== undefined) {
      figures.push({ label: 'error results', key: 'errorResults', most: target.errorResults });
    }
    const text = figures
      .map((figure) => `${after[figure.key].toFixed(2)} ${figure.label} (at most ${figure.most}, ${before[figure.key].toFixed(2)} in ${a.label})`)
      .join(', ');
    const missed = figures.filter((figure) => after[figure.key] > figure.most);
    const worse = figures.filter((figure) => after[figure.key] > before[figure.key]);
    if (missed.length === 0) {
      results.push('pass');
      lines.push(`${target.taskId} in ${b.label}: ${text}: met`);
    } else if (worse.length > 0) {
      results.push('miss');
      lines.push(
        `${target.taskId} in ${b.label}: ${text}: MISS, it misses the target and has more ${worse.map((figure) => figure.label).join(' and ')} than in its baseline`,
      );
    } else {
      results.push('open');
      lines.push(
        `${target.taskId} in ${b.label}: ${text}: open, the miss does not block, because the task is not worse than in its baseline, but a person must find its cause in the streams`,
      );
    }
  }
  return { item: 7, name: 'Friction of Haiku', result: worst(results), lines };
}

/**
 * Scores the items of the bar for each model that both summaries have, with `a` as the baseline
 * and `b` as the final run. `taskIds` are all tasks of the eval. `more` holds the summaries of the
 * 5 more runs of a task that item 2 names.
 */
export function scoreBar(a: Summary, b: Summary, taskIds: readonly string[], more: readonly Summary[] = []): BarModel[] {
  return a.models
    .map((item) => item.model)
    .filter((model) => b.models.some((item) => item.model === model))
    .map((model) => {
      const own = (summary: Summary) => summary.runs.filter((record) => record.model === model);
      const context: Context = {
        model,
        taskIds,
        a,
        b,
        more,
        runsA: own(a),
        runsB: own(b),
        runsMore: more.flatMap(own),
        paired: pairedTaskIds(a, b, model),
      };
      const success = successItem(context);
      const items = [
        validRunsItem(context),
        success.item,
        meanItem(context, 3, 'Tool calls', 'toolCalls'),
        meanItem(context, 4, 'Error results', 'errorResults'),
        tokenItem(context),
        questionItem(context),
        ...(model === HAIKU ? [frictionItem(context)] : []),
      ];
      return { model, result: worst(items.map((item) => item.result)), items, needMoreRuns: success.needMoreRuns };
    });
}

/**
 * Returns the lines of the printed bar: each item of each model with its result and figures, then
 * the result of the bar.
 */
export function barReport(a: Summary, b: Summary, taskIds: readonly string[], more: readonly Summary[] = []): string[] {
  const scored = scoreBar(a, b, taskIds, more);
  const withMore = more.length > 0 ? `, with the more runs of ${more.map((summary) => summary.label).join(', ')}` : '';
  const lines = [
    '',
    `The acceptance bar of eval/README.md, with the baseline ${a.label} and the run after ${b.label}${withMore}.`,
    'Each item holds over the tasks with valid runs in both summaries.',
  ];
  for (const model of scored) {
    lines.push('', `${model.model}: ${model.result}`);
    for (const item of model.items) {
      lines.push(`  ${item.item}. ${item.name}: ${item.result}`, ...item.lines.map((line) => `     ${line}`));
    }
    if (model.needMoreRuns.length > 0) {
      lines.push(
        `  Item 2 needs 5 more runs of ${model.needMoreRuns.join(', ')} with ${model.model} on the server of ${b.label}:`,
        `  node eval/main.ts --label more-runs --models ${model.model} --tasks ${model.needMoreRuns.join(',')} --repeat 5`,
        '  Then give its summary to the bar with --more-runs.',
      );
    }
  }
  const only = [
    ...a.models.filter((item) => !b.models.some((other) => other.model === item.model)).map((item) => `${item.model}: only in ${a.label}`),
    ...b.models.filter((item) => !a.models.some((other) => other.model === item.model)).map((item) => `${item.model}: only in ${b.label}`),
  ];
  if (only.length > 0) lines.push('', ...only.map((line) => `${line}, so the bar is open for it`));
  const result = worst([...scored.map((model) => model.result), ...(only.length > 0 ? (['open'] as const) : [])]);
  lines.push('', `The bar: ${result}`);
  return lines;
}
