// The command line of the eval: runs the tasks, writes the records and the summary into
// eval/results/, and prints a table per model. `--compare a.json b.json` prints the differences of
// two summaries, and `--bar` adds the acceptance bar (bar.ts). The README of this folder describes
// the options.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { barReport } from './bar.ts';
import { compareSummaries, modelReport, summarize, type RunRecord, type Summary } from './report.ts';
import { ARMS, crashedRecord, probeElicitation, runOne, stopRuns, type Arm, type RunOptions, type RunSpec } from './runner.ts';
import { selectTasks, TASKS } from './tasks.ts';

const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url));
const RESULTS_DIR = fileURLToPath(new URL('./results/', import.meta.url));

export const DEFAULT_MODELS = ['claude-sonnet-5-5', 'claude-haiku-5-5'];

const USAGE = `Usage: npm run eval -- [options]

  --models <a,b>          models to run (default: ${DEFAULT_MODELS.join(',')})
  --tasks <a,b>           task IDs or levels (read, standard, manage, full); default: all tasks
  --arm <name>            server (only the server), plain (also the tools of a skill) or skill
                          (plain and the plugin with its skill); default: server
  --repeat <n>            runs of each task per model (default: 1)
  --concurrency <n>       runs at the same time (default: 3)
  --label <text>          name of the results folder and the summary (default: run)
  --max-turns <n>         turn limit of each run (default: 15)
  --max-budget-usd <n>    cost limit of each run in USD (default: 0.5)
  --timeout <s>           time limit of each run in seconds (default: 300)
  --effort <level>        effort of Claude Code, or "default" for its default (default: medium)
  --claude <path>         the claude binary (default: claude on the PATH)
  --config-dir <path>     CLAUDE_CONFIG_DIR of the login to use (default: the variable of this shell)
  --list                  print the tasks and stop
  --compare <a> <b>       print the differences of two summary files and stop
  --bar                   with --compare: also score the acceptance bar of eval/README.md,
                          with <a> as the baseline and <b> as the final run, both of the arm server
  --more-runs <file>      with --bar: a summary with the 5 more runs of a task that item 2 of the
                          bar names; give it once for each such summary
  --probe-elicitation     check with a stub server and the first model of --models that a question
                          of a server reaches the Elicitation hook and its answer comes back, then stop
  --help                  print this text`;

/**
 * Returns a problem with dist/, or undefined when dist/main.js exists and is newer than every file
 * of src/.
 */
export function distProblem(packageDir: string): string | undefined {
  const main = join(packageDir, 'dist', 'main.js');
  if (!existsSync(main)) return 'dist/main.js is missing. Run "npm run build" in the package folder first.';
  const built = statSync(main).mtimeMs;
  const sources = readdirSync(join(packageDir, 'src'), { recursive: true, encoding: 'utf8' })
    .map((file) => join(packageDir, 'src', file))
    .filter((file) => statSync(file).isFile());
  const newer = sources.find((file) => statSync(file).mtimeMs > built);
  return newer === undefined
    ? undefined
    : `${relative(packageDir, newer)} is newer than dist/main.js. Run "npm run build" in the package folder first.`;
}

