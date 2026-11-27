// The user tools: find_users of the level `manage`, and invite_user and delete_user of the level
// `full`. Only invite_user makes alfaview send an email, and it needs sendEmail true.
import * as z from 'zod';
import { invalidInput, ToolError } from '../alfaview/errors.ts';
import {
  CONFIRM_EMAIL_MISSING_MESSAGE,
  confirmEmailMessage,
  deleteUser,
  EMAIL_ADDRESS_FIELD,
  EMAIL_MISMATCH_WARNING,
  findInvitedUser,
  hasAnEmailAddress,
  hasEmailAddress,
  INVITE_EMAIL_MESSAGE,
  INVITED_NOT_LISTED_WARNING,
  inviteUser,
  isUserId,
  listUsers,
  mapListedUser,
  NOT_A_USER_ID_MESSAGE,
  ONLY_API_KEY_USER_WARNING,
  readApiKeyUserId,
  sameId,
  selfDeleteMessage,
  USER_EXISTS_MESSAGE,
  userDeleteQuestion,
  userNotListedMessage,
  usersMatching,
  userWithoutAddressMessage,
  type ApiUser,
} from '../domain/users.ts';
import {
  byUserName,
  INVITE_PERMISSIONS,
  invitedUserOutput,
  LOCALES,
  type InvitePermissionKey,
} from '../shared/users.ts';
import { CONFIRMATION_OUTCOMES, confirmationNote, keptWarning } from './confirmation.ts';
import { INVITED_USER, LIST_PART, LISTED_USER, toolOutput } from './outputs.ts';
import {
  count,
  CREATE_ANNOTATIONS,
  defineTool,
  IDEMPOTENT_CHANGE_ANNOTATIONS,
  limitParameter,
  listed,
  listPart,
  offsetParameter,
  READ_ANNOTATIONS,
  showing,
  textParameter,
  userIdParameter,
} from './tool.ts';

// find_users

export const findUsersTool = defineTool({
  name: 'find_users',
  level: 'manage',
  title: 'Find users',
  description:
    'Lists the users of the alfaview company by last name, with their IDs for the other tools. Filter by name or email address.',
  descriptionWithoutPersonalData:
    'Lists the users of the alfaview company by last name, with their IDs for the other tools. Filter by name or email address: the filters still match. This server leaves out personal data: names, titles and email addresses are null.',
  inputSchema: z.strictObject({
    name: textParameter('Part of the first or last name, in any case.', 256).optional(),
    emailAddress: textParameter(
      'Only the user with this email address, in any case.',
      320,
    ).optional(),
    limit: limitParameter('users', 100, 50),
    offset: offsetParameter(),
  }),
  annotations: READ_ANNOTATIONS,
  personalData: { shape: 'mcp.user', list: 'users' },
  // apiKeyUserId is null when its read failed.
  output: toolOutput({
    apiKeyUserId: z.string().nullable(),
    ...LIST_PART,
    users: z.array(LISTED_USER),
  }),
  async run(input, { api }) {
    // One answer holds every user, so the tool filters and pages on its side: the model often
    // knows a name only, and alfaview gives the users in no fixed order.
    const users = await listUsers(api);

    // The ID of the API key's user is an extra: a failed read gives null and no warning. A cancel
    // ends the call.
    let apiKeyUserId: string | null = null;
    try {
      apiKeyUserId = await readApiKeyUserId(api);
    } catch (error) {
      if (!(error instanceof ToolError) || error.code === 'Canceled') throw error;
    }

    const filter = { name: input.name, emailAddress: input.emailAddress };
    const filtered = input.name !== undefined || input.emailAddress !== undefined;
    const matches = usersMatching(users, filter).sort(byUserName);
    const part = listPart(matches, input.offset, input.limit);
    const onlyApiKeyUser =
      !filtered &&
      users.length === 1 &&
      apiKeyUserId !== null &&
      sameId(users[0]!.id, apiKeyUserId);

    const found = part.totalMatches === 0 ? 'no users' : count(part.totalMatches, 'user');
    const matching = !filtered ? '' : part.totalMatches === 1 ? ' that matches' : ' that match';
    return {
      summary: `Found ${found}${matching}.${showing(part)}`,
      warnings: onlyApiKeyUser ? [ONLY_API_KEY_USER_WARNING] : [],
      data: {
        apiKeyUserId,
        totalMatches: part.totalMatches,
        offset: part.offset,
        nextOffset: part.nextOffset,
        users: part.items.map(mapListedUser),
      },
    };
  },
});

