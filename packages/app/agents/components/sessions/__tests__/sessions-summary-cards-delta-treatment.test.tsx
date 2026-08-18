import { WithUnifiedDeltaPill } from "@repo/app/shared/feature-flags/metric-delta-treatment-fixtures";
import {
  DeltaSentiment,
  deltaPillClass,
  deltaPillGeometryClass,
  MetricDeltaTreatment,
} from "@repo/design-system/components/ui/primitives/metric-polarity";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SESSIONS_COST_METRIC_CARD_LABEL } from "../cost-metric-card";
import {
  createFullyPopulatedSessionsUsageFixture,
  createSessionSummaryDeltasFixture,
} from "../session-list-fixtures";
import {
  PRS_SHIPPED_METRIC_CARD_LABEL,
  SESSIONS_METRIC_CARD_LABEL,
  TOTAL_TOKENS_METRIC_CARD_LABEL,
} from "../sessions-summary-card-labels";
import { SessionsSummaryCards } from "../sessions-summary-cards";

/**
 * ISS-5842 (follow-up) — the delta TREATMENT reaches every card in the Sessions
 * strip, not just the ones that happened to spell the prop.
 *
 * The defect this pins: `MetricCard` defaults an absent `deltaTreatment` to
 * `MetricDeltaTreatment.Legacy`, and the Sessions and Total Tokens cards spread a
 * `deltaSlotProps` bag that carried no treatment. With
 * `metric-delta-unified-pill` ON, the Cost card (which resolves the flag itself)
 * rendered the unified pill while Total Tokens beside it rendered a bare grey
 * "-52%" — one row, two delta families, and no error anywhere to say so.
 *
 * NEUTRAL is the tone that makes it visible, which is why it leads here. Under
 * `Legacy` a neutral delta has NO pill geometry at all (deliberately: it must not
 * be confused with the muted "No comparison" placeholder). Under `UnifiedPill` it
 * takes the full pill plus `bg-foreground/5`. A scored tone would hide the bug —
 * both treatments give improvement/regression the same geometry AND the same
 * colour, so a Sessions card stuck on `Legacy` would look correct.
 *
 * Every expectation is DERIVED from `deltaPillGeometryClass` / `deltaPillClass`
 * rather than spelled as a literal, so the tokens can be retuned in one place
 * without this file going stale — and `unifiedOnlyClasses` asserts the two
 * treatments actually differ before any "not" assertion is allowed to pass.
 */

const DELTA_CHIP = "metric-delta-chip";
const WHITESPACE = /\s+/;
/**
 * The neutral movements under test, from the OWNING fixture module rather than
 * a literal here (`agents/AGENTS.md`), so this suite and the
 * `Sessions summary delta slots` story that renders the same state cannot drift
 * onto two different scenarios. `tokens.delta` is the operator-reported figure.
 */
const NEUTRAL_DELTAS = createSessionSummaryDeltasFixture();
/**
 * Every card in the strip that renders a movement chip on `NEUTRAL_DELTAS`.
 * Named rather than discovered, so a card silently losing its chip fails the
 * count assertion instead of shrinking what "the whole strip" means.
 */
const CHIP_BEARING_CARD_LABELS = [
  SESSIONS_METRIC_CARD_LABEL,
  TOTAL_TOKENS_METRIC_CARD_LABEL,
  SESSIONS_COST_METRIC_CARD_LABEL,
  PRS_SHIPPED_METRIC_CARD_LABEL,
];
const TOKENS_DELTA_TEXT = `${NEUTRAL_DELTAS.tokens?.delta}%`;
const SESSIONS_DELTA_TEXT = `${NEUTRAL_DELTAS.sessions?.delta}%`;

/** The card carrying `label`, so an assertion cannot drift onto a sibling. */
function cardFor(label: string): HTMLElement {
  const card = screen.getByText(label).closest('[data-slot="card"]');
  if (!(card instanceof HTMLElement)) {
    throw new Error(`No metric card found for "${label}"`);
  }
  return card;
}

