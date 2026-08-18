import type { SessionLocEntry } from "@repo/api/src/utils/session-loc";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";

/**
 * The desktop-local LOC derivations behind the "LOC/$" metric (FEA-3090 /
 * FEA-3633 / FEA-4250 / ISS-4667). Extracted from `shared-agent-sessions-api.ts`
 * (ISS-4667) so the question "which lines does this ratio divide cost into?" is
 * answered in one small module instead of inside the serving-op composition root
 * — and so that grandfathered file shrinks. Pure derivations: no source loads, no
 * token summing, no I/O.
 */

/**
 * Per-session local-git LOC + estimated cost, keyed by session id (FEA-3090).
 *
 * FEA-3633: extends the dedup helper's `SessionLocEntry` (loc + provenance:
 * locSource / repositoryFullName / branch) with `cost`, so the per-branch
 * fallback-dedup shape is defined once in the SSOT and stays identical to the
 * cloud's `SessionLocCost` (apps/api/app/agent-components). When `locSource ===
 * "branch_fallback"` the `loc` is a whole-branch total shared across the branch's
 * authoring sessions, so a cross-session sum must count it once per
 * (repositoryFullName, branch), not once per session.
 */
export type SharedAgentSessionLocCost = SessionLocEntry & { cost: number };

/**
 * Authored local-git lines changed for a session (added + removed), preferring
 * the source-tagged `gitDiffStats` and falling back to the loose top-level
 * scalars — the same precedence the cloud applies when persisting
 * `SessionDetail.linesAdded/linesRemoved` (apps/api/app/agent-sessions).
 */
export function sessionLocalGitLoc(session: SyncedAgentSession): number {
  const git = session.gitDiffStats;
  const added = git?.linesAdded ?? session.linesAdded ?? 0;
  const removed = git?.linesRemoved ?? session.linesRemoved ?? 0;
  return added + removed;
}

/**
 * ISS-4667 (wongk review): the numerator the LOCAL LOC/$ projection divides cost
 * into. It must reconcile with the "Lines changed" the shared detail view prints
 * from `sessionOutputDiffDisplay` — otherwise a merged multi-PR session whose
 * local working-tree diff has collapsed to a tiny residual (56 lines) shows a big
 * branch "Lines changed" (4,004) yet a `locPerDollar` computed by dividing cost
 * into 56, so the ratio and the lines it claims to be over disagree.
 *
 * The shared display weighs `max(localDiff, branchDiff, authoredPrLoc)`. The Local
 * surface carries no per-PR LOC (`authoredPrLinesChanged` is unavailable on the
 * local `SessionPR`), so both the shared display AND this numerator resolve to
 * `max(localDiff, branchDiff)` here — they reconcile by construction. When the
 * cloud serves the detail its richer authored-PR roll-up wins in BOTH places, so
 * this local basis never contradicts the cloud contract; it just uses the largest
 * signal actually available locally.
 */
export function sessionLocPerDollarNumeratorLoc(
  session: SyncedAgentSession
): number {
  const branch = session.branchDiffStats;
  const branchLoc = (branch?.linesAdded ?? 0) + (branch?.linesRemoved ?? 0);
  return Math.max(sessionLocalGitLoc(session), branchLoc);
}

/**
 * Projects one session into its `{ loc, cost, provenance }` entry. `estimatedCost`
 * is the caller's summed per-model token cost (`sumTokenUsage`), passed in so this
 * module stays a pure derivation over the session row.
 */
export function sessionLocCost(
  session: SyncedAgentSession,
  estimatedCost: number
): SharedAgentSessionLocCost {
  return {
    loc: sessionLocalGitLoc(session),
    cost: estimatedCost,
    // FEA-3633: mirror the cloud's `loc_source` provenance so the desktop LOC/$
    // dedups the branch/PR-total fallback per branch exactly as the cloud does.
    // The authored gitDiffStats.source carries the "git" | "branch_fallback" tag;
    // loose top-level scalars have no tag (null), matching `resolveLocSourcePatch`
    // in apps/api/app/agent-sessions/service/persist-session-children.ts.
    locSource: session.gitDiffStats?.source ?? null,
    repositoryFullName: session.attribution?.repositoryFullName ?? null,
    branch: session.branch ?? null,
  };
}
