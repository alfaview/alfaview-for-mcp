import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../../src/alfaview/errors.ts';
import {
  ADMIN_GROUP_MESSAGE,
  filterGroupLinks,
  getGroupLink,
  GROUP_LINK_ALONE_MESSAGE,
  GROUP_LINK_DELETE_NOT_FOUND_MESSAGE,
  GROUP_LINK_ID_MISSING_MESSAGE,
  GROUP_LINK_MEETING_ROOM_MESSAGE,
  GROUP_LINK_PAST_VALID_UNTIL_MESSAGE,
  GROUP_LINK_UNCERTAIN_MESSAGE,
  groupLinkCreatedButNotReadMessage,
  groupLinkUpdatedButNotReadMessage,
  isMeetingRoomId,
  listGroupLinks,
  mapGroupLink,
  MISSING_GROUP_LINK_ROOM_MESSAGE,
  refuseMeetingRoom,
  roomOfGroupLink,
  type ApiGroupLink,
} from '../../src/domain/groupLinks.ts';
import { ALL_ROOMS_DENIED_MESSAGE } from '../../src/domain/guestLinks.ts';
import { loginRequest, testApi, toolErrorOf, type ExpectedRequest } from '../helpers/fakeFetch.ts';
import { fixture } from '../helpers/fixtures.ts';

const ROOM_ID = '0b7c5d2e-91a4-5f3b-8e27-0f4a6c9d1e22';
const LINK_ID = '8d4e2f1a-6c3b-5a9e-b2d7-c75e1f0a3b94';
const GUEST_GROUP_ID = 'd2b3c4d5-e6f7-5081-9a2b-c3d4e5f6a7b8';
const BERLIN = 'Europe/Berlin';
const NOW = Date.parse('2026-10-07T08:00:00Z');
const NAMES = new Map([[GUEST_GROUP_ID, 'Guest']]);
const JOIN_URL = `https://app.alfaview.com/#/join/0123456789ABCDEFGHIJKLMNOP/${ROOM_ID}/Pq4wE6rT8yU0iO2pA3sD5fG7hJ9kL1zX`;

/** Returns a version 5 room ID with `kind` in byte 10, in the observed layout of alfaview IDs. */
const roomIdOfKind = (kind: string) => `c0ffee00-0000-5000-8000-${kind}0000000001`;
/** The meeting of test/fixtures/meetings/meeting.json: version 5, kind 34 (hex 22). */
const MEETING_ID = '7e9a1c3d-5b2f-5a4e-8c6d-22f0a1b2c3d4';

const link = (overrides: Partial<ApiGroupLink> = {}): ApiGroupLink => ({
  ...fixture<ApiGroupLink>('groupLinks/group-link.json'),
  ...overrides,
});

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

describe('isMeetingRoomId', () => {
  it('is true for a version 5 UUID of the kind 34 (hex 22) in byte 10, in any case', () => {
    assert.equal(isMeetingRoomId(MEETING_ID), true);
    assert.equal(isMeetingRoomId(MEETING_ID.toUpperCase()), true);
    assert.equal(isMeetingRoomId(roomIdOfKind('22')), true);
  });

  it('is false for the version 5 IDs of other kinds', () => {
    // The kind bytes in hex, as observed: 20 a room, 21 a breakout room, 23 a waiting room, 17 a
    // department, 14 a guest link, 15 a group link, 18 a guest.
    for (const kind of ['20', '21', '23', '17', '14', '15', '18', '0f', '2a']) {
      assert.equal(isMeetingRoomId(roomIdOfKind(kind)), false, kind);
    }
    assert.equal(isMeetingRoomId(ROOM_ID), false);
  });

  it('is false for a version 4 UUID, also with 22 in byte 10: an old room is never a meeting room', () => {
    assert.equal(isMeetingRoomId('7e9a1c3d-5b2f-4a4e-8c6d-22f0a1b2c3d4'), false);
    assert.equal(isMeetingRoomId('0b7c5d2e-91a4-4f3b-8e27-0f4a6c9d1e22'), false);
  });

  it('is false for another variant, a broken UUID and a text', () => {
    assert.equal(isMeetingRoomId('7e9a1c3d-5b2f-5a4e-cc6d-22f0a1b2c3d4'), false);
    assert.equal(isMeetingRoomId('7e9a1c3d-5b2f-5a4e-8c6d-22f0a1b2c3d'), false);
    assert.equal(isMeetingRoomId(` ${MEETING_ID}`), false);
    assert.equal(isMeetingRoomId(`${MEETING_ID}0`), false);
    assert.equal(isMeetingRoomId(`${MEETING_ID} `), false);
    assert.equal(isMeetingRoomId('Review'), false);
  });
});

