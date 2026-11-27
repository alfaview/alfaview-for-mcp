import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  fetchAllPages,
  fetchPage,
  type AllPagesOptions,
  type PageOptions,
} from '../../src/alfaview/pagination.ts';
import { loginRequest, testApi, toolErrorOf, type ExpectedRequest } from '../helpers/fakeFetch.ts';
import { fixture } from '../helpers/fixtures.ts';

type Item = { id: string };

const ROOM_ID = '0b7c5d2e-91a4-5f3b-8e27-0f4a6c9d1e22';
const LINKS_PATH = `/v2/rooms/${ROOM_ID}/guest-links`;

const idsOf = (items: readonly Item[]) => items.map((item) => item.id);

/** Returns the body of a page with these IDs, and `nextPageToken` when it is given. */
function page(ids: readonly string[], nextPageToken?: string) {
  return { data: ids.map((id) => ({ id })), ...(nextPageToken ? { nextPageToken } : {}) };
}

/**
 * Returns the requests of a list with these pages. The next tokens are t1, t2 and so on, and the
 * last page has none.
 */
function pageRequests(
  path: string,
  pages: readonly (readonly string[])[],
  pageSize: number,
  extra: Record<string, string> = {},
): ExpectedRequest[] {
  return pages.map((ids, index) => ({
    method: 'GET',
    path,
    query: {
      ...extra,
      limit: String(pageSize),
      ...(index === 0 ? {} : { pageToken: `t${index}` }),
    },
    respond: {
      status: 200,
      body: page(ids, index + 1 < pages.length ? `t${index + 1}` : undefined),
    },
  }));
}

/** Returns the requests of `count` pages of one item each, each page with a next token. */
function onePerPage(path: string, count: number): ExpectedRequest[] {
  return Array.from({ length: count }, (_, index): ExpectedRequest => ({
    method: 'GET',
    path,
    query: index === 0 ? { limit: '1' } : { limit: '1', pageToken: `t${index}` },
    respond: { status: 200, body: page([`i${index}`], `t${index + 1}`) },
  }));
}

async function readPage(path: string, options: PageOptions, requests: ExpectedRequest[]) {
  const { api, fake } = testApi([loginRequest(), ...requests]);
  try {
    return await fetchPage<Item>(api, path, options);
  } finally {
    fake.assertDone();
  }
}

async function readAll(path: string, options: AllPagesOptions, requests: ExpectedRequest[]) {
  const { api, fake } = testApi([loginRequest(), ...requests]);
  try {
    return await fetchAllPages<Item>(api, path, options);
  } finally {
    fake.assertDone();
  }
}

describe('fetchPage', () => {
  it('sends limit and pageToken and returns the items and the next token', async () => {
    const roomsPage = fixture('core/rooms-page-1.json');
    const result = await readPage(
      '/v2/rooms',
      { query: { roomTypes: 'room' }, pageSize: 50, pageToken: 'abc' },
      [
        {
          method: 'GET',
          path: '/v2/rooms',
          query: { roomTypes: 'room', limit: '50', pageToken: 'abc' },
          respond: { status: 200, body: roomsPage },
        },
      ],
    );
    assert.deepEqual(idsOf(result.items), idsOf(roomsPage.data));
    assert.equal(result.nextPageToken, 'c2Vjb25kLXBhZ2U');
    assert.equal(result.status, 200);
  });

  it('returns a null token when alfaview sends none, and omits pageToken on the first page', async () => {
    const result = await readPage('/v2/rooms', { pageSize: 50 }, [
      {
        method: 'GET',
        path: '/v2/rooms',
        query: { limit: '50' },
        respond: { status: 200, body: fixture('core/rooms-page-2.json') },
      },
    ]);
    assert.equal(result.items.length, 1);
    assert.equal(result.nextPageToken, null);
  });

  it('treats data: null as an empty page and an empty token as none', async () => {
    assert.deepEqual(
      await readPage('/v2/rooms', { pageSize: 50 }, [
        {
          method: 'GET',
          path: '/v2/rooms',
          query: { limit: '50' },
          respond: { status: 200, body: { data: null, nextPageToken: '' } },
        },
      ]),
      { status: 200, items: [], nextPageToken: null },
    );
  });

  it('treats a page without data as empty', async () => {
    const result = await readPage('/v2/rooms', { pageSize: 50 }, [
      { method: 'GET', path: '/v2/rooms', query: { limit: '50' }, respond: { status: 200, body: {} } },
    ]);
    assert.deepEqual(result.items, []);
  });

  it('leaves out entries without a text ID', async () => {
    const result = await readPage(LINKS_PATH, { pageSize: 500 }, [
      {
        method: 'GET',
        path: LINKS_PATH,
        query: { limit: '500' },
        respond: { status: 200, body: { data: [null, { id: 7 }, 'x', { id: 'ok' }] } },
      },
    ]);
    assert.deepEqual(result.items, [{ id: 'ok' }]);
  });

  it('returns an allowed error status without items', async () => {
    assert.deepEqual(
      await readPage('/v2/guest-links', { pageSize: 500, allowStatuses: [403, 404] }, [
        {
          method: 'GET',
          path: '/v2/guest-links',
          query: { limit: '500' },
          respond: { status: 404, body: fixture('core/problem-404.json') },
        },
      ]),
      { status: 404, items: [], nextPageToken: null },
    );
  });

  it('throws the mapped error for other statuses', async () => {
    const error = await toolErrorOf(
      readPage(LINKS_PATH, { pageSize: 500 }, [
        {
          method: 'GET',
          path: LINKS_PATH,
          query: { limit: '500' },
          respond: { status: 403, body: fixture('core/problem-403.json') },
        },
      ]),
    );
    assert.deepEqual([error.code, error.status], ['Forbidden', 403]);
  });

  for (const [name, body] of [
    ['a bare array', [1, 2]],
    ['data that is not an array', { data: { id: 'r1' } }],
    ['an empty body', ''],
  ] as const) {
    it(`fails with InvalidResponse for ${name}`, async () => {
      const error = await toolErrorOf(
        readPage('/v2/rooms', { pageSize: 50 }, [
          { method: 'GET', path: '/v2/rooms', query: { limit: '50' }, respond: { status: 200, body } },
        ]),
      );
      assert.deepEqual([error.code, error.message], [
        'InvalidResponse',
        'alfaview sent an unexpected response for /v2/rooms.',
      ]);
    });
  }

  for (const pageSize of [0, -1, 1.5]) {
    it(`refuses page size ${pageSize} before any request`, async () => {
      const { api, fake } = testApi([]);
      await assert.rejects(fetchPage(api, '/v2/rooms', { pageSize }), (error) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /^pageSize must be a positive integer/);
        return true;
      });
      fake.assertDone();
    });
  }
});

