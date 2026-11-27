# Limits

This page lists the limits of the server and of the alfaview API, what the server does at each
limit, and what you or the AI assistant can do.

## Attendance

- A guest who joins through a guest link gets a userId, and the attendance knows the guest only by
  it. alfaview returns this userId in each guest link, and the server matches a guest to a link
  only by it. When alfaview gives a link no userId, `get_guest_link_attendance` fails with
  `This guest link cannot be matched to attendance data.`, and `get_room_attendance` does not
  count that link as invited.
- alfaview removes the user IDs and names from attendance after 40 days, and one query covers at
  most 26 hours. So `from` can be at most 39 days ago.
- "Attended" means connected, also in the waiting room. Use `minimumMinutes` for a threshold.
- The server cannot match people who joined with a group link to a person.
- Above 400 invited people, `attendedEmails` and `noShowEmails` of `get_room_attendance` are
  `null`, also with the option Personal data set to Include. Read the invitees with `status`,
  `offset` and `limit`.
- With `includeOtherAttendees`, `get_room_attendance` lists the first 20 other attendees by the
  time of joining. A warning of the result gives the number of all other attendees.

## Company statistics

`get_company_statistics` returns at most 100 periods, and it refuses a call that gives more. Then
raise `stepDurationHours` or shorten the time range.

## The people in a room

`find_room_participants` gives a snapshot at the time of the call.

## Guest links

- `create_guest_links` takes at most 25 guests in each call.
- The alfaview API has no filter for guest link lists. So the guest link and attendance tools read
  all links of a room. Above 50 pages of 500 links, they fail with a message.
- Delete old links with `delete_expired_guest_links`, which reads at most 20 pages in each call. In
  a larger room, its result gives a `pageToken` for the next call. That call goes on after the
  links that the first call read.
- `delete_expired_guest_links` refuses a meeting room, because alfaview emails each guest whose
  link is deleted there. Delete such links one at a time with `delete_guest_link` and `sendEmail`
  set to `true`.

## Group links

`update_group_link` turns a link off with a `validUntil` in the past. alfaview needs `validUntil`
after `validFrom`. So for a link that starts later, give both times in the past.

## Breakout rooms

- A room has at most 50 breakout rooms. `get_room` lists them, and `delete_breakout_room` removes
  one.
- The name of a breakout room has at most 32 bytes: 32 letters without accents, fewer with accents
  or emoji. The server refuses a longer name before any request.

## Room settings

- `update_room_settings` saves its parts one after another: first the transcription and
  translation, then the file sharing, then the features. When a part fails, the parts before it
  stay saved, and the parts after it do not change. The message names what alfaview saved and the
  parameters of the next call. Each part replaces the settings that the call names with the values
  of the call. So the same call again gives the same settings as one call without an error.
- The spoken language must be a code that alfaview offers, and each translation language a code
  that alfaview translates the spoken language into. The server checks the codes before any
  change, and its message names the codes that alfaview offers.

## The time of a tool call

- The work of each tool call with alfaview ends within 50 seconds, inside the 60 seconds after
  which many clients cancel a call.
- `create_guest_links` starts no new guest after 35 seconds, and `delete_expired_guest_links`
  starts no new delete after 30 seconds. The result then says what is left, and the AI assistant
  calls again.
- On a connection of a 2025 protocol revision, the question before `delete_room` and `delete_user`
  keeps the call open while you answer, for up to 5 minutes. A client that cancels a call after 60
  seconds then cancels the delete, and nothing is deleted. Use a client on protocol revision
  2026-07-28, or one with a longer tool timeout.

## The rate of calls and requests

- The server takes at most 120 tool calls a minute.
- It sends at most 8 requests at a time and at most 600 requests a minute to alfaview, the sign-in
  included.
- A request over a limit waits within the time limit of its call. A call that cannot go on gets a
  message that asks to wait a minute.

## The answers of alfaview

The server reads at most 16 MB of each answer of alfaview. Of an error answer, it keeps at most
500 characters of each text and 20 entries. A larger answer gives a message that names the
request. After a change, the message says that alfaview may have done the change.

## Times

- A time without an offset, for example `2026-10-07T18:00`, is local time in the `timezone`
  parameter of the tool, else in `ALFAVIEW_TIME_ZONE`, else in `Europe/Berlin`. The server does not
  use the time zone of the computer.
