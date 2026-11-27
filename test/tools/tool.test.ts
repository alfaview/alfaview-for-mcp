// The wrapper that runs every tool call, the shared parameters and the result helpers.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as z from 'zod';
import { ToolError } from '../../src/alfaview/errors.ts';
import { createLogger } from '../../src/log.ts';
import { PERSONAL_KEYS } from '../../src/shared/personalData.ts';
import {
  toolOutput,
  unexpectedResponseMessage,
  unformedResultMessage,
} from '../../src/tools/outputs.ts';
import {
  advertised,
  CHANGE_ANNOTATIONS,
  count,
  CREATE_ANNOTATIONS,
  dateTimeParameter,
  defineTool,
  groupLinkIdParameter,
  guestLinkIdParameter,
  IDEMPOTENT_CHANGE_ANNOTATIONS,
  idParameter,
  idProblem,
  INTERNAL_ERROR_MESSAGE,
  LEFT_OUT_KINDS,
  leftOutWarning,
  limitParameter,
  listed,
  listPart,
  meetingIdParameter,
  offsetParameter,
  otherIdKind,
  READ_ANNOTATIONS,
  ROOM_ID_RULE,
  roomIdNotMeetingWith,
  roomIdParameter,
  runTool,
  showing,
  subroomIdParameter,
  textParameter,
  TIME_ZONE_SLOT,
  timezoneParameter,
  TOOL_CALLS_PER_MINUTE,
  TOOL_CALLS_RATE_LIMITED_MESSAGE,
  toolInputSchema,
  userIdParameter,
  userIdWith,
  UUID_PATTERN,
  withoutPersonalData,
  type ToolContext,
  type ToolData,
  type ToolPersonalData,
  type ToolResultShape,
} from '../../src/tools/tool.ts';
import { testClock } from '../helpers/clock.ts';
import { flush, loginRequest, testApi, untilRequests } from '../helpers/fakeFetch.ts';
import { callTool, toolHarness } from '../helpers/mcpClient.ts';

const MARKER = 'marker-7f3c91';
const ROOM_ID = '0b7c5d2e-91a4-5f3b-8e27-0f4a6c9d1e22';
/** Version 5 IDs with the kind in byte 10: a user (hex 12), a guest link (14) and a guest (18). */
const USER_ID = 'c4a1e2b3-5d6f-5a7b-8c9d-12e3f4a5b6c7';
const GUEST_LINK_ID = '3f2a9c1e-7b4d-5e21-a3c4-14b7e9d0f6a2';
const GUEST_ID = '3f2a9c1e-7b4d-5e21-a3c4-18b7e9d0f6a2';
/** A meeting room (kind hex 22), which roomId takes, and a version 4 UUID of an older room. */
const MEETING_ROOM_ID = '7e9a1c3d-5b2f-5a4e-8c6d-22f0a1b2c3d4';
const V4_ID = '7e9a1c3d-5b2f-4a4e-8c6d-12f0a1b2c3d4';

/** The warning of Leave out that names `kinds`. */
function leftOutText(kinds: string): string {
  return `This server leaves out personal data (option Personal data, Leave out): ${kinds} are null, also where alfaview has a value.`;
}

const GUEST_LINK_LEFT_OUT = leftOutText('names, email addresses and origins');

let lastContext: ToolContext | undefined;

/** A tool for the wrapper tests. Its input says what `run` does. */
const probeTool = defineTool({
  name: 'probe_tool',
  level: 'read',
  title: 'Probe',
  description: 'A tool of the alfaview tests.',
  inputSchema: z.strictObject({
    marker: z.string().default('none'),
    warnings: z.array(z.string()).default([]),
    fail: z.enum(['no', 'tool', 'forbidden', 'internal', 'text']).default('no'),
    requests: z.number().int().default(0),
    roomId: roomIdParameter.optional(),
    name: textParameter('A name.', 10).optional(),
    from: dateTimeParameter('The start.', 'server').optional(),
    offset: offsetParameter(),
  }),
  annotations: READ_ANNOTATIONS,
  forbiddenHint: 'Probing needs the user permission Probe Admin.',
  personalData: { shape: 'mcp.guestLink' },
  output: toolOutput({ value: z.int(), marker: z.string(), name: z.string().nullable() }),
  async run(input, context) {
    lastContext = context;
    for (let index = 0; index < input.requests; index += 1) {
      await context.api.request({ method: 'GET', path: '/v2/permission-groups' });
    }
    if (input.fail === 'tool') throw new ToolError('NotFound', 'alfaview could not find it.', 404);
    if (input.fail === 'forbidden') {
      throw new ToolError('Forbidden', "The API key's user is not allowed to do this (Forbidden).", 403);
    }
    if (input.fail === 'internal') throw new TypeError(`broken by ${input.marker}`);
    if (input.fail === 'text') throw `thrown with ${input.marker}`;
    return {
      summary: 'Did it.',
      warnings: input.warnings.length > 0 ? input.warnings : undefined,
      // A key `warnings` in the data gives way to the warnings of the wrapper.
      data: {
        ...({ warnings: 'from run' } as object),
        value: 1,
        marker: input.marker,
        name: input.name ?? null,
      },
    };
  },
});

/** A second tool, for the limit that the tools of one server share. */
const otherProbeTool = defineTool({
  name: 'other_probe_tool',
  level: 'read',
  title: 'Other probe',
  description: 'Another tool of the alfaview tests.',
  inputSchema: z.strictObject({}),
  annotations: READ_ANNOTATIONS,
  personalData: { shape: 'mcp.guestLink' },
  output: toolOutput({}),
  async run() {
    return { summary: 'Did the other.', data: {} };
  },
});

/**
 * A tool that sends one request and returns the `id` of alfaview's answer as it is, against an
 * output schema that takes a text ID only.
 */
