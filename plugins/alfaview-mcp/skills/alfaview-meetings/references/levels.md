# Levels and server entries

The tools of each access level, and the server entry for each job. A level also has the tools of
the levels before it.

| Level | Tools | Entry |
| --- | --- | --- |
| `read` | `find_rooms`, `get_room`, `find_guest_links`, `find_meetings`, `get_meeting`, `find_room_participants`, `get_room_attendance`, `get_guest_link_attendance`, `get_company_statistics` | plugin or manual entry |
| `standard` | `regenerate_room_passcode`, `create_guest_links`, `update_guest_link`, `delete_guest_link`, `delete_expired_guest_links`, `create_meeting`, `update_meeting`, `cancel_meeting` | plugin or manual entry |
| `manage` | `get_account`, `update_own_user`, `create_room`, `update_room`, `get_room_settings`, `update_room_settings`, `create_breakout_room`, `update_breakout_room`, `delete_breakout_room`, `find_group_links`, `create_group_link`, `update_group_link`, `delete_group_link`, `find_users`, `find_room_permissions` | plugin or manual entry |
| `full` | `add_room_permission`, `update_room_permission`, `remove_room_permission`, `invite_user`, `delete_user`, `delete_room` | manual entry only |

## Which entry serves which job

- The plugin gives one server entry, `alfaview`. Its setting Access level is `read`, `standard` or
  `manage`, and the default is `standard`. To change it, the person runs `/plugin`, opens
  `alfaview-mcp` on the tab Installed, selects Configure options, then starts a new session.
- `read`: reports that change nothing, such as the attendance of a webinar.
- `standard`: guest links, meetings and the cleanup of guest links.
- `manage`: rooms and their settings, breakout rooms and group links, and a view of the users and
  of the room permissions.
- `full`: only the jobs that delete rooms or users, or that give or take away access to a room. It
  needs a manual entry with a confirmation, which the plugin cannot give
  ([The level full](https://github.com/alfaview/alfaview-for-mcp/blob/main/docs/access-levels.md#the-level-full)).
- A manual entry can also offer only some tools of its level, for example for a job without a
  person
  ([Server entries](https://github.com/alfaview/alfaview-for-mcp/blob/main/docs/access-levels.md#server-entries)).
- The plugin offers `get_company_statistics` at each level. The tool works only for an alfaview
  user with the user permission Manage Company.
- A second entry for the same company shows each shared tool twice, so add only the entries that a
  client needs. For example, a manual entry of `full` next to the plugin uses `ALFAVIEW_TOOLS` to
  name only the tools of `full`.
- A tool can come under two prefixes, such as those of the plugin at `standard` and a manual entry
  of `manage`. Then use the entry with the lowest level that has the tool.
