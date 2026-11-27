// Reads the output of `claude -p --output-format stream-json --verbose` (parseStream), and tells
// whether a run counts (invalidReasons) and whether it has a problem that the server can cause
// (runProblems).

/** The prefix of the server's tools in Claude Code, from the name "alfaview" in the MCP config. */
export const TOOL_PREFIX = 'mcp__alfaview__';

/**
 * What Claude Code loads next to the server:
 *
 * - server: only the alfaview tools, without a skill. It measures a change of the server.
 * - plain: the alfaview tools and the tools of a skill (ARM_TOOLS), without a skill.
 * - skill: the arguments of plain and the plugin folder, which adds the skill PLUGIN_SKILL.
 *
 * plain and skill use the same arguments except --plugin-dir, so their comparison measures the
 * skill alone.
 */
export type Arm = 'server' | 'plain' | 'skill';

export const ARMS: readonly Arm[] = ['server', 'plain', 'skill'];

/**
 * The built-in tools of the arms plain and skill. Skill calls a skill, Read reads its reference
 * files, and ToolSearch loads the schemas of the tools that Claude Code defers.
 */
export const ARM_TOOLS = ['Skill', 'Read', 'ToolSearch'];

/** The skill of the plugin, by the name that Claude Code gives it. */
export const PLUGIN_SKILL = 'alfaview-mcp:alfaview-meetings';

/** The start of the text of a skill that Claude Code gives the model after a call of the tool Skill. */
const SKILL_TEXT_START = 'Base directory for this skill: ';

/**
 * The start of the result subtype of a run that reached a limit of the run, such as
 * error_max_turns for --max-turns or error_max_budget_usd for --max-budget-usd.
 */
export const LIMIT_SUBTYPE_PREFIX = 'error_max_';

export type ToolCall = {
  /** The name of the tool, without the prefix of Claude Code for a tool of the server. */
  name: string;
  input: unknown;
  /** True when the tool result was an error result. */
  isError: boolean;
  /** The characters of the tool result that the model saw, or null without a result. */
  resultChars: number | null;
  /** True for a tool of the server, false for a tool of Claude Code, such as Skill or Read. */
  server: boolean;
};

export type Tokens = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
};

export type StreamInit = {
  model: string | null;
  claudeCodeVersion: string | null;
  /** The tool names that the model got. */
  tools: string[];
  mcpServers: { name: string; status: string }[];
  apiKeySource: string | null;
  /** The skills that the model can call. */
  skills: string[];
};

export type StreamResult = {
  subtype: string | null;
  isError: boolean;
  numTurns: number | null;
  durationMs: number | null;
  costUsd: number | null;
  tokens: Tokens;
  /** The models that the run used, from modelUsage. */
  models: string[];
  text: string | null;
  apiErrorStatus: unknown;
  permissionDenials: number;
};

export type ParsedStream = {
  init: StreamInit | null;
  toolCalls: ToolCall[];
  /** The model requests: the distinct message IDs of the assistant events. */
  modelRequests: number;
  result: StreamResult | null;
  /** The status of each rate limit event, such as "allowed". */
  rateLimitStatuses: string[];
  /**
   * The causes of the assistant events that Claude Code wrote for an error of the model API, such
   * as "authentication_failed".
   */
  apiErrorMessages: string[];
  /**
   * The parts of user events that are not a tool result, such as a text. Only a message from
   * outside the run gives one, for example through the messaging socket of Claude Code. The text of
   * a skill after a call of the tool Skill (isSkillText) does not count.
   */
  otherUserContent: number;
  /** The final text: the text of the result event, else the text of the last assistant event. */
  finalText: string;
  /** Lines that are not JSON objects. */
  badLines: number;
};

type Event = Record<string, any>;

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function count(value: unknown): number {
  return numberOrNull(value) ?? 0;
}

/** Returns the length of a tool_result content: a text, or the texts of a list of blocks. */
function contentChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce(
    (sum: number, block: unknown) =>
      sum + (typeof (block as Event)?.text === 'string' ? (block as Event).text.length : 0),
    0,
  );
}

function blocksOf(event: Event): Event[] {
  const content = event.message?.content;
  return Array.isArray(content) ? content.filter((block) => typeof block === 'object' && block !== null) : [];
}

/**
 * Returns true for the user event with the text of a skill that Claude Code writes after a call of
 * the tool Skill: a synthetic event that holds only text, and whose text starts with the folder of
 * the skill.
 */
function isSkillText(event: Event): boolean {
  const content = event.message?.content;
  return (
    event.isSynthetic === true &&
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((block) => typeof block?.text === 'string' && block.type === 'text') &&
    content[0].text.startsWith(SKILL_TEXT_START)
  );
}

