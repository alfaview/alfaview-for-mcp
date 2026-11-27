// The Claude Code plugin of this package: the marketplace, the manifest, the files that the plugin
// installs and the setup pages that name the plugin. The plugin runs the published server, so its
// values must agree with the server.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { sep } from 'node:path';
import { describe, it } from 'node:test';
import { PRODUCTION_BASE_URL, readConfig } from '../src/config.ts';
import { ACCESS_LEVELS, DEFAULT_ACCESS_LEVEL } from '../src/levels.ts';
import { SERVER_VERSION, serverInstructions, TOOLS, toolsOfLevel } from '../src/server.ts';
import { DEFAULT_EXPIRED_AT_LEAST_HOURS } from '../src/shared/guestLinks.ts';
import { readPersonalDataMode } from '../src/shared/personalData.ts';
import { MAX_GUESTS_PER_CALL } from '../src/tools/guestLinks.ts';
import { TOOL_CALLS_RATE_LIMITED_MESSAGE } from '../src/tools/tool.ts';
import { DEFAULT_TIME_ZONE } from '../src/values/time.ts';

/** The root of the package, which is also the root of the marketplace. */
const PACKAGE_ROOT = new URL('../', import.meta.url);

/** The folder of the plugin, from the root of the package. */
const PLUGIN_DIR = 'plugins/alfaview-mcp';

/** The folder of the skill, from the root of the package. */
const SKILL_DIR = `${PLUGIN_DIR}/skills/alfaview-meetings`;

/** Returns the text of a file, from its path in the package. */
function readText(path: string): string {
  return readFileSync(new URL(path, PACKAGE_ROOT), 'utf8');
}

/** Returns the parsed JSON of a file, from its path in the package. */
function readJson(path: string): any {
  return JSON.parse(readText(path));
}

/** Returns the parsed `plugin.json` of the plugin. */
function pluginManifest(): any {
  return readJson(`${PLUGIN_DIR}/.claude-plugin/plugin.json`);
}

/** Returns the path of each file under `dir` that ends with `extension`, from the package, sorted. */
function filesUnder(dir: string, extension: string): string[] {
  return readdirSync(new URL(`${dir}/`, PACKAGE_ROOT), { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(extension))
    .map((file) => `${dir}/${file.split(sep).join('/')}`)
    .sort();
}

/** Returns the path in the package of each Markdown file under `dir`, sorted. */
function markdownFiles(dir: string): string[] {
  return filesUnder(dir, '.md');
}

/** Returns a Markdown text without its fenced code blocks, also those in a list item. */
function withoutCodeBlocks(markdown: string): string {
  return markdown.replace(/^ {0,3}```[^\n]*\n[\s\S]*?^ {0,3}```[^\n]*$/gm, '');
}

/** Returns the text of each inline code span of a Markdown text, outside fenced code blocks. */
function codeSpans(markdown: string): string[] {
  return [...withoutCodeBlocks(markdown).matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!);
}

/** Returns the prose of a Markdown text: no code blocks, no code spans and no link targets. */
function prose(markdown: string): string {
  return withoutCodeBlocks(markdown)
    .replace(/`[^`\n]+`/g, ' ')
    .replace(/\]\([^)\s]+\)/g, ']');
}

/** Returns the cells of each body row of the Markdown table with `header`. */
function tableRows(markdown: string, header: readonly string[]): string[][] {
  const lines = markdown.split('\n');
  const start = lines.indexOf(`| ${header.join(' | ')} |`);
  assert.ok(start >= 0, `a table with the header ${header.join(', ')}`);
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(line.slice(1, -1).split('|').map((cell) => cell.trim()));
  }
  return rows;
}

/** Returns a text in lower case, without backticks and with single spaces. */
function normalized(text: string): string {
  return text.replaceAll('`', '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Returns the anchors that GitHub gives the headings of a Markdown text: the text in lower case,
 * without each character other than a letter, a digit, "_", "-" or a space, and each space as "-".
 * A second heading with the same anchor gets "-1", a third "-2".
 */
function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  for (const line of withoutCodeBlocks(markdown).split('\n')) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
    if (heading === undefined) continue;
    const anchor = heading
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
      .replace(/ /g, '-');
    const seen = counts.get(anchor) ?? 0;
    anchors.add(seen === 0 ? anchor : `${anchor}-${seen}`);
    counts.set(anchor, seen + 1);
  }
  return anchors;
}

