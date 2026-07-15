"use client";

import type { BranchPageDetail } from "@repo/api/src/types/branch";
import { useQuery } from "@tanstack/react-query";
import { livePrFilesOptions } from "./live-pr-files";
import { derivePrIdentity } from "./pr-identity";

/**
 * A branch's changed-LOC, resolved with the connected PR's live totals PREFERRED
 * over enrichment-derived counts.
 *
 * - `source: "github"` — authoritative, from the PR's own `/pr/files` data.
 * - `source: "local"` — enrichment-derived `BranchPageDetail` counts (no v1
 *   producer yet, so usually absent).
 * - `source: null` — neither available; consumers render "—", never a 0.
 */
export type PreferredBranchLoc = {
  additions: number | null;
  deletions: number | null;
  /** Total changed lines (additions + deletions), matching the "net LOC" usage. */
  netLoc: number | null;
  source: "github" | "local" | null;
};

/**
 * Resolve a branch's changed-LOC, preferring the connected PR's live totals over
 * enrichment. Single source of truth for the "PR LOC wins" rule across the
 * detail page (value-per-$ cards, the properties Changes row, …).
 *
 * Shares the `/pr/files` overlay query key with the files panel, so React Query
 * dedupes — one network fetch feeds every detail-page LOC consumer. Identity
 * gating mirrors the files panel: no PR / multiple PRs / no repo or PR URL
 * identity → no live data → enrichment fallback (never another branch's cached
 * totals).
 */
export function usePreferredBranchLoc(
  detail: BranchPageDetail | null | undefined,
  options?: { enableLive?: boolean }
): PreferredBranchLoc {
  // Called unconditionally (Rules of Hooks) even while `detail` is still loading
  // at the page level — a null identity disables the query until it arrives.
  const enableLive = options?.enableLive ?? true;
  const identity =
    enableLive && detail
      ? derivePrIdentity({
          repoFullName: detail.repoFullName,
          prUrl: detail.prUrl,
          prNumber: detail.prNumber,
          multiPrWarning: detail.multiPrWarning,
        })
      : null;
  const filesQuery = useQuery(livePrFilesOptions(identity));
  const live = identity ? (filesQuery.data ?? null) : null;

  if (live) {
    return {
      additions: live.additions,
      deletions: live.deletions,
      netLoc: live.additions + live.deletions,
      source: "github",
    };
  }

  if (detail && detail.additions != null && detail.deletions != null) {
    return {
      additions: detail.additions,
      deletions: detail.deletions,
      netLoc: detail.additions + detail.deletions,
      source: "local",
    };
  }

  return { additions: null, deletions: null, netLoc: null, source: null };
}

/**
 * Net LOC for a leaf component that accepts an optional pre-resolved `loc`:
 * prefer it when present, else fall back to the `detail` enrichment columns,
 * else null. Keeps the "PR wins" preference in one place (no per-component
 * nested ternary).
 */
export function resolveNetLoc(
  loc: PreferredBranchLoc | undefined,
  detail: BranchPageDetail
): number | null {
  if (loc) {
    return loc.netLoc;
  }
  if (detail.additions != null && detail.deletions != null) {
    return detail.additions + detail.deletions;
  }
  return null;
}
