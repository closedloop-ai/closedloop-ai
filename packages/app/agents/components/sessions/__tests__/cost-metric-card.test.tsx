import { MAX_DELTA_PCT } from "@closedloop-ai/loops-api/insights";
import {
  TOTAL_ESTIMATED_COST_COPY,
  TOTAL_ESTIMATED_COST_LABEL,
} from "@repo/api/src/types/total-estimated-cost-copy";
import { WithUnifiedDeltaPill } from "@repo/app/shared/feature-flags/metric-delta-treatment-fixtures";
import { KPI_NO_VALUE } from "@repo/app/shared/lib/format-utils";
import {
  DELTA_SENTIMENT_CAPTION,
  DeltaSentiment,
  deltaPillClass,
  deltaPillGeometryClass,
  MetricDeltaTreatment,
} from "@repo/design-system/components/ui/primitives/metric-polarity";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { COST_METRIC_CARD_LABEL, CostMetricCard } from "../cost-metric-card";

/** A detail line, to pin that the slot renders whatever a caller passes. */
const SAMPLE_DETAIL = "From local history";

// A non-finite delta must never surface as literal "NaN"/"Infinity" chip text.
const NON_FINITE_TEXT = /NaN|Infinity/;

const IMPROVEMENT_VERDICT = String(
  DELTA_SENTIMENT_CAPTION[DeltaSentiment.Improvement]
);
const REGRESSION_VERDICT = String(
  DELTA_SENTIMENT_CAPTION[DeltaSentiment.Regression]
);

function deltaChip(): HTMLElement {
  return screen.getByTestId("metric-delta-chip");
}

// The Dashboard surface feeds the shared card the backend `kpi.sub` single-line
// info (same as its rowmates + the Insights stat tile), so a plain `{ what }`
// stands in for that surface's info shape here.
const DASHBOARD_INFO = {
  what: "estimated cost in range, including subscription-covered usage",
} as const;

