// A passcode is a credential. Only get_room with includePasscode and regenerate_room_passcode
// return it.
import type { CallApi } from '../alfaview/client.ts';
import { invalidResponse } from '../alfaview/errors.ts';
import { booleanOrNull, textOrNull } from '../shared/outputValues.ts';
import { passcodePath, type ApiPasscode } from '../shared/passcode.ts';

export type PasscodeOutput = {
  roomId: string;
  passcode: string | null;
  passcodeRequired: boolean | null;
};

/** Returns the Passcode output. Absent values are `null`. */
export function mapPasscode(roomId: string, passcode: ApiPasscode | undefined): PasscodeOutput {
  return {
    roomId,
    passcode: textOrNull(passcode?.passcode),
    passcodeRequired: booleanOrNull(passcode?.required),
  };
}

/** Returns the error when alfaview answers the regeneration without the new passcode. */
export function passcodeNotReturnedMessage(roomId: string): string {
  return `alfaview made a new passcode for the room ${roomId}, but did not return it. Use get_room with includePasscode true to read it.`;
}

/**
 * Returns the current passcode of the room, or `null`. alfaview answers 200 with an empty passcode
 * for a room without a passcode: an empty passcode and an answer without one give `null`. It
 * answers 404 only for a room that it does not find or that the API key's user cannot see, and the
 * client then throws its ToolError with the code NotFound and the message of the room.
 */
export async function readPasscode(api: CallApi, roomId: string): Promise<string | null> {
  const { data } = await api.request<ApiPasscode>({ method: 'GET', path: passcodePath(roomId) });
  return mapPasscode(roomId, data).passcode;
}

/**
 * Makes a new passcode for the room and returns it. The old one stops working at once, and a
 * repeat makes another passcode. The answer carries the new passcode, so nothing is read back. An
 * answer without it gives the code InvalidResponse with {@link passcodeNotReturnedMessage}.
 */
export async function regeneratePasscode(api: CallApi, roomId: string): Promise<PasscodeOutput> {
  const { data } = await api.request<ApiPasscode>({ method: 'POST', path: passcodePath(roomId) });
  const passcode = mapPasscode(roomId, data);
  if (passcode.passcode === null) throw invalidResponse(passcodeNotReturnedMessage(roomId));
  return passcode;
}
