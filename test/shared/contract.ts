/**
 * The contract check of the tests: whether a mocked request fits the OpenAPI 3.1 spec of the
 * alfaview API.
 */

/**
 * The rule of a problem: the part of a request that the check compares with the spec.
 *
 * - `operation`: the method and the path template. A literal segment matches before a parameter,
 *   so `/v2/users/me` matches before `/v2/users/{id}`. The path is split at `/` before a segment
 *   is decoded, and each path parameter is checked against its schema.
 * - `query`: unknown names, a name given more than once, missing required parameters, and each
 *   value converted from text and checked against its schema. An array parameter is a comma list
 *   (`explode: false`). The API reads an empty value as absent, so an empty required parameter is
 *   missing, and an empty optional parameter is a problem of its own: the API ignores it.
 * - `headers`: `Content-Type: application/json` with a body. `Authorization` on every operation
 *   that needs the token, never empty, and absent on the others, such as the logins. The rule
 *   refuses the word `Bearer` in front of the token, so that every client sends the token in the
 *   form that the spec documents: without that prefix. An operation needs the token when its
 *   security requirement, or that of the spec, names a scheme of the type `http`, or when it
 *   declares the Authorization header parameter. The rule checks only the headers that the check
 *   point can see.
 * - `body`: present when the operation requires one, absent when it declares none, valid JSON,
 *   and valid against its schema.
 */
export type ContractRule = 'operation' | 'query' | 'headers' | 'body';

/** One way in which a request does not fit the spec. */
export type ContractProblem = {
  /**
   * The operationId of the operation that the request matched, or its method and path template
   * when it has none. `undefined` when no operation matched.
   */
  operation: string | undefined;
  rule: ContractRule;
  /** A sentence that says what is wrong. */
  message: string;
};

/** The value of a header as an HTTP library holds it. `undefined` counts as absent. */
export type HeaderValue = string | number | readonly string[] | undefined;

/** A request as a check point sees it. */
export type ContractRequest = {
  /** The method as sent, such as `GET`. */
  method: string;
  /** The path with the query as sent, without the origin: `/v2/rooms?limit=50`. */
  path: string;
  /**
   * The headers of the request by name in any case, or `undefined` when the check point sees no
   * header. Without headers the check skips the header rules.
   */
  headers: Readonly<Record<string, HeaderValue>> | undefined;
  /**
   * The names of the headers that the check point cannot see although it sees others, in any
   * case, for example `authorization` where a platform adds it after the check point. The check
   * skips the rules of these headers.
   */
  unseenHeaders?: readonly string[];
  /** The body text; `undefined` or the empty text when the request has none. */
  body: string | undefined;
};

/** The check of one request: every problem that it finds, or an empty list. */
export type ContractCheck = (request: ContractRequest) => ContractProblem[];

type JsonObject = { [key: string]: unknown };

/** A segment of a path template: a literal text, or the name of a path parameter. */
type Segment = { text: string; parameter: boolean };

/** A path or query parameter and the type that its text converts to. */
type Parameter = {
  required: boolean;
  schema: JsonObject;
  /** `string`, `integer` or `array`. */
  type: string;
  /** The type of the items of an array parameter: `string` or `integer`. */
  itemType: string | undefined;
};

type Operation = {
  id: string;
  pathParameters: Map<string, Parameter>;
  queryParameters: Map<string, Parameter>;
  needsAuthorization: boolean;
  body: { required: boolean; schema: JsonObject } | undefined;
};

type PathTemplate = {
  template: string;
  segments: Segment[];
  /** One character per segment, 0 for a literal and 1 for a parameter: the lower sorts first. */
  specificity: string;
  /** The operations of the template by upper-case method. */
  operations: Map<string, Operation>;
};

type Contract = { paths: PathTemplate[]; references: Map<string, JsonObject> };

/** The state of reading the spec: the resolved references and the schemas already read. */
type Reader = { spec: JsonObject; references: Map<string, JsonObject>; seen: Set<JsonObject> };

