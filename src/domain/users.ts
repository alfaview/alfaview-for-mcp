// The users of the company for the MCP tools. The API shape and the rules that do not depend on MCP
// are in ../shared/users.ts.
import type { CallApi } from '../alfaview/client.ts';
import { invalidResponse, sendCreate } from '../alfaview/errors.ts';
import { textOrNull } from '../shared/outputValues.ts';
import type { PersonalDataMode } from '../shared/personalData.ts';
import {
  localeOrNull,
  LOOKUP_STATUSES_WITHOUT_USER,
  readUserList,
  userPath,
  type ApiUser,
  type Invitation,
  type InvitePermissionKey,
} from '../shared/users.ts';
import { compact } from '../values/inputs.ts';
import { getOwnUser } from './account.ts';
import { quotedForPerson } from './rooms.ts';

export type { ApiUser } from '../shared/users.ts';

// Messages

export const USERS_UNEXPECTED_MESSAGE = 'alfaview sent an unexpected response for /v2/users.';

export const ONLY_API_KEY_USER_WARNING =
  "alfaview listed only the API key's user. The company has no other user, or the API key's user lacks the user permission List Users.";

export const NOT_A_USER_ID_MESSAGE =
  'userId is not the ID of a user, for example it is the ID of a guest link or of a guest. Find the user ID with find_users.';

export const INVITE_EMAIL_MESSAGE =
  'alfaview always emails the invitation to the new user. Call invite_user again with sendEmail true to invite and send that email.';

export const USER_EXISTS_MESSAGE =
  'The company has a user with this email address, so no invitation was sent. Find the user with find_users.';

export const INVITE_UNCERTAIN_MESSAGE =
  'alfaview may have accepted the invitation before the error. Check with find_users and emailAddress in a few minutes before you invite again: a second invitation sends a second email.';

export const INVITED_NOT_LISTED_WARNING =
  'alfaview accepted the invitation but does not list the new user yet, so id is null. A new user can take a few minutes to appear: find the ID with find_users and emailAddress. Do not invite again.';

/** Returns the error of delete_user for the API key's user. */
export function selfDeleteMessage(userId: string): string {
  return `User ${userId} is the API key's user. Deleting it would also delete the API key of this server, so this tool refuses. Do it in alfaview.`;
}

/** Returns the error of delete_user for a user that the list does not hold. Nothing was deleted. */
export function userNotListedMessage(userId: string): string {
  return `alfaview does not list a user ${userId} in this company, so nothing was deleted. The user is already deleted, or the API key's user lacks the user permission User Admin. Find the ID with find_users.`;
}

/**
 * Returns the error of delete_user when confirmEmailAddress is not the user's email address. It
 * does not name the address, so the tool does not hand it to an injected instruction.
 */
export function confirmEmailMessage(userId: string): string {
  return `confirmEmailAddress is not the email address of user ${userId}, so nothing was deleted. Check with find_users that this is the user to delete.`;
}

/**
 * Returns the error of delete_user for a user without an email address, which nothing can
 * confirm: a blank answer would match it.
 */
export function userWithoutAddressMessage(userId: string): string {
  return `User ${userId} has no email address, so nothing was deleted. Only the email address confirms the delete of a user: delete this user in alfaview.`;
}

/** Returns whether alfaview gives `user` an email address that is not blank. */
export function hasAnEmailAddress(user: ApiUser): boolean {
  return typeof user.emailAddress === 'string' && user.emailAddress.trim() !== '';
}

/**
 * The error of delete_user for a client that cannot ask the person, when the call gives no
 * confirmEmailAddress.
 */
export const CONFIRM_EMAIL_MISSING_MESSAGE =
  'This client cannot ask the person to confirm. Give confirmEmailAddress: the email address of the user, as the person named it.';

/**
 * Returns the question to the person before the delete. The facts of the server come first: the
 * ID and what the delete does. With Personal data set to Include, the user's name and email
 * address follow, each quoted and escaped by quotedForPerson: users set their own names, so a name
 * cannot pass as a text of the server. With Leave out, the question names the ID only, so it holds
 * no personal value of the results.
 */
export function userDeleteQuestion(user: ApiUser, userId: string, personalData: PersonalDataMode): string {
  const text = (value: string | undefined) => (typeof value === 'string' ? value.trim() : '');
  const name = [text(user.firstName), text(user.lastName)].filter((part) => part !== '').join(' ');
  const emailAddress = text(user.emailAddress);
  const sentences = [
    `Delete the user with the ID ${userId} for good?`,
    'The user can no longer sign in, also not with an API key, and access can last up to one hour. Rooms and room permissions of the user stay. This cannot be undone.',
  ];
  if (personalData === 'include' && name !== '') sentences.push(`Name: ${quotedForPerson(name)}.`);
  if (personalData === 'include' && emailAddress !== '') {
    sentences.push(`Email address: ${quotedForPerson(emailAddress)}.`);
  }
  return sentences.join(' ');
}

/** The form field of the question: the person types the email address of the user. */
export const EMAIL_ADDRESS_FIELD = {
  name: 'emailAddress',
  title: 'Email address',
  description: 'Type the email address of the user to delete the user.',
  format: 'email' as const,
};

/** The warning for a typed address that is not the user's. It never names the expected address. */
export const EMAIL_MISMATCH_WARNING =
  'The person typed an address that is not the email address of the user.';

// User IDs

/**
 * Returns whether `id` has the layout of a user ID: a version 5 UUID with the kind 18 (hex 12) in
 * byte 10, or a version 4 UUID of an older user. The layout is observed, not part of the API docs,
 * and alfaview counts a room permission key with this layout as a user. The function returns false
 * for the ID of a guest link, a group link or a guest, and for the key
 * 11111111-1111-1111-1111-111111111111 of a room's default permissions. The tools that take a user
 * ID refuse every other ID with it, before any request.
 */
