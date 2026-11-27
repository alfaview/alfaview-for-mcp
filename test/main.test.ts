// Tests of the command dist/main.js, started as an MCP client starts it. The preload of spawnServer
// sends the server's requests to a test server on 127.0.0.1 and refuses every other host.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { ADMIN_GUEST_GROUP_MESSAGE } from '../src/domain/guestLinks.ts';
import { serverInstructions, SERVER_VERSION, TOOLS, toolsOfLevel } from '../src/server.ts';
import { ADVISOR_ROOM_ID, sampleState, startFakeApi } from './fake-api/server.ts';
import { callTool } from './helpers/mcpClient.ts';
import {
  BREAK_START,
  ROUTE_FETCH,
  serverLaunch,
  spawnServer,
  startRecordingServer,
  TEST_ENV,
  type RecordingServer,
} from './helpers/spawnServer.ts';

const EXIT_MS = 2_000;
const SECRETS = ['secret-key-1', 'company-1', 'mcp-test'];

/**
 * The line after the start line. The SDK client of these tests opens with initialize, so the
 * server serves the 2025 era of the protocol.
 */
const ERA_LINE = 'alfaview-mcp: protocol era 2025\n';

let recording: RecordingServer;

before(async () => {
  recording = await startRecordingServer();
});

after(async () => {
  await recording.close();
});

/** Starts the server with `env`, expects it to exit 1 at once, and returns its stderr. */
async function refusedStart(env: Record<string, string>): Promise<string> {
  const server = spawnServer({ env, fakeApiOrigin: recording.origin });
  assert.equal(await server.exitWithin(EXIT_MS), 1);
  assert.equal(server.stdout(), '');
  return server.stderr();
}

/**
 * Connects an SDK client to the built server over stdio, and returns the client, its errors and
 * the server's stderr. The server sends its requests to `fakeApiOrigin`, by default the recording
 * server.
 */
async function connectOverStdio(env: Record<string, string>, fakeApiOrigin = recording.origin) {
  const transport = new StdioClientTransport({
    ...serverLaunch({ env, fakeApiOrigin }),
    stderr: 'pipe',
  });
  let stderr = '';
  // With stderr 'pipe', the transport gives a readable stream before the start.
  (transport.stderr as Readable).setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const client = new Client({ name: 'test', version: '0.0.0' });
  const errors: Error[] = [];
  client.onerror = (error) => errors.push(error);
  await client.connect(transport);
  return { client, errors, stderr: () => stderr };
}

