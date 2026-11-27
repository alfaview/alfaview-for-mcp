# Tools

This page lists each tool of the server with its parameters. The script `scripts/tools-doc.ts` writes it from the tool definitions in `src/tools/`. [Limits](limits.md) gives the limits of the tools, and [Troubleshooting](troubleshooting.md) the problems of a tool call and of its result.

The server has 38 tools. A server entry gets the tools of its access level and of the levels before it ([Access levels](access-levels.md)). `ALFAVIEW_TOOLS` can leave out tools of the level ([Configuration](configuration.md)).

| Level | Tools of the level | Tools of a server entry at the level |
| --- | --- | --- |
| `read` | 9 | 9 |
| `standard` | 8 | 17 |
| `manage` | 15 | 32 |
| `full` | 6 | 38 |

The parameter texts show the default time zone `Europe/Berlin`. A server entry with `ALFAVIEW_TIME_ZONE` shows its own time zone there. With the option Personal data set to Leave out, some descriptions and parameter texts differ, and the section gives both.

Each tool gives the client its annotations (MCP tool annotations). `readOnlyHint: true` marks a tool that only reads, and `destructiveHint: true` a tool that can overwrite or delete. `idempotentHint: true` marks a tool whose repeat with the same input changes nothing more. `openWorldHint: true` marks a tool that works with a system outside the server, here alfaview.

Each tool also gives the client the shape of its result (an MCP output schema): its keys with their types, and which keys can be null. A client can check each result with it.

## Level read

The tools that only read.

### find_rooms

Lists the alfaview rooms that the API key's user can see, with the ID, waiting room and passcode setting of each. With name, exact matches come first, then names that contain it, in any case.

- Title: Find rooms
- Annotations: `readOnlyHint: true`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `name` | string of at most 256 characters | no | none | Part of the room name. |
| `type` | `room` or `department` | no | `room` | department lists departments, which hold rooms and cannot be joined. |
| `limit` | integer, 1 to 50 | no | `20` | The most rooms to return. |
| `offset` | integer, at least 0 | no | `0` | The nextOffset of the previous result. |

### get_room

Returns one alfaview room: its type, waiting room and welcome note, passcode setting, quotas, breakout rooms, and the features that differ from the default. The breakout rooms are in subrooms, because the API calls them subrooms.

With the option Personal data set to Leave out: Returns one alfaview room: its type, waiting room, passcode setting, quotas, breakout rooms, and the features that differ from the default. The breakout rooms are in subrooms, because the API calls them subrooms. This server leaves out personal data: the welcome note is null, and so is the name of a meeting room, which is its meeting title.

- Title: Get a room
- Annotations: `readOnlyHint: true`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `roomId` | UUID | yes | none | Room ID from find_rooms. |
| `includePasscode` | boolean | no | `false` | Also return the current passcode. It is a credential when passcodeRequired is true. |

### find_guest_links

Lists the personal alfaview guest links (invitation links for one person) of one room or of every room, newest first. Expired links come only with includeExpired: after an event, set it.

- Title: Find guest links
- Annotations: `readOnlyHint: true`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `roomId` | UUID | no | none | Room ID from find_rooms. Leave it out to search every room. |
| `emailAddress` | string of at most 320 characters | no | none | Only links for this email address, in any case. |
| `origin` | string of at most 256 characters | no | none | Only links with exactly this origin, for example Webinar 2026-10-07. |
| `includeExpired` | boolean | no | `false` | Also return links whose validUntil has passed. |
| `includeJoinUrls` | boolean | no | `false` | Also return the join URLs. A join URL is a credential: whoever has it can join as the guest. |
| `limit` | integer, 1 to 50 | no | `20` | The most guest links to return. |
| `offset` | integer, at least 0 | no | `0` | The nextOffset of the previous result. |

### find_meetings

Lists the alfaview meetings that the API key's user created, best match first. Without from and to, it lists the meetings from 1 day ago to 366 days ahead. Use get_meeting for the join URLs.

