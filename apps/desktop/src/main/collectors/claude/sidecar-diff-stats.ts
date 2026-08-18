/**
 * @file sidecar-diff-stats.ts
 * @description ISS-5402 — fold a delegated Claude sub-agent's authored lines up
 * to the parent session's aggregate `diffStats`.
 *
 * **The asymmetry this closes.** The desktop sidecar merge in `claude-parser.ts`
 * already folds a `subagents/agent-*.jsonl` child's TOKENS into the parent
 * (`mergeFoldedUsage`), which is what makes the parent's `est_cost` include
 * delegated work. It never folded that child's LOC. So `LOC / $` — whose
 * denominator provably counts sub-agent tokens — was dividing that cost into the
 * parent's OWN inline edits only, understating the ratio by exactly the
 * delegation rate. A metric whose numerator and denominator disagree about what
 * counts is worse than one that is merely missing.
 *
 * **The model is not a new one.** ISS-5395 established roll-up-to-parent: a
 * folded sub-agent has no session row of its own (the local `sessions` table has
 * no `parent_id`), so there is no other timeline to attribute its work to. This
 * applies that same model to LOC.
 *
 * **Why the derivation reads the raw entries and not the merged tool-use
 * records.** `subagent-scanner.ts` bounds each tool input at 1000 JSON chars, so
 * a real `Edit`'s `old_string`/`new_string` — and a `Write`'s `content` — are
 * truncated past re-parsing there. Line deltas must come from the untruncated
 * raw lines, which the sidecar lane already streams once per file.
 *
 * The line formula itself is NOT redefined here: every delta is routed through
 * `applyDiffStatsToolUse` in the shared harness module, the same registry the
 * parent's own tool loop uses.
 */

import {
  applyDiffStatsToolUse,
  applyDiffStatsToolUseState,
  captureDiffStatsReadResult,
  createDiffStatsAccumulator,
  DIFF_STATS_TOOL_NAMES,
  type DiffStatsAccumulator,
  isUsableDiffStatsToolInput,
} from "@repo/lib/harness/claude/diff-stats-tool-handlers";
// The parser's own total `asRecord` (a non-record becomes `{}`), NOT the
// nullable `shared/type-guards` one — the diffStats handlers narrow tool input
// with exactly this helper, so sharing it keeps the two lanes reading a
// malformed block identically.
import { asRecord } from "@repo/lib/harness/parser-utils";
import type { NormalizedDiffStats } from "@repo/lib/harness/types";

/**
 * A sidecar's authored-line contribution to its parent. `filePaths` rides along
 * (rather than a pre-summed `filesChanged`) because the parent unions paths
 * across every sidecar AND its own inline edits — a file two sub-agents both
 * touched is one changed file, not two.
 */
export type SidecarDiffStatsContribution = {
  linesAdded: number;
  linesRemoved: number;
  filePaths: ReadonlySet<string>;
};

/** An empty contribution — the shape a sidecar with no edits contributes. */
export function emptySidecarDiffStats(): SidecarDiffStatsContribution {
  return { linesAdded: 0, linesRemoved: 0, filePaths: new Set<string>() };
}

/**
 * Feed one raw transcript line into the accumulator. Assistant `tool_use` blocks
 * drive the line deltas; `user` `tool_result` blocks supply the Read baselines a
 * later overwriting `Write` diffs against, so a delegated overwrite records its
 * deletions instead of reading as an all-added fresh file.
 *
 * Exported so the sidecar lane can drive it from its existing single streaming
 * pass rather than opening each file a second time.
 *
 * ISS-5426: `pass.countedDiffToolUseIds` suppresses a tool use already counted —
 * by the PARENT's own loop or by an earlier sidecar under the same parent. See
 * {@link parentCountedDiffToolUseIds}.
 */
export function accumulateSidecarDiffStatsEntry(
  pass: SidecarDiffStatsPass,
  entry: Record<string, unknown>
): void {
  const message = asRecord(entry.message);
  const content = Array.isArray(message.content) ? message.content : [];
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (block.type === "tool_use") {
      applyToolUseBlock(pass, block);
      continue;
    }
    if (block.type === "tool_result") {
      applyToolResultBlock(pass.acc, block, pass.toolInputByUseId);
    }
  }
}

