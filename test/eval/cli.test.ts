// The options and the check of dist/ before the model eval runs (eval/cli.ts).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DEFAULT_MODELS, distProblem, main, readOptions, summaryOptions } from '../../eval/cli.ts';
import { summarize, type RunRecord, type Summary } from '../../eval/report.ts';

describe('the options of the eval', () => {
  it('take the defaults, and the models and tasks as lists', () => {
    const read = readOptions(['--models', 'claude-haiku-5-5', '--tasks', 'read-room-passcode,full']);
    assert.deepEqual(read.models, ['claude-haiku-5-5']);
    assert.ok(read.tasks.length > 1);
    assert.equal(read.options.effort, 'medium');
    assert.equal(read.options.timeoutMs, 300_000);
    assert.equal(readOptions(['--effort', 'default']).options.effort, undefined);
  });

  it('take the arm server by default, the arms plain and skill, and no other arm', () => {
    assert.equal(readOptions([]).options.arm, 'server');
    assert.equal(readOptions(['--arm', 'plain']).options.arm, 'plain');
    assert.equal(readOptions(['--arm', 'skill']).options.arm, 'skill');
    assert.throws(() => readOptions(['--arm', 'plugin']), /--arm must be server, plain or skill, not "plugin"/);
  });

  it('give the summary the options of the runs, the arm included', () => {
    assert.deepEqual(summaryOptions(readOptions(['--arm', 'skill', '--tasks', 'read-room-passcode', '--effort', 'default'])), {
      models: DEFAULT_MODELS,
      tasks: ['read-room-passcode'],
      repeat: 1,
      concurrency: 3,
      maxTurns: 15,
      maxBudgetUsd: 0.5,
      timeoutS: 300,
      effort: 'default',
      arm: 'skill',
    });
    assert.equal(summaryOptions(readOptions([])).arm, 'server');
  });

  it('refuse a model named twice, which would write the same files twice at the same time', () => {
    assert.throws(
      () => readOptions(['--models', 'claude-haiku-5-5, claude-haiku-5-5,claude-sonnet-5-5']),
      /--models names claude-haiku-5-5 more than once/,
    );
  });

  it('refuse a bad label, a bad number and an unknown argument', () => {
    assert.throws(() => readOptions(['--label', '../x']), /--label can hold only/);
    assert.throws(() => readOptions(['--repeat', '0']), /--repeat must be a whole number/);
    assert.throws(() => readOptions(['--timeout', '0']), /--timeout must be a number above 0/);
    assert.throws(() => readOptions(['extra']), /Unknown arguments: extra/);
  });

  it('take the bar only with --compare, and the more runs only with the bar', () => {
    const read = readOptions(['--compare', 'a.json', 'b.json', '--bar', '--more-runs', 'c.json', '--more-runs', 'd.json']);
    assert.equal(read.values.bar, true);
    assert.deepEqual(read.values['more-runs'], ['c.json', 'd.json']);
    assert.deepEqual(readOptions([]).values['more-runs'], []);
    assert.throws(() => readOptions(['--bar']), /--bar works only with --compare/);
    assert.throws(() => readOptions(['--compare', 'a.json', 'b.json', '--more-runs', 'c.json']), /--more-runs works only with --bar/);
  });
});

describe('the comparison on the command line', () => {
  const folder = mkdtempSync(join(tmpdir(), 'alfaview-mcp-eval-compare-'));
  after(() => rmSync(folder, { recursive: true, force: true }));

  /** Writes a summary of one passed run of read-room-passcode with Haiku, and returns its path. */
  function summaryFile(label: string): string {
    const record = {
      taskId: 'read-room-passcode',
      level: 'read',
      kind: 'read',
      model: 'claude-haiku-5-5',
      repeat: 1,
      prompt: 'What is the passcode?',
      startedAt: '2026-10-29T09:00:00.000Z',
      valid: true,
      invalidReasons: [],
      runProblems: [],
      passed: true,
      checks: [],
      toolCalls: [],
      modelRequests: 1,
      turns: 1,
      tokens: { input: 0, output: 10, cacheRead: 1000, cacheCreation: 0 },
      costUsd: 0.001,
      durationMs: 1000,
      wallMs: 1000,
      resultSubtype: 'success',
      finalText: 'Kx7#mQ2p',
      claudeCodeVersion: '2.1.312',
      toolsOffered: 9,
      mcpProtocolVersion: '2026-07-28',
      featureFlags: [],
      elicitations: [],
      requestCount: 2,
      writeCount: 0,
      emails: [],
      contractProblems: [],
      exitCode: 0,
      timedOut: false,
      streamFile: '',
    } satisfies RunRecord;
    const summary: Summary = {
      label,
      startedAt: '2026-10-29T09:00:00.000Z',
      finishedAt: '2026-10-29T09:01:00.000Z',
      options: { tasks: ['read-room-passcode'], repeat: 1 },
      environment: {},
      models: summarize([record], ['claude-haiku-5-5']),
      runs: [record],
    };
    const file = join(folder, `${label}.json`);
    writeFileSync(file, JSON.stringify(summary));
    return file;
  }

  it('prints the bar after the comparison, with the more runs, and starts no run', async (t) => {
    const printed: string[] = [];
    t.mock.method(console, 'log', (text: string) => printed.push(text));
    const files = [summaryFile('base'), summaryFile('after'), summaryFile('more')];
    assert.equal(await main(['--compare', files[0]!, files[1]!, '--bar', '--more-runs', files[2]!]), 0);
    const text = printed.join('\n');
    assert.match(text, /^Compare base/);
    assert.match(text, /The acceptance bar of eval\/README\.md, with the baseline base and the run after after, with the more runs of more\./);
    // The summaries ran 1 of the tasks of the eval.
    assert.match(text, /open: the item counts the 39 tasks of the eval, and base ran 1 of them, after 1/);
    assert.match(text, /The bar: open$/);

    printed.length = 0;
    assert.equal(await main(['--compare', files[0]!, files[1]!]), 0);
    assert.doesNotMatch(printed.join('\n'), /acceptance bar/);
  });
});

describe('the check of dist/ before the eval', () => {
  const folder = mkdtempSync(join(tmpdir(), 'alfaview-mcp-eval-test-'));
  after(() => rmSync(folder, { recursive: true, force: true }));
  mkdirSync(join(folder, 'src', 'tools'), { recursive: true });
  const source = join(folder, 'src', 'tools', 'rooms.ts');
  writeFileSync(source, '');

  it('asks for a build in the package folder when dist/main.js is missing', () => {
    assert.equal(distProblem(folder), 'dist/main.js is missing. Run "npm run build" in the package folder first.');
  });

  it('asks for a build when a file of src/ is newer than dist/main.js, and passes after it', () => {
    mkdirSync(join(folder, 'dist'));
    const main = join(folder, 'dist', 'main.js');
    writeFileSync(main, '');
    utimesSync(main, new Date('2026-10-28T09:00:00Z'), new Date('2026-10-28T09:00:00Z'));
    utimesSync(source, new Date('2026-10-28T10:00:00Z'), new Date('2026-10-28T10:00:00Z'));
    assert.equal(
      distProblem(folder),
      'src/tools/rooms.ts is newer than dist/main.js. Run "npm run build" in the package folder first.',
    );
    utimesSync(main, new Date('2026-10-28T11:00:00Z'), new Date('2026-10-28T11:00:00Z'));
    assert.equal(distProblem(folder), undefined);
  });
});