function answerTool(
  name: string,
  annotations: typeof READ_ANNOTATIONS,
  readTool: string | undefined,
) {
  return defineTool({
    name,
    level: 'standard',
    title: 'Probe an answer',
    description: 'A tool of the alfaview tests that returns an answer.',
    inputSchema: z.strictObject({}),
    annotations,
    personalData: { shape: 'mcp.room' },
    output: toolOutput({ rooms: z.array(z.strictObject({ id: z.string() })) }),
    ...(readTool === undefined ? {} : { readTool }),
    async run(_input, { api }) {
      const { data } = await api.request<{ id: string }>(
        annotations.readOnlyHint === true
          ? { method: 'GET', path: '/v2/rooms' }
          : {
              method: 'POST',
              path: '/v2/rooms',
              body: { displayName: 'Probe', type: 'room', waitingRoomEnabled: false },
            },
      );
      return { summary: 'Did it.', data: { rooms: [{ id: data!.id }] } };
    },
  });
}

const groupsRequest = { method: 'GET', path: '/v2/permission-groups', respond: { status: 200, body: [] } };

describe('the wrapper', () => {
  it('returns the summary, the JSON text and the same data as structured content', async () => {
    const harness = await toolHarness([probeTool], []);
    const result = await harness.call('probe_tool', { marker: 'a' });
    await harness.done();

    assert.equal(result.isError, false);
    assert.equal(result.summary, 'Did it.');
    assert.deepEqual(result.data, { value: 1, marker: 'a', name: null, warnings: [] });
    assert.equal(result.text, '{"value":1,"marker":"a","name":null,"warnings":[]}');
  });

  it('puts the warnings last in the data and after the summary', async () => {
    const harness = await toolHarness([probeTool], []);
    const result = await harness.call('probe_tool', { warnings: ['First.', 'Second.'] });
    await harness.done();

    assert.equal(result.summary, 'Did it. First. Second.');
    assert.deepEqual(Object.keys(result.data), ['value', 'marker', 'name', 'warnings']);
    assert.deepEqual(result.data.warnings, ['First.', 'Second.']);
  });

  it('turns a ToolError into an error result with its message and logs its code', async () => {
    const harness = await toolHarness([probeTool], []);
    const result = await harness.call('probe_tool', { fail: 'tool' });
    await harness.done();

    assert.deepEqual(result, {
      isError: true,
      summary: 'alfaview could not find it.',
      data: undefined,
      text: undefined,
    });
    assert.deepEqual(harness.logLines, ['alfaview-mcp: tool probe_tool: NotFound, 0 requests, 0 ms\n']);
  });

  // The permission of a tool comes with its 403, not in its description.
  it('adds the forbiddenHint of the tool to the text of a 403, and to no other error', async () => {
    const harness = await toolHarness([probeTool, otherProbeTool], []);
    const forbidden = await harness.call('probe_tool', { fail: 'forbidden' });
    await harness.done();

    assert.equal(forbidden.isError, true);
    assert.equal(
      forbidden.summary,
      "The API key's user is not allowed to do this (Forbidden). Probing needs the user permission Probe Admin.",
    );
    assert.deepEqual(harness.logLines, ['alfaview-mcp: tool probe_tool: Forbidden, 0 requests, 0 ms\n']);
  });

  it('gives the internal message for any other error, and logs its name and frames only', async () => {
    const harness = await toolHarness([probeTool], []);
    const result = await harness.call('probe_tool', { fail: 'internal', marker: MARKER });
    await harness.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, INTERNAL_ERROR_MESSAGE);
    assert.equal(
      harness.logLines[0],
      'alfaview-mcp: tool probe_tool: internal error, 0 requests, 0 ms (TypeError)\n',
    );
    assert.ok(harness.logLines.length > 1);
    assert.ok(harness.logLines.slice(1).every((line) => line.startsWith('alfaview-mcp:     at ')));
    assert.ok(!harness.logLines.join('').includes(MARKER));
  });

  it('logs only the type of a thrown value that is not an Error', async () => {
    const harness = await toolHarness([probeTool], []);
    const result = await harness.call('probe_tool', { fail: 'text', marker: MARKER });
    await harness.done();

    assert.equal(result.summary, INTERNAL_ERROR_MESSAGE);
    assert.deepEqual(harness.logLines, [
      'alfaview-mcp: tool probe_tool: internal error, 0 requests, 0 ms (string)\n',
    ]);
  });

  it('logs one line per call with the outcome, the requests and the time, never the arguments', async () => {
    const clock = testClock();
    const harness = await toolHarness(
      [probeTool],
      [loginRequest(), groupsRequest, groupsRequest, groupsRequest],
      {
        now: clock.now,
        wrapFetch: (fetch) => (input, init) => {
          clock.advance(120);
          return fetch(input, init);
        },
      },
    );
    await harness.call('probe_tool', { requests: 2, marker: MARKER });
    await harness.call('probe_tool', { requests: 1, marker: MARKER });
    await harness.done();

    assert.deepEqual(harness.logLines, [
      'alfaview-mcp: logged in\n',
      'alfaview-mcp: tool probe_tool: ok, 3 requests, 360 ms\n',
      'alfaview-mcp: tool probe_tool: ok, 1 request, 120 ms\n',
    ]);
  });

  it('gives run the clock at the start, the server time zone, the API, the signal and the log', async () => {
    const clock = testClock('2026-12-01T10:00:00Z');
    const harness = await toolHarness([probeTool], [], { now: clock.now, timeZone: 'UTC' });
    await harness.call('probe_tool', {});
    assert.ok(lastContext !== undefined);
    lastContext.log.info('a line of the tool');
    await harness.done();

    assert.equal(lastContext.now, Date.parse('2026-12-01T10:00:00Z'));
    assert.equal(lastContext.timeZone, 'UTC');
    assert.equal(lastContext.api.requestCount, 0);
    assert.ok(lastContext.signal instanceof AbortSignal);
    assert.equal(harness.logLines.at(-1), 'alfaview-mcp: a line of the tool\n');
  });

  it('reads the time of the computer when the server gives no clock', async () => {
    const { client, fake, logLines } = testApi([]);
    const log = createLogger((text) => logLines.push(text));
    const before = Date.now();
    const input = { marker: 'none', warnings: [], fail: 'no', requests: 0 };
    await runTool(probeTool, input, new AbortController().signal, { client, log, timeZone: 'UTC' });
    fake.assertDone();

    assert.ok(lastContext !== undefined);
    assert.ok(lastContext.now >= before && lastContext.now <= Date.now());
    assert.equal(lastContext.level, 'standard');
  });

  // A tool reads the level for a rule that depends on it.
  it('gives the tool the access level of the server, standard without one', async () => {
    for (const level of [undefined, 'read', 'standard', 'manage', 'full'] as const) {
      const harness = await toolHarness([probeTool], [], level === undefined ? {} : { level });
      await harness.call('probe_tool', {});
      await harness.done();
      assert.equal(lastContext?.level, level ?? 'standard');
    }
  });

  // The removal of the personal values runs at the edge, after `run`.
  describe('with the option Personal data', () => {
    const peopleTool = defineTool({
      name: 'probe_people',
      level: 'read',
      title: 'Probe people',
      description: 'A tool of the alfaview tests with people.',
      descriptionWithoutPersonalData: 'A tool of the alfaview tests without people.',
      inputSchema: z.strictObject({ list: z.string().default('links').describe('The list with people.') }),
      inputSchemaWithoutPersonalData: z.strictObject({
        list: z.string().default('links').describe('The list without people.'),
      }),
      annotations: READ_ANNOTATIONS,
      personalData: { shape: 'mcp.guestLink', list: 'links' },
      output: toolOutput({
        roomId: z.string(),
        links: z.array(
          z.strictObject({
            id: z.string(),
            emailAddress: z.string().nullable(),
            displayName: z.string().nullable(),
            origin: z.string().nullable(),
          }),
        ),
      }),
      async run(input, context) {
        lastContext = context;
        const link = { id: 'link-1', emailAddress: `jane.${MARKER}@example.com`, displayName: MARKER, origin: MARKER };
        // A list that is no list fails the removal of the personal values.
        const links = (input.list === 'links' ? [link] : 'not a list') as (typeof link)[];
        return { summary: 'Found 1 guest link.', data: { roomId: 'room-1', links } };
      },
    });

    it('removes the personal values of the shape from the JSON text and the structured content', async () => {
      const results = [];
      for (const personalData of [undefined, 'include', 'omit'] as const) {
        const harness = await toolHarness([peopleTool], [], personalData === undefined ? {} : { personalData });
        results.push(await harness.call('probe_people', {}));
        assert.equal(lastContext?.personalData, personalData ?? 'include');
        await harness.done();
      }
      const [missing, include, omit] = results;

      assert.deepEqual(include, missing);
      assert.deepEqual(include!.data.links, [
        { id: 'link-1', emailAddress: `jane.${MARKER}@example.com`, displayName: MARKER, origin: MARKER },
      ]);
      assert.equal(
        omit!.text,
        `{"roomId":"room-1","links":[{"id":"link-1","emailAddress":null,"displayName":null,"origin":null}],"warnings":["${GUEST_LINK_LEFT_OUT}"]}`,
      );
      assert.equal(omit!.summary, `${include!.summary} ${GUEST_LINK_LEFT_OUT}`);
    });

    it('fails a tool whose list is no list of its data, in both modes', async () => {
      for (const personalData of ['include', 'omit'] as const) {
        const harness = await toolHarness([peopleTool], [], { personalData });
        const result = await harness.call('probe_people', { list: 'none' });
        await harness.done();

        assert.equal(result.summary, INTERNAL_ERROR_MESSAGE);
        assert.equal(
          harness.logLines[0],
          'alfaview-mcp: tool probe_people: internal error, 0 requests, 0 ms (TypeError)\n',
        );
      }
    });

    it('advertises the description of the option', async () => {
      for (const [personalData, description] of [
        ['include', 'A tool of the alfaview tests with people.'],
        ['omit', 'A tool of the alfaview tests without people.'],
      ] as const) {
        const harness = await toolHarness([peopleTool, probeTool], [], { personalData });
        const { tools } = await harness.client.listTools();
        await harness.done();

        assert.deepEqual(
          tools.map((tool) => tool.description),
          [description, 'A tool of the alfaview tests.'],
        );
      }
    });

    // Each mode has its own schema, which differs only in its texts. A tool without a schema for
    // Leave out has the same schema in both modes.
    it('advertises the input schema of the option, and reads the same input with it', async () => {
      const listTexts: unknown[] = [];
      const probeSchemas: string[] = [];
      for (const personalData of [undefined, 'include', 'omit'] as const) {
        const harness = await toolHarness(
          [peopleTool, probeTool],
          [],
          personalData === undefined ? {} : { personalData },
        );
        const { tools } = await harness.client.listTools();
        const result = await harness.call('probe_people', {});
        const wrong = await harness.call('probe_people', { list: 1 });
        await harness.done();

        const [people, probe] = tools.map((tool) => tool.inputSchema);
        listTexts.push((people!.properties as Record<string, { description?: string }>).list!.description);
        probeSchemas.push(JSON.stringify(probe));
        assert.match(result.summary, /^Found 1 guest link\./, personalData);
        assert.equal(wrong.isError, true, personalData);
        assert.match(wrong.summary, /expected string, received number/, personalData);
      }
      assert.deepEqual(listTexts, [
        'The list with people.',
        'The list with people.',
        'The list without people.',
      ]);
      assert.equal(new Set(probeSchemas).size, 1);
    });

    it('gives the schema of the option only with Leave out, and the same schema without one', () => {
      assert.equal(toolInputSchema(peopleTool, 'include'), peopleTool.inputSchema);
      assert.equal(toolInputSchema(peopleTool, 'omit'), peopleTool.inputSchemaWithoutPersonalData);
      assert.equal(toolInputSchema(probeTool, 'include'), probeTool.inputSchema);
      assert.equal(toolInputSchema(probeTool, 'omit'), probeTool.inputSchema);
    });

    // A result whose personal values Leave out set to null says so, so the model does not read a
    // null as a value that alfaview does not have.
    describe('the warning of Leave out', () => {
      const guestsTool = defineTool({
        name: 'probe_guests',
        level: 'read',
        title: 'Probe guests',
        description: 'A tool of the alfaview tests with guests.',
        inputSchema: z.strictObject({
          guests: z.enum(['marked', 'unnamed', 'none']).default('marked'),
          warnings: z.array(z.string()).default([]),
        }),
        annotations: READ_ANNOTATIONS,
        personalData: { shape: 'mcp.guestLink', list: 'links' },
        output: toolOutput({
          links: z.array(
            z.strictObject({
              id: z.string(),
              emailAddress: z.string().nullable(),
              displayName: z.string().nullable(),
              origin: z.string().nullable(),
            }),
          ),
        }),
        async run(input) {
          const unnamed = { id: 'link-1', emailAddress: null, displayName: null, origin: null };
          const marked = {
            id: 'link-2',
            emailAddress: `jane.${MARKER}@example.com`,
            displayName: MARKER,
            origin: MARKER,
          };
          const links = { marked: [unnamed, marked], unnamed: [unnamed], none: [] }[input.guests];
          return {
            summary: `Found ${count(links.length, 'guest link')}.`,
            warnings: input.warnings.length > 0 ? input.warnings : undefined,
            data: { links },
          };
        },
      });

      async function called(personalData: 'include' | 'omit' | undefined, args: Record<string, unknown>) {
        const harness = await toolHarness([guestsTool], [], personalData === undefined ? {} : { personalData });
        const result = await harness.call('probe_guests', args);
        await harness.done();
        return result;
      }

      it('comes once with Leave out, after the warnings of the tool, in the data and the summary', async () => {
        const result = await called('omit', { warnings: ['First.', 'Second.'] });

        assert.deepEqual(result.data.warnings, ['First.', 'Second.', GUEST_LINK_LEFT_OUT]);
        assert.deepEqual(Object.keys(result.data), ['links', 'warnings']);
        assert.equal(result.summary, `Found 2 guest links. First. Second. ${GUEST_LINK_LEFT_OUT}`);
        assert.ok(!result.summary.includes(MARKER));
        assert.ok(!JSON.stringify(result.data).includes(MARKER));
      });

      it('does not come for a result whose personal values were null already, or without any', async () => {
        for (const guests of ['unnamed', 'none']) {
          const plain = await called('omit', { guests });
          const warned = await called('omit', { guests, warnings: ['First.'] });

          assert.deepEqual(plain.data.warnings, [], guests);
          assert.deepEqual(warned.data.warnings, ['First.'], guests);
          assert.match(warned.summary, / First\.$/, guests);
        }
      });

      it('never comes with Include, also without the option', async () => {
        for (const personalData of [undefined, 'include'] as const) {
          const plain = await called(personalData, {});
          const warned = await called(personalData, { warnings: ['First.'] });

          assert.deepEqual(plain.data.warnings, [], personalData);
          assert.deepEqual(warned.data.warnings, ['First.'], personalData);
          assert.equal(warned.summary, 'Found 2 guest links. First.', personalData);
        }
      });
    });
  });

  it('passes the signal of the call to fetch, so a cancel stops the request', async () => {
    const harness = await toolHarness(
      [probeTool],
      [loginRequest(), { method: 'GET', path: '/v2/permission-groups', respond: { hang: true } }],
    );
    const controller = new AbortController();
    const call = callTool(harness.client, 'probe_tool', { requests: 1 }, { signal: controller.signal });
    await untilRequests(harness.fake, 2);
    controller.abort();
    await assert.rejects(call);
    for (let round = 0; round < 100 && harness.logLines.length < 2; round += 1) await flush();
    await harness.done();

    assert.equal(harness.fake.requests[1]!.signal!.aborted, true);
    assert.equal(harness.logLines[1], 'alfaview-mcp: tool probe_tool: Canceled, 2 requests, 0 ms\n');
  });

  it('advertises the title, the description, the annotations and a strict schema', async () => {
    const harness = await toolHarness([probeTool], []);
    const { tools } = await harness.client.listTools();
    await harness.done();

    assert.equal(tools.length, 1);
    const [tool] = tools;
    assert.equal(tool!.name, 'probe_tool');
    assert.equal(tool!.title, 'Probe');
    assert.equal(tool!.description, 'A tool of the alfaview tests.');
    assert.deepEqual(tool!.annotations, READ_ANNOTATIONS);
    assert.equal(tool!.inputSchema.additionalProperties, false);
  });

  it('lets the SDK refuse arguments before run, without a request', async () => {
    const harness = await toolHarness([probeTool], []);
    const unknown = await harness.call('probe_tool', { nmae: 'x' });
    const spaces = await harness.call('probe_tool', { name: '   ' });
    const trimmed = await harness.call('probe_tool', { name: '  Anna  ' });
    await harness.done();

    assert.equal(unknown.isError, true);
    assert.match(unknown.summary, /^Input validation error: Invalid arguments for tool probe_tool: /);
    assert.match(unknown.summary, /Unrecognized key: "nmae"/);
    assert.equal(spaces.isError, true);
    assert.match(spaces.summary, /Too small/);
    assert.equal(trimmed.data.name, 'Anna');
    assert.equal(harness.fake.requests.length, 0);
    // A refused input never reaches the wrapper, so it writes no line.
    assert.deepEqual(harness.logLines, ['alfaview-mcp: tool probe_tool: ok, 0 requests, 0 ms\n']);
  });

  describe('the output schema', () => {
    const roomsAnswer = (method: string, id: unknown) => ({
      method,
      path: '/v2/rooms',
      ...(method === 'POST'
        ? { body: { displayName: 'Probe', type: 'room', waitingRoomEnabled: false } }
        : {}),
      respond: { status: 200, body: { id } },
    });

    it('advertises the open form of the output, without descriptions and $schema', async () => {
      const harness = await toolHarness([probeTool], []);
      const { tools } = await harness.client.listTools();
      await harness.done();

      assert.deepEqual(tools[0]!.outputSchema, {
        type: 'object',
        properties: {
          value: { type: 'integer' },
          marker: { type: 'string' },
          name: { type: ['string', 'null'] },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['value', 'marker', 'name', 'warnings'],
      });
    });

    it('gives a result that fits as it is', async () => {
      const tool = answerTool('probe_write', CREATE_ANNOTATIONS, 'find_rooms');
      const harness = await toolHarness([tool], [loginRequest(), roomsAnswer('POST', 'room-1')]);
      const result = await harness.call('probe_write', {});
      await harness.done();

      assert.deepEqual(result.data, { rooms: [{ id: 'room-1' }], warnings: [] });
    });

    // A write that the SDK refused after the handler would read as failed, and the model could
    // repeat it, such as a create.
    it('says that a write is done when its data does not fit, after one write, and logs the path', async () => {
      const tool = answerTool('probe_write', CREATE_ANNOTATIONS, 'find_rooms');
      const harness = await toolHarness([tool], [loginRequest(), roomsAnswer('POST', 42)]);
      const result = await harness.call('probe_write', {});
      await harness.done();

      assert.deepEqual(result, {
        isError: true,
        summary:
          'alfaview did the change, but the server could not form its result. Do not call probe_write again for it. Read the result with find_rooms.',
        data: undefined,
        text: undefined,
      });
      assert.equal(result.summary, unformedResultMessage('probe_write', 'find_rooms'));
      const writes = harness.fake.requests.filter(
        (request) => request.method === 'POST' && new URL(request.url).pathname === '/v2/rooms',
      );
      assert.equal(writes.length, 1);
      assert.deepEqual(harness.logLines.slice(1), [
        'alfaview-mcp: tool probe_write: OutputShape (rooms[].id), 2 requests, 0 ms\n',
      ]);
    });

    it('names no read tool for a write that has none', async () => {
      const tool = answerTool('probe_write', IDEMPOTENT_CHANGE_ANNOTATIONS, undefined);
      const harness = await toolHarness([tool], [loginRequest(), roomsAnswer('POST', null)]);
      const result = await harness.call('probe_write', {});
      await harness.done();

      assert.equal(
        result.summary,
        'alfaview did the change, but the server could not form its result. Do not call probe_write again for it.',
      );
    });

    it('says that alfaview sent an unexpected response for a tool that only reads', async () => {
      const tool = answerTool('probe_read', READ_ANNOTATIONS, undefined);
      const harness = await toolHarness([tool], [loginRequest(), roomsAnswer('GET', ['room-1'])]);
      const result = await harness.call('probe_read', {});
      await harness.done();

      assert.equal(result.isError, true);
      assert.equal(result.summary, 'alfaview sent an unexpected response for probe_read.');
      assert.equal(result.summary, unexpectedResponseMessage('probe_read'));
      assert.equal(
        harness.logLines.at(-1),
        'alfaview-mcp: tool probe_read: OutputShape (rooms[].id), 2 requests, 0 ms\n',
      );
    });
  });

  // The MCP specification asks a server to limit the rate of tool calls.
  describe('the limits of the rate', () => {
    it('take at most 120 tool calls a minute, and refuse the next one before run', async () => {
      const clock = testClock();
      const harness = await toolHarness([probeTool], [], { now: clock.now });
      const results = [];
      for (let index = 0; index < 120; index += 1) {
        results.push(await harness.call('probe_tool', { marker: `call-${index}` }));
      }
      const contextBefore = lastContext;
      const refused = await harness.call('probe_tool', { marker: 'refused' });
      const contextAfter = lastContext;
      clock.advance(60_000);
      const later = await harness.call('probe_tool', { marker: 'later' });
      await harness.done();

      assert.equal(TOOL_CALLS_PER_MINUTE, 120);
      assert.ok(results.every((result) => !result.isError));
      assert.deepEqual(refused, {
        isError: true,
        summary: 'The alfaview MCP server takes at most 120 tool calls a minute. Wait a minute and call again.',
        data: undefined,
        text: undefined,
      });
      assert.equal(refused.summary, TOOL_CALLS_RATE_LIMITED_MESSAGE);
      // `run` did not start for the refused call: it got no context of its own.
      assert.ok(contextBefore !== undefined);
      assert.equal(contextAfter, contextBefore);
      assert.equal(harness.logLines[120], 'alfaview-mcp: tool probe_tool: RateLimited, 0 requests, 0 ms\n');
      assert.equal(later.data.marker, 'later');
    });

    it('count the calls of one server together, also those that fail in the tool', async () => {
      const clock = testClock();
      const harness = await toolHarness([probeTool], [], { now: clock.now });
      for (let index = 0; index < 120; index += 1) {
        await harness.call('probe_tool', { fail: index % 2 === 0 ? 'tool' : 'no' });
      }
      const refused = await harness.call('probe_tool', {});
      await harness.done();

      assert.equal(refused.summary, TOOL_CALLS_RATE_LIMITED_MESSAGE);
    });

    it('count the calls of all tools of a server together, not each tool on its own', async () => {
      const clock = testClock();
      const harness = await toolHarness([probeTool, otherProbeTool], [], { now: clock.now });
      const results = [];
      for (let index = 0; index < 120; index += 1) {
        results.push(await harness.call(index % 2 === 0 ? 'probe_tool' : 'other_probe_tool', {}));
      }
      const refusedProbe = await harness.call('probe_tool', {});
      const refusedOther = await harness.call('other_probe_tool', {});
      await harness.done();

      assert.ok(results.every((result) => !result.isError));
      assert.equal(refusedProbe.summary, TOOL_CALLS_RATE_LIMITED_MESSAGE);
      assert.equal(refusedOther.summary, TOOL_CALLS_RATE_LIMITED_MESSAGE);
    });

    it('start the ninth request of nine concurrent calls when one of the first eight ends', async () => {
      const gates = Array.from({ length: 9 }, () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        return { gate, release };
      });
      const harness = await toolHarness(
        [probeTool],
        [
          loginRequest(),
          ...gates.map(({ gate }) => ({
            method: 'GET',
            path: '/v2/permission-groups',
            respond: { waitFor: gate, then: { status: 200, body: [] } },
          })),
        ],
        { anyOrder: true },
      );
      const calls = gates.map(() => harness.call('probe_tool', { requests: 1 }));
      await untilRequests(harness.fake, 9);
      for (let round = 0; round < 5; round += 1) await flush();
      assert.equal(harness.fake.requests.length, 9);

      gates[0]!.release();
      await untilRequests(harness.fake, 10);
      for (const { release } of gates) release();
      const results = await Promise.all(calls);
      await harness.done();

      assert.ok(results.every((result) => !result.isError));
    });
  });
});