const HTTP_METHODS = ['delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'trace'];
const PATH_ITEM_TEXTS = ['description', 'summary'];
const PARAMETER_KEYS = [
  'deprecated',
  'description',
  'example',
  'examples',
  'explode',
  'in',
  'name',
  'required',
  'schema',
];
const REQUEST_BODY_KEYS = ['content', 'description', 'required'];
const MEDIA_TYPE_KEYS = ['example', 'examples', 'schema'];
const SCHEMA_KEYWORDS = [
  '$ref',
  'additionalProperties',
  'enum',
  'format',
  'items',
  'maxLength',
  'maximum',
  'minItems',
  'minLength',
  'minimum',
  'properties',
  'required',
  'type',
];
/** Keywords that describe a value without a rule for it. */
const SCHEMA_ANNOTATIONS = [
  '$comment',
  'default',
  'deprecated',
  'description',
  'examples',
  'title',
];
const TYPES = ['array', 'boolean', 'integer', 'null', 'number', 'object', 'string'];
const FORMATS = ['date-time', 'email', 'int32', 'int64'];
/** The types that a path or query value converts to from text. */
const TEXT_TYPES = ['integer', 'string'];

const INT32_RANGE: [number, number] = [-(2 ** 31), 2 ** 31 - 1];
/** A JavaScript number cannot hold 2^63 - 1 exactly, so the upper bound is 2^63. */
const INT64_RANGE: [number, number] = [-(2 ** 63), 2 ** 63];

/**
 * An RFC 3339 date-time as the API accepts it: an upper-case T and Z, a fraction after a dot or a
 * comma, and an offset of at most 24 hours and 60 minutes. `isDateTime` checks the ranges.
 */
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:[.,]\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** An atom of RFC 5322, with any character outside ASCII as RFC 6532 allows. */
const ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~\\u{80}-\\u{10FFFF}-]+";
const DOT_ATOM = `${ATOM}(?:\\.${ATOM})*`;
const IPV4_PART = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
/**
 * An email address in the form that the contract check accepts: one addr-spec of RFC 5322 that is
 * the whole value, apart from spaces and tabs around it. That is a dot-atom, an `@`, and a
 * dot-atom or an IPv4 address in brackets. The API can accept forms that this check refuses, such
 * as an IPv6 address in brackets.
 */
const EMAIL_ADDRESS = new RegExp(
  `^${DOT_ATOM}@(?:${DOT_ATOM}|\\[${IPV4_PART}(?:\\.${IPV4_PART}){3}\\])$`,
  'u',
);
/**
 * White space outside ASCII. The API refuses an address that starts or ends with such a character,
 * although ATOM accepts it.
 */
