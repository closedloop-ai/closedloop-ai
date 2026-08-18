/**
 * Generic top-N folding for categorical time-series charts (ISS-5523).
 *
 * A categorical palette holds a finite number of mutually distinguishable
 * colors. Handing a chart more series than that forces it to reuse a hue, and a
 * reused hue makes the legend physically unable to resolve which mark is which —
 * the chart still draws, but it can no longer answer the question it exists to
 * answer.
 *
 * This module keeps the highest-magnitude series and folds the remainder into a
 * single aggregate band, so every drawn series can hold its own color. It is
 * deliberately domain-agnostic: it knows only keys, labels, and numbers, and
 * takes the aggregate band's noun from the caller. The chart cannot know that a
 * series is a "model" — that word belongs to the surface that owns the data.
 */

/**
 * Series key of the synthetic aggregate band. Namespaced so a caller's own key
 * (a model id, a provider name, a bucket label) will not collide with it — and
 * {@link resolveAggregateKey} makes that a guarantee rather than a hope, because
 * a collision would silently overwrite a real series' values with the aggregate
 * sum and hand two bands one identity.
 */
export const CHART_OTHER_SERIES_KEY = "__chartOtherSeries";

/** Default noun for the aggregate band when a caller supplies none. */
export const CHART_OTHER_SERIES_LABEL = "Other";

/**
 * One categorical series. The canonical shape for both this module and the
 * chart that consumes it — `TimeSeriesAreaChart` aliases these rather than
 * re-declaring them, so the fold's return union stays assignable to the chart's
 * props by construction instead of by structural coincidence.
 */
export type FoldableSeriesDef = {
  key: string;
  label: string;
};

/** One time bucket. `date` is YYYY-MM-DD; a missing series key is treated as 0
 * and an explicit `null` renders as a gap. */
export type FoldablePointDatum = {
  date: string;
  values: Record<string, number | null>;
};

export type FoldedTimeSeries<
  TSeries extends FoldableSeriesDef,
  TPoint extends FoldablePointDatum,
> = {
  /** Series to draw, in the caller's original order, aggregate band last. */
  series: (TSeries | FoldableSeriesDef)[];
  /** Points carrying an extra summed value under {@link CHART_OTHER_SERIES_KEY}. */
  points: (TPoint | FoldablePointDatum)[];
  /**
   * How many source series the aggregate band holds. `0` means nothing was
   * folded and `series`/`points` are the untouched inputs — callers can use this
   * to assert they are looking at the whole population.
   */
  foldedCount: number;
  /**
   * The key the aggregate band was emitted under, or `undefined` when nothing
   * folded. Usually {@link CHART_OTHER_SERIES_KEY}, but the fold picks a free
   * variant if a caller already owns that key, so consumers must identify the
   * band by THIS value rather than by comparing against the constant.
   */
  aggregateKey: string | undefined;
};

/**
 * Builds the aggregate band's visible label so it can never be mistaken for a
 * real entity: it always carries the count of what it hides, and it is the only
 * band whose name is parenthesised. "Other models (7)" tells a reader both that
 * this is an aggregate and exactly how much of the population it stands for,
 * which a bare "Other" does not.
 */
export function chartOtherSeriesLabel(
  foldedCount: number,
  noun: string = CHART_OTHER_SERIES_LABEL
): string {
  return `${noun} (${foldedCount})`;
}

/**
 * Keeps at most `maxSeries` series and folds the rest into one aggregate band.
 *
 * Selection is by total magnitude across every bucket, using absolute values so
 * a series that swings negative cannot cancel itself down the ranking and be
 * dropped as if it carried no data. Ties break on the caller's original order,
 * so the same dataset always folds the same way.
 *
 * The kept series are emitted in the caller's ORIGINAL order rather than in
 * ranked order. Palette assignment is positional, so re-sorting by magnitude
 * would repaint every surviving series whenever the ranking shifted — color must
 * track the entity, not its current rank.
 *
 * Returns the inputs unchanged in content (and `foldedCount: 0`) when `maxSeries`
 * is not a usable positive cap, or the population already fits within it. The
 * arrays themselves are shallow-copied so the return type is uniform; no
 * per-bucket object is rebuilt on that path.
 */