/** Every class `MetricDeltaChip` composes for a tone under a treatment. */
function pillClasses(
  sentiment: DeltaSentiment,
  treatment: MetricDeltaTreatment
): string[] {
  return `${deltaPillGeometryClass(sentiment, treatment)} ${deltaPillClass(
    sentiment,
    treatment
  )}`
    .trim()
    .split(WHITESPACE);
}

/**
 * The classes that belong to `UnifiedPill` and NOT to `Legacy` for this tone —
 * the only ones whose absence proves a card fell back to the default. Asserting
 * "not `text-muted-foreground`" would be false for both treatments; asserting
 * "not the whole unified list" would pass on a single shared class.
 */
function unifiedOnlyClasses(sentiment: DeltaSentiment): string[] {
  const legacy = pillClasses(sentiment, MetricDeltaTreatment.Legacy);
  return pillClasses(sentiment, MetricDeltaTreatment.UnifiedPill).filter(
    (className) => !legacy.includes(className)
  );
}

function renderStrip(unifiedPill: boolean) {
  const strip = (
    <SessionsSummaryCards
      deltas={NEUTRAL_DELTAS}
      isLoading={false}
      usage={createFullyPopulatedSessionsUsageFixture()}
    />
  );
  return render(
    unifiedPill ? <WithUnifiedDeltaPill>{strip}</WithUnifiedDeltaPill> : strip
  );
}

/**
 * A tone whose two treatments are indistinguishable would make every assertion
 * below vacuous, so prove they differ before spending them.
 */
describe("neutral delta treatments are actually distinguishable", () => {
  it("gives UnifiedPill classes Legacy does not have for a neutral tone", () => {
    expect(unifiedOnlyClasses(DeltaSentiment.Neutral).length).toBeGreaterThan(
      0
    );
  });
});

describe("Sessions strip delta treatment — Total Tokens (ISS-5842)", () => {
  it("renders the unified pill on the neutral tone when the gate is ON", () => {
    renderStrip(true);

    const chip = within(cardFor(TOTAL_TOKENS_METRIC_CARD_LABEL)).getByTestId(
      DELTA_CHIP
    );
    // The movement it is grading is the operator's real figure, not a sibling's.
    expect(chip).toHaveTextContent(TOKENS_DELTA_TEXT);
    // Geometry AND colour, both from the unified family.
    expect(chip).toHaveClass(
      ...pillClasses(DeltaSentiment.Neutral, MetricDeltaTreatment.UnifiedPill)
    );
  });

  it("keeps the bare Legacy render on the neutral tone when the gate is OFF", () => {
    renderStrip(false);

    const chip = within(cardFor(TOTAL_TOKENS_METRIC_CARD_LABEL)).getByTestId(
      DELTA_CHIP
    );
    expect(chip).toHaveTextContent(TOKENS_DELTA_TEXT);
    expect(chip).toHaveClass(
      ...pillClasses(DeltaSentiment.Neutral, MetricDeltaTreatment.Legacy)
    );
    // ISS-4779 closed-by-default: no pill geometry, no unified fill.
    for (const className of unifiedOnlyClasses(DeltaSentiment.Neutral)) {
      expect(chip).not.toHaveClass(className);
    }
  });
});

describe("Sessions strip delta treatment — Sessions (ISS-5842)", () => {
  it("renders the unified pill on the neutral tone when the gate is ON", () => {
    renderStrip(true);

    const chip = within(cardFor(SESSIONS_METRIC_CARD_LABEL)).getByTestId(
      DELTA_CHIP
    );
    expect(chip).toHaveTextContent(SESSIONS_DELTA_TEXT);
    expect(chip).toHaveClass(
      ...pillClasses(DeltaSentiment.Neutral, MetricDeltaTreatment.UnifiedPill)
    );
  });

  it("keeps the bare Legacy render on the neutral tone when the gate is OFF", () => {
    renderStrip(false);

    const chip = within(cardFor(SESSIONS_METRIC_CARD_LABEL)).getByTestId(
      DELTA_CHIP
    );
    expect(chip).toHaveTextContent(SESSIONS_DELTA_TEXT);
    expect(chip).toHaveClass(
      ...pillClasses(DeltaSentiment.Neutral, MetricDeltaTreatment.Legacy)
    );
    for (const className of unifiedOnlyClasses(DeltaSentiment.Neutral)) {
      expect(chip).not.toHaveClass(className);
    }
  });
});