const WIDE_SPACE = '[\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const EDGE_SPACE = new RegExp(`^${WIDE_SPACE}|${WIDE_SPACE}$`);
const INTEGER_TEXT = /^-?\d+$/;
/** The word `Bearer` alone or before white space, also after white space. */
const BEARER_PREFIX = /^\s*bearer(?:\s|$)/i;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function has(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function unsupported(detail: string): Error {
  return new Error(`The contract check does not support the spec: ${detail}.`);
}

/** Returns the types of a schema: its `type` as a list, empty when it has none. */
function typeList(schema: JsonObject): string[] {
  if (typeof schema.type === 'string') return [schema.type];
  return Array.isArray(schema.type) ? (schema.type as string[]) : [];
}

// Reading the spec

/** Returns the schema that the local reference `reference` points to. */
function resolveReference(reader: Reader, reference: string): JsonObject {
  const known = reader.references.get(reference);
  if (known !== undefined) return known;
  if (!reference.startsWith('#/')) throw unsupported(`the reference ${reference} is not local`);
  let target: unknown = reader.spec;
  for (const token of reference.slice(2).split('/')) {
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    target = isObject(target) && has(target, key) ? target[key] : undefined;
  }
  if (!isObject(target)) throw unsupported(`the reference ${reference} points to no schema`);
  reader.references.set(reference, target);
  return target;
}

/** Checks that `schema` and every schema that it reaches use only the supported subset. */
function readSchema(reader: Reader, schema: unknown, where: string): JsonObject {
  if (!isObject(schema)) throw unsupported(`${where} is not a schema object`);
  if (reader.seen.has(schema)) return schema;
  reader.seen.add(schema);
  for (const keyword of Object.keys(schema)) {
    if (!SCHEMA_KEYWORDS.includes(keyword) && !SCHEMA_ANNOTATIONS.includes(keyword)) {
      throw unsupported(`${where} uses the keyword ${keyword}`);
    }
  }
  if (typeof schema.$ref === 'string') {
    readSchema(reader, resolveReference(reader, schema.$ref), schema.$ref);
  }
  for (const type of typeList(schema)) {
    if (!TYPES.includes(type)) throw unsupported(`${where} has the type ${String(type)}`);
  }
  if (schema.format !== undefined && !FORMATS.includes(schema.format as string)) {
    throw unsupported(`${where} has the format ${String(schema.format)}`);
  }
  if (isObject(schema.properties)) {
    for (const [name, property] of Object.entries(schema.properties)) {
      readSchema(reader, property, `${where}.${name}`);
    }
  }
  if (schema.items !== undefined) readSchema(reader, schema.items, `${where}[]`);
  if (isObject(schema.additionalProperties)) {
    readSchema(reader, schema.additionalProperties, `${where}{}`);
  }
  return schema;
}

/** Returns the one type besides `null` that a path or query value of `schema` converts to. */
function textType(reader: Reader, schema: unknown, where: string, allowed: string[]): string {
  const target =
    isObject(schema) && typeof schema.$ref === 'string'
      ? reader.references.get(schema.$ref)
      : schema;
  const types = isObject(target) ? typeList(target).filter((type) => type !== 'null') : [];
  const type = types.length === 1 ? types[0]! : '';
  if (!allowed.includes(type)) {
    throw unsupported(
      `${where} must have one type of ${allowed.join(', ')} besides null, not ${JSON.stringify(types)}`,
    );
  }
  return type;
}

/** Reads a path or query parameter of the operation `id`, whose keys are checked already. */
function readParameter(reader: Reader, id: string, parameter: JsonObject): Parameter {
  const where = `${id}, the ${String(parameter.in)} parameter ${String(parameter.name)}`;
  const schema = readSchema(reader, parameter.schema, where);
  const type = textType(reader, schema, where, ['array', ...TEXT_TYPES]);
  let itemType: string | undefined;
  if (type === 'array') {
    if (parameter.in !== 'query' || parameter.explode !== false) {
      throw unsupported(`${where} is an array outside the query or without explode: false`);
    }
    const target = typeof schema.$ref === 'string' ? reader.references.get(schema.$ref)! : schema;
    itemType = textType(reader, target.items, `${where}[]`, TEXT_TYPES);
  }
  return { required: parameter.required === true, schema, type, itemType };
}

function readRequestBody(reader: Reader, id: string, value: unknown): Operation['body'] {
  const requestBody = value as JsonObject;
  for (const key of Object.keys(requestBody)) {
    if (!REQUEST_BODY_KEYS.includes(key)) {
      throw unsupported(`${id}, the request body has the key ${key}`);
    }
  }
  const content = requestBody.content as JsonObject;
  const mediaTypes = Object.keys(content).join(', ');
  if (mediaTypes !== 'application/json') {
    throw unsupported(
      `${id}, the request body has the media types ${mediaTypes}, not application/json alone`,
    );
  }
  const mediaType = content['application/json'] as JsonObject;
  for (const key of Object.keys(mediaType)) {
    if (!MEDIA_TYPE_KEYS.includes(key)) {
      throw unsupported(`${id}, the request body has the key ${key}`);
    }
  }
  return {
    required: requestBody.required === true,
    schema: readSchema(reader, mediaType.schema, `${id}, the request body`),
  };
}

/**
 * Returns whether the security requirement of an operation, else that of the spec, needs the
 * token: a requirement that names a scheme of the type `http`, which the API reads from the
 * Authorization header. A requirement that makes the token optional (`{}`), or a scheme of another
 * type, throws: it is outside the subset.
 */
function securityNeedsToken(reader: Reader, id: string, operation: JsonObject): boolean {
  const requirements = has(operation, 'security') ? operation.security : reader.spec.security;
  if (requirements === undefined) return false;
  if (!Array.isArray(requirements)) throw unsupported(`${id} has a security that is no list`);
  const components = isObject(reader.spec.components) ? reader.spec.components : {};
  const schemes = isObject(components.securitySchemes) ? components.securitySchemes : {};
  let needsToken = false;
  for (const requirement of requirements as unknown[]) {
    const names = isObject(requirement) ? Object.keys(requirement) : [];
    if (names.length === 0) throw unsupported(`${id} has a security requirement without a scheme`);
    for (const name of names) {
      const scheme = schemes[name];
      if (!isObject(scheme) || scheme.type !== 'http') {
        throw unsupported(`${id} has the security scheme ${name}, which is not of the type http`);
      }
      needsToken = true;
    }
  }
  return needsToken;
}

function readOperation(
  reader: Reader,
  template: string,
  method: string,
  value: unknown,
): Operation {
  const operation = value as JsonObject;
  const id =
    typeof operation.operationId === 'string' ? operation.operationId : `${method} ${template}`;
  const pathParameters = new Map<string, Parameter>();
  const queryParameters = new Map<string, Parameter>();
  let needsAuthorization = securityNeedsToken(reader, id, operation);
  for (const parameter of (operation.parameters ?? []) as JsonObject[]) {
    for (const key of Object.keys(parameter)) {
      if (!PARAMETER_KEYS.includes(key)) {
        throw unsupported(`${id} has a parameter with the key ${key}`);
      }
    }
    const name = String(parameter.name);
    if (parameter.in === 'header' && name.toLowerCase() === 'authorization') {
      needsAuthorization = true;
    } else if (parameter.in === 'path' || parameter.in === 'query') {
      const read = readParameter(reader, id, parameter);
      (parameter.in === 'path' ? pathParameters : queryParameters).set(name, read);
    } else {
      throw unsupported(`${id} has the ${String(parameter.in)} parameter ${name}`);
    }
  }
  return {
    id,
    pathParameters,
    queryParameters,
    needsAuthorization,
    body:
      operation.requestBody === undefined
        ? undefined
        : readRequestBody(reader, id, operation.requestBody),
  };
}

function readContract(spec: unknown): Contract {
  if (!isObject(spec) || !isObject(spec.paths)) {
    throw new TypeError('The spec must be a parsed OpenAPI document with paths.');
  }
  const reader: Reader = { spec, references: new Map(), seen: new Set() };
  const paths: PathTemplate[] = [];
  for (const [template, value] of Object.entries(spec.paths)) {
    const item = value as JsonObject;
    const operations = new Map<string, Operation>();
    for (const key of Object.keys(item)) {
      if (HTTP_METHODS.includes(key)) {
        const method = key.toUpperCase();
        operations.set(method, readOperation(reader, template, method, item[key]));
      } else if (!PATH_ITEM_TEXTS.includes(key)) {
        throw unsupported(`the path ${template} has the key ${key}`);
      }
    }
    const segments = template.split('/').map((text) => {
      const parameter = /^\{[^{}]+\}$/.test(text);
      return { text: parameter ? text.slice(1, -1) : text, parameter };
    });
    const specificity = segments.map((segment) => (segment.parameter ? '1' : '0')).join('');
    paths.push({ template, segments, specificity, operations });
  }
  return { paths, references: reader.references };
}

// Checking a value against a schema

function shown(value: unknown): string {
  if (Array.isArray(value)) return 'an array';
  if (isObject(value)) return 'an object';
  return JSON.stringify(value);
}

function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'string':
      return typeof value === 'string';
    case 'array':
      return Array.isArray(value);
    default:
      return isObject(value);
  }
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isDateTime(text: string): boolean {
  const match = DATE_TIME.exec(text);
  if (match === null) return false;
  const part = (index: number) => Number(match[index] ?? 0);
  return (
    part(2) >= 1 &&
    part(2) <= 12 &&
    part(3) >= 1 &&
    part(3) <= daysInMonth(part(1), part(2)) &&
    part(4) <= 23 &&
    part(5) <= 59 &&
    part(6) <= 59 &&
    part(7) <= 24 &&
    part(8) <= 60
  );
}