export function foldTimeSeriesToMaxSeries<
  TSeries extends FoldableSeriesDef,
  TPoint extends FoldablePointDatum,
>({
  series,
  points,
  maxSeries,
  otherSeriesLabel,
}: {
  series: readonly TSeries[];
  points: readonly TPoint[];
  maxSeries?: number;
  otherSeriesLabel?: string;
}): FoldedTimeSeries<TSeries, TPoint> {
  const cap = resolveSeriesCap(maxSeries);
  // The cap is honoured LITERALLY: at most `cap` real series are ever drawn, so
  // the highest palette slot this module can ask for is `cap - 1`.
  //
  // This previously read `cap + 1`, on the reasoning that folding exactly ONE
  // series draws the same number of bands while trading that series' name for an
  // anonymous "Other (1)" — "strictly worse, since the palette demonstrably had a
  // slot free for it". That premise is false in the product configuration. The
  // caller's cap is clamped to `CHART_SERIES_COLOR_LIMIT`, and the product passes
  // exactly that limit, so at `cap === palette size` there is NO free slot: 11
  // series against a cap of 10 skipped the fold, numbered slots 0..10, and handed
  // the eleventh `chartSeriesColor(10)` — the overflow branch, which returns the
  // reserved aggregate neutral. A named model then wore the one colour that means
  // "these could not be told apart", and `chartSeriesColor`'s own contract
  // ("never a state a product surface should reach") was violated by this module.
  //
  // Comparing at `cap` keeps the highest requested slot at `cap - 1` for every
  // cap, so the overflow branch is unreachable by construction rather than by
  // arithmetic that happens to work only while `cap < palette size`. The cost is
  // real and accepted: at exactly `cap + 1` series one series now folds into
  // "Other (1)", losing its name. That is the honest trade — a band whose colour
  // means what it says, instead of a named band wearing the aggregate's neutral.
  if (cap === undefined || series.length <= cap) {
    return {
      aggregateKey: undefined,
      foldedCount: 0,
      points: [...points],
      series: [...series],
    };
  }

  const aggregateKey = resolveAggregateKey(series);
  const keptKeys = selectKeptSeriesKeys(series, points, cap);
  const kept = series.filter((entry) => keptKeys.has(entry.key));
  const foldedKeys = series
    .filter((entry) => !keptKeys.has(entry.key))
    .map((entry) => entry.key);

  const foldedSeries: FoldableSeriesDef = {
    key: aggregateKey,
    label: chartOtherSeriesLabel(foldedKeys.length, otherSeriesLabel),
  };

  const foldedPoints = points.map((point) => ({
    ...point,
    values: {
      ...point.values,
      [aggregateKey]: sumFoldedValues(point.values, foldedKeys),
    },
  }));

  // The aggregate leads, so it stacks at the BOTTOM. Real distributions are
  // heavy-tailed, so the folded tail routinely out-masses the smallest named
  // series; sitting on top it would cap the silhouette the eye actually reads
  // with the one band that has no identity. On the baseline it stays legible
  // without defining the shape.
  return {
    aggregateKey,
    foldedCount: foldedKeys.length,
    points: foldedPoints,
    series: [foldedSeries, ...kept],
  };
}

/**
 * The aggregate band's key, guaranteed absent from the caller's own series.
 *
 * A caller whose key happened to equal the reserved one would have its values
 * overwritten by the aggregate sum, and both bands would register one legend
 * identity. Vanishingly unlikely with model ids and provider names, and cheap
 * to make impossible.
 */
function resolveAggregateKey(series: readonly FoldableSeriesDef[]): string {
  const taken = new Set(series.map((entry) => entry.key));
  let key = CHART_OTHER_SERIES_KEY;
  let suffix = 2;
  while (taken.has(key)) {
    key = `${CHART_OTHER_SERIES_KEY}${suffix}`;
    suffix += 1;
  }
  return key;
}

/**
 * A cap is only meaningful as a positive whole number, and a cap of 1 would draw
 * a single real series beside an aggregate of everything else — legal, so it is
 * allowed. Anything non-finite, fractional-below-one, or non-positive means the
 * caller did not ask for a cap.
 */
function resolveSeriesCap(maxSeries: number | undefined): number | undefined {
  if (maxSeries === undefined || !Number.isFinite(maxSeries)) {
    return undefined;
  }
  const cap = Math.trunc(maxSeries);
  return cap > 0 ? cap : undefined;
}