- Title: Find meetings
- Annotations: `readOnlyHint: true`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `title` | string of at most 256 characters | no | none | Only meetings whose title contains this text, in any case. |
| `from` | string of at most 64 characters | no | none | Only meetings that end at or after it. Local time in Europe/Berlin unless it has an offset, for example 2026-10-27T10:00. |
| `to` | string of at most 64 characters | no | none | Only meetings that start at or before it. Local time in Europe/Berlin unless it has an offset, for example 2026-10-27T10:00. |
| `includeCanceled` | boolean | no | `false` | Also return canceled meetings. |
| `includeEveryOccurrence` | boolean | no | `false` | Return one entry for each occurrence of a recurring meeting. By default, a recurring meeting gives one entry, with its ongoing or next occurrence. |
| `limit` | integer, 1 to 100 | no | `20` | The most meetings to return. |
| `offset` | integer, at least 0 | no | `0` | The nextOffset of the previous result. |

### get_meeting

Returns an alfaview meeting that the API key's user created, with its join URLs: one for each permission group, such as Moderator and Guest.

- Title: Get a meeting
- Annotations: `readOnlyHint: true`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `meetingId` | UUID | yes | none | Meeting ID from find_meetings or create_meeting. |

### find_room_participants

Lists the people who are in an alfaview room or its waiting room now, the longest wait first. A guest who joined with a guest link of this room comes with the email address and the guest link.

With the option Personal data set to Leave out: Lists the people who are in an alfaview room or its waiting room now, the longest wait first. A guest who joined with a guest link of this room comes with the guest link. This server leaves out personal data: names and email addresses are null.

- Title: Find the people in a room
- Annotations: `readOnlyHint: true`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `roomId` | UUID | yes | none | Room ID from find_rooms. |
| `location` | `waiting_room` or `room` | no | none | Only the people who wait to be let in, or only those in the room. Default: both. |
| `limit` | integer, 1 to 50 | no | `20` | The most people to return. |
| `offset` | integer, at least 0 | no | `0` | The nextOffset of the previous result. |

### get_room_attendance

Reports who attended an alfaview room, for example a webinar: invited people with attended or no-show and their minutes, and the email lists of attendees and no-shows. Guest links whose validity is inside the window count as invited. The window is from and to, starting less than 39 days ago, or the validity of the links with origin.

With the option Personal data set to Leave out: Reports who attended an alfaview room, for example a webinar: invited people with attended or no-show and their minutes. Guest links whose validity is inside the window count as invited. The window is from and to, starting less than 39 days ago, or the validity of the links with origin. This server leaves out personal data: the email lists of attendees and no-shows are null, and so are names and email addresses. The counts and the status per guest link remain.

- Title: Get the attendance of a room
- Annotations: `readOnlyHint: true`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `roomId` | UUID | yes | none | Room ID from find_rooms. |
| `origin` | string of at most 256 characters | no | none | Only guest links with exactly this origin count as invited, for example Webinar 2026-10-07. |
| `from` | string of at most 64 characters | no | none | Start of the window. Give from and to, or origin alone. Local time in Europe/Berlin unless it has an offset, for example 2026-10-27T10:00. |
| `to` | string of at most 64 characters | no | none | End of the window, at most 26 hours after from. Local time in Europe/Berlin unless it has an offset, for example 2026-10-27T10:00. |
| `minimumMinutes` | integer, 0 to 1440 | no | `0` | The minutes connected that count as attended. 0 counts every connection, also in the waiting room. |
| `status` | `all`, `attended` or `no_show` | no | `all` | Which invited people to list. The counts and the email lists always cover everyone. |
| `includeOtherAttendees` | boolean | no | `false` | Also list the people who attended without an invited guest link, such as users of the company. |
| `limit` | integer, 1 to 40 | no | `10` | The most invited people to return. |
| `offset` | integer, at least 0 | no | `0` | The nextOffset of the previous result. |

With the option Personal data set to Leave out, `status` reads: Which invited people to list. The counts always cover everyone. This server leaves out personal data: the email lists of attendees and no-shows are null. The counts and the status per guest link remain.

### get_guest_link_attendance

Reports whether the guest of one alfaview guest link attended, and for how long, within the link's validity or from and to. After the event the link has expired: find it with find_guest_links and includeExpired true.

- Title: Get the attendance of a guest link
- Annotations: `readOnlyHint: true`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `guestLinkId` | UUID | yes | none | Guest link ID from find_guest_links or create_guest_links. |
| `from` | string of at most 64 characters | no | none | Start of the window. Default: the link's validFrom. Local time in Europe/Berlin unless it has an offset, for example 2026-10-27T10:00. |
| `to` | string of at most 64 characters | no | none | End of the window, at most 26 hours after from. Default: the link's validUntil. Local time in Europe/Berlin unless it has an offset, for example 2026-10-27T10:00. |
| `minimumMinutes` | integer, 0 to 1440 | no | `0` | The minutes connected that count as attended. 0 counts every connection, also in the waiting room. |

