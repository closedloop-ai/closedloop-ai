import type { KpiStat } from "@repo/api/src/types/insights";
import { KpiDeltaBasis, KpiFormat } from "@repo/api/src/types/insights";
import {
  WithNeutralDeltaPill,
  WithUnifiedDeltaPill,
} from "@repo/app/shared/feature-flags/metric-delta-treatment-fixtures";
import {
  DELTA_SENTIMENT_CAPTION,
  DeltaSentiment,
  deltaPillClass,
  deltaPillGeometryClass,
  MetricDeltaTreatment,
  MetricPolarity,
} from "@repo/design-system/components/ui/primitives/metric-polarity";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { KPI_NOT_COMPUTED_REASON } from "../../lib/kpi-no-comparison-copy";
import {
  NO_COMPARISON_CHIP_LABEL,
  NO_COMPARISON_LABEL,
} from "../kpi-delta-placeholder";
import { KpiMetricTile } from "../kpi-stat-tile";
import { tabTo } from "./metric-card-test-utils";

function makeKpi(overrides: Partial<KpiStat> = {}): KpiStat {
  return {
    key: "captured",
    label: "Captured PRs",
    value: 128,
    format: KpiFormat.Number,
    sub: "128 this period",
    deltaPct: null,
    ...overrides,
  };
}

function renderTile(
  kpi: KpiStat,
  tileId = "captured",
  polarity: MetricPolarity = MetricPolarity.HigherIsBetter
) {
  return render(
    <KpiMetricTile
      kpi={kpi}
      pinned={false}
      polarity={polarity}
      tileId={tileId}
      title="Merged PRs"
    />
  );
}

/**
 * ISS-5842: the same tile with the `metric-delta-unified-pill` gate ON. The
 * verdict word only disappears for a consumer that opted in — with the flag OFF
 * (the shipped default) the tile still spells it out, which the counterfactual
 * at the bottom of the polarity block pins.
 */
function renderTileWithUnifiedPill(
  kpi: KpiStat,
  tileId = "captured",
  polarity: MetricPolarity = MetricPolarity.HigherIsBetter
) {
  return render(
    <WithUnifiedDeltaPill>
      <KpiMetricTile
        kpi={kpi}
        pinned={false}
        polarity={polarity}
        tileId={tileId}
        title="Merged PRs"
      />
    </WithUnifiedDeltaPill>
  );
}

function trendChip(): HTMLElement {
  return screen.getByTestId("kpi-trend-chip");
}

// A non-finite delta must never surface as literal "NaN"/"Infinity" text.
const NON_FINITE_TEXT = /NaN|Infinity/;
const IMPROVEMENT_VERDICT = String(
  DELTA_SENTIMENT_CAPTION[DeltaSentiment.Improvement]
);

