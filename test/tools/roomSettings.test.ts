// get_room_settings and update_room_settings through an MCP SDK client.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LANGUAGE_LIST_MESSAGE,
  NO_SPOKEN_LANGUAGE_MESSAGE,
  roomNotFoundMessage,
  settingsSavedButNotReadMessage,
} from '../../src/domain/roomSettings.ts';
import { FEATURE_KEYS } from '../../src/shared/rooms.ts';
import {
  FILE_SHARING_OFF_FOR_COMPANY_WARNING,
  NOTHING_TO_CHANGE_MESSAGE,
  ROOM_SETTINGS_TOOLS,
  TRANSCRIPTION_FORBIDDEN_HINT,
} from '../../src/tools/roomSettings.ts';
import { IDEMPOTENT_CHANGE_ANNOTATIONS, READ_ANNOTATIONS } from '../../src/tools/tool.ts';
import { loginRequest, type ExpectedRequest, type FakeAnswer } from '../helpers/fakeFetch.ts';
import { fixture } from '../helpers/fixtures.ts';
import { toolHarness } from '../helpers/mcpClient.ts';

const ROOM_ID = '0b7c5d2e-91a4-5f3b-8e27-0f4a6c9d1e22';
const ROOM_PATH = `/v2/rooms/${ROOM_ID}`;
const ROOM_NOT_FOUND =
  "alfaview could not find the room. It was deleted, or the API key's user cannot see it.";
const FORBIDDEN =
  "The API key's user is not allowed to do this (missing room join permissions). Give that user the needed room or user permission.";
const SERVER_ERROR = 'alfaview had a temporary problem (HTTP 503). Try again later.';

type Json = Record<string, unknown>;

const ok = (body: unknown): FakeAnswer => ({ status: 200, body });
const NO_CONTENT: FakeAnswer = { status: 204 };
const problem = (status: number, file: string): FakeAnswer => ({
  status,
  body: fixture(`core/${file}`),
});

function get(path: string, respond: FakeAnswer): ExpectedRequest {
  return { method: 'GET', path, respond };
}

function patch(path: string, body: unknown, respond: FakeAnswer = NO_CONTENT): ExpectedRequest {
  return { method: 'PATCH', path, body, respond };
}

const roomRead = (respond = ok(fixture('rooms/room.json'))) => get(ROOM_PATH, respond);
const languageRead = (respond = ok(fixture('rooms/language-settings.json'))) =>
  get(`${ROOM_PATH}/language-settings`, respond);
const languagesRead = (respond = ok(fixture('rooms/languages.json'))) => get('/v2/languages', respond);
const fileSettingsRead = (respond = ok(fixture('rooms/file-share-settings.json'))) =>
  get(`${ROOM_PATH}/file-share-settings`, respond);
const fileLimitsRead = (respond = ok(fixture('rooms/file-share-limits.json'))) =>
  get(`${ROOM_PATH}/file-share-limits`, respond);
const languagePatch = (body: Json, respond?: FakeAnswer) =>
  patch(`${ROOM_PATH}/language-settings`, body, respond);
const fileSharingPatch = (body: Json, respond?: FakeAnswer) =>
  patch(`${ROOM_PATH}/file-share-settings`, body, respond);
const featuresPatch = (body: Json, respond?: FakeAnswer) =>
  patch(`${ROOM_PATH}/features`, body, respond);

const room = (overrides: Json = {}): Json => ({ ...fixture<Json>('rooms/room.json'), ...overrides });

/** The read back of update_room_settings: the requests of get_room_settings. */
function readBack(answers: { room?: FakeAnswer; language?: FakeAnswer; fileSettings?: FakeAnswer } = {}) {
  return [
    roomRead(answers.room),
    languageRead(answers.language),
    fileSettingsRead(answers.fileSettings),
    fileLimitsRead(),
  ];
}

const FEATURES_OUTPUT = { raiseHands: 'enabled', blockWebclient: 'disabled' };

const LANGUAGE_OUTPUT = {
  transcriptionEnabled: true,
  transcriptionType: 'simple_transcription',
  defaultSpokenLanguage: 'de-DE',
  targetTranscriptionLanguages: ['en-US', 'fr-FR'],
};

const FILE_SHARING_OUTPUT = {
  enabled: true,
  defaultAccessLevel: 'visible',
  participantsCanUpload: false,
  maxFiles: 100,
  remainingFiles: 92,
  maxTotalMegabytes: 1024,
  remainingTotalMegabytes: 968,
};

/** The state of the settings of the fixtures, as the summaries say it. */
const FIXTURE_STATE = '2 features differ from the default, transcription on, file sharing on.';

/** The 14 features with `default`, and the states of `states`. */
function features(states: Json = {}): Json {
  return { ...Object.fromEntries(FEATURE_KEYS.map((key) => [key, 'default'])), ...states };
}

