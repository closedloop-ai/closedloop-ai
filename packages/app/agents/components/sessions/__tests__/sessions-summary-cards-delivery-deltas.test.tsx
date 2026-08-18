import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { LOC_PER_DOLLAR_MERGED_LABEL } from "@repo/api/src/utils/loc-per-dollar";
import {
  buildSessionSummaryDeltas,
  type SessionSummaryDeltas,
} from "@repo/app/agents/lib/session-summary-deltas";
import { NO_COMPARISON_LABEL } from "@repo/app/insights/components/kpi-delta-placeholder";
import { KPI_NOT_COMPUTED_REASON } from "@repo/app/insights/lib/kpi-no-comparison-copy";
import { WithUnifiedDeltaPill } from "@repo/app/shared/feature-flags/metric-delta-treatment-fixtures";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  PRS_SHIPPED_METRIC_CARD_LABEL,
  SESSIONS_METRIC_CARD_LABEL,
} from "../sessions-summary-card-labels";
import { SessionsSummaryCards } from "../sessions-summary-cards";

/**
 * FEA-4202 — the delivery pair's delta slot.
 *
 * These assertions are about WHEN a movement may be shown, which for the
 * cloud-only cards is a data-honesty question, not a layout one. Every case
 * below is a state in which the card renders a `—`; the contract is that none of
 * them may carry a chip, because a graded movement beside a dash narrates a
 * trend in a number the card has just declined to state.
 *
 * Each fixture carries ONLY a `prsShipped` entry, so any chip found in the row
 * is unambiguously the one under test rather than a sibling card's.
 */

const DELTA_CHIP = "metric-delta-chip";
const DELTA_PLACEHOLDER = "kpi-delta-placeholder";
const NO_PRIOR_PERIOD = "No prior period";

function usageFixture(
  overrides: Partial<AgentSessionUsageSummary> = {}
): AgentSessionUsageSummary {
  return {
    apiEstimatedCost: 42,
    byHarness: [],
    byModel: [],
    byRepository: [],
    byUser: [],
    earliestSessionAt: null,
    lastSyncTargets: [],
    latestSessionAt: null,
    mergedLocPerDollar: 3.5,
    mergedPrCount: 7,
    subscriptionEstimatedCost: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalEstimatedCost: 42,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalSessions: 12,
    viewerScope: AgentSessionViewerScope.Organization,
    ...overrides,
  };
}

/**
 * A comparing host with a graded movement for `PRs Shipped` and nothing else.
 *
 * `deliveryCompared` is what opts the delivery pair into the comparison at all
 * (FEA-4202's rollout gate, threaded through the render contract). Every case in
 * this block is about a host that HAS adopted it; the flag-off default has its
 * own block at the bottom of the file.
 */
function prsShippedDeltas(
  overrides: Partial<SessionSummaryDeltas> = {}
): SessionSummaryDeltas {
  return {
    deliveryCompared: true,
    label: "WoW",
    prsShipped: { delta: 25, deltaPolarity: MetricPolarity.HigherIsBetter },
    ...overrides,
  };
}

/** A comparing host with NO entry for the delivery pair — only the caption. */
const DELIVERY_COMPARED_NO_ENTRY: SessionSummaryDeltas = {
  deliveryCompared: true,
  label: "WoW",
};

/** The card carrying `label`, so an assertion cannot drift onto a sibling. */
function cardFor(label: string): HTMLElement {
  const card = screen.getByText(label).closest('[data-slot="card"]');
  if (!(card instanceof HTMLElement)) {
    throw new Error(`No metric card found for "${label}"`);
  }
  return card;
}

