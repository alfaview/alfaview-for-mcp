# Cleanup

Delete old guest links and close group links. A delete of a link cannot be undone.

## Expired guest links

1. List the rooms with `find_rooms`. For a cleanup of all rooms, read every page.
2. Call `delete_expired_guest_links` for each room, one room at a time.
3. Give the source of the links in `originContains`, such as `calendly` for the bookings of
   Calendly or `Webinar` for webinars. Without it, the call deletes the expired links of every
   source.
4. Call it again with the same input while `remainingCount` is above 0. Then call it with
   `pageToken` while the result gives a `nextPageToken`.

- By default, the tool keeps a link for 48 hours after its end, so that the attendance of the
  event stays readable. When the person asks to delete the links of appointments that are over,
  that ended or that are in the past, set `expiredAtLeastHours` to 1. Keep the default only for a
  request without such a condition, such as "delete the old links". Read the attendance first
  when the person still needs it.
- A link without an end of its validity stays. A link of a booking that runs now or later has not
  expired, so it stays too.
- The tool refuses a meeting room, because alfaview emails each guest there. Delete such a link
  with `delete_guest_link` only when the person accepts that email.
- In the answer, give the number of deleted links for each room, and name each room that the
  cleanup did not change.

## One guest link

Call `delete_guest_link` for one link, such as the link of a canceled booking
([invitations.md](invitations.md)).

## Group links

- To close a group link and keep it for later, give `update_group_link` an end of the validity in
  the past.
  For a link that starts later, also give a start in the past.
- `delete_group_link` ends the join URL for everyone who has it. A new link gets a new join URL.
