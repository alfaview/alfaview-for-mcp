// The answers of the person to the questions of the server in the model eval (eval/elicitation.ts
// and the hook eval/elicitation-hook.ts).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { parseElicitationLog, replyTo } from '../../eval/elicitation.ts';

const SCHEMA = {
  type: 'object',
  properties: {
    confirm: { type: 'boolean', title: 'Delete it' },
    roomName: { type: 'string', title: 'The name of the room' },
    reason: { type: 'string', enum: ['left', 'other'] },
    count: { type: 'number' },
    broken: 'not a schema',
  },
};
const RULES = [{ names: 'Advisory Room Ben Example', text: 'Advisory Room Ben Example' }];

describe('the answers of the person to a question of the server', () => {
  it('accept a question that names what the person asked for, with yes and the text', () => {
    assert.deepEqual(
      replyTo({ message: 'Delete the room "advisory room ben example" for good?', requestedSchema: SCHEMA }, RULES),
      { action: 'accept', content: { confirm: true, roomName: 'Advisory Room Ben Example' } },
    );
  });

  it('find the name also in the form, and fill a list field only with a value of the list', () => {
    const schema = { properties: { roomName: { type: 'string', title: 'Advisory Room Ben Example' }, kind: { type: 'string', enum: ['yes'] } } };
    assert.deepEqual(replyTo({ message: 'Confirm the delete.', requestedSchema: schema }, [{ names: 'Advisory Room Ben Example', text: 'yes' }]), {
      action: 'accept',
      content: { roomName: 'yes', kind: 'yes' },
    });
    assert.deepEqual(replyTo({ message: 'Advisory Room Ben Example?' }, [{ names: 'Advisory Room Ben Example' }]), {
      action: 'accept',
      content: {},
    });
  });

  it('decline every other question, and every question without rules', () => {
    assert.deepEqual(replyTo({ message: 'Delete the room "Team Room"?', requestedSchema: SCHEMA }, RULES), { action: 'decline' });
    assert.deepEqual(replyTo({ message: 'Delete the room "Advisory Room Ben Example"?' }, []), { action: 'decline' });
  });

  it('read the log of the hook and skip a line that is not complete', () => {
    assert.deepEqual(parseElicitationLog('{"server":"alfaview","message":"m","action":"decline"}\n{"server":\n42\n\n'), [
      { server: 'alfaview', message: 'm', action: 'decline' },
    ]);
  });
});

describe('the Elicitation hook', () => {
  const folder = mkdtempSync(join(tmpdir(), 'alfaview-mcp-eval-hook-'));
  after(() => rmSync(folder, { recursive: true, force: true }));
  const hook = fileURLToPath(new URL('../../eval/elicitation-hook.ts', import.meta.url));
  const rules = join(folder, 'rules.json');
  const log = join(folder, 'elicitations.jsonl');
  writeFileSync(rules, JSON.stringify(RULES));

  function ask(message: string): unknown {
    const input = { hook_event_name: 'Elicitation', mcp_server_name: 'alfaview', message, requested_schema: SCHEMA };
    return JSON.parse(execFileSync(process.execPath, [hook, rules, log], { input: JSON.stringify(input), encoding: 'utf8' }));
  }

  it('answers Claude Code as the person and logs each question with its answer', () => {
    assert.deepEqual(ask('Delete the room "Advisory Room Ben Example"?'), {
      hookSpecificOutput: {
        hookEventName: 'Elicitation',
        action: 'accept',
        content: { confirm: true, roomName: 'Advisory Room Ben Example' },
      },
    });
    assert.deepEqual(ask('Delete the user ben.example@example.com?'), {
      hookSpecificOutput: { hookEventName: 'Elicitation', action: 'decline' },
    });
    const entries = parseElicitationLog(readFileSync(log, 'utf8'));
    assert.deepEqual(
      entries.map((entry) => [entry.server, entry.message, entry.action]),
      [
        ['alfaview', 'Delete the room "Advisory Room Ben Example"?', 'accept'],
        ['alfaview', 'Delete the user ben.example@example.com?', 'decline'],
      ],
    );
    assert.deepEqual(entries[0]?.requestedSchema, SCHEMA);
  });

  it('stops with a usage text without its files', () => {
    assert.throws(
      () => execFileSync(process.execPath, [hook], { input: '{}', encoding: 'utf8', stdio: 'pipe' }),
      /Usage: node elicitation-hook\.ts/,
    );
  });
});
