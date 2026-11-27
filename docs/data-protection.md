# Data protection

This page explains which data leaves your computer when an AI assistant uses the server, and what
the server does to keep that data small. Cover this data in the data processing agreement and the
records of processing of your company.

## What leaves your computer

The server runs on your computer and sends data only to alfaview. The MCP client sends every tool
argument and every tool result to the AI provider of the client, for example Anthropic for Claude.
The client sends them because the model reads them. When you host the AI assistant and its model
yourself, no AI provider receives the data.

### Personal data in the results

Tool results hold the names and email addresses of guests. They hold the names of attendees and of
the people in a room. They also hold the times when people joined and left, meeting titles and
agendas, and waiting room welcome notes.

- At the level `manage`, `get_account` and `update_own_user` also hold data of the alfaview user
  of the API key: its name, email address, title, city and initials.
- `find_users` holds the names, titles and email addresses of all users of the company, and
  `find_room_permissions` the names of the users who can enter a room.
- At the level `full`, `invite_user` holds the name, title and email address of the new user.

With the option Personal data set to Leave out, the results hold fewer of these values
([Personal data](#personal-data)).

### Credentials in the results

Tool results can hold credentials:

- Every guest link, group link and meeting join URL holds an access key. Whoever has the URL can
  join as that guest or group.
- `create_guest_links` and `create_meeting` return the join URLs that they make, and `get_meeting`
  returns the join URLs of the meeting. `find_guest_links` with `includeJoinUrls` returns the join
  URL of each link.
- The room passcode comes from `get_room` with `includePasscode` and from
  `regenerate_room_passcode`.
- At the level `manage`, `create_group_link` returns the join URL of the new group link, and
  `find_group_links` with `includeJoinUrls` returns the join URL of each link.

## What the server does to keep the data small

- Each tool result holds what its task needs. The passcode comes only with `includePasscode`. The
  join URLs of `find_guest_links` and `find_group_links` come only with `includeJoinUrls`.
  `update_guest_link`, `update_meeting`, `cancel_meeting` and `update_group_link` answer without
  join URLs.
- The server keeps its sign-in to alfaview in memory and writes nothing to disk. Its log holds one
  line for each tool call, with the tool name, the outcome, the number of requests and the
  duration. The log holds no personal data and no secret.
- The server tells the AI assistant to use personal data only for what you asked. It also tells
  the assistant to treat text from alfaview as data, never as instructions.

## The risks and the protections

Other people write parts of the tool results: guest names, meeting titles, agendas and welcome
notes. Such a text can hold instructions for the AI assistant.

- The create tools can give any email address access to a room.
- Such a text can ask the assistant to show or send the credentials of
  [Credentials in the results](#credentials-in-the-results).
- At the level `manage`, such a text can also ask the assistant to create or change a room, the
  settings of a room or the profile of the alfaview user of the API key. It can also ask the
  assistant to create, change or delete breakout rooms and group links.
- At the level `full`, such a text can also ask the assistant to delete a room or a user for good,
  to invite a person as a user, or to give or take away access to a room.

These three protections do not depend on the model of the assistant:

1. The permissions of the alfaview user of the API key
   ([The alfaview user and its permissions](configuration.md#the-alfaview-user-and-its-permissions)).
2. The permission prompt of the AI assistant. Allow only the tools of the list in
   [Permission rules of Claude Code](clients.md#permission-rules-of-claude-code) without a prompt.
   Keep every other tool on the prompt.
3. `ALFAVIEW_ACCESS_LEVEL` and `ALFAVIEW_TOOLS`. The server offers only the tools of its level that
   `ALFAVIEW_TOOLS` names, and an AI assistant can call no other tool
   ([Access levels](access-levels.md)).

The level `full` adds the guards of [The level full](access-levels.md#the-level-full): the company
ID as a confirmation at start, the risk at the start of each tool description, and the question
before a delete, which the model cannot answer for you. An AI assistant that cannot ask gets a
weaker guard ([The question before a delete](access-levels.md#the-question-before-a-delete)).

## Personal data

A server entry has the option Personal data: Include, the default, or Leave out. Set
`ALFAVIEW_PERSONAL_DATA` to `omit` in the `env` of the entry for Leave out. The server then keeps
names and email addresses out of what it gives the AI assistant:

- The AI assistant also gets no meeting titles, agendas, waiting room welcome notes or origins,
  and no titles, cities or initials of users. All these values are `null`, and every key of a
  result stays.
- alfaview names a meeting room after the meeting title, so the name of a meeting room is `null`
  too.
- IDs, times, counts, the names of other rooms and join URLs stay. With the API key, an ID still
  leads to a person, so the data that stays is still personal data.
- What the AI assistant sends to alfaview reaches the AI provider as before. An example is the
  email address of a new guest.
- The server reads alfaview's answers on your computer. Leave out decides what the AI assistant
  gets.
- The option belongs to the server entry. An entry with `include`, or without the variable, gives
  the full data.

With Leave out, the tools still find, create, report and delete by IDs, times and states:

- Each result of `create_guest_links` has `index`, the position of its guest in `guests`, counted
  from 0. The AI assistant can match each join URL to its guest by this position.
- `get_room_attendance` gives the counts and the status of each invited person with their guest
  links. The values `attendedEmails` and `noShowEmails` are `null`, so tagging by email address
  needs Include.
- When alfaview refuses the input of `create_guest_links` or `update_guest_link`, the message names
  the field. The reason that alfaview gives can repeat an email address, so the message leaves it
  out. At the level `manage`, `create_group_link` does the same, because its input holds an
  origin, and so does `invite_user` at the level `full`.
- `find_users` still filters by name and email address. Before `delete_user` deletes a user, the
  server asks you for the email address of the user, and its question names the user by the ID
  only. An AI assistant that cannot ask needs the address from you, because no result holds it.

The server tells the AI assistant in its instructions that these values are `null`. Each tool
result in which the server set such a value of alfaview to `null` also has a warning that says so.

- The warning names the kinds of the values, such as names and email addresses, and no value.
- It tells the AI assistant that the values are `null` also where alfaview has a value. Then the
  assistant does not say that they do not exist.
- An empty list and a value that you gave in the request, such as the origin filter of a cleanup,
  get no warning.

A change of the variable applies when the server starts again. Some jobs, such as the cleanup of
expired guest links, need no names. For such a job, set up an entry of its own with `omit`
([Runs without a person](access-levels.md#runs-without-a-person)).

## The place of the API key

The API key is a secret. The setup keeps it out of the shell history and out of shared files.
Claude Code (scopes `local` and `user`) and Claude Desktop keep the values of a server entry in
their configuration files. These files hold the values in plain text.

With the plugin, Claude Code keeps the key in its credential store, not in `settings.json`
([Install the plugin](clients.md#install-the-plugin)). The credential store differs for each
system:

- macOS: the Keychain. When the Keychain refuses the write, for example when it is locked in an SSH
  session, Claude Code writes the key to `~/.claude/.credentials.json`, as on Linux.
- Linux: the file `~/.claude/.credentials.json`, in plain text. Its mode `0600` lets only your user
  read it.
- Windows: the file `%USERPROFILE%\.claude\.credentials.json`, in plain text. By default, the access
  rights of your user folder let only your user read it.

For a manual entry, prefer the forms that keep the key in the entry alone: `claude mcp add --env`
in Claude Code, the `env` of the entry in Claude Desktop, and `envFile` in Cursor
([Set up your AI assistant](clients.md)).

A form can name the key as a variable: `${ALFAVIEW_API_KEY}` in `.mcp.json` or
`${env:ALFAVIEW_API_KEY}` in Cursor. Such a form needs the key in the environment of the client. A
run without a person needs it there too. Every process that the client starts then also gets the
key:

- every other MCP server that the client starts, which can read the key
- the shell tool of the assistant, hooks and terminals

A text with instructions, for example in a guest name, can make the assistant print the key with
the shell tool.

## Related pages

- [Configuration](configuration.md): the variable `ALFAVIEW_PERSONAL_DATA` and the permissions of
  the alfaview user.
- [Access levels](access-levels.md): the tools of each level and the guards of the level `full`.
- [Set up your AI assistant](clients.md): the server entry and the permission rules.
