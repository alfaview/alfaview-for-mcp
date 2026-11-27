import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ApiRoom } from '../../src/domain/rooms.ts';
import {
  getLanguageSettings,
  LANGUAGE_LIST_MESSAGE,
  languageCodeMessage,
  listLanguages,
  mapFileSharingSettings,
  mapRoomSettings,
  readFileSharing,
  readRoomSettings,
  roomNotFoundMessage,
  settingsSavedButNotReadMessage,
  updateFileSharing,
  updateLanguageSettings,
} from '../../src/domain/roomSettings.ts';
import { checkedLanguageCodes, readLanguages, type Languages } from '../../src/shared/languages.ts';
import { loginRequest, testApi, toolErrorOf, type ExpectedRequest } from '../helpers/fakeFetch.ts';
import { fixture } from '../helpers/fixtures.ts';

const ROOM_ID = '0b7c5d2e-91a4-5f3b-8e27-0f4a6c9d1e22';
const ROOM_PATH = `/v2/rooms/${ROOM_ID}`;

const languages = (): Languages => readLanguages(fixture('rooms/languages.json'))!;

describe('languageCodeMessage', () => {
  it('names the spoken languages that alfaview offers, each once and sorted', () => {
    assert.equal(
      languageCodeMessage({ kind: 'spokenNotOffered', code: 'pt-BR' }, languages()),
      'alfaview does not offer pt-BR as a spoken language. It offers: de-DE, en-US, es-ES, fr-FR, it-IT.',
    );
  });

  it('names the kept translation languages and how to change them', () => {
    assert.equal(
      languageCodeMessage(
        { kind: 'keptTargetsUntranslatable', spoken: 'es-ES', codes: ['en-US', 'fr-FR'] },
        languages(),
      ),
      'alfaview does not translate es-ES into these translation languages of this room: en-US, fr-FR. Give targetTranscriptionLanguages too, or [] to remove them.',
    );
  });

  it('names every translation language that alfaview offers, each once in any case', () => {
    const offered = languages();
    offered.translation.push({ in: 'it-IT', out: ['EN-us', 'pl-PL'] });
    assert.equal(
      languageCodeMessage({ kind: 'targetsNotOffered', codes: ['pt-BR', 'xx'] }, offered),
      'alfaview does not translate into pt-BR, xx. It translates into: de-DE, en-US, es-ES, fr-FR, ja-JP, pl-PL.',
    );
  });

  it('names the translation languages of the spoken language, in any case', () => {
    assert.equal(
      languageCodeMessage(
        { kind: 'targetsUntranslatable', spoken: 'EN-us', codes: ['it-IT'] },
        languages(),
      ),
      'alfaview does not translate EN-us into it-IT. It translates EN-us into: de-DE, es-ES, fr-FR, ja-JP.',
    );
  });

  it('names the translation languages of the first pair of the spoken language, as the check takes it', () => {
    const twice: Languages = {
      transcription: ['de-DE'],
      translation: [
        { in: 'de-DE', out: ['en-US'] },
        { in: 'de-de', out: ['fr-FR'] },
      ],
    };
    assert.deepEqual(checkedLanguageCodes(twice, { spoken: 'de-DE', targets: ['fr-FR'] }), {
      problem: { kind: 'targetsUntranslatable', spoken: 'de-DE', codes: ['fr-FR'] },
    });
    assert.equal(
      languageCodeMessage(
        { kind: 'targetsUntranslatable', spoken: 'de-DE', codes: ['fr-FR'] },
        twice,
      ),
      'alfaview does not translate de-DE into fr-FR. It translates de-DE into: en-US.',
    );
  });

  it('says none when alfaview offers no code', () => {
    const none: Languages = { transcription: [], translation: [{ in: 'es-ES', out: [] }] };
    assert.deepEqual(
      [
        languageCodeMessage({ kind: 'spokenNotOffered', code: 'de-DE' }, none),
        languageCodeMessage({ kind: 'targetsNotOffered', codes: ['de-DE'] }, none),
        languageCodeMessage({ kind: 'targetsUntranslatable', spoken: 'es-ES', codes: ['de-DE'] }, none),
      ],
      [
        'alfaview does not offer de-DE as a spoken language. It offers: none.',
        'alfaview does not translate into de-DE. It translates into: none.',
        'alfaview does not translate es-ES into de-DE. It translates es-ES into: none.',
      ],
    );
  });
});

describe('the messages of a change', () => {
  it('name the room and say what is saved', () => {
    assert.equal(
      settingsSavedButNotReadMessage(ROOM_ID),
      `alfaview saved every change to room ${ROOM_ID}, but reading the settings back failed. Use get_room_settings to read them.`,
    );
    assert.equal(
      roomNotFoundMessage(ROOM_ID),
      `alfaview could not find the room ${ROOM_ID}, so nothing changed.`,
    );
  });
});

describe('mapFileSharingSettings', () => {
  it('gives the settings and the storage left, in whole megabytes, without the room ID and the byte counts', () => {
    const output = mapFileSharingSettings(
      fixture('rooms/file-share-settings.json'),
      { ...fixture('rooms/file-share-limits.json'), remainingTotalBytes: 1_048_575 },
    );
    assert.deepEqual(output, {
      enabled: true,
      defaultAccessLevel: 'visible',
      participantsCanUpload: false,
      maxFiles: 100,
      remainingFiles: 92,
      maxTotalMegabytes: 1024,
      remainingTotalMegabytes: 0,
    });
    assert.deepEqual(Object.keys(output), [
      'enabled',
      'defaultAccessLevel',
      'participantsCanUpload',
      'maxFiles',
      'remainingFiles',
      'maxTotalMegabytes',
      'remainingTotalMegabytes',
    ]);
  });

  it('gives null for missing answers', () => {
    assert.deepEqual(mapFileSharingSettings(undefined, undefined), {
      enabled: null,
      defaultAccessLevel: null,
      participantsCanUpload: null,
      maxFiles: null,
      remainingFiles: null,
      maxTotalMegabytes: null,
      remainingTotalMegabytes: null,
    });
  });
});

