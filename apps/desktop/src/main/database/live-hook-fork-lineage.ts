/**
 * ISS-12552 (AC-020): what the live-hook path reads about a headless Claude
 * fork, beside `live-hook.ts`.
 */
import path from "node:path";
import { resolveClaudeForkLineage } from "../collectors/claude/claude-fork-lineage.js";
import { getProjectsDir as getClaudeProjectsDir } from "../collectors/claude/claude-home.js";
import { isImportableSourcePath } from "../collectors/engine/source-admission.js";
import { effectiveParsePolicy } from "../parse-policy/effective-parse-policy.js";
import type { TranscriptForkSkip } from "./transcript.js";

/** The roots a hook-named transcript path must sit under to be read. */
export function claudeProjectsRoots(): string[] {
  return [getClaudeProjectsDir()].filter(
    (root): root is string => typeof root === "string" && root.length > 0
  );
}

/**
 * The entries a headless fork copied from its parent, so the hook path does
 * not count the parent's usage again. The hook names the path, so only a
 * transcript under the Claude projects root has its directory scanned.
 * Best-effort: an unreadable sibling leaves the extraction as it was.
 */
export async function replayedForkEntries(
  transcriptPath: string,
  log: (message: string) => void
): Promise<ReadonlySet<string> | undefined> {
  if (
    !isImportableSourcePath(path.resolve(transcriptPath), claudeProjectsRoots())
  ) {
    return undefined;
  }
  try {
    return (await resolveClaudeForkLineage(transcriptPath))?.entryUuids;
  } catch (error) {
    log(
      `sqlite lifecycle: fork lineage unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}

/**
 * What the hook path's token extraction skips of a fork's inherited history.
 * ISS-12552 (PRD-800 "Rollout"): only under the attribution policy; off,
 * nothing is skipped, as before PRD-800.
 */
export async function forkSkipFor(
  transcriptPath: string,
  log: (message: string) => void
): Promise<TranscriptForkSkip | undefined> {
  if (!effectiveParsePolicy().attributionEvidence) {
    return;
  }
  return { replayed: await replayedForkEntries(transcriptPath, log) };
}
