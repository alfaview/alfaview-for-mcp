// The group link tools of the level `manage`. At every level, the three writes refuse a meeting
// room, whose group links give the meeting its join URLs. create_group_link and update_group_link
// also refuse a permission group with admin. alfaview sends no email for a group link.
import * as z from 'zod';
import { invalidInput, readAfterSavedWrite, sendCreate, ToolError } from '../alfaview/errors.ts';
import {
  ADMIN_GROUP_LINK_MESSAGE,
  ADMIN_GROUP_MESSAGE,
  filterGroupLinks,
  getGroupLink,
  GROUP_LINK_ALONE_MESSAGE,
  GROUP_LINK_DELETE_NOT_FOUND_MESSAGE,
  GROUP_LINK_ID_MISSING_MESSAGE,
  GROUP_LINK_PAST_VALID_UNTIL_MESSAGE,
  GROUP_LINK_STARTS_LATER_MESSAGE,
  GROUP_LINK_UNCERTAIN_MESSAGE,
  groupLinkCreatedButNotReadMessage,
  groupLinkPath,
  groupLinksPath,
  groupLinkUpdatedButNotReadMessage,
  listGroupLinks,
  mapGroupLink,
  refuseMeetingRoom,
  roomGroupLinkPath,
  roomOfGroupLink,
} from '../domain/groupLinks.ts';
import { checkValidity, createdLinkId, DEFAULT_ORIGIN } from '../domain/guestLinks.ts';
import {
  groupNamesById,
  listPermissionGroups,
  readGroupNames,
  refuseAdminGroup,
  refuseStoredAdminGroup,
  resolvePermissionGroup,
  type PermissionGroup,
} from '../domain/permissionGroups.ts';
import { compact, readDateTime } from '../values/inputs.ts';
import { normalizeTimestamp } from '../values/time.ts';
import { GROUP_LINK, GROUP_LINK_WITHOUT_URL, LIST_PART, toolOutput } from './outputs.ts';
import {
  count,
  CREATE_ANNOTATIONS,
  dateTimeParameter,
  defineTool,
  groupLinkIdParameter,
  IDEMPOTENT_CHANGE_ANNOTATIONS,
  limitParameter,
  listPart,
  offsetParameter,
  READ_ANNOTATIONS,
  roomIdNotMeetingWith,
  roomIdWith,
  showing,
  textParameter,
  validity,
} from './tool.ts';

/**
 * Returns the permission group that `value` names, and refuses a group with admin: everyone with
 * the join URL could change and delete the room.
 */
function linkGroup(value: string, groups: readonly PermissionGroup[]): PermissionGroup {
  const group = resolvePermissionGroup(value, groups);
  refuseAdminGroup(group, ADMIN_GROUP_MESSAGE);
  return group;
}

const VALIDITY_ORDER_MESSAGE = 'validUntil must be after validFrom.';

/**
 * Refuses a validity that alfaview refuses with 422: a validUntil that is not after its validFrom,
 * equal times included. A validUntil in the past is allowed: it turns the link off.
 */
function checkOrder(
  validFrom: string | undefined,
  validUntil: string | undefined,
  message = VALIDITY_ORDER_MESSAGE,
): void {
  if (
    validFrom !== undefined &&
    validUntil !== undefined &&
    Date.parse(validUntil) <= Date.parse(validFrom)
  ) {
    throw invalidInput(message);
  }
}

// find_group_links