### get_company_statistics

Returns the use of the alfaview company's rooms and meetings per period: how many were used, the visits, and the minutes.

- Title: Get company statistics
- Annotations: `readOnlyHint: true`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `from` | string of at most 64 characters | yes | none | Start of the time range, at most 61 days ago. Local time in Europe/Berlin unless it has an offset, for example 2026-10-27T10:00. |
| `to` | string of at most 64 characters | yes | none | End of the time range, at most 32 days after from. Local time in Europe/Berlin unless it has an offset, for example 2026-10-27T10:00. |
| `stepDurationHours` | integer, 1 to 768 | no | `24` | Hours of each period: 24 gives one period per day, and the hours between from and to give one total. |

## Level standard

The tools that change guest links, meetings and the passcode of a room.

### regenerate_room_passcode

Makes a new passcode for an alfaview room and returns it. The old passcode stops working at once, also in sent invitations. This cannot be undone.

- Title: Regenerate a room passcode
- Annotations: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `roomId` | UUID | yes | none | Room ID from find_rooms. |

### create_guest_links

Creates a personal alfaview guest link (an invitation link for one person) for each guest in a room, for example for a booking or a webinar, and returns the join URLs. Safe to repeat: a guest with a valid link of the same email address, origin, validity, permission group and dial-in setting gets that link back, without a new link or email. alfaview emails nobody unless sendEmail is true. Each result has index, the position of its guest in guests, from 0.

- Title: Create guest links
- Annotations: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `roomId` | UUID | yes | none | Room ID from find_rooms. |
| `guests` | list of 1 to 25 objects | yes | none | Each guest gets one link. |
| `guests[].emailAddress` | string of at most 320 characters | yes | none | The guest's email address. |
| `guests[].displayName` | string of at most 256 characters | yes | none | The guest's name in the room. |
| `guests[].locale` | `de-DE` or `en-US` | no | none | Overrides locale for this guest. |
| `locale` | `de-DE` or `en-US` | yes | none | Language of the join page and of alfaview's emails. |
| `validFrom` | string of at most 64 characters | no | none | The link works from this time. Local time in timezone, else in Europe/Berlin, unless it has an offset, for example 2026-10-27T10:00. |
| `validUntil` | string of at most 64 characters | no | none | The link works until this time. Give validFrom and validUntil for get_room_attendance. Local time in timezone, else in Europe/Berlin, unless it has an offset, for example 2026-10-27T10:00. |
| `permissionGroup` | string of at most 256 characters | no | none | Permission group of the guests, by name or ID. Default: Guest. For a webinar, a group without voice and video, such as Spectator. |
| `origin` | string of at most 256 characters | no | none | The event or source, for example Webinar 2026-10-07 or a booking URI. The tools match it exactly. Default: MCP. |
| `sendEmail` | boolean | no | `false` | If true, alfaview emails each new guest the link. |
| `timezone` | string of at most 64 characters | no | none | Time zone of the event and of alfaview's email. For guests in another zone, give the times with an offset and their zone here. An IANA name. It is also the zone of times without an offset and of the result. Default: Europe/Berlin. |
| `dialInAllowed` | boolean | no | `false` | If true, the guests can also join by phone. Needs dial-in in the alfaview plan. |

### update_guest_link

Changes an alfaview guest link. The join URL and the origin never change: for a Calendly reschedule (a new invitee URI), delete the link and create a new one. With sendEmail true, alfaview emails the guest on each call that gives a field other than an unchanged name, also with the same values.

- Title: Update a guest link
- Annotations: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `guestLinkId` | UUID | yes | none | Guest link ID from find_guest_links or create_guest_links. |
| `displayName` | string of at most 256 characters | no | none | The guest's name in the room. |
| `emailAddress` | string of at most 320 characters | no | none | The guest's email address. |
| `locale` | `de-DE` or `en-US` | no | none | Language of the join page and of alfaview's emails. |
| `validFrom` | string of at most 64 characters | no | none | The link works from this time. Local time in timezone, else in Europe/Berlin, unless it has an offset, for example 2026-10-27T10:00. |
| `validUntil` | string of at most 64 characters | no | none | The link works until this time. Local time in timezone, else in Europe/Berlin, unless it has an offset, for example 2026-10-27T10:00. |
| `permissionGroup` | string of at most 256 characters | no | none | Permission group of the guest, by name or ID. |
| `dialInAllowed` | boolean | no | none | If true, the guest can also join by phone. |
| `sendEmail` | boolean | no | `false` | If true, alfaview emails the guest about the change. |
| `timezone` | string of at most 64 characters | no | none | Time zone of the event and of that email. For a guest in another zone, give the times with an offset and the guest's zone here. An IANA name. It is also the zone of times without an offset and of the result. Default: Europe/Berlin. |

