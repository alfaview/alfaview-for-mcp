// Tool definitions on a real McpServer, called by an SDK client over the in-memory transport with
// a real AlfaviewClient on a fake fetch, so the tool tests see what an MCP client sees. They run on
// the 2025 era of the protocol, and `connectModern` pins a client to revision 2026-07-28.
import assert from 'node:assert/strict';
import {
  Client,
  InMemoryTransport,
  type ClientCapabilities,
  type ElicitRequest,
  type ElicitResult,
} from '@modelcontextprotocol/client';
import { McpServer, type McpServerFactory } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { AlfaviewClient } from '../../src/alfaview/client.ts';
import type { AccessLevel } from '../../src/levels.ts';
import { createLogger } from '../../src/log.ts';
import { protocolOptions, TOOLS } from '../../src/server.ts';
import type { PersonalDataMode } from '../../src/shared/personalData.ts';
import { Confirmations } from '../../src/tools/confirmation.ts';
import { registerTools, type AnyTool } from '../../src/tools/tool.ts';
import { testClock } from './clock.ts';
import { fakeFetch, TEST_CONFIG, type ExpectedRequest, type FakeFetch } from './fakeFetch.ts';

export const TEST_TIME_ZONE = 'Europe/Berlin';

export type ConnectOptions = {
  fetch: typeof fetch;
  /** The clock of the client and of the tools. */
  now: () => number;
  /** Default Europe/Berlin. */
  timeZone?: string;
  timeoutMs?: number;
  callTimeLimitMs?: number;
  /** The option Personal data of the server. Left out, the tools get no value, as by default. */
  personalData?: PersonalDataMode;
  /** The access level of the server. Left out, the tools get no value: `standard` by default. */
  level?: AccessLevel;
  /** A client that can ask the person, and how it answers (Asking). Left out, it cannot ask. */
  asking?: Asking;
  /** The confirmations of the server, for a test that shares them. A new one by default. */
  confirmations?: Confirmations;
};

/** A question of the server as the handler of the client gets it. */
export type Question = ElicitRequest['params'];

/**
 * How a test client asks the person: the elicitation capability that it declares, form mode by
 * default, and the person's answer to each question.
 */
export type Asking = {
  capability?: NonNullable<ClientCapabilities['elicitation']>;
  answer(question: Question): ElicitResult | Promise<ElicitResult>;
};

/** Returns a client with the capability and the handler of `asking`, or one that cannot ask. */
export function testClient(asking?: Asking, options: ConstructorParameters<typeof Client>[1] = {}): Client {
  if (asking === undefined) return new Client({ name: 'test', version: '0.0.0' }, options);
  const client = new Client(
    { name: 'test', version: '0.0.0' },
    { ...options, capabilities: { elicitation: asking.capability ?? { form: {} } } },
  );
  client.setRequestHandler('elicitation/create', (request) => asking.answer(request.params));
  return client;
}

export type ConnectedTools = {
  client: Client;
  /** The log lines of the server, each with its line break. */
  logLines: string[];
  close(): Promise<void>;
};

/**
 * Registers `tools` on a new server with the protocol options of the server (protocolOptions) and
 * connects an SDK client to it.
 */