export const findGroupLinksTool = defineTool({
  name: 'find_group_links',
  level: 'manage',
  title: 'Find group links',
  description:
    'Lists the alfaview group links (one join URL for many people) of one room or of every room, newest first. meetingLink marks the links of a meeting room, which the other group link tools do not change.',
  inputSchema: z.strictObject({
    roomId: roomIdWith('Room ID from find_rooms. Leave it out to search every room.').optional(),
    groupLinkId: groupLinkIdParameter
      .describe('Read only this group link, also when it has expired.')
      .optional(),
    description: textParameter(
      'Only links whose description contains this text, in any case.',
      256,
    ).optional(),
    originContains: textParameter(
      'Only links whose origin contains this text, in any case.',
      256,
    ).optional(),
    includeExpired: z
      .boolean()
      .default(false)
      .describe('Also return links whose validUntil has passed.'),
    includeJoinUrls: z
      .boolean()
      .default(false)
      .describe(
        'Also return the join URLs. A join URL is a credential: whoever has it joins with the rights of its permission group.',
      ),
    limit: limitParameter('group links', 50, 20),
    offset: offsetParameter(),
  }),
  annotations: READ_ANNOTATIONS,
  personalData: { shape: 'mcp.groupLink', list: 'links' },
  output: toolOutput({
    roomId: z.string().nullable(),
    ...LIST_PART,
    expiredMatchCount: z.int(),
    links: z.array(GROUP_LINK),
  }),
  async run(input, { api, now, timeZone }) {
    const filters = [input.roomId, input.description, input.originContains];
    if (input.groupLinkId !== undefined && filters.some((value) => value !== undefined)) {
      throw invalidInput(GROUP_LINK_ALONE_MESSAGE);
    }
    // One link by its ID is returned also when it has expired.
    const { links, expiredMatchCount } =
      input.groupLinkId === undefined
        ? filterGroupLinks(
            await listGroupLinks(api, input.roomId),
            {
              description: input.description,
              originContains: input.originContains,
              includeExpired: input.includeExpired,
            },
            now,
          )
        : { links: [await getGroupLink(api, input.groupLinkId)], expiredMatchCount: 0 };
    const part = listPart(links, input.offset, input.limit);
    const names = part.items.length > 0 ? await readGroupNames(api) : new Map<string, string>();
    const options = {
      timeZone,
      includeRoomId: input.roomId === undefined,
      includeJoinUrl: input.includeJoinUrls,
    };
    const found =
      part.totalMatches === 0 ? 'no group links' : count(part.totalMatches, 'group link');
    const warnings =
      !input.includeExpired && expiredMatchCount > 0
        ? [
            `${count(expiredMatchCount, 'expired group link')} also ${expiredMatchCount === 1 ? 'matches' : 'match'}. Call again with includeExpired true.`,
          ]
        : [];
    return {
      summary: `Found ${found}.${showing(part)}`,
      warnings,
      data: {
        roomId: input.roomId ?? null,
        totalMatches: part.totalMatches,
        expiredMatchCount,
        offset: part.offset,
        nextOffset: part.nextOffset,
        links: part.items.map((link) => mapGroupLink(link, names, options)),
      },
    };
  },
});

// create_group_link