describe('fetchAllPages', () => {
  it('follows nextPageToken, keeps the query on every page and joins the items', async () => {
    const first = fixture('core/rooms-page-1.json');
    const second = fixture('core/rooms-page-2.json');
    const list = await readAll('/v2/rooms', { query: { roomTypes: 'room' }, pageSize: 2 }, [
      {
        method: 'GET',
        path: '/v2/rooms',
        query: { roomTypes: 'room', limit: '2' },
        respond: { status: 200, body: first },
      },
      {
        method: 'GET',
        path: '/v2/rooms',
        query: { roomTypes: 'room', limit: '2', pageToken: 'c2Vjb25kLXBhZ2U' },
        respond: { status: 200, body: second },
      },
    ]);
    assert.deepEqual(idsOf(list.items), [...idsOf(first.data), ...idsOf(second.data)]);
    assert.deepEqual([list.status, list.complete], [200, true]);
  });

  it('stops at an empty page even when it carries a token', async () => {
    const list = await readAll(LINKS_PATH, { pageSize: 500 }, [
      {
        method: 'GET',
        path: LINKS_PATH,
        query: { limit: '500' },
        respond: { status: 200, body: page(['a'], 'page-2') },
      },
      {
        method: 'GET',
        path: LINKS_PATH,
        query: { limit: '500', pageToken: 'page-2' },
        respond: { status: 200, body: { data: [], nextPageToken: 'page-3' } },
      },
    ]);
    assert.deepEqual(list, { status: 200, items: [{ id: 'a' }], complete: true, nextPageToken: null });
  });

  it('reads the extra empty page that follows a full last page', async () => {
    const list = await readAll(
      '/v2/guest-links',
      { pageSize: 2 },
      pageRequests('/v2/guest-links', [['g1', 'g2'], []], 2),
    );
    assert.deepEqual(idsOf(list.items), ['g1', 'g2']);
  });

  it('throws TooManyResults with the hint when there are more than maxPages pages', async () => {
    const error = await toolErrorOf(
      readAll(
        LINKS_PATH,
        { pageSize: 1, maxPages: 2, tooManyResultsHint: 'Give roomId to read one room.' },
        onePerPage(LINKS_PATH, 3),
      ),
    );
    assert.deepEqual([error.code, error.message], [
      'TooManyResults',
      'alfaview returned more than 2 pages of guest links. Give roomId to read one room.',
    ]);
  });

  it('throws TooManyResults without a hint sentence when none is given', async () => {
    const error = await toolErrorOf(
      readAll('/v2/group-links', { pageSize: 1, maxPages: 1 }, onePerPage('/v2/group-links', 2)),
    );
    assert.equal(error.message, 'alfaview returned more than 1 pages of group links.');
  });

  it('accepts exactly maxPages full pages followed by an empty page', async () => {
    const list = await readAll('/v2/rooms', { pageSize: 1, maxPages: 2 }, [
      ...onePerPage('/v2/rooms', 2),
      {
        method: 'GET',
        path: '/v2/rooms',
        query: { limit: '1', pageToken: 't2' },
        respond: { status: 200, body: { data: [] } },
      },
    ]);
    assert.deepEqual(idsOf(list.items), ['i0', 'i1']);
    assert.equal(list.complete, true);
  });

  it('defaults to 50 pages', async () => {
    const error = await toolErrorOf(readAll('/v2/rooms', { pageSize: 1 }, onePerPage('/v2/rooms', 51)));
    assert.equal(error.message, 'alfaview returned more than 50 pages of rooms.');
  });

  it('reads 50 full pages and the empty page after them', async () => {
    const pages: string[][] = Array.from({ length: 50 }, (_, index) => [`link-${index}`]);
    pages.push([]);
    const list = await readAll(LINKS_PATH, { pageSize: 500 }, pageRequests(LINKS_PATH, pages, 500));
    assert.equal(list.items.length, 50);
    assert.equal(list.complete, true);
  });

  it('returns an allowed status of the first page without items', async () => {
    assert.deepEqual(
      await readAll('/v2/guest-links', { pageSize: 500, allowStatuses: [403, 404] }, [
        {
          method: 'GET',
          path: '/v2/guest-links',
          query: { limit: '500' },
          respond: { status: 403, body: fixture('core/problem-403.json') },
        },
      ]),
      { status: 403, items: [], complete: true, nextPageToken: null },
    );
  });

  it('allows the statuses only on the first page', async () => {
    const error = await toolErrorOf(
      readAll('/v2/guest-links', { pageSize: 500, allowStatuses: [404] }, [
        {
          method: 'GET',
          path: '/v2/guest-links',
          query: { limit: '500' },
          respond: { status: 200, body: page(['a'], 'page-2') },
        },
        {
          method: 'GET',
          path: '/v2/guest-links',
          query: { limit: '500', pageToken: 'page-2' },
          respond: { status: 404, body: fixture('core/problem-404.json') },
        },
      ]),
    );
    assert.deepEqual([error.code, error.status], ['NotFound', 404]);
  });

  describe('pageLimit', () => {
    /** Returns the request of one entry after the last page, with the token of that page. */
    const nextEntry = (pageToken: string, ids: string[]): ExpectedRequest => ({
      method: 'GET',
      path: LINKS_PATH,
      query: { limit: '1', pageToken },
      respond: { status: 200, body: page(ids, ids.length > 0 ? 'after' : undefined) },
    });

    it('stops quietly after the page limit, and gives the token of the next page when an entry follows', async () => {
      const list = await readAll(LINKS_PATH, { pageSize: 500, pageLimit: 2 }, [
        ...pageRequests(LINKS_PATH, [['a'], ['b'], ['c']], 500).slice(0, 2),
        nextEntry('t2', ['c']),
      ]);
      assert.deepEqual(list, {
        status: 200,
        items: [{ id: 'a' }, { id: 'b' }],
        complete: false,
        nextPageToken: 't2',
      });
    });

    it('is complete when no entry follows the last page, which alfaview gave a token', async () => {
      const list = await readAll(LINKS_PATH, { pageSize: 500, pageLimit: 2 }, [
        ...pageRequests(LINKS_PATH, [['a'], ['b'], []], 500).slice(0, 2),
        nextEntry('t2', []),
      ]);
      assert.deepEqual(list, {
        status: 200,
        items: [{ id: 'a' }, { id: 'b' }],
        complete: true,
        nextPageToken: null,
      });
    });

    it('starts at pageToken', async () => {
      const list = await readAll(LINKS_PATH, { pageSize: 500, pageLimit: 2, pageToken: 't5' }, [
        {
          method: 'GET',
          path: LINKS_PATH,
          query: { limit: '500', pageToken: 't5' },
          respond: { status: 200, body: page(['f'], 't6') },
        },
        {
          method: 'GET',
          path: LINKS_PATH,
          query: { limit: '500', pageToken: 't6' },
          respond: { status: 200, body: page(['g']) },
        },
      ]);
      assert.deepEqual(list, {
        status: 200,
        items: [{ id: 'f' }, { id: 'g' }],
        complete: true,
        nextPageToken: null,
      });
    });

    it('is complete when page pageLimit is the last page', async () => {
      const list = await readAll(
        LINKS_PATH,
        { pageSize: 500, pageLimit: 2 },
        pageRequests(LINKS_PATH, [['a'], ['b']], 500),
      );
      assert.deepEqual(list, {
        status: 200,
        items: [{ id: 'a' }, { id: 'b' }],
        complete: true,
        nextPageToken: null,
      });
    });

    it('is complete when the list has fewer pages than the limit', async () => {
      const list = await readAll(
        LINKS_PATH,
        { pageSize: 500, pageLimit: 20 },
        pageRequests(LINKS_PATH, [['a']], 500),
      );
      assert.equal(list.complete, true);
    });

    it('reads 20 pages whose last has no token as complete', async () => {
      const pages = Array.from({ length: 20 }, (_, index) => [`link-${index}`]);
      const list = await readAll(
        LINKS_PATH,
        { pageSize: 500, pageLimit: 20 },
        pageRequests(LINKS_PATH, pages, 500),
      );
      assert.equal(list.items.length, 20);
      assert.equal(list.complete, true);
    });
  });
});
