import { MAX_DELTA_PCT } from "@closedloop-ai/loops-api/insights";
import { WithUnifiedDeltaPill } from "@repo/app/shared/feature-flags/metric-delta-treatment-fixtures";
import {
  formatCurrencyWhole,
  WHOLE_CURRENCY_BELOW_FLOOR,
} from "@repo/app/shared/lib/format-utils";
import {
  DeltaSentiment,
  deltaPillClass,
  deltaPillGeometryClass,
  MetricDeltaTreatment,
} from "@repo/design-system/components/ui/primitives/metric-polarity";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  COST_METRIC_CARD_LABEL,
  CostMetricCard,
  formatCostMetricDetail,
  formatHonestCostMetricDetail,
  SESSIONS_COST_METRIC_CARD_INFO,
  SESSIONS_COST_METRIC_CARD_LABEL,
} from "../cost-metric-card";

// The Dashboard surface feeds the shared card the backend `kpi.sub` single-line
// info (same as its rowmates + the Insights stat tile), so a plain `{ what }`
// stands in for that surface's info shape here.
const DASHBOARD_INFO = {
  what: "estimated cost in range, including subscription-covered usage",
} as const;

// The detail line names the API-EQUIVALENT cost of subscription-covered usage —
// what it WOULD have cost if metered — and says so in the conditional mood
// ("if billed to API", FEA-4231). ISS-6092 briefly moved it to "est. API spend
// via subscription"; codex review on #4905 rejected that as asserting spend the
// subscription user was never charged, so the conditional is restored. The value
// is the canonical `subscriptionEstimatedCost` field ($70 for the known fixture
// — API-billed $30, inclusive total $100). No space after the leading plus, so
// it reads as an additive figure, not a period-over-period change chip.
const SUBSCRIPTION_DETAIL_PATTERN = /\+\$70 if billed to API/;

// The counterfactual qualifier the caption must carry, in whatever wording it
// ships: without it the figure reads as money the account was actually charged
// (codex P1 on #4905). Asserted as a MOOD, not a fixed phrase, so a future
// rewording that stays conditional still passes and one that drops the
// conditional cannot.
const COUNTERFACTUAL_QUALIFIER_PATTERN = /\bif billed to\b|would have cost/;

// A non-finite delta must never surface as literal "NaN"/"Infinity" chip text.
const NON_FINITE_TEXT = /NaN|Infinity/;

function deltaChip(): HTMLElement {
  return screen.getByTestId("metric-delta-chip");
}

