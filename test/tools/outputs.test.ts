// The output schemas of the tools: the open form that the server advertises and checks, its JSON
// Schema, and the path of a key that does not fit.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as z from 'zod';
import {
  advertisedOutput,
  openOutput,
  outputProblem,
  slimOutputJson,
  toolOutput,
} from '../../src/tools/outputs.ts';

/** A shape with each kind of value that the tools use. */
const shape = toolOutput({
  id: z.string(),
  count: z.int(),
  next: z.int().nullable(),
  note: z.string().nullable(),
  link: z.string().nullable().optional(),
  status: z.enum(['created', 'failed']),
  features: z.partialRecord(z.enum(['a', 'b']), z.string()),
  quotas: z.strictObject({ limit: z.int().nullable() }).nullable(),
  emails: z.array(z.string()).nullable(),
  items: z.array(z.strictObject({ id: z.string(), done: z.boolean() })),
});

const data = {
  id: 'r-1',
  count: 2,
  next: null,
  note: 'a note',
  status: 'created',
  features: { a: 'enabled' },
  quotas: { limit: 5 },
  emails: null,
  items: [{ id: 'i-1', done: true }],
  warnings: [],
};

describe('the output schemas', () => {
  it('take the data of a tool in the strict shape and in the open form', () => {
    assert.equal(shape.safeParse(data).success, true);
    assert.equal(openOutput(shape).safeParse(data).success, true);
  });

  // The strict shape runs in the tests. The open form keeps a rare extra key from breaking a call
  // whose write alfaview already did.
  it('allow other keys, other enum values and other record keys only in the open form', () => {
    const others = {
      ...data,
      extra: 1,
      status: 'later',
      features: { c: 'enabled' },
      quotas: { limit: 5, extra: true },
      items: [{ id: 'i-1', done: true, extra: 'x' }],
    };
    assert.equal(shape.safeParse(others).success, false);
    assert.equal(openOutput(shape).safeParse(others).success, true);
    assert.equal(outputProblem(shape, others), undefined);
  });

  // An int64 of alfaview above Number.MAX_SAFE_INTEGER passes the mappers and the advertised
  // { "type": "integer" }, so the check of the server takes it too.
  it('take an integer above the safe range in the open form, as the advertised schema does', async () => {
    const big = { ...data, count: 2 ** 53 + 2, next: 2 ** 60, quotas: { limit: 9223372036854775807 } };
    assert.equal(z.int().safeParse(2 ** 53 + 2).success, false);
    assert.equal(outputProblem(shape, big), undefined);
    const checked = await advertisedOutput(shape)['~standard'].validate(big);
    assert.equal('issues' in checked && checked.issues !== undefined, false);
    assert.equal(outputProblem(shape, { ...data, next: 0.5 }), 'next');
    assert.equal(outputProblem(shape, { ...data, count: '2' }), 'count');
  });

  it('give the path of the first key that does not fit, in the form of PERSONAL_KEYS', () => {
    assert.equal(outputProblem(shape, data), undefined);
    assert.equal(outputProblem(shape, { ...data, count: 1.5 }), 'count');
    assert.equal(outputProblem(shape, { ...data, items: [{ id: 7, done: true }] }), 'items[].id');
    assert.equal(outputProblem(shape, { ...data, quotas: { limit: 'many' } }), 'quotas.limit');
    const { id: _id, ...withoutId } = data;
    assert.equal(outputProblem(shape, withoutId), 'id');
  });

  it('advertise JSON Schema 2020-12 without $schema, descriptions and the keywords that allow anything', () => {
    const json = advertisedOutput(shape)['~standard'].jsonSchema.output({ target: 'draft-2020-12' });

    assert.deepEqual(json, {
      type: 'object',
      properties: {
        id: { type: 'string' },
        count: { type: 'integer' },
        next: { type: ['integer', 'null'] },
        note: { type: ['string', 'null'] },
        link: { type: ['string', 'null'] },
        status: { type: 'string' },
        features: { type: 'object', additionalProperties: { type: 'string' } },
        quotas: {
          type: ['object', 'null'],
          properties: { limit: { type: ['integer', 'null'] } },
          required: ['limit'],
        },
        emails: { type: ['array', 'null'], items: { type: 'string' } },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, done: { type: 'boolean' } },
            required: ['id', 'done'],
          },
        },
        warnings: { type: 'array', items: { type: 'string' } },
      },
      required: ['id', 'count', 'next', 'note', 'status', 'features', 'quotas', 'emails', 'items', 'warnings'],
    });
    assert.deepEqual(json, advertisedOutput(shape)['~standard'].jsonSchema.input({ target: 'draft-2020-12' }));
  });

  it('check a result with the open form, and make the forms of a shape once', async () => {
    const advertised = advertisedOutput(shape);
    const fits = await advertised['~standard'].validate({ ...data, extra: 1 });
    const fails = await advertised['~standard'].validate({ ...data, count: 'two' });

    assert.equal(advertised, advertisedOutput(shape));
    assert.equal(advertised['~standard'].vendor, 'zod');
    assert.equal('issues' in fits && fits.issues !== undefined, false);
    assert.deepEqual(
      (fails as unknown as { issues: { path: unknown[] }[] }).issues.map((issue) => issue.path),
      [['count']],
    );
  });

  it('keep a list of types only for a nullable schema whose keys apply to one type', () => {
    // A constant applies to null too, so a nullable constant keeps its anyOf.
    const constant = { anyOf: [{ type: 'boolean', const: true }, { type: 'null' }] };
    const union = { anyOf: [{ type: 'integer' }, { type: 'string' }] };
    const three = { anyOf: [{ type: 'integer' }, { type: 'null' }, { type: 'string' }] };
    const described = { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'A count.' };
    const nullWithMore = { anyOf: [{ type: 'integer' }, { type: 'null', title: 'None' }] };
    const types = { anyOf: [{ type: ['integer', 'string'] }, { type: 'null' }] };
    for (const schema of [constant, union, three, described, nullWithMore, types]) {
      assert.deepEqual(slimOutputJson(schema), schema);
    }
    assert.deepEqual(slimOutputJson({ anyOf: [{ type: 'integer' }, { type: 'null' }] }), {
      type: ['integer', 'null'],
    });
  });

  it('keep the bounds and keywords that limit a value', () => {
    const schema = {
      type: 'object',
      properties: { count: { type: 'integer', minimum: 0, maximum: 10 } },
      propertyNames: { type: 'string', pattern: '^[a-z]+$' },
      additionalProperties: false,
    };
    assert.deepEqual(slimOutputJson(schema), schema);
  });
});
