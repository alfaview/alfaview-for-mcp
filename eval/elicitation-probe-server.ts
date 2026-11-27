// The stub MCP server of `--probe-elicitation` (cli.ts, runner.ts): it shows whether Claude Code in
// `claude -p` sends a question of the server to the Elicitation hook of the run, and whether the
// answer of the hook comes back to the server. It speaks JSON-RPC over stdio without an SDK, so
// that the probe does not depend on the SDK of the alfaview server:
//
//   node elicitation-probe-server.ts <probe.jsonl>
//
// Its one tool asks the person with elicitation/create whether to delete the "Webinar Room", and
// returns the answer. The server writes the initialize request and each answer to the file of its
// argument, one JSON object per line. It deletes nothing and sends no request to alfaview.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [logFile] = process.argv.slice(2);
if (logFile === undefined) {
  console.error('Usage: node elicitation-probe-server.ts <probe.jsonl>');
  process.exit(2);
}

/** The question of the tool. It names the "Webinar Room", as the accept rule of the probe needs. */
const PROBE_QUESTION = {
  message: 'Delete the room "Webinar Room" for good?',
  requestedSchema: {
    type: 'object',
    properties: { confirm: { type: 'boolean', title: 'Delete the room' } },
    required: ['confirm'],
  },
};

const TOOL = {
  name: 'delete_room',
  description: 'Deletes the room "Webinar Room" after the person confirms it in a question. Call it once.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

type Message = { jsonrpc: '2.0'; id?: string | number; method?: string; params?: any; result?: any; error?: any };

const pending = new Map<string | number, (message: Message) => void>();
let questions = 0;

function send(message: Message): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function log(entry: object): void {
  appendFileSync(logFile!, `${JSON.stringify(entry)}\n`);
}

/** Asks the person and returns the answer of the client, a result or an error. */
function ask(): Promise<Message> {
  questions += 1;
  const id = `probe-question-${questions}`;
  const answer = new Promise<Message>((resolve) => pending.set(id, resolve));
  send({ jsonrpc: '2.0', id, method: 'elicitation/create', params: PROBE_QUESTION });
  return answer;
}

async function handle(message: Message): Promise<void> {
  if (message.method === undefined) {
    // The answer to a question of this server.
    pending.get(message.id!)?.(message);
    pending.delete(message.id!);
    return;
  }
  if (message.id === undefined) return;
  const reply = (result: unknown) => send({ jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'initialize':
      log({ initialize: message.params });
      reply({
        protocolVersion: message.params?.protocolVersion ?? '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'elicitation-probe', version: '1.0.0' },
      });
      return;
    case 'ping':
      reply({});
      return;
    case 'tools/list':
      reply({ tools: [TOOL] });
      return;
    case 'tools/call': {
      const answer = await ask();
      log({ answer: answer.result ?? null, error: answer.error ?? null });
      const text =
        answer.error === undefined
          ? `The person answered: ${JSON.stringify(answer.result)}. Nothing was deleted: this is a probe.`
          : `The question failed: ${String(answer.error?.message)}`;
      reply({ content: [{ type: 'text', text }], isError: answer.error !== undefined });
      return;
    }
    default:
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return;
  try {
    void handle(JSON.parse(line) as Message);
  } catch {
    // A line that is not JSON: the client gets no answer, as for a broken message.
  }
});