describe("CostMetricCard (FEA-3818)", () => {
  it("defaults to the bare metric name", () => {
    render(<CostMetricCard cost={42} />);
    expect(screen.getByText(COST_METRIC_CARD_LABEL)).toBeInTheDocument();
  });

  it("renders a caller's label and a matching accessible name", () => {
    render(<CostMetricCard cost={42} label={TOTAL_ESTIMATED_COST_LABEL} />);

    expect(screen.getByText(TOTAL_ESTIMATED_COST_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(COST_METRIC_CARD_LABEL)).toBeNull();
    // The info control's accessible name follows the label.
    expect(
      screen.getByRole("button", {
        name: `About ${TOTAL_ESTIMATED_COST_LABEL}`,
      })
    ).toBeInTheDocument();
  });

  it("formats a finite value as whole dollars (no cents)", () => {
    render(<CostMetricCard cost={9061} />);
    expect(screen.getByText("$9,061")).toBeInTheDocument();
  });

  it("renders a real $0 for a genuine zero-spend set (not the empty sentinel)", () => {
    render(<CostMetricCard cost={0} />);
    expect(screen.getByText("$0")).toBeInTheDocument();
    expect(screen.queryByText(KPI_NO_VALUE)).toBeNull();
  });

  it("renders the honest-empty '—' for null/undefined/non-finite, never a misleading $0", () => {
    const { rerender } = render(<CostMetricCard cost={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();

    rerender(<CostMetricCard cost={undefined} />);
    expect(screen.getByText("—")).toBeInTheDocument();

    rerender(<CostMetricCard cost={Number.NaN} />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("$0")).toBeNull();
  });

  it("shows the info control with whatever per-surface copy the caller passes", () => {
    const { rerender } = render(
      <CostMetricCard cost={42} info={TOTAL_ESTIMATED_COST_COPY.info} />
    );
    expect(
      screen.getByRole("button", { name: `About ${COST_METRIC_CARD_LABEL}` })
    ).toBeInTheDocument();

    // Dashboard basis: a single-line `{ what }` (its `kpi.sub`) still renders the
    // same info control — the card is agnostic to the copy each surface passes.
    rerender(<CostMetricCard cost={42} info={DASHBOARD_INFO} />);
    expect(
      screen.getByRole("button", { name: `About ${COST_METRIC_CARD_LABEL}` })
    ).toBeInTheDocument();
  });

  it("renders a passed detail line beneath the value", () => {
    render(<CostMetricCard cost={30} detail={SAMPLE_DETAIL} />);
    expect(screen.getByText(SAMPLE_DETAIL)).toBeInTheDocument();
  });

  it("renders a signed delta chip only when a numeric delta is provided", () => {
    const { rerender } = render(
      <CostMetricCard cost={42} delta={5} deltaLabel="vs. prior 90 days" />
    );
    expect(screen.getByText("+5%")).toBeInTheDocument();
    expect(screen.getByText("vs. prior 90 days")).toBeInTheDocument();

    rerender(<CostMetricCard cost={42} />);
    expect(screen.queryByText("+5%")).toBeNull();
  });

  // ISS-4633: this is the Dashboard "Cost" tile. Spend is lower-is-better, so a
  // period-over-period INCREASE must not borrow the green/"improving" chip a
  // throughput metric gets — the live bug was a $123,607 cost with a green
  // ">999%" badge.
  it("renders a rising cost as a regression, not an improvement", () => {
    render(
      <WithUnifiedDeltaPill>
        <CostMetricCard
          cost={123_607}
          delta={38}
          deltaLabel="vs. prior 90 days"
        />
      </WithUnifiedDeltaPill>
    );

    const chip = deltaChip();
    expect(chip).toHaveTextContent("+38%");
    expect(chip).toHaveClass("text-destructive");
    expect(chip).not.toHaveClass("text-success");
    // The arrow stays honest — the number DID go up…
    expect(chip.querySelector("svg.lucide-trending-up")).not.toBeNull();
    // ISS-5842: …and the card no longer spells out a verdict beside it. The
    // tone colour and the arrow carry the reading; the editorial word is gone.
    expect(screen.queryByText(REGRESSION_VERDICT)).toBeNull();
    // Every tone is a pill now — same geometry, colour is the only variable.
    expect(chip).toHaveClass("rounded-full");
  });

  it("renders a falling cost as an improvement", () => {
    render(
      <WithUnifiedDeltaPill>
        <CostMetricCard cost={42} delta={-38} deltaLabel="vs. prior 90 days" />
      </WithUnifiedDeltaPill>
    );

    const chip = deltaChip();
    expect(chip).toHaveClass("text-success");
    expect(chip.querySelector("svg.lucide-trending-down")).not.toBeNull();
    // ISS-5842: no "better" claim — see the rising-cost case above.
    expect(screen.queryByText(IMPROVEMENT_VERDICT)).toBeNull();
    expect(chip).toHaveClass("rounded-full");
  });

  it("reads a flat 0% cost as holding steady, not as a win, and KEEPS the pill", () => {
    // Covers the design-system chip's own neutral path through a real MetricCard
    // consumer.
    //
    // ISS-5842 — this is the counterfactual for acceptance criterion 1. The
    // neutral tone used to drop out of the pill entirely (`isScoredSentiment`
    // gated `rounded-full px-2 py-0.5`), so one row of cards read as three
    // different components. The geometry assertions below FAIL on the old chip;
    // the tone assertions still hold, which is the point — only the colour
    // varies by tone now.
    render(
      <WithUnifiedDeltaPill>
        <CostMetricCard cost={42} delta={0} deltaLabel="vs. prior 90 days" />
      </WithUnifiedDeltaPill>
    );

    const chip = deltaChip();
    expect(chip).toHaveTextContent("0%");
    expect(chip).toHaveClass("text-muted-foreground");
    expect(chip).not.toHaveClass("text-success");
    expect(chip).not.toHaveClass("text-destructive");
    // Same pill geometry as the scored tones.
    expect(chip).toHaveClass("rounded-full");
    expect(chip).toHaveClass("px-2");
    expect(chip).toHaveClass("py-0.5");
    // …in a fill that is NOT the "No comparison" placeholder's flat `bg-muted`,
    // so a real neutral delta can't be mistaken for a failed read.
    expect(chip).toHaveClass("bg-foreground/5");
    expect(chip).not.toHaveClass("bg-muted");
    // No arrow — the number did not move — and no better/worse claim.
    expect(chip.querySelector("svg.lucide-minus")).not.toBeNull();
    expect(screen.queryByText(IMPROVEMENT_VERDICT)).toBeNull();
    expect(screen.queryByText(REGRESSION_VERDICT)).toBeNull();
    // The caption itself still renders, so the footer layout is unchanged.
    expect(screen.getByText("vs. prior 90 days")).toBeInTheDocument();
  });

  // ISS-4779 closed-by-default, and the counterfactual for the whole gate: with
  // the flag OFF (the shipped default) the card must render EXACTLY what it
  // rendered before ISS-5842. If `deltaTreatment` ever defaults to
  // `UnifiedPill`, or a consumer stops threading the flag, every assertion in
  // this test flips — which is precisely the leak whitlockk and codex flagged on
  // #4823, where a shared primitive changed the look on Insights, Branches and
  // the desktop dashboard without any of them opting in.
  it("keeps the pre-ISS-5842 render when the unified-pill flag is OFF", () => {
    const { rerender } = render(
      <CostMetricCard cost={42} delta={0} deltaLabel="vs. prior 90 days" />
    );

    // Neutral is BARE: no pill geometry, and none of the unified fill.
    const neutralChip = deltaChip();
    expect(neutralChip).toHaveTextContent("0%");
    expect(neutralChip).not.toHaveClass("rounded-full");
    expect(neutralChip).not.toHaveClass("px-2");
    expect(neutralChip).not.toHaveClass("bg-foreground/5");

    // A scored tone keeps its pill AND its visible verdict word, the WCAG 1.4.1
    // non-colour channel the ON path drops.
    rerender(
      <CostMetricCard
        cost={123_607}
        delta={38}
        deltaLabel="vs. prior 90 days"
      />
    );
    const risingChip = deltaChip();
    expect(risingChip).toHaveClass("rounded-full");
    expect(risingChip).toHaveClass("text-destructive");
    expect(screen.getByText("worse")).toBeInTheDocument();
  });

  it.each([
    ["NaN", Number.NaN],
    ["+Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])(
    "renders no delta chip for a %s delta at the MetricCard boundary (davetho review on #4148)",
    (_label, delta) => {
      // The MetricCard boundary types `delta` as `number`, but a non-finite value
      // (e.g. a percent-change over a zero base) is really "no comparison".
      // Without the finite guard it would render a bogus chip — on this
      // lower-is-better Cost card, a down-arrow + "NaN%" + a green "better".
      render(
        <CostMetricCard
          cost={123_607}
          delta={delta}
          deltaLabel="vs. prior 90 days"
        />
      );

      expect(screen.queryByTestId("metric-delta-chip")).toBeNull();
      expect(screen.queryByText(NON_FINITE_TEXT)).toBeNull();
      expect(screen.queryByText(IMPROVEMENT_VERDICT)).toBeNull();
      expect(screen.queryByText(REGRESSION_VERDICT)).toBeNull();
    }
  );

  it("forwards a capped delta through to the '>999%' chip (FEA-3959)", () => {
    // whitlockk: the CostMetricCard forwarding path needs its own coverage — the
    // Dashboard Cost tile is a CostMetricCard, not a bare MetricCard. A ceiling
    // delta must render the capped ">999%" affordance, never a raw figure.
    // ISS-5003: this build's `pctDelta` no longer produces a clamp, so what this
    // now guards is the version-skew path — a ±999 from an older producer.
    render(
      <CostMetricCard cost={42} delta={MAX_DELTA_PCT} deltaCapped={true} />
    );
    expect(screen.getByText(`>${MAX_DELTA_PCT}%`)).toBeInTheDocument();
    expect(screen.queryByText(`+${MAX_DELTA_PCT}%`)).toBeNull();
  });

  it("forwards a capped negative delta through to the '<-999%' chip (FEA-3959)", () => {
    render(
      <CostMetricCard cost={42} delta={-MAX_DELTA_PCT} deltaCapped={true} />
    );
    expect(screen.getByText(`<-${MAX_DELTA_PCT}%`)).toBeInTheDocument();
  });

  it("renders the no-comparison placeholder in the delta slot when delta is omitted (FEA-3960)", () => {
    render(
      <CostMetricCard
        cost={42}
        deltaPlaceholder={
          <span data-testid="no-comparison">No comparison</span>
        }
      />
    );
    expect(screen.getByTestId("no-comparison")).toBeInTheDocument();
  });
});

/**
 * ISS-5842 (follow-up, review on #4907) — the card honours a treatment its
 * CALLER resolved, so the Sessions strip's `deltaSlotProps` bag is one source of
 * truth for the whole row rather than two that agree by coincidence.
 *
 * Before this, the card read `useMetricDeltaTreatment()` and nothing else, and
 * silently dropped the `deltaTreatment` the strip spread onto it — JSX spreads
 * are not excess-property checked, so a wrapper that destructures explicit props
 * loses any key it did not declare, with no type error.
 *
 * Both cases below mount with NO flag provider, so the internal hook resolves
 * `Legacy`. That is what makes them non-vacuous: the prop has to actually beat
 * the hook for the ON case to pass, and the OFF case pins that an absent prop
 * still falls back to the hook rather than to some new default.
 */
describe("CostMetricCard delta treatment prop (ISS-5842)", () => {
  it("renders the unified pill from a caller-passed treatment with no provider mounted", () => {
    render(
      <CostMetricCard
        cost={42}
        delta={0}
        deltaLabel="vs. prior 90 days"
        deltaTreatment={MetricDeltaTreatment.UnifiedPill}
      />
    );

    const chip = deltaChip();
    expect(chip).toHaveTextContent("0%");
    // The neutral tone is the one that discriminates: under `Legacy` — which is
    // what the un-provided hook resolves to — it renders BARE.
    expect(chip).toHaveClass(...unifiedOnlyNeutralChipClasses());
  });

  it("falls back to the surface hook when the caller passes no treatment", () => {
    render(
      <CostMetricCard cost={42} delta={0} deltaLabel="vs. prior 90 days" />
    );

    const chip = deltaChip();
    for (const className of unifiedOnlyNeutralChipClasses()) {
      expect(chip).not.toHaveClass(className);
    }
  });
});

/**
 * The classes `UnifiedPill` gives a neutral tone that `Legacy` does not — the
 * only ones whose presence proves the prop won. Both treatments share
 * `text-muted-foreground`, so the full unified list would not discriminate.
 */
function unifiedOnlyNeutralChipClasses(): string[] {
  const legacy = neutralChipClasses(MetricDeltaTreatment.Legacy);
  return neutralChipClasses(MetricDeltaTreatment.UnifiedPill).filter(
    (className) => !legacy.includes(className)
  );
}

function neutralChipClasses(treatment: MetricDeltaTreatment): string[] {
  return `${deltaPillGeometryClass(
    DeltaSentiment.Neutral,
    treatment
  )} ${deltaPillClass(DeltaSentiment.Neutral, treatment)}`
    .trim()
    .split(CHIP_CLASS_SEPARATOR);
}

const CHIP_CLASS_SEPARATOR = /\s+/;
