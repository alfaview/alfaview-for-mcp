# alfaview MCP server

A Model Context Protocol (MCP) server for alfaview rooms, guest links, meetings and attendance.

`@alfaview-integrations/alfaview-for-mcp`

[![npm](https://img.shields.io/npm/v/@alfaview-integrations/alfaview-for-mcp)](https://www.npmjs.com/package/@alfaview-integrations/alfaview-for-mcp) [![License](https://img.shields.io/npm/l/@alfaview-integrations/alfaview-for-mcp)](LICENSE)

## What it does

The server is for the people who prepare appointments and webinars in alfaview, and for the
administrators of the company. Each server entry works with one alfaview company and offers tools
for these jobs:

- Rooms and guests: find rooms, create, change and delete personal guest links, and see who waits
  in a room.
- Meetings: schedule, change and cancel meetings, also recurring meetings.
- Reports: who attended an appointment or a webinar, and the statistics of the company.
- Administration, at the access level `manage`: rooms, room settings, breakout rooms and group
  links, and a view of the users and the room permissions. At `full`, also the delete of rooms and
  users, the invitation of users and the change of room permissions.

The server acts only when the assistant calls a tool. It does not react to an event, such as a new
booking. alfaview sends an email only when the assistant sets `sendEmail` to `true`, and the
server tells the assistant to set it only when you ask for an email.

## Requirements

- Node.js 22 or newer on the computer of the AI assistant, with access to the npm registry.
- An alfaview user with the company ID, the client ID and the API key of the alfaview API
  ([how to get your API credentials](https://support.alfaview.com/en/for-it-administration/advanced-configurations/generate-api-credentials/)).
  The administration interface of alfaview shows them as the account ID, the alias and the code.
  The user needs the room permissions Admin and Join in each room that the assistant works in
  ([The alfaview user and its permissions](docs/configuration.md#the-alfaview-user-and-its-permissions)).
- An AI assistant that starts MCP servers on your computer, such as Claude Code.

## Quick start

Add the server to Claude Code. Run these commands in bash or zsh (on Windows, in Git Bash), in the
folder of your project, with your company ID and client ID. For all your projects, add
`--scope user` after `alfaview`. At `read -s`, paste the API key and press Enter. The shell shows
nothing, and the key stays out of the history file of the shell.

```sh
read -s ALFAVIEW_API_KEY
claude mcp add alfaview \
  --env ALFAVIEW_COMPANY_ID=your-company-id \
  --env ALFAVIEW_CLIENT_ID=your-client-id \
  --env ALFAVIEW_API_KEY="$ALFAVIEW_API_KEY" \
  --env ALFAVIEW_ACCESS_LEVEL=standard \
  -- npx -y @alfaview-integrations/alfaview-for-mcp
unset ALFAVIEW_API_KEY
```

`claude mcp list` in the same folder then shows the server `alfaview` as `✔ Connected`. This does
not check the API key: the server signs in to alfaview only at its first tool call.

In a Claude Code session, ask: "Which alfaview rooms can you see?" The assistant calls
`find_rooms`, and Claude Code asks you to allow the call. For a company with four rooms, the
result starts with `Found 4 rooms. Showing 1 to 4.` and gives the name and the ID of each room.
The log of the server gets the line `alfaview-mcp: tool find_rooms: ok, 2 requests, 19 ms`. In
Claude Code, `claude --debug-file <path>` writes the log to a file
([Find the log](docs/troubleshooting.md#find-the-log) names the place for each client).

Then ask for a job, such as "Create guest links in the webinar room for these 12 registrants,
valid on 7 October from 17:30 to 19:30." The assistant calls `find_rooms`, then
`create_guest_links`, and the answer lists the join URL of each guest. The same request a second
time returns the same links, so each registrant keeps one link.

The command above offers all tools of `standard`, also `get_company_statistics`. That tool needs
the user permission Manage Company. The command of [Set up your AI assistant](docs/clients.md) leaves
it out with `ALFAVIEW_TOOLS`, and adds the time zone and the option Personal data.

An AI assistant that runs commands on your computer, such as Claude Code, can also do the setup.
Give it this request:

```text
Read https://raw.githubusercontent.com/alfaview/alfaview-for-mcp/main/docs/agent-setup.md and set up the alfaview MCP server on this computer.
```

[Set up the alfaview MCP server with an AI agent](docs/agent-setup.md) tells the assistant to ask
you for the IDs and the settings, but not for the API key. You type the key yourself.

## Other clients

Claude Desktop, Cursor and other AI assistants that start MCP servers on your computer read a
server entry from a JSON file. [Set up your AI assistant](docs/clients.md) gives the full entry
and names the clients where the server has run. This short entry offers the same tools as the
command of the quick start:

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
        "ALFAVIEW_ACCESS_LEVEL": "standard"
      }
    }
  }
}
```

- Claude Desktop: the file `claude_desktop_config.json`, which **Settings > Developer > Edit
  Config** opens. Quit Claude Desktop and start it again after a change.
- Cursor: `~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project.
  [Set up Cursor](docs/clients.md#set-up-cursor) gives an entry that reads the key from the
  environment, so that the file does not hold it.

## Access levels

The access level of a server entry decides which tools the server offers. Each level has its own
tools and the tools of the levels before it:

| Level | Tools | For |
| --- | --- | --- |
| `read` | The tools that only read: `find_rooms`, `get_room`, `find_guest_links`, `find_meetings`, `get_meeting`, `find_room_participants`, `get_room_attendance`, `get_guest_link_attendance` and `get_company_statistics`. | A job that reports and changes nothing, for example the attendance after a webinar. |
| `standard` | The tools that write: `regenerate_room_passcode`, `create_guest_links`, `update_guest_link`, `delete_guest_link`, `delete_expired_guest_links`, `create_meeting`, `update_meeting` and `cancel_meeting`. This is the default. | The routine work with guest links and meetings. |
| `manage` | The tools of the account, the rooms, the room settings, the breakout rooms, the group links, the users and the room permissions: `get_account`, `update_own_user`, `create_room`, `update_room`, `get_room_settings`, `update_room_settings`, `create_breakout_room`, `update_breakout_room`, `delete_breakout_room`, `find_group_links`, `create_group_link`, `update_group_link`, `delete_group_link`, `find_users` and `find_room_permissions`. | The administration of rooms, their settings, breakout rooms and group links, and of the profile of the alfaview user of the API key. A view of the users and of who can enter a room. |
| `full` | The tools that cannot be undone or that change who has access to rooms: `add_room_permission`, `update_room_permission`, `remove_room_permission`, `invite_user`, `delete_user` and `delete_room`. | Only the jobs that must delete rooms or users, or give and take away access to rooms. |

The server starts at `full` only when `ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS` holds the company
ID of the entry. Before `delete_room` or `delete_user` deletes, the server asks you to type the
name of the room or the email address of the user. This question needs an AI assistant that can
ask. [Access levels](docs/access-levels.md) explains the guards of `full` and the entries for runs
without a person.

## Configuration

The server reads its settings from the environment variables of its server entry:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ALFAVIEW_COMPANY_ID` | Yes | none | The ID of your alfaview company. The administration interface of alfaview shows it as the account ID. |
| `ALFAVIEW_CLIENT_ID` | Yes | none | The alias of the API key, also called client ID. |
| `ALFAVIEW_API_KEY` | Yes | none | The API key. The administration interface of alfaview shows it as the code. It is a secret. |
| `ALFAVIEW_ACCESS_LEVEL` | No | `standard` | The access level: `read`, `standard`, `manage` or `full`. Set it in each entry. |
| `ALFAVIEW_TOOLS` | No | all tools of the level | A comma list of the tools of the level that the server offers. |
| `ALFAVIEW_TIME_ZONE` | No | `Europe/Berlin` | The time zone of a time without an offset, as an IANA name such as `America/New_York`. |
| `ALFAVIEW_PERSONAL_DATA` | No | `include` | The option Personal data: `include` or `omit`. |

When a value is missing or wrong, the server writes one line for each problem to its log and
stops. [`docs/configuration.md`](docs/configuration.md) describes each setting with its type and
its default.

## Data protection

The server runs on your computer. The server itself sends data only to alfaview. The MCP client
sends every tool argument and every tool result to the AI provider of the client, for example
Anthropic for Claude. When you host the AI assistant yourself, with a model that you host, no AI
provider receives the data.

- Tool results hold personal data, such as the names and email addresses of guests, and
  credentials, such as join URLs and room passcodes.
- The server keeps its sign-in to alfaview in memory and writes nothing to disk. Its log holds no
  personal data and no secret.
- Other people write parts of the results, such as guest names and meeting titles. Such a text
  can hold instructions for the AI assistant, so keep each tool that writes on the permission
  prompt of the assistant.

[`docs/data-protection.md`](docs/data-protection.md) describes the data flow and the protections.
Report a vulnerability as [`SECURITY.md`](SECURITY.md) describes.

### Personal data

A server entry has the option **Personal data**: Include, the default, or Leave out. For Leave
out, set `ALFAVIEW_PERSONAL_DATA` to `omit`. The AI assistant then gets `null` in place of names,
email addresses, meeting titles, agendas, waiting room welcome notes, origins, and the titles,
cities and initials of users. IDs stay, and an ID still leads to a person
([Personal data](docs/data-protection.md#personal-data)).

## Documentation

- [Set up your AI assistant](docs/clients.md): Claude Code, Claude Desktop and Cursor.
- [Set up the alfaview MCP server with an AI agent](docs/agent-setup.md): the steps for an AI agent
  that does the setup.
- [Configuration](docs/configuration.md): each setting and the permissions of the alfaview user.
- [Access levels](docs/access-levels.md): the levels, the guards of `full` and runs without a person.
- [Tools](docs/tools.md): each tool with its parameters, its annotations and its level.
- [Work with appointments and webinars](docs/examples.md): requests and their tool calls.
- [Data protection](docs/data-protection.md): the data flow, the risks and the protections.
- [Limits](docs/limits.md): the limits of the server and of the alfaview API.
- [Troubleshooting](docs/troubleshooting.md): the log, the messages and their fixes.

## Support

- Bugs: [the issues on GitHub](https://github.com/alfaview/alfaview-for-mcp/issues).
- Security: [`SECURITY.md`](SECURITY.md).
- Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md).
- Changes: [`CHANGELOG.md`](CHANGELOG.md).

## Usage and licensing

The server is open source under the MIT License ([`LICENSE`](LICENSE)).

The copyright of the server belongs to alfaview Video Conferencing Systems GmbH & Co. KG.

The MIT License does not cover the alfaview name, the alfaview logo or other brand assets of
alfaview, and the package grants no trademark rights ([`TRADEMARKS.md`](TRADEMARKS.md)).

The server connects to the alfaview service. Usage and licensing of the alfaview service by
alfaview GmbH, Kriegsstr. 100, 76133 Karlsruhe. Registered with the Amtsgericht Mannheim,
HRB 730903. Registered office: Karlsruhe. VAT ID DE318911962.

The [Terms and Conditions](https://alfaview.com/en/terms/) and the
[Privacy Policy](https://alfaview.com/en/privacy/) of alfaview are on alfaview.com.
