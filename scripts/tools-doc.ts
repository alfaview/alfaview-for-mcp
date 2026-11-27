// Writes docs/tools.md, the reference of the tools, from the tool definitions of the server: the
// name, the title, the description, the annotations and the parameters of each tool, under the
// lowest access level that has it. Run `npm run docs:tools` after a change of a tool.
// test/toolsDoc.test.ts fails when docs/tools.md differs from the text of toolsDoc.
import { realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ACCESS_LEVELS, levelIncludes, type AccessLevel } from '../src/levels.ts';
import type { PersonalDataMode } from '../src/shared/personalData.ts';
import { TOOLS } from '../src/server.ts';
import { advertised, toolDescription, toolInputSchema, type AnyTool } from '../src/tools/tool.ts';
import { DEFAULT_TIME_ZONE } from '../src/values/time.ts';

/** The page that this script writes. */
export const TOOLS_DOC_PATH = fileURLToPath(new URL('../docs/tools.md', import.meta.url));

/** A node of the JSON Schema that the server advertises for the input of a tool. */
type SchemaNode = {
  type?: string;
  description?: string;
  default?: unknown;
  enum?: readonly unknown[];
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
  required?: readonly string[];
  propertyNames?: SchemaNode;
  additionalProperties?: SchemaNode | boolean;
};

/** One row of the table of the parameters of a tool. */
type ParameterRow = {
  name: string;
  type: string;
  required: boolean;
  default: string;
  description: string;
};

/** The keywords that typeText reads. A schema with another keyword stops the script. */
const KNOWN_KEYWORDS = new Set([
  'type',
  'description',
  'default',
  'enum',
  'format',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'items',
  'properties',
  'required',
  'propertyNames',
  'additionalProperties',
]);

const LEVEL_TEXT: Record<AccessLevel, string> = {
  read: 'The tools that only read.',
  standard: 'The tools that change guest links, meetings and the passcode of a room.',
  manage:
    'The tools of the account, the rooms, the room settings, the breakout rooms, the group links, the users and the room permissions.',
  full: 'The tools that cannot be undone or that change who has access to rooms. The level needs `ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS`.',
};

/** Returns `values` in code spans, joined with commas and `conjunction` before the last one. */
function codeList(values: readonly unknown[], conjunction: 'and' | 'or'): string {
  const spans = values.map((value) => `\`${String(value)}\``);
  if (spans.length <= 1) return spans.join('');
  return `${spans.slice(0, -1).join(', ')} ${conjunction} ${spans.at(-1)}`;
}

/** Returns the range of `low` and `high` in words, such as `1 to 50` or `at most 256`. */
function range(low: number | undefined, high: number | undefined): string | undefined {
  if (low !== undefined && high !== undefined) return `${low} to ${high}`;
  if (low !== undefined) return `at least ${low}`;
  if (high !== undefined) return `at most ${high}`;
  return undefined;
}

/** Stops the script for a keyword that typeText does not read, so no rule of a schema is lost. */
function checkKeywords(node: SchemaNode, where: string): void {
  for (const key of Object.keys(node)) {
    if (!KNOWN_KEYWORDS.has(key)) throw new TypeError(`${where}: the keyword ${key} is not known.`);
  }
}

