import type { BranchPageDetail } from "@repo/api/src/types/branch";

/**
 * A branch's changed-LOC, read from the cloud branch projection.
 *
 * PLN-1535 M5.3 removed the live `/pr/files` gateway lane that used to be
 * preferred over the projection, so there is now exactly ONE source: the
 * `apps/api` branch read service, which resolves `additions`/`deletions` from
 * the connected PR's diff stats or the per-file cache (`branch-loc.ts`) and
 * preserves null rather than fabricating a count. The old `source` discriminator
 * ("github" live vs "local" enrichment) went with that lane — with one source
 * left, a per-render provenance label would claim knowledge the client no longer
 * has.
 *
 * `null` therefore means UNAVAILABLE — never zero. Consumers render "—".
 */
export type PreferredBranchLoc = {
  additions: number | null;
  deletions: number | null;
  /**
   * Total code churn: additions + DELETIONS. Removed lines are work delivered,
   * so they ADD to the total — this is gross churn, never a net figure. (It was
   * called `netLoc` while carrying exactly this sum, which read as though
   * deletions were subtracted.)
   */
  churn: number | null;
};

/**
 * Resolve a branch's changed-LOC from the projection. Single source of truth for
 * the detail page's LOC consumers (value-per-$ cards, the properties Changes
 * row, the PR activity timeline), so one branch cannot report two sizes.
 *
 * Tolerates a null/undefined `detail` — the page resolves this before its first
 * read lands — and requires BOTH dimensions to be present: with only one side
 * populated, "+10 −0" would fabricate the other.
 */
export function resolvePreferredBranchLoc(
  detail: BranchPageDetail | null | undefined
): PreferredBranchLoc {
  if (detail && detail.additions != null && detail.deletions != null) {
    return {
      additions: detail.additions,
      deletions: detail.deletions,
      churn: detail.additions + detail.deletions,
    };
  }
  return { additions: null, deletions: null, churn: null };
}

/**
 * Total code churn for a leaf component that accepts an optional pre-resolved
 * `loc`: prefer it when present, else fall back to the `detail` columns, else
 * null. Keeps the resolution in one place (no per-component nested ternary).
 */
export function resolveChurn(
  loc: PreferredBranchLoc | undefined,
  detail: BranchPageDetail
): number | null {
  if (loc) {
    return loc.churn;
  }
  if (detail.additions != null && detail.deletions != null) {
    return detail.additions + detail.deletions;
  }
  return null;
}
