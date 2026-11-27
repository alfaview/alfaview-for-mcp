/**
 * Guest links: their output, filters and checks, and the cleanup of expired links. alfaview lists
 * links page by page, with no filter by email, origin or time, so every search reads all pages of
 * a room. The cleanup keeps that list short.
 */
import { createInputReaders } from './inputs.ts';
import { booleanOrNull, textOrNull } from './outputValues.ts';
import type { Platform } from './platform.ts';
import { newestFirst } from './polling.ts';
import { roomPath } from './rooms.ts';
import { formatLocalTimestamp, formatZonedDateTime, normalizeTimestamp } from './time.ts';
import { localeOrNull } from './users.ts';

// Constants

const HOUR_MS = 60 * 60 * 1000;

/** The largest page alfaview allows for link lists. */
export const LINK_PAGE_SIZE = 500;

/** The longest origin that alfaview accepts, in characters. */
export const MAX_ORIGIN_LENGTH = 256;

/**
 * Statuses after which a create may still have saved links: alfaview can answer 500 after it saved
 * some or all of them, and a proxy can answer 502 to 504 after alfaview saved them.
 */
export const UNCERTAIN_CREATE_STATUSES = [500, 502, 503, 504];

/** The default number of hours after `validUntil` from which the cleanup deletes a link. */
export const DEFAULT_EXPIRED_AT_LEAST_HOURS = 48;

/** The most deletes of the cleanup in flight at the same time. */
export const DELETE_CONCURRENCY = 5;

/**
 * The most pages that one run of the cleanup reads (10,000 links). The cleanup stops at this limit
 * without an error, so a room with more pages of links than a search can read (DEFAULT_MAX_PAGES)
 * is still cleaned, a part per run.
 */
export const CLEANUP_PAGE_LIMIT = 20;

// API shape (spec: GuestLink)

/**
 * A guest link as alfaview gives it. `userId` is the ID under which the attendance and the
 * participant list show the guest of the link (spec: GuestLink.userId). alfaview sends it empty
 * when it cannot give it. No Guest Link output has it: only the attendance and the participants
 * read it.
 */
export type ApiGuestLink = {
  id: string;
  userId?: string;
  roomId?: string;
  emailAddress?: string;
  displayName?: string;
  joinUrl?: string;
  accessKey?: string;
  locale?: string;
  validFrom?: string;
  validUntil?: string;
  permissionGroupId?: string;
  dialInAllowed?: boolean;
  dialInCode?: string;
  origin?: string;
  createdAt?: string;
  createdBy?: string;
};

// Output shapes

/**
 * The Guest Link output. `validFromLocal` and `validUntilLocal` show the validity as local time in
 * the time zone that mapGuestLink gets, with the zone name.
 */
export type GuestLinkOutput = {
  id: string;
  roomId: string | null;
  roomName: string | null;
  emailAddress: string | null;
  displayName: string | null;
  joinUrl: string | null;
  locale: string | null;
  validFrom: string | null;
  validFromLocal: string | null;
  validUntil: string | null;
  validUntilLocal: string | null;
  permissionGroupId: string | null;
  permissionGroupName: string | null;
  dialInAllowed: boolean | null;
  dialInCode: string | null;
  origin: string | null;
  createdAt: string | null;
  createdBy: string | null;
};

export type LinkDeleteOutput = { id: string; deleted: true };

// Names of rooms and permission groups in link outputs

/** Room names and permission group names by lowercase ID. */
export type LinkNames = {
  roomNames: ReadonlyMap<string, string | null>;
  groupNames: ReadonlyMap<string, string>;
};

/** No names: outputs get `null` for `roomName` and `permissionGroupName`. */
export const NO_LINK_NAMES: LinkNames = { roomNames: new Map(), groupNames: new Map() };

/** Returns the name of `id` in `names`, whose keys are in lower case, or `null`. */
export function lookupName<T>(names: ReadonlyMap<string, T>, id: unknown): T | null {
  return typeof id === 'string' && id !== '' ? (names.get(id.toLowerCase()) ?? null) : null;
}

// Mapper and label

/**
 * Returns the Guest Link output. Every documented key is present, absent values are `null`,
 * timestamps before 1971 (alfaview's "not set") are `null`, and so is the locale `unknown`
 * (localeOrNull). The access key is left out: it is part of `joinUrl`, and it is a credential. The
 * local times use `timeZone`.
 */
