# Troubleshooting

Find the reason of a problem in the log of the server, then fix it.

## Find the log

- Claude Code: `/mcp` shows the state of the server. The command `claude --debug-file <path>`
  writes a debug log with the output of the server. Without a session,
  `claude --debug-file <path> mcp list` writes the output of the start of each server. Claude Code
  writes each line of the server after `[ERROR]` and `Server stderr:`, also when nothing failed.
  One entry of the file can hold two lines of the server, with `\n` between them.
- Claude Desktop: the file `mcp-server-<entry>.log`, with the name of the entry, such as
  `mcp-server-alfaview.log` or `mcp-server-alfaview-manage.log`. It is in `~/Library/Logs/Claude`
  on macOS, in `%APPDATA%\Claude\logs` on Windows and in `~/.config/Claude/logs` on Linux.
- Cursor: the Output panel, MCP Logs.

## Read the log

Every line of the server starts with `alfaview-mcp:`.

- The first line names the version, the host, the number of tools, the access level, the time
  zone of the server and the option Personal data, for example
  `alfaview-mcp: version <version> ready for https://apis.alfaview.com with 17 tools at level standard, time zone Europe/Berlin, personal data include`.
- When a tool of the level `full` is registered, a warning line follows the first line.
- At the first message of the client, a line names the protocol revision that the client uses:
  `protocol era 2025` or `protocol era 2026-07-28`.
- Then comes one line for each tool call, for example
  `alfaview-mcp: tool find_rooms: ok, 2 requests, 19 ms`, or with the error code in place of
  `ok`.
- A delete has one line for each round of its question: `asks the person (round 1)` when it asks,
  then `ok, confirmed by the person`, `ok, declined by the person`, `ok, canceled by the person`,
  `ok, not confirmed by the person` or, for a client that cannot ask,
  `ok, confirmed by the parameter`.

## The server does not start

When the server does not start, its log names the reason, with one line for each problem. In
Claude Code, `claude --debug-file <path> mcp list` writes these lines to the file `<path>`.

