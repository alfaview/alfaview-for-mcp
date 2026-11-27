// The settings of a room (its features, transcription and translation, and file sharing with the
// storage left) and the languages that alfaview offers.
import type { CallApi } from '../alfaview/client.ts';
import { invalidResponse } from '../alfaview/errors.ts';
import {
  fileShareLimitsPath,
  fileShareSettingsPath,
  mapFileSharing,
  type ApiFileShareLimits,
  type ApiFileShareSettings,
  type FileSharingOutput,
} from '../shared/fileSharing.ts';
import {
  languageSettingsPath,
  mapLanguageSettings,
  readLanguages,
  type ApiLanguageSettings,
  type LanguageCodeProblem,
  type Languages,
  type LanguageSettingsOutput,
} from '../shared/languages.ts';
import { changedFeatures, getRoom, type ApiRoom } from './rooms.ts';

// Messages

export const LANGUAGE_LIST_MESSAGE = 'alfaview sent an unexpected language response.';

export const NO_SPOKEN_LANGUAGE_MESSAGE =
  'Give defaultSpokenLanguage too. This room has no default spoken language yet.';

/** Returns the error for a room that alfaview does not find before a change of its settings. */
export function roomNotFoundMessage(roomId: string): string {
  return `alfaview could not find the room ${roomId}, so nothing changed.`;
}

/** Returns the error when the settings cannot be read back after every change is saved. */
export function settingsSavedButNotReadMessage(roomId: string): string {
  return `alfaview saved every change to room ${roomId}, but reading the settings back failed. Use get_room_settings to read them.`;
}

/**
 * Returns `codes` as the list of a message: each code once in any case, with its first spelling,
 * sorted. An empty `codes` gives `none`, so that a message never ends with an empty list: alfaview
 * may offer no code.
 */
function offered(codes: readonly string[]): string {
  const seen = new Map<string, string>();
  for (const code of codes) {
    if (!seen.has(code.toLowerCase())) seen.set(code.toLowerCase(), code);
  }
  const list = [...seen.values()].sort();
  return list.length === 0 ? 'none' : list.join(', ');
}

/**
 * Returns the message of a problem of checkedLanguageCodes, with the codes that alfaview offers in
 * `languages`: the model has no dropdown to choose from.
 */
export function languageCodeMessage(problem: LanguageCodeProblem, languages: Languages): string {
  switch (problem.kind) {
    case 'spokenNotOffered':
      return `alfaview does not offer ${problem.code} as a spoken language. It offers: ${offered(languages.transcription)}.`;
    case 'keptTargetsUntranslatable':
      return `alfaview does not translate ${problem.spoken} into these translation languages of this room: ${problem.codes.join(', ')}. Give targetTranscriptionLanguages too, or [] to remove them.`;
    case 'targetsNotOffered':
      return `alfaview does not translate into ${problem.codes.join(', ')}. It translates into: ${offered(languages.translation.flatMap((pair) => pair.out))}.`;
    case 'targetsUntranslatable': {
      // The first pair of the spoken language, as checkedLanguageCodes takes it.
      const spoken = problem.spoken.toLowerCase();
      const targets =
        languages.translation.find((pair) => pair.in.toLowerCase() === spoken)?.out ?? [];
      return `alfaview does not translate ${problem.spoken} into ${problem.codes.join(', ')}. It translates ${problem.spoken} into: ${offered(targets)}.`;
    }
  }
}

// Output shapes and mappers

/** The language settings of a room, without its ID. */
export type LanguageSettings = Omit<LanguageSettingsOutput, 'roomId'>;

/**
 * The file sharing settings and the storage left of a room, without its ID and without the byte
 * counts, which repeat the megabytes.
 */
export type FileSharing = Omit<FileSharingOutput, 'roomId' | 'maxTotalBytes' | 'remainingTotalBytes'>;

/**
 * The output of get_room_settings, which update_room_settings also gives, with the room ID of the
 * call and the parts that it changed.
 */
export type RoomSettings = {
  roomId: string;
  /** Only the features whose state is not `default`, in the order of FEATURE_KEYS. */
  features: Record<string, string>;
  language: LanguageSettings;
  fileSharing: FileSharing;
};

/** Returns the File Sharing output without the room ID and the byte counts. */
export function mapFileSharingSettings(
  settings: ApiFileShareSettings | undefined,
  limits: ApiFileShareLimits | undefined,
): FileSharing {
  const { roomId: _roomId, maxTotalBytes: _max, remainingTotalBytes: _remaining, ...fileSharing } =
    mapFileSharing('', settings, limits);
  return fileSharing;
}

/**
 * Returns the settings of `room`: the features of GetRoom that differ from the default, the
 * language settings and the file sharing settings. The room ID is the one of GetRoom.
 */
