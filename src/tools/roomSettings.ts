// The room settings tools of the level `manage`. update_room_settings saves its parts one after
// another, in the order of PARTS, so each error says what is saved. Neither tool emails anyone.
import * as z from 'zod';
import { invalidInput, readAfterSavedWrite, refusedByAlfaview, ToolError } from '../alfaview/errors.ts';
import type { CallApi } from '../alfaview/client.ts';
import {
  FEATURE_STATE_VALUES,
  featureChange,
  getRoom,
  updateRoomFeatures,
  type FeatureChange,
} from '../domain/rooms.ts';
import {
  getLanguageSettings,
  languageCodeMessage,
  listLanguages,
  NO_SPOKEN_LANGUAGE_MESSAGE,
  readRoomSettings,
  roomNotFoundMessage,
  settingsSavedButNotReadMessage,
  updateFileSharing,
  updateLanguageSettings,
  type FileSharingChange,
  type LanguageSettingsChange,
  type RoomSettings,
} from '../domain/roomSettings.ts';
import { checkedLanguageCodes, hasSpokenLanguage } from '../shared/languages.ts';
import { textList } from '../shared/outputValues.ts';
import { FEATURE_KEYS } from '../shared/rooms.ts';
import { compact } from '../values/inputs.ts';
import { ROOM_SETTINGS, toolOutput } from './outputs.ts';
import {
  defineTool,
  IDEMPOTENT_CHANGE_ANNOTATIONS,
  listed,
  READ_ANNOTATIONS,
  roomIdParameter,
  textParameter,
} from './tool.ts';

// Messages

export const NOTHING_TO_CHANGE_MESSAGE =
  'Give at least one setting to change in features, language or fileSharing, or set resetFeatures true.';

/** The end of each error before the first write, and of a refused first write. */
export const NOTHING_CHANGED = 'Nothing changed.';

export const FILE_SHARING_OFF_FOR_COMPANY_WARNING =
  'File sharing is off for the whole company, so it stays off in this room.';

/**
 * The hint after a 403 of the language settings of a call that gives transcriptionEnabled:
 * alfaview refuses that field without the user permission Room Admin. The other fields need other
 * permissions, so a call without the field gets no hint. The parameter text does not name the
 * permission, so the model reads it only when it meets the error.
 */
export const TRANSCRIPTION_FORBIDDEN_HINT =
  'Changing transcriptionEnabled needs the user permission Room Admin.';

/**
 * The parts of a change, in the order of the writes: the part with the most causes of failure
 * first, so that most failures leave nothing saved.
 */
const PARTS = ['language', 'fileSharing', 'features'] as const;

type Part = (typeof PARTS)[number];

/** How a message names each part. */
const PART_NAMES: Record<Part, string> = {
  language: 'the language settings',
  fileSharing: 'file sharing',
  features: 'the features',
};

/** Returns the parts as a list of words, such as `the language settings and file sharing`. */
function partNames(parts: readonly Part[]): string {
  return listed(
    parts.map((part) => PART_NAMES[part]),
    'and',
  );
}

/** Returns `on` or `off` for a setting, or `unknown` when alfaview left the setting out. */
function onOff(value: boolean | null): string {
  return value === null ? 'unknown' : value ? 'on' : 'off';
}

/**
 * Returns the summary text of the settings, such as `2 features differ from the default,
 * transcription on, file sharing off`.
 */
function settingsState(settings: RoomSettings): string {
  const changed = Object.keys(settings.features).length;
  const features =
    changed === 0
      ? 'no features differ'
      : changed === 1
        ? '1 feature differs'
        : `${changed} features differ`;
  const transcription = onOff(settings.language.transcriptionEnabled);
  return `${features} from the default, transcription ${transcription}, file sharing ${onOff(settings.fileSharing.enabled)}`;
}

/**
 * Runs a step before the first write. A ToolError of the step keeps its code and gets
 * NOTHING_CHANGED at the end of its message: no write has gone out.
 */