export const createGroupLinkTool = defineTool({
  name: 'create_group_link',
  level: 'manage',
  title: 'Create a group link',
  description:
    'Creates an alfaview group link and returns its join URL, which many people share with the rights of one permission group, for example for an open event. Attendance data cannot tell these people apart: for personal invitations, use create_guest_links. alfaview emails nobody.',
  inputSchema: z.strictObject({
    roomId: roomIdNotMeetingWith('Room ID from find_rooms. Not a meeting ID.'),
    // At most 256 characters, so that a full page of find_group_links stays small.
    description: textParameter(
      'Shown in the list of links in alfaview, for example Open house.',
      256,
    ),
    // Required: everyone with the URL gets its rights, so the model must choose them.
    permissionGroup: textParameter(
      'Permission group of everyone who joins with the link, by name or ID, for example Participant, or Spectator for a webinar. With a moderator group, everyone who has the join URL can moderate.',
      256,
    ),
    // Group links have no time zone in alfaview and no email, so the tool has no `timezone`
    // parameter.
    validFrom: dateTimeParameter('The link works from this time.', 'server').optional(),
    validUntil: dateTimeParameter('The link works until this time.', 'server').optional(),
    dialInAllowed: z
      .boolean()
      .default(false)
      .describe('If true, people can also join by phone. Needs dial-in in the alfaview plan.'),
    origin: textParameter(
      'The source or event, for example Open house 2026-10-07. find_group_links filters by it. Default: MCP.',
      256,
    ).optional(),
  }),
  annotations: CREATE_ANNOTATIONS,
  personalData: { shape: 'mcp.groupLink' },
  output: toolOutput(GROUP_LINK.shape),
  readTool: 'find_group_links',
  async run(input, { api, now, timeZone }) {
    refuseMeetingRoom(input.roomId);
    const validFrom = readDateTime(input.validFrom, 'validFrom', timeZone);
    const validUntil = readDateTime(input.validUntil, 'validUntil', timeZone);
    checkValidity(validFrom, validUntil, now, GROUP_LINK_PAST_VALID_UNTIL_MESSAGE);

    // The model cannot learn a group ID, so the tool resolves a group name before the create.
    const groups = await listPermissionGroups(api);
    const group = linkGroup(input.permissionGroup, groups);

    // alfaview can answer 500 after it saved the link, so an answer that leaves the outcome open
    // says that the link may exist.
    const answer = await sendCreate<unknown>(
      api,
      {
        method: 'POST',
        path: groupLinksPath(input.roomId),
        body: {
          create: [
            compact({
              description: input.description,
              permissionGroupId: group.id,
              dialInAllowed: input.dialInAllowed,
              validFrom,
              validUntil,
            }),
          ],
          origin: input.origin ?? DEFAULT_ORIGIN,
        },
        // The body holds the origin, which Leave out removes, so a 422 then names the fields only.
        personalInput: true,
      },
      GROUP_LINK_UNCERTAIN_MESSAGE,
    );
    const groupLinkId = createdLinkId(answer.data);
    if (groupLinkId === undefined) {
      throw new ToolError('InvalidResponse', GROUP_LINK_ID_MISSING_MESSAGE, answer.status);
    }

    // The link exists, whatever the error: the read back must never ask for a second create.
    const link = await readAfterSavedWrite(
      () => getGroupLink(api, groupLinkId),
      groupLinkCreatedButNotReadMessage(groupLinkId),
    );
    return {
      summary: `Created group link ${link.id} in room ${input.roomId}, ${validity(link.validFrom, link.validUntil, timeZone)}. The join URL is in the result. alfaview sent no email.`,
      data: mapGroupLink(link, groupNamesById(groups), { timeZone }),
    };
  },
});

// update_group_link

