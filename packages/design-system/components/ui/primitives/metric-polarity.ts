/**
 * Per-metric delta polarity (ISS-4633).
 *
 * A period-over-period delta has a direction (the number went up or down) and a
 * SENTIMENT (that movement is good, bad, or neither). The two are not the same:
 * a rising throughput count is an improvement, a rising spend is a regression,
 * and a rising token count is just a bigger number. Rendering every positive
 * delta with the same green/up affordance tells the reader a growing bill is
 * "improving", so each metric declares which direction — if any — is good, and
 * the delta chip derives its sentiment from that.
 *
 * Kept in its own lightweight module (no React, no component runtime) so metric
 * catalogs and pure formatters can import the polarity contract without pulling
 * in the `"use client"` MetricCard. The class maps live here too, so the pill
 * chip (`MetricCard`) and the bare chip (Insights `TrendBadge`) cannot drift on
 * what "worse" looks like.
 */

export const MetricPolarity = {
  /** Up is good — throughput, merged PRs, sessions, cache savings. */
  HigherIsBetter: "higher-is-better",
  /** Down is good — spend, time-to-merge, review backlog. */
  LowerIsBetter: "lower-is-better",
  /**
   * Neither direction is a verdict. For metrics where a rise is not a win or a
   * loss on its own — raw token volume (the substance of spend, so calling its
   * rise "good" would contradict the Cost card beside it), agent runtime, or a
   * model count that reads as sprawl or as healthy experimentation depending on
   * the reader. These render the movement without claiming it is good or bad.
   */
  Neutral: "neutral",
} as const;
export type MetricPolarity =
  (typeof MetricPolarity)[keyof typeof MetricPolarity];

export const DeltaSentiment = {
  Improvement: "improvement",
  Regression: "regression",
  /** No verdict: a flat 0%, or a metric with no good direction. */
  Neutral: "neutral",
} as const;
export type DeltaSentiment =
  (typeof DeltaSentiment)[keyof typeof DeltaSentiment];

/**
 * Which delta treatment a consumer has opted into (ISS-5842, gated per the
 * ISS-4779 closed-by-default UI policy).
 *
 * `MetricCard` and the Insights `TrendBadge` are SHARED primitives: the same
 * components render the Sessions strip, the Branches strip, the Insights
 * dashboard and the desktop first-launch dashboard. Changing their delta
 * presentation unconditionally would land the new look on every one of those
 * surfaces at once, on web AND desktop — which is exactly what the reviews on
 * #4823 (whitlockk, codex) rejected: the Sessions cost flag of the day gated Sessions
 * COST SEMANTICS and never reached Insights or Branches, so it could not stand
 * in as the gate for a shared presentation change. (That flag was
 * `sessions-cost-billing-honesty`, retired by ISS-8791; the reasoning is about
 * flag SCOPE and does not depend on which flag it was.)
 *
 * So the primitive stays dumb and the CONSUMER decides. Each `packages/app`
 * surface resolves `useMetricDeltaTreatment()` — which reads TWO gates, each a
 * PostHog flag on the web app and a byte-equal Labs toggle on the packaged
 * desktop renderer, default OFF on both: `metric-delta-neutral-pill` yields
 * {@link MetricDeltaTreatment.NeutralPill} and `metric-delta-unified-pill`
 * yields {@link MetricDeltaTreatment.UnifiedPill}, which wins when both are on
 * because it is a strict superset. A consumer that passes nothing — including
 * every `apps/prototypes` sandbox page — keeps
 * {@link MetricDeltaTreatment.Legacy}, so the default render is byte-for-byte
 * what shipped before ISS-5842.
 */