async function beforeWrites<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    throw new ToolError(
      error.code,
      `${error.message} ${NOTHING_CHANGED}`,
      error.status,
      error.fieldLocations,
    );
  }
}

// The tools

export const getRoomSettingsTool = defineTool({
  name: 'get_room_settings',
  level: 'manage',
  title: 'Get room settings',
  description:
    'Returns the settings of an alfaview room: transcription with its spoken and translation languages, file sharing with the storage left, and the features that differ from the default.',
  inputSchema: z.strictObject({ roomId: roomIdParameter }),
  annotations: READ_ANNOTATIONS,
  personalData: { shape: 'mcp.roomSettings' },
  output: toolOutput(ROOM_SETTINGS),
  async run(input, { api }) {
    // alfaview answers default file sharing settings for a room that does not exist, so the room
    // read finds a wrong room. It also gives the features, as GetRoomFeatures would.
    const settings = await readRoomSettings(api, input.roomId);
    return { summary: `Room ${settings.roomId}: ${settingsState(settings)}.`, data: settings };
  },
});

// 35 characters hold every BCP 47 tag that alfaview offers, and 50 languages are more than a plan
// allows.
const languageSchema = z.strictObject({
  transcriptionEnabled: z
    .boolean()
    .describe('If true, transcription can be started in the room. If false, it stops.')
    .optional(),
  transcriptionType: z
    .enum(['simple_transcription', 'digital_interpreter'])
    .describe(
      'digital_interpreter lets each participant choose the language they speak. simple_transcription uses defaultSpokenLanguage.',
    )
    .optional(),
  defaultSpokenLanguage: textParameter(
    'Language code of what people say in the room, for example de-DE.',
    35,
  ).optional(),
  targetTranscriptionLanguages: z
    .array(z.string().trim().min(1).max(35))
    .max(50)
    .describe(
      'Language codes to translate into, for example ["en-US"]. The list replaces the current one, and [] removes them all.',
    )
    .optional(),
});

type LanguageInput = z.output<typeof languageSchema>;

const fileSharingSchema = z.strictObject({
  enabled: z.boolean().describe('If true, people can share files in the room.').optional(),
  defaultAccessLevel: z
    .enum(['hidden', 'visible', 'downloadable'])
    .describe(
      'Access of the other participants to a new file. Moderators can always download files.',
    )
    .optional(),
  participantsCanUpload: z
    .boolean()
    .describe(
      'If false, only moderators upload files. If true, also participants, by default not guests.',
    )
    .optional(),
});

/**
 * Returns the request body that changes the language settings. alfaview answers 422 for a
 * transcription type without a spoken language, and the API docs do not say that it refuses a
 * well-formed code that it does not offer. So the checks come first, with messages that name the
 * problem.
 *
 * It reads the current settings only when a check needs them. Without a spoken language in the
 * call, a transcription type needs the current one, and the translation languages are checked
 * against it. With a spoken language but no translation languages, the room keeps its translation
 * languages, so they are checked against the new spoken language. `[]` removes every translation
 * language and needs no check.
 */
async function languageChange(
  api: CallApi,
  roomId: string,
  language: LanguageInput,
): Promise<LanguageSettingsChange> {
  const {
    transcriptionEnabled,
    transcriptionType,
    defaultSpokenLanguage: spoken,
    targetTranscriptionLanguages: targets,
  } = language;
  const removeAllTargets = targets !== undefined && targets.length === 0;
  const hasTargets = targets !== undefined && targets.length > 0;
  const needsCurrentSpoken = spoken === undefined && (transcriptionType !== undefined || hasTargets);
  const keepsCurrentTargets = spoken !== undefined && targets === undefined;
  const current =
    needsCurrentSpoken || keepsCurrentTargets ? await getLanguageSettings(api, roomId) : undefined;
  if (
    needsCurrentSpoken &&
    transcriptionType !== undefined &&
    !hasSpokenLanguage(current?.defaultSpokenLanguage)
  ) {
    throw invalidInput(NO_SPOKEN_LANGUAGE_MESSAGE);
  }

  let checked: { spoken?: string; targets?: string[] } = {};
  if (spoken !== undefined || hasTargets) {
    const languages = await listLanguages(api);
    const result = checkedLanguageCodes(languages, {
      spoken,
      targets,
      knownSpoken: current?.defaultSpokenLanguage,
      knownTargets: keepsCurrentTargets ? textList(current?.targetTranscriptionLanguages) : undefined,
    });
    if ('problem' in result) throw invalidInput(languageCodeMessage(result.problem, languages));
    checked = result;
  }
  return compact({
    defaultSpokenLanguage: checked.spoken,
    targetTranscriptionLanguages: removeAllTargets ? [] : checked.targets,
    transcriptionEnabled,
    transcriptionType,
  });
}