export async function connectTools(
  tools: readonly AnyTool[],
  options: ConnectOptions,
): Promise<ConnectedTools> {
  const logLines: string[] = [];
  const log = createLogger((text) => logLines.push(text));
  const alfaview = new AlfaviewClient({
    config: TEST_CONFIG,
    fetch: options.fetch,
    log,
    now: options.now,
    timeoutMs: options.timeoutMs,
    callTimeLimitMs: options.callTimeLimitMs,
  });
  const confirmations = options.confirmations ?? new Confirmations(options.now);
  const server = new McpServer({ name: 'alfaview', version: '0.0.0' }, protocolOptions(confirmations));
  registerTools(server, tools, {
    client: alfaview,
    log,
    timeZone: options.timeZone ?? TEST_TIME_ZONE,
    now: options.now,
    confirmations,
    ...(options.personalData === undefined ? {} : { personalData: options.personalData }),
    ...(options.level === undefined ? {} : { level: options.level }),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = testClient(options.asking);
  await client.connect(clientTransport);
  definitions.set(client, tools);
  return {
    client,
    logLines,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** The revision of the protocol that `connectModern` pins. */
export const MODERN_REVISION = '2026-07-28';

export type ModernConnection = {
  client: Client;
  /** The transport of the client, for a test that sends a message of its own. */
  transport: InMemoryTransport;
  /** What serveStdio gave its `onerror`. */
  errors: Error[];
  close(): Promise<void>;
};

/**
 * Connects a client pinned to revision 2026-07-28 over the in-memory transport to serveStdio with
 * `factory`, as the command serves stdio. The client opens with server/discover and sends the
 * fields of the revision in `_meta` of each request. With `asking`, it can ask the person and
 * fulfills each input_required result of a tool with that answer, as the SDK client does by
 * default. With `autoFulfill` false, it declares the capability but fulfills none.
 */
export async function connectModern(
  factory: McpServerFactory,
  options: { asking?: Asking; autoFulfill?: boolean } = {},
): Promise<ModernConnection> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const errors: Error[] = [];
  const served = serveStdio(factory, {
    transport: serverTransport,
    onerror: (error) => errors.push(error),
  });
  const client = testClient(options.asking, {
    versionNegotiation: { mode: { pin: MODERN_REVISION } },
    ...(options.autoFulfill === undefined ? {} : { inputRequired: { autoFulfill: options.autoFulfill } }),
  });
  await client.connect(clientTransport);
  return {
    client,
    transport: clientTransport,
    errors,
    async close() {
      await client.close();
      await served.close();
    },
  };
}

export type ToolCallResult = {
  isError: boolean;
  /** The first text block: the summary, or the error message. */
  summary: string;
  /** The parsed second text block, or undefined for an error. */
  data: any;
  /** The second text block as sent, or undefined for an error. */
  text: string | undefined;
};

/**
 * The tools that connectTools registered for each client. assertToolOutput checks the results of
 * every other client against TOOLS.
 */
const definitions = new WeakMap<Client, readonly AnyTool[]>();

/** The output schemas that the server of each client advertises, by tool name. */
const advertisedOutputs = new WeakMap<Client, Promise<Map<string, unknown>>>();

/** The JSON Schema 2020-12 validator of the SDK, and its checks by schema text. */
const validator = new AjvJsonSchemaValidator();
const compiled = new Map<string, ReturnType<AjvJsonSchemaValidator['getValidator']>>();

function outputsOf(client: Client): Promise<Map<string, unknown>> {
  let outputs = advertisedOutputs.get(client);
  if (outputs === undefined) {
    outputs = client
      .listTools()
      .then(({ tools }) => new Map(tools.map((tool) => [tool.name, tool.outputSchema])));
    advertisedOutputs.set(client, outputs);
  }
  return outputs;
}

/**
 * Checks the data of a result of `name` against the strict shape of its tool, which refuses each
 * key that it does not name, and against the output schema that the server advertises, with the
 * validator of the SDK. The data that a tool gives with either value of the option Personal data
 * must pass both checks.
 */
export async function assertToolOutput(client: Client, name: string, data: unknown): Promise<void> {
  const tool = (definitions.get(client) ?? TOOLS).find((entry) => entry.name === name);
  assert.ok(tool !== undefined, `${name} has no definition`);
  const strict = tool.output.safeParse(data);
  assert.ok(strict.success, `${name}: the strict shape refuses the data: ${strict.error?.message}`);
  const schema = (await outputsOf(client)).get(name);
  assert.ok(schema !== undefined, `${name} advertises no output schema`);
  const text = JSON.stringify(schema);
  let check = compiled.get(text);
  if (check === undefined) {
    check = validator.getValidator(schema as never);
    compiled.set(text, check);
  }
  const checked = check(data);
  assert.ok(checked.valid, `${name}: the output schema refuses the data: ${checked.errorMessage}`);
}

/**
 * Calls a tool. A normal result must have exactly the summary and the JSON text, the JSON must
 * equal the structured content, and the data must fit the output schema of the tool
 * (assertToolOutput). An error result must have one text block and no data.
 */
export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  options: { signal?: AbortSignal } = {},
): Promise<ToolCallResult> {
  const result = await client.callTool({ name, arguments: args }, { signal: options.signal });
  const content = result.content as { type: string; text: string }[];
  assert.ok(content.every((block) => block.type === 'text'));
  const summary = content[0]!.text;
  if (result.isError === true) {
    assert.equal(content.length, 1);
    assert.equal(result.structuredContent, undefined);
    return { isError: true, summary, data: undefined, text: undefined };
  }
  assert.equal(content.length, 2);
  const text = content[1]!.text;
  const data: unknown = JSON.parse(text);
  assert.deepEqual(data, result.structuredContent);
  await assertToolOutput(client, name, data);
  return { isError: false, summary, data, text };
}

export type ToolHarness = {
  call(name: string, args?: Record<string, unknown>): Promise<ToolCallResult>;
  fake: FakeFetch;
  logLines: string[];
  client: Client;
  /** Closes the connection, then checks that every expected request arrived and no other. */
  done(): Promise<void>;
};

export type HarnessOptions = Partial<Omit<ConnectOptions, 'fetch'>> & {
  anyOrder?: boolean;
  /** Wraps the fake fetch, for example to move a clock on every request. */
  wrapFetch?: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch;
};

/**
 * Connects `tools` with `connectTools` on a fake fetch that expects `expected`. Unless `now` is
 * given, the clock stands at 2026-10-07T08:00Z.
 */
export async function toolHarness(
  tools: readonly AnyTool[],
  expected: readonly ExpectedRequest[],
  options: HarnessOptions = {},
): Promise<ToolHarness> {
  const { anyOrder, wrapFetch, ...connectOptions } = options;
  const fake = fakeFetch(expected, { anyOrder });
  const connected = await connectTools(tools, {
    now: testClock().now,
    ...connectOptions,
    fetch: wrapFetch === undefined ? fake.fetch : wrapFetch(fake.fetch),
  });
  return {
    call: (name, args = {}) => callTool(connected.client, name, args),
    fake,
    logLines: connected.logLines,
    client: connected.client,
    async done() {
      await connected.close();
      fake.assertDone();
    },
  };
}
