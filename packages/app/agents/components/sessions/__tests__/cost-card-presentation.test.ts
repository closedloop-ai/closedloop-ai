import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import {
  TOTAL_ESTIMATED_COST_ALIAS_LABEL,
  TOTAL_ESTIMATED_COST_COPY,
} from "@repo/api/src/types/total-estimated-cost-copy";
import { describe, expect, it } from "vitest";
import {
  CostCardPresentationMode,
  hasReportableCostSplit,
  resolveCostCardDetail,
  resolveCostCardPresentation,
  resolveCostTileSlots,
} from "../cost-card-presentation";
import { createAgentSessionUsageSummaryFixture } from "../session-list-fixtures";

function usageFixture(
  overrides: Partial<AgentSessionUsageSummary> = {}
): AgentSessionUsageSummary {
  return createAgentSessionUsageSummaryFixture(
    AgentSessionViewerScope.Organization,
    {
      totalEstimatedCost: 150,
      subscriptionEstimatedCost: 50,
      apiEstimatedCost: 100,
      meteredEstimatedCost: 40,
      unknownEstimatedCost: 60,
      ...overrides,
    }
  );
}

describe("resolveCostCardPresentation", () => {
  it.each([
    { name: "NaN", apiEstimatedCost: Number.NaN },
    { name: "positive infinity", apiEstimatedCost: Number.POSITIVE_INFINITY },
    { name: "negative infinity", apiEstimatedCost: Number.NEGATIVE_INFINITY },
  ])(
    "drops the lanes but keeps the inclusive headline when its API total is $name",
    ({ apiEstimatedCost }) => {
      const presentation = resolveCostCardPresentation(
        usageFixture({ apiEstimatedCost })
      );

      // ISS-10636: an unreadable `apiEstimatedCost` used to become the headline
      // here, because the fallback presentation headlined that field. It no
      // longer backs any headline, so a NaN in it costs the card its lanes and
      // nothing else.
      expect(presentation).toEqual({
        mode: CostCardPresentationMode.Total,
        cost: 150,
        label: TOTAL_ESTIMATED_COST_ALIAS_LABEL,
        info: TOTAL_ESTIMATED_COST_COPY.info,
      });
    }
  );

  // The codex P1 on #4905 asserted here that the NUMBER and the WORDS agree,
  // and it still does — ISS-10597 only reversed WHICH number they agree on.
  // Operator ruling 2026-09-17: "It should say Total Estimated Cost and that is
  // what it should show." A card that headlined the narrower bucket under this
  // copy would be the lie that ruling exists to stop, so both halves are pinned
  // in one breath, on the arm that used to headline the narrower bucket.
  it("headlines the inclusive total under copy that promises it, even when the payload cannot split", () => {
    // The canonical mixed cohort: $30 billed to an API key, $70 of
    // subscription-covered usage, $100 inclusive total. `unknownEstimatedCost`
    // is dropped so the payload cannot split at all.
    const presentation = resolveCostCardPresentation(
      usageFixture({
        totalEstimatedCost: 100,
        apiEstimatedCost: 30,
        subscriptionEstimatedCost: 70,
        meteredEstimatedCost: 30,
        unknownEstimatedCost: undefined,
      })
    );

    expect(presentation.mode).toBe(CostCardPresentationMode.Total);
    expect(presentation.cost).toBe(100);
    expect(presentation.cost).not.toBe(30);
    expect(presentation.label).toBe(TOTAL_ESTIMATED_COST_ALIAS_LABEL);
    expect(presentation.info.what).toContain("every billing type included");
  });

  it("uses the breakdown presentation with no flag of its own", () => {
    expect(resolveCostCardPresentation(usageFixture())).toEqual({
      mode: CostCardPresentationMode.Breakdown,
      // The subscription-INCLUSIVE total (150), which the fixture makes
      // distinct from both `apiEstimatedCost` (100) and `meteredEstimatedCost`
      // (40) — so headlining either of those instead would fail here.
      cost: 150,
      label: TOTAL_ESTIMATED_COST_ALIAS_LABEL,
      // ISS-10636: breakdown no longer carries its own copy. Every mode resolves
      // the one canonical explanation of the one dollar figure, so the lanes
      // detail the same number the tooltip describes rather than a second one.
      info: TOTAL_ESTIMATED_COST_COPY.info,
    });
  });

  it("headlines the subscription-inclusive total, not a narrower lane", () => {
    // The fixture makes the three candidate figures distinct — total 150,
    // `apiEstimatedCost` 100, `meteredEstimatedCost` 40 — so headlining any lane
    // instead of the total fails here rather than coincidentally passing.
    const presentation = resolveCostCardPresentation(usageFixture());

    expect(presentation.mode).toBe(CostCardPresentationMode.Breakdown);
    expect(presentation.cost).toBe(150);
    expect(presentation.cost).not.toBe(100);
    expect(presentation.cost).not.toBe(40);
    expect(presentation.label).toBe(TOTAL_ESTIMATED_COST_ALIAS_LABEL);
  });

  it("drops the lanes when the split does not reconcile", () => {
    // A producer that cannot substantiate the split loses its lanes rather than
    // stating a partition derived from a payload we do not understand. The
    // headline and the label are unchanged: the total is still substantiated.
    const presentation = resolveCostCardPresentation(
      usageFixture({ meteredEstimatedCost: 5, unknownEstimatedCost: 5 })
    );

    expect(presentation.mode).toBe(CostCardPresentationMode.Total);
    expect(presentation.cost).toBe(150);
    expect(presentation.label).toBe(TOTAL_ESTIMATED_COST_ALIAS_LABEL);
  });

  // whitlockk on #5953: `hasReportableCostSplit` reconciles metered + unknown against
  // `apiEstimatedCost` and says nothing about the subscription lane or the total.
  // Breakdown headlines the TOTAL and states all three lanes as a partition of
  // it, so a payload whose lanes do not add up to that total must not enter the
  // mode and have a lane rewritten by the allocator to fit the header.
  it("refuses breakdown when the three lanes do not reconcile with the total", () => {
    const presentation = resolveCostCardPresentation(
      // metered + unknown DOES reconcile with apiEstimatedCost (40 + 60 = 100),
      // so the older guard passes — but the lanes sum to 150 against a stated
      // total of 900.
      usageFixture({ totalEstimatedCost: 900 })
    );

    expect(presentation.mode).toBe(CostCardPresentationMode.Total);
  });

  it("refuses breakdown when a lane is negative", () => {
    const presentation = resolveCostCardPresentation(
      usageFixture({
        subscriptionEstimatedCost: -50,
        totalEstimatedCost: 50,
      })
    );

    expect(presentation.mode).toBe(CostCardPresentationMode.Total);
  });

  // ISS-5401 ∩ ISS-8791. A cohort that did measurable work and priced nothing
  // partitions into three zeroes, so every arithmetic check in
  // `canReportCostBreakdown` passes on it. Breakdown would state `$0 · $0 · $0`
  // as a measured partition AND suppress the caption explaining the dash, which
  // is the "could not compute" / "cost nothing" conflation ISS-5401 exists to
  // stop. Asserted at the resolver because that is where the refusal now lives;
  // `sessions-summary-cards-unpriced-cost.test.tsx` pins what the card renders.
  it("refuses breakdown for a cohort that consumed tokens and priced nothing", () => {
    const presentation = resolveCostCardPresentation(
      usageFixture({
        totalInputTokens: 620_000_000,
        totalOutputTokens: 640_000_000,
        totalEstimatedCost: 0,
        subscriptionEstimatedCost: 0,
        apiEstimatedCost: 0,
        meteredEstimatedCost: 0,
        unknownEstimatedCost: 0,
      })
    );

    expect(presentation.mode).not.toBe(CostCardPresentationMode.Breakdown);
  });

  // The terminal fallback, and since ISS-8791 the ONLY one: a payload that
  // cannot split at all loses its lanes rather than stating a confident `$0`
  // for a bucket we cannot compute.
  it("drops the lanes for a payload that cannot split", () => {
    expect(
      resolveCostCardPresentation(
        usageFixture({ unknownEstimatedCost: undefined })
      ).mode
    ).toBe(CostCardPresentationMode.Total);
  });
});

