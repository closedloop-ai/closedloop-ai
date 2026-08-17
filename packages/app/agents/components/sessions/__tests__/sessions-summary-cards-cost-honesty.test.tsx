/**
 * ISS-4773 — the Sessions "Cost" card's truth-in-UI contract, behind
 * `SESSIONS_COST_BILLING_HONESTY_FEATURE_FLAG_KEY` (default OFF).
 *
 * A sibling of `sessions-summary-cards.test.tsx` rather than more cases inside
 * it: that file is a whole-row suite already at the 1,000-line ceiling, and this
 * is a single, self-contained concern (which cost basis the card reports on).
 *
 * The defect these tests pin: the shipped card headlines `apiEstimatedCost`,
 * which BOTH producers define as "everything not covered by a subscription" —
 * confirmed API spend AND every session whose billing mode was never determined.
 * On a subscription-heavy account the second term dominates, so a figure that was
 * mostly unconfirmed usage rendered as definite out-of-pocket cost.
 */

import { formatDeltaPct } from "@closedloop-ai/loops-api/insights";
import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { SESSIONS_COST_BILLING_HONESTY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SessionSummaryDeltas } from "../../../lib/session-summary-deltas";
import {
  COST_METRIC_CARD_LABEL,
  SESSIONS_COST_HONEST_METRIC_CARD_LABEL,
  SESSIONS_COST_METRIC_CARD_LABEL,
} from "../cost-metric-card";
import { createAgentSessionUsageSummaryFixture } from "../session-list-fixtures";
import { SessionsSummaryCards } from "../sessions-summary-cards";

/** The disclosure clause, matched to assert it is absent on the flag-OFF path. */
const UNCLASSIFIED_PATTERN = /billing unknown/;
/** FEA-4231's shipped caption, which the honest caption replaces. */
const IF_BILLED_TO_API_PATTERN = /\+\$\d[\d,]* if billed to API/;

/**
 * The reported ISS-4773 shape: a subscription-heavy account whose
 * not-subscription bucket ($16,825) is almost entirely usage the collector could
 * not classify. Only $42 of it was ever billed to an API key.
 */
function honestUsageFixture(
  overrides: Partial<AgentSessionUsageSummary> = {}
): AgentSessionUsageSummary {
  return createAgentSessionUsageSummaryFixture(
    AgentSessionViewerScope.Organization,
    {
      totalSessions: 12,
      totalEstimatedCost: 18_855,
      subscriptionEstimatedCost: 2030,
      apiEstimatedCost: 16_825,
      meteredEstimatedCost: 42,
      unknownEstimatedCost: 16_783,
      ...overrides,
    }
  );
}

/**
 * Render the summary cards with the cost-honesty flag ON, through the real
 * `FeatureFlagAdapterProvider` seam both shells use — not a stubbed boolean.
 */
function renderCardsWithCostHonesty(
  usage: AgentSessionUsageSummary,
  deltas?: SessionSummaryDeltas
) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [SESSIONS_COST_BILLING_HONESTY_FEATURE_FLAG_KEY],
      })}
    >
      <SessionsSummaryCards deltas={deltas} isLoading={false} usage={usage} />
    </FeatureFlagAdapterProvider>
  );
}

/** The metered movement: DOWN. */
const METERED_COST_DELTA_PCT = -12;
/** The API movement: UP. Opposite by design — see the describe block below. */
const API_COST_DELTA_PCT = 18;

/** A landed prior read carrying a distinct entry for each cost basis. */
const COST_BASIS_DELTAS: SessionSummaryDeltas = {
  apiCost: {
    delta: API_COST_DELTA_PCT,
    deltaPolarity: MetricPolarity.LowerIsBetter,
  },
  label: "vs. prior 30 days",
  meteredCost: {
    delta: METERED_COST_DELTA_PCT,
    deltaPolarity: MetricPolarity.LowerIsBetter,
  },
};

