// Categorical palette tokens defined in globals.css (--chart-1..10). Imported
// directly from source by consuming surfaces so they can reuse the shared chart
// palette instead of redefining it.
export const CHART_COLOR_TOKENS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
  "var(--chart-9)",
  "var(--chart-10)",
] as const;

export type ChartColorPair = {
  /** Representative/base token for surfaces that can show only one color. */
  base: string;
  /** Softer companion color for lower-emphasis marks. */
  soft: string;
  /** Stronger companion color for higher-emphasis marks. */
  strong: string;
};

/**
 * Pair order for paired categorical charts. The first pair starts with
 * `--chart-2`, and the final chart token is intentionally left available for
 * callers that need a reserved fallback state.
 */
export const CHART_COLOR_PAIR_TOKEN_INDEXES = [
  1, 0, 2, 3, 4, 5, 6, 7, 8,
] as const;

export function chartColor(index: number): string {
  const count = CHART_COLOR_TOKENS.length;
  if (!Number.isFinite(index)) {
    return CHART_COLOR_TOKENS[0];
  }
  // True modulo so negative/non-integer indexes still land in 0..count-1
  // (`%` alone yields a negative remainder → an out-of-bounds `undefined`).
  const slot = ((Math.trunc(index) % count) + count) % count;
  return CHART_COLOR_TOKENS[slot] ?? CHART_COLOR_TOKENS[0];
}

export function chartColorPair(index: number): ChartColorPair {
  const count = CHART_COLOR_PAIR_TOKEN_INDEXES.length;
  if (!Number.isFinite(index)) {
    return chartColorPairForTokenIndex(CHART_COLOR_PAIR_TOKEN_INDEXES[0] ?? 0);
  }
  const slot = ((Math.trunc(index) % count) + count) % count;
  return chartColorPairForTokenIndex(CHART_COLOR_PAIR_TOKEN_INDEXES[slot] ?? 0);
}

export function chartColorPairForTokenIndex(index: number): ChartColorPair {
  const base = chartColor(index);
  return {
    base,
    soft: `color-mix(in oklch, ${base} 62%, var(--background))`,
    strong: `color-mix(in oklch, ${base} 84%, var(--foreground))`,
  };
}

/**
 * Assignment order for categorical SERIES in a stacked or line chart, expressed
 * as indexes into {@link CHART_COLOR_TOKENS} (ISS-5523).
 *
 * The natural order (`--chart-1` … `--chart-10`) seats colour-vision-confusable
 * hues next to each other, so consecutive series were not reliably tellable
 * apart, and it opens on `--chart-4`, the one token that is all but invisible on
 * the light surface. This order is a search over the same ten tokens against
 * three constraints — adjacent CVD separation, adjacent normal-vision
 * separation, and the contrast of the FIRST slot (the bottom, usually largest,
 * band). Measured with the data-viz palette validator on the tokens' own OKLCH
 * values against the light and dark chart surfaces, worst ADJACENT pair over all
 * ten slots:
 *
 *   natural order — CVD ΔE 5.4 (dark) · normal-vision ΔE 11.1 · slot-1 1.31:1  FAIL
 *   this order    — CVD ΔE 18.0 (dark) · normal-vision ΔE 18.4 · slot-1 3.89:1  PASS
 *
 * (Targets: CVD ΔE ≥ 8, normal-vision ΔE ≥ 15, OKLab ×100; contrast ≥ 3:1.)
 *
 * This is a PERMUTATION, not a retune: every token value is untouched, so the
 * palette itself is unchanged and only the seat each series takes moves. That
 * keeps the fix inside the charts that opt in, rather than repainting every
 * chart in the repo.
 *
 * **What this does NOT buy, stated plainly.** These are ADJACENT-pair numbers.
 * A reader resolving a legend swatch against a band anywhere in the stack is
 * doing an ALL-PAIRS comparison, and over all 45 pairs the palette does not
 * clear the thresholds at any useful count — measured on the composited
 * `fillOpacity` the bands actually render at, colour alone separates about one
 * series. Colour is therefore NOT sufficient on its own here; the cap below
 * stops two bands sharing a fill, which is the defect this ticket names, but a
 * second encoding (texture, per `donut-slice-textures.tsx`) is what makes ten
 * bands genuinely resolvable, and is filed as the follow-up.
 */
export const CHART_SERIES_TOKEN_INDEXES = [5, 7, 2, 0, 4, 6, 9, 1, 3, 8] as const;

/**
 * How many series this palette can draw without ever REUSING a colour. This is
 * a statement about the palette's size, not a claim that ten bands read well —
 * see the all-pairs caveat above. A chart handed more than this must fold the
 * remainder into an aggregate band (see `chart-series-fold.ts`) rather than wrap.
 */
export const CHART_SERIES_COLOR_LIMIT = CHART_SERIES_TOKEN_INDEXES.length;

/**
 * Colour for the aggregate "Other" band. Deliberately a NEUTRAL, not the next
 * categorical hue: the band is not an entity, and giving it a hue of its own
 * would both spend a slot a real series could use and invite a reader to treat
 * it as one more model.
 *
 * Mixed back toward the surface rather than used at full strength. Raw
 * `--muted-foreground` measures 6.73:1 against `--card` while the ten real
 * series sit between 1.31:1 and 5.20:1, so the one band that means "these could
 * not be told apart individually" would out-shout every series that does have an
 * identity. At 70% it measures 3.49:1 light / 4.36:1 dark — clear of the 3:1
 * non-text floor in both themes, without dominating the stack.
 *
 * `@repo/app`'s `spend-outcome-palette.ts` independently reached the same
 * `--muted-foreground` for its residual "Unknown" bucket. That is agreement, not
 * drift — keep the two in step rather than "fixing" one.
 */
export const CHART_OTHER_SERIES_COLOR =
  "color-mix(in oklch, var(--muted-foreground) 70%, var(--card))";

/**
 * Palette colour for the series at `index`, using the distinguishable-adjacent
 * order above.
 *
 * Unlike {@link chartColor} this NEVER wraps. Past the last slot it returns the
 * neutral overflow colour, because silently restarting the sequence is what made
 * two unrelated series render identically in the first place. Callers MUST cap
 * at {@link CHART_SERIES_COLOR_LIMIT} — `TimeSeriesAreaChart` clamps for them —
 * so the overflow branch is a floor under a caller that does not, never a state
 * a product surface should reach: past the limit a real series and the aggregate
 * band would share the neutral.
 */
export function chartSeriesColor(index: number): string {
  if (!Number.isFinite(index)) {
    return CHART_OTHER_SERIES_COLOR;
  }
  const slot = Math.trunc(index);
  if (slot < 0 || slot >= CHART_SERIES_TOKEN_INDEXES.length) {
    return CHART_OTHER_SERIES_COLOR;
  }
  return chartColor(CHART_SERIES_TOKEN_INDEXES[slot]);
}