describe('the command without a usable configuration', () => {
  it('exits 1 without configuration and names the missing variables on stderr', async () => {
    const stderr = await refusedStart({});
    assert.match(
      stderr,
      /^alfaview-mcp: Missing configuration: ALFAVIEW_COMPANY_ID, ALFAVIEW_CLIENT_ID, ALFAVIEW_API_KEY\. /m,
    );
  });

  it('exits 1 for a base URL that is not allowed, and never writes the given values', async () => {
    const stderr = await refusedStart({ ...TEST_ENV, ALFAVIEW_API_BASE_URL: 'https://example.com' });
    assert.match(stderr, /^alfaview-mcp: ALFAVIEW_API_BASE_URL must be empty or https:\/\/apis\.alfaview\.com\.$/m);
    for (const secret of SECRETS) assert.ok(!stderr.includes(secret), secret);
  });

  // The server takes only the production host.
  it('exits 1 for another alfaview host, before any request', async () => {
    const stderr = await refusedStart({ ...TEST_ENV, ALFAVIEW_API_BASE_URL: 'https://app.alfaview.com' });
    assert.match(stderr, /^alfaview-mcp: ALFAVIEW_API_BASE_URL must be empty or https:\/\/apis\.alfaview\.com\.$/m);
    assert.deepEqual(recording.requests, []);
  });

  it('exits 1 for an unknown tool name', async () => {
    const stderr = await refusedStart({ ...TEST_ENV, ALFAVIEW_TOOLS: 'find_rooms,find_room' });
    assert.match(stderr, /^alfaview-mcp: ALFAVIEW_TOOLS names unknown tools: find_room\. /m);
    for (const secret of SECRETS) assert.ok(!stderr.includes(secret), secret);
  });

  it('exits 1 for a time zone that is not valid, and never writes the given value', async () => {
    const stderr = await refusedStart({ ...TEST_ENV, ALFAVIEW_TIME_ZONE: 'Europe/Berlni' });
    assert.match(stderr, /^alfaview-mcp: ALFAVIEW_TIME_ZONE is not a valid time zone\. /m);
    assert.ok(!stderr.includes('Berlni'));
    assert.ok(!stderr.includes('ready for'));
  });

  it('exits 1 for a value of ALFAVIEW_PERSONAL_DATA other than include and omit', async () => {
    const stderr = await refusedStart({ ...TEST_ENV, ALFAVIEW_PERSONAL_DATA: 'leave out' });
    assert.match(
      stderr,
      /^alfaview-mcp: ALFAVIEW_PERSONAL_DATA must be include or omit, or empty for include\.$/m,
    );
    assert.ok(!stderr.includes('leave out'));
    assert.ok(!stderr.includes('ready for'));
  });

  // An unknown level never falls back to another level, also not to `standard`: the server starts
  // at the level of its entry or not at all.
  it('exits 1 for an unknown access level, and never writes the given value', async () => {
    const stderr = await refusedStart({ ...TEST_ENV, ALFAVIEW_ACCESS_LEVEL: 'level-marker' });
    assert.equal(
      stderr,
      'alfaview-mcp: ALFAVIEW_ACCESS_LEVEL must be read, standard, manage or full. Leave it empty for standard.\n',
    );
  });

  it('exits 1 for the level full without the company ID as its confirmation', async () => {
    const missing = await refusedStart({ ...TEST_ENV, ALFAVIEW_ACCESS_LEVEL: 'full' });
    assert.match(missing, /^alfaview-mcp: ALFAVIEW_ACCESS_LEVEL is full, which can delete rooms and users for good /m);
    const other = await refusedStart({
      ...TEST_ENV,
      ALFAVIEW_ACCESS_LEVEL: 'full',
      ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS: 'company-marker',
    });
    assert.equal(
      other,
      'alfaview-mcp: ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS does not match ALFAVIEW_COMPANY_ID. Set it to the company ID of this server entry.\n',
    );
    for (const secret of SECRETS) assert.ok(!missing.includes(secret) && !other.includes(secret), secret);
    assert.deepEqual(recording.requests, []);
  });

  // A shell that exports the confirmation gives it to each entry of the MCP client. A leftover
  // confirmation would unlock `full` later with a change of the level alone.
  it('exits 1 when the confirmation of full is set at another level', async () => {
    const stderr = await refusedStart({ ...TEST_ENV, ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS: 'company-1' });
    assert.equal(
      stderr,
      'alfaview-mcp: ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS is set, but ALFAVIEW_ACCESS_LEVEL is not full. Remove the variable from this server entry and from the shell environment of the MCP client.\n',
    );
  });

  it('exits 1 for a tool above the level and names the level of the tool', async () => {
    const stderr = await refusedStart({
      ...TEST_ENV,
      ALFAVIEW_ACCESS_LEVEL: 'read',
      ALFAVIEW_TOOLS: 'find_rooms,create_guest_links',
    });
    assert.equal(
      stderr,
      'alfaview-mcp: ALFAVIEW_TOOLS names tools above the level read: create_guest_links (standard). Set ALFAVIEW_ACCESS_LEVEL to the level of the tools, or remove their names.\n',
    );
  });

  it('exits 1 when NODE_TLS_REJECT_UNAUTHORIZED is 0', async () => {
    const stderr = await refusedStart({ ...TEST_ENV, NODE_TLS_REJECT_UNAUTHORIZED: '0' });
    assert.match(stderr, /^alfaview-mcp: NODE_TLS_REJECT_UNAUTHORIZED is 0, /m);
    assert.deepEqual(recording.requests, []);
  });
});

describe('the command when its start fails after the configuration check', () => {
  it('exits 1 and logs the error name and its stack frames, never its message', async () => {
    const server = spawnServer({
      env: TEST_ENV,
      fakeApiOrigin: recording.origin,
      preloads: [BREAK_START],
    });
    assert.equal(await server.exitWithin(EXIT_MS), 1);
    assert.equal(server.stdout(), '');

    const [first, ...frames] = server.stderr().split('\n').filter((line) => line !== '');
    assert.equal(first, 'alfaview-mcp: could not start (Error)');
    assert.ok(frames.length > 0);
    for (const frame of frames) assert.match(frame, /^alfaview-mcp: {5}at /);
    // break-start.ts throws with the message marker-of-the-start-error.
    assert.ok(!server.stderr().includes('marker'));
    for (const secret of SECRETS) assert.ok(!server.stderr().includes(secret), secret);
    assert.deepEqual(recording.requests, []);
  });
});

