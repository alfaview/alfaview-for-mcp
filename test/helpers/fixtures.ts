// Reads the fixtures of alfaview answers in test/fixtures/.
import { readFileSync } from 'node:fs';

/** Returns a fresh copy of `test/fixtures/<path>` on every call, so that a test can change it. */
export function fixture<T = any>(path: string): T {
  return JSON.parse(readFileSync(new URL(`../fixtures/${path}`, import.meta.url), 'utf8')) as T;
}