- `create_meeting`, `update_meeting`, `create_guest_links` and `update_guest_link` have a
  `timezone` parameter. The other tools read their times in the time zone of the server. For
  another time zone, give a time with an offset.

### The forms of a time

The schemas show ISO 8601, which a model writes. The server also accepts these forms:

- `27.10.2026 10:00`
- `27/10/2026 10:00` and `10/27/2026 10:00`, only when the day is above 12
- Unix time with exactly 10 digits (seconds) or 13 digits (milliseconds)

The server refuses an ambiguous slash date such as `05/10/2026`, a two-digit year, a date without a
time, and natural language. Its message names the parameter.

### Clock changes

- The server refuses a local time that the clocks skip in spring, for example `2026-03-29T02:30`
  in Europe/Berlin.
- A local time that occurs twice in autumn is the earlier one: `2026-10-25T02:30` in Europe/Berlin
  is `2026-10-25T00:30:00Z`. Give an offset for the second one.

### Times in the results

Result times have the offset of the time zone of the call (the `timezone` parameter, else that of
the server), in whole seconds, for example `2026-10-07T18:00:00+02:00`. The summaries give each
time as local text with the name of the time zone, for example `2026-10-07 18:00 Europe/Berlin`.
The model can then repeat it to you as it is.

## Lists

Each list tool returns at most `limit` entries, and the maximum differs by tool
([Tools](tools.md)). `nextOffset` gives the `offset` of the next call.

## Sign-in

The server signs in at the first tool call. It uses the token until alfaview refuses it, after
about 12 hours, then signs in again. Every sign-in creates a session entry in alfaview, so each
client session that calls a tool creates one.

## Meetings

Meetings belong to the alfaview user of the API key
([The alfaview user and its permissions](configuration.md#the-alfaview-user-and-its-permissions)).

### Recurring meetings

- `find_meetings` gives one entry for a recurring meeting, with its ongoing or next occurrence.
  With `includeEveryOccurrence`, it gives one entry for each occurrence that alfaview lists.
- alfaview lists no past occurrence, and no occurrence more than 90 days after the later of `from`
  and the time of the request. A series without an occurrence in that period gives no entry.
- The list of meetings in alfaview does not show the guest links of a recurring meeting, so
  `guestLinkCount` is `null` for such an entry. `get_meeting` gives the count.

### Recurrence rules

`create_meeting` and `update_meeting` take `recurrenceRule`, an RFC 5545 rule such as
`FREQ=WEEKLY;BYDAY=MO`, with or without the prefix `RRULE:`.

- `start` is the start of the first occurrence, and `end` minus `start` the length of each. In
  `update_meeting` without `start`, the current start stays the first occurrence.
- alfaview anchors the rule in the time zone of the meeting. So a weekly rule without `BYDAY`
  keeps the weekday and the local time of `start`, also when the clocks change.
- A recurring meeting cannot stop repeating: alfaview cannot remove its rule.

Before any request, the server checks the rule, with a message that says why. It refuses:

- a rule that is not KEY=VALUE parts with `FREQ`
- a rule that repeats more often than daily
- `BYHOUR`, `BYMINUTE` or `BYSECOND`, because `start` sets the time
- an `UNTIL` that is not in UTC, is in the past or is before `start`
- `UNTIL` together with `COUNT`
- a `COUNT` or `INTERVAL` below 1
- a rule of more than 1018 characters without its prefix

alfaview checks what the server cannot, such as a rule whose days never come before `UNTIL`, or
`UNTIL` in `update_meeting` without `start`. Then the tool gives the message of alfaview.

### The outputs of a recurring meeting

- Every meeting result has `recurrenceRule` and `externallyManaged`.
- `get_meeting`, `create_meeting`, `update_meeting` and `cancel_meeting` also have `nextInstance`,
  the start of the ongoing or next occurrence.
- These keys are `null` for a meeting that does not recur.
- In these four tools, `start` and `end` of a recurring meeting are those of its first occurrence.

### Externally managed meetings

Another system can manage a recurring meeting, such as an alfaview add-in of a calendar program.
That system can write its own time and title back over a change. Its `externallyManaged` is
`true`.

- At the level `standard`, `update_meeting` and `cancel_meeting` refuse such a meeting and change
  nothing.
- At `manage` and `full`, they change or cancel it.
- No tool parameter changes this rule: the level of the server entry decides it
  ([Access levels](access-levels.md)).

## Transport

The server runs over standard input and output (stdio) only.
