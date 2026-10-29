/**
 * @file branch-pushed-loc-numerator.test.ts
 * @description ISS-9956/ISS-9957/ISS-9958 — Branches counts lines PUSHED to
 * origin, and the ratio divides by the cost figure shown beside it.
 *
 * These drive the real kernel (`calculateBranchListMetrics`), never a
 * re-implementation of its arithmetic. Every expected figure below is written
 * as an independent literal rather than recomputed from the inputs, so a kernel
 * that changed a term would move the answer away from the literal and fail
 * instead of following.
 */
import {
  BranchMetricAvailability,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import type {
  BranchListMetricInput,
  BranchMetricCostContribution,
} from "./branch-list-metrics";
import { calculateMetricsWithSpendFacts as calculateBranchListMetrics } from "./branch-list-metrics.test-helpers";
import { buildAdjacentBranchMetricWindows } from "./branch-metric-windows";
import {
  type BranchMetricLocContribution,
  BranchPublicationLocSource,
} from "./branch-publication-loc";

const NOW = new Date("2026-09-08T18:05:33.852Z");
const IN_WINDOW = "2026-09-07T12:00:00.000Z";
/** Two years before the 7-day window, so it cannot affect that window's total. */
const BEFORE_WINDOW = "2024-01-01T00:00:00.000Z";
const PUSHED_BRANCH = "branch-pushed";
const MERGED_ONLY_BRANCH = "branch-merged-only";

/** The pushed commit's gross lines: 900 added + 100 deleted. */
const PUSHED_LINES = 1000;
/** The merged-only commit's gross lines, which the pushed basis must exclude. */
const MERGED_ONLY_LINES = 500;
/** Dollars the cohort's single readable cost contribution carries. */
const COST_USD = 250;
/** 1000 pushed lines over $250. Written out, not derived from the two above. */
const PUSHED_LOC_PER_DOLLAR = 4;

function pushContribution(
  overrides: Partial<BranchMetricLocContribution> = {}
): BranchMetricLocContribution {
  return {
    sourceEventId: "successful-push:1",
    changeIdentity: "acme/repo:aaaa1111",
    branchId: PUSHED_BRANCH,
    occurredAt: IN_WINDOW,
    additions: 900,
    deletions: 100,
    source: BranchPublicationLocSource.SuccessfulPush,
    ...overrides,
  };
}

function mergedContribution(
  overrides: Partial<BranchMetricLocContribution> = {}
): BranchMetricLocContribution {
  return {
    sourceEventId: "merged-pr:1",
    changeIdentity: "acme/repo:bbbb2222",
    branchId: MERGED_ONLY_BRANCH,
    occurredAt: IN_WINDOW,
    additions: MERGED_ONLY_LINES,
    deletions: 0,
    source: BranchPublicationLocSource.MergedPullRequest,
    ...overrides,
  };
}

function costContribution(): BranchMetricCostContribution {
  return {
    sourceEventId: "cost-event-1",
    branchId: PUSHED_BRANCH,
    sessionId: "session-1",
    occurredAt: IN_WINDOW,
    costUsd: COST_USD,
    qualifyingBranchCount: 1,
  };
}

function inputWith(
  locContributions: readonly BranchMetricLocContribution[]
): BranchListMetricInput {
  return {
    cohortSize: 2,
    lastActiveEvents: [],
    lastActiveCoverageComplete: true,
    statusSnapshots: [PUSHED_BRANCH, MERGED_ONLY_BRANCH].map((branchId) => ({
      branchId,
      currentActive: true,
      priorActive: null,
      lastActivityAt: IN_WINDOW,
    })),
    locContributions,
    locCoverageComplete: true,
    locCompleteBranchIds: [PUSHED_BRANCH, MERGED_ONLY_BRANCH],
    pullRequests: [],
    pullRequestCoverageComplete: true,
    costContributions: [costContribution()],
    costCompleteBranchIds: [PUSHED_BRANCH, MERGED_ONLY_BRANCH],
  };
}

function bundleFor(input: BranchListMetricInput) {
  return calculateBranchListMetrics(
    input,
    buildAdjacentBranchMetricWindows(BranchMetricPeriod.All, NOW)
  );
}

/** The same kernel over a bounded window, for the window-scoping cases. */
function windowedBundleFor(input: BranchListMetricInput) {
  return calculateBranchListMetrics(
    input,
    buildAdjacentBranchMetricWindows(BranchMetricPeriod.SevenDays, NOW)
  );
}

describe("ISS-9957 the Branches numerator counts pushed lines only", () => {
  it("excludes merged-PR lines that no push observation represents", () => {
    const bundle = bundleFor(
      inputWith([pushContribution(), mergedContribution()])
    );

    // 1000, not the 1500 a push-OR-merge numerator sums. This is the whole
    // behavioural change: remove the source filter and this reads 1500.
    expect(bundle.totalLocPushed?.current.value).toBe(PUSHED_LINES);
  });

  it("marks the total incomplete when merged evidence has no push sibling", () => {
    const bundle = bundleFor(
      inputWith([pushContribution(), mergedContribution()])
    );

    // The omitted merged lines are real published lines, so the figure is short
    // by a knowable amount — a disclosed Partial, never a confident Complete
    // carrying a smaller number.
    expect(bundle.totalLocPushed?.current.state).toBe(
      BranchMetricAvailability.Partial
    );
  });

  it("counts a commit that was both pushed and merged exactly once", () => {
    const bundle = bundleFor(
      inputWith([
        pushContribution(),
        // The merged twin of the SAME commit: one change identity, one set of
        // line counts. Reconciliation fuses these; the filter must not turn the
        // pair into two contributions.
        mergedContribution({
          sourceEventId: "merged-pr:same-commit",
          changeIdentity: "acme/repo:aaaa1111",
          branchId: PUSHED_BRANCH,
          additions: 900,
          deletions: 100,
        }),
      ])
    );

    expect(bundle.totalLocPushed?.current.value).toBe(PUSHED_LINES);
    // Every change is represented by a push, so nothing is missing.
    expect(bundle.totalLocPushed?.current.state).toBe(
      BranchMetricAvailability.Complete
    );
  });

  /**
   * The desktop local projection emits merged-PR rows only. Summing those to
   * `0` would publish "nothing was pushed" from evidence that cannot speak to
   * pushes — the fabricated-figure outcome the operator ruled out when he chose
   * "desktop reads the cloud figure".
   */
  it("is unavailable, never zero, when no push evidence exists at all", () => {
    const bundle = bundleFor(inputWith([mergedContribution()]));

    // One deepEqual, so a future `value: 0` beside an Unavailable state cannot
    // slip through a per-key check.
    expect(bundle.totalLocPushed?.current).toEqual({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    });
  });

  /**
   * Reconciliation runs over the WHOLE evidence set before the push filter, so
   * a push and a merged observation of one commit that disagree about the line
   * counts still cancel each other. Filtering to the push arm first would hide
   * the disagreement from the only code that detects it and sum the push row as
   * fact; dropping the change and then summing the survivors to `0` would be
   * the opposite error, reporting "nothing pushed" from contested evidence.
   */
  it("withholds a total when every pushed change is contested", () => {
    const bundle = bundleFor(
      inputWith([
        pushContribution(),
        mergedContribution({
          sourceEventId: "merged-pr:disagrees",
          changeIdentity: "acme/repo:aaaa1111",
          branchId: PUSHED_BRANCH,
          additions: 4242,
          deletions: 0,
        }),
      ])
    );

    expect(bundle.totalLocPushed?.current).toEqual({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    });
  });

  it("treats an untagged contribution as unproven rather than as a push", () => {
    const bundle = bundleFor(
      inputWith([pushContribution(), mergedContribution({ source: undefined })])
    );

    expect(bundle.totalLocPushed?.current.value).toBe(PUSHED_LINES);
    expect(bundle.totalLocPushed?.current.state).toBe(
      BranchMetricAvailability.Partial
    );
  });

  /**
   * whitlockk review: the completeness verdict is about THIS window's total. A
   * merged-only row from two years ago cannot change what the 7-day window
   * counted, so letting it turn a fully covered window Partial discloses a gap
   * that is not there. Drop the window scoping and this reads Partial.
   */
  it("stays complete when the only unpushed merged row predates the window", () => {
    const bundle = windowedBundleFor(
      inputWith([
        pushContribution(),
        mergedContribution({ occurredAt: BEFORE_WINDOW }),
      ])
    );

    expect(bundle.totalLocPushed?.current.value).toBe(PUSHED_LINES);
    expect(bundle.totalLocPushed?.current.state).toBe(
      BranchMetricAvailability.Complete
    );
  });

  /**
   * davetho review: a malformed push is dropped by reconciliation, so its
   * change identity is NOT proven pushed. Crediting it anyway lets the merged
   * sibling that survives reconciliation match that identity and have its lines
   * summed as pushed — 1500 rather than 1000.
   */
  it("does not count a merged row as pushed when its push twin is malformed", () => {
    const bundle = bundleFor(
      inputWith([
        pushContribution(),
        pushContribution({
          sourceEventId: "successful-push:malformed",
          changeIdentity: "acme/repo:cccc3333",
          branchId: MERGED_ONLY_BRANCH,
          // Reconciliation refuses a negative line count, so this row is
          // dropped and nothing proves that change was ever pushed.
          additions: -1,
        }),
        mergedContribution({
          sourceEventId: "merged-pr:malformed-push-twin",
          changeIdentity: "acme/repo:cccc3333",
          branchId: MERGED_ONLY_BRANCH,
          additions: MERGED_ONLY_LINES,
          deletions: 0,
        }),
      ])
    );

    expect(bundle.totalLocPushed?.current.value).toBe(PUSHED_LINES);
  });
});

describe("ISS-9958 LOC per $ divides the spend figure shown beside it", () => {
  it("reconciles with the LOC total and the spend total on the same bundle", () => {
    const bundle = bundleFor(inputWith([pushContribution()]));

    // Three independent literals rather than one re-derivation: the ratio, its
    // numerator, and its denominator are each pinned, so a change to any one
    // term breaks this instead of being absorbed by recomputing the others.
    expect(bundle.totalLocPushed?.current.value).toBe(PUSHED_LINES);
    expect(bundle.aiSpendUsd.current.value).toBe(COST_USD);
    expect(bundle.pushedLocPerDollar?.current.value).toBe(
      PUSHED_LOC_PER_DOLLAR
    );
  });

  /**
   * The shipped companion returns `null` on incomplete coverage, which is how
   * the card came to be absent from the row. Incomplete evidence must now yield
   * a disclosed number instead of a refusal.
   */
  it("still publishes a ratio when the pushed total is incomplete", () => {
    const bundle = bundleFor(
      inputWith([pushContribution(), mergedContribution()])
    );

    expect(bundle.pushedLocPerDollar?.current.state).toBe(
      BranchMetricAvailability.Partial
    );
    expect(bundle.pushedLocPerDollar?.current.value).toBe(
      PUSHED_LOC_PER_DOLLAR
    );
  });

  it("withholds the ratio rather than inventing one with no push evidence", () => {
    const bundle = bundleFor(inputWith([mergedContribution()]));

    expect(bundle.pushedLocPerDollar?.current).toEqual({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    });
  });
});
