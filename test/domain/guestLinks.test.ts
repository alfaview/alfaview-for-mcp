import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ApiRequest, ApiResponse, CallApi } from '../../src/alfaview/client.ts';
import { ToolError } from '../../src/alfaview/errors.ts';
import {
  ALL_ROOMS_DENIED_MESSAGE,
  CLEANUP_PAGE_LIMIT,
  DEFAULT_ORIGIN,
  DELETE_CONCURRENCY,
  DELETE_START_LIMIT_MS,
  duplicateGuestMessage,
  findExistingLink,
  getGuestLink,
  guestLinkCreatedButNotReadMessage,
  guestLinksHint,
  listGuestLinks,
  mapGuestLink,
  MISSING_LINK_ROOM_MESSAGE,
  roomOfLink,
  deleteLinksWithinBudget,
  type ApiGuestLink,
} from '../../src/domain/guestLinks.ts';
import { loginRequest, testApi, toolErrorOf, type ExpectedRequest } from '../helpers/fakeFetch.ts';
import { fixture } from '../helpers/fixtures.ts';
import { keepApiRequestProblems, testFileLine } from '../helpers/spec.ts';

const ROOM_ID = '0b7c5d2e-91a4-5f3b-8e27-0f4a6c9d1e22';
const LINK_ID = '3f2a9c1e-7b4d-5e21-a3c4-14b7e9d0f6a2';
const GUEST_GROUP_ID = 'd2b3c4d5-e6f7-5081-9a2b-c3d4e5f6a7b8';
const BERLIN = 'Europe/Berlin';
const NOW = Date.parse('2026-10-07T08:00:00Z');
const NAMES = new Map([[GUEST_GROUP_ID, 'Guest']]);

const link = () => fixture<ApiGuestLink>('guestLinks/guest-link.json');
const unbounded = () => fixture<ApiGuestLink>('guestLinks/guest-link-unbounded.json');

/** Returns the ToolError that `run` throws, and fails the test when it throws none. */
function errorOf(run: () => unknown): ToolError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ToolError);
    return error;
  }
  throw new assert.AssertionError({ message: 'Expected an error.' });
}

