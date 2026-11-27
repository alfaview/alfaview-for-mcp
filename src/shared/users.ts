/**
 * The users of a company: their output, labels and order, the invitation of a new user, and the
 * languages of users and guest links.
 */
import { createInputReaders } from './inputs.ts';
import { textOrNull } from './outputValues.ts';
import type { Platform } from './platform.ts';

// Languages

/** The languages alfaview accepts for users and guest links. */
export const LOCALES = ['de-DE', 'en-US'] as const;
export type Locale = (typeof LOCALES)[number];

/**
 * Returns the language of a User or Guest Link output. alfaview answers `unknown` for a user or
 * link without a language (spec: User, UserProfile and GuestLink, `locale`). `unknown` in any
 * case, an empty or blank value and a value that is not text give `null`. Every other value stays
 * as it is.
 */
export function localeOrNull(value: unknown): string | null {
  const locale = textOrNull(value);
  if (locale === null) return null;
  const normalized = locale.trim().toLowerCase();
  return normalized === '' || normalized === 'unknown' ? null : locale;
}

// API shape (spec: User)

export type ApiUser = {
  id: string;
  emailAddress?: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  city?: string;
  initials?: string;
  locale?: string;
};

// Output shapes

export type UserOutput = {
  id: string;
  emailAddress: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  city: string | null;
  initials: string | null;
  locale: string | null;
};

/** The output of an invitation. `id` is `null` while the invited user is not listed yet. */
export type InvitedUserOutput = Omit<UserOutput, 'id'> & { id: string | null; invited: true };

export type UserDeleteOutput = { id: string; deleted: true };

// Mappers, labels and sorts

/**
 * Returns the User output. Every documented key is present, absent values are `null`, and so is
 * the locale `unknown` (localeOrNull).
 */
export function mapUser(user: ApiUser): UserOutput {
  return {
    id: user.id,
    emailAddress: textOrNull(user.emailAddress),
    firstName: textOrNull(user.firstName),
    lastName: textOrNull(user.lastName),
    title: textOrNull(user.title),
    city: textOrNull(user.city),
    initials: textOrNull(user.initials),
    locale: localeOrNull(user.locale),
  };
}

/** Sorts by user ID, for a stable order: alfaview lists users in no fixed order. */
export function byUserId(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'en', { sensitivity: 'base' });
}

/** Returns "First Last (email)", or the parts of it that exist, else the ID. */
export function userLabel(user: ApiUser): string {
  const name = `${text(user.firstName)} ${text(user.lastName)}`.trim();
  const email = text(user.emailAddress);
  if (name === '') return email === '' ? user.id : email;
  return email === '' ? name : `${name} (${email})`;
}

/** Sorts a user list by last name, first name, email address, then ID, without case or accents. */
export function byUserName(left: ApiUser, right: ApiUser): number {
  return (
    compareText(text(left.lastName), text(right.lastName)) ||
    compareText(text(left.firstName), text(right.firstName)) ||
    compareText(text(left.emailAddress), text(right.emailAddress)) ||
    compareText(left.id, right.id)
  );
}

export function userPath(userId: string): string {
  return `/v2/users/${encodeURIComponent(userId)}`;
}

/**
 * Reads the users of a `GET /v2/users` answer. A missing or `null` body is an empty list, and
 * entries without an ID are left out. Returns `undefined` for a body that is not a list, so that
 * the caller throws its response error.
 */
export function readUserList(data: unknown): ApiUser[] | undefined {
  if (data !== undefined && data !== null && !Array.isArray(data)) return undefined;
  return ((data ?? []) as ApiUser[]).filter((user) => typeof user?.id === 'string');
}

// Invitation

/**
 * The user permissions that an invitation can grant, in the order in which a caller checks their
 * values. `label` names a permission in a message.
 */
export const INVITE_PERMISSIONS = [
  { key: 'manageCompany', label: 'Manage Company' },
  { key: 'userAdmin', label: 'User Admin' },
  { key: 'userList', label: 'List Users' },
  { key: 'userShow', label: 'Show User Names' },
  { key: 'roomAdmin', label: 'Room Admin' },
  { key: 'roomList', label: 'List Rooms' },
  { key: 'roomCreate', label: 'Create Rooms' },
] as const;

export type InvitePermissionKey = (typeof INVITE_PERMISSIONS)[number]['key'];

/**
 * The statuses of the lookup after an invitation that mean no user to show. The invitation is sent
 * by then, so the caller reports it instead of failing: a second run would send a second
 * invitation.
 */
export const LOOKUP_STATUSES_WITHOUT_USER = [403, 404, 422];

/** The values of an invitation that its output shows while alfaview does not list the user. */
export type Invitation = {
  emailAddress: string;
  firstName: string;
  lastName: string;
  title?: string;
  locale?: Locale;
};

/**
 * Returns the output of an invitation: the User output of `user`, the user that the lookup after
 * the invitation found, else the values of `invitation` without an ID. A new user can take a few
 * minutes to appear in alfaview.
 */
export function invitedUserOutput(
  user: ApiUser | undefined,
  invitation: Invitation,
): InvitedUserOutput {
  if (user !== undefined) {
    return { ...mapUser(user), invited: true };
  }
  return {
    id: null,
    emailAddress: invitation.emailAddress,
    firstName: invitation.firstName,
    lastName: invitation.lastName,
    title: invitation.title ?? null,
    city: null,
    initials: null,
    locale: invitation.locale ?? null,
    invited: true,
  };
}

// Reader

/** The name of the Language field, the default label of readLocale. */
export type UserLabels = { language: string };

/** The reader of createUserReaders. */
export type UserReaders = {
  /** Reads a Language field: `de-DE` or `en-US` in any case. Empty gives `undefined`. */
  readLocale: (value: unknown, label?: string) => Locale | undefined;
};

/** Returns the user reader bound to `platform`, with `labels.language` as its default label. */
export function createUserReaders(platform: Platform, labels: UserLabels): UserReaders {
  const { readString } = createInputReaders(platform);
  return {
    readLocale(value, label = labels.language) {
      const entry = readString(value, label);
      if (entry === undefined) return undefined;
      const locale = LOCALES.find((candidate) => candidate.toLowerCase() === entry.toLowerCase());
      if (locale === undefined) {
        throw platform.invalidInput(`${label} must be German (de-DE) or English (en-US).`);
      }
      return locale;
    },
  };
}
