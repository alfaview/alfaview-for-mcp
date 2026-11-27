# Configuration

The server reads its settings from the environment variables of its server entry, never from a
file. This page lists each variable and the permissions that the alfaview user of the API key
needs.

## Required variables

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `ALFAVIEW_COMPANY_ID` | text | none | The ID of your alfaview company. It comes with the API key. The administration interface of alfaview shows it as the account ID. |
| `ALFAVIEW_CLIENT_ID` | text | none | The alias of the API key, also called client ID. |
| `ALFAVIEW_API_KEY` | text | none | The API key. The administration interface of alfaview shows it as the code. It is a secret: [Data protection](data-protection.md#the-place-of-the-api-key) says where to keep it. |

The alfaview help shows
[how to get your API credentials](https://support.alfaview.com/en/for-it-administration/advanced-configurations/generate-api-credentials/).

## Optional variables

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `ALFAVIEW_ACCESS_LEVEL` | `read`, `standard`, `manage` or `full` | `standard` | The access level of the entry, in lowercase. It decides which tools the server offers ([Access levels](access-levels.md)). |
| `ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS` | text | none | Only for the level `full`: the company ID of the entry, the value of `ALFAVIEW_COMPANY_ID`. Upper and lower case do not matter. At every other level, the server does not start while it is set. |
| `ALFAVIEW_TOOLS` | comma list of tool names | all tools of the level | The tools of the level that the server offers, for example `find_rooms,find_guest_links,create_guest_links`. [Tools](tools.md) lists the names. A name of a tool above the level stops the server at start. |
| `ALFAVIEW_TIME_ZONE` | IANA name | `Europe/Berlin` | The time zone of the server, for example `America/New_York`. The server refuses `Local` and offsets such as `+01:00` ([The time zone](#the-time-zone)). |
| `ALFAVIEW_PERSONAL_DATA` | `include` or `omit` | `include` | The option Personal data, in lowercase. `include` gives every value. `omit` leaves out names, email addresses and the texts about a meeting or a booking ([Personal data](data-protection.md#personal-data)). |
| `ALFAVIEW_API_BASE_URL` | URL | `https://apis.alfaview.com` | The address of the alfaview API. The server takes no other host. |

## How the server reads the values

- The server removes the spaces at the start and the end of each value. An empty value counts as
  unset.
- Set all three required variables and `ALFAVIEW_ACCESS_LEVEL` in each server entry. Claude Code
  gives a server its whole own environment plus the `env` of the entry. Without the variables in
  the entry, a shell that exports `ALFAVIEW_API_KEY` for another purpose gives that key to the
  server. A shell that exports `ALFAVIEW_ACCESS_LEVEL` gives its level. A job can take the three
  required variables from its own environment on purpose
  ([Runs without a person](access-levels.md#runs-without-a-person)).
- The server checks the configuration at start. When a value is missing or wrong, the server writes
  one line for each problem to its log and stops. The AI assistant then shows the server as failed
  ([Troubleshooting](troubleshooting.md#the-server-does-not-start)).
- A change of a variable applies when the server starts again
  ([Troubleshooting](troubleshooting.md#restart-the-server)).
- The first line of the log names the access level, the time zone and the option Personal data
  that are in effect.

## The time zone

`ALFAVIEW_TIME_ZONE` sets three defaults. Each applies when a tool call gives no `timezone`:

- the time zone of a time without an offset, for example `2026-10-07T18:00`, and of the times in
  the results
- the time zone that `create_meeting` sends to alfaview, in which the invitees see the meeting
  times
- the time zone of the emails of `create_guest_links` and `update_guest_link`

Set the variable once for your time zone. Without it, all three are `Europe/Berlin`, also on a
computer in another time zone.

## The option Personal data

The values are `include` and `omit`. For any other value, the server writes the line
`ALFAVIEW_PERSONAL_DATA must be include or omit, or empty for include.` to its log and stops at
start. Each result of `create_guest_links` has the key `index`, also with `include`.
[Personal data](data-protection.md#personal-data) says what `omit` leaves out.

## The certificate check

The server does not start when `NODE_TLS_REJECT_UNAUTHORIZED` is `0`. That setting turns off the
certificate check of HTTPS, and the server does not send the API key without that check.

## The alfaview user and its permissions

Create the API key for a dedicated alfaview user, not for a person. The key comes with a company
ID and a client ID (the alias of the key). The administration interface of alfaview shows the key
as the code and the company ID as the account ID.

Give this user what the AI assistant needs, and nothing more:

| Permission | Where | What it allows |
| --- | --- | --- |
| Room permission **Admin** and **Join**, for example the permission group Admin | Each room that the assistant works in | Admin: the guest links and the attendance of the room, and at the level `manage` its group links and breakout rooms. Join: `find_room_participants`, which the user permission Room Admin does not give. |
| User permissions **Room Admin** and **List Rooms** | The user | Every room of the company. Give them only when the assistant must search all rooms (`find_guest_links` without `roomId`, or at the level `manage` `find_group_links` without `roomId`). |
| User permission **Manage Company** | A second user, for the entry `alfaview-admin` only | `get_company_statistics` |
| User permission **Create Rooms** | The user of an entry at the level `manage`, only when the assistant must create rooms | `create_room`. **Room Admin** allows it too, and it also lets `update_room_settings` turn transcription on or off. |
| User permission **List Users** | The user of an entry at the level `manage` or `full`, only when the assistant must find users | `find_users`, and the names of `find_room_permissions`. Without it, alfaview lists only the alfaview user of the API key. **User Admin** allows it too. |
| Room permission **Admin**, or user permission **Room Admin** | The user of an entry at the level `full`, in each room whose permissions the assistant changes or that it deletes | `add_room_permission`, `update_room_permission`, `remove_room_permission` and `delete_room`. |
| User permission **User Admin** | The user of an entry at the level `full`, only when the assistant must invite or delete users | `invite_user` and `delete_user`. A new user gets only user permissions that the alfaview user of the API key has. |

A room admin gives the room permission in alfaview, in the permissions of the room.
[Server entries](access-levels.md#server-entries) shows the entries `alfaview` and
`alfaview-admin`.

Meetings belong to the alfaview user of the API key. The tools `find_meetings`, `get_meeting`,
`update_meeting` and `cancel_meeting` work with the meetings that this user created. They do not
work with the meetings of other users.
