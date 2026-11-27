---
name: alfaview-meetings
description: Plans and runs the work of an alfaview company with the tools of the alfaview MCP server, such as guest links for bookings and webinars, meetings, attendance reports, the cleanup of old guest links, room settings, breakout rooms and group links. It gives the order of the tool calls, the points at which to ask the person, and the form of the answer. Use it before the first call of an alfaview tool in a task.
license: MIT
compatibility: Needs the server alfaview of the plugin alfaview-mcp, which runs @alfaview-integrations/alfaview-for-mcp.
---

# alfaview-meetings

## The tools and the level

This skill names each tool by its bare name, such as `find_rooms`. The client adds the prefix of
the server entry, such as `mcp__plugin_alfaview-mcp_alfaview__find_rooms` for the plugin or
`mcp__alfaview__find_rooms` for a manual entry.

The server offers the tools of its access level and of the levels before it. The tool list shows
the level: `full` has `delete_room` and `delete_user`, `manage` has `update_room` and `find_users`,
`standard` has `create_guest_links` and `create_meeting`, and `read` has only tools that read. Use
only the tools of the list. A manual entry can offer only some tools of its level, and two entries
show a tool twice ([levels.md](references/levels.md)).

## Checks before a write

- The target: find it with a find tool, also when the person gives its name. When more than one
  item fits and no item has exactly the name of the request, list the items and ask the person.
  Change nothing until the person answers. Before a delete, also ask when more than one item fits
  ([deletes.md](references/deletes.md)).
- The missing values: ask the person once for each value that the task needs and the request does
  not give, such as the date of an appointment. Never invent one.
