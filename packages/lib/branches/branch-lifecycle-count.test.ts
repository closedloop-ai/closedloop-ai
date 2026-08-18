import { GitHubPRState } from "@repo/api/src/types/github-status";
import { describe, expect, it } from "vitest";
import {
  countPrLifecycle,
  derivePrLifecycle,
  PrLifecycle,
} from "./branch-lifecycle-count";

describe("derivePrLifecycle", () => {
  it("classifies a genuinely-open PR (no merge evidence) as active", () => {
    expect(
      derivePrLifecycle({ prState: GitHubPRState.Open, mergedAt: null })
    ).toBe(PrLifecycle.Active);
  });

  it("classifies a MERGED-state PR as merged", () => {
    expect(
      derivePrLifecycle({ prState: GitHubPRState.Merged, mergedAt: null })
    ).toBe(PrLifecycle.Merged);
  });

  it("classifies a closed (unmerged) PR as closed", () => {
    expect(
      derivePrLifecycle({ prState: GitHubPRState.Closed, mergedAt: null })
    ).toBe(PrLifecycle.Closed);
  });

  it("lets merge evidence (mergedAt) win over a stale OPEN state — FEA-4333", () => {
    // The core bug: a PR whose stored state is still OPEN but which carries a
    // non-null mergedAt is merged by GitHub semantics. It must classify as merged,
    // NOT active, so it can never be double-counted.
    expect(
      derivePrLifecycle({
        prState: GitHubPRState.Open,
        mergedAt: new Date("2026-07-03T09:13:00.000Z"),
      })
    ).toBe(PrLifecycle.Merged);
  });

  it("accepts an ISO-string mergedAt as merge evidence", () => {
    expect(
      derivePrLifecycle({
        prState: GitHubPRState.Open,
        mergedAt: "2026-07-03T09:13:00.000Z",
      })
    ).toBe(PrLifecycle.Merged);
  });

  it("returns null for a branch with no connected PR", () => {
    expect(derivePrLifecycle({ prState: null, mergedAt: null })).toBeNull();
  });
});

describe("countPrLifecycle", () => {
  it("a stale-open-but-merged PR counts ONLY as merged, never active — FEA-4333", () => {
    const counts = countPrLifecycle([
      // stale-open + mergedAt → merged only
      {
        prState: GitHubPRState.Open,
        mergedAt: new Date("2026-07-03T09:13:00.000Z"),
      },
      // genuinely open (no mergedAt) → active only
      { prState: GitHubPRState.Open, mergedAt: null },
    ]);
    expect(counts.merged).toBe(1);
    expect(counts.active).toBe(1);
    expect(counts.closed).toBe(0);
  });

  it("counts each connected PR in exactly one bucket and omits no-PR branches", () => {
    const counts = countPrLifecycle([
      { prState: GitHubPRState.Open, mergedAt: null },
      { prState: GitHubPRState.Merged, mergedAt: null },
      {
        prState: GitHubPRState.Open,
        mergedAt: new Date("2026-07-03T09:13:00.000Z"),
      },
      { prState: GitHubPRState.Closed, mergedAt: null },
      // no connected PR → counted in no bucket
      { prState: null, mergedAt: null },
    ]);
    expect(counts).toEqual({ active: 1, merged: 2, closed: 1 });
    // Mutual exclusivity: the buckets sum to the number of connected PRs (4), the
    // no-PR branch excluded.
    expect(counts.active + counts.merged + counts.closed).toBe(4);
  });

  it("returns all-zero counts for an empty corpus", () => {
    expect(countPrLifecycle([])).toEqual({ active: 0, merged: 0, closed: 0 });
  });
});