describe('mapGuestLink', () => {
  it('maps a link to the documented shape, in the documented key order', () => {
    const output = mapGuestLink(link(), NAMES, { timeZone: BERLIN });
    assert.deepEqual(output, {
      id: LINK_ID,
      roomId: ROOM_ID,
      inMeetingRoom: false,
      emailAddress: 'jane.doe@example.com',
      displayName: 'Jane Doe',
      joinUrl: `https://app.alfaview.com/#/join/0123456789ABCDEFGHIJKLMNOP/${ROOM_ID}/Hj7kL9zX2cV4bN6mQ8wE0rT1yU3iO5pA`,
      locale: 'de-DE',
      validFrom: '2026-10-07T10:45:00+02:00',
      validUntil: '2026-10-07T12:15:00+02:00',
      permissionGroupName: 'Guest',
      dialInAllowed: false,
      origin: 'Zapier',
      createdAt: '2026-09-25T12:00:00+02:00',
    });
    assert.deepEqual(Object.keys(output), [
      'id',
      'roomId',
      'inMeetingRoom',
      'emailAddress',
      'displayName',
      'joinUrl',
      'locale',
      'validFrom',
      'validUntil',
      'permissionGroupName',
      'dialInAllowed',
      'origin',
      'createdAt',
    ]);
  });

  it('leaves out roomId and joinUrl when asked', () => {
    const output = mapGuestLink(link(), NAMES, {
      timeZone: BERLIN,
      includeRoomId: false,
      includeJoinUrl: false,
    });
    assert.ok(!('roomId' in output));
    assert.ok(!('joinUrl' in output));
    assert.equal(Object.keys(output).length, 11);
  });

  // The kind byte of the room ID tells a meeting room without a request, also when the output
  // leaves out the room ID.
  it('gives inMeetingRoom from the kind of the room ID, also without roomId', () => {
    const meetingRoomId = '7e9a1c3d-5b2f-5a4e-8c6d-22f0a1b2c3d4';
    const inMeeting = mapGuestLink({ ...link(), roomId: meetingRoomId.toUpperCase() }, NAMES, {
      timeZone: BERLIN,
      includeRoomId: false,
    });
    assert.equal(inMeeting.inMeetingRoom, true);
    assert.equal(mapGuestLink(link(), NAMES, { timeZone: BERLIN }).inMeetingRoom, false);
  });

  it('leaves out the access key, the group ID, the dial-in code and the creator', () => {
    const output = mapGuestLink(unbounded(), NAMES, { timeZone: BERLIN }) as Record<string, unknown>;
    for (const key of ['accessKey', 'permissionGroupId', 'dialInCode', 'createdBy']) {
      assert.ok(!(key in output), key);
    }
  });

  it('turns year 1, empty and absent values into null', () => {
    const output = mapGuestLink(unbounded(), NAMES, { timeZone: BERLIN });
    assert.deepEqual(
      [output.displayName, output.validFrom, output.validUntil, output.permissionGroupName],
      [null, null, null, null],
    );
    assert.equal(output.createdAt, '2026-09-20T09:15:30+02:00');
  });

  it('finds the group name whatever the case of the ID', () => {
    const output = mapGuestLink(
      { ...link(), permissionGroupId: GUEST_GROUP_ID.toUpperCase() },
      NAMES,
      { timeZone: BERLIN },
    );
    assert.equal(output.permissionGroupName, 'Guest');
  });

  it('gives null for every field of a link with only an ID', () => {
    const output = mapGuestLink({ id: 'g1' }, new Map(), { timeZone: BERLIN });
    assert.deepEqual(output, {
      id: 'g1',
      roomId: null,
      inMeetingRoom: false,
      emailAddress: null,
      displayName: null,
      joinUrl: null,
      locale: null,
      validFrom: null,
      validUntil: null,
      permissionGroupName: null,
      dialInAllowed: null,
      origin: null,
      createdAt: null,
    });
  });

  // alfaview answers `unknown` for a guest link without a language (spec: GuestLink, `locale`).
  it('gives a null locale for unknown, in any case, and for an empty or blank one', () => {
    for (const locale of ['unknown', 'UNKNOWN', '', ' ']) {
      const output = mapGuestLink({ ...link(), locale }, NAMES, { timeZone: BERLIN });
      assert.equal(output.locale, null, JSON.stringify(locale));
    }
    assert.equal(mapGuestLink({ ...link(), locale: 'en-US' }, NAMES, { timeZone: BERLIN }).locale, 'en-US');
  });
});

describe('hints and messages', () => {
  it('give the hint for one room or for all rooms', () => {
    assert.equal(guestLinksHint(ROOM_ID), 'Delete old guest links of this room with delete_expired_guest_links.');
    assert.equal(guestLinksHint(undefined), 'Give roomId to read one room.');
  });

  it('name the default origin, a guest given twice and a link not read back', () => {
    assert.equal(DEFAULT_ORIGIN, 'MCP');
    assert.equal(
      duplicateGuestMessage('jane.doe@example.com'),
      'The guest list has jane.doe@example.com more than once. Give each email address once per call.',
    );
    assert.equal(
      guestLinkCreatedButNotReadMessage(LINK_ID),
      `alfaview created the guest link ${LINK_ID}, but reading it back failed. Call create_guest_links again with the same input: it returns this link as existing, with its join URL.`,
    );
  });
});