| Log line | Fix |
| --- | --- |
| `Missing configuration: ALFAVIEW_COMPANY_ID, ...` | Set the named variables in the `env` of the entry. |
| `ALFAVIEW_API_BASE_URL must be empty or https://apis.alfaview.com.` | Remove the variable, or set it to `https://apis.alfaview.com`. |
| `ALFAVIEW_ACCESS_LEVEL must be read, standard, manage or full. ...` | Write one of the four levels in lowercase, or leave the variable out for `standard`. |
| `ALFAVIEW_ACCESS_LEVEL is full, which can delete rooms and users for good ...` | Set `ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS` to the company ID of the entry, or choose another level ([The level full](access-levels.md#the-level-full)). |
| `ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS does not match ALFAVIEW_COMPANY_ID. ...` | Write the value of `ALFAVIEW_COMPANY_ID` of the same entry. |
| `ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS is set, but ALFAVIEW_ACCESS_LEVEL is not full. ...` | Remove the variable from the entry and from the shell environment of the client. |
| `ALFAVIEW_TOOLS names unknown tools: ...` | Correct the names. The line lists the valid ones with their levels. |
| `ALFAVIEW_TOOLS names no tools. ...` | Leave it empty for all tools of the level, or name some. |
| `ALFAVIEW_TOOLS names tools that update_room_settings replaces: ...` | Write `update_room_settings` in the place of `update_room_features`, `update_room_language_settings` and `update_room_file_sharing`. Also change each permission rule of an AI assistant that names them, such as `mcp__alfaview__update_room_features` in Claude Code. |
| `ALFAVIEW_TOOLS names tools above the level ...` | Set `ALFAVIEW_ACCESS_LEVEL` to the level that the line names, or remove the names. |
| `ALFAVIEW_TIME_ZONE is not a valid time zone. ...` | Use an IANA name such as `America/New_York`, or leave the variable empty for `Europe/Berlin`. The value `Local` and offsets such as `+01:00` are not time zones here. |
| `ALFAVIEW_PERSONAL_DATA must be include or omit, or empty for include.` | Write `include` or `omit` in lowercase, or leave the variable out for `include`. |
| `NODE_TLS_REJECT_UNAUTHORIZED is 0, ...` | Remove this variable from the environment of the client. |

## A tool call fails

| Symptom | Message | Fix |
| --- | --- | --- |
| The sign-in is refused | `alfaview rejected the Company ID, Client ID or API key. ...` | Check the three values, then restart the server. The server remembers a refused sign-in for 5 minutes. During that time, it answers every call with the same message. |
| The account is not active | `The alfaview account that owns this API key is not active. ...` | Wait until the account is active again. The server tries to sign in again 5 minutes after the refusal. |
| A search of guest links or group links needs a room | `Searching all rooms needs the user permissions List Rooms and Room Admin. Give roomId instead.` | Give `roomId`, or give the alfaview user the user permissions List Rooms and Room Admin. |
| An ID is not found | `alfaview could not find the <item>. It was deleted, or the API key's user cannot see it.` | Ask the AI assistant to find the ID again, for example with `find_rooms`. For a room that exists, give the alfaview user of the API key its room permissions ([The alfaview user and its permissions](configuration.md#the-alfaview-user-and-its-permissions)). |
| A create ends with an error | `alfaview may have ... before the error. Check with ... before you create it again: a second create makes a second ...` | Let the AI assistant check with the tool that the message names, such as `find_rooms`, before it creates the room, breakout room, meeting or group link again. |
| A guest of `create_guest_links` fails with the ID of a link | `This guest has a valid link in this room with the same email address, origin and validity, but with another permission group or dial-in setting: ...` | The guest has a link already, so the tool makes no second link and sends no email. To change the permission group or the dial-in of that link, ask for `update_guest_link`. |
| Too many tool calls in a minute | `... takes at most 120 tool calls a minute. Wait a minute and call again.` | Wait a minute, then ask again. When the assistant repeats the same call, ask it to stop. |
| Too many requests to alfaview | `... sends at most 600 requests a minute to alfaview. Wait a minute and call again.` | Wait a minute, then ask again. The limit counts the requests of all calls of the server, also of the calls that run at the same time. |
| A result has an unexpected form | `alfaview sent an unexpected response for ...` or `alfaview did the change, but the server could not form its result. ...` | Do not repeat a change: read its result with the tool that the message names. The log line of the call has `OutputShape` and the key with the unexpected value. Report that line. |
| A delete in an AI assistant that cannot ask | `This client cannot ask the person to confirm. Give confirmRoomName: ...` (or `confirmEmailAddress`) | Tell the AI assistant the name of the room or the email address of the user, or use an AI assistant that can ask ([The question before a delete](access-levels.md#the-question-before-a-delete)). |
| The question gets no answer | `The person did not answer the question, so nothing was deleted. ...` | The server asked twice through the AI assistant and got no answer. Ask for the delete again when you can answer the question. |
| An answer that does not fit | `The answer of the person does not fit this call or was used already, so nothing was deleted. ...` | Ask for the delete again. The server asks you again. |

Every other message says what to do, for example which permission the alfaview user needs, or
which tool gives the ID that a tool needs.

## A result is not what you expect

| Symptom | Cause | Fix |
| --- | --- | --- |
| A tool is missing | The access level or `ALFAVIEW_TOOLS` of the entry leaves the tool out. A call of the tool gets the answer "Tool ... not found". | Set the level of the tool ([Tools](tools.md)), or add the tool to `ALFAVIEW_TOOLS`. Then restart the server. |
| A time is some hours off | The time has no offset, and the server reads it in the `timezone` parameter of the tool, else in `ALFAVIEW_TIME_ZONE`, else in `Europe/Berlin`. The time zone of the computer plays no part. | Set `ALFAVIEW_TIME_ZONE` to your time zone, or give the time with an offset ([Times](limits.md#times)). |
| No email went out | alfaview sends an email only when the AI assistant sets `sendEmail` to `true`. The server tells the assistant to set it only when you ask for an email. | Ask for the email in the request. |
| Names and email addresses are `null` | The option Personal data of the entry is Leave out. | When the job needs them, set `ALFAVIEW_PERSONAL_DATA` to `include`, or remove the variable ([Personal data](data-protection.md#personal-data)). Then restart the server. |
| `attendedEmails` and `noShowEmails` of `get_room_attendance` are `null` with Include | The report has more than 400 invited people. A warning of the result says so. | Read the invitees with `status`, `offset` and `limit` ([Attendance](limits.md#attendance)). |
| A language is `null` | The user or the guest link has no language, and alfaview sends `unknown` for it. The server gives `null` in its place. | To set the language, give `locale` to `update_guest_link`, or to `update_own_user` for the alfaview user of the API key. Set the language of another user in alfaview. |
| The passcode of `get_room` is `null` | The call did not set `includePasscode`, or the room has no passcode yet. | Ask the AI assistant for the passcode. For a room without one, `update_room` with `passcodeRequired` set to `true` makes alfaview create a passcode. |
| `find_users` lists only the alfaview user of the API key | That user has no user permission List Users, or the company has no other user. A warning of the result says so. `apiKeyUserId` of each result names the alfaview user of the API key. | Give the user the user permission List Users or User Admin ([The alfaview user and its permissions](configuration.md#the-alfaview-user-and-its-permissions)). |

## Restart the server

After a change of the configuration, restart the server:

- In Claude Code, start a new session.
- In Claude Desktop, quit the app and start it again.
- In Cursor, turn the server off and on in **Customize** in the sidebar. After a change of a
  variable in the environment of Cursor, quit Cursor and start it again from a shell that exports
  the variable.

A restart also starts a newer version of the package, when npm has one and the entry names no
version ([The server entry](clients.md#the-server-entry)).

## Check the result

After the restart, read the first line of the log ([Read the log](#read-the-log)).

## Next steps

- [Configuration](configuration.md): each variable with its type and default.
- [Limits](limits.md): the limits of the server and of the alfaview API.
