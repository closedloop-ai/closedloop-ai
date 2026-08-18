/**
 * The Codex transcript diffStats accumulation, extracted from `parse-codex.ts`.
 *
 * Codex reports edits as `apply_patch` / `patch_apply_begin` payloads carrying a
 * unified-diff / Codex-envelope patch string. `mergeDiffDelta` folds each patch
 * into the session-level `diffStats`: line counts genuinely SUM across patches,
 * but the FILE count must dedup by path — a file edited across N patches is one
 * changed file, not N. This mirrors the Claude parser, which accumulates distinct
 * paths into `diffFiles: Set<string>` and reports `filesChanged = set.size`
 * (`claude/diff-stats-tool-handlers.ts`); before FEA-3943 the Codex path instead
 * summed `countDiffFiles` per patch and inflated the total (ISS-4398 sibling gap).
 *
 * Splitting this out of the grandfathered `parse-codex.ts` keeps that file
 * shrinking (root AGENTS.md file-size rule), exactly as the Claude diff-stats
 * handlers were extracted from `parse-claude.ts`.
 */

import { computeUnifiedDiffDelta } from "../parser-utils";
import type { NormalizedDiffStats } from "../types";

/**
 * The subset of the Codex parser's accumulator these helpers mutate. The full
 * `RolloutAccumulator` in `parse-codex.ts` is structurally assignable to this,
 * so the parser can pass it straight through without widening its surface.
 */
export type CodexDiffAccumulator = {
  diffStats: NormalizedDiffStats | null;
  readonly diffFiles: Set<string>;
};

// The file-identifying headers we recognize, captured so the accumulator can
// dedup by PATH rather than count header occurrences: the Codex apply_patch
// envelope (`*** Add|Update|Delete File: <path>`, already a repo-relative path)
// and the unified-diff file headers (`--- <old>` / `+++ <new>`).
const CODEX_FILE_HEADER_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/;
const UNIFIED_OLD_FILE_HEADER_PREFIX = "--- ";
const UNIFIED_NEW_FILE_HEADER_PREFIX = "+++ ";
// git renders new/deleted files as this sentinel on one side of the pair.
const DEV_NULL = "/dev/null";
// git diff `a/`/`b/` path prefix, stripped so a unified header's `a/src/a.ts`
// resolves to the same identity as the Codex envelope's `src/a.ts`.
const UNIFIED_DIFF_PREFIX_RE = /^[ab]\//;
// shafty023 CR: split on CRLF as well as LF. A Windows-captured rollout carries
// `\r\n`; splitting on `\n` alone leaves a trailing `\r` that the `$`-anchored
// header regex won't match (`.` and `$` both stop before `\r`), so every
// `*** … File:` directive would be missed and the session rebuilt with
// filesChanged: 0. Mirrors the Codex adapter's own `/\r?\n/` handling.
const LINE_SPLIT_RE = /\r?\n/;

/**
 * wongk (FEA-3943 CR): normalize one side of a unified-diff file header to a
 * stable identity. Drops the trailing `\t<timestamp>` that `diff -u` appends,
 * strips the `a/`/`b/` diff prefix so it matches the Codex envelope's bare path,
 * and returns null for the `/dev/null` sentinel (a new/deleted file's absent
 * side) so the caller can fall back to the real side of the pair.
 */
function normalizeUnifiedHeaderPath(raw: string): string | null {
  const tabIdx = raw.indexOf("\t");
  const path = (tabIdx === -1 ? raw : raw.slice(0, tabIdx)).trim();
  if (path === "" || path === DEV_NULL) {
    return null;
  }
  return path.replace(UNIFIED_DIFF_PREFIX_RE, "");
}

/**
 * FEA-3943: the distinct-file counterpart to `countDiffFiles` — returns the file
 * PATHS named by a patch's headers (duplicates possible within one patch) so the
 * caller can fold them into a cross-patch dedup set.
 *
 * wongk CR: a header string is not a stable file identity. Codex envelopes name
 * `src/a.ts` while unified diffs name `a/src/a.ts`, so a mixed-format session
 * would count one file twice; and every unified ADD has a `--- /dev/null` old
 * header, so distinct added files would collapse to one entry. We therefore
 * PAIR each `--- ` with its following `+++ `, pick the non-`/dev/null` side
 * (preferring the new/destination path), and normalize the diff prefix — so
 * both formats and every add/update/delete resolve to one canonical path.
 */
export function extractDiffFilePaths(patch: string): string[] {
  const paths: string[] = [];
  // Set when a `--- ` header is seen, consumed by its paired `+++ `. `null`
  // records a `/dev/null` old side (absent), distinct from "no pending header".
  let pendingOld: string | null | undefined;
  for (const line of patch.split(LINE_SPLIT_RE)) {
    const codexHeader = CODEX_FILE_HEADER_RE.exec(line);
    if (codexHeader) {
      const path = codexHeader[1].trim();
      if (path) {
        paths.push(path);
      }
      pendingOld = undefined;
    } else if (line.startsWith(UNIFIED_OLD_FILE_HEADER_PREFIX)) {
      pendingOld = normalizeUnifiedHeaderPath(
        line.slice(UNIFIED_OLD_FILE_HEADER_PREFIX.length)
      );
    } else if (line.startsWith(UNIFIED_NEW_FILE_HEADER_PREFIX)) {
      const newPath = normalizeUnifiedHeaderPath(
        line.slice(UNIFIED_NEW_FILE_HEADER_PREFIX.length)
      );
      const chosen = newPath ?? pendingOld ?? null;
      if (chosen) {
        paths.push(chosen);
      }
      pendingOld = undefined;
    }
  }
  return paths;
}

/**
 * CR-4 / FEA-3943: parse one patch string, fold its line delta and distinct file
 * paths into the session-level `diffStats` accumulator, and return the per-tool
 * delta so the caller can stamp `tu.diffDelta`. Lines add up across patches;
 * `filesChanged` tracks the distinct-path set size, NOT the per-patch header sum.
 */
export function mergeDiffDelta(
  acc: CodexDiffAccumulator,
  rawDiff: string
): { add: number; del: number } {
  const delta = computeUnifiedDiffDelta(rawDiff);
  for (const path of extractDiffFilePaths(rawDiff)) {
    acc.diffFiles.add(path);
  }
  if (acc.diffStats) {
    acc.diffStats.filesChanged = acc.diffFiles.size;
    acc.diffStats.linesAdded += delta.add;
    acc.diffStats.linesRemoved += delta.del;
  } else {
    acc.diffStats = {
      filesChanged: acc.diffFiles.size,
      linesAdded: delta.add,
      linesRemoved: delta.del,
    };
  }
  return delta;
}