// The kinds of the values that Leave out set to null.
describe('the warning of Leave out of a result', () => {
  /** The warning of `data` of a tool of `personalData`, after its removal with Leave out. */
  function warningOf(data: ToolData, personalData: ToolPersonalData): string | undefined {
    return leftOutWarning(data, withoutPersonalData(data, personalData, 'omit'), personalData);
  }

  /** Data with `value` at `path`, as PERSONAL_KEYS writes a path: `results[].emailAddress`. */
  function dataWith(path: string, value: unknown): ToolData {
    const [first, ...rest] = path.split('.') as [string, ...string[]];
    const inner = rest.length === 0 ? value : dataWith(rest.join('.'), value);
    return first.endsWith('[]') ? { [first.slice(0, -2)]: [inner] } : { [first]: inner };
  }

  it('names the kind of each path of each shape of the server, and no echo of the input', () => {
    const shapes = Object.keys(PERSONAL_KEYS).filter((shape) => shape.startsWith('mcp.')) as ToolResultShape[];
    // The model gave these values in the call, so they are no values of alfaview.
    const echoes = ['mcp.deleteExpiredGuestLinksResult originContains', 'mcp.roomAttendance origin'];
    const named = new Set<string>();
    for (const shape of shapes) {
      for (const path of PERSONAL_KEYS[shape] as readonly string[]) {
        const warning = warningOf(dataWith(path, MARKER), { shape });
        if (echoes.includes(`${shape} ${path}`)) {
          assert.equal(warning, undefined, `${shape} ${path}`);
          continue;
        }
        const kind = LEFT_OUT_KINDS.find((item) => warning === leftOutText(item));
        assert.ok(kind !== undefined, `${shape} ${path}: ${warning}`);
        named.add(kind);
      }
    }
    // The name of a meeting room is no path of PERSONAL_KEYS (MEETING_ROOM_NAME_KEYS).
    assert.deepEqual(
      LEFT_OUT_KINDS.filter((kind) => !named.has(kind)),
      ['the names of meeting rooms'],
    );
  });

  it('names each kind once, in a fixed order, and no value of the result', () => {
    const user = {
      id: 'user-1',
      initials: MARKER,
      city: MARKER,
      title: MARKER,
      lastName: MARKER,
      firstName: MARKER,
      emailAddress: `${MARKER}@example.com`,
    };
    const account = warningOf({ user, company: { id: 'company-1' } }, { shape: 'mcp.account' });
    const users = warningOf({ users: [user, { ...user, id: 'user-2' }] }, { shape: 'mcp.user', list: 'users' });

    assert.equal(account, leftOutText('names, email addresses, titles, cities and initials'));
    assert.equal(users, account);
    assert.ok(!account!.includes(MARKER));
  });

  it('names a meeting title, an agenda and the name of a meeting room', () => {
    const meeting = warningOf({ id: 'meeting-1', title: MARKER, agenda: MARKER }, { shape: 'mcp.meeting' });
    const room = { id: MEETING_ROOM_ID, displayName: MARKER, type: 'meeting', waitingRoomWelcomeNote: MARKER };
    const meetingRoom = warningOf(room, { shape: 'mcp.room' });
    const rooms = warningOf(
      { rooms: [{ ...room, id: ROOM_ID, type: 'room', waitingRoomWelcomeNote: null }, room] },
      { shape: 'mcp.room', list: 'rooms' },
    );

    assert.equal(meeting, leftOutText('meeting titles and agendas'));
    assert.equal(meetingRoom, leftOutText('the names of meeting rooms and welcome notes'));
    assert.equal(rooms, meetingRoom);
  });

  it('counts a list of addresses with an entry, not an empty one, and the nested paths of a list', () => {
    const report = {
      attendedEmails: [],
      noShowEmails: null,
      origin: 'Webinar',
      invitees: [{ guestLinkId: 'link-1', emailAddress: null, displayName: null, origin: MARKER }],
      otherAttendees: [],
    };

    assert.equal(warningOf(report, { shape: 'mcp.roomAttendance' }), leftOutText('origins'));
    assert.equal(
      warningOf({ ...report, noShowEmails: [`${MARKER}@example.com`] }, { shape: 'mcp.roomAttendance' }),
      leftOutText('email addresses and origins'),
    );
  });

  it('is undefined when the removal set no value of alfaview to null', () => {
    const cases: [ToolData, ToolPersonalData][] = [
      [{ links: [] }, { shape: 'mcp.guestLink', list: 'links' }],
      [{ links: [{ id: 'link-1', emailAddress: null }] }, { shape: 'mcp.guestLink', list: 'links' }],
      // A key whose value is undefined holds no value either.
      [{ id: 'link-1', displayName: undefined, origin: undefined }, { shape: 'mcp.guestLink' }],
      [{ id: ROOM_ID, displayName: 'Advisory room', type: 'room' }, { shape: 'mcp.room' }],
      [{ code: 'de-DE', count: 2, nested: { list: [1, 'a'] } }, { shape: 'mcp.roomSettings' }],
      [{ id: 'user-1', user: null }, { shape: 'mcp.account' }],
      // A window without invited people: empty email lists and the origin of the call only.
      [
        { origin: 'Webinar', attendedEmails: [], noShowEmails: [], invitees: [], otherAttendees: [] },
        { shape: 'mcp.roomAttendance' },
      ],
      // The filter text of a cleanup is the input of the call.
      [{ roomId: ROOM_ID, originContains: 'Webinar', deletedCount: 2 }, { shape: 'mcp.deleteExpiredGuestLinksResult' }],
    ];
    for (const [data, personalData] of cases) {
      assert.equal(warningOf(data, personalData), undefined, JSON.stringify(data));
    }
  });
});