### delete_guest_link

Deletes an alfaview guest link: its join URL stops working at once. This cannot be undone. No email, except for a link in a meeting room (type meeting, made by create_meeting, inMeetingRoom true in find_guest_links): there the tool refuses unless sendEmail is true.

- Title: Delete a guest link
- Annotations: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `guestLinkId` | UUID | yes | none | Guest link ID from find_guest_links or create_guest_links. |
| `sendEmail` | boolean | no | `false` | Must be true for a link in a meeting room: alfaview then always emails the guest that the link was revoked. |

### delete_expired_guest_links

Deletes the alfaview guest links of one room whose validity ended at least expiredAtLeastHours ago, for example after webinars: old links slow down the guest link and attendance tools. Links without an end of validity stay. alfaview emails nobody. This cannot be undone.

- Title: Delete expired guest links
- Annotations: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `roomId` | UUID | yes | none | Room ID from find_rooms. |
| `originContains` | string of at most 256 characters | no | none | Only links whose origin contains this text, in any case, for example Webinar. |
| `expiredAtLeastHours` | integer, 1 to 8760 | no | `48` | Only links whose validUntil is at least this many hours ago. The attendance tools need the links, so keep 48 or more until the attendance is read. |
| `pageToken` | string of at most 128 characters | no | none | The nextPageToken of the previous result. |

### create_meeting

Schedules an alfaview meeting and returns it with its four join URLs (moderator, participant, guest, spectator). Only the API key's user can see, change or cancel it. For an appointment in an existing room, use create_guest_links.

- Title: Create a meeting
- Annotations: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `title` | string | yes | none | The title of the meeting. |
| `start` | string of at most 64 characters | yes | none | The start. Local time in timezone, else in Europe/Berlin, unless it has an offset, for example 2026-10-27T10:00. |
| `end` | string of at most 64 characters | yes | none | The end: after start, at most 24 hours after it, and in the future. Local time in timezone, else in Europe/Berlin, unless it has an offset, for example 2026-10-27T10:00. |
| `recurrenceRule` | string | no | none | An RFC 5545 RRULE, such as FREQ=WEEKLY;BYDAY=MO. start is the first occurrence, and end minus start the length of each. |
| `timezone` | string of at most 64 characters | no | none | Time zone for the times shown to the invitees. An IANA name. It is also the zone of times without an offset and of the result. Default: Europe/Berlin. |
| `waitingRoomEnabled` | boolean | no | `false` | If true, participants wait until a moderator lets them in. |
| `waitingRoomWelcomeNote` | string | no | none | Shown to people in the waiting room. |
| `agenda` | string | no | none | Plain text, no HTML. |
| `earlyAccessMinutes` | integer, 0 to 30 | no | none | People without moderator or administrator permissions can join this many minutes early. Moderators and administrators can always join 30 minutes early. |
| `passcodeRequired` | boolean | no | none | If true, everyone who joins must enter the room passcode. |

### update_meeting

Changes the title, time, time zone, agenda or early access of an alfaview meeting. A meeting with guest links needs sendEmail true.

- Title: Update a meeting
- Annotations: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `meetingId` | UUID | yes | none | Meeting ID from find_meetings or create_meeting. |
| `title` | string | no | none | The title of the meeting. |
| `start` | string of at most 64 characters | no | none | The start. Local time in timezone, else in Europe/Berlin, unless it has an offset, for example 2026-10-27T10:00. |
| `end` | string of at most 64 characters | no | none | The end: at most 24 hours after the start. Local time in timezone, else in Europe/Berlin, unless it has an offset, for example 2026-10-27T10:00. |
| `recurrenceRule` | string | no | none | An RFC 5545 RRULE, such as FREQ=WEEKLY;BYDAY=MO. start is the first occurrence, and end minus start the length of each. A recurring meeting cannot stop repeating. |
| `timezone` | string of at most 64 characters | no | none | Time zone for the times shown to the invitees: an IANA name. It is also the zone of times without an offset and of the result. Without it, the meeting keeps its time zone, and times without an offset are read in Europe/Berlin. |
| `agenda` | string | no | none | Plain text, no HTML. |
| `earlyAccessMinutes` | integer, 0 to 30 | no | none | People without moderator or administrator permissions can join this many minutes early. Moderators and administrators can always join 30 minutes early. |
| `sendEmail` | boolean | no | `false` | Must be true for a meeting with guest links: alfaview can email those guests about any change. |

