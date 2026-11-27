# Deletes

What each delete removes, and the steps of a delete that asks the person. You cannot undo a
delete, with one exception: `add_room_permission` can give back the permissions that
`remove_room_permission` removed.

## What each tool removes

| Tool | Level | Removes | Asks the person |
| --- | --- | --- | --- |
| `delete_guest_link` | `standard` | One guest link. In a meeting room, alfaview emails the guest. | No |
| `delete_expired_guest_links` | `standard` | The expired guest links of one room. | No |
| `cancel_meeting` | `standard` | The meeting. Nobody can join it after that. | No |
| `delete_breakout_room` | `manage` | One breakout room. A new one gets a new ID. | No |
| `delete_group_link` | `manage` | One group link, for everyone who has its join URL. | No |
| `remove_room_permission` | `full` | The room permission of one user in one room. | No |
| `delete_user` | `full` | One user. The rooms and the room permissions of the user stay. | Yes, for the email address |
| `delete_room` | `full` | One room or department, with its breakout rooms, guest links, group links, files and polls. Everyone in the room leaves it. | Yes, for the room name |

## Before the call

1. Find the target with its find tool, such as `find_rooms`, `find_users`, `find_guest_links`,
   `find_group_links` or `get_room`.
2. When more than one item fits the request, or no item fits it exactly, list the candidates and
   ask the person. Delete nothing.
3. In the answer, name the target and what went with it.

## The question of the server

`delete_room` and `delete_user` ask the person in the client. The person types the room name or
the email address of the user.

- Call the tool once, and wait for the answer.
- Do not answer the question yourself. Give `confirmRoomName` or `confirmEmailAddress` only when
  the server says that the client cannot ask, and only with the value that the person typed.
- After a no, a cancel or no answer, the item stays. Do not call the tool again, and do not delete
  another item in its place. Only a new request of the person starts a new delete.
- `delete_room` refuses a meeting room. To end a meeting, use `cancel_meeting`.
- A run without a person cannot answer the question, so the server deletes nothing. Such a job
  needs a hook that answers for its operator
  ([A delete without a person](https://github.com/alfaview/alfaview-for-mcp/blob/main/docs/access-levels.md#a-delete-without-a-person)).