describe("PRs Shipped delta chip (FEA-4202)", () => {
  it("renders the movement, its direction and its cadence caption", () => {
    render(
      <WithUnifiedDeltaPill>
        <SessionsSummaryCards
          deltas={prsShippedDeltas()}
          isLoading={false}
          usage={usageFixture()}
        />
      </WithUnifiedDeltaPill>
    );

    const card = cardFor(PRS_SHIPPED_METRIC_CARD_LABEL);
    // The magnitude AND its sign — a chip asserting merely "an element exists"
    // would stay green if the delta rendered as -25%, 0%, or the wrong card's
    // figure.
    const chip = within(card).getByTestId(DELTA_CHIP);
    expect(chip).toHaveTextContent("+25%");
    // ISS-5842: more merged PRs is still graded an improvement — the chip takes
    // the success tone and the rising glyph — but the card no longer spells
    // "better" beside it.
    expect(chip).toHaveClass("text-success");
    expect(chip.querySelector("svg.lucide-trending-up")).not.toBeNull();
    expect(within(card).queryByText("better")).toBeNull();
    expect(within(card).getByText("WoW")).toBeInTheDocument();
    // The value it is grading is still the real count.
    expect(within(card).getByText("7")).toBeInTheDocument();
  });

  it("grades a fall as a regression by tone, on the same card", () => {
    render(
      <WithUnifiedDeltaPill>
        <SessionsSummaryCards
          deltas={prsShippedDeltas({
            prsShipped: {
              delta: -30,
              deltaPolarity: MetricPolarity.HigherIsBetter,
            },
          })}
          isLoading={false}
          usage={usageFixture()}
        />
      </WithUnifiedDeltaPill>
    );

    const card = cardFor(PRS_SHIPPED_METRIC_CARD_LABEL);
    const chip = within(card).getByTestId(DELTA_CHIP);
    expect(chip).toHaveTextContent("-30%");
    // ISS-5842: the regression reading survives in the tone and the falling
    // glyph; the word does not.
    expect(chip).toHaveClass("text-destructive");
    expect(chip.querySelector("svg.lucide-trending-down")).not.toBeNull();
    expect(within(card).queryByText("worse")).toBeNull();
  });

  // ISS-4779 closed-by-default counterfactual for THIS file (thadeusb review).
  // Every case above opts into `WithUnifiedDeltaPill`, so on its own this block
  // would stay green if the treatment ever defaulted to `UnifiedPill` — the
  // "no verdict word" assertions would still hold, for the wrong reason. This
  // renders the SAME fixture with no provider (the shipped default) and pins the
  // opposite: the verdict word is present and the neutral pill chrome is absent.
  it("keeps the pre-ISS-5842 render when the unified-pill flag is OFF", () => {
    render(
      <SessionsSummaryCards
        deltas={prsShippedDeltas({
          prsShipped: {
            delta: -30,
            deltaPolarity: MetricPolarity.HigherIsBetter,
          },
        })}
        isLoading={false}
        usage={usageFixture()}
      />
    );

    const card = cardFor(PRS_SHIPPED_METRIC_CARD_LABEL);
    const chip = within(card).getByTestId(DELTA_CHIP);
    // The movement and its tone are unchanged by the gate…
    expect(chip).toHaveTextContent("-30%");
    expect(chip).toHaveClass("text-destructive");
    // …but the visible verdict word — the WCAG 2.2 SC 1.4.1 non-colour channel —
    // is still rendered, and the scored tone still carries the pill.
    expect(within(card).getByText("worse")).toBeInTheDocument();
    expect(chip).toHaveClass("rounded-full");
  });

  // Signed out we cannot see the cloud merged-PR layer at all, so a chip would
  // grade a trend in data the card is simultaneously refusing to show.
  it("shows no chip when signed out, even with a delta in hand", () => {
    render(
      <SessionsSummaryCards
        authenticated={false}
        deltas={prsShippedDeltas()}
        isLoading={false}
        usage={usageFixture()}
      />
    );

    const card = cardFor(PRS_SHIPPED_METRIC_CARD_LABEL);
    expect(within(card).queryByTestId(DELTA_CHIP)).not.toBeInTheDocument();
    expect(within(card).queryByText("+25%")).not.toBeInTheDocument();
    // It is the signed-out dash that is rendered, not a value.
    expect(within(card).getByText("—")).toBeInTheDocument();
  });

  // A failed read is "Unavailable": the trend is not merely unknown, it is
  // unfounded.
  it("shows no chip on a failed read", () => {
    render(
      <SessionsSummaryCards
        deltas={prsShippedDeltas()}
        isError
        isLoading={false}
        usage={usageFixture()}
      />
    );

    const card = cardFor(PRS_SHIPPED_METRIC_CARD_LABEL);
    expect(within(card).queryByTestId(DELTA_CHIP)).not.toBeInTheDocument();
    expect(within(card).getByText("Unavailable")).toBeInTheDocument();
  });

  // Signed in but the metric is absent (out of range, GitHub not connected):
  // there is no current value for the movement to be a movement IN.
  it("shows no chip when the value itself is unavailable", () => {
    render(
      <SessionsSummaryCards
        deltas={prsShippedDeltas()}
        isLoading={false}
        usage={usageFixture({ mergedPrCount: null })}
      />
    );

    const card = cardFor(PRS_SHIPPED_METRIC_CARD_LABEL);
    expect(within(card).queryByTestId(DELTA_CHIP)).not.toBeInTheDocument();
    expect(within(card).getByText("—")).toBeInTheDocument();
  });

  // "All time" has no prior period, so `buildSessionSummaryDeltas` nulls the
  // label — and a null label must suppress the chip on every card regardless of
  // any entry that survived alongside it.
  it("shows no chip on the All range, whose label is null", () => {
    render(
      <SessionsSummaryCards
        deltas={prsShippedDeltas({ label: null })}
        isLoading={false}
        usage={usageFixture()}
      />
    );

    const card = cardFor(PRS_SHIPPED_METRIC_CARD_LABEL);
    expect(within(card).queryByTestId(DELTA_CHIP)).not.toBeInTheDocument();
    expect(within(card).queryByText("+25%")).not.toBeInTheDocument();
  });

  // The delivery cards must NOT borrow this strip's "No prior period" text: on
  // every bounded range the prior window exists and was read, so that sentence
  // would be false. The shared reason-agnostic "No comparison" affordance states
  // the outcome instead, and keeps the slot filled.
  //
  // This is the case the producer makes routine — it collapses a real zero
  // merged-PR count to `null` ("no fabricated '0 merged PRs'"), so a prior week
  // that genuinely shipped nothing is indistinguishable from an absent figure.
  it("says 'no comparison', never 'no prior period', when the prior window shipped nothing", () => {
    render(
      <SessionsSummaryCards
        deltas={DELIVERY_COMPARED_NO_ENTRY}
        isLoading={false}
        usage={usageFixture()}
      />
    );

    const card = cardFor(PRS_SHIPPED_METRIC_CARD_LABEL);
    expect(within(card).getByTestId(DELTA_PLACEHOLDER)).toBeInTheDocument();
    expect(within(card).queryByText(NO_PRIOR_PERIOD)).not.toBeInTheDocument();
    expect(within(card).queryByTestId(DELTA_CHIP)).not.toBeInTheDocument();
    // The count itself is untouched — only the comparison is withheld.
    expect(within(card).getByText("7")).toBeInTheDocument();
    // The range-shaped default reason, NOT the "we never compute this" one —
    // PRs Shipped IS a compared metric; this particular window just declined.
    expect(
      within(card).getByText(`. ${NO_COMPARISON_LABEL}`)
    ).toBeInTheDocument();
    expect(
      within(card).queryByText(`. ${KPI_NOT_COMPUTED_REASON}`)
    ).not.toBeInTheDocument();
  });

  // The other routine decline on a small-integer metric: `pctDelta` refuses any
  // magnitude at or past its ±999% ceiling, and merged-PR counts cross it easily
  // (1 → 12 is +1100%). ISS-5809 moved that refusal to the producer, so it
  // reaches this component as an OMITTED `prsShipped` key alongside a comparison
  // that plainly exists — the prior period is not in doubt.
  it("says 'no comparison' when the movement exceeded the display ceiling", () => {
    const overCeiling = buildSessionSummaryDeltas({
      comparisonV2Enabled: true,
      current: usageFixture({
        comparison: {
          priorStartDate: "2026-07-25T00:00:00.000Z",
          priorEndDate: "2026-07-31T23:59:59.999Z",
          deltas: { sessions: 20 },
        },
        mergedPrCount: 12,
      }),
      dateRange: "7d",
    });
    // Precondition: the builder really did decline this one, and the caption
    // still names a cadence — so the prior period is not in doubt.
    expect(overCeiling.prsShipped).toBeUndefined();
    expect(overCeiling.label).toBe("WoW");

    render(
      <SessionsSummaryCards
        deltas={overCeiling}
        isLoading={false}
        usage={usageFixture({ mergedPrCount: 12 })}
      />
    );

    const card = cardFor(PRS_SHIPPED_METRIC_CARD_LABEL);
    expect(within(card).getByTestId(DELTA_PLACEHOLDER)).toBeInTheDocument();
    expect(within(card).queryByText(NO_PRIOR_PERIOD)).not.toBeInTheDocument();
    expect(within(card).getByText("12")).toBeInTheDocument();
  });

  // A dashed card carries no placeholder either — the slot rides the available
  // branch, so a card refusing to state a value does not annotate a comparison
  // of it (the ISS-5401 ruling, applied to the delivery pair).
  it("shows no placeholder on the dashed branches", () => {
    render(
      <SessionsSummaryCards
        authenticated={false}
        deltas={DELIVERY_COMPARED_NO_ENTRY}
        isLoading={false}
        usage={usageFixture()}
      />
    );

    const card = cardFor(PRS_SHIPPED_METRIC_CARD_LABEL);
    expect(
      within(card).queryByTestId(DELTA_PLACEHOLDER)
    ).not.toBeInTheDocument();
  });

  // A host that never compares (ISS-6041: the desktop Sessions view in LOCAL
  // mode, whose SQLite producer has no prior-window read) passes no `deltas` and
  // must keep its chip-free footer rather than a permanent "No prior period"
  // implying a comparison that is never coming.
  it("renders neither chip nor placeholder on a host that does not compare", () => {
    render(<SessionsSummaryCards isLoading={false} usage={usageFixture()} />);

    const card = cardFor(PRS_SHIPPED_METRIC_CARD_LABEL);
    expect(within(card).queryByTestId(DELTA_CHIP)).not.toBeInTheDocument();
    expect(within(card).queryByText(NO_PRIOR_PERIOD)).not.toBeInTheDocument();
    expect(
      within(card).queryByTestId(DELTA_PLACEHOLDER)
    ).not.toBeInTheDocument();
  });
});

