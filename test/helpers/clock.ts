// A clock that a test moves by hand, for code that takes the time from a `now` function.

export type TestClock = { now: () => number; advance(milliseconds: number): void };

export function testClock(start: number | string = '2026-10-07T08:00:00Z'): TestClock {
  let current = typeof start === 'string' ? Date.parse(start) : start;
  return {
    now: () => current,
    advance(milliseconds) {
      current += milliseconds;
    },
  };
}