### cancel_meeting

Cancels an alfaview meeting: nobody can join it afterwards. This cannot be undone.

- Title: Cancel a meeting
- Annotations: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `meetingId` | UUID | yes | none | Meeting ID from find_meetings or create_meeting. |
| `sendEmail` | boolean | no | `false` | If true, alfaview emails the creator and all invitees about the cancellation. |
| `reason` | string | no | none | Plain text, no HTML. alfaview puts it into the email. |

## Level manage

The tools of the account, the rooms, the room settings, the breakout rooms, the group links, the users and the room permissions.

### get_account

Returns the alfaview user and company of the API key: the user's ID, name, email address, title, city, initials and language, and the company's ID and name. Use it to check the account of this server.

With the option Personal data set to Leave out: Returns the alfaview user and company of the API key: the user's ID and language, and the company's ID and name. Use it to check the account of this server. This server leaves out personal data: the user's name, email address, title, city and initials are null.

- Title: Get the account
- Annotations: `readOnlyHint: true`, `openWorldHint: true`

The tool has no parameters.

### update_own_user

Changes the profile of the alfaview user that owns the API key: name, title, city, initials or language. It cannot change other users.

- Title: Update your own profile
- Annotations: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `firstName` | string | no | none | First name. |
| `lastName` | string | no | none | Last name. |
| `title` | string of at most 20 characters | no | none | Title, for example Dr. |
| `city` | string | no | none | City. |
| `initials` | string of at most 3 characters | no | none | Initials. |
| `locale` | `de-DE` or `en-US` | no | none | Language of alfaview's apps and emails for this user. |

### create_room

Creates an alfaview room, or a department that holds rooms, and returns it. alfaview does not detect duplicate rooms: after an error, check with find_rooms before you create it again.

- Title: Create a room
- Annotations: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `displayName` | string | yes | none | The name of the room. |
| `type` | `room` or `department` | no | `room` | A department holds rooms and cannot be joined. |
| `parentId` | UUID | no | none | The department of the room: an ID from find_rooms with type department. |
| `waitingRoomEnabled` | boolean | no | `false` | If true, people wait until a moderator lets them in. |
| `waitingRoomWelcomeNote` | string | no | none | Shown to people in the waiting room: at most 300 characters on one line. |
| `passcodeRequired` | boolean | no | none | If true, everyone who joins must enter the room passcode, which alfaview makes when the room has none. get_room with includePasscode reads it. |
| `planRoomType` | string of at most 256 characters | no | none | A room type of the company's alfaview plan, by name, for its participant limits. |

### update_room

Changes the name, waiting room, welcome note or passcode setting of an alfaview room.

- Title: Update a room
- Annotations: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `roomId` | UUID | yes | none | Room ID from find_rooms. |
| `displayName` | string | no | none | The name of the room. |
| `waitingRoomEnabled` | boolean | no | none | If true, people wait until a moderator lets them in. |
| `waitingRoomWelcomeNote` | string | no | none | Shown to people in the waiting room: at most 300 characters on one line. |
| `passcodeRequired` | boolean | no | none | If true, everyone who joins must enter the room passcode, which alfaview makes when the room has none. get_room with includePasscode reads it. |

### get_room_settings

Returns the settings of an alfaview room: transcription with its spoken and translation languages, file sharing with the storage left, and the features that differ from the default.

- Title: Get room settings
- Annotations: `readOnlyHint: true`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `roomId` | UUID | yes | none | Room ID from find_rooms. |

### update_room_settings

Changes the features, the transcription and translation, and the file sharing of an alfaview room, and returns all its settings after the change. Parts and fields that you leave out stay as they are.

