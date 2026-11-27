// The names and numbers that README.md and the pages of docs/ give for the configuration and the
// tools: each environment variable is one that the server reads, each tool name is a tool of the
// server, and each number of tools of a level is the number that the server registers. The raw URL
// of docs/agent-setup.md names the GitHub repository of package.json, so the prompt of the README
// gives an AI agent the page of this package.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ConfigError, readConfig, REPLACED_TOOLS } from '../src/config.ts';
import { ACCESS_LEVELS, levelIncludes } from '../src/levels.ts';
import { TOOLS, toolsOfLevel } from '../src/server.ts';

const PACKAGE = new URL('../', import.meta.url);
const DOCS = new URL('docs/', PACKAGE);

/** The text of each doc of the package, by its path in the package. */
const docs = new Map<string, string>([
  ['README.md', readFileSync(new URL('README.md', PACKAGE), 'utf8')],
  ...readdirSync(DOCS)
    .filter((name) => name.endsWith('.md'))
    .map((name): [string, string] => [`docs/${name}`, readFileSync(new URL(name, DOCS), 'utf8')]),
]);

/** The variables ALFAVIEW_* that readConfig reads, in the order of their first read. */
function configVariables(): string[] {
  const read = new Set<string>();
  const env = new Proxy({} as Record<string, string | undefined>, {
    get(_target, key) {
      if (typeof key === 'string') read.add(key);
      return undefined;
    },
  });
  assert.throws(() => readConfig(env, TOOLS), ConfigError);
  return [...read].filter((name) => name.startsWith('ALFAVIEW_'));
}

const names = TOOLS.map((tool) => tool.name);

describe('the docs of the package', () => {
  const variables = configVariables();

  it('name only the environment variables that the server reads', () => {
    for (const [file, text] of docs) {
      for (const [name] of text.matchAll(/ALFAVIEW_[A-Z0-9_]+/g)) {
        assert.ok(variables.includes(name), `${file}: ${name}`);
      }
    }
  });

  it('give each variable of the server a row of docs/configuration.md', () => {
    const configuration = docs.get('docs/configuration.md') ?? '';
    for (const name of variables) {
      assert.ok(configuration.includes(`\n| \`${name}\` |`), name);
    }
  });

  it('name only tools of the server in the lists of tool names and in the tool names of Claude Code', () => {
    for (const [file, text] of docs) {
      for (const [list] of text.matchAll(/\b[a-z]+(?:_[a-z]+)+(?:,[a-z]+(?:_[a-z]+)+)+\b/g)) {
        for (const name of list.split(',')) assert.ok(names.includes(name), `${file}: ${name}`);
      }
      // A permission rule of a replaced tool is the example of the rule to change.
      for (const [, name] of text.matchAll(/\bmcp__[a-z-]+__([a-z_]+)/g)) {
        assert.ok(names.includes(name!) || Object.hasOwn(REPLACED_TOOLS, name!), `${file}: ${name}`);
      }
    }
  });

  it('give the entry alfaview of docs/clients.md every tool of the level standard but get_company_statistics', () => {
    const expected = TOOLS.filter(
      (tool) => levelIncludes('standard', tool.level) && tool.name !== 'get_company_statistics',
    ).map((tool) => tool.name);
    const lists = [...(docs.get('docs/clients.md') ?? '').matchAll(/ALFAVIEW_TOOLS(?:=|": ")([a-z_,]+)/g)];
    assert.ok(lists.length > 0);
    for (const [, list] of lists) assert.deepEqual(list!.split(','), expected);
  });

  it('give the raw URL of docs/agent-setup.md in the repository of package.json', () => {
    const manifest = JSON.parse(readFileSync(new URL('package.json', PACKAGE), 'utf8')) as {
      repository: { url: string };
    };
    const repository = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)\.git$/.exec(manifest.repository.url)?.[1];
    assert.ok(repository, manifest.repository.url);
    assert.ok(docs.has('docs/agent-setup.md'));
    const expected = `https://raw.githubusercontent.com/${repository}/main/docs/agent-setup.md`;
    assert.ok((docs.get('README.md') ?? '').includes(expected), expected);
    for (const [file, text] of docs) {
      for (const [url] of text.matchAll(/https:\/\/raw\.githubusercontent\.com\/[^\s)`]+/g)) {
        assert.equal(url, expected, file);
      }
    }
  });

  it('give the number of tools of the level in each example first line of the log', () => {
    const counts = new Map<string, number>(ACCESS_LEVELS.map((level) => [level, toolsOfLevel(level).length]));
    const pattern = /with\s+(\d+)\s+tools\s+at\s+level\s+([a-z]+)/g;
    assert.ok([...(docs.get('docs/troubleshooting.md') ?? '').matchAll(pattern)].length > 0);
    for (const [file, text] of docs) {
      for (const [line, number, level] of text.matchAll(pattern)) {
        assert.equal(Number(number), counts.get(level!), `${file}: ${line}`);
      }
    }
  });
});
