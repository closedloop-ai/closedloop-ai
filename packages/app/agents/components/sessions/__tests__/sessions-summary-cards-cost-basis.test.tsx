/**
 * Which cost basis the Sessions "Cost" card reports on, and the copy that goes
 * with it.
 *
 * Was `sessions-summary-cards-cost-honesty.test.tsx`. ISS-8791 retired the
 * ISS-4773 honest presentation and its `sessions-cost-billing-honesty` flag —
 * making breakdown unconditional left honest mode unreachable, because both
 * producers build `totalEstimatedCost` as `subscription + metered + unknown` and
 * `apiEstimatedCost` as `metered + unknown`, so every payload either can emit
 * reconciles and breakdown claims it first. The cases that drove that mode are
 * gone with it. What remains are the contracts that outlived it: the split
 * guard that still decides whether a partition can be reported, the card's
 * label stability across an absent payload, the neutral caption tone, the
 * delta-basis pairing, and the LOC / $ copy that must not claim a match.
 *
 * A sibling of `sessions-summary-cards.test.tsx` rather than more cases inside
 * it: that file is a whole-row suite already at the 1,000-line ceiling, and this
 * is a single, self-contained concern.
 */

import { formatDeltaPct } from "@closedloop-ai/loops-api/insights";
import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { TOTAL_ESTIMATED_COST_ALIAS_LABEL } from "@repo/api/src/types/total-estimated-cost-copy";
import { LOC_PER_DOLLAR_LABEL } from "@repo/api/src/utils/loc-per-dollar";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { SessionSummaryDeltas } from "../../../lib/session-summary-deltas";
import { COST_BREAKDOWN_DISCLOSURE_LABEL } from "../cost-breakdown-lanes";
import { createAgentSessionUsageSummaryFixture } from "../session-list-fixtures";
import { SessionsSummaryCards } from "../sessions-summary-cards";

/**
 * The clause the LOC / $ case below pins the ABSENCE of. That card's copy once
 * claimed its divisor was "the same figure the Cost card shows", which held only
 * while both summed `apiEstimatedCost`. Kept — and deliberately widened to the
 * bare "same figure" — now that the divisor is the total: this is a NEGATIVE
 * assertion, so a broader pattern rejects more, and any revival of the
 * two-cards-one-claim wording fails here however it is phrased.
 */
const MATCHES_COST_CARD_CLAUSE = /same figure/;
/** The self-describing copy that replaced it: the divisor names itself. */
const TOTAL_ESTIMATED_COST_CLAUSE =
  /total estimated cost across matched sessions/;

/** The disclosure clause, matched to assert it is absent on the flag-OFF path. */
const UNCLASSIFIED_PATTERN = /billing unknown/;
/**
 * The disclosure the card offers ONLY in breakdown mode — the lanes themselves
 * mount lazily inside it. Since ISS-10636 both modes headline the same figure
 * under the same label, so a refused partition is no longer visible in the
 * label; this control is what tells the two modes apart, and every refusal case
 * below asserts its absence rather than a second label.
 */
function breakdownDisclosure(): HTMLElement | null {
  return screen.queryByRole("button", {
    name: COST_BREAKDOWN_DISCLOSURE_LABEL,
  });
}
/** `splitUsageFixture`'s `totalEstimatedCost`: the figure EVERY mode headlines. */
const TOTAL_HEADLINE = "$18,855";
/** Its `apiEstimatedCost` — the narrower bucket ISS-10597 took off this card. */
const API_HEADLINE = "$16,825";

/**
 * The reported ISS-4773 shape: a subscription-heavy account whose
 * not-subscription bucket ($16,825) is almost entirely usage the collector could
 * not classify. Only $42 of it was ever billed to an API key.
 *
 * It RECONCILES (2030 + 42 + 16,783 = 18,855), which is deliberate: it means
 * breakdown mode is granted by default, so each split-validation case below
 * reaches the shipped fallback ONLY because its override breaks the guard. Give
 * the fixture a non-reconciling total instead and those cases fall back for that
 * reason rather than the one they name, and stop testing the guard at all.
 */