function selectKeptSeriesKeys(
  series: readonly FoldableSeriesDef[],
  points: readonly FoldablePointDatum[],
  cap: number
): Set<string> {
  const totals = new Map<string, number>();
  for (const entry of series) {
    totals.set(entry.key, 0);
  }
  for (const point of points) {
    for (const entry of series) {
      const value = point.values[entry.key];
      // Non-finite values are skipped for RANKING on purpose, and this is not the
      // same call as the aggregation above (codex review raised both together).
      // Ranking asks "how much magnitude does this series carry", and `NaN` or
      // `±Infinity` answer nothing — there is no honest magnitude to add. Folding
      // an unknown into the total would poison it: `+Infinity` would pin one
      // series at the top of the ranking forever and evict a real series from the
      // kept set on the strength of a single malformed point, and `NaN` would
      // erase a series' entire accumulated total. Skipping ranks the series on
      // the data that IS valid, which is the conservative reading. The malformed
      // value is not forgotten — if the series does fold, `sumFoldedValues` turns
      // that bucket into a visible gap rather than a number.
      if (typeof value === "number" && Number.isFinite(value)) {
        totals.set(entry.key, (totals.get(entry.key) ?? 0) + Math.abs(value));
      }
    }
  }
  const ranked = series
    .map((entry, index) => ({ index, key: entry.key }))
    .sort((a, b) => {
      const delta = (totals.get(b.key) ?? 0) - (totals.get(a.key) ?? 0);
      return delta === 0 ? a.index - b.index : delta;
    });
  return new Set(ranked.slice(0, cap).map((entry) => entry.key));
}

/**
 * The aggregate band's value for one bucket — or `null` when that bucket's total
 * is not fully known.
 *
 * A SUM IS ALL-OR-NOTHING. Folding is the one operation here that destroys
 * information: before it, an unmeasured model was its own visible gap and a
 * reader could see precisely which series had no data. After it, that gap is
 * inside a band labelled with a count, and the number the band plots is read as
 * the total of all `N` of them. So the aggregate may only state a number when it
 * can account for every folded key in the bucket; if any single contribution is
 * unknown, the total is unknown, and the honest rendering is the gap the chart
 * already draws for `null` — not a subtotal that looks complete.
 *
 * Per folded key, in one bucket:
 *
 *   - a finite number      -> known, contributes its value;
 *   - key absent entirely  -> known `0`. This is the chart's documented treatment
 *     of a missing key, and it is a statement about the DATASET's shape (this
 *     series does not appear in this bucket), not a failed measurement;
 *   - explicit `null`      -> UNKNOWN. The producer said "measured nothing here";
 *   - `NaN` / `±Infinity`  -> UNKNOWN. A present-but-malformed value is the one
 *     case we must not quietly discard: dropping it used to let a single valid
 *     sibling carry the band (a plausible subtotal), and an all-malformed bucket
 *     fabricate a confident `0`.
 *
 * Any unknown therefore makes the bucket `null`. Only an all-known bucket sums.
 *
 * Non-finite values are rejected HERE rather than routed to a monitoring channel
 * (codex review): this is a pure function inside a `@closedloop-ai/design-system` render
 * path that runs on the client, where the repo's logging discipline forbids
 * client-side reporting, and the module has no observability seam to reach. The
 * value is not swallowed — it is what turns the whole bucket into a visible gap,
 * which is exactly the "treat the aggregate as unavailable" branch the review
 * asked for.
 */
function sumFoldedValues(
  values: Record<string, number | null>,
  keys: readonly string[]
): number | null {
  let total = 0;
  for (const key of keys) {
    // Widened deliberately: `noUncheckedIndexedAccess` is off, so the index
    // signature claims `number | null` for a key that may simply be absent. The
    // absent case is a real and meaningful input here, so name it in the type
    // rather than letting the compiler pretend it cannot happen.
    const value: number | null | undefined = values[key];
    if (value === undefined) {
      // Absent key: a documented, known zero. Contributes nothing.
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      // Explicit null, NaN, or ±Infinity — this bucket's total is not knowable.
      return null;
    }
    total += value;
  }
  return total;
}
