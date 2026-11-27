/**
 * The transcription and translation settings of a room, the languages that alfaview offers, and
 * the check of language codes against them. alfaview answers 422 to a `PATCH` that sets
 * `transcriptionType` without `defaultSpokenLanguage` on a room without a spoken language.
 */
import { booleanOrNull, textList, textOrNull } from './outputValues.ts';
import type { Platform } from './platform.ts';
import { byLabel, roomPath } from './rooms.ts';

// API shapes (spec: LanguageSettings, Languages, Translation)

export type ApiLanguageSettings = {
  defaultSpokenLanguage?: string | null;
  targetTranscriptionLanguages?: string[] | null;
  transcriptionEnabled?: boolean;
  transcriptionType?: string;
};

/** The languages that alfaview offers, with `null` lists read as empty. */
export type Languages = {
  /** The spoken languages. */
  transcription: string[];
  /** For each spoken language (`in`), the languages it can be translated into (`out`). */
  translation: { in: string; out: string[] }[];
};

// Output shape and mapper

export type LanguageSettingsOutput = {
  roomId: string;
  transcriptionEnabled: boolean | null;
  transcriptionType: string | null;
  defaultSpokenLanguage: string | null;
  targetTranscriptionLanguages: string[];
};

export function languageSettingsPath(roomId: string): string {
  return `${roomPath(roomId)}/language-settings`;
}

/**
 * Returns whether `value` names a spoken language. alfaview reports a room without one as `''`.
 * Missing, `null`, blank text and `und` (an undetermined language, in any case) are none.
 */
export function hasSpokenLanguage(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trim().toLowerCase();
  return text !== '' && text !== 'und';
}

/**
 * Returns the Language Settings output. Without a spoken language, the transcription type is
 * `null` too: alfaview reports `simple_transcription` for a room that has no transcription setup.
 */
export function mapLanguageSettings(
  roomId: string,
  settings: ApiLanguageSettings | undefined,
): LanguageSettingsOutput {
  const spoken = settings?.defaultSpokenLanguage;
  const hasSpoken = hasSpokenLanguage(spoken);
  return {
    roomId,
    transcriptionEnabled: booleanOrNull(settings?.transcriptionEnabled),
    transcriptionType: hasSpoken ? textOrNull(settings?.transcriptionType) : null,
    defaultSpokenLanguage: hasSpoken ? spoken : null,
    targetTranscriptionLanguages: textList(settings?.targetTranscriptionLanguages),
  };
}

// Language lists

/**
 * Returns the English name of a language code and the code, for example "German (Germany),
 * de-DE", or the code alone when the code is not well-formed or has no name.
 */
export function languageLabel(code: string): string {
  let name: string | undefined;
  try {
    name = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' }).of(code);
  } catch {
    name = undefined;
  }
  return name ? `${name}, ${code}` : code;
}

/**
 * Returns the entries of a language list, such as a dropdown: each code once (any case, the first
 * spelling wins), labeled with its English name and the code, sorted by label.
 */
export function languageEntries(codes: readonly string[]): { id: string; label: string }[] {
  const seen = new Set<string>();
  const entries: { id: string; label: string }[] = [];
  for (const code of codes) {
    if (seen.has(code.toLowerCase())) continue;
    seen.add(code.toLowerCase());
    entries.push({ id: code, label: languageLabel(code) });
  }
  return entries.sort(byLabel);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the languages of a `GET /v2/languages` answer. A missing or `null` body and `null` lists
 * give none, and entries of `translation` without a non-empty `in` are left out. Returns
 * `undefined` for a body that is not an object, so that the caller throws its response error.
 */
export function readLanguages(data: unknown): Languages | undefined {
  if (data === undefined || data === null) return { transcription: [], translation: [] };
  if (!isObject(data)) return undefined;
  const translation = Array.isArray(data.translation) ? data.translation.filter(isObject) : [];
  return {
    transcription: textList(data.transcription),
    translation: translation
      .filter((pair) => typeof pair.in === 'string' && pair.in !== '')
      .map((pair) => ({ in: pair.in as string, out: textList(pair.out) })),
  };
}

// Code check

/** Returns the first spelling of each code in `codes`, by lowercase code. */
function byLowercase(codes: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const code of codes) {
    if (!result.has(code.toLowerCase())) result.set(code.toLowerCase(), code);
  }
  return result;
}

/** Returns the codes of `targets` that alfaview does not translate `spoken` into, in any case. */
function untranslatable(
  languages: Languages,
  spoken: string,
  targets: readonly string[],
): string[] {
  const pair = languages.translation.find(
    (entry) => entry.in.toLowerCase() === spoken.toLowerCase(),
  );
  const reachable = new Set((pair?.out ?? []).map((code) => code.toLowerCase()));
  return targets.filter((code) => !reachable.has(code.toLowerCase()));
}

/** The codes of a language check: the codes of the change and the room's current codes. */
export type LanguageCodes = {
  spoken?: string;
  targets?: readonly string[];
  knownSpoken?: string | null;
  knownTargets?: readonly string[];
};

