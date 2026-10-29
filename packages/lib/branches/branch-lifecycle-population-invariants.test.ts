/**
 * ISS-4503: the logical-QA pack's POPULATION invariants, held against the
 * production PR-lifecycle classifier rather than against prose.
 *
 * Two of the pack's four rules live here because `countPrLifecycle` is where
 * they are the same question asked twice: buckets that are not mutually
 * exclusive are exactly the buckets that can outgrow the corpus they were
 * counted from. `.claude/logical/discipline-core.md` states the rules; this
 * file is the executable form.
 *
 * NOT all of this is new ground. The sibling `branch-lifecycle-count.test.ts`
 * already pins four of the six `(state, merge-evidence)` cells one at a time,
 * including the FEA-4333 case. What it cannot give is a table that fails to
 * compile when the union grows: its cases are hand-picked, so a new
 * `GitHubPRState` member simply goes untested. `EXPECTED_LIFECYCLE` below is
 * that guard, and `(Merged, evidence)` and `(Closed, evidence)` are the two
 * cells nothing covered before.
 *
 * The corpus below is deliberately pinned AT the boundary — every branch
 * carries a connected PR, so a correct fold spends the whole population and
 * `sum(buckets) === corpus.length`. A bucket that double-counts one branch
 * therefore breaks the `<=` outright instead of eating slack.
 */

import { GitHubPRState } from "@repo/api/src/types/github-status";
import { describe, expect, it } from "vitest";
import {
  countPrLifecycle,
  derivePrLifecycle,
  PrLifecycle,
  type PrLifecycleCounts,
} from "./branch-lifecycle-count.ts";

type ClassifiableBranch = {
  prState: GitHubPRState | null;
  mergedAt: Date | string | null;
};

const MERGE_EVIDENCE = "2026-08-03T17:07:41.797Z";

/**
 * The classification every `(prState, mergedAt)` pair must produce, written as
 * literals rather than derived from the classifier, so the expectation cannot
 * agree with a regression in the code it polices.
 *
 * Typed `Record<GitHubPRState, …>`: a new member of the union fails `tsc` here
 * until someone states what it classifies as, which is the guard a hand-picked
 * fixture list cannot give.
 */
const EXPECTED_LIFECYCLE: Record<
  GitHubPRState,
  { withMergeEvidence: PrLifecycle; withoutMergeEvidence: PrLifecycle }
> = {
  [GitHubPRState.Open]: {
    // FEA-4333: merge evidence outranks a stale stored state.
    withMergeEvidence: PrLifecycle.Merged,
    withoutMergeEvidence: PrLifecycle.Active,
  },
  [GitHubPRState.Merged]: {
    withMergeEvidence: PrLifecycle.Merged,
    withoutMergeEvidence: PrLifecycle.Merged,
  },
  [GitHubPRState.Closed]: {
    withMergeEvidence: PrLifecycle.Merged,
    withoutMergeEvidence: PrLifecycle.Closed,
  },
};

/** Every `(state, merge-evidence)` cell, as branches a corpus can hold. */
function everyClassifiableCell(): ClassifiableBranch[] {
  return Object.values(GitHubPRState).flatMap((prState) => [
    { prState, mergedAt: MERGE_EVIDENCE },
    { prState, mergedAt: null },
  ]);
}

/**
 * Summed over `Object.values` of the canonical counts type rather than over a
 * hand-listed `active + merged + closed`, so a fourth bucket joins every
 * population comparison below by existing (marisolashgrove, review). An inline
 * shape re-declared here would be the same stale side inventory this file's
 * `EXPECTED_LIFECYCLE` exists to rule out, one layer down.
 */
