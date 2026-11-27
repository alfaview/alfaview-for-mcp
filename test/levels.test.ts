import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ACCESS_LEVELS, DEFAULT_ACCESS_LEVEL, levelIncludes } from '../src/levels.ts';

describe('the access levels', () => {
  it('come from the fewest tools to every tool, with standard as the default', () => {
    assert.deepEqual(ACCESS_LEVELS, ['read', 'standard', 'manage', 'full']);
    assert.equal(DEFAULT_ACCESS_LEVEL, 'standard');
  });

  it('include the tools of their own level and of every level before it', () => {
    const included = ACCESS_LEVELS.map((level) =>
      ACCESS_LEVELS.filter((toolLevel) => levelIncludes(level, toolLevel)),
    );
    assert.deepEqual(included, [
      ['read'],
      ['read', 'standard'],
      ['read', 'standard', 'manage'],
      ['read', 'standard', 'manage', 'full'],
    ]);
  });
});