describe("KpiMetricTile delta slot (FEA-2494)", () => {
  it("shows a real signed delta for ranges with a prior-period comparison", () => {
    renderTile(makeKpi({ deltaPct: 12 }));

    expect(screen.getByText("+12%")).toBeInTheDocument();
    expect(
      screen.queryByTestId("kpi-delta-placeholder")
    ).not.toBeInTheDocument();
  });

  it("shows an explicit 'No comparison' affordance (not an empty slot) when no comparison exists for the range (FEA-3960)", () => {
    renderTile(makeKpi({ deltaPct: null }));

    const placeholder = screen.getByTestId("kpi-delta-placeholder");
    expect(placeholder).toBeInTheDocument();
    // FEA-3960: a visible, intentional "No comparison" chip — never a bare em
    // dash that reads as forgotten/missing data.
    expect(placeholder).toHaveTextContent(NO_COMPARISON_CHIP_LABEL);
    // A screen-reader-only label explains the absence instead of conveying an
    // empty value. Asserted against the exported SSOT rather than a re-typed
    // literal. The copy is reason-agnostic (FEA-3959 / ISS-5003): it holds for a
    // near-zero prior base AND for an over-ceiling magnitude, where the prior
    // period was full and busy but the comparison is declined on our side.
    expect(placeholder).toHaveTextContent(NO_COMPARISON_LABEL);
  });

  it.each([
    ["NaN", Number.NaN],
    ["+Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])(
    "renders the no-comparison placeholder, not a bogus chip, for a %s delta on a lower-is-better tile (davetho review on #4148)",
    (_label, deltaPct) => {
      // A non-finite deltaPct must fall to the placeholder. Without the boundary
      // guard `NaN > 0` is false, so a lower-is-better tile would render a bogus
      // down-arrow + "NaN%" + a green "better" — a UI that lies about a number
      // that does not exist.
      renderTile(makeKpi({ deltaPct }), "cost", MetricPolarity.LowerIsBetter);

      expect(screen.getByTestId("kpi-delta-placeholder")).toBeInTheDocument();
      expect(screen.queryByTestId("kpi-trend-chip")).not.toBeInTheDocument();
      expect(screen.queryByText(NON_FINITE_TEXT)).not.toBeInTheDocument();
      expect(screen.queryByText(IMPROVEMENT_VERDICT)).not.toBeInTheDocument();
    }
  );

  it("moves the KPI description behind the card info control", async () => {
    const user = userEvent.setup();
    renderTile(makeKpi({ sub: "PRs found in local sessions" }), "kpi:merged");

    expect(
      screen.queryByText("PRs found in local sessions")
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Metric details" })
    ).toBeInTheDocument();

    const trigger = screen.getByRole("button", { name: "About Merged PRs" });

    await user.click(trigger);

    const contentId = trigger.getAttribute("aria-controls");
    const dialog = await screen.findByRole("dialog", {
      name: "About Merged PRs",
    });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(contentId).toBeTruthy();
    expect(dialog).toHaveAttribute("id", contentId);
    expect(dialog).toHaveTextContent("PRs found in local sessions");
  });
});

// ISS-4633: the trend chip used to colour EVERY positive delta green, so a
// rising spend read as "improving". The arrow now reports direction and the
// colour reports sentiment, derived from the metric's declared polarity.
describe("KpiMetricTile trend polarity (ISS-4633)", () => {
  it("colours a rise on a higher-is-better metric as an improvement", () => {
    renderTileWithUnifiedPill(
      makeKpi({ deltaPct: 12 }),
      "kpi:merged",
      MetricPolarity.HigherIsBetter
    );

    const chip = trendChip();
    expect(chip).toHaveTextContent("+12%");
    expect(chip).toHaveClass("text-success");
    expect(chip).not.toHaveClass("text-destructive");
    // ISS-5842: the tone carries the reading; the verdict word is gone.
    expect(chip).not.toHaveTextContent("better");
  });

  it("colours a rise on a lower-is-better metric as a regression, keeping the up-arrow honest", () => {
    renderTileWithUnifiedPill(
      makeKpi({ deltaPct: 38, label: "Cost" }),
      "kpi:cost",
      MetricPolarity.LowerIsBetter
    );

    const chip = trendChip();
    expect(chip).toHaveTextContent("+38%");
    expect(chip).toHaveClass("text-destructive");
    expect(chip).not.toHaveClass("text-success");
    // The number went UP, so the arrow still points up — only the sentiment
    // (colour + the visible verdict word) flips.
    expect(chip.querySelector("svg.lucide-arrow-up")).not.toBeNull();
    // ISS-5842: tone only, no verdict word.
    expect(chip).not.toHaveTextContent("worse");
  });

  it("colours a drop on a lower-is-better metric as an improvement", () => {
    renderTileWithUnifiedPill(
      makeKpi({ deltaPct: -21, label: "Cost" }),
      "kpi:cost",
      MetricPolarity.LowerIsBetter
    );

    const chip = trendChip();
    expect(chip).toHaveTextContent("-21%");
    expect(chip).toHaveClass("text-success");
    expect(chip.querySelector("svg.lucide-arrow-down")).not.toBeNull();
    // ISS-5842: tone only, no verdict word.
    expect(chip).not.toHaveTextContent("better");
  });

  it("colours a drop on a higher-is-better metric as a regression", () => {
    renderTileWithUnifiedPill(
      makeKpi({ deltaPct: -21 }),
      "kpi:merged",
      MetricPolarity.HigherIsBetter
    );

    const chip = trendChip();
    expect(chip).toHaveClass("text-destructive");
    // ISS-5842: tone only, no verdict word.
    expect(chip).not.toHaveTextContent("worse");
  });

  it("passes no verdict on a metric with no good direction", () => {
    renderTile(
      makeKpi({ deltaPct: 38, label: "Tokens" }),
      "kpi:tokens",
      MetricPolarity.Neutral
    );

    const chip = trendChip();
    // The movement is still reported honestly…
    expect(chip).toHaveTextContent("+38%");
    expect(chip.querySelector("svg.lucide-arrow-up")).not.toBeNull();
    // …but nothing claims it is good or bad.
    expect(chip).toHaveClass("text-muted-foreground");
    expect(chip).not.toHaveClass("text-success");
    expect(chip).not.toHaveClass("text-destructive");
    expect(chip).not.toHaveTextContent("better");
    expect(chip).not.toHaveTextContent("worse");
  });

  // ISS-4779 closed-by-default counterfactual: with the gate OFF (the shipped
  // default) the tile still spells out the verdict — the WCAG 2.2 SC 1.4.1
  // non-colour channel. Every "no verdict word" case above passes trivially if
  // the gate stops being read, so this is what keeps them honest.
  it("keeps the visible verdict word when the unified-pill flag is OFF", () => {
    renderTile(
      makeKpi({ deltaPct: 38, label: "Cost" }),
      "kpi:cost",
      MetricPolarity.LowerIsBetter
    );

    const chip = trendChip();
    expect(chip).toHaveTextContent("+38%");
    expect(chip).toHaveTextContent("worse");
  });

  /**
   * ISS-6493 AC5 — this consumer must NOT move, and that is the finding.
   *
   * The ticket lists `kpi-stat-tile` among the five surfaces that "mount the
   * same primitives and must all move together". It resolves the same
   * `useMetricDeltaTreatment()` and does inherit the new treatment — but its
   * delta is `TrendBadge`, bare text plus an arrow with no pill under ANY
   * treatment (that is deliberate: `KpiDeltaPlaceholder` uses `variant="bare"`
   * here precisely so the absent state does not out-design the present one).
   * A pill change therefore has nothing to act on, and the only thing the
   * treatment decides for this tile is the verdict word — which ISS-6493 keeps.
   *
   * So the correct behaviour is byte-identical to the flag-off render above, and
   * that is asserted rather than assumed: if the neutral gate ever started
   * stripping the word here, this tile would silently lose its non-colour cue on
   * a gate whose whole premise is that it does not touch that cue. The
   * `renderTileWithUnifiedPill` cases above are the positive sibling proving
   * this assertion can fail — under THAT gate the word does go.
   */
  it("is unchanged by the neutral-pill gate, whose pill this bare tile never had (ISS-6493)", () => {
    render(
      <WithNeutralDeltaPill>
        <KpiMetricTile
          kpi={makeKpi({ deltaPct: 38, label: "Cost" })}
          pinned={false}
          polarity={MetricPolarity.LowerIsBetter}
          tileId="kpi:cost"
          title="Cost"
        />
      </WithNeutralDeltaPill>
    );

    const chip = trendChip();
    expect(chip).toHaveTextContent("+38%");
    expect(chip).toHaveTextContent("worse");
  });

  /**
   * ISS-6493 AC5, on the tone that can actually show the difference (whitlockk
   * review on #5857).
   *
   * The case above rides `LowerIsBetter` + `+38%`, which grades out SCORED — and
   * every treatment renders a scored tone identically, so it cannot distinguish
   * "this tile deliberately ignores the pill" from "the gate never reached this
   * tile". NEUTRAL is the only tone `TREATMENT_PILLS_EVERY_TONE` changes, so it
   * is the only tone on which this consumer's no-op is a real claim. Production
   * neutral tiles are exactly the ones at stake: Tokens and Sessions.
   *
   * The no-op is the CONTRACT, not an oversight: `TrendBadge` styles its chip
   * with `DELTA_SENTIMENT_TEXT_CLASS` alone and never reaches for
   * `deltaPillClass`/`deltaPillGeometryClass`, so an Insights tile has no pill to
   * gain under any treatment. Asserting that here narrows the rollout claim to
   * what the code actually does — the Sessions/Branches delta families pill,
   * this bare tile does not — so a future change that quietly starts pilling
   * here has to come through this test rather than through a screenshot.
   */
  it("leaves a NEUTRAL tile bare under the neutral-pill gate (ISS-6493)", () => {
    render(
      <WithNeutralDeltaPill>
        <KpiMetricTile
          kpi={makeKpi({ deltaPct: -52, label: "Tokens" })}
          pinned={false}
          polarity={MetricPolarity.Neutral}
          tileId="kpi:tokens"
          title="Tokens"
        />
      </WithNeutralDeltaPill>
    );

    const chip = trendChip();
    expect(chip).toHaveTextContent("-52%");
    // Neutral carries no verdict word under ANY treatment, so its absence here
    // is not evidence about the gate — the pill classes below are.
    expect(chip).toHaveClass("text-muted-foreground");

    // Derived from the polarity SSOT, never retyped: these are precisely the
    // classes a pilling consumer gains for a neutral tone. Empty would make
    // every assertion below vacuous, so the list is proven non-empty first.
    const pillOnlyClasses = neutralPillOnlyClasses();
    expect(pillOnlyClasses.length).toBeGreaterThan(0);
    for (const className of pillOnlyClasses) {
      expect(chip).not.toHaveClass(className);
    }
  });

  it("reads a flat 0% as holding steady, not as a win", () => {
    renderTile(
      makeKpi({ deltaPct: 0 }),
      "kpi:merged",
      MetricPolarity.HigherIsBetter
    );

    const chip = trendChip();
    expect(chip).toHaveTextContent("0%");
    expect(chip).toHaveClass("text-muted-foreground");
    expect(chip).not.toHaveClass("text-success");
    // No arrow: the number did not move.
    expect(chip.querySelector("svg.lucide-minus")).not.toBeNull();
  });
});

describe("KpiMetricTile no-comparison reason (ISS-4995)", () => {
  it("names OUR gap for a metric the producer never compares", () => {
    // Cloud emits `kloc` with no prior-window figure at all. The range copy
    // would send this reader to the range control, which cannot help: no range
    // and no amount of history produces a comparison here.
    renderTile(
      makeKpi({
        key: "kloc",
        label: "KLOC merged",
        deltaBasis: KpiDeltaBasis.NotComputed,
        deltaPct: null,
      }),
      "kpi:kloc"
    );

    const placeholder = screen.getByTestId("kpi-delta-placeholder");
    expect(placeholder).toHaveTextContent(KPI_NOT_COMPUTED_REASON);
    expect(placeholder).not.toHaveTextContent(NO_COMPARISON_LABEL);
    // The visible chip is unchanged — only the explanation differs.
    expect(placeholder).toHaveTextContent(NO_COMPARISON_CHIP_LABEL);
  });

  it("keeps the range copy for a compared metric whose window has no prior period", () => {
    // `merged` IS compared; a null delta here really is a fact about the window
    // (the "all" range, or a prior base too near zero to divide by).
    renderTile(
      makeKpi({
        key: "merged",
        label: "Merged PRs",
        deltaBasis: KpiDeltaBasis.Computed,
        deltaPct: null,
      }),
      "kpi:merged"
    );

    const placeholder = screen.getByTestId("kpi-delta-placeholder");
    expect(placeholder).toHaveTextContent(NO_COMPARISON_LABEL);
    expect(placeholder).not.toHaveTextContent(KPI_NOT_COMPUTED_REASON);
  });

  it("falls back to the range copy for a producer that sends no basis", () => {
    // Version skew: a Desktop/API peer built before ISS-4995 omits the field. It
    // does not tell us which case it is, so we must not assert either cause.
    renderTile(makeKpi({ deltaPct: null }));

    const placeholder = screen.getByTestId("kpi-delta-placeholder");
    expect(placeholder).toHaveTextContent(NO_COMPARISON_LABEL);
    expect(placeholder).not.toHaveTextContent(KPI_NOT_COMPUTED_REASON);
  });

  it("renders the range copy rather than throwing on an inherited basis name", () => {
    // whitlockk review: `deltaBasis` is parsed JSON, so the type does not hold at
    // runtime. Indexing the reason map with `"__proto__"` used to yield
    // `Object.prototype`, which reaches `TooltipContent` as a React child and
    // throws instead of falling back. Rendering through the real tile is the
    // point — the resolver's unit test cannot prove the render survives.
    renderTile(
      makeKpi({ deltaBasis: "__proto__" as KpiDeltaBasis, deltaPct: null })
    );

    const placeholder = screen.getByTestId("kpi-delta-placeholder");
    expect(placeholder).toHaveTextContent(NO_COMPARISON_LABEL);
    expect(placeholder).not.toHaveTextContent(KPI_NOT_COMPUTED_REASON);
  });

  it("puts the reason in the keyboard tab order, not behind hover alone", async () => {
    // Review thread: the tooltip is now the ONE place the two no-comparison
    // states differ, so its sentence carries real information — and the trigger
    // was a bare `<span>`, which is not focusable, so a keyboard user had no
    // path to it at all. Drive a real tab sequence rather than asserting a
    // `tabindex` attribute: the contract is "a keyboard user reaches it and the
    // reason appears", which an attribute check cannot prove.
    const user = userEvent.setup();
    renderTile(
      makeKpi({
        key: "kloc",
        label: "KLOC merged",
        deltaBasis: KpiDeltaBasis.NotComputed,
        deltaPct: null,
      }),
      "kpi:kloc"
    );
    const placeholder = screen.getByTestId("kpi-delta-placeholder");

    // Bounded walk: the tile carries a handful of other stops (the label's info
    // affordance, the overlay controls), so assert the chip is reachable rather
    // than pinning a brittle absolute position in that order.
    await tabTo(user, placeholder);

    expect(placeholder).toHaveFocus();
    // Focus alone must reveal the reason — no pointer involved.
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      KPI_NOT_COMPUTED_REASON
    );
  });

  it("does not offer a click it cannot honour", async () => {
    // Review thread: `globals.css` gives every enabled `button` a pointer cursor
    // in the base layer, so the button that bought the tab stop also started
    // promising an activation on ~12 of the 16 dashboard KPI cards, the Insights
    // tiles, and every branch-detail headline card. There is nothing to click:
    // the tooltip is the whole payload. Drive a real click and assert nothing
    // fires and the chip stays a chip, alongside the cursor the user is shown.
    const user = userEvent.setup();
    renderTile(
      makeKpi({
        key: "kloc",
        label: "KLOC merged",
        deltaBasis: KpiDeltaBasis.NotComputed,
        deltaPct: null,
      }),
      "kpi:kloc"
    );
    const placeholder = screen.getByTestId("kpi-delta-placeholder");

    expect(placeholder).toHaveClass("cursor-default");

    await user.click(placeholder);

    // The chip still reads as the same state after a click: no navigation, no
    // expansion, no toggled label. The reason stays reachable by keyboard, which
    // is the path the button exists for.
    expect(placeholder).toHaveTextContent(NO_COMPARISON_CHIP_LABEL);
    expect(placeholder).toHaveTextContent(KPI_NOT_COMPUTED_REASON);
  });

  it("shows no placeholder at all once the compared metric has a real delta", () => {
    renderTile(
      makeKpi({ deltaBasis: KpiDeltaBasis.Computed, deltaPct: 12 }),
      "kpi:merged"
    );

    expect(
      screen.queryByTestId("kpi-delta-placeholder")
    ).not.toBeInTheDocument();
    expect(trendChip()).toHaveTextContent("+12%");
  });
});

/**
 * ISS-7866. A gated tile used to replace the whole card with a bare bordered
 * box, so the "Connect GitHub" ask arrived with no metric name attached to it.
 */
describe("KpiMetricTile availability detail (ISS-7866)", () => {
  it("keeps the metric label beside the gated affordance", () => {
    render(
      <KpiMetricTile
        availabilityDetail={<button type="button">Connect GitHub</button>}
        kpi={undefined}
        pinned={false}
        polarity={MetricPolarity.HigherIsBetter}
        tileId="kpi:merged"
        title="Merged PRs"
      />
    );

    expect(screen.getByText("Merged PRs")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connect GitHub" })
    ).toBeInTheDocument();
  });

  it("uses the catalog title, not the producer's own label (ISS-12638)", () => {
    render(
      <KpiMetricTile
        availabilityDetail={<span>Unavailable for this scope</span>}
        kpi={makeKpi({ key: "merged", label: "PRs merged" })}
        pinned={false}
        polarity={MetricPolarity.HigherIsBetter}
        tileId="kpi:merged"
        title="Merged PRs"
      />
    );

    expect(screen.getByText("Merged PRs")).toBeInTheDocument();
    expect(screen.queryByText("PRs merged")).not.toBeInTheDocument();
    // The value the producer sent is NOT stated: the tile is declining to
    // report this metric, so printing 128 beside "Unavailable" would contradict
    // the caption it just rendered.
    expect(screen.queryByText("128")).not.toBeInTheDocument();
  });
});

const CLASS_SEPARATOR = /\s+/;

/**
 * The classes a NEUTRAL delta gains under {@link MetricDeltaTreatment.NeutralPill}
 * that it does not carry under {@link MetricDeltaTreatment.Legacy} — i.e. exactly
 * the pill chrome an Insights `TrendBadge` must never pick up.
 *
 * Read from the polarity SSOT rather than retyped: a literal list would keep
 * asserting the old tokens after a retune and quietly stop describing the pill
 * it is named for. Both treatments share `text-muted-foreground` on this tone,
 * so the shared class is filtered out — asserting the full list absent would
 * otherwise fail on the overlap rather than on the pill.
 */
function neutralPillOnlyClasses(): string[] {
  const classesFor = (treatment: MetricDeltaTreatment): string[] =>
    `${deltaPillGeometryClass(DeltaSentiment.Neutral, treatment)} ${deltaPillClass(
      DeltaSentiment.Neutral,
      treatment
    )}`
      .trim()
      .split(CLASS_SEPARATOR)
      .filter(Boolean);

  const legacy = classesFor(MetricDeltaTreatment.Legacy);
  return classesFor(MetricDeltaTreatment.NeutralPill).filter(
    (className) => !legacy.includes(className)
  );
}