/**
 * Parses the output of `claude -p --output-format stream-json --verbose`: one JSON event per line.
 * It reads these events, as Claude Code 2.1.312 writes them:
 *
 * - system/init: the model, the version of Claude Code, the tools, the MCP servers and the skills.
 * - assistant: message.content holds the text and the tool_use blocks of the model. One model
 *   request can give several assistant events with the same message.id. When the model API gave
 *   no answer, Claude Code writes the error as an assistant event with is_api_error_message true
 *   and the cause in error, such as authentication_failed when it is not logged in.
 * - user: message.content holds the tool_result blocks, the content that the model saw. After the
 *   result of a call of the tool Skill, Claude Code 2.1.332 writes the text of the skill as a user
 *   event with isSynthetic true and one text block.
 * - rate_limit_event: rate_limit_info.status.
 * - result: the final text, the turns, the usage, the cost and the duration of the whole run.
 *   num_turns counts the tool calls plus one, not the model requests.
 *
 * The usage of an assistant event is partial, so the totals come from the result event only.
 */
export function parseStream(text: string): ParsedStream {
  const parsed: ParsedStream = {
    init: null,
    toolCalls: [],
    modelRequests: 0,
    result: null,
    rateLimitStatuses: [],
    apiErrorMessages: [],
    otherUserContent: 0,
    finalText: '',
    badLines: 0,
  };
  const callsById = new Map<string, ToolCall>();
  const messageIds = new Set<string>();
  let lastAssistantText = '';
  // The calls of the tool Skill with a result that is no error, whose text did not come yet.
  let skillTextsDue = 0;

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let event: Event;
    try {
      event = JSON.parse(line);
    } catch {
      parsed.badLines += 1;
      continue;
    }
    if (typeof event !== 'object' || event === null) {
      parsed.badLines += 1;
      continue;
    }

    if (event.type === 'system' && event.subtype === 'init') {
      parsed.init = {
        model: textOrNull(event.model),
        claudeCodeVersion: textOrNull(event.claude_code_version),
        tools: Array.isArray(event.tools) ? event.tools.filter((tool: unknown) => typeof tool === 'string') : [],
        mcpServers: Array.isArray(event.mcp_servers)
          ? event.mcp_servers.map((server: Event) => ({
              name: String(server?.name),
              status: String(server?.status),
            }))
          : [],
        apiKeySource: textOrNull(event.apiKeySource),
        skills: Array.isArray(event.skills) ? event.skills.filter((skill: unknown) => typeof skill === 'string') : [],
      };
    } else if (event.type === 'assistant') {
      if (event.is_api_error_message === true) parsed.apiErrorMessages.push(String(event.error ?? 'unknown'));
      const id = event.message?.id;
      if (typeof id !== 'string') {
        parsed.modelRequests += 1;
      } else if (!messageIds.has(id)) {
        messageIds.add(id);
        parsed.modelRequests += 1;
      }
      const texts: string[] = [];
      for (const block of blocksOf(event)) {
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
        if (block.type !== 'tool_use') continue;
        const name = String(block.name);
        const server = name.startsWith(TOOL_PREFIX);
        const call: ToolCall = {
          name: server ? name.slice(TOOL_PREFIX.length) : name,
          input: block.input,
          isError: false,
          resultChars: null,
          server,
        };
        parsed.toolCalls.push(call);
        if (typeof block.id === 'string') callsById.set(block.id, call);
      }
      if (texts.length > 0) lastAssistantText = texts.join('\n');
    } else if (event.type === 'user') {
      if (skillTextsDue > 0 && isSkillText(event)) {
        skillTextsDue -= 1;
        continue;
      }
      const content = event.message?.content;
      if (!Array.isArray(content)) {
        parsed.otherUserContent += 1;
        continue;
      }
      parsed.otherUserContent += content.filter(
        (block) => typeof block !== 'object' || block === null || block.type !== 'tool_result',
      ).length;
      for (const block of blocksOf(event)) {
        if (block.type !== 'tool_result') continue;
        const call = callsById.get(block.tool_use_id);
        if (call === undefined) continue;
        call.isError = block.is_error === true;
        call.resultChars = contentChars(block.content);
        if (!call.server && call.name === 'Skill' && !call.isError) skillTextsDue += 1;
      }
    } else if (event.type === 'rate_limit_event') {
      parsed.rateLimitStatuses.push(String(event.rate_limit_info?.status));
    } else if (event.type === 'result') {
      const usage = event.usage ?? {};
      parsed.result = {
        subtype: textOrNull(event.subtype),
        isError: event.is_error === true,
        numTurns: numberOrNull(event.num_turns),
        durationMs: numberOrNull(event.duration_ms),
        costUsd: numberOrNull(event.total_cost_usd),
        tokens: {
          input: count(usage.input_tokens),
          output: count(usage.output_tokens),
          cacheRead: count(usage.cache_read_input_tokens),
          cacheCreation: count(usage.cache_creation_input_tokens),
        },
        models:
          typeof event.modelUsage === 'object' && event.modelUsage !== null
            ? Object.keys(event.modelUsage)
            : [],
        text: textOrNull(event.result),
        apiErrorStatus: event.api_error_status ?? null,
        permissionDenials: Array.isArray(event.permission_denials) ? event.permission_denials.length : 0,
      };
    }
  }

  parsed.finalText = parsed.result?.text ?? lastAssistantText;
  return parsed;
}

