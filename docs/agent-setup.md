# Set up the alfaview MCP server with an AI agent

This page is for an AI agent that sets up the alfaview MCP server for a person on this computer.
Do the steps in order. Check the result of each step before you start the next step.

## Rules

- Never ask the person for the API key in the chat. The AI provider gets each message. The person
  types the key into the settings dialog of the plugin, the masked prompt (`read -s`), the file or
  the variables of step 3.
- Never write the API key into a file, such as `.mcp.json`, a configuration file of an AI
  assistant or a shell profile. Never give it to a command, such as `--config` of
  `claude plugin install`. Never copy it to the clipboard.
- Never read the API key back. Do not open a file after the person wrote the key into it. Do not
  print the environment. Do not run `claude mcp get`, which shows the key.
- Set the access level `full` only when the person asks for `full`.
- Never turn off the check of TLS certificates. The server does not start when
  `NODE_TLS_REJECT_UNAUTHORIZED` is `0`.
- Propose the lowest access level that does the job of the person: `standard` by default
  ([Access levels](access-levels.md)).

## 1. Check the runtime

Run `node --version`.

Result: the version is 22 or later. Else, tell the person to install Node.js 22 or later, and stop.

## 2. Ask the person

Ask the person once for these values. Do not ask for the API key, which the administration
interface of alfaview shows as the code.