describe('mapRoomSettings', () => {
  const fileSharing = mapFileSharingSettings(undefined, undefined);

  it('gives the ID of the room, its changed features, and the language settings without a room ID', () => {
    const room = fixture<ApiRoom>('rooms/room.json');
    assert.deepEqual(mapRoomSettings(room, fixture('rooms/language-settings.json'), fileSharing), {
      roomId: ROOM_ID,
      features: { raiseHands: 'enabled', blockWebclient: 'disabled' },
      language: {
        transcriptionEnabled: true,
        transcriptionType: 'simple_transcription',
        defaultSpokenLanguage: 'de-DE',
        targetTranscriptionLanguages: ['en-US', 'fr-FR'],
      },
      fileSharing,
    });
  });

  it('gives no features and null language settings when alfaview sends none', () => {
    const settings = mapRoomSettings({ id: ROOM_ID }, undefined, fileSharing);
    assert.deepEqual(settings.features, {});
    assert.deepEqual(settings.language, {
      transcriptionEnabled: null,
      transcriptionType: null,
      defaultSpokenLanguage: null,
      targetTranscriptionLanguages: [],
    });
  });
});

describe('room settings requests', () => {
  const read = (path: string, body: unknown, status = 200): ExpectedRequest => ({
    method: 'GET',
    path,
    respond: { status, ...(body === undefined ? {} : { body }) },
  });

  it('getLanguageSettings reads the settings with the room ID in lowercase, and gives undefined for no body', async () => {
    const path = `${ROOM_PATH}/language-settings`;
    const { api, fake } = testApi([
      loginRequest(),
      read(path, fixture('rooms/language-settings.json')),
      read(path, null),
      read(path, undefined),
    ]);
    assert.equal((await getLanguageSettings(api, ROOM_ID.toUpperCase()))?.defaultSpokenLanguage, 'de-DE');
    assert.equal(await getLanguageSettings(api, ROOM_ID), undefined);
    assert.equal(await getLanguageSettings(api, ROOM_ID), undefined);
    fake.assertDone();
  });

  it('updateLanguageSettings sends PATCH with the change as it is', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      {
        method: 'PATCH',
        path: `${ROOM_PATH}/language-settings`,
        body: { targetTranscriptionLanguages: [], transcriptionEnabled: false },
        respond: { status: 204 },
      },
    ]);
    await updateLanguageSettings(api, ROOM_ID.toUpperCase(), {
      targetTranscriptionLanguages: [],
      transcriptionEnabled: false,
    });
    fake.assertDone();
  });

  it('listLanguages reads GET /v2/languages: null gives none, a body that is not an object fails', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      read('/v2/languages', fixture('rooms/languages.json')),
      read('/v2/languages', null),
      read('/v2/languages', '"de-DE"'),
    ]);
    assert.deepEqual((await listLanguages(api)).translation.at(-1), { in: 'es-ES', out: [] });
    assert.deepEqual(await listLanguages(api), { transcription: [], translation: [] });
    const error = await toolErrorOf(listLanguages(api));
    assert.deepEqual([error.code, error.message], ['InvalidResponse', LANGUAGE_LIST_MESSAGE]);
    fake.assertDone();
  });

  it('readFileSharing reads the settings, then the limits, with the room ID in lowercase', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      read(`${ROOM_PATH}/file-share-settings`, fixture('rooms/file-share-settings.json')),
      read(`${ROOM_PATH}/file-share-limits`, fixture('rooms/file-share-limits.json')),
    ]);
    const output = await readFileSharing(api, ROOM_ID.toUpperCase());
    assert.equal(output.remainingTotalMegabytes, 968);
    fake.assertDone();
  });

  it('readRoomSettings reads the room, the language settings, the file settings and the limits, in this order', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      read(ROOM_PATH, fixture('rooms/room.json')),
      read(`${ROOM_PATH}/language-settings`, fixture('rooms/language-settings.json')),
      read(`${ROOM_PATH}/file-share-settings`, fixture('rooms/file-share-settings.json')),
      read(`${ROOM_PATH}/file-share-limits`, fixture('rooms/file-share-limits.json')),
    ]);
    const settings = await readRoomSettings(api, ROOM_ID.toUpperCase());
    assert.deepEqual(Object.keys(settings), ['roomId', 'features', 'language', 'fileSharing']);
    assert.deepEqual(settings.features, { raiseHands: 'enabled', blockWebclient: 'disabled' });
    fake.assertDone();
  });

  it('updateFileSharing sends PATCH with the change as it is', async () => {
    const { api, fake } = testApi([
      loginRequest(),
      {
        method: 'PATCH',
        path: `${ROOM_PATH}/file-share-settings`,
        body: { defaultAccessLevel: 'hidden' },
        respond: { status: 204 },
      },
    ]);
    await updateFileSharing(api, ROOM_ID.toUpperCase(), { defaultAccessLevel: 'hidden' });
    fake.assertDone();
  });
});