/** The user tools of the level `manage`. */
export const USER_TOOLS = [findUsersTool] as const;

// invite_user

/** Returns a user permission parameter of invite_user: false unless the call gives true. */
function invitePermission(description: string) {
  return z.boolean().default(false).describe(description);
}

export const inviteUserTool = defineTool({
  name: 'invite_user',
  level: 'full',
  title: 'Invite a user',
  description:
    'Changes who has access: invites a person to the alfaview company as a user, with the permissions that you give. An invitation cannot be taken back. Call it only when the user asked for it.',
  // The schema holds alfaview's title maximum of 20 characters: alfaview answers an invitation with
  // 202 before it checks the title.
  inputSchema: z.strictObject({
    emailAddress: textParameter('The address of the invitation.', 320),
    firstName: textParameter('The first name.', 256),
    lastName: textParameter('The last name.', 256),
    title: textParameter('For example Dr.', 20).optional(),
    locale: z.enum(LOCALES).describe("The user's language in alfaview.").optional(),
    manageCompany: invitePermission(
      'Can change the company settings. Includes userAdmin, roomAdmin and userShow.',
    ),
    userAdmin: invitePermission('Can add, change and delete other users. Includes userList.'),
    userList: invitePermission('Can see all users of the company.'),
    userShow: invitePermission('Sees the names of all users in the rooms they can access.'),
    roomAdmin: invitePermission(
      'Can create, change and delete every room. Includes roomList and roomCreate.',
    ),
    roomList: invitePermission('Can see all rooms of the company.'),
    roomCreate: invitePermission('Can create rooms.'),
    sendEmail: z
      .boolean()
      .describe('Must be true: alfaview always emails the invitation.'),
  }),
  // Not idempotent: a repeat before alfaview lists the new user sends a second invitation email.
  annotations: CREATE_ANNOTATIONS,
  // alfaview names the missing permission in the detail of its 403.
  forbiddenHint:
    "Inviting needs the user permission User Admin, and the API key's user can give only the user permissions that it has.",
  personalData: { shape: 'mcp.user' },
  output: toolOutput(INVITED_USER),
  readTool: 'find_users',
  async run(input, { api }) {
    // The API has no flag for the email, so the call must state it.
    if (!input.sendEmail) throw new ToolError('InviteEmail', INVITE_EMAIL_MESSAGE);

    // No second invitation goes to a person who is a user already. User Admin, which an invitation
    // needs, includes List Users, so a key that can invite reads the whole list.
    const users = await listUsers(api);
    if (users.some((user) => hasEmailAddress(user, input.emailAddress))) {
      throw new ToolError('UserExists', USER_EXISTS_MESSAGE);
    }

    const invitation = {
      emailAddress: input.emailAddress,
      firstName: input.firstName,
      lastName: input.lastName,
      title: input.title,
      locale: input.locale,
    };
    const permissions = {} as Record<InvitePermissionKey, boolean>;
    for (const { key } of INVITE_PERMISSIONS) permissions[key] = input[key];
    await inviteUser(api, invitation, permissions);

    // The invitation is sent, so the read back never fails the call: an error would make the
    // model invite again.
    let user: ApiUser | undefined;
    try {
      user = await findInvitedUser(api, input.emailAddress);
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
    }

    const { city: _city, initials: _initials, ...invited } = invitedUserOutput(user, invitation);
    const userPermissions = INVITE_PERMISSIONS.filter(({ key }) => permissions[key]).map(
      ({ key }) => key,
    );
    const granted =
      userPermissions.length === 0
        ? 'without user permissions'
        : `with the user ${userPermissions.length === 1 ? 'permission' : 'permissions'} ${listed(userPermissions, 'and')}`;
    const id = invited.id === null ? '' : ` The new user has ID ${invited.id}.`;
    return {
      summary: `Invited a new user ${granted}. alfaview emails the invitation.${id}`,
      warnings: invited.id === null ? [INVITED_NOT_LISTED_WARNING] : [],
      data: { ...invited, userPermissions },
    };
  },
});

// delete_user

/**
 * The text of confirmEmailAddress with Personal data set to Include. The parameter is the fallback
 * for a client that cannot ask the person.
 */
