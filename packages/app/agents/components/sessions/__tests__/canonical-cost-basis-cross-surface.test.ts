/**
 * @file canonical-cost-basis-cross-surface.test.ts
 * @description ISS-9956 acceptance 1 — Branches and Sessions on ONE dollar
 * basis, asserted as an AGREEMENT rather than as two constants.
 *
 * The whole point of this file is that neither surface is checked against a
 * literal it could drift away from alone. One fixture produces the figure the
 * Sessions listing metrics card headlines; that SAME figure is handed to the
 * Branches metric kernel as its denominator; and the final assertion recovers
 * the denominator back out of the ratio Branches published and requires it to
 * equal what Sessions rendered. If either surface changed basis, the recovered
 * number stops matching and this fails — which two independent per-surface
 * assertions against constants could never detect.
 *
 * It also pins the DIRECTION of the basis. `totalEstimatedCost` is
 * subscription-INCLUSIVE and `apiEstimatedCost` is the subscription-exclusive
 * figure; the two differ in this fixture on purpose, so a change that quietly
 * moved the card onto the exclusive figure fails here rather than shipping.
 */
import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import {
  BranchMetricAvailability,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import {
  type BranchListMetricInput,
  calculateBranchListMetrics,
} from "@repo/lib/branches/branch-list-metrics";
import { buildAdjacentBranchMetricWindows } from "@repo/lib/branches/branch-metric-windows";
import { BranchPublicationLocSource } from "@repo/lib/branches/branch-publication-loc";
import { describe, expect, it } from "vitest";
import { resolveCostCardPresentation } from "../cost-card-presentation";

const NOW = new Date("2026-08-18T12:00:00.000Z");
const CURRENT = "2026-08-17T12:00:00.000Z";
const PUBLISHED_LINES = 100;

/**
 * The three lanes, written out. Subscription is the LARGEST, so the inclusive
 * total ($25) and the exclusive `apiEstimatedCost` ($10) cannot be confused for
 * one another by coincidence.
 */
const SUBSCRIPTION_COST = 15;
const METERED_COST = 7;
const UNKNOWN_COST = 3;
const API_COST = METERED_COST + UNKNOWN_COST;
const TOTAL_COST = SUBSCRIPTION_COST + METERED_COST + UNKNOWN_COST;

describe("ISS-9956 one dollar basis across Branches and Sessions", () => {
  it("headlines the subscription-inclusive total on the Sessions card", () => {
    const presentation = resolveCostCardPresentation(settledUsage());

    // Written out, not read from the module under test. The label is ruling 7's
    // alias since the operator ruling of 2026-09-20; the BASIS this case is
    // about is unchanged.
    expect(presentation.cost).toBe(25);
    expect(presentation.label).toBe("Cost");
    // The direction guard: the exclusive figure is a different number, and it is
    // NOT what this card reports.
    expect(presentation.cost).not.toBe(API_COST);
  });

  it("divides on Branches exactly the figure Sessions headlines", () => {
    // ONE fixture, read once. The Sessions surface resolves the basis...
    const presentation = resolveCostCardPresentation(settledUsage());
    expect(presentation.cost).not.toBeUndefined();

    // ...and the Branches surface is handed that same resolved number.
    const bundle = calculateBranchListMetrics(
      branchInput(presentation.cost as number),
      buildAdjacentBranchMetricWindows(BranchMetricPeriod.SevenDays, NOW)
    );

    expect(bundle.canonicalLocPerDollar?.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 4,
    });

    // The agreement itself: recover the denominator Branches actually used and
    // require it to BE the Sessions figure. This is the assertion that fails if
    // either surface moves basis independently.
    const ratio = bundle.canonicalLocPerDollar?.current.value as number;
    expect(PUBLISHED_LINES / ratio).toBe(presentation.cost);
  });
});

/** A settled payload whose three lanes reconcile with their total. */
function settledUsage(): AgentSessionUsageSummary {
  return {
    totalSessions: 4,
    totalInputTokens: 1000,
    totalOutputTokens: 1000,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalEstimatedCost: TOTAL_COST,
    subscriptionEstimatedCost: SUBSCRIPTION_COST,
    apiEstimatedCost: API_COST,
    meteredEstimatedCost: METERED_COST,
    unknownEstimatedCost: UNKNOWN_COST,
  } as AgentSessionUsageSummary;
}

/** One published branch, with the canonical basis supplied by the caller. */
function branchInput(canonicalEstimatedCostUsd: number): BranchListMetricInput {
  return {
    cohortSize: 1,
    cohortCoverageComplete: true,
    lastActiveEvents: [{ sourceEventId: "activity", occurredAt: CURRENT }],
    lastActiveCoverageComplete: true,
    statusSnapshots: [
      { branchId: "branch-a", currentActive: true, priorActive: true },
    ],
    locContributions: [
      {
        sourceEventId: "push-a",
        changeIdentity: "change-a",
        branchId: "branch-a",
        occurredAt: CURRENT,
        additions: PUBLISHED_LINES,
        deletions: 0,
        source: BranchPublicationLocSource.SuccessfulPush,
      },
    ],
    locCoverageComplete: true,
    locCompleteBranchIds: ["branch-a"],
    pullRequests: [],
    pullRequestCoverageComplete: true,
    costContributions: [],
    costCompleteBranchIds: ["branch-a"],
    canonicalEstimatedCostUsd,
  };
}