/** Returns the text of each TypeScript file of the server, joined. */
function sourceText(): string {
  return filesUnder('src', '.ts').map(readText).join('\n');
}

/** Returns the level of a tool of the server. */
function levelOf(name: string): string | undefined {
  return TOOLS.find((tool) => tool.name === name)?.level;
}

const pkg = readJson('package.json');

/** The repository of package.json, such as `owner/name`. */
function repositoryPath(): string {
  const repository = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)\.git$/.exec(pkg.repository.url)?.[1];
  assert.ok(repository !== undefined, pkg.repository.url);
  return repository;
}

/** The two commands of the install, from the repository of package.json and the two manifests. */
function installCommands(): string[] {
  const marketplace = readJson('.claude-plugin/marketplace.json');
  return [
    `claude plugin marketplace add ${repositoryPath()}`,
    `claude plugin install ${pluginManifest().name}@${marketplace.name}`,
  ];
}

/** The two commands of the update, from the names of the two manifests. */
function updateCommands(): string[] {
  const marketplace = readJson('.claude-plugin/marketplace.json');
  return [
    `claude plugin marketplace update ${marketplace.name}`,
    `claude plugin update ${pluginManifest().name}@${marketplace.name}`,
  ];
}

/** The environment that the server of the plugin gets for the option values `values`. */
function pluginEnv(values: Record<string, string>): Record<string, string> {
  const { userConfig, mcpServers } = pluginManifest();
  const env: Record<string, string> = mcpServers.alfaview.env;
  return Object.fromEntries(
    Object.entries(env).map(([name, value]) => [
      name,
      value.replace(/^\$\{user_config\.(\w+)\}$/, (_, key: string) => values[key] ?? userConfig[key].default ?? ''),
    ]),
  );
}