export function mapGuestLink(
  link: ApiGuestLink,
  names: LinkNames,
  timeZone: string,
): GuestLinkOutput {
  return {
    id: link.id,
    roomId: textOrNull(link.roomId),
    roomName: lookupName(names.roomNames, link.roomId),
    emailAddress: textOrNull(link.emailAddress),
    displayName: textOrNull(link.displayName),
    joinUrl: textOrNull(link.joinUrl),
    locale: localeOrNull(link.locale),
    validFrom: normalizeTimestamp(link.validFrom),
    validFromLocal: formatLocalTimestamp(link.validFrom, timeZone),
    validUntil: normalizeTimestamp(link.validUntil),
    validUntilLocal: formatLocalTimestamp(link.validUntil, timeZone),
    permissionGroupId: textOrNull(link.permissionGroupId),
    permissionGroupName: lookupName(names.groupNames, link.permissionGroupId),
    dialInAllowed: booleanOrNull(link.dialInAllowed),
    dialInCode: textOrNull(link.dialInCode),
    origin: textOrNull(link.origin),
    createdAt: normalizeTimestamp(link.createdAt),
    createdBy: textOrNull(link.createdBy),
  };
}

/**
 * Returns the label of a link in a list: "Display Name <email> (valid from YYYY-MM-DD)" with the
 * date in `timeZone`, or the parts that the link has. The ID replaces a missing name and email.
 */
export function guestLinkLabel(link: ApiGuestLink, timeZone: string): string {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const name = text(link.displayName);
  const email = text(link.emailAddress);
  const person = name !== '' && email !== '' ? `${name} <${email}>` : name || email || link.id;
  const validFrom = formatZonedDateTime(link.validFrom, timeZone);
  return validFrom === null ? person : `${person} (valid from ${validFrom.slice(0, 10)})`;
}

// Paths

export function guestLinkPath(guestLinkId: string): string {
  return `/v2/guest-links/${encodeURIComponent(guestLinkId)}`;
}

/** Returns the path of the guest links of a room, or of the company when `roomId` is undefined. */
export function guestLinksPath(roomId: string | undefined): string {
  return roomId === undefined ? '/v2/guest-links' : `${roomPath(roomId)}/guest-links`;
}

export function roomGuestLinkPath(roomId: string, guestLinkId: string): string {
  return `${roomPath(roomId)}/guest-links/${encodeURIComponent(guestLinkId)}`;
}

// Filters and answers

/**
 * Returns whether `origin` contains `originContains`, in any case. Without a filter, every origin
 * matches, a missing one too.
 */
export function originMatches(origin: unknown, originContains: string | undefined): boolean {
  if (originContains === undefined) return true;
  return typeof origin === 'string' && origin.toLowerCase().includes(originContains.toLowerCase());
}

/**
 * Sorts links from alfaview by newestFirst. A `createdAt` that alfaview marks as not set counts as
 * missing.
 */
export function newestLinkFirst(left: ApiGuestLink, right: ApiGuestLink): number {
  return newestFirst(
    { id: left.id, createdAt: normalizeTimestamp(left.createdAt) },
    { id: right.id, createdAt: normalizeTimestamp(right.createdAt) },
  );
}

/** Returns a timestamp from alfaview in milliseconds, or `null` when it is not set. */
function instantOf(value: unknown): number | null {
  const iso = normalizeTimestamp(value);
  return iso === null ? null : Date.parse(iso);
}

function sameEmail(link: ApiGuestLink, emailAddress: string): boolean {
  return (
    typeof link.emailAddress === 'string' &&
    link.emailAddress.trim().toLowerCase() === emailAddress.trim().toLowerCase()
  );
}

/** Returns whether the link's `validUntil` is set and before `now`. */
export function hasExpired(link: ApiGuestLink, now: number): boolean {
  const validUntil = instantOf(link.validUntil);
  return validUntil !== null && validUntil < now;
}

/** What a guest link search matches. */
export type GuestLinkFilter = {
  /** Matches trimmed and in any case. */
  emailAddress?: string;
  /** Matches exactly. */
  origin?: string;
  includeExpired: boolean;
};

/**
 * Returns the links that match the email address and the origin, newest first. `expiredMatchCount`
 * counts the matching links whose `validUntil` has passed. Unless `includeExpired` is true, these
 * links are left out.
 */
export function filterGuestLinks(
  links: readonly ApiGuestLink[],
  filter: GuestLinkFilter,
  now: number,
): { links: ApiGuestLink[]; expiredMatchCount: number } {
  const matches = links.filter(
    (link) =>
      (filter.emailAddress === undefined || sameEmail(link, filter.emailAddress)) &&
      (filter.origin === undefined || link.origin === filter.origin),
  );
  const expiredMatchCount = matches.filter((link) => hasExpired(link, now)).length;
  const kept = filter.includeExpired ? matches : matches.filter((link) => !hasExpired(link, now));
  return { links: kept.sort(newestLinkFirst), expiredMatchCount };
}