describe("LOC / $ carries no comparison (FEA-4202 / ISS-6398)", () => {
  // The producer reads the prior window's merged-PR count but not its SPEND, so
  // there is no honest prior ratio to move against (ISS-6398 windowed the current
  // divisor; a prior ratio would divide prior lines by current dollars). It gets
  // neither a chip nor the placeholder: the placeholder would promise a
  // comparison that cannot be made rather than one that has not arrived.
  it("never renders a chip, and explains the absence as never-computed", () => {
    render(
      <SessionsSummaryCards
        deltas={prsShippedDeltas()}
        isLoading={false}
        usage={usageFixture()}
      />
    );

    const card = cardFor(LOC_PER_DOLLAR_MERGED_LABEL);
    expect(within(card).queryByTestId(DELTA_CHIP)).not.toBeInTheDocument();
    expect(within(card).queryByText(NO_PRIOR_PERIOD)).not.toBeInTheDocument();
    // The slot is FILLED, so the row does not end on a hollow card — and the
    // reason is the ISS-4995 "we never work this out" sentence, not the
    // range-shaped default, which would point the reader at the range control:
    // the one control that cannot produce a comparison for this card.
    expect(within(card).getByTestId(DELTA_PLACEHOLDER)).toBeInTheDocument();
    expect(
      within(card).getByText(`. ${KPI_NOT_COMPUTED_REASON}`)
    ).toBeInTheDocument();
    expect(
      within(card).queryByText(`. ${NO_COMPARISON_LABEL}`)
    ).not.toBeInTheDocument();
    // The card itself still renders its real value — only the comparison is
    // withheld.
    expect(within(card).getByText("3.50")).toBeInTheDocument();
  });

  // Its sibling delivery card IS compared in the same render, so this is a
  // scoped decline rather than the delivery pair going dark together.
  it("sits beside a PRs Shipped card that does carry a chip", () => {
    render(
      <SessionsSummaryCards
        deltas={prsShippedDeltas()}
        isLoading={false}
        usage={usageFixture()}
      />
    );

    expect(
      within(cardFor(PRS_SHIPPED_METRIC_CARD_LABEL)).getByTestId(DELTA_CHIP)
    ).toHaveTextContent("+25%");
    expect(
      within(cardFor(LOC_PER_DOLLAR_MERGED_LABEL)).queryByTestId(DELTA_CHIP)
    ).not.toBeInTheDocument();
  });
});