describe('the Claude Code plugin', () => {
  it('the marketplace lists the plugin alfaview-mcp from its folder', () => {
    const marketplace = readJson('.claude-plugin/marketplace.json');
    assert.equal(marketplace.name, 'alfaview');
    assert.equal(marketplace.plugins.length, 1);
    assert.equal(marketplace.plugins[0].name, 'alfaview-mcp');
    assert.equal(marketplace.plugins[0].source, `./${PLUGIN_DIR}`);
    assert.equal(pluginManifest().name, 'alfaview-mcp');
  });

  it('the plugin runs the version of the server', () => {
    const manifest = pluginManifest();
    assert.equal(manifest.version, pkg.version);
    assert.equal(manifest.version, SERVER_VERSION);
    const server = manifest.mcpServers.alfaview;
    assert.equal(server.command, 'npx');
    assert.deepEqual(server.args, ['-y', `@alfaview-integrations/alfaview-for-mcp@${SERVER_VERSION}`]);
  });

  // Claude Code gives its own environment to the server, so a variable that the entry does not set
  // comes from the shell, such as the ALFAVIEW_TOOLS of a manual entry.
  it('the server entry sets each variable that the server reads, from an option or empty', () => {
    const manifest = pluginManifest();
    const config = readText('src/config.ts');
    const variables = [...new Set([...config.matchAll(/ALFAVIEW_[A-Z_]+/g)].map((match) => match[0]))];
    const options = Object.keys(manifest.userConfig);
    const env: Record<string, string> = manifest.mcpServers.alfaview.env;
    assert.deepEqual(Object.keys(env).sort(), variables.sort());
    for (const [name, value] of Object.entries(env)) {
      if (value === '') continue;
      const option = /^\$\{user_config\.([A-Za-z0-9_]+)\}$/.exec(value)?.[1];
      assert.ok(option !== undefined && options.includes(option), `${name}: ${value}`);
    }
    for (const option of options) {
      const uses = Object.values(env).filter((value) => value === `\${user_config.${option}}`);
      assert.equal(uses.length, 1, option);
    }
    assert.deepEqual(env, {
      ALFAVIEW_COMPANY_ID: '${user_config.company_id}',
      ALFAVIEW_CLIENT_ID: '${user_config.client_id}',
      ALFAVIEW_API_KEY: '${user_config.api_key}',
      ALFAVIEW_ACCESS_LEVEL: '${user_config.access_level}',
      ALFAVIEW_PERSONAL_DATA: '${user_config.personal_data}',
      ALFAVIEW_TIME_ZONE: '${user_config.time_zone}',
      ALFAVIEW_TOOLS: '',
      ALFAVIEW_API_BASE_URL: '',
      ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS: '',
    });
  });

  it('the options never offer the level full', () => {
    const { userConfig, mcpServers } = pluginManifest();
    assert.deepEqual(
      userConfig.access_level.options,
      ACCESS_LEVELS.filter((level) => level !== 'full'),
    );
    assert.equal(userConfig.access_level.default, DEFAULT_ACCESS_LEVEL);
    for (const [key, option] of Object.entries<any>(userConfig)) {
      assert.ok(!(option.options ?? []).includes('full'), key);
    }
    assert.equal(mcpServers.alfaview.env.ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS, '');
  });

  it('the API key goes to the credential store', () => {
    const { userConfig } = pluginManifest();
    assert.equal(userConfig.api_key.sensitive, true);
    assert.equal(userConfig.api_key.required, true);
    assert.equal(userConfig.company_id.required, true);
    assert.equal(userConfig.client_id.required, true);
    assert.match(userConfig.api_key.description, /credential store, not in settings\.json/);
    for (const [key, option] of Object.entries<any>(userConfig)) {
      assert.ok(!normalized(option.description).includes('secure storage'), key);
    }
  });

  it('the options of Personal data and of the time zone are those of the server', () => {
    const { personal_data: personalData, time_zone: timeZone } = pluginManifest().userConfig;
    for (const mode of personalData.options) assert.deepEqual(readPersonalDataMode(mode), { mode });
    const refused = readPersonalDataMode('another value');
    assert.ok('problem' in refused);
    const valid = /must be (.+), or empty for (\w+)\.$/.exec(refused.problem);
    assert.ok(valid !== null, refused.problem);
    assert.deepEqual(valid[1]!.split(/, | or /), personalData.options);
    assert.equal(valid[2], personalData.default);
    assert.deepEqual(readPersonalDataMode(''), { mode: personalData.default });
    assert.equal(timeZone.default, '');
    assert.ok(timeZone.description.includes(`Empty: ${DEFAULT_TIME_ZONE}`), timeZone.description);
  });

  it('the server of the plugin offers every tool of its level, whatever the shell exports', () => {
    const { userConfig } = pluginManifest();
    const shell = {
      ALFAVIEW_ACCESS_LEVEL: 'full',
      ALFAVIEW_TOOLS: 'find_rooms',
      ALFAVIEW_API_BASE_URL: 'https://example.com',
      ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS: 'company',
      ALFAVIEW_TIME_ZONE: 'Asia/Tokyo',
      ALFAVIEW_PERSONAL_DATA: 'omit',
    };
    for (const level of userConfig.access_level.options) {
      const env = pluginEnv({ company_id: 'company', client_id: 'client', api_key: 'key', access_level: level });
      const config = readConfig({ ...shell, ...env }, TOOLS);
      assert.equal(config.level, level);
      assert.deepEqual(config.tools, toolsOfLevel(level).map((tool) => tool.name), level);
      assert.equal(config.baseUrl, PRODUCTION_BASE_URL);
      assert.equal(config.timeZone, DEFAULT_TIME_ZONE);
      assert.equal(config.personalData, userConfig.personal_data.default);
    }
  });

  it('npm does not ship the plugin', () => {
    for (const entry of pkg.files) {
      assert.ok(!entry.startsWith('plugins') && !entry.startsWith('.claude-plugin'), entry);
    }
  });
});

