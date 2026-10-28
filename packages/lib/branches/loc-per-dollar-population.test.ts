/**
 * @file loc-per-dollar-population.test.ts
 * @description ISS-9972 — the Branches LOC/$ ratio has ONE denominator, and no
 * flag selects which arithmetic it performs.
 *
 * This file was ISS-9732's, whose flag-selected `populationMatchedLocPerDollar`
 * companion published a second, differently-scoped ratio beside the shipped
 * one. ISS-9972 retires that companion outright — a flag may gate whether a
 * surface ships, never which dollars a shipped ratio divides by — so the cases
 * that drove the companion are gone with their subject. What survives here is
 * the coverage of the SHIPPED field the companion was measured against.
 *
 * THE REAL CASE those constants came from. `GET /branches/analytics` in
 * production returned `canonicalMetrics.locPerDollar = { state: "partial",
 * value: 123649.21… }` beside `aiSpendUsd = { state: "partial", value:
 * 20.39018263333334 }` over a `cohortSize` of 640, while the legacy whole-org
 * `totalSpendUsd` for the same corpus read `163834.34840199968`. Multiplying
 * the ratio by the denominator recovers an exact integer line count —
 * 2,521,230 — which is what proves the mechanism: verified publication LOC was
 * summed over the FULL cohort while qualifying Session cost was summed over
 * only the cost-KNOWN subset.
 *
 * The constants below are those production readings, pinned as literals. They
 * are NOT re-derived from the kernel: {@link PRODUCTION_COHORT_LOC} is the
 * numerator the response implies and {@link PRODUCTION_KNOWN_COST_USD} is the
 * denominator it published, so a kernel that changed either term would move the
 * expected value away from the observed one and fail rather than follow.
 *
 * These tests drive the real kernel (`calculateBranchListMetrics`), never a
 * re-implementation of its arithmetic.
 */