export const CONFIRM_EMAIL_TEXT =
  'Only for a client that cannot ask the person: the email address, as the person named it (any case).';

/**
 * The text of confirmEmailAddress with Personal data set to Leave out: find_users then gives no
 * address, so the text says so.
 */
export const CONFIRM_EMAIL_TEXT_WITHOUT_PERSONAL_DATA =
  'Only for a client that cannot ask the person: the email address, as the person named it (any case). Results leave it out.';

/** Returns the parameters of delete_user, with `confirmText` as the text of the address. */
function deleteUserSchema(confirmText: string) {
  return z.strictObject({
    userId: userIdParameter,
    confirmEmailAddress: textParameter(confirmText, 320).optional(),
  });
}

export const deleteUserTool = defineTool({
  name: 'delete_user',
  level: 'full',
  title: 'Delete a user',
  description:
    'Cannot be undone: deletes a user of the alfaview company. The user can no longer sign in, also not with an API key, and access can last up to one hour. Rooms and room permissions of the user stay. The server asks the person to confirm.',
  inputSchema: deleteUserSchema(CONFIRM_EMAIL_TEXT),
  inputSchemaWithoutPersonalData: deleteUserSchema(CONFIRM_EMAIL_TEXT_WITHOUT_PERSONAL_DATA),
  annotations: IDEMPOTENT_CHANGE_ANNOTATIONS,
  forbiddenHint: 'Deleting a user needs the user permission User Admin.',
  // The result holds an ID only, and with Leave out so does the question (userDeleteQuestion).
  personalData: { shape: 'mcp.user' },
  output: toolOutput({
    userId: z.string(),
    deleted: z.boolean(),
    confirmation: z.enum(CONFIRMATION_OUTCOMES),
  }),
  readTool: 'find_users',
  async run(input, { api, confirmation, personalData }) {
    if (!isUserId(input.userId)) throw invalidInput(NOT_A_USER_ID_MESSAGE);
    // IDs are compared and sent in lowercase.
    const userId = input.userId.toLowerCase();
    // A round after a question must carry the confirmation state of this user, which works once.
    confirmation.claim(userId);

    // The tool refuses the API key's user: a delete of that user also deletes the API key of this
    // server. An error of this read ends the call.
    if (sameId(await readApiKeyUserId(api), userId)) {
      throw new ToolError('OwnUserRefused', selfDeleteMessage(userId));
    }
    // The list tells a deleted user from a wrong ID, whatever alfaview answers to the delete of an
    // unknown ID. Each round reads the list again, so a new address counts.
    const user = (await listUsers(api)).find((entry) => sameId(entry.id, userId));
    if (user === undefined) throw new ToolError('NotFound', userNotListedMessage(userId), 404);
    // A user without an address would match a blank answer, which confirms nothing, so the tool
    // refuses before the question and before the fallback, as for a room without a name.
    if (!hasAnEmailAddress(user)) {
      throw new ToolError('ConfirmationMismatch', userWithoutAddressMessage(userId));
    }

    const decision = confirmation.decide({
      id: userId,
      message: userDeleteQuestion(user, userId, personalData),
      field: EMAIL_ADDRESS_FIELD,
      matches: (value) => hasEmailAddress(user, value),
      fallback: {
        value: input.confirmEmailAddress,
        missingMessage: CONFIRM_EMAIL_MISSING_MESSAGE,
        mismatchMessage: confirmEmailMessage(userId),
      },
    });
    if (decision.kind === 'ask') return decision.ask;
    if (decision.kind === 'keep') {
      return {
        summary: `Did not delete user ${userId}.`,
        warnings: [keptWarning(decision.confirmation, EMAIL_MISMATCH_WARNING)],
        note: confirmationNote(decision.confirmation),
        data: { userId, deleted: false, confirmation: decision.confirmation },
      };
    }

    await deleteUser(api, userId);
    return {
      summary: `Deleted user ${userId}. The user can no longer sign in, and access can last up to one hour.`,
      note: confirmationNote(decision.confirmation),
      data: { userId, deleted: true, confirmation: decision.confirmation },
    };
  },
});

/**
 * The user tools of the level `full`. The tool list shows the tools of `full` last, so these are
 * not in USER_TOOLS.
 */
export const FULL_USER_TOOLS = [inviteUserTool, deleteUserTool] as const;