function splitUsageFixture(
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

/** Render the summary cards over a settled usage payload. */
function renderCards(
  usage: AgentSessionUsageSummary,
  deltas?: SessionSummaryDeltas
) {
  return render(
    <SessionsSummaryCards deltas={deltas} isLoading={false} usage={usage} />
  );
}

/** The TOTAL movement, which every mode grades: DOWN. */
const TOTAL_COST_DELTA_PCT = -12;
/**
 * A rowmate's movement, distinct from the cost one, so the cost chip's text
 * identifies the KEY the card resolved rather than merely proving a chip exists.
 */
const SESSIONS_DELTA_PCT = 41;

/** A landed prior read carrying the cost entry plus one distinct rowmate. */
const COST_BASIS_DELTAS: SessionSummaryDeltas = {
  label: "vs. prior 30 days",
  sessions: {
    delta: SESSIONS_DELTA_PCT,
    deltaPolarity: MetricPolarity.HigherIsBetter,
  },
  totalCost: {
    delta: TOTAL_COST_DELTA_PCT,
    deltaPolarity: MetricPolarity.LowerIsBetter,
  },
};

/**
 * The delta chip belonging to the COST card specifically.
 *
 * The strip renders several chips, so this walks up from the cost label to the
 * nearest ancestor that owns a chip, rather than indexing into a flat list whose
 * order is a layout detail.
 */
function costDeltaChipText(): string | undefined {
  const label = screen.getByText(TOTAL_ESTIMATED_COST_ALIAS_LABEL);
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

describe("SessionsSummaryCards LOC / $ basis copy", () => {
  async function readLocPerDollarInfo() {
    const user = userEvent.setup();
    render(
      <SessionsSummaryCards
        authenticated
        isLoading={false}
        usage={splitUsageFixture()}
      />
    );

    await user.click(
      screen.getByRole("button", {
        name: `About ${LOC_PER_DOLLAR_LABEL}`,
      })
    );
    return await screen.findByRole("dialog", {
      name: `About ${LOC_PER_DOLLAR_LABEL}`,
    });
  }

  it("names total estimated cost as the LOC / $ divisor", async () => {
    const popover = await readLocPerDollarInfo();

    // Asserted in BOTH directions: the presence of the true clause alone would
    // stay green if the false one were appended beside it.
    expect(popover.textContent).toMatch(TOTAL_ESTIMATED_COST_CLAUSE);
    expect(popover.textContent).not.toMatch(MATCHES_COST_CARD_CLAUSE);
  });
});

describe("SessionsSummaryCards cost label stability (ISS-4773)", () => {
  it("keeps an elevated label on the failed-read path, where the card renders chrome with no usage", () => {
    // A failed read still renders the card's label/info chrome with a dashed
    // value (the initial load is a full-card skeleton instead, so this is the
    // reachable "chrome without usage" state). Falling back on an absent payload
    // would label the SAME card "cost" here and something else once a read
    // succeeds — the label flicker reads as the card changing what it measures.
    // An absent payload is "not known yet", not "this producer cannot split the
    // bucket".
    //
    render(
      <SessionsSummaryCards isError isLoading={false} usage={undefined} />
    );

    expect(screen.getByText(TOTAL_ESTIMATED_COST_ALIAS_LABEL)).toBeTruthy();
  });
});

describe("SessionsSummaryCards cost label across the load boundary", () => {
  // ISS-8791 recorded a KNOWN TRADE here: an absent payload is breakdown-
  // eligible on purpose, so a card that SETTLED into the narrower fallback
  // changed its label on arrival, and this block pinned that swap. ISS-10636
  // retired the trade rather than re-pinning it — every mode now headlines the
  // one inclusive total under the one phrase, so there is no second label left
  // to swap to. Both settle paths are kept as counterfactuals: a fallback that
  // reintroduced a per-mode label would redden the first case.
  it("holds the label when an absent payload settles into the fallback", () => {
    const { rerender } = render(
      <SessionsSummaryCards isLoading={false} usage={undefined} />
    );

    expect(screen.getByText(TOTAL_ESTIMATED_COST_ALIAS_LABEL)).toBeTruthy();

    rerender(
      <SessionsSummaryCards
        isLoading={false}
        usage={splitUsageFixture({ unknownEstimatedCost: undefined })}
      />
    );

    expect(screen.getByText(TOTAL_ESTIMATED_COST_ALIAS_LABEL)).toBeTruthy();
  });

  it("holds the label when an absent payload settles into a reportable partition", () => {
    const { rerender } = render(
      <SessionsSummaryCards isLoading={false} usage={undefined} />
    );

    expect(screen.getByText(TOTAL_ESTIMATED_COST_ALIAS_LABEL)).toBeTruthy();

    rerender(
      <SessionsSummaryCards isLoading={false} usage={splitUsageFixture()} />
    );

    expect(screen.getByText(TOTAL_ESTIMATED_COST_ALIAS_LABEL)).toBeTruthy();
  });
});

describe("SessionsSummaryCards cost split validation (ISS-4773)", () => {
  // whitlockk + stage review: the two halves are INDEPENDENTLY optional on the
  // contract, and neither the HTTP response nor the Desktop IPC reply is parsed
  // before it reaches this component. Gating on `metered` alone let a
  // half-populated payload headline a narrowed figure while the clause naming
  // what it excluded silently vanished — understating the population with no
  // signal at all. `hasReportableCostSplit` is that guard, and ISS-8791 left it
  // gating breakdown. Each case below reaches the SHIPPED presentation because
  // its override made the payload unreportable — but only the
  // apiEstimatedCost-reconciliation case isolates THIS guard; the others are
  // also caught by `canReportCostBreakdown`'s own later checks, so they do not
  // prove the call site survives.
  it("refuses the partition when the producer sent metered but no unknown", () => {
    renderCards(splitUsageFixture({ unknownEstimatedCost: undefined }));

    expect(screen.getByText(TOTAL_HEADLINE)).toBeTruthy();
    expect(screen.queryByText(API_HEADLINE)).toBeNull();
    expect(screen.queryByText("$42")).toBeNull();
    expect(screen.queryByText(UNCLASSIFIED_PATTERN)).toBeNull();
  });

  it("refuses the partition when a half arrives as null on the wire", () => {
    // `null` is not in the optional type, but a wire payload can still carry it
    // and nothing between the producer and this render validates the shape.
    // Summing it as 0 would headline a confident, wrong number.
    renderCards(
      splitUsageFixture({
        unknownEstimatedCost: null as unknown as number,
      })
    );

    expect(screen.getByText(TOTAL_HEADLINE)).toBeTruthy();
    expect(screen.queryByText("$42")).toBeNull();
  });

  it("refuses the partition when the two halves do not reconcile with the bucket they partition", () => {
    // metered + unknown must equal apiEstimatedCost. A payload where it does not
    // is a producer bug or a shape we do not understand; either way the card
    // must not headline a figure it cannot substantiate.
    renderCards(splitUsageFixture({ meteredEstimatedCost: 9000 }));

    expect(screen.getByText(TOTAL_HEADLINE)).toBeTruthy();
    expect(screen.queryByText("$9,000")).toBeNull();
  });

  // The case that actually pins `hasReportableCostSplit`'s OWN contract. Every
  // other case in this block is also rejected by a later check inside
  // `canReportCostBreakdown` — the lane-reportability check or the
  // lane-sum-vs-total check — so deleting the `hasReportableCostSplit` call from
  // the production path leaves all of them green. This payload passes both of
  // those (three finite non-negative lanes; 40 + 50 + 50 === 140 === the total)
  // and fails ONLY the `metered + unknown ≈ apiEstimatedCost` reconciliation
  // that `hasReportableCostSplit` alone enforces: 40 + 50 = 90, against a stated
  // api of 100.
  it("refuses the partition when the halves do not reconcile with apiEstimatedCost, even though the lanes total correctly", () => {
    renderCards(
      splitUsageFixture({
        apiEstimatedCost: 100,
        meteredEstimatedCost: 40,
        unknownEstimatedCost: 50,
        subscriptionEstimatedCost: 50,
        totalEstimatedCost: 140,
      })
    );

    expect(breakdownDisclosure()).toBeNull();
  });

  it("accepts a split that reconciles only to within float-accumulation drift", () => {
    // The three figures are independently summed floats, so the guard must
    // tolerate last-ULP drift or it would reject every real payload.
    renderCards(splitUsageFixture({ meteredEstimatedCost: 42.000_000_000_1 }));

    expect(breakdownDisclosure()).toBeTruthy();
  });

  it("rejects a split whose drift exceeds the relative tolerance", () => {
    renderCards(splitUsageFixture({ meteredEstimatedCost: 42.5 }));

    expect(breakdownDisclosure()).toBeNull();
  });
});

/**
 * #4480 — the Cost chip must grade the figure the HEADLINE rendered.
 *
 * ISS-10636 made the TOTAL entry the right answer on BOTH arms, and ISS-10734
 * retired the `apiCost` entry these cases used to contrast it against — a mode
 * pointed there now fails `tsc` rather than a test. What still discriminates is
 * the rowmate: `sessions` carries its own distinct movement, so a card that
 * resolved to any other key renders that percentage or no chip at all, and both
 * cases redden.
 */
describe("SessionsSummaryCards cost delta basis (#4480)", () => {
  it("grades the TOTAL entry when the partition reconciles", () => {
    renderCards(splitUsageFixture(), COST_BASIS_DELTAS);

    expect(breakdownDisclosure()).toBeInTheDocument();
    expect(costDeltaChipText()).toBe(formatDeltaPct(TOTAL_COST_DELTA_PCT));
  });

  it("grades the TOTAL entry when the partition is refused", () => {
    renderCards(
      splitUsageFixture({ unknownEstimatedCost: undefined }),
      COST_BASIS_DELTAS
    );

    expect(breakdownDisclosure()).toBeNull();
    expect(costDeltaChipText()).toBe(formatDeltaPct(TOTAL_COST_DELTA_PCT));
    expect(costDeltaChipText()).not.toBe(formatDeltaPct(SESSIONS_DELTA_PCT));
  });
});