/** Returns the skill of the input of a call of the tool Skill, or "unknown" without one. */
function skillOf(input: unknown): string {
  const skill = (input as Event | null)?.skill;
  return typeof skill === 'string' ? skill : 'unknown';
}

/**
 * Returns the reasons why a run of `arm` says nothing about the server, because of a cause outside
 * the server. An empty list means the run counts.
 *
 * The causes are a rate limit, an error of the model API (also a Claude Code that is not logged
 * in), another model, and a run that was not isolated: another tool, another MCP server, an API
 * key, a message from outside the run, or a skill. The arms plain and skill allow the tools of
 * ARM_TOOLS. The arm plain allows no skill and no call of Skill. The arm skill needs PLUGIN_SKILL,
 * allows no other skill, and allows a call of Skill only for PLUGIN_SKILL: the tool can also load a
 * command of Claude Code that the init event lists in slash_commands, not in skills, such as init.
 * The arm server does not read the skills, because --disable-slash-commands turns them off.
 */
export function invalidReasons(parsed: ParsedStream, model: string, arm: Arm): string[] {
  const reasons: string[] = [];
  if (parsed.init !== null) {
    if (parsed.init.model !== model) reasons.push(`Claude Code ran the model ${parsed.init.model}`);
    const clientTools = arm === 'server' ? [] : ARM_TOOLS;
    const others = parsed.init.tools.filter((tool) => !tool.startsWith(TOOL_PREFIX) && !clientTools.includes(tool));
    if (others.length > 0) reasons.push(`the model also got the tools ${others.join(', ')}`);
    const servers = parsed.init.mcpServers.filter((server) => server.name !== 'alfaview');
    if (servers.length > 0) reasons.push(`Claude Code also started the MCP servers ${servers.map((server) => server.name).join(', ')}`);
    if (parsed.init.apiKeySource !== 'none') {
      reasons.push(`Claude Code used an API key (${String(parsed.init.apiKeySource)})`);
    }
    if (arm !== 'server') {
      const skills = parsed.init.skills.filter((skill) => arm !== 'skill' || skill !== PLUGIN_SKILL);
      if (skills.length > 0) reasons.push(`Claude Code also offered the skills ${skills.join(', ')}`);
      if (arm === 'skill' && !parsed.init.skills.includes(PLUGIN_SKILL)) {
        reasons.push(`Claude Code did not offer the skill ${PLUGIN_SKILL}`);
      }
    }
  }
  if (arm !== 'server') {
    const called = parsed.toolCalls
      .filter((call) => !call.server && call.name === 'Skill')
      .map((call) => skillOf(call.input))
      .filter((skill) => arm !== 'skill' || skill !== PLUGIN_SKILL);
    if (called.length > 0) reasons.push(`the model called the skills ${[...new Set(called)].join(', ')}`);
  }
  if (parsed.result !== null) {
    if (parsed.result.apiErrorStatus !== null) {
      reasons.push(`the API answered with the error ${String(parsed.result.apiErrorStatus)}`);
    }
    const others = parsed.result.models.filter((item) => item !== model);
    if (others.length > 0) reasons.push(`the run also used ${others.join(', ')}`);
  }
  if (parsed.apiErrorMessages.length > 0) {
    reasons.push(`the model API gave no answer: ${parsed.apiErrorMessages.join(', ')}`);
  }
  const limited = parsed.rateLimitStatuses.filter((status) => !status.startsWith('allowed'));
  if (limited.length > 0) reasons.push(`rate limit ${limited.join(', ')}`);
  if (parsed.otherUserContent > 0) reasons.push('a message from outside the run reached the model');
  return reasons;
}

/**
 * Returns the problems of a run that the server can cause: Claude Code did not start or end as it
 * should, the server did not connect, or the run ended with an error. Such a run counts, and it
 * fails.
 */
export function runProblems(parsed: ParsedStream): string[] {
  const problems: string[] = [];
  if (parsed.init === null) {
    problems.push('Claude Code sent no init event');
  } else {
    const server = parsed.init.mcpServers.find((item) => item.name === 'alfaview');
    if (server?.status !== 'connected') problems.push(`the alfaview server is ${server?.status ?? 'missing'}`);
  }
  if (parsed.result === null) {
    problems.push('Claude Code sent no result event');
  } else {
    // error_max_turns and error_max_budget_usd are limits that the agent reached: the checks show
    // what the run did up to then. Every other error ends the run as a failure.
    const subtype = parsed.result.subtype ?? 'missing';
    if (subtype !== 'success' && !subtype.startsWith(LIMIT_SUBTYPE_PREFIX)) problems.push(`the result is ${subtype}`);
  }
  return problems;
}