describe('the ID parameters', () => {
  it('accept a UUID in lower and upper case, with spaces around it', () => {
    assert.equal(roomIdParameter.parse(ROOM_ID), ROOM_ID);
    assert.equal(roomIdParameter.parse(ROOM_ID.toUpperCase()), ROOM_ID.toUpperCase());
    assert.equal(roomIdParameter.parse(`  ${ROOM_ID} `), ROOM_ID);
  });

  it('refuse a name, dot segments and a UUID with a missing group, with the message of the tool', () => {
    for (const value of ['Advisory Room', '.', '..', '0b7c5d2e-91a4-5f3b-0f4a6c9d1e22']) {
      const result = roomIdParameter.safeParse(value);
      assert.equal(result.success, false, value);
      assert.equal(
        result.error!.issues[0]!.message,
        'roomId takes an ID from find_rooms, or a meeting ID, not a name.',
      );
    }
  });

  it('give an ID parameter of its own the message and the description of its tool', () => {
    const parameter = idParameter(
      { parameter: 'parentId', source: 'find_rooms' },
      'parentId takes a department ID.',
      'The department.',
    );
    assert.equal(parameter.description, 'The department.');
    assert.equal(parameter.parse(` ${ROOM_ID.toUpperCase()} `), ROOM_ID.toUpperCase());
    assert.equal(parameter.safeParse('..').error!.issues[0]!.message, 'parentId takes a department ID.');
    // Without otherKind, a parameter takes an ID of any kind.
    assert.equal(parameter.parse(USER_ID), USER_ID);
  });

  // The nil UUID is no ID of alfaview, so each ID parameter refuses it before any request.
  it('refuse the nil UUID with the tool that gives the ID', () => {
    const nil = '00000000-0000-0000-0000-000000000000';
    for (const [parameter, name, source] of [
      [roomIdParameter, 'roomId', 'find_rooms'],
      [userIdParameter, 'userId', 'find_users'],
      [guestLinkIdParameter, 'guestLinkId', 'find_guest_links'],
      [meetingIdParameter, 'meetingId', 'find_meetings'],
      [subroomIdParameter, 'subroomId', 'get_room'],
      [groupLinkIdParameter, 'groupLinkId', 'find_group_links'],
    ] as const) {
      const issues = parameter.safeParse(` ${nil} `).error!.issues;
      assert.deepEqual(
        issues.map((issue) => issue.message),
        [`${name} ${nil} is no ID. Call ${source} first and use an ID from its result.`],
        name,
      );
    }
  });

  // roomId refuses an ID of a user or a guest by the kind in byte 10 of a version 5 UUID.
  // A version 4 UUID names no kind, and an older room can have one. roomId does not check the kind
  // of a guest link ID, so such an ID gets the answer of the room lookup.
  it('refuse a user ID and a guest ID as roomId, in any case', () => {
    for (const [id, kind] of [
      [USER_ID, 'a user ID'],
      [GUEST_ID, 'the ID of a guest'],
    ] as const) {
      for (const parameter of [roomIdParameter, roomIdNotMeetingWith('A room.')]) {
        const issues = parameter.safeParse(id.toUpperCase()).error!.issues;
        assert.deepEqual(
          issues.map((issue) => issue.message),
          [`roomId ${id.toUpperCase()} is ${kind}, not a room ID. Give a room ID from find_rooms.`],
        );
      }
      assert.ok(idProblem(ROOM_ID_RULE, id) !== undefined);
    }
    assert.deepEqual([otherIdKind(USER_ID), otherIdKind(GUEST_ID)], ['user', 'guest']);
    for (const id of [ROOM_ID, MEETING_ROOM_ID, V4_ID, 'c4a1e2b3-5d6f-4a7b-8c9d-12e3f4a5b6c7', GUEST_LINK_ID]) {
      assert.equal(otherIdKind(id), undefined, id);
      assert.equal(roomIdParameter.parse(id), id);
    }
    // A user ID of another variant is no ID of alfaview, and no user ID either.
    assert.equal(otherIdKind(USER_ID.replace('-8', '-c')), undefined);
    assert.equal(idProblem(ROOM_ID_RULE, 'Advisory Room'), undefined);
  });

  it('give the user ID the message and the description that name find_users', () => {
    assert.equal(userIdParameter.description, 'User ID from find_users.');
    assert.equal(userIdWith('Only this user.').description, 'Only this user.');
    assert.equal(userIdParameter.parse(` ${ROOM_ID.toUpperCase()} `), ROOM_ID.toUpperCase());
    assert.equal(
      userIdParameter.safeParse('anna@example.com').error!.issues[0]!.message,
      'userId takes an ID from find_users, not a name or an email address.',
    );
  });

  // A tool that refuses a meeting room does not offer a meeting ID.
  it('give the room ID of a tool that refuses a meeting room a message without a meeting ID', () => {
    const parameter = roomIdNotMeetingWith('Room ID from find_rooms. Not a meeting ID.');
    assert.equal(parameter.description, 'Room ID from find_rooms. Not a meeting ID.');
    assert.equal(parameter.parse(ROOM_ID.toUpperCase()), ROOM_ID.toUpperCase());
    assert.equal(
      parameter.safeParse('Advisory Room').error!.issues[0]!.message,
      'roomId takes a room ID from find_rooms, not a name or a meeting ID.',
    );
  });

  // The advertised schema has format uuid, and zod keeps the pattern with its message.
  it('advertise format uuid in the place of the pattern, which zod still checks in both cases', async () => {
    const harness = await toolHarness([probeTool], []);
    const { tools } = await harness.client.listTools();
    const refused = await harness.call('probe_tool', { roomId: 'Advisory Room' });
    await harness.done();

    const roomId = (tools[0]!.inputSchema.properties as Record<string, Record<string, unknown>>).roomId!;
    assert.deepEqual(roomId, { type: 'string', format: 'uuid', description: 'Room ID from find_rooms.' });
    assert.ok(UUID_PATTERN.test(ROOM_ID) && UUID_PATTERN.test(ROOM_ID.toUpperCase()));
    assert.ok(!UUID_PATTERN.test('..'));
    assert.equal(refused.isError, true);
    assert.match(refused.summary, /roomId: roomId takes an ID from find_rooms, or a meeting ID, not a name\./);
  });
});