export const MetricDeltaTreatment = {
  /**
   * The pre-ISS-5842 shipped render, and the default. Scored tones (improvement
   * / regression) get the filled tinted pill; a NEUTRAL tone renders bare so it
   * cannot be mistaken for the muted "No comparison" placeholder pill; and the
   * caption leads with the visible verdict word ("better" / "worse").
   */
  Legacy: "legacy",
  /**
   * ISS-6493. One pill geometry for every tone, and the verdict word KEPT.
   *
   * ISS-5842 built the neutral pill and the verdict-word removal as one
   * treatment, so the neutral pill inherited a blocker that is not about it: the
   * #4823 question is whether hue alone may carry the good/bad reading once
   * "better"/"worse" is gone (see {@link deltaVerdictCaption}). A neutral delta
   * makes no good/bad claim, so it has no hue-alone problem and does not need
   * that answer. This treatment is the neutral pill on its own — the caption
   * still leads with the verdict word, exactly as under {@link Legacy}.
   */
  NeutralPill: "neutral-pill",
  /**
   * ISS-5842. One pill geometry for every tone — same shape, same padding, same
   * type, only the COLOUR varies — and no verdict word in the caption. A strict
   * superset of {@link NeutralPill}, which is why it wins when both gates are on.
   */
  UnifiedPill: "unified-pill",
} as const;
export type MetricDeltaTreatment =
  (typeof MetricDeltaTreatment)[keyof typeof MetricDeltaTreatment];

/**
 * The VISIBLE one-word verdict rendered beside the delta chip under
 * {@link MetricDeltaTreatment.Legacy}. Colour alone must not carry the good/bad
 * reading (WCAG 2.2 SC 1.4.1) — and `--success` and `--destructive` sit at
 * nearly the same lightness, so desaturating the chip leaves the two states
 * indistinguishable. A neutral sentiment has no word: it makes no claim.
 *
 * ISS-5842 removes this word, but only for consumers that have opted into
 * {@link MetricDeltaTreatment.UnifiedPill} — read
 * {@link deltaVerdictCaption} for the trade that removal makes, and why the map
 * survives rather than being deleted.
 */
export const DELTA_SENTIMENT_CAPTION: Record<DeltaSentiment, string | null> = {
  [DeltaSentiment.Improvement]: "better",
  [DeltaSentiment.Regression]: "worse",
  [DeltaSentiment.Neutral]: null,
};

/**
 * Pill-chip colouring under {@link MetricDeltaTreatment.Legacy} (the default).
 * A SCORED sentiment gets a filled tinted pill — the affordance that says
 * "we're grading this movement". A neutral movement is deliberately NOT a
 * filled muted pill: that chrome is identical to the `KpiDeltaPlaceholder` "No
 * comparison" chip, so a real neutral delta (which HAS a number) would read as
 * "didn't load" (review on #4148).
 */
export const DELTA_SENTIMENT_PILL_CLASS: Record<DeltaSentiment, string> = {
  [DeltaSentiment.Improvement]: "bg-success/10 text-success",
  [DeltaSentiment.Regression]: "bg-destructive/10 text-destructive",
  [DeltaSentiment.Neutral]: "text-muted-foreground",
};

/**
 * ISS-5842 pill-chip colouring, spent by every treatment that pills each tone —
 * {@link MetricDeltaTreatment.NeutralPill} and
 * {@link MetricDeltaTreatment.UnifiedPill}. Both reach for this ONE map rather
 * than a copy apiece: they differ on the verdict word, never on the colours.
 *
 * All three sentiments carry the SAME geometry — rounded pill, same padding,
 * same type — and only the COLOUR varies. Product (Marisol, 2026-08-10): "neutral
 * pills should still be pill on trendiness … neutral should still have a pill
 * like red or green." The delta chip is one component in three tonal states; it
 * previously rendered as three different-looking things in one row, which is a
 * component boundary the reader has to re-learn per card.
 *
 * The original neutral-is-bare concern is answered rather than discarded — but
 * by TEXT, not by fill, and the difference matters to anyone citing this later.
 * `bg-foreground/5` and `KpiDeltaPlaceholder`'s `bg-muted` are different tokens
 * that composite to the same pixel over `bg-card` (measured: 0.1/255 apart in
 * light, 1.4/255 in dark), so the neutral pill and the "No comparison" chip
 * deliberately read at the SAME visual weight. What tells them apart is what
 * each one says: a real movement ("0%", "-52%") against the literal words "No
 * comparison". That is the strong channel and the one the #4148 review actually
 * needed; the distinct token only keeps the two from drifting onto one literal.
 */
