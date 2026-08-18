import type { KpiStat } from "@repo/api/src/types/insights";
import { KpiDeltaBasis, KpiFormat } from "@repo/api/src/types/insights";
import { WithUnifiedDeltaPill } from "@repo/app/shared/feature-flags/metric-delta-treatment-fixtures";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
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
      title="Captured PRs"
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
        title="Captured PRs"
      />
    </WithUnifiedDeltaPill>
  );
}

function trendChip(): HTMLElement {
  return screen.getByTestId("kpi-trend-chip");
}

// A non-finite delta must never surface as literal "NaN"/"Infinity" text.
const NON_FINITE_TEXT = /NaN|Infinity/;

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
  ])("renders the no-comparison placeholder, not a bogus chip, for a %s delta on a lower-is-better tile (shafty023 review on #4148)", (_label, deltaPct) => {
    // A non-finite deltaPct must fall to the placeholder. Without the boundary
    // guard `NaN > 0` is false, so a lower-is-better tile would render a bogus
    // down-arrow + "NaN%" + a green "better" — a UI that lies about a number
    // that does not exist.
    renderTile(makeKpi({ deltaPct }), "cost", MetricPolarity.LowerIsBetter);

    expect(screen.getByTestId("kpi-delta-placeholder")).toBeInTheDocument();
    expect(screen.queryByTestId("kpi-trend-chip")).not.toBeInTheDocument();
    expect(screen.queryByText(NON_FINITE_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByText("better")).not.toBeInTheDocument();
  });

  it("moves the KPI description behind the card info control", async () => {
    const user = userEvent.setup();
    renderTile(
      makeKpi({ label: "Merged PRs", sub: "PRs found in local sessions" }),
      "kpi:merged"
    );

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
    // wongk review: `deltaBasis` is parsed JSON, so the type does not hold at
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