function positiveInteger(value: string, option: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${option} must be a whole number of 1 or more`);
  return number;
}

function positiveNumber(value: string, option: string): number {
  const number = Number(value);
  if (!(number > 0)) throw new Error(`${option} must be a number above 0`);
  return number;
}

function armOf(value: string): Arm {
  if (!(ARMS as readonly string[]).includes(value)) {
    throw new Error(`--arm must be ${ARMS.slice(0, -1).join(', ')} or ${ARMS.at(-1)}, not "${value}"`);
  }
  return value as Arm;
}

function list(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * Runs `work` on each item, with at most `size` at the same time, and keeps the order. After
 * `stopped` gives true, it starts no more work.
 */
async function pool<T, R>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<R>,
  stopped: () => boolean,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stopped()) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

/** Returns the local time as 20261028-142501, for the name of the results folder. */
function stamp(date: Date): string {
  const two = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

/** Returns the trimmed output of a command, or null when it fails. */
function outputOf(command: string, args: string[], env?: Record<string, string>): string | null {
  try {
    return execFileSync(command, args, { cwd: PACKAGE_DIR, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function printTasks(): void {
  for (const task of TASKS) {
    const omit = task.personalData === 'omit' ? ', personal data omit' : '';
    console.log(`${task.id} (${task.level}, ${task.kind}${omit}): ${task.intent}`);
  }
}

/** Prints the comparison of two summaries and, with `bar`, the acceptance bar (bar.ts). */
function compare(files: readonly string[], bar: boolean, moreFiles: readonly string[]): number {
  if (files.length !== 2) {
    console.error('--compare needs two summary files.');
    return 2;
  }
  const read = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Summary;
  const [a, b] = files.map(read);
  const lines = compareSummaries(a!, b!);
  if (bar) lines.push(...barReport(a!, b!, TASKS.map((task) => task.id), moreFiles.map(read)));
  console.log(lines.join('\n'));
  return 0;
}

/**
 * Runs the probe of the questions to the person twice, once with a person who accepts and once
 * with one who declines, and prints what reached the hook and the server.
 */
async function probe(model: string, options: RunOptions): Promise<number> {
  let failed = false;
  for (const expected of ['accept', 'decline'] as const) {
    const result = await probeElicitation(model, expected, options);
    const verdict = result.problems.length === 0 ? 'works' : `FAILS: ${result.problems.join('; ')}`;
    console.log(
      `${model}, a person who answers ${expected}: ${verdict}. Protocol ${result.protocolVersion ?? 'unknown'}, ${result.hookEntries.length} questions at the hook, server got ${JSON.stringify(result.serverAnswers)}.`,
    );
    failed ||= result.problems.length > 0;
  }
  return failed ? 1 : 0;
}

/**
 * Returns the checked options of the command line. Throws an Error with a message for the person.
 */
export function readOptions(argv: readonly string[]) {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      models: { type: 'string', default: DEFAULT_MODELS.join(',') },
      tasks: { type: 'string', default: '' },
      arm: { type: 'string', default: 'server' },
      repeat: { type: 'string', default: '1' },
      concurrency: { type: 'string', default: '3' },
      label: { type: 'string', default: 'run' },
      'max-turns': { type: 'string', default: '15' },
      'max-budget-usd': { type: 'string', default: '0.5' },
      timeout: { type: 'string', default: '300' },
      effort: { type: 'string', default: 'medium' },
      claude: { type: 'string', default: 'claude' },
      'config-dir': { type: 'string' },
      list: { type: 'boolean', default: false },
      compare: { type: 'boolean', default: false },
      bar: { type: 'boolean', default: false },
      'more-runs': { type: 'string', multiple: true, default: [] },
      'probe-elicitation': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (!values.compare && positionals.length > 0) {
    throw new Error(`Unknown arguments: ${positionals.join(' ')}`);
  }
  if (values.bar && !values.compare) throw new Error('--bar works only with --compare.');
  if (values['more-runs'].length > 0 && !values.bar) throw new Error('--more-runs works only with --bar.');
  if (!/^[\w.-]+$/.test(values.label)) {
    throw new Error('--label can hold only letters, digits, dots, underscores and hyphens.');
  }
  // Two runs of the same model would write the same record files at the same time.
  const models = list(values.models);
  const twice = models.filter((model, index) => models.indexOf(model) !== index);
  if (twice.length > 0) throw new Error(`--models names ${[...new Set(twice)].join(', ')} more than once.`);
  const options: RunOptions = {
    claudeBin: values.claude,
    configDir: values['config-dir'] ?? process.env.CLAUDE_CONFIG_DIR,
    maxTurns: positiveInteger(values['max-turns'], '--max-turns'),
    maxBudgetUsd: positiveNumber(values['max-budget-usd'], '--max-budget-usd'),
    timeoutMs: positiveNumber(values.timeout, '--timeout') * 1000,
    effort: values.effort === 'default' ? undefined : values.effort,
    arm: armOf(values.arm),
  };
  return {
    values,
    positionals,
    models,
    tasks: selectTasks(list(values.tasks)),
    repeat: positiveInteger(values.repeat, '--repeat'),
    concurrency: positiveInteger(values.concurrency, '--concurrency'),
    options,
  };
}

/** Returns the options of the runs as `options` of summary.json. */
export function summaryOptions(read: ReturnType<typeof readOptions>): Record<string, unknown> {
  const { models, tasks, repeat, concurrency, options } = read;
  return {
    models,
    tasks: tasks.map((task) => task.id),
    repeat,
    concurrency,
    maxTurns: options.maxTurns,
    maxBudgetUsd: options.maxBudgetUsd,
    timeoutS: options.timeoutMs / 1000,
    effort: options.effort ?? 'default',
    arm: options.arm,
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  let read: ReturnType<typeof readOptions>;
  try {
    read = readOptions(argv);
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals, models, tasks, repeat, concurrency, options } = read;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values.list) {
    printTasks();
    return 0;
  }
  if (values.compare) return compare(positionals, values.bar, values['more-runs']);
  if (values['probe-elicitation']) return probe(models[0]!, options);

  const problem = distProblem(PACKAGE_DIR);
  if (problem !== undefined) {
    console.error(problem);
    return 1;
  }

  const versionEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
  const claudeVersion = outputOf(options.claudeBin, ['--version'], versionEnv);
  if (claudeVersion === null) {
    console.error(`Cannot run "${options.claudeBin} --version". Give the claude binary with --claude.`);
    return 1;
  }

  const started = new Date();
  const outDir = join(RESULTS_DIR, `${values.label}-${stamp(started)}`);
  await mkdir(RESULTS_DIR, { recursive: true });
  try {
    // Not recursive: a folder that exists belongs to another invocation.
    await mkdir(outDir);
  } catch {
    console.error(`${relative(process.cwd(), outDir)} exists. Wait a second, or give another --label.`);
    return 1;
  }
  const specs: RunSpec[] = models.flatMap((model) =>
    tasks.flatMap((task) =>
      Array.from({ length: repeat }, (_, index) => ({ task, model, repeat: index + 1, outDir })),
    ),
  );
  console.log(
    `${specs.length} runs: ${tasks.length} tasks, ${models.join(' and ')}, ${repeat} each, ${concurrency} at a time, the arm ${options.arm}. Claude Code ${claudeVersion}.`,
  );
  console.log(`Results: ${relative(process.cwd(), outDir)}\n`);

  // A stop ends the claude runs and removes their temporary folders. The eval then starts no more
  // runs and writes no summary, because the runs that the stop ended say nothing about the server.
  const exitCodes: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
  let stopSignal: string | undefined;
  let stopped: Promise<void> | undefined;
  for (const signal of Object.keys(exitCodes)) {
    process.once(signal, () => {
      stopSignal ??= signal;
      console.error(`\nStopping (${signal}): ending the open runs.`);
      stopped ??= stopRuns();
    });
  }

  let done = 0;
  const records = await pool(specs, concurrency, async (spec): Promise<RunRecord> => {
    let record: RunRecord;
    try {
      record = await runOne(spec, options);
    } catch (error) {
      // One run that the eval cannot do must not end the other runs.
      record = crashedRecord(spec, error);
    }
    done += 1;
    const verdict = !record.valid
      ? `invalid (${record.invalidReasons.join('; ')})`
      : record.passed
        ? 'pass'
        : record.runProblems.length > 0
          ? `FAIL (${record.runProblems.join('; ')})`
          : 'FAIL';
    const cost = record.costUsd === null ? 'n/a' : `$${record.costUsd.toFixed(4)}`;
    const clientCalls = record.toolCalls.filter((call) => call.server === false).length;
    const calls = `${record.toolCalls.length - clientCalls} calls${clientCalls > 0 ? ` and ${clientCalls} client calls` : ''}`;
    console.log(
      `[${done}/${specs.length}] ${spec.model} ${spec.task.id} run ${spec.repeat}: ${verdict}, ${calls}, ${cost}, ${(record.wallMs / 1000).toFixed(1)} s`,
    );
    return record;
  }, () => stopSignal !== undefined);

  if (stopSignal !== undefined) {
    await stopped;
    console.error(`Stopped by ${stopSignal}. The finished runs are in the results folder; no summary was written.`);
    return exitCodes[stopSignal]!;
  }

  const summary: Summary = {
    label: values.label,
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    options: summaryOptions(read),
    environment: {
      node: process.version,
      claudeVersion,
      claudeCodeVersions: [...new Set(records.map((record) => record.claudeCodeVersion))],
      mcpProtocolVersions: [...new Set(records.map((record) => record.mcpProtocolVersion))],
      featureFlags: [...new Set(records.flatMap((record) => record.featureFlags))].sort(),
      elicitations: records.reduce((sum, record) => sum + record.elicitations.length, 0),
      serverVersion: JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')).version,
      gitCommit: outputOf('git', ['rev-parse', 'HEAD']),
      srcChanged: (outputOf('git', ['status', '--porcelain', '--', 'src']) ?? '') !== '',
      contractProblems: records.reduce((sum, record) => sum + record.contractProblems.length, 0),
    },
    models: summarize(records, models),
    runs: records,
  };
  const summaryFile = join(outDir, 'summary.json');
  await writeFile(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);

  for (const model of summary.models) console.log(`\n${modelReport(model).join('\n')}`);
  if (summary.environment.contractProblems !== 0) {
    console.log(`\nRequests that do not fit spec/openapi-v2.json: ${summary.environment.contractProblems}. See contractProblems in the records.`);
  }
  console.log(`\nSummary: ${relative(process.cwd(), summaryFile)}`);
  return 0;
}
