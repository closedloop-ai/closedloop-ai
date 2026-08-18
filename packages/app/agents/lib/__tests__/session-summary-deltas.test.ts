import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import type { AgentSessionUsageComparisonDeltas } from "@repo/api/src/types/agent-session-usage-comparison";
import {
  buildSessionSummaryDeltas,
  sessionPriorWindowLabel,
  shouldSuppressSessionComparison,
} from "@repo/app/agents/lib/session-summary-deltas";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import { describe, expect, it } from "vitest";

function usage(
  overrides: Partial<AgentSessionUsageSummary>
): AgentSessionUsageSummary {
  return {
    byHarness: [],
    byModel: [],
    byRepository: [],
    byUser: [],
    earliestSessionAt: null,
    lastSyncTargets: [],
    latestSessionAt: null,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalSessions: 0,
    viewerScope: "org",
    ...overrides,
  } as AgentSessionUsageSummary;
}

// ISS-5809: the percentages are computed by the producer and ride the same
// response as the figures they grade, so a fixture is a usage summary carrying a
// `comparison`. The arithmetic and the honesty rules that decide WHICH keys the
// producer emits (equal-width prior window, near-zero baseline, display ceiling,
// a figure absent on either side) are owned by
// `apps/api/app/agent-sessions/service/usage-comparison.test.ts`. These tests own
// the other half: mapping an emitted percent onto a card's slot and polarity, and
// mapping an ABSENT percent onto no chip at all.
function compared(
  deltas: AgentSessionUsageComparisonDeltas,
  overrides: Partial<AgentSessionUsageSummary> = {}
): AgentSessionUsageSummary {
  return usage({
    ...overrides,
    comparison: {
      priorStartDate: "2026-07-25T00:00:00.000Z",
      priorEndDate: "2026-07-31T23:59:59.999Z",
      deltas,
    },
  });
}