describe('refuseMeetingRoom', () => {
  it('refuses a meeting room with the code MeetingRoomRefused, and lets every other room pass', () => {
    const error = errorOf(() => refuseMeetingRoom(MEETING_ID));
    assert.deepEqual([error.code, error.message, error.status], [
      'MeetingRoomRefused',
      GROUP_LINK_MEETING_ROOM_MESSAGE,
      undefined,
    ]);
    refuseMeetingRoom(ROOM_ID);
    refuseMeetingRoom(roomIdOfKind('20'));
  });
});

describe('mapGroupLink', () => {
  it('maps a link to the output shape, in its key order', () => {
    const output = mapGroupLink(link(), NAMES, { timeZone: BERLIN });
    assert.deepEqual(output, {
      id: LINK_ID,
      roomId: ROOM_ID,
      description: 'Open house',
      joinUrl: JOIN_URL,
      permissionGroupName: 'Guest',
      validFrom: '2026-10-07T10:45:00+02:00',
      validUntil: '2026-10-07T12:15:00+02:00',
      dialInAllowed: false,
      origin: 'Zapier',
      createdAt: '2026-09-25T12:00:00+02:00',
      meetingLink: false,
    });
    assert.deepEqual(Object.keys(output), [
      'id',
      'roomId',
      'description',
      'joinUrl',
      'permissionGroupName',
      'validFrom',
      'validUntil',
      'dialInAllowed',
      'origin',
      'createdAt',
      'meetingLink',
    ]);
  });

  it('leaves out roomId and joinUrl when asked', () => {
    const output = mapGroupLink(link(), NAMES, {
      timeZone: BERLIN,
      includeRoomId: false,
      includeJoinUrl: false,
    });
    assert.ok(!('roomId' in output));
    assert.ok(!('joinUrl' in output));
    assert.equal(Object.keys(output).length, 9);
  });

  it('leaves out the room name, the group ID, the access key, joinLink, the dial-in code and the creator', () => {
    const output = mapGroupLink(link({ dialInCode: '123456' }), NAMES, { timeZone: BERLIN });
    for (const key of [
      'roomName',
      'permissionGroupId',
      'accessKey',
      'joinLink',
      'dialInCode',
      'createdBy',
      'validFromLocal',
      'validUntilLocal',
    ]) {
      assert.ok(!(key in output), key);
    }
  });

  it('gives null for every absent value and false for meetingLink of a link with only an ID', () => {
    assert.deepEqual(mapGroupLink({ id: 'g1' }, new Map(), { timeZone: BERLIN }), {
      id: 'g1',
      roomId: null,
      description: null,
      joinUrl: null,
      permissionGroupName: null,
      validFrom: null,
      validUntil: null,
      dialInAllowed: null,
      origin: null,
      createdAt: null,
      meetingLink: false,
    });
  });

  it('turns year 1 times into null, and finds the group name whatever the case of its ID', () => {
    const output = mapGroupLink(
      link({
        validFrom: '0001-01-01T00:00:00Z',
        validUntil: '0001-01-01T00:00:00Z',
        permissionGroupId: GUEST_GROUP_ID.toUpperCase(),
      }),
      NAMES,
      { timeZone: BERLIN },
    );
    assert.deepEqual([output.validFrom, output.validUntil, output.permissionGroupName], [null, null, 'Guest']);
  });

  it('marks the link of a meeting room, and no link of another room', () => {
    const marked = (roomId: string) =>
      mapGroupLink(link({ roomId }), NAMES, { timeZone: BERLIN }).meetingLink;
    assert.equal(marked(MEETING_ID), true);
    assert.equal(marked(roomIdOfKind('20')), false);
    assert.equal(marked('7e9a1c3d-5b2f-4a4e-8c6d-22f0a1b2c3d4'), false);
    assert.equal(marked(''), false);
  });
});

