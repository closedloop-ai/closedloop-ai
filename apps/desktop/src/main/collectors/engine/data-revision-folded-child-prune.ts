/**
 * @file data-revision-folded-child-prune.ts
 * @description ISS-5395 — the pruning that data-revision entry 62 (ISS-4544,
 * corrected by ISS-4649 finding 1) recorded as "tracked, not yet built".
 *
 * A BATCH collector (OpenCode) implements neither `sessionIdForSource` nor
 * `isBurstArtifactSource`, and both existing delete paths — `foldedChildSessionIds`
 * in collector-manager-pass-scan.ts and the empty-parse delete — are gated on
 * exactly those two. A pre-fold `opencode-<childId>` row therefore SURVIVED the
 * revision rebuild beside its now-folded root: one subagent appearing twice, once
 * as a top-level Sessions row and once nested under its parent.
 *
 * Revision 69 makes that stale row actively wrong rather than merely redundant.
 * The sub-agent roll-up counts a folded subagent's `$.tokenSeries` round-trips on
 * the ROOT, while the surviving child row still derives its own
 * `session_turn_bucket` rows for the SAME round-trips, and `computeAgents` /
 * `computeUtilization` GROUP BY day across every session in the window with no
 * dedupe. Without this pass an upgraded install would double-count every folded
 * round-trip on the autonomy trend and the activity heatmap.
 *
 * Extracted into its own module so data-revision-rebuild.ts (899 lines before
 * this change) stays clear of the 1,000-line ceiling. It takes plain inputs
 * rather than the rebuild's `Database`/`Summary` types so there is no import
 * cycle back into that module.
 */
import type { NormalizedSession } from "../types.js";

export type FoldedChildPruneResult = {
  /** Ids actually deleted. The caller adds this to `summary.deleted`. */
  deletedIds: string[];
  /** Deletes that threw. The caller adds this to `summary.errors`. */
  errors: number;
};

export type FoldedChildPruneInput = {
  /** Harness key, for the log prefix only. */
  harness: string;
  /** Every session the CURRENT parse returned as top level. */
  sessions: readonly NormalizedSession[];
  /**
   * The stale TERMINAL session ids still pending for this harness. Membership is
   * both the existence proof (the row is really in the store) and the liveness
   * guard (an active row is never in this set, so it is never deleted). Deleted
   * ids are removed from it in place.
   */
  pending: Set<string>;
  deleteSessionRow: (sessionId: string) => Promise<void>;
  log: (message: string) => void;
  pauseAfterWrite: () => Promise<void>;
  shouldContinue: () => boolean;
};

/**
 * The set of session ids THIS parse folded into a root as a subagent — the
 * fold's OWN emitted child set, which is the only key revision 62 sanctions for
 * pruning.
 *
 * Deliberately NOT derived from the raw `parent_id` column: `foldOpencodeSubagents`
 * RE-EMITS an orphaned child (unknown or cyclic parent, or a root that failed to
 * parse) as a top-level session, and `deleteSessionRow` cascades irreversibly
 * across ~20 session-keyed tables. Any id that came back as a top-level session
 * in the same parse is therefore excluded here, so a re-emitted orphan can never
 * be pruned.
 */
export function foldedChildSessionIdsFromParse(
  sessions: readonly NormalizedSession[]
): Set<string> {
  const topLevelIds = new Set(sessions.map((session) => session.sessionId));
  const foldedChildIds = new Set<string>();
  for (const session of sessions) {
    for (const subagent of session.subagents ?? []) {
      const childSessionId = subagent.childSessionId;
      if (childSessionId && !topLevelIds.has(childSessionId)) {
        foldedChildIds.add(childSessionId);
      }
    }
  }
  return foldedChildIds;
}

/**
 * Delete the surviving top-level row of every session THIS parse folded into a
 * root.
 *
 * Deleting is only sound because the id comes from the current parse: the fold
 * itself says the session is a subagent of that root and is not top level, so a
 * lingering top-level row for it is stale by construction. A delete that throws
 * is logged and counted and the id is LEFT pending so a later boot retries it
 * (mirrors `deleteFoldedChildren` in collector-manager-pass-scan.ts); it is
 * never fatal to the rest of the rebuild.
 */
export async function pruneFoldedChildRows(
  input: FoldedChildPruneInput
): Promise<FoldedChildPruneResult> {
  const {
    harness,
    sessions,
    pending,
    deleteSessionRow,
    log,
    pauseAfterWrite,
    shouldContinue,
  } = input;
  const result: FoldedChildPruneResult = { deletedIds: [], errors: 0 };
  for (const childSessionId of foldedChildSessionIdsFromParse(sessions)) {
    if (!pending.has(childSessionId)) {
      continue;
    }
    if (!shouldContinue()) {
      return result;
    }
    try {
      await deleteSessionRow(childSessionId);
    } catch (error) {
      result.errors++;
      log(
        `data-revision rebuild [${harness}]: folded-child cleanup failed for ${childSessionId}: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
    result.deletedIds.push(childSessionId);
    pending.delete(childSessionId);
    await pauseAfterWrite();
    log(
      `data-revision rebuild [${harness}]: deleted pre-fold subagent row ${childSessionId} (the current parser folds it into its root)`
    );
  }
  return result;
}