export function mapRoomSettings(
  room: ApiRoom,
  languageSettings: ApiLanguageSettings | undefined,
  fileSharing: FileSharing,
): RoomSettings {
  const { roomId: _roomId, ...language } = mapLanguageSettings(room.id, languageSettings);
  return { roomId: room.id, features: changedFeatures(room.features), language, fileSharing };
}

// Requests

/**
 * Returns the language settings of a room (`GET /v2/rooms/{id}/language-settings`). An empty or
 * `null` body gives `undefined`, which mapLanguageSettings maps to nulls.
 */
export async function getLanguageSettings(
  api: CallApi,
  roomId: string,
): Promise<ApiLanguageSettings | undefined> {
  const { data } = await api.request<ApiLanguageSettings | null>({
    method: 'GET',
    path: languageSettingsPath(roomId),
  });
  return data ?? undefined;
}

/** The fields of the language settings that a change sets (spec: LanguageSettingsEdit). */
export type LanguageSettingsChange = {
  defaultSpokenLanguage?: string;
  /** `[]` removes every translation language. */
  targetTranscriptionLanguages?: string[];
  transcriptionEnabled?: boolean;
  transcriptionType?: 'simple_transcription' | 'digital_interpreter';
};

/**
 * Changes the given language settings of a room (`PATCH /v2/rooms/{id}/language-settings`). The
 * spec does not say that alfaview refuses a well-formed language code that it does not offer, so
 * the caller checks the codes first (checkedLanguageCodes). Its answer has no body.
 */
export async function updateLanguageSettings(
  api: CallApi,
  roomId: string,
  change: LanguageSettingsChange,
): Promise<void> {
  await api.request({ method: 'PATCH', path: languageSettingsPath(roomId), body: change });
}

/** Returns the languages that alfaview offers (`GET /v2/languages`, readLanguages). */
export async function listLanguages(api: CallApi): Promise<Languages> {
  const { data } = await api.request<unknown>({ method: 'GET', path: '/v2/languages' });
  const languages = readLanguages(data);
  if (languages === undefined) throw invalidResponse(LANGUAGE_LIST_MESSAGE);
  return languages;
}

/**
 * Returns the file sharing settings and the storage left of a room: `GET .../file-share-settings`,
 * then `GET .../file-share-limits`. alfaview answers default settings for a room that does not
 * exist, so the caller reads the room first: that read is the only way to find a wrong room.
 */
export async function readFileSharing(api: CallApi, roomId: string): Promise<FileSharing> {
  const { data: settings } = await api.request<ApiFileShareSettings>({
    method: 'GET',
    path: fileShareSettingsPath(roomId),
  });
  const { data: limits } = await api.request<ApiFileShareLimits>({
    method: 'GET',
    path: fileShareLimitsPath(roomId),
  });
  return mapFileSharingSettings(settings, limits);
}

/** The InvalidResponse of a read back without the features of the room. */
const FEATURES_NOT_RETURNED_MESSAGE = 'alfaview did not return the features of the room.';

/**
 * Returns the settings of a room, as get_room_settings gives them: `GET /v2/rooms/{id}`, which
 * finds a wrong room and gives the features, then the language settings, then the file sharing
 * settings and the storage left. With `requireFeatures`, a room without a features object is an
 * InvalidResponse: after a change of the features, it would read as no feature that differs from
 * the default, which the saved change contradicts.
 */
export async function readRoomSettings(
  api: CallApi,
  roomId: string,
  options: { requireFeatures?: boolean } = {},
): Promise<RoomSettings> {
  const room = await getRoom(api, roomId);
  const { features } = room;
  if (
    options.requireFeatures === true &&
    (typeof features !== 'object' || features === null || Array.isArray(features))
  ) {
    throw invalidResponse(FEATURES_NOT_RETURNED_MESSAGE);
  }
  const languageSettings = await getLanguageSettings(api, roomId);
  const fileSharing = await readFileSharing(api, roomId);
  return mapRoomSettings(room, languageSettings, fileSharing);
}

/** The fields of the file sharing settings that a change sets (spec: RoomSettingsUpdate). */
export type FileSharingChange = {
  enabled?: boolean;
  defaultAccessLevel?: 'hidden' | 'visible' | 'downloadable';
  participantsCanUpload?: boolean;
};

/**
 * Changes the given file sharing settings of a room (`PATCH /v2/rooms/{id}/file-share-settings`).
 * alfaview stores the settings also for a room that does not exist, so the caller reads the room
 * first. Its answer has no body. `enabled` needs the user permission Room Admin or the room
 * permission `admin`. The other fields need Room Admin, or the room permission `admin` or
 * `promote`.
 */
export async function updateFileSharing(
  api: CallApi,
  roomId: string,
  change: FileSharingChange,
): Promise<void> {
  await api.request({ method: 'PATCH', path: fileShareSettingsPath(roomId), body: change });
}