export const updateGroupLinkTool = defineTool({
  name: 'update_group_link',
  level: 'manage',
  title: 'Update a group link',
  description:
    'Changes the description, validity, permission group or dial-in setting of an alfaview group link. The join URL stays the same, so a change applies to everyone who has it. alfaview emails nobody.',
  inputSchema: z.strictObject({
    groupLinkId: groupLinkIdParameter,
    description: textParameter('Shown in the list of links in alfaview.', 256).optional(),
    validFrom: dateTimeParameter('The link works from this time.', 'server').optional(),
    validUntil: dateTimeParameter(
      'The link works until this time. A time in the past turns the link off.',
      'server',
    ).optional(),
    permissionGroup: textParameter(
      'Permission group of everyone who joins with the link, by name or ID.',
      256,
    ).optional(),
    dialInAllowed: z
      .boolean()
      .describe('If true, people can also join by phone.')
      .optional(),
  }),
  annotations: IDEMPOTENT_CHANGE_ANNOTATIONS,
  personalData: { shape: 'mcp.groupLink' },
  output: toolOutput(GROUP_LINK_WITHOUT_URL.shape),
  readTool: 'find_group_links',
  async run(input, { api, timeZone }) {
    const fields = [
      input.description,
      input.validFrom,
      input.validUntil,
      input.permissionGroup,
      input.dialInAllowed,
    ];
    if (fields.every((value) => value === undefined)) {
      throw invalidInput('Give at least one field to change.');
    }
    const validFrom = readDateTime(input.validFrom, 'validFrom', timeZone);
    const validUntil = readDateTime(input.validUntil, 'validUntil', timeZone);
    checkOrder(validFrom, validUntil);

    // The link comes first, for the guard of a meeting room and the stored bounds.
    const current = await getGroupLink(api, input.groupLinkId);
    refuseMeetingRoom(roomOfGroupLink(current));
    // A new bound is checked against the stored other one, which alfaview refuses with 422 when
    // reversed. A stored time before 1971 is no bound. A validUntil alone that is not after the
    // stored validFrom cannot turn the link off, so its error asks for a validFrom too.
    if (validFrom !== undefined || validUntil !== undefined) {
      checkOrder(
        validFrom ?? normalizeTimestamp(current.validFrom) ?? undefined,
        validUntil ?? normalizeTimestamp(current.validUntil) ?? undefined,
        validFrom === undefined ? GROUP_LINK_STARTS_LATER_MESSAGE : VALIDITY_ORDER_MESSAGE,
      );
    }

    // Without a new group, the stored group decides: a new validity of a link with admin would turn
    // its join URL on again or keep it on for longer.
    const groups = await listPermissionGroups(api);
    let permissionGroupId: string | undefined;
    if (input.permissionGroup === undefined) {
      refuseStoredAdminGroup(current.permissionGroupId, groups, ADMIN_GROUP_LINK_MESSAGE);
    } else {
      permissionGroupId = linkGroup(input.permissionGroup, groups).id;
    }
    const names = groupNamesById(groups);

    await api.request({
      method: 'PATCH',
      path: groupLinkPath(input.groupLinkId),
      body: compact({
        description: input.description,
        validFrom,
        validUntil,
        permissionGroupId,
        dialInAllowed: input.dialInAllowed,
      }),
    });

    // The change is saved: a failed read back must not read as a failed change.
    const stored = await readAfterSavedWrite(
      () => getGroupLink(api, input.groupLinkId),
      groupLinkUpdatedButNotReadMessage(input.groupLinkId),
    );
    // The result has no join URL, which a change does not need: find_group_links gives it.
    return {
      summary: `Updated group link ${stored.id}, ${validity(stored.validFrom, stored.validUntil, timeZone)}. Its join URL stays the same. alfaview sent no email.`,
      data: mapGroupLink(stored, names, { timeZone, includeJoinUrl: false }),
    };
  },
});

// delete_group_link

export const deleteGroupLinkTool = defineTool({
  name: 'delete_group_link',
  level: 'manage',
  title: 'Delete a group link',
  description:
    'Deletes an alfaview group link: its join URL stops working at once for everyone who has it. This cannot be undone: a new link has a new join URL. To close a link for a while, give update_group_link a validUntil in the past. alfaview emails nobody.',
  inputSchema: z.strictObject({ groupLinkId: groupLinkIdParameter }),
  annotations: IDEMPOTENT_CHANGE_ANNOTATIONS,
  // The result holds IDs only.
  personalData: { shape: 'mcp.groupLink' },
  output: toolOutput({ groupLinkId: z.string(), roomId: z.string(), deleted: z.boolean() }),
  readTool: 'find_group_links',
  async run(input, { api }) {
    // alfaview answers 404 also for a link that it hides from the API key's user, so a 404 is no
    // delete.
    const link = await getGroupLink(api, input.groupLinkId, { allowNotFound: true });
    if (link === undefined) {
      throw new ToolError('NotFound', GROUP_LINK_DELETE_NOT_FOUND_MESSAGE, 404);
    }
    // The room comes from the link: in another room, alfaview answers 204 and deletes nothing.
    const roomId = roomOfGroupLink(link);
    refuseMeetingRoom(roomId);

    await api.request({ method: 'DELETE', path: roomGroupLinkPath(roomId, input.groupLinkId) });
    return {
      summary: `Deleted group link ${input.groupLinkId} of room ${roomId}. Its join URL no longer works for anyone. alfaview sent no email.`,
      data: { groupLinkId: input.groupLinkId, roomId, deleted: true },
    };
  },
});

/** The group link tools, in the order of the tool list. */
export const GROUP_LINK_TOOLS = [
  findGroupLinksTool,
  createGroupLinkTool,
  updateGroupLinkTool,
  deleteGroupLinkTool,
] as const;