describe('the command with a configuration', () => {
  // The computer's zone is UTC+14 here, and the server still reads and gives times in Berlin.
  it('serves the 17 tools and its instructions over stdio, without a request to alfaview', async () => {
    const { client, errors, stderr } = await connectOverStdio({ ...TEST_ENV, TZ: 'Pacific/Kiritimati' });
    const { tools } = await client.listTools();
    const info = client.getServerVersion();
    const instructions = client.getInstructions();
    await client.close();

    assert.deepEqual(
      tools.map((tool) => tool.name),
      toolsOfLevel('standard').map((tool) => tool.name),
    );
    assert.equal(tools.length, 17);
    assert.deepEqual([info?.name, info?.title, info?.version], ['alfaview', 'alfaview', SERVER_VERSION]);
    assert.equal(instructions, serverInstructions('Europe/Berlin'));
    assert.deepEqual(recording.requests, []);
    assert.deepEqual(errors, []);
    assert.equal(
      stderr(),
      `alfaview-mcp: version ${SERVER_VERSION} ready for https://apis.alfaview.com with 17 tools at level standard, time zone Europe/Berlin, personal data include\n${ERA_LINE}`,
    );
  });

  it('reads times in the zone of ALFAVIEW_TIME_ZONE and names it in the instructions and the log', async () => {
    const { client, stderr } = await connectOverStdio({
      ...TEST_ENV,
      TZ: 'Pacific/Kiritimati',
      ALFAVIEW_TIME_ZONE: 'america/new_york',
    });
    const instructions = client.getInstructions();
    await client.close();

    assert.equal(instructions, serverInstructions('America/New_York'));
    assert.ok(
      stderr().endsWith(` with 17 tools at level standard, time zone America/New_York, personal data include\n${ERA_LINE}`),
      stderr(),
    );
  });

  it('serves only the tools that ALFAVIEW_TOOLS names', async () => {
    const { client, stderr } = await connectOverStdio({ ...TEST_ENV, ALFAVIEW_TOOLS: ' find_rooms ' });
    const { tools } = await client.listTools();
    await client.close();

    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['find_rooms'],
    );
    assert.ok(
      stderr().endsWith(` with 1 tool at level standard, time zone Europe/Berlin, personal data include\n${ERA_LINE}`),
      stderr(),
    );
  });

  // The level `read` gives an unattended report run a server without writes.
  it('serves the tools of the level read, and names the level in the log', async () => {
    const { client, stderr } = await connectOverStdio({ ...TEST_ENV, ALFAVIEW_ACCESS_LEVEL: ' read ' });
    const { tools } = await client.listTools();
    const instructions = client.getInstructions();
    await client.close();

    const read = TOOLS.filter((tool) => tool.level === 'read').map((tool) => tool.name);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      read,
    );
    assert.equal(read.length, 9);
    assert.equal(instructions, serverInstructions('Europe/Berlin', read));
    assert.equal(
      stderr(),
      `alfaview-mcp: version ${SERVER_VERSION} ready for https://apis.alfaview.com with 9 tools at level read, time zone Europe/Berlin, personal data include\n${ERA_LINE}`,
    );
  });

  // The second line of the log warns of the tools of `full`. The level `full` still refuses a guest
  // link whose permission group has admin rights.
  it('starts at the level full with the company ID in any case as the confirmation', async () => {
    const api = await startFakeApi(sampleState(Math.floor(Date.now() / 60_000) * 60_000));
    const { client, stderr } = await connectOverStdio(
      { ...TEST_ENV, ALFAVIEW_ACCESS_LEVEL: 'full', ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS: ' COMPANY-1 ' },
      api.origin,
    );
    const { tools } = await client.listTools();
    const refused = await callTool(client, 'create_guest_links', {
      roomId: ADVISOR_ROOM_ID,
      guests: [{ emailAddress: 'admin.guest@example.com', displayName: 'Admin Guest' }],
      locale: 'en-US',
      permissionGroup: 'Admin',
    });
    await client.close();
    await api.close();

    assert.deepEqual(
      tools.map((tool) => tool.name),
      TOOLS.map((tool) => tool.name),
    );
    assert.deepEqual(stderr().split('\n').slice(0, 2), [
      `alfaview-mcp: version ${SERVER_VERSION} ready for https://apis.alfaview.com with ${TOOLS.length} tools at level full, time zone Europe/Berlin, personal data include`,
      'alfaview-mcp: level full: DANGEROUS tools are registered. They can delete rooms and users for good and change who has access to rooms.',
    ]);
    assert.ok(tools.some((tool) => tool.name === 'delete_room'));
    assert.equal(refused.isError, true);
    assert.equal(refused.summary, ADMIN_GUEST_GROUP_MESSAGE);
    assert.deepEqual(recording.requests, []);
  });

  it('serves the same instructions and tools with ALFAVIEW_PERSONAL_DATA=include as without it', async () => {
    const without = await connectOverStdio(TEST_ENV);
    const withInclude = await connectOverStdio({ ...TEST_ENV, ALFAVIEW_PERSONAL_DATA: ' include ' });
    const lists = [await without.client.listTools(), await withInclude.client.listTools()];
    const instructions = [without.client.getInstructions(), withInclude.client.getInstructions()];
    await without.client.close();
    await withInclude.client.close();

    assert.equal(JSON.stringify(lists[1]), JSON.stringify(lists[0]));
    assert.equal(instructions[1], instructions[0]);
    assert.equal(instructions[0], serverInstructions('Europe/Berlin'));
    assert.ok(withInclude.stderr().endsWith(`, personal data include\n${ERA_LINE}`), withInclude.stderr());
  });

  it('names the option in the instructions and the log with ALFAVIEW_PERSONAL_DATA=omit', async () => {
    const { client, stderr } = await connectOverStdio({ ...TEST_ENV, ALFAVIEW_PERSONAL_DATA: 'omit' });
    const instructions = client.getInstructions();
    const { tools } = await client.listTools();
    await client.close();

    assert.equal(instructions, serverInstructions('Europe/Berlin', undefined, 'omit'));
    const attendance = tools.find((tool) => tool.name === 'get_room_attendance');
    assert.match(attendance?.description ?? '', / the email lists of attendees and no-shows are null/);
    const status = (attendance?.inputSchema.properties as Record<string, { description?: string }>)
      .status;
    assert.match(status?.description ?? '', / the email lists of attendees and no-shows are null\. /);
    assert.ok(
      stderr().endsWith(` with 17 tools at level standard, time zone Europe/Berlin, personal data omit\n${ERA_LINE}`),
      stderr(),
    );
    assert.deepEqual(recording.requests, []);
  });

  // A line that serveStdio cannot read as a message gives a protocol error in the log, with the
  // error name and the stack frames, never the message, which can quote the input. SDK 2.4.0 drops
  // a line that is not JSON without a report, so the second line gives the error.
  it('logs a line on stdin that is not an MCP message by its error name and stack frames only', async () => {
    const server = spawnServer({ env: TEST_ENV, fakeApiOrigin: recording.origin });
    await server.stderrWithin(' ready for ', EXIT_MS);
    server.child.stdin.write('not json marker-of-the-text\n');
    server.child.stdin.write('{"jsonrpc":"2.0","marker-of-the-key":"marker-of-the-value"}\n');
    await server.stderrWithin('protocol error', EXIT_MS);
    server.child.stdin.end();

    assert.equal(await server.exitWithin(EXIT_MS), 0);
    assert.equal(server.stdout(), '');
    const [start, error, ...frames] = server.stderr().split('\n').filter((line) => line !== '');
    assert.match(start ?? '', /^alfaview-mcp: version .* ready for /);
    assert.equal(error, 'alfaview-mcp: protocol error (ZodError)');
    assert.ok(frames.length > 0);
    for (const frame of frames) assert.match(frame, /^alfaview-mcp: {5}at /);
    assert.ok(!server.stderr().includes('marker'));
    assert.deepEqual(recording.requests, []);
  });

  // The MCP specification allows only MCP messages on the stdout of a stdio server. The SDK client
  // skips a line of stdout that is not JSON, so only the raw stdout shows that the server writes
  // nothing else.
  it('writes only whole MCP messages to stdout in a flow with tool calls, one on each line', async () => {
    const api = await startFakeApi(sampleState(Math.floor(Date.now() / 60_000) * 60_000));
    const server = spawnServer({ env: TEST_ENV, fakeApiOrigin: api.origin });
    try {
      await server.stderrWithin(' ready for ', EXIT_MS);
      const send = (message: object) => server.child.stdin.write(`${JSON.stringify(message)}\n`);
      const call = (id: number, name: string, args: object) =>
        send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
      });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      call(3, 'find_rooms', {});
      call(4, 'get_room', { roomId: '00000000-0000-5000-8000-200000000001' });
      call(5, 'no_such_tool', {});
      await server.stderrWithin('tool get_room: ', EXIT_MS);
      const deadline = Date.now() + EXIT_MS;
      while (server.stdout().split('\n').length <= 5 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      server.child.stdin.end();
      assert.equal(await server.exitWithin(EXIT_MS), 0);
    } finally {
      server.child.kill();
      await api.close();
    }

    const stdout = server.stdout();
    assert.ok(stdout.endsWith('\n'), 'nothing after the last line break');
    const messages = stdout
      .slice(0, -1)
      .split('\n')
      .map((line) => JSON.parse(line) as { jsonrpc?: string; id?: number; result?: { isError?: boolean }; error?: unknown });
    assert.deepEqual(
      messages.map((message) => [message.jsonrpc, message.id]).sort((left, right) => Number(left[1]) - Number(right[1])),
      [1, 2, 3, 4, 5].map((id) => ['2.0', id]),
    );
    const byId = new Map(messages.map((message) => [message.id, message]));
    assert.ok(byId.get(3)!.result !== undefined && byId.get(3)!.result!.isError !== true);
    assert.equal(byId.get(4)!.result!.isError, true);
    assert.ok(byId.get(5)!.error !== undefined);
  });

  it('ends with code 0 within 2 seconds when stdin closes', async () => {
    const server = spawnServer({ env: TEST_ENV, fakeApiOrigin: recording.origin });
    await server.stderrWithin(' ready for ', EXIT_MS);
    server.child.stdin.end();

    assert.equal(await server.exitWithin(EXIT_MS), 0);
    assert.equal(server.stdout(), '');
  });

  it('logs in at the first tool call, through the preload to the fake API', async () => {
    recording.requests.length = 0;
    const { client, stderr } = await connectOverStdio(TEST_ENV);
    assert.deepEqual(recording.requests, []);
    const result = await client.callTool({ name: 'find_rooms', arguments: {} });
    await client.close();

    assert.equal(result.isError, true);
    assert.deepEqual(result.content, [
      { type: 'text', text: 'alfaview had a temporary problem (HTTP 500). Try again later.' },
    ]);
    assert.deepEqual(recording.requests, ['POST /v2/auth/api-key']);
    assert.match(stderr(), /\nalfaview-mcp: tool find_rooms: ServerError, 1 request, \d+ ms\n$/);
    for (const secret of SECRETS) assert.ok(!stderr().includes(secret), secret);
    recording.requests.length = 0;
  });

  it('runs a tool call without arguments, which the Python SDK sends for no parameters', async () => {
    recording.requests.length = 0;
    const { client } = await connectOverStdio(TEST_ENV);
    const result = await client.callTool({ name: 'find_rooms' });
    await client.close();

    // The tool ran and logged in: the SDK did not refuse the missing arguments.
    assert.deepEqual(result.content, [
      { type: 'text', text: 'alfaview had a temporary problem (HTTP 500). Try again later.' },
    ]);
    assert.deepEqual(recording.requests, ['POST /v2/auth/api-key']);
    recording.requests.length = 0;
  });
});