/** Returns the type of `node` in words, with its values, its length or its range. */
function typeText(node: SchemaNode, where: string): string {
  checkKeywords(node, where);
  if (node.enum !== undefined) return codeList(node.enum, 'or');
  switch (node.type) {
    case 'string': {
      if (node.format === 'uuid') return 'UUID';
      const length = range(node.minLength, node.maxLength);
      return length === undefined ? 'string' : `string of ${length} characters`;
    }
    case 'integer':
    case 'number': {
      const bounds = range(node.minimum, node.maximum);
      return bounds === undefined ? node.type : `${node.type}, ${bounds}`;
    }
    case 'boolean':
      return 'boolean';
    case 'array': {
      if (node.items === undefined) throw new TypeError(`${where}: a list without items.`);
      const items = itemsText(node.items, `${where}[]`);
      const count = range(node.minItems, node.maxItems);
      return count === undefined ? `list of ${items}` : `list of ${count} ${items}`;
    }
    case 'object': {
      if (node.properties !== undefined) return 'object';
      const keys = node.propertyNames?.enum;
      const values = typeof node.additionalProperties === 'object' ? node.additionalProperties.enum : undefined;
      if (keys === undefined || values === undefined) throw new TypeError(`${where}: an object without its keys.`);
      return `object: each key one of ${codeList(keys, 'or')}, each value ${codeList(values, 'or')}`;
    }
    default:
      throw new TypeError(`${where}: the type ${String(node.type)} is not known.`);
  }
}

/** Returns the items of a list in words, such as `objects` or `strings of at most 35 characters`. */
function itemsText(node: SchemaNode, where: string): string {
  checkKeywords(node, where);
  if (node.type === 'object') return 'objects';
  if (node.enum !== undefined) return `values ${codeList(node.enum, 'or')}`;
  if (node.type === 'string' && node.format === 'uuid') return 'UUIDs';
  if (node.type === 'string') {
    const length = range(node.minLength, node.maxLength);
    return length === undefined ? 'strings' : `strings of ${length} characters`;
  }
  return `items of the type ${typeText(node, where)}`;
}

/** Returns the default of a parameter as a code span, or `none`. */
function defaultText(value: unknown): string {
  if (value === undefined) return 'none';
  return `\`${typeof value === 'string' ? value : JSON.stringify(value)}\``;
}

/** Returns a text for a table cell: one line, with each `|` escaped. */
function cell(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replaceAll('|', '\\|');
}

/**
 * Returns the rows of the parameters of `node`, an object schema, and of the objects in it: a key
 * of an object as `parent.key`, a key of the objects of a list as `parent[].key`.
 */
function parameterRows(node: SchemaNode, prefix: string, where: string): ParameterRow[] {
  checkKeywords(node, where);
  const required = new Set(node.required ?? []);
  const rows: ParameterRow[] = [];
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    const name = `${prefix}${key}`;
    rows.push({
      name,
      type: typeText(child, `${where}.${key}`),
      required: required.has(key),
      default: defaultText(child.default),
      description: child.description ?? '',
    });
    if (child.type === 'object' && child.properties !== undefined) {
      rows.push(...parameterRows(child, `${name}.`, `${where}.${key}`));
    }
    if (child.type === 'array' && child.items?.type === 'object') {
      rows.push(...parameterRows(child.items, `${name}[].`, `${where}.${key}[]`));
    }
  }
  return rows;
}

/** Returns the rows of the parameters of `tool` as the server advertises them in `mode`. */
function toolRows(tool: AnyTool, mode: PersonalDataMode): ParameterRow[] {
  const schema = advertised(toolInputSchema(tool, mode), DEFAULT_TIME_ZONE);
  const json = schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' }) as SchemaNode;
  return parameterRows(json, '', tool.name);
}

/** Returns the lines of the table of `rows`. */
function parameterTable(rows: readonly ParameterRow[]): string[] {
  return [
    '| Parameter | Type | Required | Default | Description |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(
      (row) =>
        `| \`${row.name}\` | ${cell(row.type)} | ${row.required ? 'yes' : 'no'} | ${cell(row.default)} | ${cell(row.description)} |`,
    ),
  ];
}

/** Returns the annotations of `tool` as code spans, such as `` `readOnlyHint: true` ``. */
function annotationText(tool: AnyTool): string {
  const entries = Object.entries(tool.annotations).map(([key, value]) => `\`${key}: ${String(value)}\``);
  return entries.join(', ');
}

/**
 * Returns the section of `tool`: its name as the heading, its description, its title and
 * annotations, and its parameters. A description or a parameter text that differs with the option
 * Personal data set to Leave out follows the text of Include. Leave out changes only texts, so a
 * parameter whose type, place, default or need differs stops the script.
 */