/**
 * The whole point of threading the treatment through `deltaSlotProps` rather
 * than per-card: the row must land on ONE delta family.
 *
 * ## This block is the GUARD, not a nicety
 *
 * The required parameter on `deltaSlotProps` stops a caller BUILDING the bag
 * without a treatment; it cannot stop a wrapper card destructuring explicit
 * props and dropping the treatment on the floor, because JSX spreads are not
 * excess-property checked (review on #4907 — `CostMetricCard` was that wrapper).
 * Nothing in the type system closes that, so this block does: render the whole
 * strip under `UnifiedPill` and assert per card. A wrapper that swallows the
 * treatment fails the per-card assertion; a new chip-bearing card fails the
 * count until it is added to the list and therefore covered. Do not weaken
 * either assertion — the module docblock on `deltaSlotProps` points here.
 *
 * wongk (#4907): an earlier version of this block asserted over
 * `getAllByTestId` on a fixture that only carried Sessions and Total Tokens
 * movements, so "the whole strip" could observe nothing beyond the two cards
 * already covered card-by-card above — green for the wrong reason. It now names
 * each chip-bearing card and asserts the unified-ONLY classes on each, and the
 * count assertion pins that all four are actually present, so dropping a card
 * out of the fixture fails here instead of quietly shrinking the claim.
 */
describe("the whole Sessions strip lands on one delta treatment (ISS-5842)", () => {
  it("puts every chip-bearing card on the unified family when the gate is ON", () => {
    renderStrip(true);

    // Every card in the strip that can carry a movement. LOC / $ is absent by
    // design: the prior window's spend is read too late in the request to reach
    // the delivery pass (ISS-6398), so it never compares and never renders a chip.
    expect(screen.getAllByTestId(DELTA_CHIP)).toHaveLength(
      CHIP_BEARING_CARD_LABELS.length
    );
    for (const label of CHIP_BEARING_CARD_LABELS) {
      const chip = within(cardFor(label)).getByTestId(DELTA_CHIP);
      // The unified-ONLY classes, not merely the shared ones: a card that fell
      // back to `Legacy` still carries `text-muted-foreground`, so asserting the
      // full unified list would pass on the overlap.
      expect(chip).toHaveClass(...unifiedOnlyClasses(DeltaSentiment.Neutral));
    }
  });

  it("keeps every chip-bearing card on the bare Legacy render when the gate is OFF", () => {
    renderStrip(false);

    expect(screen.getAllByTestId(DELTA_CHIP)).toHaveLength(
      CHIP_BEARING_CARD_LABELS.length
    );
    for (const label of CHIP_BEARING_CARD_LABELS) {
      const chip = within(cardFor(label)).getByTestId(DELTA_CHIP);
      for (const className of unifiedOnlyClasses(DeltaSentiment.Neutral)) {
        expect(chip).not.toHaveClass(className);
      }
    }
  });

  // The delivery pair's participation is opt-in (`deliveryCompared`), and its
  // absence must yield no chip at all rather than an unstyled one — otherwise
  // the assertions above would be describing a card the host never opted in.
  it("renders no delivery chip on a host that does not compare that pair", () => {
    render(
      <WithUnifiedDeltaPill>
        <SessionsSummaryCards
          deltas={createSessionSummaryDeltasFixture({
            deliveryCompared: false,
          })}
          isLoading={false}
          usage={createFullyPopulatedSessionsUsageFixture()}
        />
      </WithUnifiedDeltaPill>
    );

    expect(
      within(cardFor(PRS_SHIPPED_METRIC_CARD_LABEL)).queryByTestId(DELTA_CHIP)
    ).not.toBeInTheDocument();
  });
});