/**
 * The delta chip belonging to the COST card specifically.
 *
 * The strip renders several chips, so this walks up from whichever cost label is
 * on screen to the nearest ancestor that owns a chip, rather than indexing into
 * a flat list whose order is a layout detail.
 */
function costDeltaChipText(): string | undefined {
  const label =
    screen.queryByText(SESSIONS_COST_HONEST_METRIC_CARD_LABEL) ??
    screen.getByText(SESSIONS_COST_METRIC_CARD_LABEL);
  let node: HTMLElement | null = label;
  while (node) {
    const chip = node.querySelector<HTMLElement>(
      '[data-testid="metric-delta-chip"]'
    );
    if (chip) {
      return chip.textContent ?? undefined;
    }
    node = node.parentElement;
  }
  return undefined;
}

describe("SessionsSummaryCards cost honesty (ISS-4773)", () => {
  it("headlines CONFIRMED API-billed spend under its own qualified label, not the unknown-dominated bucket", () => {
    renderCardsWithCostHonesty(honestUsageFixture());

    // ISS-4401 collision guard (stage review): the honest basis gets its OWN
    // label. The bare word "Cost" is worn by the org Dashboard KPI (a
    // subscription-INCLUSIVE total) and by this page's own table column (every
    // session's cost regardless of billing mode), so reclaiming it here would
    // put three different numbers under one word on adjacent surfaces.
    expect(
      screen.getByText(SESSIONS_COST_HONEST_METRIC_CARD_LABEL)
    ).toBeTruthy();
    expect(screen.queryByText(COST_METRIC_CARD_LABEL)).toBeNull();
    // $42 is what was actually billed. $16,825 is the old headline — a figure
    // dominated by usage nobody confirmed was ever charged.
    expect(screen.getByText("$42")).toBeTruthy();
    expect(screen.queryByText("$16,825")).toBeNull();
    expect(screen.queryByText(SESSIONS_COST_METRIC_CARD_LABEL)).toBeNull();
  });

  it("discloses the unclassified share beside the subscription value rather than dropping it", () => {
    renderCardsWithCostHonesty(honestUsageFixture());

    // Excluding the unknown share from the headline stops the card OVERstating
    // spend; naming it here stops the card UNDERstating the population.
    expect(
      screen.getByText("+$2,030 via subscription · $16,783 billing unknown")
    ).toBeTruthy();
  });

  it("drops the disclosure when every session's billing mode resolved", () => {
    // The clean account: nothing is unclassified, so the caption must not
    // manufacture a second fact just because the flag is on. `apiEstimatedCost`
    // moves with it — the halves must still partition the bucket they claim to,
    // or the reconciliation guard (correctly) refuses the honest presentation.
    renderCardsWithCostHonesty(
      honestUsageFixture({ apiEstimatedCost: 42, unknownEstimatedCost: 0 })
    );

    expect(screen.getByText("+$2,030 via subscription")).toBeTruthy();
    expect(screen.queryByText(UNCLASSIFIED_PATTERN)).toBeNull();
  });

  it("falls back to the shipped presentation when the producer cannot split the bucket", () => {
    // Version skew: an already-installed Desktop predating ISS-4773 omits the
    // split. Treating that absence as "$0 billed" would be a worse lie than the
    // bucket label, so the card keeps naming the bucket it is actually summing.
    renderCardsWithCostHonesty(
      honestUsageFixture({
        meteredEstimatedCost: undefined,
        unknownEstimatedCost: undefined,
      })
    );

    expect(screen.getByText(SESSIONS_COST_METRIC_CARD_LABEL)).toBeTruthy();
    expect(screen.getByText("$16,825")).toBeTruthy();
    expect(screen.queryByText("$42")).toBeNull();
  });

  it("renders exactly today's card when the flag is OFF", () => {
    // The closed-by-default guarantee, asserted on the SAME fixture the flag-ON
    // cases use, so enabling the flag is the only thing that changes it.
    render(
      <SessionsSummaryCards isLoading={false} usage={honestUsageFixture()} />
    );

    expect(screen.getByText(SESSIONS_COST_METRIC_CARD_LABEL)).toBeTruthy();
    expect(screen.getByText("$16,825")).toBeTruthy();
    expect(screen.getByText(IF_BILLED_TO_API_PATTERN)).toBeTruthy();
    expect(screen.queryByText(UNCLASSIFIED_PATTERN)).toBeNull();
  });
});

