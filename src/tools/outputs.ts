// The output schemas of the tools. The tests check each result against the strict zod shape. The
// server advertises and checks an open form that allows other keys, so that a rare extra key
// cannot break a call whose write alfaview already did.
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { FEATURE_KEYS, PERMISSION_KEYS, type PermissionKey } from '../shared/rooms.ts';

// Values

// A key that alfaview can leave out, and each key of a shape in PERSONAL_KEYS of
// src/shared/personalData.ts, is nullable, so that one schema fits both values of the option
// Personal data.
const nullableText = z.string().nullable();
const nullableFlag = z.boolean().nullable();
const nullableCount = z.int().nullable();

/** The offset of the next part of a list, or null after the last part. */
const nextOffset = z.int().nullable();

/**
 * Returns the strict shape of a result: the keys of `shape` and `warnings`, the list of texts that
 * the wrapper adds as the last key of each result.
 */
export function toolOutput<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.strictObject({ ...shape, warnings: z.array(z.string()) });
}

/** The keys of a part of a sorted list (ListPart of src/tools/tool.ts), without its items. */
export const LIST_PART = { totalMatches: z.int(), offset: z.int(), nextOffset };

/** The keys of a list without totalMatches, such as the invited people of an attendance. */
export const LIST_PAGE = { offset: z.int(), nextOffset };

// Shapes that more than one tool returns

/** RoomSummary of src/domain/rooms.ts: an entry of find_rooms. */
export const ROOM_SUMMARY = z.strictObject({
  id: z.string(),
  displayName: nullableText,
  type: nullableText,
  parentId: nullableText,
  waitingRoomEnabled: nullableFlag,
  passcodeRequired: nullableFlag,
});

/** Room of src/domain/rooms.ts. `features` holds only the features that differ from the default. */
export const ROOM = ROOM_SUMMARY.extend({
  waitingRoomWelcomeNote: nullableText,
  managed: nullableFlag,
  createdAt: nullableText,
  quotas: z
    .strictObject({
      activeParticipants: nullableCount,
      spectatorOnlyParticipants: nullableCount,
      maxVideoTilesPerPage: nullableCount,
    })
    .nullable(),
  features: z.partialRecord(z.enum(FEATURE_KEYS), z.string()),
  subrooms: z.array(z.strictObject({ id: z.string(), displayName: nullableText })),
  passcode: nullableText,
});

/**
 * GuestLink of src/domain/guestLinks.ts. mapGuestLink leaves out roomId when find_guest_links got
 * one, and the join URL unless find_guest_links was asked for it.
 */
export const GUEST_LINK = z.strictObject({
  id: z.string(),
  roomId: nullableText.optional(),
  inMeetingRoom: z.boolean(),
  emailAddress: nullableText,
  displayName: nullableText,
  joinUrl: nullableText.optional(),
  locale: nullableText,
  validFrom: nullableText,
  validUntil: nullableText,
  permissionGroupName: nullableText,
  dialInAllowed: nullableFlag,
  origin: nullableText,
  createdAt: nullableText,
});

/** The guest link of update_guest_link, which never holds the join URL. */
export const GUEST_LINK_WITHOUT_URL = GUEST_LINK.omit({ joinUrl: true });

/**
 * ListedMeeting of src/domain/meetings.ts: an entry of find_meetings. `guestLinkCount` is null for
 * a recurring meeting.
 */
export const MEETING_SUMMARY = z.strictObject({
  id: z.string(),
  title: nullableText,
  start: nullableText,
  end: nullableText,
  timezone: nullableText,
  state: nullableText,
  canJoin: nullableFlag,
  guestLinkCount: nullableCount,
  recurrenceRule: nullableText,
  externallyManaged: nullableFlag,
});

/**
 * MeetingDetails: the meeting of the tools that change it, without the join URLs. A meeting that
 * is read by its ID always has its count of guest links.
 */
export const MEETING_DETAILS = MEETING_SUMMARY.extend({
  guestLinkCount: z.int(),
  agenda: nullableText,
  earlyAccessMinutes: nullableCount,
  canJoinAfter: nullableText,
  canceledAt: nullableText,
  roomAvailable: nullableFlag,
  createdAt: nullableText,
  nextInstance: nullableText,
});

/** Meeting: the details with the join URL of each permission group. */
export const MEETING = MEETING_DETAILS.extend({
  groupLinks: z.array(
    z.strictObject({
      permissionGroupId: z.string(),
      permissionGroupName: nullableText,
      joinUrl: nullableText,
    }),
  ),
});

