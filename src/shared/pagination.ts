/**
 * The page rules of alfaview's paginated lists (`{ data, nextPageToken? }`): the check of one page
 * answer and the loop over the pages with its stop rules. The caller passes the request of one
 * page and the error of too many pages to readAllPages.
 */

/** The most pages a list reads before it gives up with TooManyResults. */
export const DEFAULT_MAX_PAGES = 50;

/** One page of a list. */
export type Page<T> = {
  /** The HTTP status: 200, or an error status that the caller allowed, then without items. */
  status: number;
  items: T[];
  nextPageToken: string | null;
};

/** The pages that readAllPages read. */
export type PageList<T> = {
  /** The status of the first page: 200, or an allowed error status, then without items. */
  status: number;
  items: T[];
  /** `false` when `pageLimit` or `limit` left entries unread. */
  complete: boolean;
  /** The token of the next page when `pageLimit` stopped the reading, else `null`. */
  nextPageToken: string | null;
};

/**
 * Returns the collection name of a list path in plain words: `/v2/rooms/{id}/guest-links` gives
 * "guest links".
 */
export function collectionName(path: string): string {
  const segments = path
    .split('?')[0]!
    .split('/')
    .filter((segment) => segment !== '');
  return (segments[segments.length - 1] ?? 'items').replace(/-/g, ' ');
}

function hasTextId(entry: unknown): boolean {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    typeof (entry as { id?: unknown }).id === 'string'
  );
}

/**
 * Reads the items and the next page token of one page answer. `data: null` or no `data` counts as
 * an empty page, and entries without a text `id` are left out. `nextPageToken` is `null` when
 * alfaview sent none or an empty one. Returns `undefined` for an answer that is not a page, so
 * that the caller throws its response error.
 */
export function readPageBody<T extends { id: string }>(
  data: unknown,
): { items: T[]; nextPageToken: string | null } | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const page = data as { data?: unknown; nextPageToken?: unknown };
  if (page.data !== undefined && page.data !== null && !Array.isArray(page.data)) return undefined;

  const items = ((page.data ?? []) as unknown[]).filter(hasTextId) as T[];
  const nextPageToken =
    typeof page.nextPageToken === 'string' && page.nextPageToken !== '' ? page.nextPageToken : null;
  return { items, nextPageToken };
}

/** The options of readAllPages. */
export type AllPagesOptions = {
  /** The list path, for the collection name in the TooManyResults message. */
  path: string;
  /** Default DEFAULT_MAX_PAGES. */
  maxPages?: number;
  /** The sentence after the TooManyResults text, for example what the user can do. */
  tooManyResultsHint?: string;
  /** Read at most this many pages, without an error. */
  pageLimit?: number;
  /** Stop once this many items are read. */
  limit?: number;
  /** Start at this page: the `nextPageToken` of an earlier list. */
  pageToken?: string;
  /** The caller's error for a list with more than `maxPages` pages of items. */
  tooManyResults: (message: string) => Error;
};

/**
 * Reads every page of a list with `fetchPage`, the caller's request of one page, from `pageToken`
 * when it is given. `fetchPage` gets the token of the page (`undefined` for the first page of a
 * list) and the number of the page, from 1. The stop rules:
 *
 * - A page with an error status ends the reading with that status and no items, and drops the
 *   items of earlier pages. So `fetchPage` must allow an error status on page 1 only.
 * - A page without `nextPageToken` or without items is the last page, so the empty page that
 *   follows a full last page ends the reading.
 * - More than `maxPages` pages of items throw `tooManyResults` with `tooManyResultsHint`
 *   appended. One empty page after page `maxPages` does not.
 * - `limit`: the reading stops once `limit` items are read and returns the first `limit`.
 *   `complete` is `true` only when the last page ends exactly at the limit.
 * - `pageLimit`: the reading stops after that many pages, with `complete: false` and the token of
 *   the next page. The rules above come first, so a last page at the limit is complete.
 */
export async function readAllPages<T>(
  fetchPage: (pageToken: string | undefined, pageNumber: number) => Promise<Page<T>>,
  options: AllPagesOptions,
): Promise<PageList<T>> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const items: T[] = [];
  let status = 200;
  let pageToken = options.pageToken;

  for (let pageNumber = 1; ; pageNumber += 1) {
    const page = await fetchPage(pageToken, pageNumber);
    if (page.status >= 400) {
      return { status: page.status, items: [], complete: true, nextPageToken: null };
    }
    if (pageNumber === 1) status = page.status;

    if (pageNumber > maxPages) {
      if (page.items.length === 0) break;
      const hint = options.tooManyResultsHint ? ` ${options.tooManyResultsHint}` : '';
      throw options.tooManyResults(
        `alfaview returned more than ${maxPages} pages of ${collectionName(options.path)}.${hint}`,
      );
    }

    items.push(...page.items);
    const lastPage = page.nextPageToken === null || page.items.length === 0;
    if (options.limit !== undefined && items.length >= options.limit) {
      const complete = lastPage && items.length === options.limit;
      return { status, items: items.slice(0, options.limit), complete, nextPageToken: null };
    }
    if (lastPage) break;
    if (options.pageLimit !== undefined && pageNumber >= options.pageLimit) {
      return { status, items, complete: false, nextPageToken: page.nextPageToken };
    }
    pageToken = page.nextPageToken as string;
  }
  return { status, items, complete: true, nextPageToken: null };
}
