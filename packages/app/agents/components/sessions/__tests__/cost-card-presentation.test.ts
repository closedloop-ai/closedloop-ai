import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import {
  hasReportableCostSplit,
  resolveCostCardDetail,
  resolveCostCardPresentation,
} from "../cost-card-presentation";
import {
  SESSIONS_COST_HONEST_METRIC_CARD_INFO,
  SESSIONS_COST_HONEST_METRIC_CARD_LABEL,
  SESSIONS_COST_METRIC_CARD_INFO,
  SESSIONS_COST_METRIC_CARD_LABEL,
} from "../cost-metric-card";
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
  ])("falls back to the collapsed presentation when its API total is $name", ({
    apiEstimatedCost,
  }) => {
    const presentation = resolveCostCardPresentation(
      true,
      usageFixture({ apiEstimatedCost })
    );

    expect(presentation).toEqual({
      honest: false,
      cost: apiEstimatedCost,
      label: SESSIONS_COST_METRIC_CARD_LABEL,
      info: SESSIONS_COST_METRIC_CARD_INFO,
    });
  });

  // The codex P1 on #4905, asserted where the NUMBER and the WORDS are resolved
  // together — the only place their agreement can be checked in one breath.
  it("flag OFF: the copy qualifies the bucket the headline actually sums, never the cohort total", () => {
    // The canonical mixed cohort: $30 billed to an API key, $70 of
    // subscription-covered usage, $100 inclusive total.
    const presentation = resolveCostCardPresentation(
      false,
      usageFixture({
        totalEstimatedCost: 100,
        apiEstimatedCost: 30,
        subscriptionEstimatedCost: 70,
        meteredEstimatedCost: 30,
        unknownEstimatedCost: 0,
      })
    );

    // The headline is the PARTIAL bucket, not the $100 cohort total…
    expect(presentation.cost).toBe(30);
    expect(presentation.cost).not.toBe(100);
    // …so the copy resolved alongside it has to say which bucket that is.
    // ISS-6092's first draft ("Cost across the filtered sessions" / "Session
    // cost is summed for the selected and filtered range") failed both of these.
    expect(presentation.info.what).toContain("not covered by a subscription");
    expect(presentation.info.how).toContain(
      "counting only the sessions a subscription doesn't cover"
    );
  });

  it("uses the honest presentation for a complete split that reconciles", () => {
    expect(resolveCostCardPresentation(true, usageFixture())).toEqual({
      honest: true,
      cost: 40,
      label: SESSIONS_COST_HONEST_METRIC_CARD_LABEL,
      info: SESSIONS_COST_HONEST_METRIC_CARD_INFO,
    });
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
      usage: usageFixture({
        subscriptionEstimatedCost: 0,
        apiEstimatedCost: 40,
        meteredEstimatedCost: 40,
        unknownEstimatedCost: 0,
      }),
      honest: true,
      unpriceable: false,
    });

    expect(detail).toBe("From local history");
  });
});