import {
  BranchMetricAvailability,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { locPerDollarFromLines } from "@repo/api/src/utils/loc-per-dollar";
import { describe, expect, it } from "vitest";
import {
  type BranchListMetricInput,
  type BranchMetricCostContribution,
  calculateBranchListMetrics,
} from "./branch-list-metrics";
import { buildAdjacentBranchMetricWindows } from "./branch-metric-windows";
import type { BranchMetricLocContribution } from "./branch-publication-loc";

const NOW = new Date("2026-09-08T18:05:33.852Z");
const IN_WINDOW = "2026-09-07T12:00:00.000Z";
const COVERED_BRANCH = "branch-cost-known";
const UNCOVERED_BRANCH = "branch-cost-unknown";

/** Lines the production cohort's numerator summed (123649.21125710574 × 20.39018263333334). */
const PRODUCTION_COHORT_LOC = 2_521_230;

/** Dollars the production denominator summed — the cost-KNOWN subset only. */
const PRODUCTION_KNOWN_COST_USD = 20.390_182_633_333_34;

/** The inflated ratio the card actually printed. */
const PRODUCTION_RENDERED_RATIO = 123_649.211_257_105_74;

function costContribution(
  overrides: Partial<BranchMetricCostContribution> = {}
): BranchMetricCostContribution {
  return {
    sourceEventId: "cost-event-1",
    branchId: COVERED_BRANCH,
    sessionId: "session-1",
    occurredAt: IN_WINDOW,
    costUsd: PRODUCTION_KNOWN_COST_USD,
    qualifyingBranchCount: 1,
    ...overrides,
  };
}

function locContribution(
  overrides: Partial<BranchMetricLocContribution> = {}
): BranchMetricLocContribution {
  return {
    sourceEventId: "publication-1",
    branchId: COVERED_BRANCH,
    occurredAt: IN_WINDOW,
    additions: PRODUCTION_COHORT_LOC,
    deletions: 0,
    ...overrides,
  };
}

/**
 * The production shape, reduced to its smallest reproducing cohort: TWO
 * branches, both LOC-complete, only ONE of which has cost evidence.
 */
function partialCostCoverageInput(): BranchListMetricInput {
  return {
    cohortSize: 2,
    lastActiveEvents: [],
    lastActiveCoverageComplete: true,
    statusSnapshots: [COVERED_BRANCH, UNCOVERED_BRANCH].map((branchId) => ({
      branchId,
      currentActive: true,
      priorActive: null,
      lastActivityAt: IN_WINDOW,
    })),
    locContributions: [locContribution()],
    locCoverageComplete: true,
    locCompleteBranchIds: [COVERED_BRANCH, UNCOVERED_BRANCH],
    pullRequests: [],
    pullRequestCoverageComplete: true,
    costContributions: [costContribution()],
    costCompleteBranchIds: [COVERED_BRANCH],
    locPerDollarCostCoverageComplete: false,
  };
}

/** The same cohort with cost evidence for BOTH branches: one whole population. */
function completeCoverageInput(
  coveredCostUsd: number,
  uncoveredCostUsd: number
): BranchListMetricInput {
  return {
    ...partialCostCoverageInput(),
    costContributions: [
      costContribution({ costUsd: coveredCostUsd }),
      costContribution({
        sourceEventId: "cost-event-2",
        branchId: UNCOVERED_BRANCH,
        sessionId: "session-2",
        costUsd: uncoveredCostUsd,
      }),
    ],
    costCompleteBranchIds: [COVERED_BRANCH, UNCOVERED_BRANCH],
    locPerDollarCostCoverageComplete: true,
  };
}

function bundleFor(input: BranchListMetricInput) {
  return calculateBranchListMetrics(
    input,
    buildAdjacentBranchMetricWindows(BranchMetricPeriod.All, NOW)
  );
}

describe("ISS-9972 the shipped LOC/$ field answers with one denominator", () => {
  it("publishes the partial-coverage reading the production cohort produced", () => {
    const bundle = bundleFor(partialCostCoverageInput());

    expect(bundle.locPerDollar.current.state).toBe(
      BranchMetricAvailability.Partial
    );
    expect(bundle.locPerDollar.current.value).toBeCloseTo(
      PRODUCTION_RENDERED_RATIO,
      6
    );
  });

  it("keeps out-of-cohort qualifying spend in the denominator", () => {
    // ISS-6543 put qualifying Session cost from outside the visible cohort in
    // the denominator on purpose, and ISS-9972 deleted the flag that offered a
    // narrower alternative. This is now the only answer the card can give.
    const input = completeCoverageInput(PRODUCTION_KNOWN_COST_USD, 4);
    input.locPerDollarCostContributions = [
      ...input.costContributions,
      costContribution({
        sourceEventId: "cost-event-outside",
        branchId: "branch-outside-cohort",
        sessionId: "session-outside",
        costUsd: 250,
      }),
    ];

    expect(bundleFor(input).locPerDollar.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: PRODUCTION_COHORT_LOC / (PRODUCTION_KNOWN_COST_USD + 4 + 250),
    });
  });
});

describe("ISS-9732 Sessions and Branches agree over the same sessions", () => {
  /**
   * AC4, now carried by the shipped field. Sessions publishes its ratio through
   * `locPerDollarFromLines` (`apps/api/app/agent-sessions/service/
   * projections.ts`, `session-detail-read.ts`, and the desktop
   * `shared-agent-sessions-api.ts`); Branches publishes its own through the
   * kernel below. Driven over ONE population with complete coverage, the two
   * must return the same number.
   */
  it("produces the same LOC/$ from the Sessions helper and the Branches kernel", () => {
    const coveredCostUsd = 12.5;
    const uncoveredCostUsd = 7.5;
    const bundle = bundleFor(
      completeCoverageInput(coveredCostUsd, uncoveredCostUsd)
    );

    const sessionsRatio = locPerDollarFromLines(
      PRODUCTION_COHORT_LOC,
      coveredCostUsd + uncoveredCostUsd
    );

    expect(sessionsRatio).not.toBeNull();
    expect(bundle.locPerDollar.current.value).toBe(sessionsRatio);
  });

  it("declines on both surfaces when the population has no dollars", () => {
    // Agreement has to hold on the ABSENT answer too, or the two surfaces
    // disagree exactly where a reader is most likely to be misled.
    const bundle = bundleFor(completeCoverageInput(0, 0));

    expect(locPerDollarFromLines(PRODUCTION_COHORT_LOC, 0)).toBeNull();
    expect(bundle.locPerDollar.current.value).toBeNull();
  });
});
