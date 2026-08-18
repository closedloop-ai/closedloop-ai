// Per-branch LOC dedup for cross-session KLOC aggregation (FEA-3633).
//
// PROBLEM. When per-commit enrichment is unavailable (e.g. RTK strips commit
// SHAs), a session's local-git LOC falls back to the linked branch/PR artifact's
// FULL total (`lines_added/removed`). That branch total is attributed to EVERY
// authoring session on the branch. So when N authoring sessions share one branch
// and a component is used across them, summing each session's LOC counts the same
// branch total N times — the same code counted N times.
//
// DECISION (Mike, FEA-3633). LOC basis = "branch-total, DEDUP PER BRANCH." KEEP
// the branch/PR-total fallback (it's the only signal when commits aren't
// enriched), but in any aggregation that sums session LOC across MULTIPLE
// sessions, a branch whose LOC came from the fallback contributes its total ONCE
// per branch, not once per authoring session. Authored-commit LOC (the priority-1
// path, `loc_source = "git"`) stays per-session and sums normally. A single
// session on a branch is unchanged (its one fallback total counts once).
//
// This helper is the SINGLE SSOT for that dedup, shared by the cloud aggregations
// (`computeLocPerDollar` in agent-components/service.ts, `sumScalars` in
// cohort-performance.ts) and the desktop twin (shared-agent-components-api.ts) so
// every KLOC surface agrees.

/** NUL joins repo + branch: neither can contain it, so the key is unambiguous. */
const BRANCH_KEY_SEP = "\u0000";

/** One session's LOC contribution with the provenance needed to dedup it. */
export type SessionLocEntry = {
  /** Added + removed local-git lines for the session (>= 0). */
  loc: number;
  /**
   * `SessionDetail.loc_source` / `gitDiffStats.source`. When it marks a
   * branch/PR-total fallback (`branch_fallback`), the `loc` is a whole-branch
   * total shared across the branch's sessions and must be deduped per branch.
   */
  locSource: string | null | undefined;
  /**
   * Repository full name for the session's fallback branch, when known. Combined
   * with `branch` to key the dedup. Null/undefined ⇒ the branch cannot be keyed.
   */
  repositoryFullName?: string | null;
  /** Branch name for the session's fallback LOC, when known. */
  branch?: string | null;
};

/**
 * Sum LOC across a set of sessions with per-branch dedup of the branch/PR-total
 * fallback. Commit-sourced LOC (`loc_source` !== "branch_fallback") sums normally
 * per session. Fallback-sourced LOC is grouped by `(repositoryFullName, branch)`
 * and each such branch contributes its total ONCE.
 *
 * Dedup-safety guards (never drop legitimately-distinct LOC):
 * - A fallback row whose branch cannot be keyed (missing repo or branch) is NOT
 *   collapsed — it sums per session, because we cannot prove two such rows are the
 *   same branch. (This over-counts at worst, never under-counts / silently drops.)
 * - Only the FALLBACK source is deduped. A `git` (authored-commit) row on the same
 *   branch is genuinely distinct per-session work and always sums.
 * - When two fallback sessions on the same branch report DIFFERENT totals (e.g. a
 *   branch grew between syncs), the MAX is kept — the most complete observation of
 *   that one branch — never the sum, and never a silent drop of the larger value.
 */
export function sumSessionLocDedupedByBranch(
  entries: Iterable<SessionLocEntry>
): number {
  let total = 0;
  // branchKey -> max observed fallback total for that branch
  const fallbackByBranch = new Map<string, number>();
  for (const entry of entries) {
    const loc = Number.isFinite(entry.loc) && entry.loc > 0 ? entry.loc : 0;
    if (loc === 0) {
      continue;
    }
    const branchKey = fallbackBranchKey(entry);
    if (branchKey === null) {
      // Commit-sourced, or fallback that cannot be branch-keyed: sum per session.
      total += loc;
      continue;
    }
    const prior = fallbackByBranch.get(branchKey);
    if (prior === undefined || loc > prior) {
      fallbackByBranch.set(branchKey, loc);
    }
  }
  for (const branchTotal of fallbackByBranch.values()) {
    total += branchTotal;
  }
  return total;
}

/**
 * The dedup key for a fallback-sourced entry, or `null` when the entry must sum
 * per-session (commit-sourced, or a fallback whose branch can't be keyed).
 */
function fallbackBranchKey(entry: SessionLocEntry): string | null {
  if (!isBranchFallbackLocSource(entry.locSource)) {
    return null;
  }
  const repo = entry.repositoryFullName;
  const branch = entry.branch;
  if (!(repo && branch)) {
    return null;
  }
  return `${repo}${BRANCH_KEY_SEP}${branch}`;
}

/**
 * `gitDiffStats.source` / `SessionDetail.loc_source` marker values.
 *
 * - `GIT` — the LOC are the session's own authored-commit sums (priority-1 path
 *   in the desktop `gitLocRows` query). These are genuinely per-session and sum
 *   normally across a session set.
 * - `BRANCH_FALLBACK` — the LOC fell back to the linked branch/PR artifact's FULL
 *   total because per-commit enrichment was unavailable (e.g. RTK strips SHAs).
 *   That branch total is attributed to EVERY authoring session on the branch, so
 *   summing it once-per-session double-counts. Aggregations that sum session LOC
 *   across multiple sessions MUST count a branch's fallback LOC ONCE per branch
 *   (see `sumSessionLocDedupedByBranch`), while a single-session view keeps showing
 *   its own branch total (counted once for that one session).
 *
 * The string values are persisted in Postgres (`SessionDetail.loc_source`) and
 * synced on the wire (`gitDiffStats.source`), so they are a stable contract.
 */
export const LOC_SOURCE_GIT = "git";
export const LOC_SOURCE_BRANCH_FALLBACK = "branch_fallback";

/** True when a persisted `loc_source` marks the LOC as a branch/PR-total fallback. */
export function isBranchFallbackLocSource(
  locSource: string | null | undefined
): boolean {
  return locSource === LOC_SOURCE_BRANCH_FALLBACK;
}