/** Route one `tool_use` block through the shared line formula. */
function applyToolUseBlock(
  pass: SidecarDiffStatsPass,
  block: Record<string, unknown>
): void {
  if (typeof block.name !== "string") {
    return;
  }
  const toolUseId = typeof block.id === "string" ? block.id : null;
  const toolInput = block.input ?? null;
  // ISS-5426: one authored tool use contributes its lines ONCE, keyed on
  // `tool_use.id`. Two representations can present the same record to this fold:
  // the parent's inline `isSidechain` entries (already booked by the core's
  // `TOOL_USE_HANDLERS` pass, which is what seeds this set) and a sidecar file;
  // and, for a NESTED workflow agent, its records can appear inside its parent
  // sidecar's transcript as well as in its own `agent-*.jsonl`.
  if (toolUseId && pass.countedDiffToolUseIds.has(toolUseId)) {
    // wongk review (PR #4715): suppress the COUNT, never the STATE. This
    // record's lines and changed file were booked by whoever counted it first,
    // but the accumulator's known-file baseline is per-pass and still has to
    // advance — a duplicated `Write` followed by a genuinely new `Write` to the
    // same path must diff against what the first one left, not against
    // never-written. Returning here made that second write read as a fresh
    // all-added file.
    applyDiffStatsToolUseState(pass.acc, block.name, toolInput);
  } else {
    // `toolInput` is raw transcript JSON — nothing has validated it. The shared
    // entry point gates on the payload schema before dispatching, so a malformed
    // block (a `Write` with no string `content`, an `Edit`/`MultiEdit` with no
    // edited side) contributes neither lines nor a changed file rather than the
    // fabricated one-added-line the total handlers would coerce it into.
    const counted = applyDiffStatsToolUse(pass.acc, block.name, toolInput);
    // Claim the id only when the payload ACTUALLY contributed. A record the
    // schema gate rejected booked nothing, so claiming it would let a malformed
    // first occurrence silently suppress a well-formed later one.
    if (counted && toolUseId) {
      pass.countedDiffToolUseIds.add(toolUseId);
    }
  }
  // Only a Read's input is needed later, and only to pair with its result.
  // Unconditional on the branch above: a Read is not a diffStats tool, so it is
  // never in the counted set today, but pairing it is bookkeeping rather than
  // counting and must not become collateral of a future suppression.
  if (block.name === "Read" && toolUseId) {
    pass.toolInputByUseId.set(toolUseId, toolInput);
  }
}

/** Pair a successful `Read` result with its pending input and cache the baseline. */
function applyToolResultBlock(
  acc: DiffStatsAccumulator,
  block: Record<string, unknown>,
  toolInputByUseId: Map<string, unknown>
): void {
  if (block.is_error === true || typeof block.tool_use_id !== "string") {
    return;
  }
  const readInput = toolInputByUseId.get(block.tool_use_id);
  if (readInput === undefined) {
    return;
  }
  toolInputByUseId.delete(block.tool_use_id);
  const resultText = toolResultText(block.content);
  if (resultText !== null) {
    captureDiffStatsReadResult(acc, readInput, resultText);
  }
}

/**
 * Flatten a `tool_result` block's content to its text, or `null` when the block
 * carries no readable text. A Read whose body cannot be recovered simply leaves
 * no baseline cached — the `Write` handler then falls back to its documented
 * fresh-file reading rather than diffing against a fabricated one.
 */
