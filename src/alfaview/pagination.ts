// The page requests of the server for the paginated lists of alfaview, with the page rules of
// ../shared/pagination.ts. A tool reads the pages of a list first, then sorts and filters them.
import { readAllPages, readPageBody, type Page, type PageList } from '../shared/pagination.ts';
import type { CallApi } from './client.ts';
import { invalidResponse, ToolError } from './errors.ts';

export type { PageList } from '../shared/pagination.ts';

export type PageOptions = {
  query?: Record<string, string | undefined>;
  /** Entries a page: a positive integer, such as ROOM_PAGE_SIZE or LINK_PAGE_SIZE. */
  pageSize: number;
  pageToken?: string;
  /** These error statuses return an empty page with that status instead of throwing. */
  allowStatuses?: readonly number[];
};

export type AllPagesOptions = {
  query?: Record<string, string | undefined>;
  pageSize: number;
  /** The most pages before TooManyResults. DEFAULT_MAX_PAGES by default. */
  maxPages?: number;
  /** The sentence after the TooManyResults text, for example what the model can do. */
  tooManyResultsHint?: string;
  /** Error statuses of the first page that return that status without items. */
  allowStatuses?: readonly number[];
  /** Read at most this many pages, without an error. */
  pageLimit?: number;
  /** Start at this page: the `nextPageToken` of an earlier list. */
  pageToken?: string;
};

/**
 * Reads one page of a paginated list (`{ data, nextPageToken? }`) with readPageBody. `data: null`
 * counts as an empty page, and entries without a text `id` are left out. `nextPageToken` is `null`
 * when alfaview sent none. An answer that is not a page throws InvalidResponse.
 */
export async function fetchPage<T extends { id: string }>(
  api: CallApi,
  path: string,
  options: PageOptions,
): Promise<Page<T>> {
  if (!Number.isInteger(options.pageSize) || options.pageSize < 1) {
    throw new TypeError(`pageSize must be a positive integer, got ${options.pageSize}`);
  }

  const { status, data } = await api.request<unknown>({
    method: 'GET',
    path,
    query: { ...options.query, limit: options.pageSize, pageToken: options.pageToken },
    allowStatuses: options.allowStatuses ?? [],
  });
  if (status >= 400) return { status, items: [], nextPageToken: null };

  const page = readPageBody<T>(data);
  if (page === undefined) {
    throw invalidResponse(`alfaview sent an unexpected response for ${path}.`);
  }
  return { status, ...page };
}

/**
 * Reads every page of a paginated list with the stop rules of readAllPages, from `pageToken` when
 * it is given. More than `maxPages` pages of items throw TooManyResults with
 * `tooManyResultsHint` appended. With `pageLimit`, the reading stops after that many pages
 * instead. alfaview gives a full last page a token too, so one entry after it is read: when it
 * exists, `complete` is `false` and `nextPageToken` is the token of the next page.
 */
export async function fetchAllPages<T extends { id: string }>(
  api: CallApi,
  path: string,
  options: AllPagesOptions,
): Promise<PageList<T>> {
  const list = await readAllPages<T>(
    (pageToken, pageNumber) =>
      fetchPage<T>(api, path, {
        query: options.query,
        pageSize: options.pageSize,
        pageToken,
        allowStatuses: pageNumber === 1 ? options.allowStatuses : [],
      }),
    {
      path,
      maxPages: options.maxPages,
      tooManyResultsHint: options.tooManyResultsHint,
      pageLimit: options.pageLimit,
      pageToken: options.pageToken,
      tooManyResults: (message) => new ToolError('TooManyResults', message),
    },
  );
  if (list.complete) return list;

  // Only pageLimit leaves a list incomplete here, and then nextPageToken is the next page.
  const next = await fetchPage<T>(api, path, {
    query: options.query,
    pageSize: 1,
    pageToken: list.nextPageToken!,
  });
  return next.items.length === 0 ? { ...list, complete: true, nextPageToken: null } : list;
}
