/**
 * The rules of the polling triggers that list resources by creation time. Every page is read
 * anyway, so the rules only decide which of the listed items a poll can return.
 */

/** The window in which a poll can return every created item, without a count cap. */
export const NEW_ITEM_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The number of newest items that a sample load or a manual run returns, whatever their age. */
export const SAMPLE_ITEM_COUNT = 3;

type Timestamped = { id: string; createdAt: string | null };

function createdAtMs(item: Timestamped): number | undefined {
  if (item.createdAt === null) return undefined;
  const time = Date.parse(item.createdAt);
  return Number.isNaN(time) ? undefined : time;
}

/** Sorts newest `createdAt` first. Items without a creation time go last. Ties sort by `id`. */
export function newestFirst(left: Timestamped, right: Timestamped): number {
  const leftTime = createdAtMs(left);
  const rightTime = createdAtMs(right);
  if (leftTime !== rightTime) {
    if (leftTime === undefined) return 1;
    if (rightTime === undefined) return -1;
    return rightTime - leftTime;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Returns the items created within NEW_ITEM_WINDOW_MS before `now`, newest first. */
export function recentItems<T extends Timestamped>(items: readonly T[], now: number): T[] {
  const oldestIncluded = now - NEW_ITEM_WINDOW_MS;
  return [...items].sort(newestFirst).filter((item) => {
    const time = createdAtMs(item);
    return time !== undefined && time >= oldestIncluded;
  });
}

/** Returns the newest `count` items, whatever their age. */
export function newestItems<T extends Timestamped>(items: readonly T[], count: number): T[] {
  return [...items].sort(newestFirst).slice(0, count);
}