function toolResultText(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const rawPart of content) {
    const part = asRecord(rawPart);
    if (part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * One sidecar file's streaming pass.
 *
 * `acc` and `toolInputByUseId` are per FILE. `countedDiffToolUseIds` is per
 * PARENT and deliberately SHARED (and mutated) across every pass under it — that
 * is what lets a later sidecar recognise a record an earlier one already booked.
 */
export type SidecarDiffStatsPass = {
  acc: DiffStatsAccumulator;
  toolInputByUseId: Map<string, unknown>;
  countedDiffToolUseIds: Set<string>;
};

/**
 * A fresh accumulator + Read-join map for one sidecar file's streaming pass,
 * joined to the parent-scoped counted-tool-use set (ISS-5426). Pass the SAME set
 * to every sidecar under one parent; a fresh one per file would reopen the
 * cross-sidecar duplicate this closes.
 */
export function createSidecarDiffStatsPass(
  countedDiffToolUseIds: Set<string>
): SidecarDiffStatsPass {
  return {
    acc: createDiffStatsAccumulator(),
    toolInputByUseId: new Map<string, unknown>(),
    countedDiffToolUseIds,
  };
}

/** Close a pass into the contribution its parent folds. */
export function sidecarDiffStatsFromAccumulator(
  acc: DiffStatsAccumulator
): SidecarDiffStatsContribution {
  return {
    linesAdded: acc.totalAdded,
    linesRemoved: acc.totalRemoved,
    filePaths: acc.diffFiles,
  };
}

/**
 * ISS-5402: fold every sidecar's contribution into the parent's `diffStats`.
 *
 * `filesChanged` is a UNION, not a sum: the parent's own changed-file count is
 * widened only by paths no earlier contributor already claimed. The parent's own
 * path set is recovered from its inline tool uses (`ownFilePaths`) so a file both
 * the parent and a sub-agent edited is still one changed file.
 *
 * Returns `null` — never a zero-valued object — whenever no changed file can be
 * attributed, preserving the parser's existing "no edits means no diffStats"
 * contract so an unresolvable LOC keeps reading as unknown downstream rather
 * than as a true zero.
 */
export function foldSidecarDiffStats(
  parentDiffStats: NormalizedDiffStats | null,
  ownFilePaths: ReadonlySet<string>,
  contributions: readonly SidecarDiffStatsContribution[]
): NormalizedDiffStats | null {
  let addedFromSidecars = 0;
  let removedFromSidecars = 0;
  const unionPaths = new Set<string>(ownFilePaths);
  for (const contribution of contributions) {
    addedFromSidecars += contribution.linesAdded;
    removedFromSidecars += contribution.linesRemoved;
    for (const filePath of contribution.filePaths) {
      unionPaths.add(filePath);
    }
  }
  const linesAdded = (parentDiffStats?.linesAdded ?? 0) + addedFromSidecars;
  const linesRemoved =
    (parentDiffStats?.linesRemoved ?? 0) + removedFromSidecars;
  // The parent's own `filesChanged` is authoritative for its own edits (it may
  // exceed `ownFilePaths` if a tool use carried no usable `file_path`), so widen
  // it by the sidecar paths it does not already account for rather than trusting
  // the recovered set alone.
  const newSidecarPaths = unionPaths.size - ownFilePaths.size;
  const filesChanged = (parentDiffStats?.filesChanged ?? 0) + newSidecarPaths;
  // Mirror the parent lane's stronger invariant: `parse-claude.ts` gates the
  // whole object on `acc.diffFiles.size > 0`, so the core can never emit lines
  // against zero files. A `{filesChanged: 0, linesAdded: N}` record contradicts
  // itself and would ride to the cloud's `files_changed`/`lines_added` columns
  // and onto the session header as "0 files changed, +N". Lines from a tool use
  // that carried no usable `file_path` are unattributable, so they drop with the
  // object rather than being persisted against a file count that denies them.
  // `parentDiffStats` is null whenever this fires (the core's own gate makes a
  // non-null parent's `filesChanged` at least 1), so LOC keeps reading as
  // unknown downstream rather than as a fabricated zero.
  if (filesChanged === 0) {
    return parentDiffStats;
  }
  return { filesChanged, linesAdded, linesRemoved };
}

/**
 * Recover the parent's own changed-file path set from its inline tool uses, so
 * the union above can tell a genuinely new sidecar file from one the parent
 * already counted. Mirrors the `file_path` extraction the diffStats handlers do;
 * every currently registered handler keys on that same input field.
 *
 * The tool names come from {@link DIFF_STATS_TOOL_NAMES}, which is derived from
 * the shared handler registry rather than re-declared here, so a newly
 * registered handler is picked up automatically instead of silently falling out
 * of the union and double-counting the parent's files as new sidecar paths.
 */
export function ownDiffFilePaths(
  toolUses: ReadonlyArray<{ name: string; input?: unknown }>
): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const toolUse of toolUses) {
    if (!DIFF_STATS_TOOL_NAMES.has(toolUse.name)) {
      continue;
    }
    const filePath = asRecord(toolUse.input).file_path;
    if (typeof filePath === "string") {
      paths.add(filePath);
    }
  }
  return paths;
}

