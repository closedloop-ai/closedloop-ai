/**
 * The canonical PR-lifecycle classifier + counter, shared by both branch
 * analytics producers so the ONE cross-surface card cannot re-diverge:
 *
 * - web  — apps/api/app/branches/branch-read-service.ts (`getBranchAnalytics`)
 * - desktop — apps/desktop/src/main/branch/branch-analytics-projection.ts
 *
 * FEA-4333: the active-PR count and the merged count are MUTUALLY EXCLUSIVE
 * lifecycle KPIs, so they must classify each branch's PR from ONE signal — the
 * connected PR state resolved with MERGE EVIDENCE taking precedence. A PR whose
 * stored `prState` is still `"OPEN"` but which carries a non-null `mergedAt` is
 * merged by GitHub semantics; counting `active` off the raw `prState` while
 * counting `merged` off a merge-aware signal let that same stale-open-but-merged
 * PR land in BOTH KPIs. `derivePrLifecycle` folds `mergedAt` into the state
 * (mirroring the desktop importer's `derivePrState`) so a stale-open-but-merged
 * PR classifies as `merged`, never `active`, on both surfaces.
 *
 * This classifies the connected PR's lifecycle only — a branch with NO connected
 * PR is `null` here (it contributes to neither the active-PR nor the merged
 * count), which is exactly the cross-surface "Merged PRs" contract (FEA-3089): a
 * local-status merge with no connected MERGED PR is not a "Merged PR".
 *
 * Lives in `@repo/lib` — Node-safe, no server-only deps — the same home as the
 * sibling `merged-trace` / `value-per-dollar` kernels both surfaces already
 * import.
 */

import { GitHubPRState } from "@repo/api/src/types/github-status";

/**
 * The mutually-exclusive lifecycle bucket a connected PR falls into. A PR
 * resolves to exactly one — the property that guarantees the active-PR and merged
 * counts can never both count the same PR (FEA-4333).
 */
export const PrLifecycle = {
  /** OPEN and carrying no merge evidence — a genuinely active PR. */
  Active: "active",
  /** Merged — merge evidence (`mergedAt`) OR a MERGED state won. */
  Merged: "merged",
  /** Closed without merging. */
  Closed: "closed",
} as const;
export type PrLifecycle = (typeof PrLifecycle)[keyof typeof PrLifecycle];

/**
 * Resolves a connected PR's lifecycle from its state and merge evidence, with a
 * non-null `mergedAt` taking precedence over a stale `prState` (FEA-4333). This
 * mirrors the desktop importer's `derivePrState` (`shared-branches-api.ts`) so
 * both surfaces classify a stale-open-but-merged PR identically. Returns `null`
 * when there is no connected PR state to classify.
 *
 * Exhaustive over the closed `GitHubPRState` union: a newly-added PR state fails
 * typecheck at the `never` guard rather than silently miscounting.
 */
export function derivePrLifecycle(input: {
  prState: GitHubPRState | null;
  mergedAt: Date | string | null;
}): PrLifecycle | null {
  // Merge evidence wins over a stale connected state — the FEA-4333 fix.
  if (input.mergedAt != null) {
    return PrLifecycle.Merged;
  }
  if (input.prState === null) {
    return null;
  }
  switch (input.prState) {
    case GitHubPRState.Merged:
      return PrLifecycle.Merged;
    case GitHubPRState.Closed:
      return PrLifecycle.Closed;
    case GitHubPRState.Open:
      return PrLifecycle.Active;
    default:
      return assertUnreachablePrState(input.prState);
  }
}

/**
 * Per-lifecycle PR counts — each connected PR counted in exactly one bucket,
 * branches with no connected PR omitted entirely.
 */
export type PrLifecycleCounts = {
  active: number;
  merged: number;
  closed: number;
};

/**
 * Counts a branch corpus into its mutually-exclusive PR-lifecycle buckets, each
 * connected PR classified with merge evidence taking precedence. A branch with no
 * connected PR (both fields absent → `derivePrLifecycle` returns `null`) is not
 * counted in any bucket. `activePrCount` on the card is `active`; the merged count
 * numerator and the merge-rate DECIDED denominator (`merged + closed`) derive from
 * the same buckets, so the KPIs cannot disagree for one corpus.
 */
export function countPrLifecycle(
  branches: readonly {
    prState: GitHubPRState | null;
    mergedAt: Date | string | null;
  }[]
): PrLifecycleCounts {
  const counts: PrLifecycleCounts = { active: 0, merged: 0, closed: 0 };
  for (const branch of branches) {
    const lifecycle = derivePrLifecycle(branch);
    if (lifecycle !== null) {
      counts[lifecycle] += 1;
    }
  }
  return counts;
}

function assertUnreachablePrState(state: never): never {
  throw new Error(`Unhandled GitHubPRState: ${String(state)}`);
}