- Title: Update room settings
- Annotations: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `roomId` | UUID | yes | none | Room ID from find_rooms. |
| `features` | object: each key one of `disableCameraOff`, `sixteenByNineVideos`, `centeredVideoGrid`, `allowCopyRoomInfo`, `sortVideoGridAlphabetically`, `raiseHands`, `showRaisedHandsOnlyToModerators`, `shareContentOnlyToModerators`, `blockWebclient`, `disableMiniWindow`, `disableJoinAndLeaveNotifications`, `localRecording`, `liveStreaming` or `examScreenshare`, each value `enabled`, `disabled` or `default` | no | none | default removes the room's own setting. disableCameraOff keeps cameras on. allowCopyRoomInfo lets moderators copy the participant list. blockWebclient hides the browser join for guests. examScreenshare shows the screen of each participant to the moderators: tell the participants. |
| `resetFeatures` | boolean | no | `false` | If true, each feature that features does not name goes back to the default. |
| `language` | object | no | none | While transcription runs, alfaview sends what people say to its transcription service: tell the participants. It can cost extra and needs transcription in the plan. |
| `language.transcriptionEnabled` | boolean | no | none | If true, transcription can be started in the room. If false, it stops. |
| `language.transcriptionType` | `simple_transcription` or `digital_interpreter` | no | none | digital_interpreter lets each participant choose the language they speak. simple_transcription uses defaultSpokenLanguage. |
| `language.defaultSpokenLanguage` | string of at most 35 characters | no | none | Language code of what people say in the room, for example de-DE. |
| `language.targetTranscriptionLanguages` | list of at most 50 strings of at most 35 characters | no | none | Language codes to translate into, for example ["en-US"]. The list replaces the current one, and [] removes them all. |
| `fileSharing` | object | no | none | The file sharing settings of the room. |
| `fileSharing.enabled` | boolean | no | none | If true, people can share files in the room. |
| `fileSharing.defaultAccessLevel` | `hidden`, `visible` or `downloadable` | no | none | Access of the other participants to a new file. Moderators can always download files. |
| `fileSharing.participantsCanUpload` | boolean | no | none | If false, only moderators upload files. If true, also participants, by default not guests. |

### create_breakout_room

Adds a breakout room to an alfaview room and returns its ID. Without displayName, alfaview shows a numbered name, such as Group 1. get_room lists the breakout rooms.

- Title: Create a breakout room
- Annotations: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `roomId` | UUID | yes | none | Room ID from find_rooms. |
| `displayName` | string of at most 32 characters | no | none | At most 32 bytes: 32 letters without accents, fewer with accents or emoji. |

### update_breakout_room

Renames a breakout room of an alfaview room.

- Title: Rename a breakout room
- Annotations: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `roomId` | UUID | yes | none | Room ID from find_rooms. |
| `subroomId` | UUID | yes | none | Breakout room ID from get_room or create_breakout_room. |
| `displayName` | string of at most 32 characters | yes | none | At most 32 bytes: 32 letters without accents, fewer with accents or emoji. |

### delete_breakout_room

Deletes a breakout room of an alfaview room. create_breakout_room can make it again, with a new ID.

- Title: Delete a breakout room
- Annotations: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `roomId` | UUID | yes | none | Room ID from find_rooms. |
| `subroomId` | UUID | yes | none | Breakout room ID from get_room or create_breakout_room. |

### find_group_links

Lists the alfaview group links (one join URL for many people) of one room or of every room, newest first. meetingLink marks the links of a meeting room, which the other group link tools do not change.

- Title: Find group links
- Annotations: `readOnlyHint: true`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `roomId` | UUID | no | none | Room ID from find_rooms. Leave it out to search every room. |
| `groupLinkId` | UUID | no | none | Read only this group link, also when it has expired. |
| `description` | string of at most 256 characters | no | none | Only links whose description contains this text, in any case. |
| `originContains` | string of at most 256 characters | no | none | Only links whose origin contains this text, in any case. |
| `includeExpired` | boolean | no | `false` | Also return links whose validUntil has passed. |
| `includeJoinUrls` | boolean | no | `false` | Also return the join URLs. A join URL is a credential: whoever has it joins with the rights of its permission group. |
| `limit` | integer, 1 to 50 | no | `20` | The most group links to return. |
| `offset` | integer, at least 0 | no | `0` | The nextOffset of the previous result. |

### create_group_link

Creates an alfaview group link and returns its join URL, which many people share with the rights of one permission group, for example for an open event. Attendance data cannot tell these people apart: for personal invitations, use create_guest_links. alfaview emails nobody.