describe('filterGroupLinks', () => {
  const at = (n: number, fields: Partial<ApiGroupLink>): ApiGroupLink => ({
    id: `aa000000-0000-5000-8000-15000000000${n}`,
    ...fields,
  });
  const open = at(1, { description: 'Open House', origin: 'MCP Open house', createdAt: '2026-10-01T10:00:00Z' });
  const webinar = at(2, {
    description: 'Webinar Altersvorsorge',
    origin: 'Zapier',
    validUntil: '2026-10-06T10:00:00Z',
    createdAt: '2026-10-03T10:00:00Z',
  });
  const unbounded = at(3, {
    description: 'Lobby',
    origin: 'mcp',
    validUntil: '0001-01-01T00:00:00Z',
    createdAt: '2026-10-02T10:00:00Z',
  });
  const later = at(4, {
    description: 'Open house 2',
    validUntil: '2026-10-07T08:00:01Z',
    createdAt: '2026-10-01T10:00:00Z',
  });
  const links = [open, webinar, unbounded, later];
  const ids = (result: { links: ApiGroupLink[] }) => result.links.map((entry) => entry.id.slice(-1));

  it('keeps the links whose validUntil has not passed, newest first, then by ID, and counts the expired ones', () => {
    const result = filterGroupLinks(links, { includeExpired: false }, NOW);
    assert.deepEqual(ids(result), ['3', '1', '4']);
    assert.equal(result.expiredMatchCount, 1);
  });

  it('returns the expired links with includeExpired, and still counts them', () => {
    const result = filterGroupLinks(links, { includeExpired: true }, NOW);
    assert.deepEqual(ids(result), ['2', '3', '1', '4']);
    assert.equal(result.expiredMatchCount, 1);
  });

  it('filters by a part of the description, trimmed and in any case', () => {
    const result = filterGroupLinks(links, { description: ' OPEN house ', includeExpired: false }, NOW);
    assert.deepEqual(ids(result), ['1', '4']);
    assert.equal(result.expiredMatchCount, 0);
    assert.deepEqual(ids(filterGroupLinks([at(5, {})], { description: 'x', includeExpired: true }, NOW)), []);
  });

  it('filters by a part of the origin in any case, and counts only the expired matches', () => {
    assert.deepEqual(ids(filterGroupLinks(links, { originContains: 'MCP', includeExpired: false }, NOW)), ['3', '1']);
    const zapier = filterGroupLinks(links, { originContains: 'zap', includeExpired: false }, NOW);
    assert.deepEqual([ids(zapier), zapier.expiredMatchCount], [[], 1]);
  });

  it('does not change the list that it reads', () => {
    const copy = [...links];
    filterGroupLinks(links, { includeExpired: true }, NOW);
    assert.deepEqual(links, copy);
  });
});

describe('listGroupLinks', () => {
  const roomLinks = `/v2/rooms/${ROOM_ID}/group-links`;

  function pageRequest(path: string, pageToken: string | undefined, body: unknown): ExpectedRequest {
    return {
      method: 'GET',
      path,
      query: { limit: '500', ...(pageToken === undefined ? {} : { pageToken }) },
      respond: { status: 200, body },
    };
  }

  it('reads every page of a room with 500 links per page, the room ID in lowercase', async () => {
    const second = link({ id: 'aa000000-0000-5000-8000-150000000002' });
    const { api, fake } = testApi([
      loginRequest(),
      pageRequest(roomLinks, undefined, { data: [link()], nextPageToken: 'p2' }),
      pageRequest(roomLinks, 'p2', { data: [second] }),
    ]);
    const links = await listGroupLinks(api, ROOM_ID.toUpperCase());
    assert.deepEqual(links.map((item) => item.id), [LINK_ID, second.id]);
    fake.assertDone();
  });

  it('reads the company-wide list without a room', async () => {
    const { api, fake } = testApi([loginRequest(), pageRequest('/v2/group-links', undefined, { data: [link()] })]);
    assert.equal((await listGroupLinks(api, undefined)).length, 1);
    fake.assertDone();
  });

  for (const status of [403, 404]) {
    it(`explains the user permissions when the company-wide list answers ${status}`, async () => {
      const { api, fake } = testApi([
        loginRequest(),
        { method: 'GET', path: '/v2/group-links', query: { limit: '500' }, respond: { status } },
      ]);
      const error = await toolErrorOf(listGroupLinks(api, undefined));
      assert.deepEqual([error.code, error.message, error.status], ['Forbidden', ALL_ROOMS_DENIED_MESSAGE, status]);
      fake.assertDone();
    });
  }

  it('shows a 404 of a room as the room that alfaview cannot find', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'GET', path: roomLinks, query: { limit: '500' }, respond: { status: 404 } },
    ]);
    const error = await toolErrorOf(listGroupLinks(api, ROOM_ID));
    assert.deepEqual([error.code, error.message], [
      'NotFound',
      "alfaview could not find the room. It was deleted, or the API key's user cannot see it.",
    ]);
    fake.assertDone();
  });

  it('asks for roomId after more than 50 pages of every room, and adds nothing for one room', async () => {
    const pages = (path: string) =>
      Array.from({ length: 51 }, (_, index) =>
        pageRequest(path, index === 0 ? undefined : `p${index}`, {
          data: [{ id: `l${index}` }],
          nextPageToken: `p${index + 1}`,
        }),
      );
    const { api, fake } = testApi([loginRequest(), ...pages('/v2/group-links'), ...pages(roomLinks)]);
    const all = await toolErrorOf(listGroupLinks(api, undefined));
    const room = await toolErrorOf(listGroupLinks(api, ROOM_ID));
    assert.deepEqual([all.code, all.message], [
      'TooManyResults',
      'alfaview returned more than 50 pages of group links. Give roomId to read one room.',
    ]);
    assert.equal(room.message, 'alfaview returned more than 50 pages of group links.');
    fake.assertDone();
  });
});

