import {
  DELTA_PILL_GEOMETRY_CLASS,
  DELTA_SENTIMENT_CAPTION,
  DELTA_SENTIMENT_PILL_CLASS,
  DELTA_SENTIMENT_TEXT_CLASS,
  DELTA_SENTIMENT_UNIFIED_PILL_CLASS,
  DeltaSentiment,
  deltaPillClass,
  deltaPillGeometryClass,
  deltaSentiment,
  deltaVerdictCaption,
  isComparableDelta,
  isScoredSentiment,
  MetricDeltaTreatment,
  MetricPolarity,
} from "@closedloop-ai/design-system/components/ui/primitives/metric-polarity";
import { describe, expect, it } from "vitest";

describe("MetricPolarity — const enums", () => {
  it("exposes the three polarity values", () => {
    expect(MetricPolarity.HigherIsBetter).toBe("higher-is-better");
    expect(MetricPolarity.LowerIsBetter).toBe("lower-is-better");
    expect(MetricPolarity.Neutral).toBe("neutral");
  });

  it("exposes the three sentiment values", () => {
    expect(DeltaSentiment.Improvement).toBe("improvement");
    expect(DeltaSentiment.Regression).toBe("regression");
    expect(DeltaSentiment.Neutral).toBe("neutral");
  });

  it("exposes the three treatment values", () => {
    expect(MetricDeltaTreatment.Legacy).toBe("legacy");
    expect(MetricDeltaTreatment.NeutralPill).toBe("neutral-pill");
    expect(MetricDeltaTreatment.UnifiedPill).toBe("unified-pill");
  });
});

