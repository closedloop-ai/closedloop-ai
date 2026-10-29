import { WithNeutralDeltaPill } from "@repo/app/shared/feature-flags/metric-delta-treatment-fixtures";
import { useMetricDeltaTreatment } from "@repo/app/shared/feature-flags/use-metric-delta-treatment";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  KpiDeltaPlaceholder,
  NO_COMPARISON_CHIP_LABEL,
} from "../kpi-delta-placeholder";

/**
 * The two fills, spelled out rather than read from the maps they police: a test
 * that reads each chip's fill from its own source and asserts they differ is
 * satisfied by both being `undefined`.
 */
const NEUTRAL_PILL_FILL_CLASS = "bg-foreground/5";
const NO_COMPARISON_FILL_CLASS = "bg-muted";
const DELTA_CHIP_TEST_ID = "metric-delta-chip";
const PLACEHOLDER_TEST_ID = "kpi-delta-placeholder";

/**
 * Two cards as a real strip renders them: one with a neutral movement, one with
 * no prior period at all. The treatment is resolved through the production
 * `useMetricDeltaTreatment()` seam, not stubbed, so the gate is exercised the
 * way a shipped surface exercises it.
 */
function NeighbouringCards() {
  const treatment = useMetricDeltaTreatment();
  return (
    <>
      <MetricCard
        delta={-52}
        deltaPolarity={MetricPolarity.Neutral}
        deltaTreatment={treatment}
        label="Total tokens"
        value="1.26B"
      />
      <MetricCard
        deltaPlaceholder={<KpiDeltaPlaceholder />}
        deltaTreatment={treatment}
        label="LOC / $"
        value="—"
      />
    </>
  );
}

// Both chips render on ONE screen because the #4148 objection was about their
// ADJACENCY — a card with a comparison beside a card without one. Asserting each
// against a constant in its own test would pass even if both had converged.
describe("a pilled neutral delta stays distinct from 'No comparison' (ISS-6493 AC2)", () => {
  it("tells the two apart by what each says: a movement, against the words for none", () => {
    render(
      <WithNeutralDeltaPill>
        <NeighbouringCards />
      </WithNeutralDeltaPill>
    );

    // The channel that does the real work, and the one WCAG 1.4.1 needs: the
    // neutral chip states a figure the placeholder cannot, and the placeholder
    // says so in words rather than leaving a blank the reader has to interpret.
    expect(screen.getByTestId(DELTA_CHIP_TEST_ID)).toHaveTextContent("-52%");
    expect(screen.getByTestId(PLACEHOLDER_TEST_ID)).toHaveTextContent(
      NO_COMPARISON_CHIP_LABEL
    );
  });

  // A token-drift guard, NOT the #4148 proof: the two fills composite to the
  // same pixel over `bg-card`, so this cannot see visual separation — only the
  // two collapsing onto one literal, which is a regression this ticket could
  // cause. The text assertion above is what actually holds the constraint up.
  it("keeps their fill tokens from drifting onto one literal", () => {
    render(
      <WithNeutralDeltaPill>
        <NeighbouringCards />
      </WithNeutralDeltaPill>
    );

    const neutralChip = screen.getByTestId(DELTA_CHIP_TEST_ID);
    const placeholder = screen.getByTestId(PLACEHOLDER_TEST_ID);

    // The neutral chip wears the foreground wash and refuses the placeholder's.
    expect(neutralChip).toHaveClass(NEUTRAL_PILL_FILL_CLASS);
    expect(neutralChip).not.toHaveClass(NO_COMPARISON_FILL_CLASS);
    // The placeholder wears its own and refuses the neutral chip's.
    expect(placeholder).toHaveClass(NO_COMPARISON_FILL_CLASS);
    expect(placeholder).not.toHaveClass(NEUTRAL_PILL_FILL_CLASS);
  });
});
