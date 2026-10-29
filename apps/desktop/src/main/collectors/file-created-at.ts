/**
 * @file file-created-at.ts
 * @description ISS-12251 (PLN-2176 T-6.2): the transcript file's birth time,
 * which Desktop records as the session's creation time.
 */
import type { Stats } from "node:fs";
import type { NormalizedSession } from "./types.js";

/**
 * `birthtimeMs` when it is finite and greater than 0, otherwise `undefined`
 * (some filesystems report 0 for an unknown birth time). Takes the stat the
 * parser already holds for `fileModifiedAt`, so both come from one stat.
 */
export function fileCreatedAtFromStats(
  stats: Pick<Stats, "birthtimeMs">
): number | undefined {
  const { birthtimeMs } = stats;
  if (!Number.isFinite(birthtimeMs) || birthtimeMs <= 0) {
    return;
  }
  return birthtimeMs;
}

/** No stat (it failed) or no usable birth time leaves `fileCreatedAt` unset. */
export function stampFileCreatedAt(
  session: NormalizedSession,
  stats: Pick<Stats, "birthtimeMs"> | undefined
): void {
  const fileCreatedAt = stats && fileCreatedAtFromStats(stats);
  if (fileCreatedAt !== undefined) {
    session.fileCreatedAt = fileCreatedAt;
  }
}