describe('the room settings tools', () => {
  it('are listed in their fixed order, at the level manage, with their annotations', async () => {
    const harness = await toolHarness(ROOM_SETTINGS_TOOLS, []);
    const { tools } = await harness.client.listTools();
    await harness.done();

    assert.deepEqual(
      tools.map((tool) => [tool.name, tool.title, tool.annotations]),
      [
        ['get_room_settings', 'Get room settings', READ_ANNOTATIONS],
        ['update_room_settings', 'Update room settings', IDEMPOTENT_CHANGE_ANNOTATIONS],
      ],
    );
    assert.deepEqual(
      ROOM_SETTINGS_TOOLS.map((tool) => tool.level),
      ['manage', 'manage'],
    );
  });

  it('refuse a room name and a broken UUID without a request', async () => {
    const harness = await toolHarness(ROOM_SETTINGS_TOOLS, []);
    const results = [
      await harness.call('get_room_settings', { roomId: 'Advisory Room' }),
      await harness.call('update_room_settings', { roomId: 'Advisory Room', resetFeatures: true }),
      await harness.call('update_room_settings', { roomId: '..', language: { transcriptionEnabled: true } }),
      await harness.call('update_room_settings', { roomId: '0b7c5d2e-91a4', fileSharing: { enabled: true } }),
    ];
    await harness.done();

    for (const result of results) {
      assert.equal(result.isError, true);
      assert.match(result.summary, /roomId takes an ID from find_rooms, or a meeting ID, not a name\./);
    }
  });
});

describe('get_room_settings', () => {
  it('reads the room, the language settings, the file settings and the limits, in this order', async () => {
    const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [loginRequest(), ...readBack()]);
    const result = await harness.call('get_room_settings', { roomId: ROOM_ID.toUpperCase() });
    await harness.done();

    assert.equal(result.summary, `Room ${ROOM_ID}: ${FIXTURE_STATE}`);
    assert.deepEqual(result.data, {
      roomId: ROOM_ID,
      features: FEATURES_OUTPUT,
      language: LANGUAGE_OUTPUT,
      fileSharing: FILE_SHARING_OUTPUT,
      warnings: [],
    });
  });

  it('says that one or no feature differs, and gives the ID of the room that alfaview returns', async () => {
    const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [
      loginRequest(),
      roomRead(ok(room({ features: features({ examScreenshare: 'enabled' }) }))),
      languageRead(),
      fileSettingsRead(ok({ enabled: false })),
      fileLimitsRead(),
      roomRead(ok(room({ id: ROOM_ID.toUpperCase(), features: null }))),
      languageRead(),
      fileSettingsRead(ok({})),
      fileLimitsRead(),
    ]);
    const one = await harness.call('get_room_settings', { roomId: ROOM_ID });
    const none = await harness.call('get_room_settings', { roomId: ROOM_ID });
    await harness.done();

    assert.equal(
      one.summary,
      `Room ${ROOM_ID}: 1 feature differs from the default, transcription on, file sharing off.`,
    );
    assert.deepEqual(one.data.features, { examScreenshare: 'enabled' });
    assert.equal(
      none.summary,
      `Room ${ROOM_ID.toUpperCase()}: no features differ from the default, transcription on, file sharing unknown.`,
    );
    assert.equal(none.data.roomId, ROOM_ID.toUpperCase());
    assert.deepEqual(none.data.features, {});
  });

  it('gives null for the spoken language and the transcription type of a room without them, and for an empty body', async () => {
    const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [
      loginRequest(),
      ...readBack({ language: ok(fixture('rooms/language-settings-fresh.json')) }),
      ...readBack({ language: NO_CONTENT }),
    ]);
    const fresh = await harness.call('get_room_settings', { roomId: ROOM_ID });
    const empty = await harness.call('get_room_settings', { roomId: ROOM_ID });
    await harness.done();

    assert.deepEqual(fresh.data.language, {
      transcriptionEnabled: false,
      transcriptionType: null,
      defaultSpokenLanguage: null,
      targetTranscriptionLanguages: [],
    });
    assert.match(fresh.summary, /, transcription off, /);
    assert.deepEqual(empty.data.language, {
      transcriptionEnabled: null,
      transcriptionType: null,
      defaultSpokenLanguage: null,
      targetTranscriptionLanguages: [],
    });
    assert.match(empty.summary, /, transcription unknown, /);
  });

  it('gives the text of a room that alfaview cannot find, without another request', async () => {
    const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [
      loginRequest(),
      roomRead(problem(404, 'problem-404.json')),
    ]);
    const result = await harness.call('get_room_settings', { roomId: ROOM_ID });
    await harness.done();

    assert.equal(result.isError, true);
    assert.equal(result.summary, ROOM_NOT_FOUND);
    assert.match(harness.logLines.at(-1)!, /: NotFound, 2 requests/);
  });

  it('gives the text of a missing permission for the file settings and for the limits', async () => {
    const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [
      loginRequest(),
      roomRead(),
      languageRead(),
      fileSettingsRead(problem(403, 'problem-403.json')),
      roomRead(),
      languageRead(),
      fileSettingsRead(),
      fileLimitsRead(problem(403, 'problem-403.json')),
    ]);
    const settings = await harness.call('get_room_settings', { roomId: ROOM_ID });
    const limits = await harness.call('get_room_settings', { roomId: ROOM_ID });
    await harness.done();

    for (const result of [settings, limits]) {
      assert.equal(result.isError, true);
      assert.equal(result.summary, FORBIDDEN);
    }
  });
});

