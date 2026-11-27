// The configuration of the server. It is read and checked once at start, from the environment that
// the MCP client gives the server, and every problem is reported together.
import {
  ACCESS_LEVELS,
  DEFAULT_ACCESS_LEVEL,
  levelIncludes,
  type AccessLevel,
} from './levels.ts';
import { PRODUCTION_BASE_URL } from './shared/apiHosts.ts';
import { readPersonalDataMode, type PersonalDataMode } from './shared/personalData.ts';
import { DEFAULT_TIME_ZONE, knownTimeZone } from './values/time.ts';

export { PRODUCTION_BASE_URL } from './shared/apiHosts.ts';

/** The three variables without which the server cannot log in, in the order of the messages. */
const REQUIRED_VARIABLES = [
  'ALFAVIEW_COMPANY_ID',
  'ALFAVIEW_CLIENT_ID',
  'ALFAVIEW_API_KEY',
] as const;

export type Config = {
  companyId: string;
  clientId: string;
  apiKey: string;
  /** The origin of the alfaview API, for example `https://apis.alfaview.com`. */
  baseUrl: string;
  /**
   * The access level: ALFAVIEW_ACCESS_LEVEL, else `standard`. `full` only with the company ID in
   * ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS.
   */
  level: AccessLevel;
  /**
   * The names of the tools to register, in the order of the tool list: those that ALFAVIEW_TOOLS
   * names, else every tool of the level.
   */
  tools: readonly string[];
  /**
   * The server's time zone: ALFAVIEW_TIME_ZONE, else Europe/Berlin. It reads a time without an
   * offset when a call gives no `timezone`.
   */
  timeZone: string;
  /**
   * The option Personal data: ALFAVIEW_PERSONAL_DATA, `include` (the default) or `omit`, which
   * sets the names, email addresses and texts that people write to null in every result.
   */
  personalData: PersonalDataMode;
};

/** A tool as readConfig needs it: its name and the access level that registers it. */
export type ToolLevel = { name: string; level: AccessLevel };

/**
 * Thrown when the configuration cannot be used. `problems` has one text for each problem, and the
 * message joins them with line breaks. A problem quotes no given value except tool names and a
 * valid access level.
 */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(problems.join('\n'));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

function trimmed(value: string | undefined): string {
  return (value ?? '').trim();
}

/**
 * Returns the origin for ALFAVIEW_API_BASE_URL: the production origin when the value is empty or
 * names it, else `undefined`, also for a value with credentials. The server sends the API key to
 * the public alfaview API only.
 */
function readBaseUrl(value: string): string | undefined {
  if (value === '') return PRODUCTION_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== new URL(PRODUCTION_BASE_URL).hostname ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return undefined;
  }
  return url.origin;
}

/**
 * Returns the level of ALFAVIEW_ACCESS_LEVEL, `standard` when it is empty. `full` needs the company
 * ID in ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS, compared without case. Every other level needs that
 * variable unset: a shell that exports it gives it to each server entry of the MCP client, and a
 * later change of the level alone would unlock `full`. The result is a problem sentence otherwise,
 * never a lower level. An unknown level gives only its own problem, because the confirmation
 * cannot be checked against it.
 */
function readLevel(
  value: string,
  confirmation: string,
  companyId: string,
): { level: AccessLevel } | { problem: string } {
  const level = value === '' ? DEFAULT_ACCESS_LEVEL : ACCESS_LEVELS.find((name) => name === value);
  if (level === undefined) {
    return {
      problem:
        'ALFAVIEW_ACCESS_LEVEL must be read, standard, manage or full. Leave it empty for standard.',
    };
  }
  if (level !== 'full') {
    if (confirmation === '') return { level };
    return {
      problem:
        'ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS is set, but ALFAVIEW_ACCESS_LEVEL is not full. Remove the variable from this server entry and from the shell environment of the MCP client.',
    };
  }
  if (confirmation === '') {
    return {
      problem:
        'ALFAVIEW_ACCESS_LEVEL is full, which can delete rooms and users for good and change who has access to rooms. To allow it, set ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS to the company ID of this server entry.',
    };
  }
  if (confirmation.toLowerCase() !== companyId.toLowerCase()) {
    return {
      problem:
        'ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS does not match ALFAVIEW_COMPANY_ID. Set it to the company ID of this server entry.',
    };
  }
  return { level };
}

/**
 * The tools that a newer tool replaces, with the name of that tool. An entry that names one of them
 * gets a problem that names the newer tool, not an unknown name.
 */
export const REPLACED_TOOLS: Readonly<Record<string, string>> = {
  update_room_features: 'update_room_settings',
  update_room_language_settings: 'update_room_settings',
  update_room_file_sharing: 'update_room_settings',
};

/** Returns the tool names with their levels, such as `find_rooms (read), create_room (manage)`. */
function withLevels(tools: readonly ToolLevel[]): string {
  return tools.map((tool) => `${tool.name} (${tool.level})`).join(', ');
}

/**
 * Returns the tools that ALFAVIEW_TOOLS names among the tools of `level`, in the order of `tools`.
 * Empty gives every tool of the level. The result is a problem sentence for each of these: a list
 * without any name, unknown names, names of tools that a newer tool replaces (one sentence for
 * each newer tool), and names of tools above the level. The last check needs the level, so it does
 * not run when the level has a problem: no message names a level that the entry did not set.
 */