export const DELTA_SENTIMENT_UNIFIED_PILL_CLASS: Record<
  DeltaSentiment,
  string
> = {
  [DeltaSentiment.Improvement]: "bg-success/10 text-success",
  [DeltaSentiment.Regression]: "bg-destructive/10 text-destructive",
  [DeltaSentiment.Neutral]: "bg-foreground/5 text-muted-foreground",
};

/**
 * The pill's shape, as ONE constant both treatments spend. ISS-5842's whole
 * geometry claim is "every tone gets exactly this, and nothing else varies by
 * tone", so the string lives here rather than being spelled per branch where a
 * tone could quietly acquire its own padding.
 */
export const DELTA_PILL_GEOMETRY_CLASS = "rounded-full px-2 py-0.5";

/**
 * Whether a delta value is a real, comparable number. The public `MetricCard` /
 * `KpiMetricTile` boundary types `delta` as `number`, but a caller without its
 * own finite guard can pass `NaN` or `±Infinity` (e.g. a `x/0` percent-change
 * with no prior base). `NaN > 0` is false, so a raw non-finite value would slip
 * through `deltaSentiment` as a false "down" and render a bogus chip — on a
 * lower-is-better card, a down-arrow + "NaN%" + a green "better" (davetho
 * review on #4148). A non-finite delta is really "no comparison", so the render
 * boundary must reject it here and fall to the no-comparison placeholder instead
 * of grading a number that does not exist.
 */
export function isComparableDelta(delta: number): boolean {
  return Number.isFinite(delta);
}

/** Bare-text chip colouring (Insights `TrendBadge`). */
export const DELTA_SENTIMENT_TEXT_CLASS: Record<DeltaSentiment, string> = {
  [DeltaSentiment.Improvement]: "text-success",
  [DeltaSentiment.Regression]: "text-destructive",
  [DeltaSentiment.Neutral]: "text-muted-foreground",
};

/**
 * Whether a delta reads as an improvement, a regression, or neither for a metric
 * with the given polarity. A flat `0%` is always neutral — nothing changed is
 * not an improvement — and a neutral-polarity metric is neutral at any size.
 */
export function deltaSentiment(
  deltaPct: number,
  polarity: MetricPolarity
): DeltaSentiment {
  if (deltaPct === 0) {
    return DeltaSentiment.Neutral;
  }
  const rising = deltaPct > 0;
  switch (polarity) {
    case MetricPolarity.HigherIsBetter:
      return rising ? DeltaSentiment.Improvement : DeltaSentiment.Regression;
    case MetricPolarity.LowerIsBetter:
      return rising ? DeltaSentiment.Regression : DeltaSentiment.Improvement;
    case MetricPolarity.Neutral:
      return DeltaSentiment.Neutral;
    default:
      // Exhaustive: a newly added polarity must be mapped here, not silently
      // treated as higher-is-better.
      return assertUnreachablePolarity(polarity);
  }
}

function assertUnreachablePolarity(polarity: never): never {
  throw new Error(`Unhandled metric polarity: ${String(polarity)}`);
}

/**
 * Whether a sentiment gets the filled rounded pill chrome under
 * {@link MetricDeltaTreatment.Legacy}. Only scored movements do; a neutral delta
 * renders bare so it is distinct from the muted "No comparison" placeholder pill
 * (review on #4148). Under every other treatment each tone is a pill and this
 * predicate does not apply — see {@link TREATMENT_PILLS_EVERY_TONE}.
 */
export function isScoredSentiment(sentiment: DeltaSentiment): boolean {
  return sentiment !== DeltaSentiment.Neutral;
}

