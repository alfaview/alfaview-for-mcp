/**
 * The passcode of a room. A passcode is a credential: output it only from the operations that read
 * or regenerate it.
 */
import { booleanOrNull, textOrNull } from './outputValues.ts';
import { roomPath } from './rooms.ts';

/** The passcode of a room as the API answers it (spec: Passcode). */
export type ApiPasscode = { passcode?: string; required?: boolean };

export type PasscodeOutput = {
  roomId: string;
  roomName: string | null;
  passcode: string | null;
  passcodeRequired: boolean | null;
};

export function passcodePath(roomId: string): string {
  return `${roomPath(roomId)}/passcode`;
}

/** Returns the Passcode output. Absent values are `null`. */
export function mapPasscode(
  roomId: string,
  roomName: string | null,
  passcode: ApiPasscode | undefined,
): PasscodeOutput {
  return {
    roomId,
    roomName,
    passcode: textOrNull(passcode?.passcode),
    passcodeRequired: booleanOrNull(passcode?.required),
  };
}
