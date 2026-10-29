/**
 * @file branch-canonical-loc-per-dollar.test.ts
 * @description ISS-9956 — the Branches LOC per $ that divides TOTAL ESTIMATED
 * COST, the one dollar basis shared with Sessions.
 *
 * Every expected number here is written out, never read back from the helper it
 * polices. A fixture that computed its expectation from `canonicalEstimatedCostUsd`
 * would agree with the implementation no matter which denominator the
 * implementation actually used, which is the one thing these cases exist to pin.
 *
 * The load-bearing fixture choice is that the two bases DISAGREE: the same
 * cohort carries $50 of token-event cost and a $25 canonical
 * total. So `locPerDollar` must read 2 and `canonicalLocPerDollar` must read 4.
 * If the canonical field ever silently fell back to the attributed fold — the
 * exact regression this ticket is about — it would read 2 and these cases fail.
 */
import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import {
  type BranchListMetricInput,
  calculateBranchListMetrics,
} from "./branch-list-metrics";
import { buildAdjacentBranchMetricWindows } from "./branch-metric-windows";
import { BranchPublicationLocSource } from "./branch-publication-loc";

const NOW = new Date("2026-08-18T12:00:00.000Z");
const CURRENT = "2026-08-17T12:00:00.000Z";

/** Lines published in the current window. */
const PUBLISHED_LINES = 100;
/** Phase-attributed token-event cost — what the SHIPPED `locPerDollar` divides. */
const ATTRIBUTED_COST_USD = 50;
/** Total estimated cost — what the CANONICAL field divides. Deliberately ≠ above. */
const CANONICAL_COST_USD = 25;

describe("ISS-9956 canonical LOC per $ divides total estimated cost", () => {
  it("divides the canonical total, not the attributed-cost fold", () => {
    const bundle = calculate(withBothBases());

    // 100 / 25. Written out, and different from the 100 / 50 below.
    expect(bundle.canonicalLocPerDollar?.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 4,
    });
    // The shipped field is untouched on the same fixture — so this pins that the
    // two bases genuinely differ here, and that the new field did not change the
    // old one's answer.
    expect(bundle.locPerDollar.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 2,
    });
  });

  it("reconciles: lines divided by the published ratio recovers the basis", () => {
    const bundle = calculate(withBothBases());
    const ratio = bundle.canonicalLocPerDollar?.current.value;

    // The denominator the card actually used, recovered from what it published.
    // This is the assertion that survives a fixture change: whatever the numbers
    // are, the ratio must divide the canonical basis and nothing else.
    expect(ratio).not.toBeNull();
    expect(PUBLISHED_LINES / (ratio as number)).toBe(CANONICAL_COST_USD);
    expect(PUBLISHED_LINES / (ratio as number)).not.toBe(ATTRIBUTED_COST_USD);
  });

  /*
   * Salvaged from PR #8215 (closed unmerged), which withheld this ratio on
   * Desktop Local and needed an anti-generalization control: the ratio must not
   * require a PUSH. Only the cloud publication projection emits
   * `SuccessfulPush`; the desktop one emits `MergedPullRequest` only
   * (`apps/desktop/src/main/branch/branch-publication-loc-projection.ts`). Every
   * other case in this file drives a push, so nothing here would have caught a
   * basis narrowed to pushes — it would have taken the figure off one producer
   * and left this suite green.
   */
  it("computes the ratio from merged-PR lines alone, with no push in the cohort", () => {
    const input = withBothBases();
    const [contribution] = input.locContributions;

    const bundle = calculate({
      ...input,
      locContributions: [
        {
          ...contribution,
          sourceEventId: "merged-pr-a",
          source: BranchPublicationLocSource.MergedPullRequest,
        },
      ],
    });

    // The same 100 / 25 the push cohort publishes: the SOURCE of the lines is
    // not part of this ratio's definition.
    expect(bundle.canonicalLocPerDollar?.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 4,
    });
  });

  it("withholds the ratio when the producer sent no basis", () => {
    const input = withBothBases();
    // A producer predating the field omits it. That is "we were not told", which
    // must not render as a measured zero or as not-applicable.
    input.canonicalEstimatedCostUsd = undefined;

    expect(calculate(input).canonicalLocPerDollar?.current).toEqual({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    });
  });

  it("answers N/A for a measured zero basis", () => {
    const input = withBothBases();
    input.canonicalEstimatedCostUsd = 0;

    // The cohort's Sessions really cost nothing, so the ratio does not apply —
    // a different answer from the Unavailable above, and the distinction is the
    // point: "cost nothing" must not read as "we could not compute this".
    expect(calculate(input).canonicalLocPerDollar?.current).toEqual({
      state: BranchMetricAvailability.NotApplicable,
      value: null,
    });
  });

  it("refuses a corrupt basis rather than publishing a confident number", () => {
    // Reachable: this value crosses a wire and is not parsed on arrival. Each of
    // these is impossible from a correct producer, so none may be divided by.
    for (const corrupt of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const input = withBothBases();
      input.canonicalEstimatedCostUsd = corrupt;

      expect(calculate(input).canonicalLocPerDollar?.current).toEqual({
        state: BranchMetricAvailability.Unavailable,
        value: null,
      });
    }
  });

  it("reports a verified zero-LOC cohort as a real zero, not an unknown", () => {
    const input = withBothBases();
    // Complete coverage, real money spent, nothing published in the window.
    // Over a COHORT that is an answer — "these branches published nothing in
    // range and you spent $25" — not a failure to compute. Dividing through the
    // SESSION-scoped rule (`lines <= 0` never divides) returns null here and
    // dashes the card, which is the defect this case pins.
    input.locContributions = [];

    expect(calculate(input).canonicalLocPerDollar?.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 0,
    });
  });

  it("publishes no period comparison, because it cannot compute an honest one", () => {
    // #7021 review (codex + whitlockk). The denominator is ONE scalar the producer
    // folded over the current request window; the numerator is re-derived per
    // window here. A prior result would therefore be prior-window LOC over
    // CURRENT-window cost, and the delta would report a pure LOC movement as a
    // movement in efficiency.
    const bundle = calculate(withBothBases());

    expect(bundle.canonicalLocPerDollar?.comparison).toBeUndefined();
    // The contrast is the assertion: this window HAS a prior (7-day adjacent),
    // and the sibling that can honestly re-derive both of its terms per window
    // does publish a comparison over it. So the absence above is this metric
    // withholding, not the fixture having no prior window to compare against.
    expect(bundle.locPerDollar.comparison).toBeDefined();
  });

  it("discloses incomplete publication coverage instead of hiding the ratio", () => {
    const input = withBothBases();
    input.locCoverageComplete = false;

    expect(calculate(input).canonicalLocPerDollar?.current).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 4,
      disclosure: BranchMetricDisclosure.LocIncomplete,
    });
  });
});

function calculate(input: BranchListMetricInput) {
  return calculateBranchListMetrics(
    input,
    buildAdjacentBranchMetricWindows(BranchMetricPeriod.SevenDays, NOW)
  );
}

/** One cohort whose two cost bases deliberately disagree. */
function withBothBases(): BranchListMetricInput {
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
    locPerDollarCostContributions: [
      {
        sourceEventId: "cost-a",
        branchId: "branch-a",
        sessionId: "session-a",
        occurredAt: CURRENT,
        costUsd: ATTRIBUTED_COST_USD,
        qualifyingBranchCount: 1,
      },
    ],
    locPerDollarQualifyingSessionIds: ["session-a"],
    locPerDollarCostCoverageComplete: true,
    canonicalEstimatedCostUsd: CANONICAL_COST_USD,
  };
}