/** The keys of UserOutput of src/shared/users.ts without its ID. */
const USER_KEYS = {
  emailAddress: nullableText,
  firstName: nullableText,
  lastName: nullableText,
  title: nullableText,
  city: nullableText,
  initials: nullableText,
  locale: nullableText,
};

/** UserOutput of src/shared/users.ts: the profile of get_account and update_own_user. */
export const USER = z.strictObject({ id: z.string(), ...USER_KEYS });

/** ListedUser of src/domain/users.ts: an entry of find_users. */
export const LISTED_USER = USER.omit({ city: true, initials: true });

/**
 * The user of invite_user, with the user permissions that the call gave. The ID is
 * null while alfaview does not list the new user.
 */
export const INVITED_USER = {
  ...LISTED_USER.shape,
  id: nullableText,
  invited: z.boolean(),
  userPermissions: z.array(z.string()),
};

/** RoomSettings of src/domain/roomSettings.ts. */
export const ROOM_SETTINGS = {
  roomId: z.string(),
  features: z.partialRecord(z.enum(FEATURE_KEYS), z.string()),
  language: z.strictObject({
    transcriptionEnabled: nullableFlag,
    transcriptionType: nullableText,
    defaultSpokenLanguage: nullableText,
    targetTranscriptionLanguages: z.array(z.string()),
  }),
  fileSharing: z.strictObject({
    enabled: nullableFlag,
    defaultAccessLevel: nullableText,
    participantsCanUpload: nullableFlag,
    maxFiles: nullableCount,
    remainingFiles: nullableCount,
    maxTotalMegabytes: nullableCount,
    remainingTotalMegabytes: nullableCount,
  }),
};

/** BreakoutRoom of src/domain/rooms.ts. */
export const BREAKOUT_ROOM = {
  id: z.string(),
  roomId: z.string(),
  displayName: nullableText,
};

/**
 * GroupLink of src/domain/groupLinks.ts. mapGroupLink leaves out roomId when find_group_links
 * got one, and the join URL unless create_group_link made the link or find_group_links was asked
 * for it.
 */
export const GROUP_LINK = z.strictObject({
  id: z.string(),
  roomId: nullableText.optional(),
  description: nullableText,
  joinUrl: nullableText.optional(),
  permissionGroupName: nullableText,
  validFrom: nullableText,
  validUntil: nullableText,
  dialInAllowed: nullableFlag,
  origin: nullableText,
  createdAt: nullableText,
  meetingLink: z.boolean(),
});

/** The group link of update_group_link, which never holds the join URL. */
export const GROUP_LINK_WITHOUT_URL = GROUP_LINK.omit({ joinUrl: true });

/** The room permissions of PERMISSION_KEYS, each true, false, or null when alfaview left it out. */
export const ROOM_PERMISSIONS = Object.fromEntries(
  PERMISSION_KEYS.map((key) => [key, nullableFlag]),
) as Record<PermissionKey, typeof nullableFlag>;

// The open form

/**
 * An integer of the open form. `z.int()` refuses an integer above `Number.MAX_SAFE_INTEGER`, such
 * as an int64 of alfaview, but JSON can hold it, and the advertised `{ "type": "integer" }` takes
 * it. So the open form takes each integer, and its JSON Schema stays `{ "type": "integer" }`.
 */
const OPEN_INTEGER = z.number().refine(Number.isInteger).meta({ type: 'integer' });

/**
 * Returns the open form of `schema`: each object allows other keys, each record and each enum
 * takes any text, each integer takes any integer (OPEN_INTEGER), and every other value keeps its
 * type. It knows the kinds of value that the shapes of this module use, and keeps any other schema
 * as it is.
 */
export function openOutput(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodObject) {
    const shape: Record<string, z.ZodType> = {};
    for (const [key, value] of Object.entries(schema.shape)) {
      shape[key] = openOutput(value as z.ZodType);
    }
    return z.looseObject(shape);
  }
  if (schema instanceof z.ZodArray) return z.array(openOutput(schema.element as z.ZodType));
  if (schema instanceof z.ZodNullable) return openOutput(schema.unwrap() as z.ZodType).nullable();
  if (schema instanceof z.ZodOptional) return openOutput(schema.unwrap() as z.ZodType).optional();
  if (schema instanceof z.ZodRecord) {
    return z.record(z.string(), openOutput(schema.valueType as z.ZodType));
  }
  if (schema instanceof z.ZodEnum) return z.string();
  if (schema instanceof z.ZodNumber && schema.isInt) return OPEN_INTEGER;
  return schema;
}

type JsonSchema = Record<string, unknown>;

