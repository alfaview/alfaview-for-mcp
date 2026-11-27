/** Byte 10 of the userId of a guest, as two hex digits. */
const GUEST_KIND = '18';

/** Canonical hyphenated UUID, hex digits in any case. */
const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** String index of the version nibble (byte 6, high nibble). */
const VERSION_INDEX = 14;
/** String index of the variant nibble (byte 8, high nibble). */
const VARIANT_INDEX = 19;
/** String index of byte 10: the first two characters of the last group. */
const KIND_INDEX = 24;

/**
 * Returns whether `id` has the layout of the userId that alfaview gives a guest: a version 5 UUID
 * with the IETF variant and the kind 24 (0x18) in byte 10.
 *
 * The layout is observed, not part of the API docs, so a guest ID of another layout gives `false`.
 * Use the check only where such a miss loses no guest. To match a guest to a guest link, use the
 * userId that alfaview returns with the link (spec: GuestLink.userId).
 */
export function isGuestUserId(id: string): boolean {
  if (typeof id !== 'string' || !UUID_FORMAT.test(id)) {
    return false;
  }
  const lower = id.toLowerCase();
  return (
    lower[VERSION_INDEX] === '5' &&
    '89ab'.includes(lower[VARIANT_INDEX] ?? '') &&
    lower.slice(KIND_INDEX, KIND_INDEX + 2) === GUEST_KIND
  );
}