/**
 * The PRODUCTION default — `grid-table-v2` off (review threads on #4681).
 *
 * These build their fixture with the REAL `buildSessionSummaryDeltas` rather
 * than a hand-written object, because the defect was in what that function
 * returns: it emits a delta object on every bounded range regardless of the
 * flag — the ISS-5315 contract the always-available cards rely on — so a
 * delivery card that read "is there an object?" as "may I render?" published the
 * new footer to every flag-off web user. A hand-written fixture cannot catch a
 * regression in the producer that feeds it.
 *
 * Each absence assertion is paired with a POSITIVE CONTROL over the same
 * selector and the same fixture, differing only in the flag, so neither
 * direction of a broken gate can pass: hard-wiring the gate off reddens the
 * controls, hard-wiring it on reddens the flag-off cases.
 */
describe("delivery pair is gated on the rollout flag (FEA-4202)", () => {
  function deltasForFlag(comparisonV2Enabled: boolean): SessionSummaryDeltas {
    return buildSessionSummaryDeltas({
      comparisonV2Enabled,
      current: usageFixture({
        comparison: {
          priorStartDate: "2026-07-25T00:00:00.000Z",
          priorEndDate: "2026-07-31T23:59:59.999Z",
          // 4 → 7 merged PRs, as the producer would report it.
          deltas: { prsShipped: 75, sessions: 20 },
        },
        mergedPrCount: 7,
      }),
      dateRange: "7d",
    });
  }

  function renderForFlag(comparisonV2Enabled: boolean) {
    render(
      <SessionsSummaryCards
        deltas={deltasForFlag(comparisonV2Enabled)}
        isLoading={false}
        usage={usageFixture({ mergedPrCount: 7 })}
      />
    );
  }

  // Precondition, stated as an assertion so the cases below cannot be passing
  // for the wrong reason: flag-off the object still EXISTS and still captions
  // the always-available cards. If this ever went null, every absence assertion
  // in this block would pass vacuously.
  it("still returns a captioned delta object when the flag is off", () => {
    const deltas = deltasForFlag(false);

    expect(deltas).toBeDefined();
    expect(deltas.label).toBe("vs. prior 7 days");
    expect(deltas.sessions).toBeDefined();
  });

  it("renders no chip and no placeholder on PRs Shipped when the flag is off", () => {
    renderForFlag(false);

    const card = cardFor(PRS_SHIPPED_METRIC_CARD_LABEL);
    expect(within(card).queryByTestId(DELTA_CHIP)).not.toBeInTheDocument();
    expect(
      within(card).queryByTestId(DELTA_PLACEHOLDER)
    ).not.toBeInTheDocument();
    // The card is otherwise untouched — it is the COMPARISON that is absent,
    // not the value, so this is not a blank-card false positive.
    expect(within(card).getByText("7")).toBeInTheDocument();
  });

  it("renders the PRs Shipped chip once the flag is on (positive control)", () => {
    renderForFlag(true);

    const card = cardFor(PRS_SHIPPED_METRIC_CARD_LABEL);
    expect(within(card).getByTestId(DELTA_CHIP)).toHaveTextContent("+75%");
    expect(within(card).getByText("7")).toBeInTheDocument();
  });

  it("renders no LOC / $ placeholder when the flag is off", () => {
    renderForFlag(false);

    const card = cardFor(LOC_PER_DOLLAR_MERGED_LABEL);
    expect(
      within(card).queryByTestId(DELTA_PLACEHOLDER)
    ).not.toBeInTheDocument();
    expect(
      within(card).queryByText(`. ${KPI_NOT_COMPUTED_REASON}`)
    ).not.toBeInTheDocument();
    expect(within(card).getByText("3.50")).toBeInTheDocument();
  });

  it("renders the LOC / $ placeholder once the flag is on (positive control)", () => {
    renderForFlag(true);

    const card = cardFor(LOC_PER_DOLLAR_MERGED_LABEL);
    expect(within(card).getByTestId(DELTA_PLACEHOLDER)).toBeInTheDocument();
    expect(
      within(card).getByText(`. ${KPI_NOT_COMPUTED_REASON}`)
    ).toBeInTheDocument();
  });

  // The gate must be SCOPED to the delivery pair. Over-gating — dropping the
  // whole delta object flag-off — would also silence the ISS-5315 cards that
  // have shipped their chips for months, which is a regression in the other
  // direction and would otherwise be invisible to the assertions above.
  it("leaves the always-available cards comparing when the flag is off", () => {
    renderForFlag(false);

    const card = cardFor(SESSIONS_METRIC_CARD_LABEL);
    expect(within(card).getByTestId(DELTA_CHIP)).toBeInTheDocument();
    // ISS-5315 caption wording, byte-for-byte — NOT the v2 cadence.
    expect(within(card).getByText("vs. prior 7 days")).toBeInTheDocument();
    expect(within(card).queryByText("WoW")).not.toBeInTheDocument();
  });

  it("switches that caption to the cadence once the flag is on (positive control)", () => {
    renderForFlag(true);

    const card = cardFor(SESSIONS_METRIC_CARD_LABEL);
    expect(within(card).getByText("WoW")).toBeInTheDocument();
    expect(
      within(card).queryByText("vs. prior 7 days")
    ).not.toBeInTheDocument();
  });
});