/**
 * A problem of checkedLanguageCodes, with the codes that its message names: the refused codes as
 * the user wrote them or as the room stores them, and the spoken language of the pair check.
 */
export type LanguageCodeProblem =
  | { kind: 'spokenNotOffered'; code: string }
  | { kind: 'keptTargetsUntranslatable'; spoken: string; codes: string[] }
  | { kind: 'targetsNotOffered'; codes: string[] }
  | { kind: 'targetsUntranslatable'; spoken: string; codes: string[] };

/**
 * Checks language codes against the languages that alfaview offers, because the spec does not say
 * that alfaview refuses a well-formed code that it does not offer. Codes compare without case.
 * Returns the codes as `/v2/languages` lists them, the target languages without duplicates.
 * Returns the first problem, in this order:
 * 1. `spokenNotOffered`: a spoken language that alfaview does not offer;
 * 2. `keptTargetsUntranslatable`: without `targets`, `knownTargets` (the room's current target
 *    languages) that `spoken` cannot be translated into, because a new spoken language keeps the
 *    current targets;
 * 3. `targetsNotOffered`: target languages that alfaview translates into from no language;
 * 4. `targetsUntranslatable`: target languages that the spoken language cannot be translated
 *    into. The spoken language is `spoken`, else `knownSpoken` (the room's current one) when it
 *    names a language.
 */
export function checkedLanguageCodes(
  languages: Languages,
  codes: LanguageCodes,
): { spoken?: string; targets?: string[] } | { problem: LanguageCodeProblem } {
  let spoken: string | undefined;
  if (codes.spoken !== undefined) {
    spoken = byLowercase(languages.transcription).get(codes.spoken.toLowerCase());
    if (spoken === undefined) return { problem: { kind: 'spokenNotOffered', code: codes.spoken } };
  }
  if (codes.targets === undefined) {
    if (spoken !== undefined) {
      const kept = untranslatable(languages, spoken, codes.knownTargets ?? []);
      if (kept.length > 0) {
        return { problem: { kind: 'keptTargetsUntranslatable', spoken, codes: kept } };
      }
    }
    return { spoken };
  }

  const offered = byLowercase(languages.translation.flatMap((pair) => pair.out));
  const unknown = codes.targets.filter((code) => !offered.has(code.toLowerCase()));
  if (unknown.length > 0) return { problem: { kind: 'targetsNotOffered', codes: unknown } };

  const source = spoken ?? (hasSpokenLanguage(codes.knownSpoken) ? codes.knownSpoken : undefined);
  if (source !== undefined) {
    const refused = untranslatable(languages, source, codes.targets);
    if (refused.length > 0) {
      return { problem: { kind: 'targetsUntranslatable', spoken: source, codes: refused } };
    }
  }

  const targets = codes.targets.map((code) => offered.get(code.toLowerCase()) as string);
  return { spoken, targets: [...new Set(targets)] };
}

/** The names of the language fields in the messages of createLanguageChecks. */
export type LanguageLabels = {
  defaultSpokenLanguage: string;
  translationLanguages: string;
  removeAllTranslationLanguages: string;
};

/** The check of createLanguageChecks. */
export type LanguageChecks = {
  /**
   * Checks language codes as checkedLanguageCodes does, and returns its codes. Throws the input
   * error of the platform for its problem, with a message that names the refused codes and the
   * fields of the labels.
   */
  checkLanguageCodes: (
    languages: Languages,
    codes: LanguageCodes,
  ) => { spoken?: string; targets?: string[] };
};

/** Returns the message of a problem of checkedLanguageCodes, with the field names of `labels`. */
function languageCodeText(problem: LanguageCodeProblem, labels: LanguageLabels): string {
  switch (problem.kind) {
    case 'spokenNotOffered':
      return `alfaview does not offer ${problem.code} as a spoken language. Choose ${labels.defaultSpokenLanguage} from the list.`;
    case 'keptTargetsUntranslatable':
      return `alfaview does not translate ${problem.spoken} into these ${labels.translationLanguages} of this room: ${problem.codes.join(', ')}. Set ${labels.translationLanguages} too, or ${labels.removeAllTranslationLanguages}.`;
    case 'targetsNotOffered':
      return `alfaview does not translate into ${problem.codes.join(', ')}. Choose ${labels.translationLanguages} from the list.`;
    case 'targetsUntranslatable':
      return `alfaview does not translate ${problem.spoken} into ${problem.codes.join(', ')}. Choose other ${labels.translationLanguages} or another ${labels.defaultSpokenLanguage}.`;
  }
}

/** Returns the language check bound to `platform`, with the field names of `labels` in messages. */
export function createLanguageChecks(platform: Platform, labels: LanguageLabels): LanguageChecks {
  return {
    checkLanguageCodes(languages, codes) {
      const checked = checkedLanguageCodes(languages, codes);
      if ('problem' in checked) {
        throw platform.invalidInput(languageCodeText(checked.problem, labels));
      }
      return checked;
    },
  };
}
