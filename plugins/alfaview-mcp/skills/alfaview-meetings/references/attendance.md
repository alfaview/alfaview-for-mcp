# Attendance

Attendance reports, the guests of an event, and the use of the rooms of the company.

## Who is in a room now

1. Find the room with `find_rooms`.
2. Call `find_room_participants`. For the people who wait, set the location to the waiting room.

- The result shows the room at the time of the call.
- For the time that each person waited, compare the times of the result with the time now. Use
  the time now that the person gives.

## Who attended an event

1. Find the room with `find_rooms`.
2. Call `get_room_attendance` with the origin of the event. Without an origin, give the start and
   the end of the event.
3. For a minimum time, such as "at least 15 minutes", give its minutes as `minimumMinutes`.

- A person can have two or more guest links for one event. The result lists each invited person
  once, with all of their guest links in `guestLinkIds`. `totalMinutes` and `status` already cover
  every link of that email address, and `attendedEmails` and `noShowEmails` follow that status.
  Use these values as they are. Do not add the minutes of the links again.
- Compare email addresses in lower case.
- To find the guests of one event who did not register for the next one, read the attendance of
  the first event. Then read the guest links of the next event with `find_guest_links` and its
  origin, and compare the two lists.

## One guest

1. Find the guest link with `find_guest_links`. After the event, include the expired links.
2. Call `get_guest_link_attendance` with the ID of the link.

- Without the email address of the guest, list the links of the room, and find the guest by the
  name.
- The result adds the minutes of all sessions of the link. Give the total, and the number of
  sessions when there is more than one.

## The guests of an event

- Find the links with `find_guest_links` and the origin of the event.
- Read every page before you count or list: call again with the offset of `nextOffset` until it is
  `null`. For a count of all matches, read `totalMatches`.
- When one origin covers more than one date, group the links by the day of their validity.

## The use of the rooms

- `get_company_statistics` needs the user permission Manage Company. When the call fails for this
  reason, give the person the message.
- A day of a report runs from 00:00 to 00:00 of the next day, in the time zone of the person. For
  the total of one day, give a step of 24 hours.
- The result gives the figures of the rooms and of the meetings apart. Give the figures that the
  person asks for.
