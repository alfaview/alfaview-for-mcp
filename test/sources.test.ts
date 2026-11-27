// The MCP client reads the server's standard output as protocol messages, so nothing in src/ may
// write to it.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SOURCE_ROOT = fileURLToPath(new URL('../src/', import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

const files = sourceFiles(SOURCE_ROOT).map((path) => ({
  name: relative(SOURCE_ROOT, path),
  text: readFileSync(path, 'utf8'),
}));

describe('the sources', () => {
  it('are found', () => {
    assert.ok(files.some((file) => file.name === 'config.ts'));
    assert.ok(files.some((file) => file.name === join('alfaview', 'client.ts')));
  });

  it('never write to standard output', () => {
    for (const { name, text } of files) {
      assert.doesNotMatch(text, /console\./, `${name} uses console`);
      assert.doesNotMatch(text, /stdout/, `${name} names stdout`);
      assert.doesNotMatch(text, /writeSync\(1,/, `${name} writes to file descriptor 1`);
    }
  });

  it('read the environment only in config.ts and main.ts', () => {
    for (const { name, text } of files) {
      if (name === 'config.ts' || name === 'main.ts') continue;
      assert.doesNotMatch(text, /process\.env/, `${name} reads process.env`);
    }
  });
});
