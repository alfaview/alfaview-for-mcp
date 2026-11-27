// docs/tools.md is the reference of the tools that scripts/tools-doc.ts writes from the tool
// definitions. A change of a tool fails here until `npm run docs:tools` writes the page again.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { TOOLS_DOC_PATH, toolsDoc } from '../scripts/tools-doc.ts';
import { ACCESS_LEVELS } from '../src/levels.ts';
import { TOOLS } from '../src/server.ts';

describe('docs/tools.md', () => {
  const text = readFileSync(TOOLS_DOC_PATH, 'utf8');

  it('is the text that scripts/tools-doc.ts writes from the tool definitions', () => {
    assert.equal(text, toolsDoc(), 'docs/tools.md differs from the tools. Run npm run docs:tools.');
  });

  it('has one section for each tool, under the heading of its level, in the order of the tool list', () => {
    const headings = [...text.matchAll(/^(##|###) (.+)$/gm)].map(([, marks, name]) => `${marks} ${name}`);
    const expected = ACCESS_LEVELS.flatMap((level) => [
      `## Level ${level}`,
      ...TOOLS.filter((tool) => tool.level === level).map((tool) => `### ${tool.name}`),
    ]);
    assert.deepEqual(headings, expected);
  });

  it('gives each parameter of a tool a row of its table', () => {
    for (const tool of TOOLS) {
      const start = text.indexOf(`\n### ${tool.name}\n`);
      const end = text.indexOf('\n##', start + 1);
      const section = text.slice(start, end === -1 ? undefined : end);
      for (const key of Object.keys(tool.inputSchema.shape)) {
        assert.ok(section.includes(`\n| \`${key}\` |`), `${tool.name}: ${key}`);
      }
    }
  });
});