describe('update_room_settings', () => {
  type Harness = Awaited<ReturnType<typeof toolHarness>>;
  const call = (harness: Harness, args: Json) =>
    harness.call('update_room_settings', { roomId: ROOM_ID, ...args });
  /** The log line of each call, in the order of the calls. */
  const callLines = (harness: Harness) =>
    harness.logLines.filter((line) => line.includes('tool update_room_settings: '));

  describe('the call', () => {
    it('reads the room, changes only the given part, and gives every setting after the change', async () => {
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [
        loginRequest(),
        roomRead(),
        featuresPatch({ examScreenshare: 'enabled' }),
        ...readBack({ room: ok(room({ id: ROOM_ID.toUpperCase(), features: features({ examScreenshare: 'enabled' }) })) }),
        roomRead(),
        fileSharingPatch({ participantsCanUpload: true }),
        ...readBack({ fileSettings: ok({ ...fixture<Json>('rooms/file-share-settings.json'), participantsCanUpload: true }) }),
        roomRead(),
        languagePatch({ transcriptionEnabled: false }),
        ...readBack({ language: ok({ ...LANGUAGE_OUTPUT, transcriptionEnabled: false }) }),
      ]);
      const feature = await harness.call('update_room_settings', {
        roomId: ROOM_ID.toUpperCase(),
        features: { examScreenshare: 'enabled' },
      });
      const upload = await call(harness, { fileSharing: { participantsCanUpload: true } });
      const transcription = await call(harness, { language: { transcriptionEnabled: false } });
      await harness.done();

      assert.equal(
        feature.summary,
        `Updated the features of room ${ROOM_ID}: 1 feature differs from the default, transcription on, file sharing on.`,
      );
      assert.deepEqual(feature.data, {
        roomId: ROOM_ID,
        features: { examScreenshare: 'enabled' },
        language: LANGUAGE_OUTPUT,
        fileSharing: FILE_SHARING_OUTPUT,
        changed: ['features'],
        warnings: [],
      });
      assert.equal(upload.summary, `Updated file sharing of room ${ROOM_ID}: ${FIXTURE_STATE}`);
      assert.deepEqual(upload.data.fileSharing, { ...FILE_SHARING_OUTPUT, participantsCanUpload: true });
      assert.deepEqual(upload.data.changed, ['fileSharing']);
      assert.equal(
        transcription.summary,
        `Updated the language settings of room ${ROOM_ID}: 2 features differ from the default, transcription off, file sharing on.`,
      );
      assert.deepEqual(transcription.data.changed, ['language']);
      assert.deepEqual(
        callLines(harness).map((line) => /: ok, (\d+) requests/.exec(line)?.[1]),
        ['7', '6', '6'],
      );
    });

    it('writes the language settings, the file sharing and the features in this order, and reads back once', async () => {
      const all = {
        language: { defaultSpokenLanguage: 'en-US' },
        fileSharing: { enabled: true },
        features: { raiseHands: 'disabled' },
      };
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [
        loginRequest(),
        roomRead(),
        languageRead(ok({ ...LANGUAGE_OUTPUT, targetTranscriptionLanguages: ['de-DE'] })),
        languagesRead(),
        languagePatch({ defaultSpokenLanguage: 'en-US' }),
        fileSharingPatch({ enabled: true }),
        featuresPatch({ raiseHands: 'disabled' }),
        ...readBack(),
      ]);
      const result = await call(harness, { features: all.features, fileSharing: all.fileSharing, language: all.language });
      await harness.done();

      assert.equal(
        result.summary,
        `Updated the language settings, file sharing and the features of room ${ROOM_ID}: ${FIXTURE_STATE}`,
      );
      assert.deepEqual(result.data.changed, ['language', 'fileSharing', 'features']);
      // 10 requests after the login, the most that a call sends.
      assert.match(callLines(harness)[0]!, /: ok, 11 requests/);
    });

    it('refuses a call without anything to change, without a request', async () => {
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, []);
      const results = [
        await call(harness, {}),
        await call(harness, { features: {} }),
        await call(harness, { features: {}, resetFeatures: false }),
        await call(harness, { language: {} }),
        await call(harness, { fileSharing: {} }),
        await call(harness, { features: {}, language: {}, fileSharing: {} }),
      ];
      await harness.done();

      for (const result of results) {
        assert.equal(result.isError, true);
        assert.equal(result.summary, NOTHING_TO_CHANGE_MESSAGE);
      }
      assert.equal(
        NOTHING_TO_CHANGE_MESSAGE,
        'Give at least one setting to change in features, language or fileSharing, or set resetFeatures true.',
      );
      assert.match(callLines(harness)[0]!, /: InvalidInput, 0 requests/);
    });

    // A model can send the nil UUID as roomId before it has an ID from find_rooms.
    it('refuses the nil UUID as roomId with the tool that gives the ID, without a request', async () => {
      const nil = '00000000-0000-0000-0000-000000000000';
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, []);
      const update = await harness.client.callTool({
        name: 'update_room_settings',
        arguments: { roomId: nil, fileSharing: { enabled: true } },
      });
      await harness.done();

      assert.equal(update.isError, true);
      assert.equal(
        (update.content as { text: string }[])[0]!.text,
        `Input validation error: Invalid arguments for tool update_room_settings: roomId: roomId ${nil} is no ID. Call find_rooms first and use an ID from its result.`,
      );
      assert.deepEqual(harness.logLines, []);
    });

    it('refuses unknown keys, values and the parameters of the tools that it replaces, without a request', async () => {
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, []);
      const results = [
        await call(harness, { features: { recording: 'enabled' } }),
        await call(harness, { features: { raiseHands: 'on' } }),
        await call(harness, { resetAll: true }),
        await call(harness, { transcriptionEnabled: true }),
        await call(harness, { enabled: true }),
        await call(harness, { language: { transcriptionEnabled: true, spokenLanguage: 'de-DE' } }),
        await call(harness, { fileSharing: { enabled: true, uploads: true } }),
        await call(harness, { fileSharing: { defaultAccessLevel: 'Visible' } }),
      ];
      await harness.done();

      for (const result of results) {
        assert.equal(result.isError, true);
        assert.match(result.summary, /Input validation error/);
      }
    });

    it('changes nothing for a room that alfaview cannot find, and says why for another error of the room read', async () => {
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [
        loginRequest(),
        roomRead(problem(404, 'problem-404.json')),
        roomRead(problem(403, 'problem-403.json')),
      ]);
      const missing = await harness.call('update_room_settings', {
        roomId: ROOM_ID.toUpperCase(),
        fileSharing: { enabled: true },
      });
      const forbidden = await call(harness, { features: { raiseHands: 'enabled' } });
      await harness.done();

      assert.equal(missing.summary, roomNotFoundMessage(ROOM_ID));
      assert.equal(missing.summary, `alfaview could not find the room ${ROOM_ID}, so nothing changed.`);
      assert.match(callLines(harness)[0]!, /: NotFound, 2 requests/);
      assert.equal(forbidden.summary, `${FORBIDDEN} Nothing changed.`);
      assert.match(callLines(harness)[1]!, /: Forbidden, 1 request,/);
    });

    it('says that each change is saved when reading the settings back fails', async () => {
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [
        loginRequest(),
        roomRead(),
        fileSharingPatch({ enabled: true }),
        roomRead(problem(503, 'problem-500.json')),
        roomRead(),
        featuresPatch(features()),
        roomRead(),
        languageRead(),
        fileSettingsRead(),
        fileLimitsRead(problem(403, 'problem-403.json')),
      ]);
      const roomFailed = await harness.call('update_room_settings', {
        roomId: ROOM_ID.toUpperCase(),
        fileSharing: { enabled: true },
      });
      const limitsFailed = await call(harness, { resetFeatures: true });
      await harness.done();

      for (const result of [roomFailed, limitsFailed]) {
        assert.equal(result.isError, true);
        assert.equal(result.summary, settingsSavedButNotReadMessage(ROOM_ID));
      }
      assert.equal(
        roomFailed.summary,
        `alfaview saved every change to room ${ROOM_ID}, but reading the settings back failed. Use get_room_settings to read them.`,
      );
      assert.match(callLines(harness)[0]!, /: ServerError, 4 requests/);
      assert.match(callLines(harness)[1]!, /: Forbidden, 6 requests/);
    });

    it('warns when file sharing stays off for the whole company', async () => {
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [
        loginRequest(),
        roomRead(),
        fileSharingPatch({ enabled: true }),
        ...readBack({ fileSettings: ok({ enabled: false, defaultAccessLevel: 'visible', participantsCanUpload: false }) }),
        roomRead(),
        fileSharingPatch({ enabled: false }),
        ...readBack({ fileSettings: ok({ enabled: false }) }),
        roomRead(),
        fileSharingPatch({ enabled: true }),
        ...readBack(),
      ]);
      const off = await call(harness, { fileSharing: { enabled: true } });
      const turnedOff = await call(harness, { fileSharing: { enabled: false } });
      const on = await call(harness, { fileSharing: { enabled: true } });
      await harness.done();

      assert.equal(off.isError, false);
      assert.deepEqual(off.data.warnings, [FILE_SHARING_OFF_FOR_COMPANY_WARNING]);
      assert.equal(
        off.summary,
        `Updated file sharing of room ${ROOM_ID}: 2 features differ from the default, transcription on, file sharing off. ${FILE_SHARING_OFF_FOR_COMPANY_WARNING}`,
      );
      assert.equal(
        FILE_SHARING_OFF_FOR_COMPANY_WARNING,
        'File sharing is off for the whole company, so it stays off in this room.',
      );
      assert.deepEqual(turnedOff.data.warnings, []);
      assert.deepEqual(on.data.warnings, []);
    });

    it('does not warn about file sharing that is off when the call does not turn it on', async () => {
      const off = ok({ enabled: false, defaultAccessLevel: 'visible', participantsCanUpload: false });
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [
        loginRequest(),
        roomRead(),
        featuresPatch({ raiseHands: 'enabled' }),
        ...readBack({ fileSettings: off }),
        roomRead(),
        languagePatch({ transcriptionEnabled: false }),
        ...readBack({ fileSettings: off }),
        roomRead(),
        fileSharingPatch({ participantsCanUpload: true }),
        ...readBack({ fileSettings: off }),
      ]);
      const results = [
        await call(harness, { features: { raiseHands: 'enabled' } }),
        await call(harness, { language: { transcriptionEnabled: false } }),
        await call(harness, { fileSharing: { participantsCanUpload: true } }),
      ];
      await harness.done();

      for (const result of results) {
        assert.equal(result.isError, false);
        assert.deepEqual(result.data.warnings, []);
        assert.match(result.summary, /, file sharing off\.$/);
      }
    });

    // The features of GetRoom are the read back of a features change.
    it('says that the change is saved when the read back after a features change has no features', async () => {
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [
        loginRequest(),
        roomRead(),
        featuresPatch({ raiseHands: 'enabled' }),
        roomRead(ok(room({ features: null }))),
        roomRead(),
        featuresPatch(features()),
        roomRead(ok(room({ features: ['raiseHands'] }))),
        roomRead(),
        fileSharingPatch({ enabled: true }),
        ...readBack({ room: ok(room({ features: null })) }),
      ]);
      const missing = await call(harness, { features: { raiseHands: 'enabled' } });
      const list = await call(harness, { resetFeatures: true });
      const fileSharingOnly = await call(harness, { fileSharing: { enabled: true } });
      await harness.done();

      for (const result of [missing, list]) {
        assert.equal(result.isError, true);
        assert.equal(result.summary, settingsSavedButNotReadMessage(ROOM_ID));
      }
      assert.match(callLines(harness)[0]!, /: InvalidResponse, 4 requests/);
      assert.match(callLines(harness)[1]!, /: InvalidResponse, 3 requests/);
      // Without a features change, a room without features has no feature that differs, as
      // get_room_settings says.
      assert.equal(fileSharingOnly.isError, false);
      assert.deepEqual(fileSharingOnly.data.features, {});
    });
  });

  describe('a failed write', () => {
    it('changes nothing when alfaview refuses the first write', async () => {
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [
        loginRequest(),
        roomRead(),
        languagePatch({ transcriptionEnabled: true }, problem(403, 'problem-403.json')),
        roomRead(),
        languagePatch(
          { targetTranscriptionLanguages: [] },
          { status: 422, body: { title: 'Unprocessable Entity', detail: 'too many languages' } },
        ),
      ]);
      const every = {
        fileSharing: { enabled: true },
        features: { raiseHands: 'enabled' },
      };
      const forbidden = await call(harness, { language: { transcriptionEnabled: true }, ...every });
      const quota = await call(harness, { language: { targetTranscriptionLanguages: [] }, ...every });
      await harness.done();

      // The 403 of the language settings names the permission, which no text of the tool names.
      assert.equal(forbidden.isError, true);
      assert.equal(
        forbidden.summary,
        `${FORBIDDEN} Changing transcriptionEnabled needs the user permission Room Admin. Nothing changed.`,
      );
      assert.equal(
        TRANSCRIPTION_FORBIDDEN_HINT,
        'Changing transcriptionEnabled needs the user permission Room Admin.',
      );
      assert.match(callLines(harness)[0]!, /: Forbidden, 3 requests/);
      assert.equal(quota.summary, 'alfaview could not process the input: too many languages. Nothing changed.');
      assert.match(callLines(harness)[1]!, /: ValidationFailed, 2 requests/);
    });

    // Only transcriptionEnabled needs the user permission Room Admin.
    it('names Room Admin only after a 403 of a language change that gives transcriptionEnabled', async () => {
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [
        loginRequest(),
        roomRead(),
        languagePatch({ targetTranscriptionLanguages: [] }, problem(403, 'problem-403.json')),
        roomRead(),
        languagePatch(
          { transcriptionEnabled: true },
          { status: 422, body: { title: 'Unprocessable Entity', detail: 'QUOTA_EXCEEDED' } },
        ),
        roomRead(),
        fileSharingPatch({ enabled: true }, problem(403, 'problem-403.json')),
        roomRead(),
        featuresPatch({ raiseHands: 'enabled' }, problem(403, 'problem-403.json')),
      ]);
      const targets = await call(harness, { language: { targetTranscriptionLanguages: [] } });
      const quota = await call(harness, { language: { transcriptionEnabled: true } });
      const fileSharing = await call(harness, { fileSharing: { enabled: true } });
      const featuresOnly = await call(harness, { features: { raiseHands: 'enabled' } });
      await harness.done();

      assert.equal(targets.summary, `${FORBIDDEN} Nothing changed.`);
      assert.equal(quota.summary, 'alfaview could not process the input: QUOTA_EXCEEDED. Nothing changed.');
      assert.equal(fileSharing.summary, `${FORBIDDEN} Nothing changed.`);
      assert.equal(featuresOnly.summary, `${FORBIDDEN} Nothing changed.`);
    });

    it('says that alfaview may have saved the first write after an error without a refusal', async () => {
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [
        loginRequest(),
        roomRead(),
        fileSharingPatch({ enabled: true }, problem(503, 'problem-500.json')),
        roomRead(),
        featuresPatch({ raiseHands: 'enabled' }, problem(500, 'problem-500.json')),
      ]);
      const result = await call(harness, { fileSharing: { enabled: true }, features: { raiseHands: 'enabled' } });
      const status500 = await call(harness, { features: { raiseHands: 'enabled' } });
      await harness.done();

      assert.equal(
        result.summary,
        `${SERVER_ERROR} alfaview may have saved file sharing before the error, and nothing else changed. The same call again is safe.`,
      );
      assert.match(callLines(harness)[0]!, /: ServerError, 3 requests/);
      assert.equal(
        status500.summary,
        'alfaview had a temporary problem (HTTP 500). Try again later. alfaview may have saved the features before the error, and nothing else changed. The same call again is safe.',
      );
    });

    it('names the saved parts, the failed part, the parts not sent and the parameters to call again with', async () => {
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [
        loginRequest(),
        roomRead(),
        languagePatch({ transcriptionEnabled: true }),
        fileSharingPatch({ enabled: true }, problem(403, 'problem-403.json')),
        roomRead(),
        languagePatch({ transcriptionEnabled: true }),
        fileSharingPatch({ enabled: true }),
        featuresPatch(features(), problem(503, 'problem-500.json')),
        roomRead(),
        fileSharingPatch({ enabled: true }),
        featuresPatch({ raiseHands: 'enabled' }, problem(404, 'problem-404.json')),
      ]);
      const second = await call(harness, {
        language: { transcriptionEnabled: true },
        fileSharing: { enabled: true },
        features: { raiseHands: 'enabled' },
        resetFeatures: true,
      });
      const third = await call(harness, {
        language: { transcriptionEnabled: true },
        fileSharing: { enabled: true },
        resetFeatures: true,
      });
      const featuresOnly = await call(harness, { fileSharing: { enabled: true }, features: { raiseHands: 'enabled' } });
      await harness.done();

      // features with resetFeatures: raiseHands and 13 features default, in the order of the
      // features.
      assert.equal(
        second.summary,
        `alfaview saved the language settings of room ${ROOM_ID}, but the change of file sharing failed: ${FORBIDDEN} The features did not change. What is saved stays saved. Fix the cause and call update_room_settings again with only fileSharing, features and resetFeatures. The same call again is also safe.`,
      );
      // A 503 can come after alfaview saved the features.
      assert.equal(
        third.summary,
        `alfaview saved the language settings and file sharing of room ${ROOM_ID}, and may have saved the features before this error: ${SERVER_ERROR} What is saved stays saved. Fix the cause and call update_room_settings again with only resetFeatures. The same call again is also safe.`,
      );
      assert.equal(
        featuresOnly.summary,
        `alfaview saved file sharing of room ${ROOM_ID}, but the change of the features failed: ${ROOM_NOT_FOUND} What is saved stays saved. Fix the cause and call update_room_settings again with only features. The same call again is also safe.`,
      );
      assert.deepEqual(
        callLines(harness).map((line) => /: (\w+), (\d+) requests/.exec(line)?.slice(1)),
        [
          ['PartlySaved', '4'],
          ['PartlySaved', '4'],
          ['PartlySaved', '3'],
        ],
      );
    });

    it('says that alfaview may have saved the first write after a lost answer', async () => {
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [loginRequest(), roomRead()], {
        wrapFetch: (fetch) => async (input, init) => {
          if (init?.method === 'PATCH') throw new TypeError('fetch failed');
          return fetch(input, init);
        },
      });
      const result = await call(harness, { features: { raiseHands: 'enabled' } });
      await harness.done();

      assert.equal(
        result.summary,
        `alfaview could not be reached (PATCH ${ROOM_PATH}/features). Check the network connection, then try again. alfaview may have saved the features before the error, and nothing else changed. The same call again is safe.`,
      );
      assert.match(callLines(harness)[0]!, /: NetworkError, 3 requests/);
    });

    it('says that alfaview may have saved a later write after a lost answer', async () => {
      const harness = await toolHarness(
        ROOM_SETTINGS_TOOLS,
        [loginRequest(), roomRead(), fileSharingPatch({ enabled: true })],
        {
          wrapFetch: (fetch) => async (input, init) => {
            if (init?.method === 'PATCH' && String(input).endsWith('/features')) throw new TypeError('fetch failed');
            return fetch(input, init);
          },
        },
      );
      const result = await call(harness, { fileSharing: { enabled: true }, features: { raiseHands: 'enabled' } });
      await harness.done();

      assert.equal(
        result.summary,
        `alfaview saved file sharing of room ${ROOM_ID}, and may have saved the features before this error: alfaview could not be reached (PATCH ${ROOM_PATH}/features). Check the network connection, then try again. What is saved stays saved. Fix the cause and call update_room_settings again with only features. The same call again is also safe.`,
      );
      assert.match(callLines(harness)[0]!, /: PartlySaved, 4 requests/);
    });
  });

  describe('the features', () => {
    const change = (body: Json) => [roomRead(), featuresPatch(body), ...readBack()];

    it('sends the given features in the order of the features, whatever the order of the input', async () => {
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [
        loginRequest(),
        ...change({ examScreenshare: 'enabled' }),
        ...change({ disableCameraOff: 'disabled', raiseHands: 'default', examScreenshare: 'enabled' }),
      ]);
      await call(harness, { features: { examScreenshare: 'enabled' } });
      await call(harness, {
        features: { examScreenshare: 'enabled', raiseHands: 'default', disableCameraOff: 'disabled' },
      });
      await harness.done();

      const body = JSON.parse(harness.fake.requests[8]!.body!);
      assert.deepEqual(Object.keys(body), ['disableCameraOff', 'raiseHands', 'examScreenshare']);
    });

    it('sends default for every other feature with resetFeatures, in one request', async () => {
      const all = features();
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [
        loginRequest(),
        ...change(all),
        ...change({ ...all, sixteenByNineVideos: 'enabled', blockWebclient: 'disabled' }),
        ...change(all),
      ]);
      const reset = await call(harness, { resetFeatures: true });
      await call(harness, {
        features: { blockWebclient: 'disabled', sixteenByNineVideos: 'enabled' },
        resetFeatures: true,
      });
      const resetWithNone = await call(harness, { features: {}, resetFeatures: true });
      await harness.done();

      assert.deepEqual(reset.data.changed, ['features']);
      assert.deepEqual(Object.keys(JSON.parse(harness.fake.requests[8]!.body!)), [...FEATURE_KEYS]);
      assert.equal(resetWithNone.summary, reset.summary);
    });

    it('advertises the 14 features as the property names of features', async () => {
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, []);
      const { tools } = await harness.client.listTools();
      await harness.done();

      const schema = tools.find((tool) => tool.name === 'update_room_settings')!.inputSchema as {
        properties: Record<string, Json>;
      };
      assert.deepEqual(schema.properties.features!.propertyNames, {
        type: 'string',
        enum: [...FEATURE_KEYS],
      });
      assert.deepEqual(schema.properties.features!.additionalProperties, {
        type: 'string',
        enum: ['enabled', 'disabled', 'default'],
      });
      assert.deepEqual(Object.keys(schema.properties), [
        'roomId',
        'features',
        'resetFeatures',
        'language',
        'fileSharing',
      ]);
    });
  });

  describe('the language settings', () => {
    it('reads nothing first for transcriptionEnabled alone and for [] alone', async () => {
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [
        loginRequest(),
        roomRead(),
        languagePatch({ transcriptionEnabled: false }),
        ...readBack(),
        roomRead(),
        languagePatch({ targetTranscriptionLanguages: [] }),
        ...readBack({ language: ok({ ...LANGUAGE_OUTPUT, targetTranscriptionLanguages: null }) }),
      ]);
      await call(harness, { language: { transcriptionEnabled: false } });
      const removed = await call(harness, { language: { targetTranscriptionLanguages: [] } });
      await harness.done();

      assert.deepEqual(removed.data.language.targetTranscriptionLanguages, []);
    });

    it('reads the current spoken language for transcriptionType alone and for codes without a spoken language', async () => {
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [
        loginRequest(),
        roomRead(),
        languageRead(),
        languagePatch({ transcriptionType: 'digital_interpreter' }),
        ...readBack({ language: ok({ ...LANGUAGE_OUTPUT, transcriptionType: 'digital_interpreter' }) }),
        roomRead(),
        languageRead(),
        languagesRead(),
        languagePatch({ targetTranscriptionLanguages: ['fr-FR'] }),
        ...readBack(),
      ]);
      const type = await call(harness, { language: { transcriptionType: 'digital_interpreter' } });
      await call(harness, { language: { targetTranscriptionLanguages: ['FR-fr'] } });
      await harness.done();

      assert.equal(type.data.language.transcriptionType, 'digital_interpreter');
    });

    it('reads the current translation languages for a spoken language without them', async () => {
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [
        loginRequest(),
        roomRead(),
        languageRead(ok({ ...LANGUAGE_OUTPUT, defaultSpokenLanguage: 'en-US' })),
        languagesRead(),
        languagePatch({ defaultSpokenLanguage: 'de-DE' }),
        ...readBack(),
      ]);
      const result = await call(harness, { language: { defaultSpokenLanguage: 'de-de' } });
      await harness.done();

      assert.equal(result.data.language.defaultSpokenLanguage, 'de-DE');
    });

    it('refuses transcriptionType for a room without a spoken language, after the read and without a change', async () => {
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [
        loginRequest(),
        roomRead(),
        languageRead(ok(fixture('rooms/language-settings-fresh.json'))),
        roomRead(),
        languageRead(NO_CONTENT),
      ]);
      const fresh = await call(harness, {
        language: { transcriptionType: 'simple_transcription' },
        fileSharing: { enabled: true },
      });
      const empty = await call(harness, {
        language: { transcriptionType: 'digital_interpreter', targetTranscriptionLanguages: ['en-US'] },
      });
      await harness.done();

      for (const result of [fresh, empty]) {
        assert.equal(result.isError, true);
        assert.equal(result.summary, `${NO_SPOKEN_LANGUAGE_MESSAGE} Nothing changed.`);
      }
      assert.equal(
        NO_SPOKEN_LANGUAGE_MESSAGE,
        'Give defaultSpokenLanguage too. This room has no default spoken language yet.',
      );
      assert.match(callLines(harness)[0]!, /: InvalidInput, 3 requests/);
    });

    it('skips the pair check for codes alone on a room without a spoken language, and sends them', async () => {
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [
        loginRequest(),
        roomRead(),
        languageRead(ok(fixture('rooms/language-settings-fresh.json'))),
        languagesRead(),
        languagePatch({ targetTranscriptionLanguages: ['es-ES'] }),
        ...readBack(),
      ]);
      const result = await call(harness, { language: { targetTranscriptionLanguages: ['es-es'] } });
      await harness.done();

      assert.equal(result.isError, false);
    });

    it('names the codes that alfaview offers for each problem of the codes, without a change', async () => {
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [
        loginRequest(),
        roomRead(),
        languageRead(),
        languagesRead(),
        roomRead(),
        languageRead(),
        languagesRead(),
        roomRead(),
        languagesRead(),
        roomRead(),
        languageRead(),
        languagesRead(),
        roomRead(),
        languagesRead(),
      ]);
      const language = (args: Json) => call(harness, { language: args, features: { raiseHands: 'enabled' } });
      const spoken = await language({ defaultSpokenLanguage: 'pt-BR' });
      const kept = await language({ defaultSpokenLanguage: 'es-ES' });
      const notOffered = await language({ defaultSpokenLanguage: 'de-DE', targetTranscriptionLanguages: ['pt-BR', 'en-US', 'xx'] });
      const untranslatable = await language({ targetTranscriptionLanguages: ['ja-JP', 'en-US'] });
      const nowhere = await language({ defaultSpokenLanguage: 'it-IT', targetTranscriptionLanguages: ['de-DE'] });
      await harness.done();

      assert.deepEqual(
        [spoken, kept, notOffered, untranslatable, nowhere].map((result) => [result.isError, result.summary]),
        [
          [true, 'alfaview does not offer pt-BR as a spoken language. It offers: de-DE, en-US, es-ES, fr-FR, it-IT. Nothing changed.'],
          [
            true,
            'alfaview does not translate es-ES into these translation languages of this room: en-US, fr-FR. Give targetTranscriptionLanguages too, or [] to remove them. Nothing changed.',
          ],
          [true, 'alfaview does not translate into pt-BR, xx. It translates into: de-DE, en-US, es-ES, fr-FR, ja-JP. Nothing changed.'],
          [true, 'alfaview does not translate de-DE into ja-JP. It translates de-DE into: en-US, fr-FR. Nothing changed.'],
          [true, 'alfaview does not translate it-IT into de-DE. It translates it-IT into: none. Nothing changed.'],
        ],
      );
      assert.match(callLines(harness)[0]!, /: InvalidInput, 4 requests/);
      assert.match(callLines(harness)[1]!, /: InvalidInput, 3 requests/);
    });

    it('sends the codes as alfaview lists them, a target given twice once, and every field in one request', async () => {
      const all = {
        defaultSpokenLanguage: 'en-US',
        targetTranscriptionLanguages: ['de-DE', 'ja-JP'],
        transcriptionEnabled: true,
        transcriptionType: 'digital_interpreter',
      };
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [
        loginRequest(),
        roomRead(),
        languagesRead(),
        languagePatch({ defaultSpokenLanguage: 'de-DE', targetTranscriptionLanguages: ['en-US', 'fr-FR'] }),
        ...readBack(),
        roomRead(),
        languagesRead(),
        languagePatch(all),
        ...readBack({ language: ok(all) }),
        roomRead(),
        languagesRead(),
        languagePatch({ defaultSpokenLanguage: 'fr-FR', targetTranscriptionLanguages: [] }),
        ...readBack(),
      ]);
      const cased = await call(harness, {
        language: { defaultSpokenLanguage: 'DE-de', targetTranscriptionLanguages: ['EN-us', 'fr-fr', ' en-US '] },
      });
      const every = await call(harness, {
        language: { ...all, targetTranscriptionLanguages: ['de-de', 'ja-jp'] },
      });
      await call(harness, { language: { defaultSpokenLanguage: 'fr-FR', targetTranscriptionLanguages: [] } });
      await harness.done();

      assert.deepEqual(cased.data.language, LANGUAGE_OUTPUT);
      assert.deepEqual(every.data.language, all);
      assert.equal(
        every.summary,
        `Updated the language settings of room ${ROOM_ID}: ${FIXTURE_STATE}`,
      );
    });

    it('refuses 51 translation languages, a code of 36 characters, a blank code and an unknown type, without a request', async () => {
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, []);
      const refused = [
        await call(harness, {
          language: { targetTranscriptionLanguages: Array.from({ length: 51 }, (_, index) => `x-${index}`) },
        }),
        await call(harness, { language: { defaultSpokenLanguage: 'x'.repeat(36) } }),
        await call(harness, { language: { targetTranscriptionLanguages: ['x'.repeat(36)] } }),
        await call(harness, { language: { targetTranscriptionLanguages: ['  '] } }),
        await call(harness, { language: { transcriptionType: 'live' } }),
      ];
      await harness.done();

      for (const result of refused) {
        assert.equal(result.isError, true);
        assert.match(result.summary, /Input validation error/);
      }
    });

    it('gives the text of a room that alfaview cannot find, for the read and for the change', async () => {
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [
        loginRequest(),
        roomRead(),
        languageRead(problem(404, 'problem-404.json')),
        roomRead(),
        languagePatch({ transcriptionEnabled: true }, problem(404, 'problem-404.json')),
      ]);
      const read = await call(harness, { language: { transcriptionType: 'simple_transcription' } });
      const change = await call(harness, { language: { transcriptionEnabled: true } });
      await harness.done();

      assert.equal(read.summary, `${ROOM_NOT_FOUND} Nothing changed.`);
      assert.equal(change.summary, `${ROOM_NOT_FOUND} Nothing changed.`);
    });

    it('reports a language list that is not an object, without a change', async () => {
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [
        loginRequest(),
        roomRead(),
        languagesRead(ok(['de-DE'])),
      ]);
      const result = await call(harness, {
        language: { defaultSpokenLanguage: 'de-DE', targetTranscriptionLanguages: ['en-US'] },
      });
      await harness.done();

      assert.equal(result.summary, `${LANGUAGE_LIST_MESSAGE} Nothing changed.`);
      assert.equal(LANGUAGE_LIST_MESSAGE, 'alfaview sent an unexpected language response.');
      assert.match(callLines(harness)[0]!, /: InvalidResponse, /);
    });
  });

  describe('the file sharing', () => {
    it('sends only the given field, and all three together', async () => {
      const fields: [string, unknown][] = [
        ['enabled', false],
        ['defaultAccessLevel', 'downloadable'],
        ['participantsCanUpload', true],
      ];
      const all = { enabled: true, defaultAccessLevel: 'hidden', participantsCanUpload: false };
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [
        loginRequest(),
        ...fields.flatMap(([key, value]) => [roomRead(), fileSharingPatch({ [key]: value }), ...readBack()]),
        roomRead(),
        fileSharingPatch(all),
        ...readBack(),
      ]);
      for (const [key, value] of fields) {
        await call(harness, { fileSharing: { [key]: value } });
      }
      const every = await call(harness, { fileSharing: all });
      await harness.done();

      assert.deepEqual(every.data.changed, ['fileSharing']);
    });

    it('gives whole megabytes and null for the values that alfaview leaves out', async () => {
      const harness = await toolHarness(ROOM_SETTINGS_TOOLS, [
        loginRequest(),
        roomRead(),
        fileSharingPatch({ defaultAccessLevel: 'hidden' }),
        roomRead(),
        languageRead(),
        fileSettingsRead(ok({})),
        fileLimitsRead(ok({ maxTotalBytes: 1_572_864, remainingTotalBytes: 1_048_575 })),
      ]);
      const result = await call(harness, { fileSharing: { defaultAccessLevel: 'hidden' } });
      await harness.done();

      assert.match(result.summary, /, file sharing unknown\.$/);
      assert.deepEqual(result.data.fileSharing, {
        enabled: null,
        defaultAccessLevel: null,
        participantsCanUpload: null,
        maxFiles: null,
        remainingFiles: null,
        maxTotalMegabytes: 1,
        remainingTotalMegabytes: 0,
      });
    });
  });
});