/**
 * ISS-5426: SEED the counted-tool-use set with the `tool_use.id`s the PARENT's
 * own tool loop already booked toward `diffStats`, so the sidecar fold refuses
 * to count them a second time. The sidecar passes then ADD to this same set as
 * they count, which is what makes the guard hold across sidecars too.
 *
 * A delegated sub-agent can be written down twice: as `isSidechain: true`
 * entries inside the parent `.jsonl` — which the core parser runs through
 * `TOOL_USE_HANDLERS`, so their lines are ALREADY in `session.diffStats` — and
 * as its own `subagents/agent-*.jsonl` sidecar, which the ISS-5402 fold also
 * reads. `claude-parser.ts` already reconciles exactly that dual shape for the
 * merged tool-use RECORDS (it reuses an inline sidechain subagent for a sidecar
 * file and dedups `subagent.toolUses` by `toolUse.id`); this gives the LINE fold
 * the same guard, keyed on the same identity.
 *
 * The set is returned MUTABLE on purpose. Seeding from the parent alone would
 * miss the FEA-3420 nested shape, where a workflow agent's records can appear
 * both inside its parent sidecar's transcript and in its own
 * `workflows__<wf>__agent-*.jsonl` — neither of which the core ever parsed, so
 * neither is in `session.toolUses`.
 *
 * `session.toolUses` carries the parent's own AND its inline-sidechain tool
 * uses. The name set is {@link DIFF_STATS_TOOL_NAMES}, derived from the shared
 * handler registry, so a fourth registered handler is covered with no edit here.
 *
 * wongk review (PR #4715): the seed additionally gates on the PAYLOAD, not the
 * name alone. Seeding by name assumed "a registered diffStats tool was counted",
 * but the parent's handlers are TOTAL — a malformed inline record (a `Write`
 * whose `content` is not a string, an `Edit`/`MultiEdit` carrying no edited
 * side) is coerced into a fabricated or empty delta rather than a real one. A
 * truncated inline copy claiming the id would then suppress the sidecar's
 * well-formed copy of the SAME tool use: data loss in the opposite direction
 * from the double-count this guard exists to close. Gating on
 * {@link isUsableDiffStatsToolInput} makes this seed obey the same rule the
 * sidecar passes already do — claim an id only for a payload that could produce
 * a trustworthy delta.
 *
 * What this deliberately does NOT do is un-count the parent's own fabrication:
 * a malformed inline `Write` still books its coerced line in the CORE's pass,
 * which is the parent lane's long-standing total-handler posture (ISS-5402 left
 * it unchanged on purpose, and it is not reachable from this module). This seed
 * only stops that fabrication from also DELETING the real measurement.
 */
export function parentCountedDiffToolUseIds(
  toolUses: ReadonlyArray<{ name: string; id?: string; input?: unknown }>
): Set<string> {
  const ids = new Set<string>();
  for (const toolUse of toolUses) {
    if (
      toolUse.id &&
      DIFF_STATS_TOOL_NAMES.has(toolUse.name) &&
      isUsableDiffStatsToolInput(toolUse.name, toolUse.input)
    ) {
      ids.add(toolUse.id);
    }
  }
  return ids;
}