function isEmailAddress(text: string): boolean {
  const address = text.replace(/^[ \t]+|[ \t]+$/g, '');
  return EMAIL_ADDRESS.test(address) && !EDGE_SPACE.test(address);
}

function numberProblems(
  schema: JsonObject,
  value: number,
  where: string,
  problems: string[],
): void {
  if (typeof schema.minimum === 'number' && value < schema.minimum) {
    problems.push(`${where} is ${value}, less than the minimum ${schema.minimum}.`);
  }
  if (typeof schema.maximum === 'number' && value > schema.maximum) {
    problems.push(`${where} is ${value}, more than the maximum ${schema.maximum}.`);
  }
  const range =
    schema.format === 'int32' ? INT32_RANGE : schema.format === 'int64' ? INT64_RANGE : undefined;
  if (range !== undefined && (value < range[0] || value > range[1])) {
    problems.push(`${where} is ${value}, outside the range of ${schema.format as string}.`);
  }
}

function stringProblems(
  schema: JsonObject,
  value: string,
  where: string,
  problems: string[],
): void {
  if (schema.format === 'date-time' && !isDateTime(value)) {
    problems.push(`${where} is ${JSON.stringify(value)}, not an RFC 3339 date-time.`);
  } else if (schema.format === 'email' && !isEmailAddress(value)) {
    problems.push(`${where} is ${JSON.stringify(value)}, not an email address.`);
  }
  // The API counts code points, so a character outside the BMP counts once.
  const length = [...value].length;
  if (typeof schema.minLength === 'number' && length < schema.minLength) {
    problems.push(`${where} has ${length} characters, fewer than the minimum ${schema.minLength}.`);
  }
  if (typeof schema.maxLength === 'number' && length > schema.maxLength) {
    problems.push(`${where} has ${length} characters, more than the maximum ${schema.maxLength}.`);
  }
}