describe('the advertised schema', () => {
  it('leaves out $schema, minLength 1 and the maximum of an offset, and names the zone of the server', () => {
    const json = advertised(probeTool.inputSchema, 'Asia/Tokyo')['~standard'].jsonSchema.input({
      target: 'draft-2020-12',
    });
    const text = JSON.stringify(json);
    const properties = json.properties as Record<string, Record<string, unknown>>;

    assert.equal('$schema' in json, false);
    assert.deepEqual(properties.name, { type: 'string', maxLength: 10, description: 'A name.' });
    assert.deepEqual(properties.offset, {
      default: 0,
      description: 'The nextOffset of the previous result.',
      type: 'integer',
      minimum: 0,
    });
    assert.equal(
      properties.from!.description,
      'The start. Local time in Asia/Tokyo unless it has an offset, for example 2026-10-27T10:00.',
    );
    assert.ok(!text.includes(TIME_ZONE_SLOT));
    // zod still has each check that the advertised schema leaves out.
    const zod = z.toJSONSchema(probeTool.inputSchema, { target: 'draft-2020-12', io: 'input' });
    assert.match(JSON.stringify(zod), /"\$schema"/);
    assert.match(JSON.stringify(zod), /"minLength":1/);
    assert.match(JSON.stringify(zod), new RegExp(`"maximum":${Number.MAX_SAFE_INTEGER}`));
  });

  it('checks the input with zod, so its messages and defaults stay', async () => {
    const schema = advertised(probeTool.inputSchema, 'UTC')['~standard'];
    const valid = await schema.validate({ name: '  Anna  ' });
    const invalid = await schema.validate({ name: '   ', offset: Number.MAX_SAFE_INTEGER + 2 });

    assert.ok(!('issues' in valid && valid.issues !== undefined));
    const value = (valid as unknown as { value: { name: string; offset: number } }).value;
    assert.deepEqual([value.name, value.offset], ['Anna', 0]);
    assert.deepEqual(
      (invalid as unknown as { issues: { path: unknown[] }[] }).issues.map((issue) => issue.path),
      [['name'], ['offset']],
    );
    assert.equal(schema.vendor, 'zod');
  });
});