// FEA-3818: one shared cost card behind both the Sessions summary row and the
// org Dashboard KPI row. These assert the shared value/formatting/empty-state
// contract so the two surfaces can't drift.
describe("CostMetricCard (FEA-3818)", () => {
  it("defaults to the inclusive 'Cost' label so the Dashboard/other callers are unchanged (ISS-4401)", () => {
    render(<CostMetricCard cost={42} />);
    expect(screen.getByText(COST_METRIC_CARD_LABEL)).toBeInTheDocument();
    // The default is the inclusive label, NOT the per-surface metered one.
    expect(screen.queryByText(SESSIONS_COST_METRIC_CARD_LABEL)).toBeNull();
  });

  it("renders the per-surface metered label and matching accessible name when a caller passes `label` (ISS-4401)", () => {
    render(
      <CostMetricCard
        cost={42}
        info={SESSIONS_COST_METRIC_CARD_INFO}
        label={SESSIONS_COST_METRIC_CARD_LABEL}
      />
    );
    // The Sessions surface passes the per-surface label ("Non-subscription
    // Cost"); the inclusive "Cost" default must NOT be what renders.
    expect(
      screen.getByText(SESSIONS_COST_METRIC_CARD_LABEL)
    ).toBeInTheDocument();
    expect(screen.queryByText(COST_METRIC_CARD_LABEL)).toBeNull();
    // The info control's accessible name follows the label.
    expect(
      screen.getByRole("button", {
        name: `About ${SESSIONS_COST_METRIC_CARD_LABEL}`,
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
    expect(screen.queryByText("—")).toBeNull();
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
      <CostMetricCard cost={42} info={SESSIONS_COST_METRIC_CARD_INFO} />
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
    render(<CostMetricCard cost={30} detail={formatCostMetricDetail(70)} />);
    expect(screen.getByText(SUBSCRIPTION_DETAIL_PATTERN)).toBeInTheDocument();
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
    expect(screen.queryByText("worse")).toBeNull();
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
    expect(screen.queryByText("better")).toBeNull();
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
    expect(screen.queryByText("better")).toBeNull();
    expect(screen.queryByText("worse")).toBeNull();
    // The caption itself still renders, so the footer layout is unchanged.
    expect(screen.getByText("vs. prior 90 days")).toBeInTheDocument();
  });

  // ISS-4779 closed-by-default, and the counterfactual for the whole gate: with
  // the flag OFF (the shipped default) the card must render EXACTLY what it
  // rendered before ISS-5842. If `deltaTreatment` ever defaults to
  // `UnifiedPill`, or a consumer stops threading the flag, every assertion in
  // this test flips — which is precisely the leak wongk and codex flagged on
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
  ])("renders no delta chip for a %s delta at the MetricCard boundary (shafty023 review on #4148)", (_label, delta) => {
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
    expect(screen.queryByText("better")).toBeNull();
    expect(screen.queryByText("worse")).toBeNull();
  });

  it("forwards a capped delta through to the '>999%' chip (FEA-3959)", () => {
    // wongk: the CostMetricCard forwarding path needs its own coverage — the
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

  // FEA-3434: the "i" tooltip copy must be accurate and complete relative to
  // the two numbers the card actually shows — the API-billed headline
  // (`apiEstimatedCost`, which is NOT subscription/seat-covered) and, when it's
  // non-zero, the API-equivalent-cost detail line for subscription-covered usage
  // (`subscriptionEstimatedCost`).
  describe("Sessions Cost tooltip accuracy (FEA-3434)", () => {
    it("names the headline as not-subscription-covered spend, never the cohort's whole cost", () => {
      // The codex P1 on #4905. ISS-6092's first draft reworded these to "Cost
      // across the filtered sessions" / "Session cost is summed for the selected
      // and filtered range" — copy that describes the cohort TOTAL. With the
      // honesty flag off (the default) the headline is `apiEstimatedCost` alone,
      // so on the canonical $30-API/$70-subscription cohort the card shows $30
      // while that copy claimed $100's worth of ground. Both strings must keep
      // the qualifier; these two assertions fail against that draft.
      expect(SESSIONS_COST_METRIC_CARD_INFO.what).toContain(
        "not covered by a subscription"
      );
      expect(SESSIONS_COST_METRIC_CARD_INFO.how).toContain(
        "counting only the sessions a subscription doesn't cover"
      );
      // ISS-6092's contribution is the plainer voice, so the exact strings are
      // pinned too — any drift in either fails here.
      expect(SESSIONS_COST_METRIC_CARD_INFO.what).toBe(
        "Cost across the filtered sessions not covered by a subscription."
      );
      expect(SESSIONS_COST_METRIC_CARD_INFO.how).toBe(
        "Session cost is summed for the selected and filtered range, counting only the sessions a subscription doesn't cover. The caption beneath estimates what the subscription-covered sessions would have cost if billed to an API key."
      );
      // FEA-3434's FORM rule survives the rewording and still governs: no
      // implementation jargon, no query-time recompute claim.
      for (const jargon of [
        "stored estimated cost",
        "billing source",
        "denominator",
        "subtext",
        "tokens × model rate",
      ]) {
        expect(SESSIONS_COST_METRIC_CARD_INFO.what).not.toContain(jargon);
        expect(SESSIONS_COST_METRIC_CARD_INFO.how).not.toContain(jargon);
      }
    });

    it("keeps the copy free of em dashes (reader-facing punctuation)", () => {
      expect(SESSIONS_COST_METRIC_CARD_INFO.what).not.toContain("—");
      expect(SESSIONS_COST_METRIC_CARD_INFO.how).not.toContain("—");
    });

    it("keeps `what` a single short headline sentence, with `how` carrying the reconciliation", () => {
      // `what` is one sentence (its rowmates land ~50 chars); the subscription
      // reconciliation lives in `how`, not crammed into `what`.
      expect(SESSIONS_COST_METRIC_CARD_INFO.what.split(". ")).toHaveLength(1);
      // `how` glosses the covered usage's API-EQUIVALENT cost in the SAME
      // conditional mood the caption uses ("+$X if billed to API") — never a
      // real "subscription cost added on top", which reads as a charged seat
      // fee. ISS-6092 shortened the phrase from FEA-4231's "would have cost if
      // it had been billed to an API key"; the mood assertion is what actually
      // guards the meaning, so it is checked with the same pattern the caption
      // is, and the caption and this tooltip have to move together.
      expect(SESSIONS_COST_METRIC_CARD_INFO.how).toMatch(
        COUNTERFACTUAL_QUALIFIER_PATTERN
      );
      expect(SESSIONS_COST_METRIC_CARD_INFO.how).toContain(
        "would have cost if billed to an API key"
      );
      expect(SESSIONS_COST_METRIC_CARD_INFO.how).not.toContain(
        "subscription cost added on top"
      );
    });

    it("reconciles the API-billed headline with the rendered equivalent-cost line (no drift)", () => {
      // Known fixture: API-billed $30, subscription-covered usage worth $70 at
      // model rates (the canonical `subscriptionEstimatedCost` field). The card
      // composes them: $30 headline + $70 equivalent-cost line = the $100
      // inclusive total service.ts reports.
      const apiEstimatedCost = 30;
      const subscriptionEstimatedCost = 70;

      render(
        <CostMetricCard
          cost={apiEstimatedCost}
          detail={formatCostMetricDetail(subscriptionEstimatedCost)}
          info={SESSIONS_COST_METRIC_CARD_INFO}
        />
      );

      // Headline renders the API-billed basis the `what` copy names.
      expect(screen.getByText(`$${apiEstimatedCost}`)).toBeInTheDocument();
      // The detail line renders the canonical subscription share via the
      // production `formatCostMetricDetail`, so the two on-screen numbers
      // reconcile with the tooltip's described basis and can't drift.
      expect(screen.getByText(SUBSCRIPTION_DETAIL_PATTERN)).toBeInTheDocument();
    });
  });

  describe("formatCostMetricDetail (FEA-4231)", () => {
    it("captions the API-equivalent cost of covered usage as an estimate, not the inclusive total", () => {
      // The value is `subscriptionEstimatedCost` ($70), read from the field the
      // summary already carries rather than recomputed by subtraction, and NOT
      // "incl. subscription: $100" (a larger rival total).
      //
      expect(formatCostMetricDetail(70)).toBe("+$70 if billed to API");
      // The codex P1 on #4905, pinned as an invariant rather than only as an
      // exact string: whenever `subscriptionEstimatedCost` is positive this
      // figure is a price nobody was charged, so the caption MUST carry an
      // explicit counterfactual. ISS-6092's "+$70 est. API spend via
      // subscription" draft fails this line — "est." qualifies the number's
      // precision, not its reality, and the sentence still asserts API spend
      // the subscription user incurred.
      expect(formatCostMetricDetail(70)).toMatch(
        COUNTERFACTUAL_QUALIFIER_PATTERN
      );
      // Leading plus has NO space (an additive figure, not a change chip).
      expect(formatCostMetricDetail(70)).not.toContain("+ $");
    });

    it("reads the canonical subscription field directly, never derived from total or api", () => {
      // FEA-3986: `totalEstimatedCost` is now the subscription-INCLUSIVE total
      // (`subscriptionEstimatedCost + apiEstimatedCost`) on BOTH producers, so a
      // `total − api` recompute would just re-derive the field the summary already
      // carries and risk float drift. `formatCostMetricDetail` sidesteps that by
      // reading `subscriptionEstimatedCost` DIRECTLY (chatgpt-codex-connector P2),
      // so the real $0.49 share surfaces regardless of the total/api relationship.
      // formatCurrencyWhole renders a below-round-to-dollar value in full cents
      // ($0.49; a value of $0.50+ would round to a whole dollar).
      expect(formatCostMetricDetail(0.49)).toBe("+$0.49 if billed to API");
    });

    it("drops the line when there is no subscription share to add", () => {
      // A zero, negative, or non-finite share means nothing was layered on top of
      // the headline, so the card shows only its headline.
      expect(formatCostMetricDetail(0)).toBeUndefined();
      expect(formatCostMetricDetail(-5)).toBeUndefined();
      expect(formatCostMetricDetail(null)).toBeUndefined();
      expect(formatCostMetricDetail(undefined)).toBeUndefined();
      expect(formatCostMetricDetail(Number.NaN)).toBeUndefined();
    });

    it("captions a real sub-cent share with its true figure, never a lying '+$0.00'", () => {
      // ISS-4919: formatCurrencyWhole routes the sub-cent band through
      // formatCostPrecise, so a real $0.004 share now shows the figure it
      // actually is. The rule this drop-guard enforces is "never state an
      // amount while showing nothing added" — a visible $0.004 satisfies it,
      // and suppressing the line would hide real covered usage instead.
      expect(formatCostMetricDetail(0.004)).toBe("+$0.004 if billed to API");
      expect(formatCostMetricDetail(0.004)).not.toContain("$0.00 ");
    });

    it("still drops the line when the share is below the precision floor", () => {
      // Below formatCostPrecise's 4dp floor there is no figure left to show, so
      // the caption would promise an amount with nothing behind it
      // (closedloop-ai-stage review).
      //
      // ISS-4919 changed WHAT the formatter emits there — a bound, not the old
      // fabricated "$0.00" — so this drop guard keys on the bound too. The card
      // keeps its editorial call: "+< $0.01 if billed to API" is broken grammar
      // wrapped around a quantity too small for a sentence whose job is to
      // quantify. The bound is the right render for a KPI value, not here.
      //
      // The bound asserted is the WHOLE-DOLLAR one (review thread): this card
      // formats through `formatCurrencyWhole`, which states its bound at the
      // precision it renders, not at `formatCostPrecise`'s 4dp floor.
      expect(formatCurrencyWhole(0.000_01)).toBe(WHOLE_CURRENCY_BELOW_FLOOR);
      expect(formatCurrencyWhole(0.000_01)).not.toBe("$0.00");
      expect(formatCostMetricDetail(0.000_01)).toBeUndefined();
    });
  });
});

describe("formatHonestCostMetricDetail (ISS-4773)", () => {
  it("names the subscription value and DISCLOSES the unclassified share", () => {
    // The reported card, in its honest form: the ~$16,783 that dominated the old
    // headline was never confirmed spend, so it moves out of the number and onto
    // the caption BY NAME rather than being silently dropped.
    expect(formatHonestCostMetricDetail(2030, 16_783)).toBe(
      "+$2,030 via subscription · $16,783 billing unknown"
    );
  });

  it("shows only the subscription clause when nothing is unclassified", () => {
    // The clean account: every session's billing mode resolved, so there is no
    // second fact and the caption must not manufacture one.
    expect(formatHonestCostMetricDetail(2030, 0)).toBe(
      "+$2,030 via subscription"
    );
  });

  it("shows only the unclassified clause when there is no subscription usage", () => {
    // An all-API account with a detection gap: the disclosure still has to
    // appear, because the headline it sits under is now missing that money.
    expect(formatHonestCostMetricDetail(0, 16_783)).toBe(
      "$16,783 billing unknown"
    );
  });

  it("drops the caption entirely when neither clause carries a real figure", () => {
    // Nothing to disclose ⇒ no caption at all, rather than an empty detail row.
    expect(formatHonestCostMetricDetail(0, 0)).toBeUndefined();
    expect(formatHonestCostMetricDetail(null, undefined)).toBeUndefined();
    expect(formatHonestCostMetricDetail(-5, Number.NaN)).toBeUndefined();
  });

  it("drops a clause with no usable figure, keeping the other", () => {
    // Same floor `formatCostMetricDetail` applies: below it there is no figure
    // left to state, so the clause is omitted rather than printed.
    //
    // The intermediate assertion tracks what the formatter ACTUALLY emits now.
    // It read "$0.00" when this test landed on main; since ISS-4919 that band is
    // a bound, and `formatPositiveCurrency` guards on the same
    // `NO_FIGURE_CURRENCY_STRINGS` set — so "+< $0.01 via subscription" is
    // dropped for exactly the reason "+$0.00 via subscription" was. The behavior
    // under test is unchanged; only the string the formatter hands it moved.
    expect(formatCurrencyWhole(0.000_01)).toBe(WHOLE_CURRENCY_BELOW_FLOOR);
    expect(formatHonestCostMetricDetail(0.000_01, 16_783)).toBe(
      "$16,783 billing unknown"
    );
  });

  it("keeps a real sub-cent share, never rounding it away", () => {
    // ISS-4919 parity: a true $0.004 is a fact, and suppressing it would hide
    // real covered usage.
    expect(formatHonestCostMetricDetail(0.004, 0)).toBe(
      "+$0.004 via subscription"
    );
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