/** Adds to `problems` every way in which `value` does not fit `schema`. */
function checkValue(
  contract: Contract,
  schema: JsonObject,
  value: unknown,
  where: string,
  problems: string[],
): void {
  if (typeof schema.$ref === 'string') {
    checkValue(contract, contract.references.get(schema.$ref)!, value, where, problems);
  }
  const types = typeList(schema);
  if (types.length > 0 && !types.some((type) => hasType(value, type))) {
    problems.push(`${where} is ${shown(value)}, but the schema allows ${types.join(' or ')}.`);
    return;
  }
  const nullAllowed = value === null && types.includes('null');
  if (Array.isArray(schema.enum) && !nullAllowed && !schema.enum.includes(value)) {
    const entries = schema.enum.map((entry) => JSON.stringify(entry)).join(', ');
    problems.push(`${where} is ${shown(value)}, not one of ${entries}.`);
  }
  if (typeof value === 'number') {
    numberProblems(schema, value, where, problems);
  } else if (typeof value === 'string') {
    stringProblems(schema, value, where, problems);
  } else if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      problems.push(
        `${where} has ${value.length} items, fewer than the minimum ${schema.minItems}.`,
      );
    }
    const items = schema.items;
    if (isObject(items)) {
      value.forEach((item, index) =>
        checkValue(contract, items, item, `${where}[${index}]`, problems),
      );
    }
  } else if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const additional = schema.additionalProperties;
    for (const name of (schema.required ?? []) as string[]) {
      if (!has(value, name)) problems.push(`${where} lacks the required property ${name}.`);
    }
    for (const [name, property] of Object.entries(value)) {
      if (has(properties, name)) {
        checkValue(
          contract,
          properties[name] as JsonObject,
          property,
          `${where}.${name}`,
          problems,
        );
      } else if (additional === false) {
        problems.push(`${where} has the property ${name}, which the schema does not allow.`);
      } else if (isObject(additional)) {
        checkValue(contract, additional, property, `${where}.${name}`, problems);
      }
    }
  }
}

function valueProblems(
  contract: Contract,
  schema: JsonObject,
  value: unknown,
  where: string,
): string[] {
  const problems: string[] = [];
  checkValue(contract, schema, value, where, problems);
  return problems;
}

/** Returns the value of a path or query text: a number for an integer text, a list for an array. */
function parameterValue(parameter: Parameter, text: string): unknown {
  const convert = (type: string, part: string) =>
    type === 'integer' && INTEGER_TEXT.test(part) ? Number(part) : part;
  return parameter.itemType === undefined
    ? convert(parameter.type, text)
    : text.split(',').map((part) => convert(parameter.itemType!, part));
}