/** A failed write and what the message of its error needs. */
type FailedWrite = {
  error: ToolError;
  roomId: string;
  saved: readonly Part[];
  failed: Part;
  notSent: readonly Part[];
  /** The parameters of a call that changes only the failed part and the parts not sent. */
  retry: readonly string[];
  /** The hint after a 403 of the failed part, if it has one. */
  forbiddenHint: string | undefined;
};

/**
 * Returns the error of a failed write. alfaview refused the write when it answered with an error
 * status of 400 to 499, so that part did not change. A status of 500 and up, a timeout or a lost
 * answer can come after the save, so then alfaview may have saved that part. An error before the
 * request went out, such as a local request limit or a failed login, gets the same note, which is
 * on the safe side.
 *
 * A failed first write gives the error text of the request with NOTHING_CHANGED, or with the note
 * that alfaview may have saved that part. A failed later write gives PartlySaved with the saved
 * parts, the failed part, the parts not sent, and the parameters of a call that changes only
 * those. Each part overwrites, so the same call again is safe.
 */
function writeError(write: FailedWrite): ToolError {
  const { error, roomId, saved, failed, notSent, retry } = write;
  const refused = refusedByAlfaview(error);
  if (saved.length === 0) {
    const end = refused
      ? NOTHING_CHANGED
      : `alfaview may have saved ${PART_NAMES[failed]} before the error, and nothing else changed. The same call again is safe.`;
    // The language settings are always the first write, so only this branch can have their 403.
    const hint =
      write.forbiddenHint !== undefined && error.code === 'Forbidden' ? ` ${write.forbiddenHint}` : '';
    return new ToolError(
      error.code,
      `${error.message}${hint} ${end}`,
      error.status,
      error.fieldLocations,
    );
  }
  const outcome = refused
    ? `but the change of ${PART_NAMES[failed]} failed`
    : `and may have saved ${PART_NAMES[failed]} before this error`;
  const rest = notSent.length === 0 ? '' : ` ${capitalized(partNames(notSent))} did not change.`;
  return new ToolError(
    'PartlySaved',
    `alfaview saved ${partNames(saved)} of room ${roomId}, ${outcome}: ${error.message}${rest} What is saved stays saved. Fix the cause and call update_room_settings again with only ${listed(retry, 'and')}. The same call again is also safe.`,
    error.status,
  );
}

function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