describe('the skill alfaview-meetings', () => {
  it('each tool that a plugin file names is a tool of the server, in a code span', () => {
    const manifest = pluginManifest();
    const options = new Set(Object.keys(manifest.userConfig));
    const tools = new Set(TOOLS.map((tool) => tool.name));
    const entries = ['alfaview', `plugin_${manifest.name}_${Object.keys(manifest.mcpServers)[0]}`];
    let count = 0;
    for (const file of markdownFiles('plugins')) {
      const text = readText(file);
      for (const span of codeSpans(text)) {
        const prefixed = /^mcp__(.+?)__(.+)$/.exec(span);
        if (prefixed !== null) {
          assert.ok(entries.includes(prefixed[1]!), `${file}: ${span}`);
          assert.ok(tools.has(prefixed[2]!) || prefixed[2] === '<tool>', `${file}: ${span}`);
        }
        if (!/^[a-z]+(_[a-z]+)+$/.test(span) || options.has(span)) continue;
        assert.ok(tools.has(span), `${file}: ${span}`);
        count += 1;
      }
      const bare = [...prose(text).matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map((match) => match[0]);
      assert.deepEqual(bare, [], `${file}: names outside a code span`);
    }
    assert.ok(count >= 20, `${count} tool names`);
  });

  it('levels.md lists the tools of each level', () => {
    const rows = tableRows(readText(`${SKILL_DIR}/references/levels.md`), ['Level', 'Tools', 'Entry']);
    assert.equal(rows.length, ACCESS_LEVELS.length);
    for (const level of ACCESS_LEVELS) {
      const row = rows.find((cells) => cells[0] === `\`${level}\``);
      assert.ok(row !== undefined, level);
      const expected = TOOLS.filter((tool) => tool.level === level).map((tool) => tool.name);
      assert.deepEqual(codeSpans(row[1]!), expected, level);
      assert.equal(row[2], level === 'full' ? 'manual entry only' : 'plugin or manual entry', level);
    }
  });

  it('each other level that a plugin file gives a tool is the level of the tool', () => {
    const levels: readonly string[] = ACCESS_LEVELS;
    const deletes = tableRows(readText(`${SKILL_DIR}/references/deletes.md`), ['Tool', 'Level', 'Removes', 'Asks the person']);
    assert.ok(deletes.length >= 8, `${deletes.length} deletes`);
    for (const row of deletes) {
      const [tool, level] = [codeSpans(row[0]!)[0]!, codeSpans(row[1]!)[0]!];
      assert.equal(levelOf(tool), level, tool);
    }
    // "`full` has `delete_room` and `delete_user`" in SKILL.md.
    const skill = readText(`${SKILL_DIR}/SKILL.md`).replace(/\s+/g, ' ');
    const claims = [...skill.matchAll(/`([a-z]+)` has `([a-z_]+)`(?: and `([a-z_]+)`)?/g)];
    assert.ok(claims.length >= 3, `${claims.length} levels in SKILL.md`);
    for (const [, level, ...tools] of claims) {
      assert.ok(levels.includes(level!), level);
      for (const tool of tools.filter((name) => name !== undefined)) assert.equal(levelOf(tool!), level, tool);
    }
    // "At the level `full`, `add_room_permission` gives ..." in a reference.
    for (const file of markdownFiles(SKILL_DIR)) {
      const text = readText(file).replace(/\s+/g, ' ');
      for (const [, level, tool] of text.matchAll(/At the level `([a-z]+)`, `([a-z_]+)`/g)) {
        assert.equal(levelOf(tool!), level, `${file}: ${tool}`);
      }
    }
    // A tool that the plugin offers "at each level" has the first level.
    for (const file of [`${PLUGIN_DIR}/README.md`, `${SKILL_DIR}/references/levels.md`]) {
      const sentences = readText(file)
        .replace(/\s+/g, ' ')
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => /at each level/i.test(sentence));
      assert.ok(sentences.length > 0, `${file}: at each level`);
      for (const sentence of sentences) {
        const tools = codeSpans(sentence).filter((span) => levelOf(span) !== undefined);
        assert.ok(tools.length > 0, sentence);
        for (const tool of tools) assert.equal(levelOf(tool), ACCESS_LEVELS[0], `${file}: ${tool}`);
      }
    }
  });

  it('the table Requests of SKILL.md links each reference file', () => {
    const rows = tableRows(readText(`${SKILL_DIR}/SKILL.md`), ['Request', 'Read', 'Tools, in order']);
    const linked = new Set(rows.flatMap((cells) => [...cells[1]!.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]!)));
    const references = markdownFiles(`${SKILL_DIR}/references`).map((file) => file.slice(SKILL_DIR.length + 1));
    assert.ok(references.length >= 6, `${references.length} references`);
    assert.deepEqual([...linked].sort(), references);
  });

  it('each field and each number that the skill names is one of the server', () => {
    const source = sourceText();
    let count = 0;
    for (const file of markdownFiles(SKILL_DIR)) {
      for (const span of codeSpans(readText(file))) {
        if (!/^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(span)) continue;
        assert.match(source, new RegExp(`\\b${span}\\b`), `${file}: ${span}`);
        count += 1;
      }
    }
    assert.ok(count >= 10, `${count} fields`);
    const invitations = normalized(readText(`${SKILL_DIR}/references/invitations.md`));
    assert.ok(invitations.includes(`send at most ${MAX_GUESTS_PER_CALL} guests in one call`));
    const cleanup = normalized(readText(`${SKILL_DIR}/references/cleanup.md`));
    assert.ok(cleanup.includes(`keeps a link for ${DEFAULT_EXPIRED_AT_LEAST_HOURS} hours after its end`));
    const skill = normalized(readText(`${SKILL_DIR}/SKILL.md`));
    assert.ok(skill.includes('one minute for the limit of the server'));
    assert.match(TOOL_CALLS_RATE_LIMITED_MESSAGE, /Wait a minute/);
  });

  it('the skill has only the allowed front matter', () => {
    const text = readText(`${SKILL_DIR}/SKILL.md`);
    const block = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
    assert.ok(block !== undefined, 'the front matter');
    const fields: Record<string, string> = {};
    for (const line of block.split('\n')) {
      const field = /^([a-z-]+): (\S.*)$/.exec(line);
      assert.ok(field !== null, line);
      fields[field[1]!] = field[2]!;
    }
    assert.deepEqual(Object.keys(fields).sort(), ['compatibility', 'description', 'license', 'name']);
    assert.equal(fields.name, 'alfaview-meetings');
    assert.equal(fields.license, 'MIT');
    assert.ok(fields.description!.length <= 1024, `${fields.description!.length} characters`);
    assert.match(fields.description!, /before the first call of an alfaview tool/);
    assert.ok(text.trimEnd().split('\n').length <= 500);
  });

  it('the skill repeats no text that the client already loads', () => {
    const texts: string[] = [];
    for (const level of ACCESS_LEVELS) {
      const names = toolsOfLevel(level).map((tool) => tool.name);
      for (const mode of ['include', 'omit'] as const) {
        texts.push(serverInstructions('Europe/Berlin', names, mode));
      }
    }
    for (const tool of TOOLS) {
      texts.push(tool.description);
      if (tool.descriptionWithoutPersonalData !== undefined) texts.push(tool.descriptionWithoutPersonalData);
    }
    const sentences = new Set(
      texts
        .flatMap((text) => text.split(/(?<=[.:!?])\s+|\n/))
        .map((sentence) => normalized(sentence.replace(/^\s*-\s+/, '')))
        .filter((sentence) => sentence.length >= 40),
    );
    assert.ok(sentences.size > 50, `${sentences.size} sentences`);
    for (const file of markdownFiles(SKILL_DIR)) {
      const text = normalized(readText(file));
      for (const sentence of sentences) assert.ok(!text.includes(sentence), `${file}: ${sentence}`);
    }
  });

  // The install copies only the folder of the plugin. So a relative link stays in that folder, and
  // a link to a page of the package names the branch main of its GitHub repository.
  it('each link of a plugin file names a file and a heading that exist', () => {
    const root = new URL(`${PLUGIN_DIR}/`, PACKAGE_ROOT).href;
    const repository = `https://github.com/${repositoryPath()}`;
    const branch = `${repository}/blob/main/`;
    let relative = 0;
    let absolute = 0;
    for (const file of markdownFiles(PLUGIN_DIR)) {
      const base = new URL(file, PACKAGE_ROOT);
      for (const [, target] of withoutCodeBlocks(readText(file)).matchAll(/\]\(([^)\s]+)\)/g)) {
        const [path, anchor] = target!.split('#') as [string, string | undefined];
        let resolved: URL;
        if (path === repository) {
          assert.ok(anchor === undefined || anchor === 'readme', `${file}: ${target}`);
          continue;
        } else if (path.startsWith(branch)) {
          resolved = new URL(path.slice(branch.length), PACKAGE_ROOT);
          absolute += 1;
        } else if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
          assert.ok(!path.startsWith(`${repository}/`), `${file}: ${target} names no file of the branch main`);
          continue;
        } else {
          resolved = new URL(path, base);
          assert.ok(resolved.href.startsWith(root), `${file}: ${target}`);
          relative += 1;
        }
        assert.ok(existsSync(resolved), `${file}: ${target}`);
        if (anchor === undefined) continue;
        assert.ok(resolved.pathname.endsWith('.md'), `${file}: ${target}`);
        assert.ok(headingAnchors(readFileSync(resolved, 'utf8')).has(anchor), `${file}: ${target}`);
      }
    }
    assert.ok(relative >= 6, `${relative} relative links`);
    assert.ok(absolute >= 10, `${absolute} links to the GitHub repository`);
  });
});