describe("hasReportableCostSplit", () => {
  it.each([
    {
      name: "missing metered half",
      overrides: { meteredEstimatedCost: undefined },
    },
    {
      name: "null unknown half from the wire",
      overrides: { unknownEstimatedCost: null as unknown as number },
    },
    {
      name: "non-finite metered half",
      overrides: { meteredEstimatedCost: Number.NaN },
    },
    {
      name: "negative unknown half",
      overrides: { unknownEstimatedCost: -1 },
    },
    {
      name: "unreconciled halves",
      overrides: { meteredEstimatedCost: 41 },
    },
  ])("rejects a $name", ({ overrides }) => {
    expect(hasReportableCostSplit(usageFixture(overrides))).toBe(false);
  });
});

describe("resolveCostCardDetail", () => {
  it("keeps the local provenance caption when no exclusion caption exists", () => {
    const detail = resolveCostCardDetail({
      loading: false,
      loadingDetail: "Loading…",
      localFallbackDetail: "From local history",
      errored: false,
      showingLocalFallback: true,
      unpriceable: false,
    });

    expect(detail).toBe("From local history");
  });
});

describe("resolveCostTileSlots in breakdown mode", () => {
  function slots(mode: CostCardPresentationMode, overrides = {}) {
    return resolveCostTileSlots({
      cardsLoading: false,
      costPresentation: {
        mode,
        cost: 150,
        label: TOTAL_ESTIMATED_COST_ALIAS_LABEL,
        info: { what: "" },
      },
      costUnknownActive: false,
      errored: false,
      loadingDetail: "Loading…",
      localFallbackDetail: "From local history",
      showingLocalFallback: false,
      usage: usageFixture(),
      ...overrides,
    });
  }

  // tamsinb on #5953: the caption resolver used to fall to FEA-4231's
  // "+$X if billed to API" line. Under a headline that already includes that
  // figure the card read as though there were extra money on top of its own
  // total, so ISS-10636 retired that caption with the narrower headline it
  // described — on BOTH modes, since both now headline the inclusive total.
  it("states no subscription-share caption in breakdown mode", () => {
    expect(slots(CostCardPresentationMode.Breakdown).detail).toBeUndefined();
  });

  it("states no subscription-share caption in total mode either", () => {
    expect(slots(CostCardPresentationMode.Total).detail).toBeUndefined();
  });

  // ISS-5401's reason caption is the one that SURVIVES, on every mode. It says
  // why the headline dashed, which nothing else on the card states — a blanket
  // suppression would take that signal with it.
  it("keeps the unpriceable reason caption in total mode", () => {
    expect(
      slots(CostCardPresentationMode.Total, {
        usage: usageFixture({
          totalInputTokens: 620_000_000,
          totalOutputTokens: 640_000_000,
          totalEstimatedCost: 0,
          subscriptionEstimatedCost: 0,
          apiEstimatedCost: 0,
          meteredEstimatedCost: 0,
          unknownEstimatedCost: 0,
        }),
      }).detail
    ).toBe("No cost recorded");
  });

  // The loading and local-fallback captions explain why the VALUE is absent or
  // provisional, which the lanes cannot say, so breakdown keeps those.
  it("keeps the loading caption in breakdown mode", () => {
    expect(
      slots(CostCardPresentationMode.Breakdown, { cardsLoading: true }).detail
    ).toBe("Loading…");
  });

  it("keeps the local-fallback caption in breakdown mode", () => {
    expect(
      slots(CostCardPresentationMode.Breakdown, {
        showingLocalFallback: true,
      }).detail
    ).toBe("From local history");
  });
});