- Title: Create a group link
- Annotations: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `roomId` | UUID | yes | none | Room ID from find_rooms. Not a meeting ID. |
| `description` | string of at most 256 characters | yes | none | Shown in the list of links in alfaview, for example Open house. |
| `permissionGroup` | string of at most 256 characters | yes | none | Permission group of everyone who joins with the link, by name or ID, for example Participant, or Spectator for a webinar. With a moderator group, everyone who has the join URL can moderate. |
| `validFrom` | string of at most 64 characters | no | none | The link works from this time. Local time in Europe/Berlin unless it has an offset, for example 2026-10-27T10:00. |
| `validUntil` | string of at most 64 characters | no | none | The link works until this time. Local time in Europe/Berlin unless it has an offset, for example 2026-10-27T10:00. |
| `dialInAllowed` | boolean | no | `false` | If true, people can also join by phone. Needs dial-in in the alfaview plan. |
| `origin` | string of at most 256 characters | no | none | The source or event, for example Open house 2026-10-07. find_group_links filters by it. Default: MCP. |

### update_group_link

Changes the description, validity, permission group or dial-in setting of an alfaview group link. The join URL stays the same, so a change applies to everyone who has it. alfaview emails nobody.

- Title: Update a group link
- Annotations: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `groupLinkId` | UUID | yes | none | Group link ID from find_group_links or create_group_link. |
| `description` | string of at most 256 characters | no | none | Shown in the list of links in alfaview. |
| `validFrom` | string of at most 64 characters | no | none | The link works from this time. Local time in Europe/Berlin unless it has an offset, for example 2026-10-27T10:00. |
| `validUntil` | string of at most 64 characters | no | none | The link works until this time. A time in the past turns the link off. Local time in Europe/Berlin unless it has an offset, for example 2026-10-27T10:00. |
| `permissionGroup` | string of at most 256 characters | no | none | Permission group of everyone who joins with the link, by name or ID. |
| `dialInAllowed` | boolean | no | none | If true, people can also join by phone. |

### delete_group_link

Deletes an alfaview group link: its join URL stops working at once for everyone who has it. This cannot be undone: a new link has a new join URL. To close a link for a while, give update_group_link a validUntil in the past. alfaview emails nobody.

- Title: Delete a group link
- Annotations: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `groupLinkId` | UUID | yes | none | Group link ID from find_group_links or create_group_link. |

### find_users

Lists the users of the alfaview company by last name, with their IDs for the other tools. Filter by name or email address.

With the option Personal data set to Leave out: Lists the users of the alfaview company by last name, with their IDs for the other tools. Filter by name or email address: the filters still match. This server leaves out personal data: names, titles and email addresses are null.

- Title: Find users
- Annotations: `readOnlyHint: true`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `name` | string of at most 256 characters | no | none | Part of the first or last name, in any case. |
| `emailAddress` | string of at most 320 characters | no | none | Only the user with this email address, in any case. |
| `limit` | integer, 1 to 100 | no | `50` | The most users to return. |
| `offset` | integer, at least 0 | no | `0` | The nextOffset of the previous result. |

### find_room_permissions

Lists the users who have a room permission in an alfaview room, with the nine permissions of each, such as admin and join. A user without one gets the room's default permissions, if it has any. Guest links and group links are only counted.

With the option Personal data set to Leave out: Lists the users who have a room permission in an alfaview room, with the nine permissions of each, such as admin and join. A user without one gets the room's default permissions, if it has any. Guest links and group links are only counted. This server leaves out personal data: userName is null.

- Title: Find room permissions
- Annotations: `readOnlyHint: true`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `roomId` | UUID | yes | none | Room ID from find_rooms. |
| `userId` | UUID | no | none | Only this user: a user ID from find_users. |
| `limit` | integer, 1 to 100 | no | `50` | The most room permissions to return. |
| `offset` | integer, at least 0 | no | `0` | The nextOffset of the previous result. |

## Level full

The tools that cannot be undone or that change who has access to rooms. The level needs `ALFAVIEW_DANGEROUSLY_ALLOW_FULL_ACCESS`.

### add_room_permission

Changes who has access: gives a user of the alfaview company a room permission: the nine permissions of permissionGroup, and each permission that you give overrides one. With admin, the user can delete the room. If the user has one already, use update_room_permission. Call it only when the user asked for it.