/**
 * Whether a treatment pills EVERY tone, or only the scored ones. The pill and
 * the verdict word were one decision under ISS-5842 and are two under ISS-6493,
 * so the geometry/colour question is asked here and the caption question is
 * asked separately by {@link deltaVerdictCaption} — a treatment can answer them
 * differently, which is the whole point of
 * {@link MetricDeltaTreatment.NeutralPill}.
 *
 * A `Record` rather than the obvious `treatment !== Legacy` predicate. Written
 * by exclusion, a fourth treatment added tomorrow would silently opt IN to
 * pilling every tone without anyone choosing that — and this axis is exactly the
 * one a new treatment would exist to decide. Spelled out, `tsc` fails here until
 * it states an answer.
 */
const TREATMENT_PILLS_EVERY_TONE: Record<MetricDeltaTreatment, boolean> = {
  [MetricDeltaTreatment.Legacy]: false,
  [MetricDeltaTreatment.NeutralPill]: true,
  [MetricDeltaTreatment.UnifiedPill]: true,
};

/** The chip's colour classes for a sentiment under the consumer's treatment. */
export function deltaPillClass(
  sentiment: DeltaSentiment,
  treatment: MetricDeltaTreatment
): string {
  if (TREATMENT_PILLS_EVERY_TONE[treatment]) {
    return DELTA_SENTIMENT_UNIFIED_PILL_CLASS[sentiment];
  }
  return DELTA_SENTIMENT_PILL_CLASS[sentiment];
}

/**
 * The chip's GEOMETRY classes for a sentiment under the consumer's treatment —
 * the whole of ISS-5842's shape change, isolated so "geometry is identical
 * across tones" is one testable expression rather than a conditional spread
 * through the component.
 */
export function deltaPillGeometryClass(
  sentiment: DeltaSentiment,
  treatment: MetricDeltaTreatment
): string {
  if (TREATMENT_PILLS_EVERY_TONE[treatment]) {
    return DELTA_PILL_GEOMETRY_CLASS;
  }
  return isScoredSentiment(sentiment) ? DELTA_PILL_GEOMETRY_CLASS : "";
}

/**
 * The verdict word to render beside the chip, or `null` for none.
 *
 * Under {@link MetricDeltaTreatment.UnifiedPill} this is ALWAYS `null`. Product
 * (Marisol, 2026-08-10): "remove 'better' or 'worse' from positive / negative trend
 * line" — the card was asserting a value judgement it cannot always justify, on
 * every metric, on every render.
 *
 * ## The trade that removal makes, stated rather than buried
 *
 * That word carried the good/bad reading as VISIBLE text so hue was not the sole
 * channel (WCAG 2.2 SC 1.4.1), which matters because `--success` and
 * `--destructive` sit at nearly the same lightness. What survives without it is
 * the DIRECTION channel, which is not colour: the chip's leading glyph is a
 * distinct SHAPE per state (up arrow / down arrow / minus). What is lost is the
 * good/bad overlay on top of that direction, so a `+38%` higher-is-better and a
 * `+38%` lower-is-better become distinguishable by hue alone (whitlockk, codex on
 * #4823) — and the sparkline variant, which replaces the glyph, loses even the
 * direction shape.
 *
 * That gap is REAL and is not closed here, which is precisely why
 * `MetricDeltaTreatment.UnifiedPill` ships behind a default-off flag: the three
 * available resolutions each contradict one of the three standing product
 * constraints (drop the sentiment colour / vary geometry by tone / re-add
 * sr-only verdict text), so it needs a product + design decision, not a
 * unilateral code choice. **Do not graduate the `metric-delta-unified-pill` flag
 * until that decision is recorded.**
 *
 * ISS-6493 narrowed WHAT that blocker holds back, and nothing else. The neutral
 * pill used to ride this same flag and is now
 * {@link MetricDeltaTreatment.NeutralPill}'s own gate, because a neutral delta
 * asserts no good/bad reading and so cannot be the thing hue is left carrying.
 * The verdict word, the trade above and the instruction are untouched.
 */
export function deltaVerdictCaption(
  sentiment: DeltaSentiment,
  treatment: MetricDeltaTreatment
): string | null {
  if (treatment === MetricDeltaTreatment.UnifiedPill) {
    return null;
  }
  return DELTA_SENTIMENT_CAPTION[sentiment];
}