/**
 * Returns the first link of a guest link create answer, or `undefined` when that entry has no ID or
 * no join URL (a blank join URL counts as none). alfaview answers a guest link create with the
 * created GuestLink objects in request order, so a create of one link needs no read back. On
 * `undefined`, the caller reads the link back by the ID of createdLinkId.
 */
export function createdGuestLink(data: unknown): ApiGuestLink | undefined {
  const first: unknown = Array.isArray(data) ? data[0] : undefined;
  if (typeof first !== 'object' || first === null) return undefined;
  const { id, joinUrl } = first as { id?: unknown; joinUrl?: unknown };
  const complete =
    typeof id === 'string' && id !== '' && typeof joinUrl === 'string' && joinUrl.trim() !== '';
  return complete ? (first as ApiGuestLink) : undefined;
}

/**
 * Returns the ID of the first entry of a create answer, or `undefined` when the answer has none,
 * so that the caller throws its own response error. alfaview answers a guest link create with the
 * created GuestLink objects, and a group link create with the IDs only (`201 [{ id }]`), both in
 * request order. The caller reads the link back by this ID: a group link always, a guest link when
 * createdGuestLink gives `undefined`.
 */
export function createdLinkId(data: unknown): string | undefined {
  const first: unknown = Array.isArray(data) ? data[0] : undefined;
  const id = typeof first === 'object' && first !== null ? (first as { id?: unknown }).id : undefined;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * Returns the IDs of the links that the cleanup deletes: `validUntil` is set and at least
 * `expiredAtLeastHours` before `now`, and the origin contains `originContains` (any case) when it
 * is given. Links without `validUntil` are never deleted.
 */
export function expiredLinkIds(
  links: readonly ApiGuestLink[],
  options: { expiredAtLeastHours: number; originContains: string | undefined },
  now: number,
): string[] {
  const expiredBefore = now - options.expiredAtLeastHours * HOUR_MS;
  return links
    .filter((link) => {
      const validUntil = normalizeTimestamp(link.validUntil);
      return (
        validUntil !== null &&
        Date.parse(validUntil) <= expiredBefore &&
        originMatches(link.origin, options.originContains)
      );
    })
    .map((link) => link.id);
}

/** Returns the sentence that the error of a failed cleanup delete ends with. */
export function deletedBeforeError(count: number): string {
  return count === 1
    ? '1 link was deleted before the error.'
    : `${count} links were deleted before the error.`;
}

// Checks

/** The names of the link fields in the messages of createGuestLinkChecks. */
export type GuestLinkLabels = {
  /** The Origin field, the default label of readOrigin. */
  origin: string;
  validFrom: string;
  validUntil: string;
};

export type GuestLinkChecks = {
  /** Reads the Origin field: at most MAX_ORIGIN_LENGTH characters. Empty gives `undefined`. */
  readOrigin: (value: unknown, label?: string) => string | undefined;
  /**
   * Checks the validity of a link to create. `validFrom` and `validUntil` are ISO strings or
   * `undefined`. A `validUntil` in the past throws `pastMessage`, because nobody could use the
   * link. A `validUntil` before `validFrom` throws too.
   */
  checkValidity: (
    validFrom: string | undefined,
    validUntil: string | undefined,
    now: number,
    pastMessage: string,
  ) => void;
};

/**
 * Returns the link checks bound to `platform`, with the field names of `labels` in their messages.
 */
export function createGuestLinkChecks(platform: Platform, labels: GuestLinkLabels): GuestLinkChecks {
  const { readString } = createInputReaders(platform);
  return {
    readOrigin(value, label = labels.origin) {
      const origin = readString(value, label);
      if (origin !== undefined && [...origin].length > MAX_ORIGIN_LENGTH) {
        throw platform.invalidInput(`${label} must be at most ${MAX_ORIGIN_LENGTH} characters.`);
      }
      return origin;
    },
    checkValidity(validFrom, validUntil, now, pastMessage) {
      if (validUntil === undefined) return;
      if (Date.parse(validUntil) < now) throw platform.invalidInput(pastMessage);
      if (validFrom !== undefined && Date.parse(validUntil) < Date.parse(validFrom)) {
        throw platform.invalidInput(`${labels.validUntil} must be after ${labels.validFrom}.`);
      }
    },
  };
}
