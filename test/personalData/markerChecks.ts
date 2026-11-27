// The checks of the marker test of the option Personal data, which compares each result with Leave
// out against the same result with Include.
import assert from 'node:assert/strict';
import { PERSONAL_KEYS } from '../../src/shared/personalData.ts';
import type { ToolPersonalData } from '../../src/tools/tool.ts';

/** Returns whether the JSON text of `value`, in lower case, holds `marker`. */
export function holds(value: unknown, marker: string): boolean {
  return JSON.stringify(value).toLowerCase().includes(marker);
}

/**
 * Returns the paths of a tool's data that Leave out sets to null, in the form of PERSONAL_KEYS
 * (`invitees[].emailAddress`): the paths of the shape, under its list when the tool names one, and
 * each path of `meetingRoomName`, which holds the name of a meeting room.
 */
export function removedPaths(
  personalData: ToolPersonalData,
  meetingRoomName: readonly string[] = [],
): string[] {
  const prefix = personalData.list === undefined ? '' : `${personalData.list}[].`;
  const paths: readonly string[] = PERSONAL_KEYS[personalData.shape];
  return [...paths.map((path) => `${prefix}${path}`), ...meetingRoomName];
}

/** Returns whether `keys` lies at or under one of `paths`. */
export function isUnder(keys: string, paths: readonly string[]): boolean {
  return paths.some(
    (path) => keys === path || keys.startsWith(`${path}[]`) || keys.startsWith(`${path}.`),
  );
}

export type Leaf = { keys: string; value: unknown };

/**
 * Returns every value of `value` that is no list and no object, with its keys in the form of
 * PERSONAL_KEYS: the index of a list is `[]`.
 */
export function leavesOf(value: unknown, keys = ''): Leaf[] {
  if (Array.isArray(value)) return value.flatMap((entry) => leavesOf(entry, `${keys}[]`));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) =>
      leavesOf(entry, keys === '' ? key : `${keys}.${key}`),
    );
  }
  return [{ keys, value }];
}

/**
 * Checks `omit`, the data with Leave out, against `include`, the same data with Include: every key
 * stays in its place, every value at or under `paths` is null, and every other value is the one
 * of Include. So the check also fails when Leave out removes too much.
 */
export function expectRemoved(
  include: unknown,
  omit: unknown,
  paths: readonly string[],
  keys = '',
): void {
  if (keys !== '' && isUnder(keys, paths)) {
    assert.equal(omit, null, `${keys} is null with Leave out`);
    return;
  }
  if (Array.isArray(include)) {
    assert.ok(Array.isArray(omit), `${keys} stays a list`);
    assert.equal(omit.length, include.length, `${keys} keeps its length`);
    include.forEach((entry, index) => expectRemoved(entry, omit[index], paths, `${keys}[]`));
    return;
  }
  if (typeof include === 'object' && include !== null) {
    assert.ok(typeof omit === 'object' && omit !== null, `${keys} stays an object`);
    assert.deepEqual(Object.keys(omit), Object.keys(include), `${keys} keeps its keys`);
    for (const [key, entry] of Object.entries(include)) {
      expectRemoved(entry, (omit as Record<string, unknown>)[key], paths, keys === '' ? key : `${keys}.${key}`);
    }
    return;
  }
  assert.equal(omit, include, `${keys} is the value of Include`);
}