describe("isComparableDelta", () => {
  it("accepts finite numbers", () => {
    expect(isComparableDelta(0)).toBe(true);
    expect(isComparableDelta(42)).toBe(true);
    expect(isComparableDelta(-99.5)).toBe(true);
  });

  it("rejects NaN", () => {
    expect(isComparableDelta(Number.NaN)).toBe(false);
  });

  it("rejects Infinity", () => {
    expect(isComparableDelta(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isComparableDelta(Number.NEGATIVE_INFINITY)).toBe(false);
  });
});

describe("deltaSentiment", () => {
  it("returns neutral for zero delta regardless of polarity", () => {
    expect(deltaSentiment(0, MetricPolarity.HigherIsBetter)).toBe(
      DeltaSentiment.Neutral
    );
    expect(deltaSentiment(0, MetricPolarity.LowerIsBetter)).toBe(
      DeltaSentiment.Neutral
    );
    expect(deltaSentiment(0, MetricPolarity.Neutral)).toBe(
      DeltaSentiment.Neutral
    );
  });

  it("rising higher-is-better is improvement", () => {
    expect(deltaSentiment(10, MetricPolarity.HigherIsBetter)).toBe(
      DeltaSentiment.Improvement
    );
  });

  it("falling higher-is-better is regression", () => {
    expect(deltaSentiment(-10, MetricPolarity.HigherIsBetter)).toBe(
      DeltaSentiment.Regression
    );
  });

  it("rising lower-is-better is regression", () => {
    expect(deltaSentiment(10, MetricPolarity.LowerIsBetter)).toBe(
      DeltaSentiment.Regression
    );
  });

  it("falling lower-is-better is improvement", () => {
    expect(deltaSentiment(-10, MetricPolarity.LowerIsBetter)).toBe(
      DeltaSentiment.Improvement
    );
  });

  it("neutral polarity always returns neutral regardless of direction", () => {
    expect(deltaSentiment(50, MetricPolarity.Neutral)).toBe(
      DeltaSentiment.Neutral
    );
    expect(deltaSentiment(-50, MetricPolarity.Neutral)).toBe(
      DeltaSentiment.Neutral
    );
  });
});

describe("isScoredSentiment", () => {
  it("returns true for improvement", () => {
    expect(isScoredSentiment(DeltaSentiment.Improvement)).toBe(true);
  });

  it("returns true for regression", () => {
    expect(isScoredSentiment(DeltaSentiment.Regression)).toBe(true);
  });

  it("returns false for neutral", () => {
    expect(isScoredSentiment(DeltaSentiment.Neutral)).toBe(false);
  });
});

describe("deltaPillClass", () => {
  it("returns legacy pill classes under Legacy treatment", () => {
    expect(
      deltaPillClass(DeltaSentiment.Improvement, MetricDeltaTreatment.Legacy)
    ).toBe(DELTA_SENTIMENT_PILL_CLASS[DeltaSentiment.Improvement]);
    expect(
      deltaPillClass(DeltaSentiment.Regression, MetricDeltaTreatment.Legacy)
    ).toBe(DELTA_SENTIMENT_PILL_CLASS[DeltaSentiment.Regression]);
    expect(
      deltaPillClass(DeltaSentiment.Neutral, MetricDeltaTreatment.Legacy)
    ).toBe(DELTA_SENTIMENT_PILL_CLASS[DeltaSentiment.Neutral]);
  });

  it("returns unified pill classes under NeutralPill treatment", () => {
    expect(
      deltaPillClass(DeltaSentiment.Neutral, MetricDeltaTreatment.NeutralPill)
    ).toBe(DELTA_SENTIMENT_UNIFIED_PILL_CLASS[DeltaSentiment.Neutral]);
    expect(
      deltaPillClass(
        DeltaSentiment.Improvement,
        MetricDeltaTreatment.NeutralPill
      )
    ).toBe(DELTA_SENTIMENT_UNIFIED_PILL_CLASS[DeltaSentiment.Improvement]);
  });

  it("returns unified pill classes under UnifiedPill treatment", () => {
    expect(
      deltaPillClass(
        DeltaSentiment.Regression,
        MetricDeltaTreatment.UnifiedPill
      )
    ).toBe(DELTA_SENTIMENT_UNIFIED_PILL_CLASS[DeltaSentiment.Regression]);
  });
});

describe("deltaPillGeometryClass", () => {
  it("returns geometry for scored sentiments under Legacy", () => {
    expect(
      deltaPillGeometryClass(
        DeltaSentiment.Improvement,
        MetricDeltaTreatment.Legacy
      )
    ).toBe(DELTA_PILL_GEOMETRY_CLASS);
    expect(
      deltaPillGeometryClass(
        DeltaSentiment.Regression,
        MetricDeltaTreatment.Legacy
      )
    ).toBe(DELTA_PILL_GEOMETRY_CLASS);
  });

  it("returns empty string for neutral under Legacy", () => {
    expect(
      deltaPillGeometryClass(
        DeltaSentiment.Neutral,
        MetricDeltaTreatment.Legacy
      )
    ).toBe("");
  });

  it("returns geometry for ALL sentiments under NeutralPill", () => {
    expect(
      deltaPillGeometryClass(
        DeltaSentiment.Neutral,
        MetricDeltaTreatment.NeutralPill
      )
    ).toBe(DELTA_PILL_GEOMETRY_CLASS);
    expect(
      deltaPillGeometryClass(
        DeltaSentiment.Improvement,
        MetricDeltaTreatment.NeutralPill
      )
    ).toBe(DELTA_PILL_GEOMETRY_CLASS);
  });

  it("returns geometry for ALL sentiments under UnifiedPill", () => {
    expect(
      deltaPillGeometryClass(
        DeltaSentiment.Neutral,
        MetricDeltaTreatment.UnifiedPill
      )
    ).toBe(DELTA_PILL_GEOMETRY_CLASS);
  });
});

describe("deltaVerdictCaption", () => {
  it("returns caption map values under Legacy", () => {
    expect(
      deltaVerdictCaption(
        DeltaSentiment.Improvement,
        MetricDeltaTreatment.Legacy
      )
    ).toBe(DELTA_SENTIMENT_CAPTION[DeltaSentiment.Improvement]);
    expect(
      deltaVerdictCaption(
        DeltaSentiment.Regression,
        MetricDeltaTreatment.Legacy
      )
    ).toBe(DELTA_SENTIMENT_CAPTION[DeltaSentiment.Regression]);
    expect(
      deltaVerdictCaption(DeltaSentiment.Neutral, MetricDeltaTreatment.Legacy)
    ).toBeNull();
  });

  it("returns caption map values under NeutralPill", () => {
    expect(
      deltaVerdictCaption(
        DeltaSentiment.Improvement,
        MetricDeltaTreatment.NeutralPill
      )
    ).toBe("better");
    expect(
      deltaVerdictCaption(
        DeltaSentiment.Regression,
        MetricDeltaTreatment.NeutralPill
      )
    ).toBe("worse");
  });

  it("returns null for ALL sentiments under UnifiedPill", () => {
    expect(
      deltaVerdictCaption(
        DeltaSentiment.Improvement,
        MetricDeltaTreatment.UnifiedPill
      )
    ).toBeNull();
    expect(
      deltaVerdictCaption(
        DeltaSentiment.Regression,
        MetricDeltaTreatment.UnifiedPill
      )
    ).toBeNull();
    expect(
      deltaVerdictCaption(
        DeltaSentiment.Neutral,
        MetricDeltaTreatment.UnifiedPill
      )
    ).toBeNull();
  });
});

describe("DELTA_SENTIMENT_TEXT_CLASS — exhaustive record", () => {
  it("has an entry for every sentiment", () => {
    expect(
      DELTA_SENTIMENT_TEXT_CLASS[DeltaSentiment.Improvement]
    ).toBeDefined();
    expect(DELTA_SENTIMENT_TEXT_CLASS[DeltaSentiment.Regression]).toBeDefined();
    expect(DELTA_SENTIMENT_TEXT_CLASS[DeltaSentiment.Neutral]).toBeDefined();
  });
});

describe("DELTA_PILL_GEOMETRY_CLASS — const pin", () => {
  it("is a non-empty class string", () => {
    expect(DELTA_PILL_GEOMETRY_CLASS).toContain("rounded-full");
  });
});