- Title: Add a room permission
- Annotations: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `roomId` | UUID | yes | none | Room ID from find_rooms. |
| `userId` | UUID | yes | none | User ID from find_users. |
| `permissionGroup` | string of at most 256 characters | yes | none | Permission group that gives the nine permissions, by name or ID, for example Moderator. |
| `admin` | boolean | no | none | Can change and delete the room, its settings and guests. |
| `join` | boolean | no | none | Can join the room. |
| `voice` | boolean | no | none | Can speak. |
| `video` | boolean | no | none | Can send video. |
| `screen` | boolean | no | none | Can share the screen. |
| `chat` | boolean | no | none | Can chat. |
| `upload` | boolean | no | none | Can upload files. |
| `promote` | boolean | no | none | Can change the permissions of others. |
| `vip` | boolean | no | none | Can mark people as VIP. |

### update_room_permission

Changes who has access: changes the room permission of a user in an alfaview room. Without join the user cannot enter the room, and with admin the user can delete it. Call it only when the user asked for it.

- Title: Change a room permission
- Annotations: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `roomId` | UUID | yes | none | Room ID from find_rooms. |
| `userId` | UUID | yes | none | User ID from find_users. |
| `admin` | boolean | no | none | Can change and delete the room, its settings and guests. |
| `join` | boolean | no | none | Can join the room. |
| `voice` | boolean | no | none | Can speak. |
| `video` | boolean | no | none | Can send video. |
| `screen` | boolean | no | none | Can share the screen. |
| `chat` | boolean | no | none | Can chat. |
| `upload` | boolean | no | none | Can upload files. |
| `promote` | boolean | no | none | Can change the permissions of others. |
| `vip` | boolean | no | none | Can mark people as VIP. |

### remove_room_permission

Changes who has access: removes the room permission of a user from an alfaview room. The user keeps only the room's default permissions, if any. add_room_permission can give back the removed permissions of the result. Call it only when the user asked for it.

- Title: Remove a room permission
- Annotations: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `roomId` | UUID | yes | none | Room ID from find_rooms. |
| `userId` | UUID | yes | none | User ID from find_users. |

### invite_user

Changes who has access: invites a person to the alfaview company as a user, with the permissions that you give. An invitation cannot be taken back. Call it only when the user asked for it.

- Title: Invite a user
- Annotations: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `emailAddress` | string of at most 320 characters | yes | none | The address of the invitation. |
| `firstName` | string of at most 256 characters | yes | none | The first name. |
| `lastName` | string of at most 256 characters | yes | none | The last name. |
| `title` | string of at most 20 characters | no | none | For example Dr. |
| `locale` | `de-DE` or `en-US` | no | none | The user's language in alfaview. |
| `manageCompany` | boolean | no | `false` | Can change the company settings. Includes userAdmin, roomAdmin and userShow. |
| `userAdmin` | boolean | no | `false` | Can add, change and delete other users. Includes userList. |
| `userList` | boolean | no | `false` | Can see all users of the company. |
| `userShow` | boolean | no | `false` | Sees the names of all users in the rooms they can access. |
| `roomAdmin` | boolean | no | `false` | Can create, change and delete every room. Includes roomList and roomCreate. |
| `roomList` | boolean | no | `false` | Can see all rooms of the company. |
| `roomCreate` | boolean | no | `false` | Can create rooms. |
| `sendEmail` | boolean | yes | none | Must be true: alfaview always emails the invitation. |

### delete_user

Cannot be undone: deletes a user of the alfaview company. The user can no longer sign in, also not with an API key, and access can last up to one hour. Rooms and room permissions of the user stay. The server asks the person to confirm.

- Title: Delete a user
- Annotations: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `userId` | UUID | yes | none | User ID from find_users. |
| `confirmEmailAddress` | string of at most 320 characters | no | none | Only for a client that cannot ask the person: the email address, as the person named it (any case). |

With the option Personal data set to Leave out, `confirmEmailAddress` reads: Only for a client that cannot ask the person: the email address, as the person named it (any case). Results leave it out.

### delete_room

Cannot be undone: deletes an alfaview room or department. alfaview disconnects everyone in it and deletes its breakout rooms, guest links, group links, files and polls. The server asks the person to confirm. Meeting rooms are refused: use cancel_meeting.

- Title: Delete a room
- Annotations: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: true`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `roomId` | UUID | yes | none | Room or department ID from find_rooms. |
| `confirmRoomName` | string of at most 256 characters | no | none | Only for a client that cannot ask the person: the room name, as the person named it (any case). |