function bucketTotal(counts: PrLifecycleCounts): number {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

describe("ISS-4503 invariant: mutually exclusive classifications do not overlap", () => {
  it("puts each state-and-merge-evidence pair in exactly one bucket", () => {
    for (const prState of Object.values(GitHubPRState)) {
      const expected = EXPECTED_LIFECYCLE[prState];
      expect(derivePrLifecycle({ prState, mergedAt: MERGE_EVIDENCE })).toBe(
        expected.withMergeEvidence
      );
      expect(derivePrLifecycle({ prState, mergedAt: null })).toBe(
        expected.withoutMergeEvidence
      );
    }
  });

  it("spends each branch of the full cross-product on one bucket and no more", () => {
    const corpus = everyClassifiableCell();
    const counts = countPrLifecycle(corpus);

    // Six cells, all carrying a connected PR, so a correct fold spends all six.
    expect(corpus).toHaveLength(6);
    expect(bucketTotal(counts)).toBe(corpus.length);
    // Stated as literals: one bare OPEN is the only active PR in the set, one
    // bare CLOSED the only closed one, and the remaining four are merged.
    expect(counts).toEqual({ active: 1, merged: 4, closed: 1 });
  });

  it("leaves a branch with no connected PR out of every bucket", () => {
    const counts = countPrLifecycle([
      { prState: null, mergedAt: null },
      { prState: null, mergedAt: null },
    ]);

    expect(counts).toEqual({ active: 0, merged: 0, closed: 0 });
  });
});

describe("ISS-4503 invariant: no count exceeds its parent population", () => {
  /**
   * A corpus of stale-open-but-merged PRs: `prState` still reads OPEN while
   * `mergedAt` says otherwise. It is the FEA-4333 population, and it pins the
   * invariant at its boundary — `merged` must equal the whole corpus, so
   * counting any branch twice pushes a bucket past the population it came from.
   */
  const staleOpenButMerged: ClassifiableBranch[] = [
    { prState: GitHubPRState.Open, mergedAt: MERGE_EVIDENCE },
    { prState: GitHubPRState.Open, mergedAt: MERGE_EVIDENCE },
    { prState: GitHubPRState.Open, mergedAt: MERGE_EVIDENCE },
  ];

  it("holds merged at the population size and active at zero for a wholly merged corpus", () => {
    const counts = countPrLifecycle(staleOpenButMerged);

    expect(counts).toEqual({ active: 0, merged: 3, closed: 0 });
    expect(counts.merged).toBe(staleOpenButMerged.length);
  });

  it("keeps every bucket and their total within the corpus that produced them", () => {
    const corpus = [
      ...staleOpenButMerged,
      { prState: GitHubPRState.Open, mergedAt: null },
      { prState: GitHubPRState.Closed, mergedAt: null },
      { prState: null, mergedAt: null },
    ];
    const counts = countPrLifecycle(corpus);

    expect(counts.active).toBeLessThanOrEqual(corpus.length);
    expect(counts.merged).toBeLessThanOrEqual(corpus.length);
    expect(counts.closed).toBeLessThanOrEqual(corpus.length);
    expect(bucketTotal(counts)).toBeLessThanOrEqual(corpus.length);
    // The connected-PR sub-population, stated as a literal: five of the six
    // branches carry a PR state or merge evidence.
    expect(bucketTotal(counts)).toBe(5);
  });

  it("keeps the merge-rate denominator inside the population it is drawn from", () => {
    const corpus = [
      ...staleOpenButMerged,
      { prState: GitHubPRState.Closed, mergedAt: null },
    ];
    const counts = countPrLifecycle(corpus);
    // `merged + closed` is the DECIDED denominator the card divides by.
    const decided = counts.merged + counts.closed;

    // Pinned at the boundary: every branch here is decided, so `decided` equals
    // the corpus. A fold that spends one branch on two buckets breaks the `<=`
    // rather than eating slack.
    //
    // Deliberately NOT `decided <= bucketTotal(counts)`: `bucketTotal` is
    // `active + merged + closed` over the same object, so that form holds for
    // any non-negative `active` and cannot fail. The parent population is the
    // falsifiable comparison, and the one this describe block is named for.
    expect(decided).toBeLessThanOrEqual(corpus.length);
    expect(decided).toBe(4);
  });
});
