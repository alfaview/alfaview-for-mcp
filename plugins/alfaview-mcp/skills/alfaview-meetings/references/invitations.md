# Invitations

Guest links for appointments, bookings and webinars, meetings, and the time zones of both.

## An appointment or a booking

1. Find the room of the advisor with `find_rooms`. One search for each room is enough.
2. Call `create_guest_links` with one guest. Give the booking ID or the booking URL as the origin,
   so that a later cancel finds this one link.
3. Give a validity from 15 minutes before the start to 30 minutes after the end.

- The language of the guest link: when the request does not name it, choose it from the request,
  and name it in the answer.
- A canceled booking: find the link with `find_guest_links`, with the email address and the origin
  of the booking. Then call `delete_guest_link`. A search without the origin finds every link of
  the person.
- A moved booking with a new booking ID: delete the old link and create a new one. The guest then
  gets a new join URL.
- A moved booking with the same booking ID: change the validity with `update_guest_link`.

## A webinar

- Give all guests of one webinar the same origin, such as `Webinar 2026-10-07`, and the same
  validity. The attendance report and the cleanup find the guests by this origin.
- For guests who only watch, without camera and microphone, give the permission group Spectator.
- Remove the duplicate email addresses of the list first, in any case. Count each person once.
- Send at most 25 guests in one call. Send a longer list in parts, with the same origin and
  validity.

## A meeting

- `create_meeting` makes the meeting, its meeting room and a join URL for each permission group.
  Give the person the join URL of the group that they ask for, such as Participant. Everyone with
  the moderator join URL can moderate the meeting.
- Set the title and the time before you create guest links for the meeting. After that, each
  update of the meeting emails its guests.
- For personal links, call `create_guest_links` with the meeting ID as the room ID. Give the
  validity as for an appointment, and the time zone of the meeting.
- Before a change, read the number of guest links of the meeting. `find_meetings` gives it, and
  `get_meeting` gives it for a recurring meeting.
- A meeting with guest links changes only with an email to its guests. When the request does not
  allow that email, ask the person first.
- To move a meeting, give `update_meeting` the new start and the new end. Keep the length when
  the person asks only for a new start.
- Add a recurrence rule only when the person asks for a series. alfaview cannot remove the rule
  later.
- The tools see only the meetings of the alfaview user of the API key. When `find_meetings` does
  not find a meeting, say so.
- At the level `standard`, the tools refuse to change or cancel a meeting that another system
  manages, such as a calendar add-in. That system can write its own values back over a change.
  Tell the person, and do not change the meeting in another way.

## Time zones

- A time without an offset is in the time zone of the call: the `timezone` of the tool, else the
  time zone of the server. The server uses the setting Time zone, else Europe/Berlin.
- When the person names another time zone, such as New York time, give its IANA name, such as
  `America/New_York`, in `timezone`. A tool without `timezone` needs each time with an offset.
- When the person asks for a time in another time zone, convert the time of the result with the
  offsets of that date ([The answer](../SKILL.md#the-answer)). Name both time zones.

## The passcode of a room

- `get_room` gives the passcode only when the call asks for it. The passcode is a credential.
- Call `regenerate_room_passcode` only when the person asks for a new passcode. The old passcode
  then ends, also for the people who have it in an invitation.