describe('the docs of the plugin', () => {
  it('docs/clients.md shows the rules of both entries', () => {
    const text = readText('docs/clients.md');
    const prefix = `mcp__plugin_${pluginManifest().name}_${Object.keys(pluginManifest().mcpServers)[0]}__`;
    assert.equal(prefix, 'mcp__plugin_alfaview-mcp_alfaview__');
    for (const part of ['mcp__alfaview__', prefix, ...installCommands()]) assert.ok(text.includes(part), part);
    assert.ok(normalized(text).includes('keep only one of the two'), 'the advice to keep one entry');
    const tools = new Set(TOOLS.map((tool) => tool.name));
    const rules = [...text.matchAll(/\bmcp__plugin_alfaview-mcp_alfaview__([a-z_]+)/g)].map((match) => match[1]!);
    assert.ok(rules.length >= 5, `${rules.length} rules of the plugin`);
    for (const name of rules) assert.ok(tools.has(name), name);
  });

  it('docs/agent-setup.md and the README of the plugin give the install commands', () => {
    for (const file of ['docs/agent-setup.md', `${PLUGIN_DIR}/README.md`]) {
      const text = readText(file);
      for (const command of installCommands()) assert.ok(text.includes(command), `${file}: ${command}`);
    }
  });

  it('docs/clients.md and the README of the plugin give the update commands', () => {
    for (const file of ['docs/clients.md', `${PLUGIN_DIR}/README.md`]) {
      const text = readText(file);
      for (const command of updateCommands()) assert.ok(text.includes(command), `${file}: ${command}`);
    }
  });

  it('an entry of the level full next to the plugin names only the tools of full', () => {
    const full = TOOLS.filter((tool) => tool.level === 'full').map((tool) => tool.name);
    assert.ok(full.length > 0);
    const clients = readText('docs/clients.md');
    assert.ok(clients.includes(`\`${full.join(',')}\``), 'the tools of full in docs/clients.md');
    const setup = readText('docs/agent-setup.md');
    assert.ok(
      normalized(setup).includes('the entry alfaview-full has only the tools of full in alfaview_tools'),
      'the rule of the entry alfaview-full in docs/agent-setup.md',
    );
    assert.ok(setup.includes('(clients.md#the-plugin-and-a-manual-entry)'), 'the link to the rule');
  });

  it('each page names the credential store of the plugin for each system', () => {
    const pages = ['docs/clients.md', 'docs/agent-setup.md', 'docs/data-protection.md', `${PLUGIN_DIR}/README.md`];
    for (const file of pages) {
      const text = readText(file);
      for (const part of ['Keychain', '~/.claude/.credentials.json', 'plain text', '0600']) {
        assert.ok(text.includes(part), `${file}: ${part}`);
      }
      assert.ok(!normalized(text).includes('secure storage'), `${file}: secure storage`);
      assert.ok(!normalized(text).includes('only your user can read'), `${file}: only your user can read`);
    }
  });
});