function readTools(
  value: string,
  tools: readonly ToolLevel[],
  level: AccessLevel | undefined,
): { tools: readonly string[] } | { problems: string[] } {
  const ofLevel =
    level === undefined ? [] : tools.filter((tool) => levelIncludes(level, tool.level));
  if (value === '') return { tools: ofLevel.map((tool) => tool.name) };
  const given = new Set(
    value
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== ''),
  );
  const allTools = withLevels(tools);
  if (given.size === 0) {
    return {
      problems: [
        `ALFAVIEW_TOOLS names no tools. Leave it empty for all tools of the access level, or name some of: ${allTools}.`,
      ],
    };
  }
  const problems: string[] = [];
  const missing = [...given].filter((name) => !tools.some((tool) => tool.name === name));
  const unknown = missing.filter((name) => !Object.hasOwn(REPLACED_TOOLS, name));
  if (unknown.length > 0) {
    problems.push(
      `ALFAVIEW_TOOLS names unknown tools: ${unknown.join(', ')}. The tools are: ${allTools}.`,
    );
  }
  const replaced = missing.filter((name) => Object.hasOwn(REPLACED_TOOLS, name));
  for (const newer of new Set(replaced.map((name) => REPLACED_TOOLS[name]))) {
    const names = replaced.filter((name) => REPLACED_TOOLS[name] === newer);
    problems.push(
      `ALFAVIEW_TOOLS names tools that ${newer} replaces: ${names.join(', ')}. Name ${newer} instead.`,
    );
  }
  const above =
    level === undefined
      ? []
      : tools.filter((tool) => given.has(tool.name) && !levelIncludes(level, tool.level));
  if (above.length > 0) {
    problems.push(
      `ALFAVIEW_TOOLS names tools above the level ${level}: ${withLevels(above)}. Set ALFAVIEW_ACCESS_LEVEL to the level of the tools, or remove their names.`,
    );
  }
  if (problems.length > 0) return { problems };
  return { tools: ofLevel.filter((tool) => given.has(tool.name)).map((tool) => tool.name) };
}

/**
 * Returns the time zone that ALFAVIEW_TIME_ZONE names, Europe/Berlin when it is empty, or
 * `undefined` for a value that names no zone. The computer's time zone is not used: dev containers
 * and CI runners usually run in UTC, which would shift every time without an offset in silence.
 */
function readServerTimeZone(value: string): string | undefined {
  return value === '' ? DEFAULT_TIME_ZONE : knownTimeZone(value);
}

/**
 * Reads the configuration from `env` for `tools`, the tools of the server with their levels.
 * Every value is trimmed, and an empty value counts as missing. Throws ConfigError with every
 * problem: the missing variables, then the base URL, then the access level and its confirmation,
 * then the tool names, then the time zone, then the option Personal data, then
 * `NODE_TLS_REJECT_UNAUTHORIZED=0`, which turns off the certificate check of HTTPS.
 */
export function readConfig(
  env: Record<string, string | undefined>,
  tools: readonly ToolLevel[],
): Config {
  const problems: string[] = [];

  const missing = REQUIRED_VARIABLES.filter((name) => trimmed(env[name]) === '');
  if (missing.length > 0) {
    problems.push(
      `Missing configuration: ${missing.join(', ')}. Set them in the env block of the alfaview server entry of your MCP client (README.md of the package, Configuration).`,
    );
  }

  const baseUrl = readBaseUrl(trimmed(env.ALFAVIEW_API_BASE_URL));
  if (baseUrl === undefined) {
    problems.push('ALFAVIEW_API_BASE_URL must be empty or https://apis.alfaview.com.');
  }

  const level = readLevel(
    trimmed(env.ALFAVIEW_ACCESS_LEVEL),
    trimmed(env.ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS),
    trimmed(env.ALFAVIEW_COMPANY_ID),
  );
  if ('problem' in level) problems.push(level.problem);

  const chosen = readTools(
    trimmed(env.ALFAVIEW_TOOLS),
    tools,
    'level' in level ? level.level : undefined,
  );
  if ('problems' in chosen) problems.push(...chosen.problems);

  const timeZone = readServerTimeZone(trimmed(env.ALFAVIEW_TIME_ZONE));
  if (timeZone === undefined) {
    problems.push(
      'ALFAVIEW_TIME_ZONE is not a valid time zone. Use an IANA name such as America/New_York, or leave it empty for Europe/Berlin.',
    );
  }

  // The problem of readPersonalDataMode names the valid values, never the given one.
  const personalData = readPersonalDataMode(
    trimmed(env.ALFAVIEW_PERSONAL_DATA),
    'ALFAVIEW_PERSONAL_DATA',
  );
  if ('problem' in personalData) problems.push(personalData.problem);

  if (trimmed(env.NODE_TLS_REJECT_UNAUTHORIZED) === '0') {
    problems.push(
      'NODE_TLS_REJECT_UNAUTHORIZED is 0, which turns off the certificate check of HTTPS. The server does not send the API key without that check. Remove the variable from the environment of the MCP client.',
    );
  }

  if (
    problems.length > 0 ||
    baseUrl === undefined ||
    'problem' in level ||
    'problems' in chosen ||
    timeZone === undefined ||
    'problem' in personalData
  ) {
    throw new ConfigError(problems);
  }
  return {
    companyId: trimmed(env.ALFAVIEW_COMPANY_ID),
    clientId: trimmed(env.ALFAVIEW_CLIENT_ID),
    apiKey: trimmed(env.ALFAVIEW_API_KEY),
    baseUrl,
    level: level.level,
    tools: chosen.tools,
    timeZone,
    personalData: personalData.mode,
  };
}
