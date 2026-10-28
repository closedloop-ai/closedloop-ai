import {
  DELTA_PILL_GEOMETRY_CLASS,
  DELTA_SENTIMENT_PILL_CLASS,
  DELTA_SENTIMENT_TEXT_CLASS,
  DELTA_SENTIMENT_UNIFIED_PILL_CLASS,
  DeltaSentiment,
  deltaPillClass,
  deltaPillGeometryClass,
  deltaSentiment,
  deltaVerdictCaption,
  isComparableDelta,
  MetricDeltaTreatment,
  MetricPolarity,
} from "@repo/design-system/components/ui/primitives/metric-polarity";
import { describe, expect, it } from "vitest";
import { InsightsKpiKey, KPI_METRIC_POLARITY } from "../kpi-polarity";
import { INSIGHTS_TILES, isKpiTile } from "../tile-catalog";

/** Every sentiment must declare a pill FILL, which is what makes it a pill. */
const PILL_FILL_RE = /^bg-/;

const TEXT_UTILITY_RE = /^text-/;

/**
 * ISS-4633: a delta's direction and its sentiment are separate readings. These
 * pin the sentiment half — that a rise on a lower-is-better metric is a
 * regression, and that every KPI the catalog can render has stated which
 * direction is good for it.
 */
describe("deltaSentiment", () => {
  it("reads a rise as an improvement for a higher-is-better metric", () => {
    expect(deltaSentiment(38, MetricPolarity.HigherIsBetter)).toBe(
      DeltaSentiment.Improvement
    );
  });

  it("reads a rise as a REGRESSION for a lower-is-better metric", () => {
    expect(deltaSentiment(38, MetricPolarity.LowerIsBetter)).toBe(
      DeltaSentiment.Regression
    );
  });

  it("reads a drop as a regression for a higher-is-better metric", () => {
    expect(deltaSentiment(-12, MetricPolarity.HigherIsBetter)).toBe(
      DeltaSentiment.Regression
    );
  });

  it("reads a drop as an IMPROVEMENT for a lower-is-better metric", () => {
    expect(deltaSentiment(-12, MetricPolarity.LowerIsBetter)).toBe(
      DeltaSentiment.Improvement
    );
  });

  it("treats a flat 0% as holding steady — neither a win nor a loss", () => {
    expect(deltaSentiment(0, MetricPolarity.HigherIsBetter)).toBe(
      DeltaSentiment.Neutral
    );
    expect(deltaSentiment(0, MetricPolarity.LowerIsBetter)).toBe(
      DeltaSentiment.Neutral
    );
  });

  it("passes no verdict on a metric with no good direction, at any size", () => {
    expect(deltaSentiment(38, MetricPolarity.Neutral)).toBe(
      DeltaSentiment.Neutral
    );
    expect(deltaSentiment(-38, MetricPolarity.Neutral)).toBe(
      DeltaSentiment.Neutral
    );
  });

  it("rejects non-finite deltas as not comparable (davetho review on #4148)", () => {
    // A NaN / ±Infinity delta (e.g. a percent-change over a zero prior base) is
    // "no comparison", not a real movement. `NaN > 0` is false, so without the
    // boundary guard a lower-is-better card would grade it a false "down".
    expect(isComparableDelta(Number.NaN)).toBe(false);
    expect(isComparableDelta(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isComparableDelta(Number.NEGATIVE_INFINITY)).toBe(false);
    // Real numbers, including a flat 0 and a negative, stay comparable.
    expect(isComparableDelta(0)).toBe(true);
    expect(isComparableDelta(-38)).toBe(true);
    expect(isComparableDelta(38)).toBe(true);
  });

  it("gives every sentiment a colour class in both chip variants", () => {
    for (const sentiment of Object.values(DeltaSentiment)) {
      expect(textTokens(DELTA_SENTIMENT_PILL_CLASS[sentiment])).toEqual([
        EXPECTED_PILL_TONE[sentiment],
      ]);
      expect(textTokens(DELTA_SENTIMENT_TEXT_CLASS[sentiment])).toEqual([
        EXPECTED_TEXT_TONE[sentiment],
      ]);
    }
  });

  it("gives every sentiment the same pill geometry under the unified treatment, differing only in colour (ISS-5842)", () => {
    // Neutral must not borrow `bg-muted`: that is `KpiDeltaPlaceholder`'s "No
    // comparison" chrome, and a real neutral delta wearing it would read as a
    // failed load. This assertion is what stops the two collapsing together
    // again now that neutral has a fill at all.
    expect(
      DELTA_SENTIMENT_UNIFIED_PILL_CLASS[DeltaSentiment.Neutral]
    ).toContain("bg-foreground/5");
    expect(
      DELTA_SENTIMENT_UNIFIED_PILL_CLASS[DeltaSentiment.Neutral]
    ).not.toContain("bg-muted");
    for (const sentiment of Object.values(DeltaSentiment)) {
      expect(DELTA_SENTIMENT_UNIFIED_PILL_CLASS[sentiment]).toMatch(
        PILL_FILL_RE
      );
      // The geometry is literally one shared constant, so no tone can drift into
      // its own padding — that is the whole ISS-5842 claim, asserted directly.
      expect(
        deltaPillGeometryClass(sentiment, MetricDeltaTreatment.UnifiedPill)
      ).toBe(DELTA_PILL_GEOMETRY_CLASS);
      // …and no tone carries a verdict word.
      expect(
        deltaVerdictCaption(sentiment, MetricDeltaTreatment.UnifiedPill)
      ).toBeNull();
    }
  });

  // ISS-6493: the neutral pill WITHOUT the verdict-word removal. This is the
  // treatment the new `metric-delta-neutral-pill` gate resolves to, and the
  // whole ticket is that it can ship while `metric-delta-unified-pill` stays
  // blocked on the #4823 hue-alone question.
  it("pills every tone under the neutral-pill treatment while keeping the verdict word (ISS-6493)", () => {
    for (const sentiment of Object.values(DeltaSentiment)) {
      // AC1: identical geometry on every tone — the same shared constant the
      // scored tones already spent, so no tone can acquire padding of its own.
      expect(
        deltaPillGeometryClass(sentiment, MetricDeltaTreatment.NeutralPill)
      ).toBe(DELTA_PILL_GEOMETRY_CLASS);
      // …and every tone declares a FILL, which is what makes it a pill at all.
      expect(
        deltaPillClass(sentiment, MetricDeltaTreatment.NeutralPill)
      ).toMatch(PILL_FILL_RE);
    }
    // AC1's "only colour varies": the SCORED tones must be byte-identical to
    // Legacy, so this treatment moved the neutral tone and nothing else. If it
    // had restyled improvement/regression too, this ticket would be a different
    // change than the one its title claims.
    for (const sentiment of [
      DeltaSentiment.Improvement,
      DeltaSentiment.Regression,
    ]) {
      expect(deltaPillClass(sentiment, MetricDeltaTreatment.NeutralPill)).toBe(
        deltaPillClass(sentiment, MetricDeltaTreatment.Legacy)
      );
    }
    // AC2, at the class-map layer: the neutral pill's fill is the foreground
    // wash, NEVER `KpiDeltaPlaceholder`'s flat `bg-muted`. The rendered proof
    // that the two chips stay apart on one screen is
    // `neutral-delta-pill-vs-no-comparison.test.tsx`.
    expect(
      deltaPillClass(DeltaSentiment.Neutral, MetricDeltaTreatment.NeutralPill)
    ).toContain("bg-foreground/5");
    expect(
      deltaPillClass(DeltaSentiment.Neutral, MetricDeltaTreatment.NeutralPill)
    ).not.toContain("bg-muted");
  });

  // ISS-4779 closed-by-default: the LEGACY treatment is the default, and it must
  // still be the pre-ISS-5842 behaviour — scored tones pilled, neutral bare,
  // verdict words intact. Without this the resolvers could quietly return the
  // unified treatment for every input and every assertion above would still pass.
  it("keeps the pre-ISS-5842 geometry and verdict words under the legacy treatment", () => {
    expect(
      deltaPillGeometryClass(
        DeltaSentiment.Neutral,
        MetricDeltaTreatment.Legacy
      )
    ).toBe("");
    expect(
      deltaVerdictCaption(DeltaSentiment.Neutral, MetricDeltaTreatment.Legacy)
    ).toBeNull();
    for (const sentiment of [
      DeltaSentiment.Improvement,
      DeltaSentiment.Regression,
    ]) {
      expect(
        deltaPillGeometryClass(sentiment, MetricDeltaTreatment.Legacy)
      ).toBe(DELTA_PILL_GEOMETRY_CLASS);
      expect(
        deltaVerdictCaption(sentiment, MetricDeltaTreatment.Legacy)
      ).toBeTruthy();
    }
  });
});

/**
 * ISS-6493 AC3 — `deltaVerdictCaption` is BYTE-IDENTICAL, and this is what makes
 * that claim checkable rather than asserted.
 *
 * The expected words below are INDEPENDENT LITERALS, deliberately duplicated
 * from `DELTA_SENTIMENT_CAPTION` rather than read out of it. A table derived
 * from the map it polices cannot fail when the map changes — it would simply
 * describe the new value — and "the verdict word still renders" is exactly the
 * claim the #4823 blocker rests on, so it gets an oracle it cannot be edited
 * into agreeing with. The duplication IS the test.
 *
 * The `Record` types are the other half: adding a `DeltaSentiment` or a
 * `MetricDeltaTreatment` fails `tsc` here until the new pair states its verdict,
 * so a fourth treatment cannot quietly inherit a caption nobody chose.
 */
const EXPECTED_VERDICT_CAPTION: Record<
  MetricDeltaTreatment,
  Record<DeltaSentiment, string | null>
> = {
  [MetricDeltaTreatment.Legacy]: {
    [DeltaSentiment.Improvement]: "better",
    [DeltaSentiment.Regression]: "worse",
    [DeltaSentiment.Neutral]: null,
  },
  // ISS-6493's whole point: the neutral pill arrives, the verdict word does not
  // leave. Identical to Legacy, column for column.
  [MetricDeltaTreatment.NeutralPill]: {
    [DeltaSentiment.Improvement]: "better",
    [DeltaSentiment.Regression]: "worse",
    [DeltaSentiment.Neutral]: null,
  },
  // ISS-5842, still gated on #4823: this is the ONLY column that drops the word.
  [MetricDeltaTreatment.UnifiedPill]: {
    [DeltaSentiment.Improvement]: null,
    [DeltaSentiment.Regression]: null,
    [DeltaSentiment.Neutral]: null,
  },
};

describe("deltaVerdictCaption is unchanged by the neutral pill (ISS-6493 AC3)", () => {
  for (const treatment of Object.values(MetricDeltaTreatment)) {
    for (const sentiment of Object.values(DeltaSentiment)) {
      it(`renders ${String(
        EXPECTED_VERDICT_CAPTION[treatment][sentiment]
      )} for a ${sentiment} delta under ${treatment}`, () => {
        expect(deltaVerdictCaption(sentiment, treatment)).toBe(
          EXPECTED_VERDICT_CAPTION[treatment][sentiment]
        );
      });
    }
  }
});

describe("KPI metric polarity registry", () => {
  it("marks the spend/latency/backlog metrics lower-is-better", () => {
    expect(KPI_METRIC_POLARITY[InsightsKpiKey.Cost]).toBe(
      MetricPolarity.LowerIsBetter
    );
    expect(KPI_METRIC_POLARITY[InsightsKpiKey.Ttm]).toBe(
      MetricPolarity.LowerIsBetter
    );
    expect(KPI_METRIC_POLARITY[InsightsKpiKey.Backlog]).toBe(
      MetricPolarity.LowerIsBetter
    );
    expect(KPI_METRIC_POLARITY[InsightsKpiKey.PrSize]).toBe(
      MetricPolarity.LowerIsBetter
    );
  });

  it("keeps delivery-outcome metrics higher-is-better", () => {
    // Shipped-work outcomes carry a verdict: more merged PRs and more KLOC
    // merged is a delivery win. Raw activity counts (sessions/events/tool-runs)
    // do NOT — see the neutral-activity test below.
    expect(KPI_METRIC_POLARITY[InsightsKpiKey.Merged]).toBe(
      MetricPolarity.HigherIsBetter
    );
    expect(KPI_METRIC_POLARITY[InsightsKpiKey.Kloc]).toBe(
      MetricPolarity.HigherIsBetter
    );
    expect(KPI_METRIC_POLARITY[InsightsKpiKey.MergeRate]).toBe(
      MetricPolarity.HigherIsBetter
    );
  });

  it("passes no verdict on the spend inputs, so they can't contradict the Cost tile beside them", () => {
    // Tokens ARE the substance of cost: calling a token rise "better" while the
    // Cost card calls the same movement "worse" is the contradiction ISS-4633
    // is about, one level down.
    for (const key of [
      InsightsKpiKey.Tokens,
      InsightsKpiKey.InputTokens,
      InsightsKpiKey.OutputTokens,
      InsightsKpiKey.Runtime,
      InsightsKpiKey.Models,
    ]) {
      expect(KPI_METRIC_POLARITY[key]).toBe(MetricPolarity.Neutral);
    }
    // A growing cache saving genuinely is a win, so it keeps a verdict.
    expect(KPI_METRIC_POLARITY[InsightsKpiKey.CacheTokens]).toBe(
      MetricPolarity.HigherIsBetter
    );
  });

  it("passes no verdict on raw activity counts (review on #4148)", () => {
    // Sessions, events, and tool runs measure how much the product was used, not
    // a delivery outcome. A quiet week's decline is not a moral "worse" — we do
    // not know a team running fewer sessions is bad — so they read Neutral and
    // report the movement without a verdict word.
    for (const key of [
      InsightsKpiKey.Sessions,
      InsightsKpiKey.Events,
      InsightsKpiKey.ToolRuns,
    ]) {
      expect(KPI_METRIC_POLARITY[key]).toBe(MetricPolarity.Neutral);
    }
  });

  it("gives every KPI tile the polarity its key declares", () => {
    const kpiTiles = INSIGHTS_TILES.filter(isKpiTile);
    expect(kpiTiles.length).toBeGreaterThan(0);
    for (const tile of kpiTiles) {
      expect(tile.polarity).toBe(KPI_METRIC_POLARITY[tile.metricKey]);
    }
  });

  it("covers every KPI tile key in the registry", () => {
    const registryKeys = new Set<string>(Object.keys(KPI_METRIC_POLARITY));
    for (const tile of INSIGHTS_TILES.filter(isKpiTile)) {
      expect(registryKeys.has(tile.metricKey)).toBe(true);
    }
  });
});

// ISS-11188: literal tokens on purpose. An expected value read back from the
// map under test agrees with the map's own mistake.
const EXPECTED_PILL_TONE: Record<DeltaSentiment, string> = {
  [DeltaSentiment.Improvement]: "text-success",
  [DeltaSentiment.Regression]: "text-destructive",
  [DeltaSentiment.Neutral]: "text-muted-foreground",
};

const EXPECTED_TEXT_TONE: Record<DeltaSentiment, string> = {
  [DeltaSentiment.Improvement]: "text-success",
  [DeltaSentiment.Regression]: "text-destructive",
  [DeltaSentiment.Neutral]: "text-muted-foreground",
};

// Every `text-*` utility in the class, so a competing foreground tone fails the
// exact-match assertion instead of riding along beside the expected one.
function textTokens(className: string): string[] {
  return className.split(" ").filter((token) => TEXT_UTILITY_RE.test(token));
}