describe('the shared parameters', () => {
  // The zone of the server takes the place of TIME_ZONE_SLOT in the advertised schema.
  it('describe dates, time zones, limits and offsets', () => {
    assert.equal(
      dateTimeParameter('The start.', 'timezone').description,
      'The start. Local time in timezone, else in {timeZone}, unless it has an offset, for example 2026-10-27T10:00.',
    );
    assert.equal(
      dateTimeParameter('Start of the window.', 'server').description,
      'Start of the window. Local time in {timeZone} unless it has an offset, for example 2026-10-27T10:00.',
    );
    assert.equal(
      timezoneParameter('Time zone for the email.').description,
      'Time zone for the email. An IANA name. It is also the zone of times without an offset and of the result. Default: {timeZone}.',
    );
    assert.equal(TIME_ZONE_SLOT, '{timeZone}');
    assert.equal(limitParameter('rooms', 50, 20).description, 'The most rooms to return.');
    assert.equal(offsetParameter().description, 'The nextOffset of the previous result.');
  });

  it('check the limits and give the defaults', () => {
    const limit = limitParameter('rooms', 50, 20);
    assert.equal(limit.parse(undefined), 20);
    assert.equal(limit.safeParse(0).success, false);
    assert.equal(limit.safeParse(51).success, false);
    assert.equal(limit.safeParse(2.5).success, false);
    assert.equal(offsetParameter().parse(undefined), 0);
    assert.equal(offsetParameter().safeParse(-1).success, false);
    assert.equal(dateTimeParameter('x', 'server').safeParse('x'.repeat(65)).success, false);
    assert.equal(textParameter('x', 3).safeParse('abcd').success, false);
    assert.equal(textParameter('x').parse(' long text '), 'long text');
  });

  it('have the annotations of a read, a create and a change', () => {
    assert.deepEqual(READ_ANNOTATIONS, { readOnlyHint: true, openWorldHint: true });
    assert.deepEqual(CREATE_ANNOTATIONS, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    assert.deepEqual(CHANGE_ANNOTATIONS, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it('have the annotations of a change that a repeat does not change further', () => {
    assert.deepEqual(IDEMPOTENT_CHANGE_ANNOTATIONS, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });
});

describe('the result helpers', () => {
  it('count in singular and plural', () => {
    assert.equal(count(0, 'room'), '0 rooms');
    assert.equal(count(1, 'room'), '1 room');
    assert.equal(count(2, 'guest link'), '2 guest links');
    assert.equal(count(2, 'person', 'people'), '2 people');
  });

  it('join names with commas and the conjunction before the last', () => {
    assert.equal(listed([], 'and'), '');
    assert.equal(listed(['join'], 'and'), 'join');
    assert.equal(listed(['join', 'voice'], 'and'), 'join and voice');
    assert.equal(listed(['a', 'b', 'c'], 'or'), 'a, b or c');
  });

  it('cut a part of a list and give the next offset', () => {
    const letters = ['a', 'b', 'c', 'd', 'e'];
    assert.deepEqual(listPart(letters, 0, 2), {
      totalMatches: 5,
      offset: 0,
      nextOffset: 2,
      items: ['a', 'b'],
    });
    assert.deepEqual(listPart(letters, 3, 2), {
      totalMatches: 5,
      offset: 3,
      nextOffset: null,
      items: ['d', 'e'],
    });
    assert.deepEqual(listPart(letters, 9, 2), {
      totalMatches: 5,
      offset: 9,
      nextOffset: null,
      items: [],
    });
    assert.deepEqual(listPart([], 0, 2), { totalMatches: 0, offset: 0, nextOffset: null, items: [] });
  });

  it('say what the part shows and how to get the next one', () => {
    const letters = ['a', 'b', 'c', 'd', 'e'];
    assert.equal(
      showing(listPart(letters, 0, 2)),
      ' Showing 1 to 2. Call again with offset 2 for the next ones.',
    );
    assert.equal(showing(listPart(letters, 3, 2)), ' Showing 4 to 5.');
    assert.equal(showing(listPart(letters, 9, 2)), ' Nothing at offset 9.');
    assert.equal(showing(listPart([], 0, 2)), '');
  });

  it('name what they show and give the number of matches when asked', () => {
    const letters = ['a', 'b', 'c', 'd', 'e'];
    assert.equal(
      showing(listPart(letters, 0, 2), { items: 'invited people' }),
      ' Showing invited people 1 to 2. Call again with offset 2 for the next ones.',
    );
    assert.equal(showing(listPart(letters, 3, 2), { ofTotal: true }), ' Showing 4 to 5 of 5.');
    assert.equal(showing(listPart(letters, 9, 2), { items: 'people', ofTotal: true }), ' Nothing at offset 9.');
    assert.equal(showing(listPart([], 0, 2), { ofTotal: true }), '');
  });
});
