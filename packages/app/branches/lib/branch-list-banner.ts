import type { BranchRow } from "@repo/api/src/types/branch";

/**
 * Informational banner for the Branches list (Epic B / B2), derived from the
 * wire rows so the desktop view (and a future web surface) share one rule:
 *
 * - `"connect-github"`: no repo identity across the whole corpus → GitHub
 *   enrichment can never populate, so prompt to connect GitHub.
 * - `"net-new"`: repos are present but NO row has a linked PR → every branch is
 *   net-new local work, so the metrics shown are net-new.
 * - `null`: at least one row carries a PR (or there are no rows — the list
 *   renders its own loading/empty states), so neither banner applies.
 *
 * Connect-GitHub takes precedence over net-new (no repo ⊃ no PR).
 */
export type BranchListBanner = "connect-github" | "net-new" | null;

export function resolveBranchListBanner(
  rows: Pick<BranchRow, "repoFullName" | "prNumber">[]
): BranchListBanner {
  if (rows.length === 0) {
    return null;
  }
  if (rows.every((row) => row.repoFullName == null)) {
    return "connect-github";
  }
  if (rows.every((row) => row.prNumber == null)) {
    return "net-new";
  }
  return null;
}