- The emails: some changes always send an email ([Emails and credentials](#emails-and-credentials)).
- What cannot be undone: the server names these tools. Call one only for a target and a change
  that the person named. When the request names both, do not ask again.

## Requests

Read the file of the request before its first tool call.

| Request | Read | Tools, in order |
| --- | --- | --- |
| Invite guests to an appointment, a booking or a webinar | [invitations.md](references/invitations.md) | `find_rooms`, `create_guest_links` |
| Cancel or move a booking | [invitations.md](references/invitations.md) | `find_guest_links`, then `update_guest_link`, or `delete_guest_link` and `create_guest_links` |
| Schedule a meeting with personal guest links | [invitations.md](references/invitations.md) | `create_meeting`, `create_guest_links` |
| Move, change or cancel a meeting | [invitations.md](references/invitations.md) | `find_meetings`, `get_meeting`, `update_meeting` or `cancel_meeting` |
| The passcode of a room | [invitations.md](references/invitations.md) | `find_rooms`, `get_room` |
| Who waits in a room now | [attendance.md](references/attendance.md) | `find_rooms`, `find_room_participants` |
| Who attended an event, and who did not | [attendance.md](references/attendance.md) | `find_rooms`, `get_room_attendance` |
| How long one guest attended | [attendance.md](references/attendance.md) | `find_rooms`, `find_guest_links`, `get_guest_link_attendance` |
| Count or list the guests of an event | [attendance.md](references/attendance.md) | `find_rooms`, `find_guest_links` |
| The use of the rooms of the company | [attendance.md](references/attendance.md) | `get_company_statistics` |
| Delete old guest links | [cleanup.md](references/cleanup.md) | `find_rooms`, `delete_expired_guest_links` |
| Change a room or its settings | [administration.md](references/administration.md) | `find_rooms`, `update_room`, `update_room_settings` |
| Add, rename or remove breakout rooms | [administration.md](references/administration.md) | `find_rooms`, `get_room`, `create_breakout_room`, `update_breakout_room`, `delete_breakout_room` |
| Group links | [administration.md](references/administration.md) | `find_rooms`, `find_group_links`, `create_group_link`, `update_group_link` |
| Users and room permissions | [administration.md](references/administration.md) | `find_users`, `find_room_permissions`, `add_room_permission` |
| Delete a room or a user | [deletes.md](references/deletes.md) | `find_rooms` or `find_users`, then `delete_room` or `delete_user` |
| The level or the server entry of a job | [levels.md](references/levels.md) | none |

## A tool of a higher level

When the request needs a tool that the list does not have:

1. Do not get the same result with other tools, such as a delete and a create in place of an
   update. Make no change for this part of the request.
2. Tell the person that the access level of the server does not offer the tool. Name the level
   that does, and say how the person changes the level ([levels.md](references/levels.md)).
3. The plugin offers `read`, `standard` and `manage`. The level `full` needs a manual server entry
   ([The level full](https://github.com/alfaview/alfaview-for-mcp/blob/main/docs/access-levels.md#the-level-full)).
   Next to the plugin, that entry names only the tools of `full`
   ([The plugin and a manual entry](https://github.com/alfaview/alfaview-for-mcp/blob/main/docs/clients.md#the-plugin-and-a-manual-entry)).

## Emails and credentials

- Three changes always send an email, and the tools refuse them without the email. An update of a
  meeting with guest links emails its guests. The delete of a link in a meeting room emails its
  guest. `invite_user` emails the invited user.
- When the person forbids an email that the change needs, read the target and make no change. Say
  that alfaview would send the email, and ask whether to make the change with the email.
- Read join URLs and passcodes only when the job needs them. Give them only to the person, in the
  answer. Do not put them into a file, a message or another tool unless the person asks for it.

## Personal data

With the setting Personal data `omit`, the values that the server names are `null`.

- A `null` there does not mean that the value does not exist. Say that the server leaves out
  personal data. When the job needs such a value, tell the person to set Personal data to `include`.
- Never invent a value that the result leaves out. Do not take it from another place, such as an
  email address that you make from a name.
- The filters of the find tools still match these values. Never filter by a guess, such as an
  address that you make from a name: a match shows personal data. IDs, times, counts and states stay.

## Deletes

1. Name one target, and what goes with it ([deletes.md](references/deletes.md)). When the request
   names no single target, such as "the old room", list the candidates and ask. Delete nothing.
2. Delete only the type of item that the request names. A request to delete a user keeps the rooms
   of that user.
3. `delete_room` and `delete_user` ask the person through the client. Wait for the answer, and do
   not answer for the person.
4. After a no, a cancel or no answer, do not call the tool again, and delete nothing in its place.
   Say that the item stays.

## Errors and repeats

- A missing permission (HTTP 403): the message names the room or user permission that the
  alfaview user needs. Give the person that sentence as it is. Do not try another tool in its place.
- The item is not found: find it again with its find tool. If it is still missing, tell the person.
- No such tool: the level does not offer it ([A higher level](#a-tool-of-a-higher-level)).
- An error or a timeout of a create: look for the new item before you create it again, unless the
  server instructions say that a repeat is safe.
- A message that names the next call: make that call, with the input that the message names.
- Too many calls or requests: wait as the message says (one minute for the limit of the server),
  then make the same call once more.
- alfaview refuses the input: correct the input when the message says how. Else give the person
  the message. Do not send the same input again.
- After two errors of the same call, stop and give the person the message.

## The answer

- Join each URL of `create_guest_links` to its guest by `index`, not by the order of the result.
- Give each time as local time with its time zone and the UTC offset of its date, such as 16:45
  Europe/Berlin (UTC+2) in July. Use the time zone of the person. Give UTC only if the person asks.
- To convert a time, go through UTC with the offsets of the date of the event: 18:30 UTC-5 is
  23:30 UTC and 00:30 UTC+1 of the next day. Europe and North America change their clocks on
  other dates, so the gap between them changes during the year.
- Count and list only after you read every page of a list.
- For a list to paste, such as email addresses, give only the values, one on each line.
- Say what changed, what did not change, and who got an email from alfaview.
- Never say that a change is done when a tool refused it.