describe("buildSessionSummaryDeltas (ISS-5315 / ISS-5809)", () => {
  it("grades a session-count rise as an improvement and token volume as neutral", () => {
    const deltas = buildSessionSummaryDeltas({
      current: compared({ sessions: 20, tokens: 100 }),
      dateRange: "30d",
    });

    expect(deltas?.label).toBe("vs. prior 30 days");
    expect(deltas?.sessions).toEqual({
      delta: 20,
      deltaPolarity: MetricPolarity.HigherIsBetter,
    });
    // Token volume is the substance of spend, so a rise is not a win — grading
    // it "better" would contradict the Cost card beside it.
    expect(deltas?.tokens).toEqual({
      delta: 100,
      deltaPolarity: MetricPolarity.Neutral,
    });
  });

  // #4480: the Cost card's headline is `meteredEstimatedCost` under the honesty
  // flag and `apiEstimatedCost` otherwise, so a single "cost" delta would have
  // graded whichever basis this module picked against whatever the card actually
  // rendered. Both are emitted; the card reads the one it resolved.
  it("grades spend on BOTH bases the Cost card can render, lower being better", () => {
    const deltas = buildSessionSummaryDeltas({
      current: compared({ apiCost: 50, meteredCost: -50 }),
      dateRange: "30d",
    });

    expect(deltas?.apiCost).toEqual({
      delta: 50,
      deltaPolarity: MetricPolarity.LowerIsBetter,
    });
    // The two bases move in OPPOSITE directions here, which is exactly why one
    // shared entry would have been wrong on one of the two cards.
    expect(deltas?.meteredCost).toEqual({
      delta: -50,
      deltaPolarity: MetricPolarity.LowerIsBetter,
    });
  });

  // An absent spend figure is "not computed", never a zero to divide by — the
  // producer omits the key and the card gets no chip.
  it("emits no cost movement for a basis the producer did not compare", () => {
    const deltas = buildSessionSummaryDeltas({
      current: compared({ apiCost: 50 }),
      dateRange: "30d",
    });

    expect(deltas?.apiCost).toBeDefined();
    expect(deltas?.meteredCost).toBeUndefined();
  });

  // It still returns an OBJECT in every no-comparison case: calling this at all
  // is the surface declaring that it compares periods, which is what earns the
  // "No prior period" placeholder. A surface that never compares (desktop) does
  // not call it, and its cards show neither a chip nor a placeholder.
  it("makes no comparison for an unbounded range, but still declares the surface compares", () => {
    const deltas = buildSessionSummaryDeltas({
      current: compared({ sessions: 20, tokens: 100 }),
      dateRange: "all",
    });
    expect(deltas.label).toBeNull();
    expect(deltas.sessions).toBeUndefined();
    expect(deltas.tokens).toBeUndefined();
  });

  it("makes no comparison when the response carries none", () => {
    const deltas = buildSessionSummaryDeltas({
      current: usage({ totalSessions: 120 }),
      dateRange: "7d",
    });
    expect(deltas.sessions).toBeUndefined();
    expect(deltas.tokens).toBeUndefined();
    expect(deltas.meteredCost).toBeUndefined();
    expect(deltas.apiCost).toBeUndefined();
    // The caption still names the window it WOULD compare against, so the
    // placeholder is not the only thing distinguishing "not yet" from "never".
    expect(deltas.label).toBe("vs. prior 7 days");
  });

  it("makes no comparison before the read has landed at all", () => {
    const deltas = buildSessionSummaryDeltas({
      current: undefined,
      dateRange: "7d",
    });
    expect(deltas.sessions).toBeUndefined();
    expect(deltas.label).toBe("vs. prior 7 days");
  });

  it("makes no comparison while the caller reports the figures may be stale", () => {
    const deltas = buildSessionSummaryDeltas({
      current: compared({ sessions: 20, tokens: 100 }),
      dateRange: "7d",
      suppressed: true,
    });
    expect(deltas.sessions).toBeUndefined();
    expect(deltas.tokens).toBeUndefined();
  });

  // A zero baseline cannot be divided by, so the producer emits no key for that
  // card. This asserts the card is left with NO delta rather than a fabricated
  // 0% or an infinity — and that its siblings are unaffected.
  it("omits a card the producer declined to compare, without suppressing the row", () => {
    const deltas = buildSessionSummaryDeltas({
      current: compared({ tokens: 100 }),
      dateRange: "7d",
    });

    expect(deltas.sessions).toBeUndefined();
    expect(deltas.tokens?.delta).toBe(100);
  });

  it("reports a genuine flat period as 0%, not as an absent comparison", () => {
    const deltas = buildSessionSummaryDeltas({
      current: compared({ sessions: 0 }),
      dateRange: "7d",
    });
    expect(deltas?.sessions?.delta).toBe(0);
  });

  it("declares delivery participation from the gate, on every return path", () => {
    // Carried on the entry-bearing path AND the "no honest comparison" path,
    // because the delivery pair's placeholder is as perceivable as its chip
    // (review threads on #4681).
    expect(
      buildSessionSummaryDeltas({
        current: compared({ sessions: 20 }),
        dateRange: "7d",
      }).deliveryCompared
    ).toBe(false);
    expect(
      buildSessionSummaryDeltas({
        comparisonV2Enabled: true,
        current: compared({ sessions: 20 }),
        dateRange: "7d",
      }).deliveryCompared
    ).toBe(true);
    expect(
      buildSessionSummaryDeltas({
        comparisonV2Enabled: true,
        current: undefined,
        dateRange: "all",
      }).deliveryCompared
    ).toBe(true);
  });

  // Cross-repo skew: a newer producer may compare a metric this build has no card
  // for. The unknown key must be ignored rather than break the cards that ARE
  // mapped, and it must not leak into the returned slots.
  it("ignores a compared metric this build does not know", () => {
    const skewed: AgentSessionUsageComparisonDeltas & Record<string, number> = {
      sessions: 20,
      futureMetric: 99,
    };
    const deltas = buildSessionSummaryDeltas({
      current: compared(skewed),
      dateRange: "7d",
    });

    expect(deltas.sessions?.delta).toBe(20);
    expect(Object.keys(deltas)).not.toContain("futureMetric");
  });
});

// ISS-5809 M2.3: the page's suppression gate had NO test before this change —
// including the #4480 fix that made it depend on both queries. Collapsing to one
// query removed that hazard, so the surviving rule is asserted here as a
// decision table.
describe("shouldSuppressSessionComparison (ISS-5809)", () => {
  const settled = {
    isLoading: false,
    isError: false,
    isPlaceholderData: false,
    isFetching: false,
  };

  it("renders the comparison only once the read has settled", () => {
    expect(shouldSuppressSessionComparison(settled)).toBe(false);
  });

  it("suppresses while loading, so no chip grades figures that are not there yet", () => {
    expect(
      shouldSuppressSessionComparison({ ...settled, isLoading: true })
    ).toBe(true);
  });

  it("suppresses on error, rather than chipping a stale last-good response", () => {
    expect(shouldSuppressSessionComparison({ ...settled, isError: true })).toBe(
      true
    );
  });

  it("suppresses placeholder data — the previous scope's figures, not this one's", () => {
    expect(
      shouldSuppressSessionComparison({ ...settled, isPlaceholderData: true })
    ).toBe(true);
  });

  it("suppresses mid-refetch, when the figures and the comparison may disagree", () => {
    expect(
      shouldSuppressSessionComparison({ ...settled, isFetching: true })
    ).toBe(true);
  });
});