/** The keys that a schema in an anyOf with null can keep when it takes null as one more type. */
const MERGEABLE_KEYS = new Set(['type', 'properties', 'required', 'items']);

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns whether `value` is the JSON Schema `{ type: 'string' }` and nothing else. */
function isPlainText(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 1 && value.type === 'string';
}

/**
 * Returns `schema` with `anyOf: [{ type: t, ... }, { type: 'null' }]` written as
 * `{ type: [t, 'null'], ... }`, which takes the same values in fewer bytes, when the first schema
 * has only keys that apply to one type. Any other schema stays as it is.
 */
function withNullType(schema: JsonSchema): JsonSchema {
  const [first, second, ...rest] = Array.isArray(schema.anyOf) ? (schema.anyOf as JsonSchema[]) : [];
  const nullable =
    Object.keys(schema).length === 1 &&
    rest.length === 0 &&
    second?.type === 'null' &&
    Object.keys(second).length === 1;
  // With a second schema, the list has a first one.
  if (
    !nullable ||
    typeof first!.type !== 'string' ||
    !Object.keys(first!).every((key) => MERGEABLE_KEYS.has(key))
  ) {
    return schema;
  }
  return { ...first, type: [first!.type, 'null'] };
}

/**
 * Returns `node` as the server advertises it: without `$schema`, without
 * `additionalProperties: {}` and `propertyNames: { type: 'string' }`, which allow what JSON allows
 * anyway, and with a nullable schema as a list of types (withNullType). The keys of the other
 * schemas keep their order. An integer of the open form has no bounds (OPEN_INTEGER).
 */
export function slimOutputJson(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(slimOutputJson);
  if (!isRecord(node)) return node;
  const slim: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    const dropped =
      key === '$schema' ||
      (key === 'additionalProperties' && isRecord(value) && Object.keys(value).length === 0) ||
      (key === 'propertyNames' && isPlainText(value));
    if (!dropped) slim[key] = slimOutputJson(value);
  }
  return withNullType(slim);
}

type OutputForms = {
  open: z.ZodType;
  advertised: StandardSchemaWithJSON<unknown, unknown>;
};

const forms = new WeakMap<z.ZodType, OutputForms>();

/** Returns the open form and the advertised schema of `output`, made once for each shape. */
function formsOf(output: z.ZodType): OutputForms {
  const known = forms.get(output);
  if (known !== undefined) return known;
  const open = openOutput(output);
  const json = slimOutputJson(z.toJSONSchema(open, { target: 'draft-2020-12', io: 'output' }));
  // An output schema has one JSON Schema: the SDK advertises the output side.
  const jsonSchema = () => json as Record<string, unknown>;
  const made: OutputForms = {
    open,
    advertised: {
      '~standard': {
        version: 1,
        vendor: 'zod',
        validate: open['~standard'].validate,
        jsonSchema: { input: jsonSchema, output: jsonSchema },
      },
    },
  };
  forms.set(output, made);
  return made;
}

/**
 * Returns the output schema that the server registers for `output`: a Standard Schema whose check
 * is the open form, and whose JSON Schema is the JSON Schema 2020-12 that zod makes of the open
 * form, slimmed by slimOutputJson. The SDK checks each result with it, also in production.
 */
export function advertisedOutput(output: z.ZodType): StandardSchemaWithJSON<unknown, unknown> {
  return formsOf(output).advertised;
}

/** Writes a path such as `['rooms', 0, 'type']` as `rooms[].type`, the form of PERSONAL_KEYS. */
function pathText(path: readonly PropertyKey[]): string {
  return path.reduce<string>(
    (text, key) =>
      typeof key === 'number' ? `${text}[]` : text === '' ? String(key) : `${text}.${String(key)}`,
    '',
  );
}

/**
 * Returns the path of the first key of `data` that the open form of `output` refuses, or undefined
 * when the data fits. It names only keys and list entries, never a value, so the log can hold it.
 */
export function outputProblem(output: z.ZodType, data: unknown): string | undefined {
  const checked = formsOf(output).open.safeParse(data);
  return checked.success ? undefined : pathText(checked.error.issues[0]!.path);
}

/** Returns the error text of a read tool whose data does not fit its output schema. */
export function unexpectedResponseMessage(tool: string): string {
  return `alfaview sent an unexpected response for ${tool}.`;
}

/**
 * Returns the error text of a tool that changes something, when its data does not fit its output
 * schema. The change is done, so the text tells the model not to repeat it. `readTool` is the tool
 * that reads the change.
 */
export function unformedResultMessage(tool: string, readTool: string | undefined): string {
  const read = readTool === undefined ? '' : ` Read the result with ${readTool}.`;
  return `alfaview did the change, but the server could not form its result. Do not call ${tool} again for it.${read}`;
}
