# Set up your AI assistant

Add the server to your AI assistant, so that the assistant can call the tools of the server.

The server has run in Claude Code. The server has not run in Claude Desktop or Cursor yet.

## Before you start

- Node.js 22 or newer on the computer of the AI assistant, with access to the npm registry.
- The company ID, the client ID and the API key of a dedicated alfaview user. The administration
  interface of alfaview shows them as the account ID, the alias and the code
  ([The alfaview user and its permissions](configuration.md#the-alfaview-user-and-its-permissions)).

## The server entry

An AI assistant starts the server from a server entry: a command, its arguments and the
environment variables of the server. The server serves the MCP revision 2026-07-28 and the 2025
revisions.

This is the entry `alfaview` in the form of Claude Desktop:

```json
{
  "mcpServers": {
    "alfaview": {
      "command": "npx",
      "args": ["-y", "@alfaview-integrations/alfaview-for-mcp"],
      "env": {
        "ALFAVIEW_COMPANY_ID": "your-company-id",
        "ALFAVIEW_CLIENT_ID": "your-client-id",
        "ALFAVIEW_API_KEY": "your-api-key",
        "ALFAVIEW_ACCESS_LEVEL": "standard",
        "ALFAVIEW_TIME_ZONE": "Europe/Berlin",
        "ALFAVIEW_PERSONAL_DATA": "include",
        "ALFAVIEW_TOOLS": "find_rooms,get_room,regenerate_room_passcode,find_guest_links,create_guest_links,update_guest_link,delete_guest_link,delete_expired_guest_links,find_meetings,get_meeting,create_meeting,update_meeting,cancel_meeting,find_room_participants,get_room_attendance,get_guest_link_attendance"
      }
    }
  }
}
```

- `npx -y` installs the package at the first start, without a question. At each start, `npx`
  looks on npm for a newer version of the package and installs it. To stay on one version, write
  `@alfaview-integrations/alfaview-for-mcp@<version>` in `args`.
- Keep `ALFAVIEW_ACCESS_LEVEL` in the entry, also for `standard`, the default
  ([How the server reads the values](configuration.md#how-the-server-reads-the-values)).
- `ALFAVIEW_TOOLS` names all tools of the level `standard` except `get_company_statistics`, which
  needs the user permission Manage Company ([Server entries](access-levels.md#server-entries)). A
  short list also gives each conversation fewer tool definitions.
- `ALFAVIEW_TIME_ZONE` and `ALFAVIEW_PERSONAL_DATA` are optional. Set your own time zone, or leave
  a line out for its default ([Configuration](configuration.md)).

Another AI assistant that starts MCP servers on your computer takes the same command, arguments
and variables in its own form.

## Set up Claude Code

### Install the plugin

The plugin `alfaview-mcp` runs the server and adds the skill `alfaview-meetings`. The skill gives
Claude the order of the tool calls, when to ask you, and the form of the answer. It covers guest
links of bookings and webinars, meetings, attendance reports, the cleanup of old guest links and
room settings. The plugin needs Claude Code 2.1.271 or later (`claude --version`).

1. Add the marketplace and install the plugin:

   ```sh
   claude plugin marketplace add alfaview/alfaview-for-mcp
   claude plugin install alfaview-mcp@alfaview
   ```

2. Start Claude Code, and run `/plugin configure alfaview-mcp@alfaview`. Enter the company ID, the
   client ID and the API key. Do not give the API key with `--config` on the command line, because
   the shell keeps it in its history. The other settings have defaults: the access level
   `standard`, the option Personal data `include` and the time zone, empty for Europe/Berlin.
3. Start a new session. Claude Code starts the server only when the three required settings have a
   value.

- Claude Code keeps the API key in its credential store, not in `settings.json`. On macOS, this is
  the Keychain. On Linux and Windows, it is the file `~/.claude/.credentials.json`, which holds the
  key in plain text. On Linux, its mode `0600` lets only your user read it. On Windows, the access
  rights of your user folder apply
  ([The place of the API key](data-protection.md#the-place-of-the-api-key)). Claude Code keeps the
  other settings in `~/.claude/settings.json`.
- The plugin offers all tools of its access level: `read`, `standard` or `manage`. So it also
  offers `get_company_statistics`, which needs the user permission Manage Company
  ([Server entries](access-levels.md#server-entries)).
- The plugin sets each variable of the server. Thus `ALFAVIEW_TOOLS` or another variable in the
  environment of Claude Code does not change the server of the plugin.
- For the level `full`, or for a list of tools in `ALFAVIEW_TOOLS`, add the server by hand
  ([Add the server](#add-the-server)).
- The plugin runs the version of the server that it names. By default, Claude Code does not update
  the plugin automatically. After a new release of the server, run these commands, then start a
  new session or run `/reload-plugins`:

  ```sh
  claude plugin marketplace update alfaview
  claude plugin update alfaview-mcp@alfaview
  ```

  For automatic updates, run `/plugin` in a session, select the marketplace `alfaview` on the tab
  Marketplaces, and turn on auto-update.

### The plugin and a manual entry

The plugin and a manual entry can serve the same company:

- When the command or its arguments differ, Claude Code starts both servers. Each tool that both
  offer then comes two times, under two names.
- A manual entry can run the same command with the same arguments as the plugin, such as
  `npx -y @alfaview-integrations/alfaview-for-mcp@<version>` with the version of the plugin. Then
  Claude Code starts only the manual entry. The settings of the plugin have no effect, also when
  the variables of the manual entry are different.

So for one company, keep only one of the two: the plugin or the manual entry `alfaview`.

For the level `full` next to the plugin, add the entry `alfaview-full` of
[Server entries](access-levels.md#server-entries). Give it only the tools of `full` in
`ALFAVIEW_TOOLS`:
`add_room_permission,update_room_permission,remove_room_permission,invite_user,delete_user,delete_room`.
Its arguments must differ from those of the plugin. For example, do not pin it to the version of
the plugin. With the same arguments, Claude Code starts only the entry `alfaview-full`, and only
the tools of `full` stay.

### Add the server

Run these commands in bash or zsh (on Windows, in Git Bash), in the folder of your project.

1. Read the key with `read -s`, so that it stays out of the history file of your shell:

   ```sh
   read -s ALFAVIEW_API_KEY
   ```

   Type or paste the key, then press Enter. The shell shows nothing.

2. Add the server with `claude mcp add`:

   ```sh
   claude mcp add alfaview \
     --env ALFAVIEW_COMPANY_ID=your-company-id \
     --env ALFAVIEW_CLIENT_ID=your-client-id \
     --env ALFAVIEW_API_KEY="$ALFAVIEW_API_KEY" \
     --env ALFAVIEW_ACCESS_LEVEL=standard \
     --env ALFAVIEW_TIME_ZONE=Europe/Berlin \
     --env ALFAVIEW_PERSONAL_DATA=include \
     --env ALFAVIEW_TOOLS=find_rooms,get_room,regenerate_room_passcode,find_guest_links,create_guest_links,update_guest_link,delete_guest_link,delete_expired_guest_links,find_meetings,get_meeting,create_meeting,update_meeting,cancel_meeting,find_room_participants,get_room_attendance,get_guest_link_attendance \
     -- npx -y @alfaview-integrations/alfaview-for-mcp
   ```

   Keep the server name `alfaview` before the first `--env`. Directly after `--env`, Claude Code
   reads the name as another variable and refuses it.

3. Remove the key from the shell:

   ```sh
   unset ALFAVIEW_API_KEY
   ```

`--scope` chooses where Claude Code keeps the entry:

| Scope | Where | Covers |
| --- | --- | --- |
| `local`, the default | `~/.claude.json` | This project |
| `user` | `~/.claude.json` | All your projects |
| `project` | `.mcp.json` in the project, which you share through version control | Everyone who works in the project |

The scopes `local` and `user` keep the key in plain text in `~/.claude.json`.

### Share the entry in a project

For a shared `.mcp.json`, name the values as variables, so the file holds no secret. Claude Code
reads `${NAME}` from its own environment in `command`, `args` and `env`:

```json
{
  "mcpServers": {
    "alfaview": {
      "command": "npx",
      "args": ["-y", "@alfaview-integrations/alfaview-for-mcp"],
      "env": {
        "ALFAVIEW_COMPANY_ID": "${ALFAVIEW_COMPANY_ID}",
        "ALFAVIEW_CLIENT_ID": "${ALFAVIEW_CLIENT_ID}",
        "ALFAVIEW_API_KEY": "${ALFAVIEW_API_KEY}",
        "ALFAVIEW_ACCESS_LEVEL": "standard"
      }
    }
  }
}
```

- Add the other variables of [the server entry](#the-server-entry), such as `ALFAVIEW_TOOLS`.
- Claude Code asks before it uses a server of `.mcp.json` for the first time.
- The key must be in the environment of Claude Code. Claude Code gives it to every process that it
  starts, other MCP servers and the shell tool included
  ([The place of the API key](data-protection.md#the-place-of-the-api-key)). The command
  `claude mcp add --env` keeps the key in the entry only.

### Check the setup

- `claude mcp list` starts each server and shows `✔ Connected` or `✘ Failed to connect`. For the
  reason, run `claude --debug-file <path> mcp list` and read the lines with `alfaview-mcp:` in the
  file. The server signs in to alfaview at its first tool call, so this check leaves no session in
  alfaview.
- `claude mcp list` shows the server of the plugin as `plugin:alfaview-mcp:alfaview`, when its
  three required settings have a value.
- `/mcp` in a Claude Code session shows the state of the server and its tools.
- Claude Code shows the tools of the entry `alfaview` as `mcp__alfaview__<tool>`, for example
  `mcp__alfaview__find_rooms`. It shows the tools of the plugin as
  `mcp__plugin_alfaview-mcp_alfaview__<tool>`.

### Permission rules of Claude Code

Claude Code asks before each tool call unless a rule allows the tool. A rule names the tool with
the prefix of its entry: `mcp__<entry>__<tool>` for a manual entry, and
`mcp__plugin_alfaview-mcp_alfaview__<tool>` for the plugin.

Allow only the read tools that return no credentials. A rule in `~/.claude/settings.json` applies
only to you, in all your projects, and suits the plugin at the scope `user`. A rule in
`.claude/settings.json` of a project applies to everyone who works in the project. These are the
rules for the manual entries of [Server entries](access-levels.md#server-entries):

```json
{
  "permissions": {
    "allow": [
      "mcp__alfaview__find_rooms",
      "mcp__alfaview__find_meetings",
      "mcp__alfaview__find_room_participants",
      "mcp__alfaview__get_room_attendance",
      "mcp__alfaview__get_guest_link_attendance",
      "mcp__alfaview-admin__get_company_statistics",
      "mcp__alfaview-manage__get_account",
      "mcp__alfaview-manage__get_room_settings"
    ]
  }
}
```

`get_company_statistics` is the tool of the entry `alfaview-admin`, and `get_account` and
`get_room_settings` are tools of the level `manage`, here in an entry `alfaview-manage`.

These are the same rules for the plugin. At the level `manage`, also allow `get_account` and
`get_room_settings`:

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_alfaview-mcp_alfaview__find_rooms",
      "mcp__plugin_alfaview-mcp_alfaview__find_meetings",
      "mcp__plugin_alfaview-mcp_alfaview__find_room_participants",
      "mcp__plugin_alfaview-mcp_alfaview__get_room_attendance",
      "mcp__plugin_alfaview-mcp_alfaview__get_guest_link_attendance",
      "mcp__plugin_alfaview-mcp_alfaview__get_company_statistics"
    ]
  }
}
```

For each entry:

- Keep these tools on the prompt: `get_room` (passcode), `get_meeting`, `find_guest_links` and
  `find_group_links` (join URLs), `find_users` (the names and email addresses of all users), and
  `find_room_permissions` (who can enter a room).
- Keep every tool that writes on the prompt.
- Never allow a tool of the level `full` without a prompt
  ([The level full](access-levels.md#the-level-full)).

## Set up Claude Desktop

1. Open the configuration file: in Claude Desktop, select **Settings > Developer > Edit Config**.
   The file is `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
   `%APPDATA%\Claude\claude_desktop_config.json` on Windows and
   `~/.config/Claude/claude_desktop_config.json` on Linux.
2. Add [the server entry](#the-server-entry) to the file.
3. Quit Claude Desktop and start it again. It reads the file only at start.

- The file holds the key in plain text. Keep it readable for your user only.
- `npx` comes with Node.js. When Claude Desktop cannot find `npx`, write the absolute path of
  `npx` in `command`. The command `command -v npx` (macOS) or `where npx` (Windows) prints it. On
  Windows, write each backslash of the path twice.
- `npx` starts `node` from the `PATH`. When Node.js is in a folder that Claude Desktop does not
  search, for example with nvm, also set `PATH` in the `env` of the entry, with the folder of
  `node` first, such as `"PATH": "/Users/you/.nvm/versions/node/v22.x/bin:/usr/bin:/bin"`. The
  command `command -v node` (macOS) or `where node` (Windows) prints the path of `node`.

## Set up Cursor

1. Add the entry to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project).
   Cursor reads `${env:NAME}` from its environment, so the file can name the key without holding
   it:

   ```json
   {
     "mcpServers": {
       "alfaview": {
         "type": "stdio",
         "command": "npx",
         "args": ["-y", "@alfaview-integrations/alfaview-for-mcp"],
         "env": {
           "ALFAVIEW_COMPANY_ID": "${env:ALFAVIEW_COMPANY_ID}",
           "ALFAVIEW_CLIENT_ID": "${env:ALFAVIEW_CLIENT_ID}",
           "ALFAVIEW_API_KEY": "${env:ALFAVIEW_API_KEY}",
           "ALFAVIEW_ACCESS_LEVEL": "standard"
         }
       }
     }
   }
   ```

2. Add the other variables of [the server entry](#the-server-entry), such as `ALFAVIEW_TOOLS`.

- Cursor merges both files, and the project file wins for the same server name.
- The variables must be in the environment of Cursor, for example when you start Cursor from a
  shell that exports them. Every process that Cursor starts then gets the key, other MCP servers
  and terminals included ([The place of the API key](data-protection.md#the-place-of-the-api-key)).
- Cursor asks for your approval before each tool call by default.

### Keep the key in a file

In place of the three `${env:...}` lines, the entry can name a file in `envFile`. This keeps the
key out of the environment of Cursor:

```json
{
  "mcpServers": {
    "alfaview": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@alfaview-integrations/alfaview-for-mcp"],
      "envFile": "/absolute/path/to/alfaview.env",
      "env": {
        "ALFAVIEW_ACCESS_LEVEL": "standard"
      }
    }
  }
}
```

The file holds one line `NAME=value` for each of the three values:

```text
ALFAVIEW_COMPANY_ID=your-company-id
ALFAVIEW_CLIENT_ID=your-client-id
ALFAVIEW_API_KEY=your-api-key
```

Keep the file outside the project, readable for your user only.

## Check the result

Ask the AI assistant to find your rooms. The assistant calls `find_rooms`, and the log gets one
line for the call ([Read the log](troubleshooting.md#read-the-log)).

## Next steps

- [Work with appointments and webinars](examples.md): requests for the AI assistant, and the tool
  calls that they start.
- [Access levels](access-levels.md): the entries for other levels and for runs without a person.
- [Data protection](data-protection.md): what leaves your computer, and the option Personal data.
