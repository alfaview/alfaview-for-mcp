# Access levels

The access level of a server entry decides which tools the server offers. This page explains the
four levels, the guards of the level `full`, and the server entries for the usual jobs.

## The levels

Set the level with `ALFAVIEW_ACCESS_LEVEL`. Each level has its own tools and the tools of the
levels before it. [Tools](tools.md) lists the tools of each level.

| Level | For |
| --- | --- |
| `read` | A job that reports and changes nothing, for example the attendance after a webinar. |
| `standard` | The routine work with guest links and meetings. This is the default. |
| `manage` | The administration of rooms, their settings, breakout rooms and group links, and of the profile of the alfaview user of the API key. A view of the users and of who can enter a room. |
| `full` | Only the jobs that must delete rooms or users, or give and take away access to rooms. |

## The rules at every level

- Set `ALFAVIEW_ACCESS_LEVEL` in each server entry, also to `standard`
  ([How the server reads the values](configuration.md#how-the-server-reads-the-values)).
- `ALFAVIEW_TOOLS` chooses among the tools of the level. A name of a tool above the level stops the
  server at start, and the log line names the level of that tool. So does the name of a tool that
  `update_room_settings` replaces, and the log line names `update_room_settings`.
- The tools that create or change a guest link or a group link refuse a permission group with
  admin rights. The guest, or everyone with the join URL of the group link, could then change and
  delete the room. `update_guest_link` and `update_group_link` also refuse to change a link that
  has such a group, unless the same call gives a group without admin. To give a guest admin
  rights, make the guest link in alfaview.
- The group link tools that write leave the group links of a meeting room alone. For a meeting,
  `get_meeting` gives their join URLs, and `update_meeting` and `cancel_meeting` change the
  meeting.
- Another system can manage a recurring meeting, such as an alfaview add-in of a calendar program.
  At `standard`, `update_meeting` and `cancel_meeting` refuse such a meeting, because that system
  can overwrite a change. At `manage` and `full`, they change it.

## The level full

The level `full` can delete rooms and users for good and change who has access to rooms. The
server starts at `full` only when `ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS` holds the company ID of
the entry, the value of `ALFAVIEW_COMPANY_ID`. Thus a copy of the entry for another company does
not start at `full`.

- Set the variable only in the entry of `full`, never in the shell. At each other level, the
  server does not start while the variable is set.
- The description of each tool of `full` starts with its risk: `Cannot be undone:` for
  `delete_room` and `delete_user`, and `Changes who has access:` for the other tools of the level.
  These other tools tell the model of the assistant to call them only when you asked for it.
- `delete_room` and `delete_user` ask you before they delete
  ([The question before a delete](#the-question-before-a-delete)).
- The tools keep the alfaview user of the API key in control. They do not take away its room
  permission or its admin permission, and they do not delete it. The room permission tools and
  `delete_room` leave meeting rooms alone.
- alfaview always emails the invitation of `invite_user`, so the tool needs `sendEmail` set to
  `true`. It sends no invitation to an email address that a user of the company has.
- The alfaview user of the API key needs the permissions of these tools
  ([The alfaview user and its permissions](configuration.md#the-alfaview-user-and-its-permissions)).
- Keep every tool of `full` on the permission prompt. Read the tool name in each permission prompt
  before you allow a call.
- When a tool of `full` is registered, a second line of the log says so:
  `level full: DANGEROUS tools are registered. They can delete rooms and users for good and change who has access to rooms.`

## The question before a delete

`delete_room` and `delete_user` ask you before they delete. The AI assistant shows the question of
the server (an MCP elicitation): what the tool deletes and what goes with it. To confirm, type the
name of the room, or the email address of the user. The server deletes only when the value
matches. Upper and lower case do not matter. When you say no, close the question or type another
value, nothing is deleted. The server then tells the model of the assistant not to try again
unless you ask.

- The question first gives the facts of the server: the ID, what the delete does, and when
  alfaview created the room. The name of the room, or the name and the email address of the user,
  come last, in quotes. Other people write these texts. So the server escapes in them each quote,
  each character that looks like a double quote, each line break and each hidden character. A name
  cannot pass as a text of the server. With the option Personal data set to Leave out, the
  question names the user by the ID only.
- When this server sent a new name for the room in the last hour, the question says so, with the
  time, also when alfaview refused that name. The AI assistant can rename a room, so read the name
  in the question.
- Room names are not unique. When this server sent the same name for another room in the last
  hour, for example for a new room, the question says so, with the time. A name that differs only
  in case, in its spaces or blank characters, in invisible characters or in fullwidth letters
  counts as the same name. Check the time of the create to tell the two rooms apart.
- The server reads the room or the user again after your answer, so a change in the meantime
  counts.
- No value can confirm a room without a name or a user without an email address, so the server
  deletes neither. Give the room a name first, and delete such a user in alfaview.
- The model of the assistant cannot answer for you. Only the AI assistant sends your answer back,
  with a state that the server signed. The state is valid for 5 minutes and works once.

An AI assistant or a script without MCP elicitation in form mode cannot ask. It gets the parameters
`confirmRoomName` and `confirmEmailAddress` in place of the question, and the model then gives the
name or the address that you named. This guard is weaker, because the model writes the value
itself. Use an AI assistant that can ask at the level `full`.

## Server entries

`ALFAVIEW_ACCESS_LEVEL` and `ALFAVIEW_TOOLS` choose the tools of an entry. Set up these entries:

| Entry | `ALFAVIEW_ACCESS_LEVEL` | `ALFAVIEW_TOOLS` | Key of | Where |
| --- | --- | --- | --- | --- |
| `alfaview` | `standard` | All tools of the level except `get_company_statistics` ([The server entry](clients.md#the-server-entry)) | The dedicated user | Every client that works with rooms, guest links and meetings |
| `alfaview-admin` | `read` | `get_company_statistics` | A user with the user permission Manage Company | Only in the client of an administrator |
| For a run without a person, for example `alfaview-cleanup` | The level of the job: `standard` for the cleanup, `read` for the tagging after a webinar | Only the tools of the job, for example `find_rooms,delete_expired_guest_links` for the cleanup, or `find_rooms,get_room_attendance` for the tagging after a webinar | The dedicated user | Only in the job |

Why these entries:

- `get_company_statistics` needs Manage Company, which the dedicated user does not have. A tool that
  cannot work misleads the assistant.
- A second entry for the same company shows each shared tool twice. Add only the entries that a
  client needs.
- A job that nobody watches gets the tools that it needs and no more. Nobody answers its permission
  prompts, and the server offers only the tools of its level that `ALFAVIEW_TOOLS` names.
- An entry that only reads gets the level `read`. So it gets no tool that writes, also when its
  list of tools changes.

An entry for another level has a name of its own, for example `alfaview-read`, `alfaview-manage`
or `alfaview-full`. It has the three required variables and its level. Such an entry also offers
`get_company_statistics`, which works only for a user with the user permission Manage Company. The
entry of `full` also names the company ID a second time:

```json
{
  "mcpServers": {
    "alfaview-full": {
      "command": "npx",
      "args": ["-y", "@alfaview-integrations/alfaview-for-mcp"],
      "env": {
        "ALFAVIEW_COMPANY_ID": "your-company-id",
        "ALFAVIEW_CLIENT_ID": "your-client-id",
        "ALFAVIEW_API_KEY": "your-api-key",
        "ALFAVIEW_ACCESS_LEVEL": "full",
        "ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS": "your-company-id"
      }
    }
  }
}
```

## Runs without a person

For a run without a person with Claude Code, for example from a scheduler, put the entry into a
file of its own. Set the three required variables in the environment of the job. Claude Code gives
the server its own environment, so the file names only the level, the tools and the option
Personal data. The cleanup needs no names, so its entry leaves them out. The tagging after a
webinar needs the email addresses and keeps `include`.

```json
{
  "mcpServers": {
    "alfaview-cleanup": {
      "command": "npx",
      "args": ["-y", "@alfaview-integrations/alfaview-for-mcp"],
      "env": {
        "ALFAVIEW_ACCESS_LEVEL": "standard",
        "ALFAVIEW_TOOLS": "find_rooms,delete_expired_guest_links",
        "ALFAVIEW_PERSONAL_DATA": "omit"
      }
    }
  }
}
```

```sh
claude -p "Delete the expired guest links with the origin Webinar in the room Webinar Room." \
  --mcp-config /absolute/path/to/alfaview-cleanup.json --strict-mcp-config \
  --allowedTools "mcp__alfaview-cleanup__find_rooms" "mcp__alfaview-cleanup__delete_expired_guest_links"
```

- `--strict-mcp-config` starts no other MCP server in the job.
- `--allowedTools` allows only the tools of the job without a prompt.
- The environment of the job reaches every process that Claude Code starts, the shell tool
  included. Give the job an environment of its own with the three variables.

### A delete without a person

Claude Code tells the server that it can ask, also in `claude -p`. With `claude -p`, nobody can
answer, so Claude Code answers cancel and the server deletes nothing. A job that must delete gives
Claude Code an Elicitation hook with a list of the rooms or users that the operator allows to
delete:

- The hook accepts only a question that names an ID of its list.
- It types the name or the email address that its list holds for that ID, never a value of the
  question. The AI assistant can set the name of a room, and the question shows that name.
- The server compares the typed value with the room or the user that it deletes. So a question for
  a room that is not on the list, but whose name holds an ID of the list, still deletes nothing.

Claude Code gives the hook the question as JSON on standard input, with `mcp_server_name`,
`message` and `requested_schema`. The field of the form is `roomName` or `emailAddress`. The hook
writes its answer to standard output, for example
`{"hookSpecificOutput":{"hookEventName":"Elicitation","action":"accept","content":{"roomName":"Advisory Room"}}}`,
or `"action":"decline"`. Put the hook into the settings of the job:

```json
{
  "hooks": {
    "Elicitation": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/hook.mjs", "timeout": 30 }] }]
  }
}
```

## Related pages

- [Configuration](configuration.md): the variables of a server entry and the permissions of the
  alfaview user.
- [Tools](tools.md): the tools of each level.
- [Set up your AI assistant](clients.md): the server entry in Claude Code, Claude Desktop and Cursor.