function toolSection(tool: AnyTool): string[] {
  const lines = [`### ${tool.name}`, '', cell(toolDescription(tool, 'include')), ''];
  const omitDescription = toolDescription(tool, 'omit');
  if (omitDescription !== toolDescription(tool, 'include')) {
    lines.push(`With the option Personal data set to Leave out: ${cell(omitDescription)}`, '');
  }
  lines.push(`- Title: ${cell(tool.title)}`, `- Annotations: ${annotationText(tool)}`, '');
  const rows = toolRows(tool, 'include');
  const omitRows = toolRows(tool, 'omit');
  if (rows.length === 0) {
    lines.push('The tool has no parameters.', '');
  } else {
    lines.push(...parameterTable(rows), '');
  }
  const changed: ParameterRow[] = [];
  for (const [index, row] of rows.entries()) {
    const other = omitRows[index];
    const same =
      other !== undefined &&
      other.name === row.name &&
      other.type === row.type &&
      other.required === row.required &&
      other.default === row.default;
    if (!same || omitRows.length !== rows.length) {
      throw new TypeError(`${tool.name}: the parameter ${row.name} differs with Leave out in more than its text.`);
    }
    if (other.description !== row.description) changed.push(other);
  }
  for (const row of changed) {
    lines.push(`With the option Personal data set to Leave out, \`${row.name}\` reads: ${cell(row.description)}`, '');
  }
  return lines;
}

/** Returns the table of the number of tools of each level and of each server entry at that level. */
function countTable(): string[] {
  const lines = ['| Level | Tools of the level | Tools of a server entry at the level |', '| --- | --- | --- |'];
  for (const level of ACCESS_LEVELS) {
    const own = TOOLS.filter((tool) => tool.level === level).length;
    const entry = TOOLS.filter((tool) => levelIncludes(level, tool.level)).length;
    lines.push(`| \`${level}\` | ${own} | ${entry} |`);
  }
  return lines;
}

/** Returns the text of docs/tools.md. */
export function toolsDoc(): string {
  const lines = [
    '# Tools',
    '',
    'This page lists each tool of the server with its parameters. The script `scripts/tools-doc.ts` writes it from the tool definitions in `src/tools/`. [Limits](limits.md) gives the limits of the tools, and [Troubleshooting](troubleshooting.md) the problems of a tool call and of its result.',
    '',
    `The server has ${TOOLS.length} tools. A server entry gets the tools of its access level and of the levels before it ([Access levels](access-levels.md)). \`ALFAVIEW_TOOLS\` can leave out tools of the level ([Configuration](configuration.md)).`,
    '',
    ...countTable(),
    '',
    'The parameter texts show the default time zone `Europe/Berlin`. A server entry with `ALFAVIEW_TIME_ZONE` shows its own time zone there. With the option Personal data set to Leave out, some descriptions and parameter texts differ, and the section gives both.',
    '',
    'Each tool gives the client its annotations (MCP tool annotations). `readOnlyHint: true` marks a tool that only reads, and `destructiveHint: true` a tool that can overwrite or delete. `idempotentHint: true` marks a tool whose repeat with the same input changes nothing more. `openWorldHint: true` marks a tool that works with a system outside the server, here alfaview.',
    '',
    'Each tool also gives the client the shape of its result (an MCP output schema): its keys with their types, and which keys can be null. A client can check each result with it.',
    '',
  ];
  for (const level of ACCESS_LEVELS) {
    lines.push(`## Level ${level}`, '', LEVEL_TEXT[level], '');
    for (const tool of TOOLS.filter((item) => item.level === level)) lines.push(...toolSection(tool));
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** Whether node started this file, not a module that imports it. */
function startedAsScript(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedAsScript()) writeFileSync(TOOLS_DOC_PATH, toolsDoc());
