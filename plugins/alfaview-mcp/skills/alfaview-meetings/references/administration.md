# Administration

The tools of the level `manage` work with rooms and their settings, breakout rooms and group
links. They also show the users and the room permissions, and change the profile of the alfaview
user of the API key. The level `full` adds the tools that change who has access.

## Rooms

- `update_room` changes the name, the waiting room, the welcome note and the passcode setting.
- `update_room_settings` changes the features, the transcription and translation, and the file
  sharing. Give only the fields that the person asks to change. The other fields keep their
  values.
- A request for a property of the room and for a setting needs both tools, such as a waiting room
  and the transcription.
- After an error of `create_room`, look with `find_rooms` before you create the room again.

## Transcription and translation

- Give each language as a code, such as `de-DE` for German or `en-US` for English.
- When the person names the language that people speak, give it as the spoken language. For a
  translation, give the target languages. The list of target languages replaces the current list.
- When alfaview does not offer a language, the message of the tool names the codes that it offers.
  Tell the person these languages, and change nothing else.

## Features and file sharing

- Change only the features that the person names. The other features keep their values.
- For "everyone can download new files", set the default access of new files to `downloadable`.
- Keep file sharing on when the person changes one of its settings.

## Breakout rooms

1. Read the breakout rooms of the room with `get_room`.
2. Call `create_breakout_room` once for each new breakout room, `update_breakout_room` to rename
   one, and `delete_breakout_room` to remove one.
3. After an error, read the list with `get_room` again. Create only the breakout rooms that are
   still missing.

- The display name of a breakout room without a name is `null` in the result. alfaview shows it
  with a number, such as Group 1.

## Group links

- A group link gives one join URL to many people, with one permission group. The attendance cannot
  tell these people apart. For an invitation of one person, use a guest link.
- Give a group link a group without moderator rights, unless the person asks for moderators.
- The group link tools do not change the group links of a meeting room. `get_meeting` gives their
  join URLs.

## Users and room permissions

- `find_users` gives the IDs of the users. When the alfaview user of the API key has no user
  permission List Users, the result shows only that user.
- With the setting Personal data `omit`, the titles, cities and initials of users are `null` too.
- `find_room_permissions` shows who has a room permission in a room. Give only the names that the
  person asks for.
- At the level `full`, `add_room_permission` gives a user a room permission with a permission
  group, such as Moderator. Look first with `find_room_permissions`. When the user has one, change
  it with `update_room_permission`.
- `invite_user` always emails the invitation. Call it only when the person asks for the invitation.

## The profile of the API user

`get_account` shows the alfaview user and the company of the API key. `update_own_user` changes
only that user.