/**
 * #6885: `metric-card-hide-unavailable` retires a settled-empty Cost card, and it
 * asks THIS resolver which state the card is in. `dashed` cannot answer that — it
 * is the union of four reasons the card shows no number — so the hide decision
 * reads `settledEmpty`, and these cases are the three that must never buy a hide
 * while still dashing. Each asserts BOTH fields, because a `settledEmpty` that
 * merely tracked `dashed` would pass any one of them read alone.
 */
describe("resolveCostTileSlots settled-empty classification", () => {
  function slots(overrides = {}) {
    return resolveCostTileSlots({
      cardsLoading: false,
      costPresentation: {
        mode: CostCardPresentationMode.Total,
        cost: 150,
        label: TOTAL_ESTIMATED_COST_ALIAS_LABEL,
        info: { what: "" },
      },
      costUnknownActive: false,
      errored: false,
      loadingDetail: "Loading…",
      localFallbackDetail: "From local history",
      showingLocalFallback: false,
      usage: usageFixture(),
      ...overrides,
    });
  }

  // whitlockk on #6885: Unknown is the reader's own facet. Every listed row is
  // dashed BECAUSE they filtered to it, so the card is answering them correctly
  // and must survive the gate.
  it("does not call the reader's Unknown-cost facet a settled empty", () => {
    const result = slots({ costUnknownActive: true });

    expect(result.dashed).toBe(true);
    expect(result.settledEmpty).toBe(false);
  });

  // codex on #6885: a settled, version-skewed payload whose headline is
  // unreadable while a sibling still holds real money. The dash is what exposes
  // that contradiction; hiding the card would swallow the only signal of it.
  it("does not call a malformed settled payload a settled empty", () => {
    const result = slots({
      costPresentation: {
        mode: CostCardPresentationMode.Total,
        cost: Number.NaN,
        label: TOTAL_ESTIMATED_COST_ALIAS_LABEL,
        info: { what: "" },
      },
      usage: usageFixture({ totalEstimatedCost: Number.NaN }),
    });

    expect(result.dashed).toBe(true);
    expect(result.settledEmpty).toBe(false);
  });

  it("does not call a failed read a settled empty", () => {
    const result = slots({ errored: true });

    expect(result.dashed).toBe(true);
    expect(result.settledEmpty).toBe(false);
  });

  // The positive case, which is what stops the three above passing vacuously: a
  // genuinely unpriceable cohort DOES classify, so a predicate that simply never
  // returned true would fail here.
  it("classifies a genuinely unpriceable cohort", () => {
    const result = slots({
      usage: usageFixture({
        totalEstimatedCost: 0,
        apiEstimatedCost: 0,
        subscriptionEstimatedCost: 0,
        meteredEstimatedCost: 0,
        unknownEstimatedCost: 0,
        totalInputTokens: 5,
      }),
    });

    expect(result.dashed).toBe(true);
    expect(result.settledEmpty).toBe(true);
  });
});