describe('listGuestLinks', () => {
  const roomLinks = `/v2/rooms/${ROOM_ID}/guest-links`;

  function pageRequest(path: string, pageToken: string | undefined, body: unknown): ExpectedRequest {
    return {
      method: 'GET',
      path,
      query: { limit: '500', ...(pageToken === undefined ? {} : { pageToken }) },
      respond: { status: 200, body },
    };
  }

  it('reads every page of a room with 500 links per page', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      pageRequest(roomLinks, undefined, { data: [link()], nextPageToken: 'p2' }),
      pageRequest(roomLinks, 'p2', { data: [unbounded()] }),
    ]);
    const list = await listGuestLinks(api, ROOM_ID);
    assert.deepEqual(list.items.map((item) => item.id), [LINK_ID, unbounded().id]);
    assert.equal(list.complete, true);
    fake.assertDone();
  });

  it('reads the company-wide list without a room', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      pageRequest('/v2/guest-links', undefined, { data: [link()] }),
    ]);
    assert.equal((await listGuestLinks(api, undefined)).items.length, 1);
    fake.assertDone();
  });

  for (const status of [403, 404]) {
    it(`explains the user permissions when the company-wide list answers ${status}`, async () => {
      const { api, fake } = testApi([
        loginRequest(),
        { method: 'GET', path: '/v2/guest-links', query: { limit: '500' }, respond: { status } },
      ]);
      const error = await toolErrorOf(listGuestLinks(api, undefined));
      assert.deepEqual([error.code, error.message, error.status], [
        'Forbidden',
        ALL_ROOMS_DENIED_MESSAGE,
        status,
      ]);
      fake.assertDone();
    });
  }

  it('shows a 404 of a room as the room that alfaview cannot find', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'GET', path: roomLinks, query: { limit: '500' }, respond: { status: 404 } },
    ]);
    const error = await toolErrorOf(listGuestLinks(api, ROOM_ID));
    assert.deepEqual([error.code, error.message], [
      'NotFound',
      "alfaview could not find the room. It was deleted, or the API key's user cannot see it.",
    ]);
    fake.assertDone();
  });

  it('stops quietly at the page limit, and goes on from its token', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      pageRequest(roomLinks, undefined, { data: [link()], nextPageToken: 'p2' }),
      {
        method: 'GET',
        path: roomLinks,
        query: { limit: '1', pageToken: 'p2' },
        respond: { status: 200, body: { data: [unbounded()], nextPageToken: 'p3' } },
      },
      pageRequest(roomLinks, 'p2', { data: [unbounded()] }),
    ]);
    const first = await listGuestLinks(api, ROOM_ID, { pageLimit: 1 });
    const next = await listGuestLinks(api, ROOM_ID, { pageLimit: 1, pageToken: 'p2' });
    assert.deepEqual([first.items.length, first.complete, first.nextPageToken], [1, false, 'p2']);
    assert.deepEqual([next.items[0]?.id, next.complete, next.nextPageToken], [unbounded().id, true, null]);
    assert.equal(CLEANUP_PAGE_LIMIT, 20);
    fake.assertDone();
  });

  it('names the cleanup in the TooManyResults error of a room', async () => {
    const requests = Array.from({ length: 51 }, (_, index) =>
      pageRequest(roomLinks, index === 0 ? undefined : `p${index}`, {
        data: [{ id: `l${index}` }],
        nextPageToken: `p${index + 1}`,
      }),
    );
    const { api, fake } = testApi([loginRequest(), ...requests]);
    const error = await toolErrorOf(listGuestLinks(api, ROOM_ID));
    assert.deepEqual([error.code, error.message], [
      'TooManyResults',
      'alfaview returned more than 50 pages of guest links. Delete old guest links of this room with delete_expired_guest_links.',
    ]);
    fake.assertDone();
  });
});

describe('getGuestLink', () => {
  const path = `/v2/guest-links/${LINK_ID}`;

  it('reads the link', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'GET', path, respond: { status: 200, body: link() } },
    ]);
    assert.equal((await getGuestLink(api, LINK_ID)).id, LINK_ID);
    fake.assertDone();
  });

  it('throws NotFound for 404 and InvalidResponse for a body without an ID', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'GET', path, respond: { status: 404 } },
      { method: 'GET', path, respond: { status: 200, body: { roomId: ROOM_ID } } },
    ]);
    const notFound = await toolErrorOf(getGuestLink(api, LINK_ID));
    assert.deepEqual([notFound.code, notFound.message], [
      'NotFound',
      "alfaview could not find the guest link. It was deleted, or the API key's user cannot see it.",
    ]);
    const invalid = await toolErrorOf(getGuestLink(api, LINK_ID));
    assert.deepEqual([invalid.code, invalid.message], [
      'InvalidResponse',
      'alfaview did not return the guest link.',
    ]);
    fake.assertDone();
  });

  it('with allowNotFound gives undefined for 404 and still throws other errors', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'GET', path, respond: { status: 404 } },
      { method: 'GET', path, respond: { status: 500 } },
    ]);
    assert.equal(await getGuestLink(api, LINK_ID, { allowNotFound: true }), undefined);
    assert.equal((await toolErrorOf(getGuestLink(api, LINK_ID, { allowNotFound: true }))).code, 'ServerError');
    fake.assertDone();
  });
});