// Checking a request

function decodeText(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

type Match = { operation: Operation; values: Map<string, string> } | { problem: string };

/** Finds the most specific path template that matches `path`, then its operation of `method`. */
function findOperation(contract: Contract, method: string, path: string): Match {
  const rawSegments = path.split('/');
  const segments: string[] = [];
  for (const raw of rawSegments) {
    const decoded = decodeText(raw);
    if (decoded === undefined) {
      return { problem: `The path segment ${raw} is not valid percent-encoding.` };
    }
    segments.push(decoded);
  }
  let best: { path: PathTemplate; values: Map<string, string> } | undefined;
  for (const candidate of contract.paths) {
    if (candidate.segments.length !== segments.length) continue;
    const values = new Map<string, string>();
    const matches = candidate.segments.every((segment, index) => {
      const text = segments[index]!;
      if (!segment.parameter) return segment.text === text;
      values.set(segment.text, text);
      return text !== '';
    });
    if (matches && (best === undefined || candidate.specificity < best.path.specificity)) {
      best = { path: candidate, values };
    }
  }
  if (best === undefined) return { problem: `No path of the spec matches ${path}.` };
  const operation = best.path.operations.get(method);
  if (operation === undefined) {
    const methods = [...best.path.operations.keys()].join(', ');
    const template = best.path.template;
    return {
      problem: `The path matches ${template}, which has no ${method} operation, only ${methods}.`,
    };
  }
  return { operation, values: best.values };
}

function pathProblems(
  contract: Contract,
  operation: Operation,
  values: Map<string, string>,
): string[] {
  const problems: string[] = [];
  for (const [name, text] of values) {
    const parameter = operation.pathParameters.get(name);
    if (parameter !== undefined) {
      problems.push(
        ...valueProblems(
          contract,
          parameter.schema,
          parameterValue(parameter, text),
          `path parameter ${name}`,
        ),
      );
    }
  }
  return problems;
}

function queryProblems(contract: Contract, operation: Operation, query: string): string[] {
  const problems: string[] = [];
  const texts = new Map<string, string[]>();
  for (const part of query.split('&')) {
    if (part === '') continue;
    const equals = part.indexOf('=');
    const name = decodeText((equals === -1 ? part : part.slice(0, equals)).replace(/\+/g, ' '));
    const text = decodeText((equals === -1 ? '' : part.slice(equals + 1)).replace(/\+/g, ' '));
    if (name === undefined || text === undefined) {
      problems.push(`The query part ${part} is not valid percent-encoding.`);
      continue;
    }
    texts.set(name, [...(texts.get(name) ?? []), text]);
  }
  for (const [name, values] of texts) {
    const parameter = operation.queryParameters.get(name);
    if (parameter === undefined) {
      problems.push(`The operation has no query parameter ${name}.`);
    } else if (values.length > 1) {
      problems.push(
        `The query parameter ${name} appears ${values.length} times, but the operation takes one value.`,
      );
    } else if (values[0] === '') {
      // The API reads an empty value as absent. The loop below reports a required parameter.
      if (!parameter.required) {
        problems.push(`The query parameter ${name} is empty, so the API ignores it.`);
      }
    } else {
      const value = parameterValue(parameter, values[0]!);
      problems.push(...valueProblems(contract, parameter.schema, value, `query parameter ${name}`));
    }
  }
  for (const [name, parameter] of operation.queryParameters) {
    const values = texts.get(name) ?? [];
    if (parameter.required && values.every((value) => value === '')) {
      problems.push(`The required query parameter ${name} is missing.`);
    }
  }
  return problems;
}

/**
 * Returns the text of the header `name` (lower case), with several values joined, or `undefined`
 * when the request does not send it.
 */
function headerText(
  headers: Readonly<Record<string, HeaderValue>>,
  name: string,
): string | undefined {
  const texts: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name || value === undefined) continue;
    if (typeof value === 'string') texts.push(value);
    else if (typeof value === 'number') texts.push(String(value));
    else texts.push(...value);
  }
  return texts.length === 0 ? undefined : texts.join(', ');
}