describe("SessionsSummaryCards cost honesty — label stability (ISS-4773)", () => {
  it("keeps the honest label on the failed-read path, where the card renders chrome with no usage", () => {
    // A failed read still renders the card's label/info chrome with a dashed
    // value (the initial load is a full-card skeleton instead, so this is the
    // reachable "chrome without usage" state). Deciding against the honest
    // presentation on an absent payload would label the SAME card
    // "cost" here and "API-billed Cost" once a read succeeds —
    // the label
    // flicker reads as the card changing what it measures. An absent payload is
    // "not known yet", not "this producer cannot split the bucket".
    render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [SESSIONS_COST_BILLING_HONESTY_FEATURE_FLAG_KEY],
        })}
      >
        <SessionsSummaryCards isError isLoading={false} usage={undefined} />
      </FeatureFlagAdapterProvider>
    );

    expect(
      screen.getByText(SESSIONS_COST_HONEST_METRIC_CARD_LABEL)
    ).toBeTruthy();
    expect(screen.queryByText(SESSIONS_COST_METRIC_CARD_LABEL)).toBeNull();
  });
});

describe("SessionsSummaryCards cost honesty — split validation (ISS-4773)", () => {
  // wongk + stage review: the two halves are INDEPENDENTLY optional on the
  // contract, and neither the HTTP response nor the Desktop IPC reply is parsed
  // before it reaches this component. Gating honest mode on `metered` alone let
  // a half-populated payload headline the metered figure while the disclosure
  // clause silently vanished — understating the population with no signal, the
  // exact failure the flag exists to prevent. Each case below renders the OLD
  // presentation only because the guard rejects the payload.
  it("refuses the honest presentation when the producer sent metered but no unknown", () => {
    renderCardsWithCostHonesty(
      honestUsageFixture({ unknownEstimatedCost: undefined })
    );

    expect(screen.getByText(SESSIONS_COST_METRIC_CARD_LABEL)).toBeTruthy();
    expect(screen.getByText("$16,825")).toBeTruthy();
    expect(screen.queryByText("$42")).toBeNull();
    expect(screen.queryByText(UNCLASSIFIED_PATTERN)).toBeNull();
  });

  it("refuses the honest presentation when a half arrives as null on the wire", () => {
    // `null` is not in the optional type, but a wire payload can still carry it
    // and nothing between the producer and this render validates the shape.
    // Summing it as 0 would headline a confident, wrong number.
    renderCardsWithCostHonesty(
      honestUsageFixture({
        unknownEstimatedCost: null as unknown as number,
      })
    );

    expect(screen.getByText(SESSIONS_COST_METRIC_CARD_LABEL)).toBeTruthy();
    expect(screen.queryByText("$42")).toBeNull();
  });

  it("refuses the honest presentation when the two halves do not reconcile with the bucket they partition", () => {
    // metered + unknown must equal apiEstimatedCost. A payload where it does not
    // is a producer bug or a shape we do not understand; either way the card
    // must not headline a figure it cannot substantiate.
    renderCardsWithCostHonesty(
      honestUsageFixture({ meteredEstimatedCost: 9000 })
    );

    expect(screen.getByText(SESSIONS_COST_METRIC_CARD_LABEL)).toBeTruthy();
    expect(screen.queryByText("$9,000")).toBeNull();
  });

  it("accepts a split that reconciles only to within float-accumulation drift", () => {
    // The three figures are independently summed floats, so the guard must
    // tolerate last-ULP drift or it would reject every real payload.
    renderCardsWithCostHonesty(
      honestUsageFixture({ meteredEstimatedCost: 42.000_000_000_1 })
    );

    expect(
      screen.getByText(SESSIONS_COST_HONEST_METRIC_CARD_LABEL)
    ).toBeTruthy();
  });
});

