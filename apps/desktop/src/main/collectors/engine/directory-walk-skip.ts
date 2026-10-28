/**
 * @file directory-walk-skip.ts
 * @description ISS-8506 — the one vocabulary a recursive transcript walker uses
 * to say "there is a subtree here I did not read".
 *
 * Every transcript enumerator swallows IO errors to `[]` and stops at a depth
 * bound, which is correct for an error-tolerant import and fatal for a
 * MEASUREMENT: a readable harness root with one denied project directory yields
 * a short listing that a byte inventory would otherwise report as a confident
 * total. The walkers keep their error tolerance — the return shape and every
 * existing caller are unchanged — and gain an optional sink so a caller that
 * needs to know can be told.
 *
 * The reasons live here rather than in any one walker because three modules
 * (`claude-home.ts`, `parser-utils.ts`, `opencode-materialized-discovery.ts`)
 * emit them and one module consumes them.
 */

/** Why a recursive walk did not descend into a directory. */
export const DirectoryWalkSkipReason = {
  /** `readdir` threw something other than ENOENT — EACCES/EPERM/TCC, or IO. */
  ReadError: "read-error",
  /** The walk's depth bound stopped it before the subtree was enumerated. */
  MaxDepth: "max-depth",
} as const;
export type DirectoryWalkSkipReason =
  (typeof DirectoryWalkSkipReason)[keyof typeof DirectoryWalkSkipReason];

/**
 * Told about one unenumerated directory.
 *
 * An ABSENT directory is deliberately never reported: a harness that was never
 * installed has genuinely zero bytes, and calling that an impairment would turn
 * every clean machine into a partial measurement.
 */
export type DirectoryWalkSkipSink = (
  dir: string,
  reason: DirectoryWalkSkipReason
) => void;

/** The options every skip-reporting walker accepts. */
export type DirectoryWalkSkipOptions = {
  onSkip?: DirectoryWalkSkipSink;
};

/**
 * Report a swallowed `readdir` rejection, unless it was simply not there.
 *
 * Centralized because the ENOENT carve-out is the whole correctness of this:
 * report it and an uninstalled harness reads as impaired, omit the check and a
 * TCC-denied home reads as complete.
 */
export function reportReaddirSkip(
  dir: string,
  error: unknown,
  onSkip?: DirectoryWalkSkipSink
): void {
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return;
  }
  onSkip?.(dir, DirectoryWalkSkipReason.ReadError);
}