export function isUserId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-(?:5[0-9a-f]{3}-[0-9a-f]{4}-12[0-9a-f]{10}|4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(
    id,
  );
}

/** Returns whether two IDs are equal in any case: alfaview sends lowercase IDs, a model may not. */
export function sameId(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** Returns whether the trimmed address of `user` equals the trimmed `emailAddress` in any case. */
export function hasEmailAddress(user: ApiUser, emailAddress: string): boolean {
  return (
    typeof user.emailAddress === 'string' &&
    user.emailAddress.trim().toLowerCase() === emailAddress.trim().toLowerCase()
  );
}

// Output shape, filter and names

/**
 * A user of a list: the API's User without `city` and `initials`, which no task of the agent needs
 * and which are personal data. The own profile of get_account and update_own_user keeps them
 * (mapUser of ../shared/users.ts).
 */
export type ListedUser = {
  id: string;
  emailAddress: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  locale: string | null;
};

/**
 * Returns the ListedUser output. Every key is present, absent values are `null`, and so is the
 * locale `unknown` (localeOrNull).
 */
export function mapListedUser(user: ApiUser): ListedUser {
  return {
    id: user.id,
    emailAddress: textOrNull(user.emailAddress),
    firstName: textOrNull(user.firstName),
    lastName: textOrNull(user.lastName),
    title: textOrNull(user.title),
    locale: localeOrNull(user.locale),
  };
}

/** What find_users matches. */
export type UserFilter = {
  /** Part of the first name, the last name, or both joined by a space, in any case. */
  name?: string;
  /** The whole email address, in any case. */
  emailAddress?: string;
};

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Returns the users that match each filter that is given. With `emailAddress`, the users whose
 * trimmed address equals it in any case. With `name`, the users whose first name, last name, or
 * first and last name joined by a space contain it, trimmed and in any case.
 */
export function usersMatching(users: readonly ApiUser[], filter: UserFilter): ApiUser[] {
  const name = filter.name?.trim().toLowerCase();
  return users.filter((user) => {
    if (filter.emailAddress !== undefined && !hasEmailAddress(user, filter.emailAddress)) {
      return false;
    }
    if (name === undefined) return true;
    const first = trimmed(user.firstName);
    const last = trimmed(user.lastName);
    return [first, last, `${first} ${last}`].some((text) => text.toLowerCase().includes(name));
  });
}

/**
 * Returns a map from the lowercase user ID to the user's name, for the room permissions: the first
 * and the last name joined by a space, or `null` for a user without a name.
 */
export function userNames(users: readonly ApiUser[]): Map<string, string | null> {
  return new Map(
    users.map((user) => {
      const name = `${trimmed(user.firstName)} ${trimmed(user.lastName)}`.trim();
      return [user.id.toLowerCase(), name === '' ? null : name];
    }),
  );
}

// Requests

/**
 * Returns every user of the company from `GET /v2/users`, in one answer and in random order. A
 * caller without the user permission List Users or User Admin gets only its own user.
 */
export async function listUsers(api: CallApi): Promise<ApiUser[]> {
  const { data } = await api.request<unknown>({ method: 'GET', path: '/v2/users' });
  const users = readUserList(data);
  if (users === undefined) throw invalidResponse(USERS_UNEXPECTED_MESSAGE);
  return users;
}

/**
 * Returns the ID of the API key's user from `GET /v2/users/me`. The tools use it to refuse a change
 * that would lock this user out, such as its own delete. An answer without an ID throws the
 * InvalidResponse error of getOwnUser.
 */
export async function readApiKeyUserId(api: CallApi): Promise<string> {
  return (await getOwnUser(api)).id;
}

/**
 * Returns the user with `emailAddress` from `GET /v2/users?emailAddress=` after an invitation, or
 * `undefined` when alfaview does not list it yet or answers a status of
 * LOOKUP_STATUSES_WITHOUT_USER. alfaview can repeat the address in the text of a 422, so the
 * request is a personal input.
 */
export async function findInvitedUser(
  api: CallApi,
  emailAddress: string,
): Promise<ApiUser | undefined> {
  const { status, data } = await api.request<unknown>({
    method: 'GET',
    path: '/v2/users',
    query: { emailAddress },
    allowStatuses: LOOKUP_STATUSES_WITHOUT_USER,
    personalInput: true,
  });
  if (status >= 400) return undefined;
  const users = readUserList(data);
  if (users === undefined) throw invalidResponse(USERS_UNEXPECTED_MESSAGE);
  return users.find((user) => hasEmailAddress(user, emailAddress));
}

/**
 * Invites a user with `POST /v2/users/invitation`, with `user` as the UserInformation of the spec:
 * a title or a language left out is not sent. alfaview answers 202 without a user, then creates
 * the user and emails the invitation later. An answer that leaves the outcome open says that the
 * invitation may be queued (sendCreate): a second one sends a second email. The body holds the
 * email address and the names, which alfaview can repeat in the text of a 422, so the request is
 * a personal input.
 */
export async function inviteUser(
  api: CallApi,
  user: Invitation,
  permissions: Record<InvitePermissionKey, boolean>,
): Promise<void> {
  await sendCreate(
    api,
    {
      method: 'POST',
      path: '/v2/users/invitation',
      body: { user: compact(user), permissions },
      personalInput: true,
    },
    INVITE_UNCERTAIN_MESSAGE,
  );
}

/** Deletes a user with `DELETE /v2/users/{id}` and the ID in lowercase. Its answer has no body. */
export async function deleteUser(api: CallApi, userId: string): Promise<void> {
  await api.request({ method: 'DELETE', path: userPath(userId.toLowerCase()) });
}