describe('the fetch preload', () => {
  it('refuses every host other than the production API', async () => {
    const probe = spawn(
      process.execPath,
      [
        '--import',
        ROUTE_FETCH,
        '--eval',
        "fetch('https://apis.example.com/v2/auth/api-key').then(() => process.exit(0), (error) => { process.stderr.write(String(error)); process.exit(3); })",
      ],
      { env: { ALFAVIEW_FAKE_API_ORIGIN: recording.origin } },
    );
    let stderr = '';
    probe.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const code = await new Promise((resolve) => probe.on('exit', resolve));

    assert.equal(code, 3);
    assert.match(stderr, /route-fetch refused https:\/\/apis\.example\.com\/v2\/auth\/api-key/);
    assert.deepEqual(recording.requests, []);
  });

  it('stops the process when the fake API is not an origin on 127.0.0.1', async () => {
    const remote = spawnServer({ env: TEST_ENV, fakeApiOrigin: 'https://apis.alfaview.com' });
    assert.equal(await remote.exitWithin(EXIT_MS), 1);
    assert.match(remote.stderr(), /route-fetch: ALFAVIEW_FAKE_API_ORIGIN must be the origin/);
    assert.ok(!remote.stderr().includes('ready for'));

    // Without the variable, and without the server: only the preload runs.
    const bare = spawn(process.execPath, ['--import', ROUTE_FETCH, '--eval', ''], { env: {} });
    let stderr = '';
    bare.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const code = await new Promise((resolve) => bare.on('exit', resolve));
    assert.equal(code, 1);
    assert.match(stderr, /route-fetch: ALFAVIEW_FAKE_API_ORIGIN must be the origin/);
  });
});