describe("period-over-period cadence captions (FEA-4202)", () => {
  it("captions each bounded range with its cadence", () => {
    expect(sessionPriorWindowLabel("7d", true)).toBe("WoW");
    expect(sessionPriorWindowLabel("30d", true)).toBe("MoM");
    expect(sessionPriorWindowLabel("90d", true)).toBe("QoQ");
  });

  // "All time" has no window before it, so there is no cadence to name and no
  // card carries a chip — the gate does not change that.
  it("still has no caption for an unbounded range", () => {
    expect(sessionPriorWindowLabel("all", true)).toBeNull();
    expect(sessionPriorWindowLabel("all")).toBeNull();
  });

  // The gate defaults OFF, so a caller that has not opted in is byte-identical
  // to ISS-5315. Asserted explicitly because both the default and the explicit
  // `false` reach production while the flag is rolling out.
  it("keeps the ISS-5315 wording while the gate is off", () => {
    expect(sessionPriorWindowLabel("7d")).toBe("vs. prior 7 days");
    expect(sessionPriorWindowLabel("7d", false)).toBe("vs. prior 7 days");
    expect(sessionPriorWindowLabel("30d")).toBe("vs. prior 30 days");
  });
});

describe("PRs Shipped comparison (FEA-4202)", () => {
  it("grades more merged PRs as an improvement, captioned with the cadence", () => {
    const deltas = buildSessionSummaryDeltas({
      comparisonV2Enabled: true,
      current: compared({ prsShipped: 25, sessions: 20 }),
      dateRange: "7d",
    });

    expect(deltas.label).toBe("WoW");
    expect(deltas.prsShipped).toEqual({
      delta: 25,
      deltaPolarity: MetricPolarity.HigherIsBetter,
    });
  });

  it("grades a fall as a real negative movement, not an absent one", () => {
    const deltas = buildSessionSummaryDeltas({
      comparisonV2Enabled: true,
      current: compared({ prsShipped: -20 }),
      dateRange: "30d",
    });

    expect(deltas.prsShipped).toEqual({
      delta: -20,
      deltaPolarity: MetricPolarity.HigherIsBetter,
    });
  });

  // The producer collapses a zero merged-PR count to `null` on purpose, and an
  // absent count on either side is "we do not know" — both arrive here as an
  // absent key, and the honest render for each is no chip.
  it("declines when the producer emitted no merged-PR movement", () => {
    const deltas = buildSessionSummaryDeltas({
      comparisonV2Enabled: true,
      current: compared({ sessions: 20 }),
      dateRange: "7d",
    });

    expect(deltas.prsShipped).toBeUndefined();
    // The caption still names the cadence, so the card can distinguish
    // "no comparison yet" from "this range never compares".
    expect(deltas.label).toBe("WoW");
  });

  it("makes no comparison on the unbounded range", () => {
    const deltas = buildSessionSummaryDeltas({
      comparisonV2Enabled: true,
      current: compared({ prsShipped: 25 }),
      dateRange: "all",
    });

    expect(deltas.label).toBeNull();
    expect(deltas.prsShipped).toBeUndefined();
  });

  it("emits no chip while the gate is off, even with a movement in hand", () => {
    const deltas = buildSessionSummaryDeltas({
      current: compared({ prsShipped: 25, sessions: 20 }),
      dateRange: "7d",
    });

    expect(deltas.prsShipped).toBeUndefined();
    // The cards ISS-5315 already compares are untouched by the gate.
    expect(deltas.sessions?.delta).toBe(20);
  });

  // ISS-6398 windowed the LOC/$ divisor, but only for the CURRENT window: the
  // producer reads the prior window's merged-PR count and not its spend, so a
  // prior ratio would divide prior lines by current dollars. There is no honest
  // second figure to compare, so the contract carries no key for it — and this
  // module cannot invent one.
  it("emits no LOC/$ comparison", () => {
    const deltas = buildSessionSummaryDeltas({
      comparisonV2Enabled: true,
      current: compared(
        { prsShipped: 25 },
        { mergedLocPerDollar: 400, mergedPrCount: 10 }
      ),
      dateRange: "7d",
    });

    expect(Object.keys(deltas)).not.toContain("locPerDollar");
    // The sibling delivery card still compares, so this is a scoped decline
    // rather than the whole delivery pair going dark.
    expect(deltas.prsShipped?.delta).toBe(25);
  });
});