- The AI assistant: Claude Code, Claude Desktop, Cursor or another one.
- The company ID and the client ID of the alfaview API, which the administration interface of
  alfaview shows as the account ID and the alias
  ([how to get your API credentials](https://support.alfaview.com/en/for-it-administration/advanced-configurations/generate-api-credentials/)).
- The access level: `read`, `standard` (the default) or `manage`
  ([The levels](access-levels.md#the-levels)).
- The option Personal data: `include` (the default) or `omit`
  ([Personal data](data-protection.md#personal-data)).
- The time zone, as an IANA name such as `America/New_York`. The default is `Europe/Berlin`.

Result: you have each value of the list.

## 3. Set up the AI assistant

In Claude Code 2.1.271 or later (`claude --version`), install the plugin for the levels `read`,
`standard` and `manage`. Run the two commands of
[Install the plugin](clients.md#install-the-plugin), which hold no key:

```sh
claude plugin marketplace add alfaview/alfaview-for-mcp
claude plugin install alfaview-mcp@alfaview
```

Then the person starts a new Claude Code session and runs
`/plugin configure alfaview-mcp@alfaview`. The person types the values of step 2 and the key into
the dialog. An empty time zone gives `Europe/Berlin`. If `claude mcp list` also shows a manual
entry `alfaview`, propose to the person to remove it. With both entries, each tool can come twice
([The plugin and a manual entry](clients.md#the-plugin-and-a-manual-entry)).

Else, write a manual entry with the values of step 2. This is for the level `full`, an older
Claude Code and the other AI assistants. Name the entry `alfaview` at the level `standard`, and
`alfaview-<level>` at another level ([Server entries](access-levels.md#server-entries)). At
`standard`, the entry has the `ALFAVIEW_TOOLS` of [The server entry](clients.md#the-server-entry).
At another level, it has no `ALFAVIEW_TOOLS`, so that it offers all tools of the level. The one
exception is `full` next to the plugin, when `claude plugin list` shows `alfaview-mcp@alfaview`.
Then the entry `alfaview-full` has only the tools of `full` in `ALFAVIEW_TOOLS`, and its arguments
differ from those of the plugin
([The plugin and a manual entry](clients.md#the-plugin-and-a-manual-entry)). An entry without
`ALFAVIEW_TOOLS` also offers `get_company_statistics`, which works only for a user with the user
permission Manage Company. At `full`, also set `ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS` to the
company ID.

- Claude Code without the plugin: give the person the three commands of
  [Add the server](clients.md#add-the-server). The person runs them in a terminal, in the folder of
  the project. Do not run them yourself: `read -s` waits for the person to type the key. The entry
  then works in this project only. For all projects, add `--scope user` after the name of the entry.
  Never add `--scope project`, because Claude Code then writes the key into `.mcp.json`.
- Claude Desktop: add the entry of [The server entry](clients.md#the-server-entry) to
  `mcpServers` in the file of [Set up Claude Desktop](clients.md#set-up-claude-desktop). Keep the
  other entries of the file and the placeholder `your-api-key`. The person opens the file with
  **Settings > Developer > Edit Config**, writes the key in place of `your-api-key` and saves the
  file. Then the person quits Claude Desktop and starts it again.
- Cursor: add the entry of [Set up Cursor](clients.md#set-up-cursor) to `~/.cursor/mcp.json`, or
  to `.cursor/mcp.json` for one project, with the other variables of this step. The person sets
  `ALFAVIEW_COMPANY_ID`, `ALFAVIEW_CLIENT_ID` and `ALFAVIEW_API_KEY` in the environment of Cursor.
  Or the entry names a file outside the project in `envFile`, in place of these three lines
  ([Keep the key in a file](clients.md#keep-the-key-in-a-file)). The person writes the three
  variables into that file, which keeps the key out of the environment of Cursor. Then the person
  quits Cursor and starts it again.
- Another AI assistant: write the server entry in the form of that assistant, with the placeholder
  `your-api-key`. Then continue as for Claude Desktop.

Result: the person says that the key is in its place. You did not see the key.

## 4. Check the setup without the key

The AI assistant uses a new entry only after it starts the server again
([Restart the server](troubleshooting.md#restart-the-server)). If you run in the AI assistant that
you set up, ask the person to do this and to continue this conversation. In Claude Code, the person
runs `claude --continue --debug-file <path>` in the folder of the project. The file `<path>` then
holds the log of the server.

1. The AI assistant shows the server as connected. In Claude Code, run `claude mcp list` in the
   folder of the project: the entry has `✔ Connected`. The entry of the plugin is
   `plugin:alfaview-mcp:alfaview`, and it shows only when its three required settings have a
   value. For the plugin, `claude plugin configure alfaview-mcp@alfaview` shows `set` for
   `company_id`, `client_id` and `api_key`. It shows no value. In Claude Desktop,
   **Connectors** > **Manage connectors** in the menu **Add files, connectors, and more** of the
   chat input lists the entry. In Cursor, **Customize** in the sidebar lists the entry, turned on.
2. In the log of the entry ([Find the log](troubleshooting.md#find-the-log)), read only the lines
   with `alfaview-mcp:`, such as with `grep 'alfaview-mcp:' <path>`. In Claude Desktop, the file
   has the name of the entry, such as `mcp-server-alfaview-manage.log`. If you cannot open the log,
   ask the person for these lines. The first line holds the values of step 2, such as
   `at level standard, time zone Europe/Berlin, personal data include`.
3. Call `find_rooms`. If you set up an AI assistant other than your own, ask the person to ask
   that assistant: "Which alfaview rooms can you see?" The result starts with `Found`, such as
   `Found 3 rooms. Showing 1 to 3.`

Result: each check passes. Else, read [Troubleshooting](troubleshooting.md), and tell the person
what to change in the entry.

## 5. Add the permission rules

Claude Code asks the person before each tool call, unless a rule allows the tool. Allow only the
read tools of [Permission rules of Claude Code](clients.md#permission-rules-of-claude-code) that the
entry offers, because these tools return no credentials. Write each rule with the prefix of the
entry: `mcp__alfaview__find_rooms` for the entry `alfaview`, and
`mcp__plugin_alfaview-mcp_alfaview__find_rooms` for the plugin. Add the rules to
`permissions.allow` in `~/.claude/settings.json`, the settings of the person that no project
shares. Keep the rules that the file has.

Claude Desktop and Cursor ask the person before each tool call. Add no rule there.

Result: in Claude Code, `find_rooms` runs without a question.

## 6. Tell the person

Tell the person the name of the entry, its access level, its time zone and its option Personal
data. Name the tools that the entry offers ([Tools](tools.md)), and the tools that run without a
question. Say where the API key is
([The place of the API key](data-protection.md#the-place-of-the-api-key)):

- Claude Code with the plugin: on macOS, the Keychain. On Linux and Windows,
  `~/.claude/.credentials.json`, in plain text. On Linux, its mode `0600` lets only the person
  read it. On Windows, the access rights of the user folder apply.
- Claude Code without the plugin: `~/.claude.json`, in plain text.
- Claude Desktop: `claude_desktop_config.json`, in plain text.
- Cursor: the environment of Cursor, or the file of `envFile`.

Link [Troubleshooting](troubleshooting.md) for problems.

Result: the person knows the settings, what the server can do now, and where the API key is.