describe('roomOfLink', () => {
  it('roomOfLink returns the room or fails when alfaview returned none', () => {
    assert.equal(roomOfLink(link()), ROOM_ID);
    for (const roomId of [undefined, '', 7]) {
      const error = errorOf(() => roomOfLink({ roomId }));
      assert.deepEqual([error.code, error.message], ['InvalidResponse', MISSING_LINK_ROOM_MESSAGE]);
    }
  });
});

describe('findExistingLink', () => {
  const input = {
    origin: 'Webinar 2026-10-07',
    validFrom: '2026-10-07T16:30:00.000Z',
    validUntil: '2026-10-07T19:30:00.000Z',
    permissionGroupId: GUEST_GROUP_ID,
    dialInAllowed: false,
  };
  const guest = { emailAddress: 'Jane.Doe@example.com ' };
  const matching: ApiGuestLink = {
    id: 'l1',
    emailAddress: 'jane.doe@example.com',
    origin: 'Webinar 2026-10-07',
    validFrom: '2026-10-07T18:30:00+02:00',
    validUntil: '2026-10-07T19:30:00Z',
    permissionGroupId: GUEST_GROUP_ID.toUpperCase(),
    dialInAllowed: false,
    createdAt: '2026-09-01T00:00:00Z',
  };

  it('finds a link with the same email address, origin, validity and rights, the group ID in any case', () => {
    assert.deepEqual(findExistingLink([matching], guest, input, NOW), {
      link: matching,
      sameRights: true,
    });
  });

  it('gives the newest of several matching links', () => {
    const newer = { ...matching, id: 'l2', createdAt: '2026-09-02T00:00:00Z' };
    assert.equal(findExistingLink([matching, newer], guest, input, NOW)?.link.id, 'l2');
  });

  for (const [name, change] of [
    ['another permission group', { permissionGroupId: 'f4a5b6c7-d8e9-5f0a-9b1c-2d3e4f5a6b7c' }],
    ['no permission group', { permissionGroupId: undefined }],
    ['another dial-in setting', { dialInAllowed: true }],
    ['no dial-in setting', { dialInAllowed: undefined }],
  ] as const) {
    it(`gives a link with ${name} with sameRights false`, () => {
      const other = { ...matching, ...change };
      assert.deepEqual(findExistingLink([other], guest, input, NOW), {
        link: other,
        sameRights: false,
      });
    });
  }

  it('prefers an older link with the rights to a newer one without them', () => {
    const newer = { ...matching, id: 'l2', createdAt: '2026-09-02T00:00:00Z', dialInAllowed: true };
    assert.deepEqual(findExistingLink([newer, matching], guest, input, NOW), {
      link: matching,
      sameRights: true,
    });
  });

  for (const [name, change] of [
    ['another origin', { origin: 'Webinar 2026-10-08' }],
    ['an origin in another case', { origin: 'webinar 2026-10-07' }],
    ['another validFrom', { validFrom: '2026-10-07T16:00:00Z' }],
    ['another validUntil', { validUntil: '2026-10-07T19:30:01Z' }],
    ['another email address', { emailAddress: 'max@example.com' }],
    ['no email address', { emailAddress: undefined }],
    ['no validFrom', { validFrom: undefined }],
  ] as const) {
    it(`finds nothing for a link with ${name}`, () => {
      assert.equal(findExistingLink([{ ...matching, ...change }], guest, input, NOW), undefined);
    });
  }

  it('matches a missing bound only with a missing bound, year 1 counting as missing', () => {
    const open = { ...matching, validFrom: '0001-01-01T00:00:00Z', validUntil: undefined };
    const openInput = { ...input, validFrom: undefined, validUntil: undefined };
    assert.equal(findExistingLink([open], guest, openInput, NOW)?.link.id, 'l1');
    assert.equal(findExistingLink([open], guest, input, NOW), undefined);
    assert.equal(findExistingLink([matching], guest, openInput, NOW), undefined);
  });

  it('finds nothing when validUntil is not after now', () => {
    const now = Date.parse(input.validUntil);
    assert.equal(findExistingLink([matching], guest, input, now), undefined);
    assert.equal(findExistingLink([matching], guest, input, now - 1)?.link.id, 'l1');
  });

  it('compares instants to the millisecond', () => {
    const precise = { ...input, validUntil: '2026-10-07T19:30:00.001Z' };
    assert.equal(findExistingLink([matching], guest, precise, NOW), undefined);
  });
});