function hasBody(body: string | undefined): body is string {
  return body !== undefined && body !== '';
}

function headerProblems(operation: Operation, request: ContractRequest): string[] {
  const headers = request.headers;
  if (headers === undefined) return [];
  const unseen = (request.unseenHeaders ?? []).map((name) => name.toLowerCase());
  const problems: string[] = [];
  if (hasBody(request.body) && !unseen.includes('content-type')) {
    const contentType = headerText(headers, 'content-type');
    if (contentType === undefined) {
      problems.push(
        'The request has a body but no Content-Type header. The API needs application/json.',
      );
    } else if (contentType.split(';')[0]!.trim().toLowerCase() !== 'application/json') {
      problems.push(
        `The request has a body with the Content-Type ${contentType}. The API needs application/json.`,
      );
    }
  }
  if (!unseen.includes('authorization')) {
    const authorization = headerText(headers, 'authorization');
    if (!operation.needsAuthorization) {
      if (authorization !== undefined) {
        problems.push('The operation takes no Authorization header, but the request sends one.');
      }
    } else if (authorization === undefined) {
      problems.push('The Authorization header is missing.');
    } else if (authorization.trim() === '') {
      problems.push('The Authorization header is empty.');
    } else if (BEARER_PREFIX.test(authorization)) {
      problems.push('The Authorization header starts with Bearer. The integrations send the raw token.');
    }
  }
  return problems;
}

function parseJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

function bodyProblems(
  contract: Contract,
  operation: Operation,
  body: string | undefined,
): string[] {
  const declared = operation.body;
  if (declared === undefined) {
    return hasBody(body) ? ['The operation takes no body, but the request has one.'] : [];
  }
  if (!hasBody(body)) {
    return declared.required ? ['The operation requires a body, but the request has none.'] : [];
  }
  const parsed = parseJson(body);
  if (parsed === undefined) return ['The body is not valid JSON.'];
  return valueProblems(contract, declared.schema, parsed.value, 'body');
}

function checkRequest(contract: Contract, request: ContractRequest): ContractProblem[] {
  const queryStart = request.path.indexOf('?');
  const path = queryStart === -1 ? request.path : request.path.slice(0, queryStart);
  const query = queryStart === -1 ? '' : request.path.slice(queryStart + 1);
  const match = findOperation(contract, request.method, path);
  if ('problem' in match) {
    return [{ operation: undefined, rule: 'operation', message: match.problem }];
  }

  const { operation } = match;
  const problems: ContractProblem[] = [];
  const add = (rule: ContractRule, messages: string[]) => {
    for (const message of messages) problems.push({ operation: operation.id, rule, message });
  };
  add('operation', pathProblems(contract, operation, match.values));
  add('query', queryProblems(contract, operation, query));
  add('headers', headerProblems(operation, request));
  add('body', bodyProblems(contract, operation, request.body));
  return problems;
}

/**
 * Reads the parsed spec once and returns the check of one request. A check point creates the
 * check once, when its test helper loads, and calls it for every request that its mock receives.
 *
 * The request side of the spec uses a small subset of JSON Schema: `type` (also as a list),
 * `properties`, `required`, `additionalProperties`, `enum`, `items`, `minItems`, `minimum` and
 * `maximum` (on numbers only, as JSON Schema says), `minLength` and `maxLength` (on strings only,
 * counted in code points, as the API counts them), `format` (date-time, email, int32, int64) and
 * local `$ref`, plus annotations such as `description`. Where the API differs from JSON Schema,
 * the check follows the API: `null` passes an `enum` without `null` when the type allows `null`,
 * and a date-time is checked as the API reads it. An email address is checked in the form of
 * EMAIL_ADDRESS.
 *
 * Throws when the request side of the spec uses a keyword or a form outside this subset, so that a
 * new keyword in the spec fails loudly instead of letting requests pass unchecked. Throws a
 * TypeError when `spec` is not a parsed OpenAPI document with paths.
 */
export function createContractCheck(spec: unknown): ContractCheck {
  const contract = readContract(spec);
  return (request) => checkRequest(contract, request);
}