describe('getGroupLink', () => {
  const path = `/v2/group-links/${LINK_ID}`;

  it('reads the link', async () => {
    const { api, fake } = testApi([loginRequest(), { method: 'GET', path, respond: { status: 200, body: link() } }]);
    assert.equal((await getGroupLink(api, LINK_ID)).id, LINK_ID);
    fake.assertDone();
  });

  it('throws NotFound for 404 and InvalidResponse for a body without a text ID', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'GET', path, respond: { status: 404 } },
      { method: 'GET', path, respond: { status: 200, body: { roomId: ROOM_ID } } },
      { method: 'GET', path, respond: { status: 200, body: { id: 7 } } },
      { method: 'GET', path, respond: { status: 200 } },
    ]);
    const notFound = await toolErrorOf(getGroupLink(api, LINK_ID));
    assert.deepEqual([notFound.code, notFound.message], [
      'NotFound',
      "alfaview could not find the group link. It was deleted, or the API key's user cannot see it.",
    ]);
    for (let index = 0; index < 3; index += 1) {
      const invalid = await toolErrorOf(getGroupLink(api, LINK_ID));
      assert.deepEqual([invalid.code, invalid.message], ['InvalidResponse', 'alfaview did not return the group link.']);
    }
    fake.assertDone();
  });

  it('with allowNotFound gives undefined for 404 and still throws other errors', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      { method: 'GET', path, respond: { status: 404 } },
      { method: 'GET', path, respond: { status: 500 } },
    ]);
    assert.equal(await getGroupLink(api, LINK_ID, { allowNotFound: true }), undefined);
    assert.equal((await toolErrorOf(getGroupLink(api, LINK_ID, { allowNotFound: true }))).code, 'ServerError');
    fake.assertDone();
  });
});

describe('roomOfGroupLink', () => {
  it('returns the room or fails when alfaview returned none', () => {
    assert.equal(roomOfGroupLink(link()), ROOM_ID);
    for (const roomId of [undefined, '', 7]) {
      const error = errorOf(() => roomOfGroupLink({ id: LINK_ID, roomId } as ApiGroupLink));
      assert.deepEqual([error.code, error.message], ['InvalidResponse', MISSING_GROUP_LINK_ROOM_MESSAGE]);
    }
  });
});

describe('the messages of the group links', () => {
  it('are the exact texts that the group link tools send', () => {
    assert.equal(
      GROUP_LINK_ALONE_MESSAGE,
      'groupLinkId reads one link: leave out roomId, description and originContains.',
    );
    assert.equal(
      GROUP_LINK_MEETING_ROOM_MESSAGE,
      'This is the room of a meeting. Its group links belong to the meeting: get_meeting gives their join URLs, and alfaview never makes a deleted one again. So the group link tools do not create, change or delete links in a meeting room. Use update_meeting or cancel_meeting for the meeting.',
    );
    assert.equal(
      GROUP_LINK_PAST_VALID_UNTIL_MESSAGE,
      'validUntil is in the past, so nobody could join with this link. Check the event time.',
    );
    assert.equal(
      GROUP_LINK_UNCERTAIN_MESSAGE,
      'alfaview may have saved this group link before the error. Check with find_group_links before you create it again: a second create makes a second group link with another join URL.',
    );
    assert.equal(
      GROUP_LINK_ID_MISSING_MESSAGE,
      'alfaview did not return the ID of the new group link, but may have created it. Check with find_group_links before you create it again.',
    );
    assert.equal(MISSING_GROUP_LINK_ROOM_MESSAGE, 'alfaview did not return the room of the group link.');
    assert.equal(
      GROUP_LINK_DELETE_NOT_FOUND_MESSAGE,
      "alfaview could not find the group link, so nothing was deleted. The link is already deleted, or the API key's user cannot see it: in a meeting room, only the meeting's creator can see its group links.",
    );
    assert.equal(
      ADMIN_GROUP_MESSAGE,
      'This permission group has admin rights, so everyone with the join URL could change and delete the room. Choose a group without admin.',
    );
    assert.equal(
      groupLinkCreatedButNotReadMessage(LINK_ID),
      `alfaview created the group link ${LINK_ID}, but reading it back failed. Do not create it again: that makes a second group link. Use find_group_links with groupLinkId ${LINK_ID} to get its join URL.`,
    );
    assert.equal(
      groupLinkUpdatedButNotReadMessage(LINK_ID),
      `alfaview saved the change to group link ${LINK_ID}, but reading it back failed. Use find_group_links with groupLinkId ${LINK_ID} to read the link.`,
    );
  });
});