describe('deleteLinksWithinBudget', () => {
  type Pending = { path: string; resolve: () => void; reject: (error: unknown) => void };

  /**
   * Returns a call API whose requests the test answers by hand, with a clock that the test sets.
   * Each request goes through the contract check against the API spec, without the headers that
   * the client adds.
   */
  function manualApi() {
    const pending: Pending[] = [];
    const paths: string[] = [];
    let elapsed = 0;
    const site = testFileLine();
    const api: CallApi = {
      request<T>(request: ApiRequest): Promise<ApiResponse<T>> {
        assert.equal(request.method, 'DELETE');
        keepApiRequestProblems(request, site);
        paths.push(request.path);
        return new Promise((resolve, reject) => {
          pending.push({
            path: request.path,
            resolve: () => resolve({ status: 204, data: undefined }),
            reject,
          });
        });
      },
      requestCount: 0,
      elapsedMs: () => elapsed,
    };
    return {
      api,
      pending,
      paths,
      setElapsed(value: number) {
        elapsed = value;
      },
    };
  }

  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const ids = (count: number) => Array.from({ length: count }, (_, index) => `link-${index}`);
  const forbidden = () =>
    new ToolError(
      'Forbidden',
      "The API key's user is not allowed to do this (missing room join permissions). Give that user the needed room or user permission.",
      403,
    );

  it('keeps at most 5 deletes in flight and deletes every link', async () => {
    const { api, pending, paths } = manualApi();
    const done = deleteLinksWithinBudget(api, ROOM_ID.toUpperCase(), ids(12));
    let maxInFlight = 0;
    while (paths.length < 12 || pending.length > 0) {
      await flush();
      maxInFlight = Math.max(maxInFlight, pending.length);
      pending.shift()?.resolve();
    }
    assert.equal(await done, 12);
    assert.equal(maxInFlight, DELETE_CONCURRENCY);
    assert.equal(paths[0], `/v2/rooms/${ROOM_ID}/guest-links/link-0`);
    assert.equal(new Set(paths).size, 12);
  });

  it('starts no delete once the call has run for 30 seconds', async () => {
    const { api, pending, setElapsed } = manualApi();
    setElapsed(DELETE_START_LIMIT_MS - 1);
    const done = deleteLinksWithinBudget(api, ROOM_ID, ids(10));
    await flush();
    assert.equal(pending.length, 5);
    setElapsed(DELETE_START_LIMIT_MS);
    for (const request of pending.splice(0)) request.resolve();
    assert.equal(await done, 5);
    assert.equal(pending.length, 0);
  });

  it('stops starting deletes after a failure and counts the deletes that finished', async () => {
    const { api, pending } = manualApi();
    const done = deleteLinksWithinBudget(api, ROOM_ID, ids(3));
    await flush();
    const [first, second, third] = pending.splice(0);
    first?.reject(forbidden());
    second?.resolve();
    third?.resolve();
    const error = await toolErrorOf(done);
    assert.deepEqual([error.code, error.message, error.status], [
      'Forbidden',
      "The API key's user is not allowed to do this (missing room join permissions). Give that user the needed room or user permission. 2 links were deleted before the error.",
      403,
    ]);
    assert.equal(pending.length, 0);
  });

  it('uses the singular for one deleted link and keeps the field locations', async () => {
    const { api, pending } = manualApi();
    const done = deleteLinksWithinBudget(api, ROOM_ID, ids(2));
    await flush();
    const [first, second] = pending.splice(0);
    first?.reject(new ToolError('ValidationFailed', 'bad.', 422, ['body.x']));
    second?.resolve();
    const error = await toolErrorOf(done);
    assert.deepEqual([error.message, error.fieldLocations], [
      'bad. 1 link was deleted before the error.',
      ['body.x'],
    ]);
  });

  it('rethrows an error that is not a ToolError unchanged', async () => {
    const failure = new TypeError('bug');
    const { api } = manualApi();
    const site = testFileLine();
    const failing: CallApi = {
      ...api,
      request: (request) => {
        keepApiRequestProblems(request, site);
        return Promise.reject(failure);
      },
    };
    await assert.rejects(deleteLinksWithinBudget(failing, ROOM_ID, ids(1)), (error) => error === failure);
  });

  it('sends nothing for an empty list', async () => {
    const { api, paths } = manualApi();
    assert.equal(await deleteLinksWithinBudget(api, ROOM_ID, []), 0);
    assert.deepEqual(paths, []);
  });
});