describe("SessionsSummaryCards cost honesty — breakdown caption tone (ISS-5842)", () => {
  // ISS-4773 escalated this caption to the row's amber `text-warning-foreground`
  // treatment whenever the excluded share outweighed the headline. ISS-5842
  // removes that: product (Mike, 2026-08-10) — "it shouldn't be yellow … follow
  // same treatment as sessions-cost-billing-honesty disabled". A
  // subscription-covered figure and an unclassified figure are facts about the
  // account, not problems to act on, and a permanently-amber caption spends the
  // one signal we would need to warn about something real later.
  //
  // Both cases below are asserted, and both would FAIL before the change: the
  // dominant-unknown fixture is exactly the input that used to trigger the
  // escalation, so a test that only covered the smaller-share case would pass
  // against the old code and prove nothing.
  it("renders the breakdown in the neutral caption tone even when the excluded share outweighs the headline", () => {
    // $16,783 excluded against a $42 headline — the ISS-4773 escalation trigger.
    const { container } = renderCardsWithCostHonesty(honestUsageFixture());

    const caption = screen.getByText(
      "+$2,030 via subscription · $16,783 billing unknown"
    );
    expect(caption.className).not.toContain("text-warning-foreground");
    // The alert glyph goes with the tone: there is no fault to mark.
    expect(container.querySelector("svg.lucide-triangle-alert")).toBeNull();
  });

  it("renders the breakdown in the same neutral tone when the headline is the larger figure", () => {
    renderCardsWithCostHonesty(
      honestUsageFixture({
        apiEstimatedCost: 16_825,
        meteredEstimatedCost: 16_000,
        unknownEstimatedCost: 825,
      })
    );

    const caption = screen.getByText(
      "+$2,030 via subscription · $825 billing unknown"
    );
    expect(caption.className).not.toContain("text-warning-foreground");
  });
});

/**
 * #4480 — the Cost chip must grade the basis the HEADLINE rendered.
 *
 * The card can print either figure, so pairing the chip with a fixed key puts
 * two different numbers under one comparison. `costDeltaKey` is the mapping that
 * keeps them together; these cases drive it through the real component, in both
 * directions, so deleting the call site cannot leave the suite green.
 *
 * The two entries move OPPOSITE ways, which is what makes the assertions
 * discriminating: a card reading the wrong key renders the other sign.
 */
describe("SessionsSummaryCards cost delta basis (#4480)", () => {
  it("grades the METERED entry when the honest basis is the one headlined", () => {
    renderCardsWithCostHonesty(honestUsageFixture(), COST_BASIS_DELTAS);

    // The honest label proves which basis won; the chip proves the delta
    // followed it rather than grading the API figure beside it.
    expect(
      screen.getByText(SESSIONS_COST_HONEST_METRIC_CARD_LABEL)
    ).toBeInTheDocument();
    expect(costDeltaChipText()).toBe(formatDeltaPct(METERED_COST_DELTA_PCT));
  });

  it("grades the API entry when the flag is off and the collapsed basis is headlined", () => {
    render(
      <SessionsSummaryCards
        deltas={COST_BASIS_DELTAS}
        isLoading={false}
        usage={honestUsageFixture()}
      />
    );

    expect(
      screen.getByText(SESSIONS_COST_METRIC_CARD_LABEL)
    ).toBeInTheDocument();
    expect(costDeltaChipText()).toBe(formatDeltaPct(API_COST_DELTA_PCT));
  });
});
