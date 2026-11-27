# Work with appointments and webinars

Get a list of the people who wait in a room, an attendance report or guest links from one request
to the AI assistant.

## Before you start

- A server entry at the level `standard` ([Set up your AI assistant](clients.md)).
- The room permissions Admin and Join for the alfaview user of the API key, in each room that the
  assistant works in
  ([The alfaview user and its permissions](configuration.md#the-alfaview-user-and-its-permissions)).

## See who waits in a room

An advisor wants to know who waits before the next appointment and asks: "Who waits in my room?"

1. The assistant calls `find_rooms` for the room.
2. The assistant calls `find_room_participants` with `location` `waiting_room`.

The answer lists the people who wait, the longest wait first. For each guest who came with a guest
link of the room, it also gives the email address. With the option Personal data set to Leave out,
the answer lists the same people by ID and time. It gives no names and no email addresses
([Personal data](data-protection.md#personal-data)).

## Report who attended a webinar

The webinar is over, and the trainer asks: "Who attended yesterday's webinar, and who missed it?"

1. The assistant calls `find_rooms` for the webinar room.
2. The assistant calls `get_room_attendance` for the time of the webinar.

The report lists each invited person as attended or no-show, with their minutes. It also gives the
email lists of the attendees and the no-shows, ready to tag in an email tool. With the option
Personal data set to Leave out, the report keeps the counts and the status of each invited person.
The email lists are then `null`, so tagging by email address needs Include.

## Flows for appointments and webinars

Each flow gives the tool calls of an AI assistant for one job. Give the booking ID or URL of the
booking tool as `origin`. The tools match the origin exactly, so flow B finds the link of that one
booking.

| Flow | Calls |
| --- | --- |
| A. A new booking | `find_rooms` for the advisor room (once), then `create_guest_links` with one guest, the booking ID or URL as `origin`, the start minus 15 minutes as `validFrom` and the end plus 30 minutes as `validUntil`. |
| B. A canceled booking | `find_guest_links` with the email address and the booking as `origin`, then `delete_guest_link`. Never search without the origin: that finds every link of the person. |
| C. A moved booking | Some booking tools cancel the booking and make a new one with a new ID. The calls are then flow B with the old ID and flow A with the new one. The guest gets a new join URL. |
| D. Attendance of an appointment | `find_guest_links` with `includeExpired` true, then `get_guest_link_attendance` with `minimumMinutes`. |
| E. Webinar registration | `create_guest_links` with up to 25 registrants in each call, `permissionGroup` Spectator, and the same `origin` (for example `Webinar 2026-10-07`) and validity for all. Repeat a call that ends with `uncertain` or `not_attempted` guests with the same input. |
| F. Webinar tagging | After the webinar, `get_room_attendance` with the `origin` and `minimumMinutes`. Tag the people of `attendedEmails` and `noShowEmails` in an email tool. Above 400 invited people, these lists are `null` ([Attendance](limits.md#attendance)). |
| G. Waiting room check | `find_room_participants` with `location` `waiting_room`. |
| H. Cleanup | `delete_expired_guest_links` for each room, with `originContains` (for example `Webinar`, or the host name in the booking URLs). Again with the same input while `remainingCount` is not 0, then with `pageToken` while the result gives a `nextPageToken`. |

A job without a person, such as the cleanup, gets a server entry of its own
([Runs without a person](access-levels.md#runs-without-a-person)).

## Check the result

The log of the server has one line for each tool call, with the name of the tool and its outcome
([Read the log](troubleshooting.md#read-the-log)).

## Next steps

- [Tools](tools.md): the parameters of each tool.
- [Limits](limits.md): the limits of the guest links, the attendance and the times.
- [Data protection](data-protection.md): what the answers hold, and the option Personal data.
