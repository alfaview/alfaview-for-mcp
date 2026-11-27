/**
 * The file sharing settings and storage limits of a room. alfaview answers no 404 for them: a read
 * of a room that does not exist gives defaults, and a write stores settings for it. So a caller
 * reads the room first to find out that it exists.
 */
import { booleanOrNull, integerOrNull, textOrNull } from './outputValues.ts';
import { roomPath } from './rooms.ts';

const BYTES_PER_MEGABYTE = 1024 * 1024;

/** The file sharing settings of a room (spec: RoomSettings). */
export type ApiFileShareSettings = {
  enabled?: boolean;
  defaultAccessLevel?: string;
  participantsCanUpload?: boolean;
};

/** The storage limits of a room for shared files (spec: RoomLimits). */
export type ApiFileShareLimits = {
  maxTotalBytes?: number;
  maxFiles?: number;
  remainingTotalBytes?: number;
  remainingFiles?: number;
};

export type FileSharingOutput = {
  roomId: string;
  enabled: boolean | null;
  defaultAccessLevel: string | null;
  participantsCanUpload: boolean | null;
  maxFiles: number | null;
  remainingFiles: number | null;
  maxTotalMegabytes: number | null;
  remainingTotalMegabytes: number | null;
  maxTotalBytes: number | null;
  remainingTotalBytes: number | null;
};

export function fileShareSettingsPath(roomId: string): string {
  return `${roomPath(roomId)}/file-share-settings`;
}

export function fileShareLimitsPath(roomId: string): string {
  return `${roomPath(roomId)}/file-share-limits`;
}

/** Returns whole megabytes, rounded down, or `null` when alfaview sent no byte count. */
function megabytes(bytes: number | null): number | null {
  return bytes === null ? null : Math.floor(bytes / BYTES_PER_MEGABYTE);
}

/** Returns the File Sharing output. Absent values are `null`. */
export function mapFileSharing(
  roomId: string,
  settings: ApiFileShareSettings | undefined,
  limits: ApiFileShareLimits | undefined,
): FileSharingOutput {
  const maxTotalBytes = integerOrNull(limits?.maxTotalBytes);
  const remainingTotalBytes = integerOrNull(limits?.remainingTotalBytes);
  return {
    roomId,
    enabled: booleanOrNull(settings?.enabled),
    defaultAccessLevel: textOrNull(settings?.defaultAccessLevel),
    participantsCanUpload: booleanOrNull(settings?.participantsCanUpload),
    maxFiles: integerOrNull(limits?.maxFiles),
    remainingFiles: integerOrNull(limits?.remainingFiles),
    maxTotalMegabytes: megabytes(maxTotalBytes),
    remainingTotalMegabytes: megabytes(remainingTotalBytes),
    maxTotalBytes,
    remainingTotalBytes,
  };
}
