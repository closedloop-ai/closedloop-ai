/**
 * Where a loop command's result bundle actually lands on disk.
 *
 * A loop has two candidate directories — the repository worktree it was given
 * and the claude work directory it was run in — but each command writes its
 * deliverable to exactly ONE of them, and that is the directory the artifact
 * readers in `read-loop-artifacts.ts` (and the live dispatch in
 * `symphony-loop.ts`) upload from.
 *
 * Resolving that choice in one place matters for correctness, not just tidiness
 * (ISS-5872 review): the missing-required-artifact guard must ask about the same
 * directory the uploader reads. Searching both would let an unrelated file of
 * the same name sitting in the repo checkout — a stale root `plan.json` left by
 * an earlier run, say — count as "produced" for a run whose work directory is
 * empty, so the loop would upload no plan and still terminalize as COMPLETED.
 * That is the exact false success ISS-5872 exists to remove, re-entering by the
 * back door.
 */

import { LoopCommand } from "@closedloop-ai/loops-api/commands";

/**
 * Commands whose deliverable is written into the repository worktree rather
 * than the claude work directory. Both PRD commands run the same agent against
 * the same checkout and write `prd.md` beside the repo's own files.
 *
 * DECOMPOSE is deliberately not here even though the live dispatch used to
 * spell its read as `worktreeDir ?? claudeWorkDir`: it is `NOT_REQUIRED` for a
 * repo and runs entirely inside a temp directory, so it never has a worktree
 * and the two spellings are the same directory. Listing it would have been the
 * only difference between the live reader and the boot-recovery reader, which
 * has always read its `features.json` from the claude work directory.
 */
const WORKTREE_OUTPUT_COMMANDS = new Set<string>([
  LoopCommand.GeneratePrd,
  LoopCommand.RequestPrdChanges,
]);

export type LoopArtifactDirs = {
  claudeWorkDir: string;
  worktreeDir?: string | null;
};

/**
 * The single directory a command's result bundle is read from.
 *
 * Mirrors the reader precedence exactly, including the fallback: the PRD
 * commands read `worktreeDir ?? claudeWorkDir`, so when a worktree was assigned
 * but has since been removed this resolves to that removed path and the caller
 * sees no directory at all — which is the honest answer, since the uploader
 * would read nothing from it either.
 */
export function resolveArtifactOutputDir(
  command: string,
  dirs: LoopArtifactDirs
): string {
  if (WORKTREE_OUTPUT_COMMANDS.has(command)) {
    return dirs.worktreeDir || dirs.claudeWorkDir;
  }
  return dirs.claudeWorkDir;
}
