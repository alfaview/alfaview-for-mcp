import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { createLogger } from '../src/log.ts';

function collect() {
  const lines: string[] = [];
  return { lines, log: createLogger((text) => lines.push(text)) };
}

describe('createLogger', () => {
  it('writes one line per message with the prefix and a line break', () => {
    const { lines, log } = collect();
    log.info('logged in');
    log.error('tool find_rooms: Timeout');
    assert.deepEqual(lines, ['alfaview-mcp: logged in\n', 'alfaview-mcp: tool find_rooms: Timeout\n']);
  });

  it('adds the name and the stack frames of an Error, never its message', () => {
    const { lines, log } = collect();
    const error = new TypeError('secret-marker jane.doe@example.com\n    at secret-marker (x:1:1)');
    log.error('tool get_room: internal error', error);

    assert.equal(lines[0], 'alfaview-mcp: tool get_room: internal error (TypeError)\n');
    assert.ok(lines.length > 1);
    for (const line of lines.slice(1)) {
      assert.match(line, /^alfaview-mcp: {5}at /);
      assert.ok(line.endsWith('\n'));
    }
    assert.doesNotMatch(lines.join(''), /secret-marker|jane\.doe/);
  });

  it('keeps the frames of an error whose message changed after its stack was read', () => {
    const { lines, log } = collect();
    const error = new Error('first');
    assert.ok(error.stack?.startsWith('Error: first'));
    error.message = 'secret-marker';
    log.error('failed', error);
    assert.equal(lines[0], 'alfaview-mcp: failed (Error)\n');
    assert.ok(lines.length > 1);
    assert.doesNotMatch(lines.join(''), /secret-marker|first/);
  });

  it('handles an error without a message and one without a stack', () => {
    const { lines, log } = collect();
    const bare = new RangeError();
    log.error('bare', bare);
    assert.equal(lines[0], 'alfaview-mcp: bare (RangeError)\n');

    lines.length = 0;
    const stackless = new Error('secret-marker');
    stackless.stack = undefined;
    log.error('stackless', stackless);
    assert.deepEqual(lines, ['alfaview-mcp: stackless (Error)\n']);
  });

  it('names an Error with an unusual name as Error', () => {
    const { lines, log } = collect();
    const error = new Error('x');
    error.name = 'secret-marker name';
    log.error('odd', error);
    assert.equal(lines[0], 'alfaview-mcp: odd (Error)\n');
    assert.doesNotMatch(lines.join(''), /secret-marker/);
  });

  it('adds only the type of a thrown value that is not an Error', () => {
    const { lines, log } = collect();
    log.error('a string', 'secret-marker');
    log.error('an object', { message: 'secret-marker' });
    log.error('a number', 42);
    assert.deepEqual(lines, [
      'alfaview-mcp: a string (string)\n',
      'alfaview-mcp: an object (object)\n',
      'alfaview-mcp: a number (number)\n',
    ]);
  });

  it('writes to stderr by default', () => {
    const write = mock.method(process.stderr, 'write', () => true);
    try {
      createLogger().info('ready');
    } finally {
      write.mock.restore();
    }
    assert.equal(write.mock.callCount(), 1);
    assert.deepEqual(write.mock.calls[0]?.arguments, ['alfaview-mcp: ready\n']);
  });
});
