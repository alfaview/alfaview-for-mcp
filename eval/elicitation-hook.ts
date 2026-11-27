// The Elicitation hook of each eval run (runner.ts). Claude Code runs it for each question of the
// server, with the question as JSON on stdin:
//
//   node elicitation-hook.ts <rules.json> <elicitations.jsonl>
//
// It answers as the person of the task, by the rules in <rules.json> (elicitation.ts), adds the
// question and the answer to the log <elicitations.jsonl>, and writes the answer for Claude Code
// to stdout.
import { appendFileSync, readFileSync } from 'node:fs';
import { replyTo, type ElicitationLogEntry, type ElicitationRule } from './elicitation.ts';

const [rulesFile, logFile] = process.argv.slice(2);
if (rulesFile === undefined || logFile === undefined) {
  console.error('Usage: node elicitation-hook.ts <rules.json> <elicitations.jsonl>');
  process.exit(2);
}

const input = JSON.parse(readFileSync(0, 'utf8'));
const rules = JSON.parse(readFileSync(rulesFile, 'utf8')) as ElicitationRule[];
const question = { message: String(input?.message ?? ''), requestedSchema: input?.requested_schema };
const reply = replyTo(question, rules);
const entry: ElicitationLogEntry = { server: String(input?.mcp_server_name), ...question, ...reply };
appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Elicitation', ...reply } }));