export const updateRoomSettingsTool = defineTool({
  name: 'update_room_settings',
  level: 'manage',
  title: 'Update room settings',
  description:
    'Changes the features, the transcription and translation, and the file sharing of an alfaview room, and returns all its settings after the change. Parts and fields that you leave out stay as they are.',
  inputSchema: z.strictObject({
    roomId: roomIdParameter,
    // A partial record: the SDK lists the 14 keys in propertyNames, in fewer bytes than an object
    // with 14 optional keys. The text explains only the keys whose name does not say what they do.
    features: z
      .partialRecord(z.enum(FEATURE_KEYS), z.enum(FEATURE_STATE_VALUES))
      .describe(
        "default removes the room's own setting. disableCameraOff keeps cameras on. allowCopyRoomInfo lets moderators copy the participant list. blockWebclient hides the browser join for guests. examScreenshare shows the screen of each participant to the moderators: tell the participants.",
      )
      .optional(),
    resetFeatures: z
      .boolean()
      .default(false)
      .describe('If true, each feature that features does not name goes back to the default.'),
    language: languageSchema
      .describe(
        'While transcription runs, alfaview sends what people say to its transcription service: tell the participants. It can cost extra and needs transcription in the plan.',
      )
      .optional(),
    fileSharing: fileSharingSchema.describe('The file sharing settings of the room.').optional(),
  }),
  annotations: IDEMPOTENT_CHANGE_ANNOTATIONS,
  personalData: { shape: 'mcp.roomSettings' },
  output: toolOutput({ ...ROOM_SETTINGS, changed: z.array(z.enum(PARTS)) }),
  readTool: 'get_room_settings',
  async run(input, { api }) {
    const features: FeatureChange = featureChange(input.features, input.resetFeatures);
    const language = compact<LanguageInput>(input.language ?? {});
    const fileSharing: FileSharingChange = compact<FileSharingChange>(input.fileSharing ?? {});
    // An empty part counts as nothing to change.
    const given: Record<Part, boolean> = {
      language: Object.keys(language).length > 0,
      fileSharing: Object.keys(fileSharing).length > 0,
      features: Object.keys(features).length > 0,
    };
    const parts = PARTS.filter((part) => given[part]);
    if (parts.length === 0) throw invalidInput(NOTHING_TO_CHANGE_MESSAGE);
    const roomId = input.roomId.toLowerCase();

    // alfaview stores file sharing settings for a room that does not exist, so the room read is
    // the only way to report a wrong room, and one rule for each part is simpler.
    const room = await beforeWrites(() => getRoom(api, roomId, { allowNotFound: true }));
    if (room === undefined) throw new ToolError('NotFound', roomNotFoundMessage(roomId), 404);
    const languageBody = given.language
      ? await beforeWrites(() => languageChange(api, roomId, language))
      : {};

    const writes: Record<Part, () => Promise<void>> = {
      language: () => updateLanguageSettings(api, roomId, languageBody),
      fileSharing: () => updateFileSharing(api, roomId, fileSharing),
      features: () => updateRoomFeatures(api, roomId, features),
    };
    // The parameters of a call that changes only some parts, in the order of the writes.
    const parameters: Record<Part, string[]> = {
      language: ['language'],
      fileSharing: ['fileSharing'],
      features: [
        ...(Object.keys(input.features ?? {}).length > 0 ? ['features'] : []),
        ...(input.resetFeatures ? ['resetFeatures'] : []),
      ],
    };
    // Only transcriptionEnabled needs the user permission Room Admin.
    const forbiddenHints: Record<Part, string | undefined> = {
      language: language.transcriptionEnabled === undefined ? undefined : TRANSCRIPTION_FORBIDDEN_HINT,
      fileSharing: undefined,
      features: undefined,
    };
    for (const [index, part] of parts.entries()) {
      try {
        await writes[part]();
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        const notSent = parts.slice(index + 1);
        throw writeError({
          error,
          roomId,
          saved: parts.slice(0, index),
          failed: part,
          notSent,
          retry: [part, ...notSent].flatMap((next) => parameters[next]),
          forbiddenHint: forbiddenHints[part],
        });
      }
    }

    const settings = await readAfterSavedWrite(
      () => readRoomSettings(api, roomId, { requireFeatures: given.features }),
      settingsSavedButNotReadMessage(roomId),
    );
    const warnings =
      fileSharing.enabled === true && settings.fileSharing.enabled === false
        ? [FILE_SHARING_OFF_FOR_COMPANY_WARNING]
        : [];
    return {
      summary: `Updated ${partNames(parts)} of room ${roomId}: ${settingsState(settings)}.`,
      warnings,
      data: { ...settings, roomId, changed: parts },
    };
  },
});

/** The room settings tools, in the order of the tool list. */
export const ROOM_SETTINGS_TOOLS = [getRoomSettingsTool, updateRoomSettingsTool] as const;
