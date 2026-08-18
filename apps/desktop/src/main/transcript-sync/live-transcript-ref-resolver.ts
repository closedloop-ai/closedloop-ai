/**
 * @file live-transcript-ref-resolver.ts
 * @description ISS-4390: map a WATCHER-supplied changed path to the transcript
 * file key the archive lane should enqueue it under.
 *
 * FEA-3640 gave every harness a shared ~5 min live flush, but armed it for a
 * session's `main` transcript only: the collector seam maps a child watch event
 * back to its ROOT import source (Codex `findCodexRootSource`, Claude's
 * `subagents/` → parent fold) because that mapping answers an IMPORT question
 * ("which source do I re-parse?"). The archive lane asks a different question
 * ("which file's bytes changed?"), so a child-only edit armed a no-op flush of
 * the unchanged root and the real file waited for the 30-min discovery sweep.
 *
 * This module answers the lane's question from the ORIGINAL changed path, which
 * the seam now carries alongside the mapped source. Deliberately NOT a discovery
 * walk: the keys here must be byte-identical to the ones
 * `transcript-discovery.ts` produces for the same files, or the live enqueue and
 * the sweep would address two different archive objects for one transcript.
 *
 * BOUNDARY: this module statically imports collector modules
 * (`src/main/collectors/**`), which desktop BOOT files may not reach (the
 * agent-dashboard dependency-cruiser rule). It is therefore consumed the same
 * way `transcript-discovery.ts` is — lazily `import()`ed and injected into
 * `TranscriptSyncService` as the `resolveLiveRef` seam, never statically
 * imported by the service itself.
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import {
  isSubagentTranscriptPath,
  relIdFromSubagentPath,
  walkSubagentTranscripts,
} from "../collectors/claude/claude-home.js";
import { readCodexRolloutLinkage } from "../collectors/codex/codex-subagent-rollouts.js";
import {
  subagentFileKey,
  TRANSCRIPT_MAIN_FILE_KEY,
  TranscriptSourceHarness,
} from "./transcript-sync-types.js";

/** True when `candidate` is contained in `root` (mirrors trusted-transcript-path). */
function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" && !(relative.startsWith("..") || path.isAbsolute(relative))
  );
}

/**
 * The `subagents/` directory owned by a Claude MAIN transcript. Layout is
 * `<projectDir>/<sessionId>.jsonl` for the session and
 * `<projectDir>/<sessionId>/subagents/**` for its sidecars, so the dir is
 * derivable from the main transcript path alone — no projects-root lookup and no
 * filesystem access.
 */
export function claudeSubagentsDirForTranscript(
  mainTranscriptPath: string
): string {
  const sessionId = path.basename(mainTranscriptPath, ".jsonl");
  return path.join(path.dirname(mainTranscriptPath), sessionId, "subagents");
}

/**
 * Canonicalize a path the way the trust guard does, so both sides of a
 * containment check live at the same canonicalization level.
 *
 * The changed path reaches this module already `realpath`-resolved (the caller
 * routes it through `resolveTrustedClaudeTranscriptPath`), but the MAPPED source
 * comes straight off the collector seam and has only ever been `path.resolve`d.
 * Comparing the two directly false-negatives whenever any ancestor is a symlink
 * — a relocated `~/.claude`, a home-manager dotfile tree, a container
 * bind-mount, macOS's `/var` → `/private/var` — which would silently strand
 * every child transcript on those installs. Falls back to the lexical resolve
 * when the path does not exist yet (an early-session race), which is no worse
 * than the pre-canonicalization behavior.
 */
function canonicalize(candidate: string): string {
  const resolved = path.resolve(candidate);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * The archive-lane file key for one changed path, given the root/parent source
 * the collector seam mapped it to, or **null when the changed path cannot be
 * identified** as either the mapped transcript or one of its children.
 *
 * Null is load-bearing, not a convenience: the caller must DROP an unresolvable
 * child and leave it to the 30-min discovery sweep. Returning
 * {@link TRANSCRIPT_MAIN_FILE_KEY} as a "safe default" would be actively unsafe
 * here — the caller pairs the key with the CHILD's path, so a `main` key would
 * archive the child's bytes into the main transcript's row and advance main's
 * byte cursor over content that is not main's.
 *
 * - **Claude** — pure path math. A changed path under the mapped transcript's
 *   `subagents/` dir keys as `subagent:{relId}`, reusing
 *   {@link relIdFromSubagentPath} (the SSOT the discovery walk also calls) so
 *   nested workflow agents get the same collision-free id here as there.
 * - **Codex** — one bounded head-read. A changed rollout that is NOT the mapped
 *   root is a descendant; its id comes from `readCodexRolloutLinkage`, which
 *   prefers the rollout's own `firstMeta.id` exactly as discovery does. The id
 *   is deliberately NOT derived from the filename: `sessionIdFromRolloutPath` is
 *   only that reader's FALLBACK, so a path-derived key could disagree with
 *   discovery's and archive the file twice.
 */
export function resolveLiveTranscriptFileKey(
  harness: TranscriptSourceHarness,
  mappedSourcePath: string,
  changedPath: string
): string | null {
  const mapped = canonicalize(mappedSourcePath);
  const changed = canonicalize(changedPath);
  if (mapped === changed) {
    return TRANSCRIPT_MAIN_FILE_KEY;
  }
  if (harness === TranscriptSourceHarness.Claude) {
    const subagentsDir = claudeSubagentsDirForTranscript(mapped);
    // Containment alone is too wide: Claude's `watchMatch` admits every
    // `.jsonl`, so a workflow journal/index file — or one nested deeper than the
    // discovery walk descends — would mint a live key the sweep never
    // enumerates, leaving an archived object with no local counterpart. Gate on
    // the SAME predicate the walk uses.
    return isPathInside(changed, subagentsDir) &&
      isSubagentTranscriptPath(subagentsDir, changed)
      ? subagentFileKey(relIdFromSubagentPath(subagentsDir, changed))
      : null;
  }
  if (harness === TranscriptSourceHarness.Codex) {
    return subagentFileKey(readCodexRolloutLinkage(changed).rolloutId);
  }
  // OpenCode never reaches here — `toRawTranscriptSourceHarness` filters batch-
  // materialized harnesses out before the lane arms any live debounce.
  return null;
}

/**
 * Every subagent sidecar owned by one Claude session, as `(fileKey, sourcePath)`
 * pairs (ISS-4390 slice 2).
 *
 * The HOOK channel needs this because it has no changed path to work from: a
 * `SubagentStop` payload carries the PARENT `transcript_path`, never the
 * sidecar's. So instead of resolving one known file, the caller enumerates the
 * session's sidecars and picks the ones with new bytes.
 *
 * DORMANT: the Claude hook lane is off behind `CLAUDE_LIVE_HOOK_ENABLED`
 * (FEA-3729), so nothing calls this today — Claude runs on the watcher, which
 * uses {@link resolveLiveTranscriptFileKey} instead.
 *
 * Bounded to ONE session's `subagents/` tree — not a corpus walk — and reuses the
 * same {@link walkSubagentTranscripts} + relId derivation the discovery sweep
 * uses, so the keys agree by construction.
 */
export function listClaudeSubagentRefsForTranscript(
  mainTranscriptPath: string
): Array<{ fileKey: string; sourcePath: string }> {
  const subagentsDir = claudeSubagentsDirForTranscript(mainTranscriptPath);
  return walkSubagentTranscripts(subagentsDir).map((entry) => ({
    fileKey: subagentFileKey(entry.relId),
    sourcePath: entry.filePath,
  }));
}
