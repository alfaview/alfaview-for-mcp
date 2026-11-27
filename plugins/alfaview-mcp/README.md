# alfaview plugin for Claude Code

The plugin `alfaview-mcp` adds the alfaview MCP server and the skill `alfaview-meetings` to
Claude Code.

## What the plugin holds

- The server `alfaview`. Claude Code starts `@alfaview-integrations/alfaview-for-mcp` with `npx`,
  in the version of the plugin. The server works with the rooms, guest links, meetings and
  attendance of one alfaview company.
- The skill `alfaview-meetings`. It tells Claude the order of the tool calls, when to ask you, and
  the form of the answer. It covers guest links of bookings and webinars, meetings, attendance
  reports, the cleanup of old guest links and room settings.

## Before you start

- Claude Code 2.1.271 or later.
- Node.js 22 or later on your computer, with access to the npm registry.
- The company ID, the client ID and the API key of a dedicated alfaview user
  ([The alfaview user and its permissions](https://github.com/alfaview/alfaview-for-mcp/blob/main/docs/configuration.md#the-alfaview-user-and-its-permissions)).

## Install

Run these commands in your shell:

```sh
claude plugin marketplace add alfaview/alfaview-for-mcp
claude plugin install alfaview-mcp@alfaview
```

- The install is for you, in all your projects. For a different scope, add an option to the
  second command:
  - `--scope local`: for you, in this project only.
  - `--scope project`: for everyone who works in the repository, through its file
    `.claude/settings.json`. Each person installs the plugin and enters an API key of their own.
- Start a new session, or run `/reload-plugins` in an open session.
- Run `/plugin configure alfaview-mcp@alfaview` in the session, and enter the company ID, the
  client ID and the API key. Do not give the API key with `--config` on the command line, because
  the shell keeps it in its history.
- Start a new session. Claude Code starts the server only when the three required settings have a
  value.
- To change the settings later, run `/plugin` in a session, open `alfaview-mcp` on the tab
  Installed, and select Configure options. Then start a new session.

## Settings

| Setting | Variable of the server | Value |
| --- | --- | --- |
| Company ID | `ALFAVIEW_COMPANY_ID` | Required. |
| Client ID | `ALFAVIEW_CLIENT_ID` | Required. |
| API key | `ALFAVIEW_API_KEY` | Required. |
| Access level | `ALFAVIEW_ACCESS_LEVEL` | `read`, `standard` or `manage`. The default is `standard`. |
| Personal data | `ALFAVIEW_PERSONAL_DATA` | `include` or `omit`. The default is `include`. |
| Time zone | `ALFAVIEW_TIME_ZONE` | An IANA name, such as America/New_York. Empty: Europe/Berlin. |

- Claude Code keeps the API key in its credential store, not in `settings.json`. On macOS, this is
  the Keychain. On Linux and Windows, it is the file `~/.claude/.credentials.json`, which holds the
  key in plain text. On Linux, its mode `0600` lets only your user read it. On Windows, the access
  rights of your user folder apply
  ([The place of the API key](https://github.com/alfaview/alfaview-for-mcp/blob/main/docs/data-protection.md#the-place-of-the-api-key)).
  Claude Code keeps the other settings under `pluginConfigs` in your `settings.json`
  ([Where values are stored](https://code.claude.com/docs/en/plugins/manifest-reference#where-values-are-stored)).
- The server offers all tools of the access level
  ([Configuration](https://github.com/alfaview/alfaview-for-mcp/blob/main/docs/configuration.md)).
  At each level, this includes `get_company_statistics`, which needs the user permission Manage
  Company of the alfaview user.
- The plugin sets each variable of the server. Thus `ALFAVIEW_TOOLS` or another variable in the
  environment of Claude Code does not change the server of the plugin.
- The plugin does not offer the level `full`, which can delete rooms and users for good. That level
  needs a manual server entry with a confirmation
  ([The level full](https://github.com/alfaview/alfaview-for-mcp/blob/main/docs/access-levels.md#the-level-full)).
  Next to the plugin, that entry names only the tools of `full` in `ALFAVIEW_TOOLS`
  ([The plugin and a manual entry](https://github.com/alfaview/alfaview-for-mcp/blob/main/docs/clients.md#the-plugin-and-a-manual-entry)).

## Tool names and permission rules

Claude Code shows the tools of the plugin as `mcp__plugin_alfaview-mcp_alfaview__<tool>`, for
example `mcp__plugin_alfaview-mcp_alfaview__find_rooms`.

- Claude Code asks before each tool call, unless a permission rule allows the tool. Write the rules
  with these names
  ([Permission rules of Claude Code](https://github.com/alfaview/alfaview-for-mcp/blob/main/docs/clients.md#permission-rules-of-claude-code)).
- A manual server entry, such as `alfaview`, can have another command or other arguments than the
  plugin. Then Claude Code starts both servers, and each tool that both offer comes two times,
  under two names. A manual entry can also run the same command with the same arguments as the
  plugin. Then Claude Code starts only the manual entry. For one company, keep only one of the two
  ([The plugin and a manual entry](https://github.com/alfaview/alfaview-for-mcp/blob/main/docs/clients.md#the-plugin-and-a-manual-entry)).

## Update

By default, Claude Code does not update this plugin automatically. After a new release of the
server, run:

```sh
claude plugin marketplace update alfaview
claude plugin update alfaview-mcp@alfaview
```

Then start a new session, or run `/reload-plugins`. For automatic updates, run `/plugin` in a
session, select the marketplace `alfaview` on the tab Marketplaces, and turn on auto-update.

If you installed the plugin with `--scope local` or `--scope project`, add the same option to
`claude plugin update`.

## Uninstall

```sh
claude plugin uninstall alfaview-mcp@alfaview
claude plugin marketplace remove alfaview
```

- For an install with an option `--scope`, add it to the first command, such as
  `claude plugin uninstall alfaview-mcp@alfaview --scope project`.
- The second command removes the marketplace `alfaview`. To install the plugin again later, leave
  it out.

## More information

- [The alfaview MCP server](https://github.com/alfaview/alfaview-for-mcp#readme)
- [Tools](https://github.com/alfaview/alfaview-for-mcp/blob/main/docs/tools.md)
- [Data protection](https://github.com/alfaview/alfaview-for-mcp/blob/main/docs/data-protection.md)
- [Troubleshooting](https://github.com/alfaview/alfaview-for-mcp/blob/main/docs/troubleshooting.md)

## License

The plugin is open source under the MIT License
([`LICENSE`](https://github.com/alfaview/alfaview-for-mcp/blob/main/LICENSE)).
