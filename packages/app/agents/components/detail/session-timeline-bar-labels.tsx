"use client";

import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import { useContainerWidth } from "@repo/design-system/hooks/use-container-width";
import {
  formatBucketBarLabel,
  formatBucketTooltipTotal,
  getBarStyle,
  getBucketCost,
  isInteriorGap,
} from "./activity-bucket-rendering";
import { fitBucketBarLabels } from "./session-timeline-bar-label-fit";

/**
 * ISS-5563 (code review): the Session Timeline's cost labels, as a rail that
 * sits ABOVE the bars instead of inside them.
 *
 * The labels used to be `position: absolute; top: -14px` spans rendered inside
 * each `.sd3-bar2`, and that bar is `overflow: hidden` (it has to be — it clips
 * its own stacked `<i>` cost segments to the bar's rounded box). An absolutely
 * positioned child is clipped by its containing block's overflow, and `top:
 * -14px` puts the label entirely outside that box, so the label was clipped
 * away in BOTH axes and never rendered at all. Whatever the label said, no
 * reader saw it.
 *
 * Horizontally the same clip was the reason the old label could only ever be a
 * rounded figure: the desktop producer targets `SESSION_TRACE_BUCKET_TARGET`
 * buckets across a `flex: 1 1 0` row, so a bar is roughly 18px on a normal
 * detail width. At 9.5px that fits about `$1` — `$1.02` wants ~28px and
 * `$0.0025` ~40px — and because the label was centered with
 * `translateX(-50%)`, the clip took a glyph off EACH end. `1.0`, with the
 * dollar sign and the last digit gone, is worse than the rounded number
 * ISS-5563 set out to replace: a rounded number at least still looks like a
 * number.
 *
 * So the rail is what makes ISS-5563's precision actually deliverable. It
 * mirrors `.sd3-bars2`'s own flex geometry — one `flex: 1 1 0` cell per bucket,
 * the same 2px gap — so each label centers over its own bar without any
 * absolute positioning or per-bucket left math, and it is free to overflow its
 * cell because nothing in the rail clips. The bar keeps `overflow: hidden` for
 * the segments that need it.
 *
 * The rail is `aria-hidden`: every bar is already a button whose accessible name
 * carries its cost (`getBucketButtonLabel`), so announcing these would read the
 * same figure twice. That is load-bearing rather than incidental — see
 * ISS-5761 below, where the rail can decide to print nothing at all, and the
 * accessible name is then the only place the figure lives outside a hover.
 *
 * ISS-5761: the rail MEASURES ITSELF and prints only when the print is legible.
 * Making the labels paint (above) also made them collide: the rail does not
 * clip, the labels are `nowrap`, and each cell is only as wide as the bar under
 * it, so at the 40 buckets `SESSION_TRACE_BUCKET_TARGET` targets they abut into
 * one unreadable run — the reported strip showed `$724.0`, which is `$7` and
 * `$24.0` touching. {@link fitBucketBarLabels} owns that decision and the
 * geometry behind it; this component's only job is to supply the width.
 *
 * `useContainerWidth` is measured on the rail itself rather than on
 * `.sd3-bars2-wrap`, because the rail IS the box the cells divide up, so no
 * padding or border has to be modelled a second time.
 *
 * `measured` is honoured rather than falling back on the hook's pre-measurement
 * default, and that is not a nicety (code review). The default is a WIDE box
 * (1024px), deliberately, so a component choosing between two layouts never
 * flashes the narrow one — but here a wider guess biases {@link
 * fitBucketBarLabels} toward PRINTING, which is the wrong direction for a
 * fix whose failure mode is printing into columns too narrow to hold the
 * figures. On a sparse 40-bucket rail the 1024px default fits where the real
 * ~400–720px pane does not, so every unmeasured state — SSR, the frame before
 * the layout effect, a detached or `display: none` or parked-off-screen
 * container — would paint exactly the collision this exists to remove. An
 * unmeasured rail therefore prints nothing, and since the hook seeds
 * synchronously in a layout effect the measured frame is the first PAINTED one.
 */
export function SessionTimelineBarLabels({
  labels,
  peakIndex = null,
}: Readonly<{
  labels: readonly (string | null)[];
  /**
   * Which bucket the rail keeps when it can only afford ONE label — see
   * {@link fitBucketBarLabels}. Optional so an existing caller that cannot name
   * a peak degrades to all-or-nothing rather than to a wrong one.
   */
  peakIndex?: number | null;
}>) {
  const { measured, ref, width } = useContainerWidth<HTMLDivElement>();
  const fitted = fitBucketBarLabels({
    labels,
    peakIndex,
    railWidth: measured ? width : 0,
  });
  return (
    <div aria-hidden className="sd3-bars2-lbls" ref={ref}>
      {fitted.map((label, index) => (
        <span
          className="sd3-bar2-lbl"
          // Positional by construction: this rail is a per-bucket mirror of the
          // bar row, so cell N belongs to bar N and the index IS the identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: positional rail cell
          key={index}
        >
          {label}
        </span>
      ))}
    </div>
  );
}

/**
 * Which buckets get a printed cost, and what it says — one entry per bucket,
 * `null` where the rail stays blank.
 *
 * Built here rather than inside the bar loop so the rail and the bars cannot
 * drift about which bucket is labelled: both read the same `getBarStyle`
 * decision for the same index. It also keeps this decision out of
 * `agent-session-detail-view.tsx`, which is grandfathered shrink-only.
 */
export function buildBucketBarLabels({
  buckets,
  costsSynthesized,
  maxCost,
  unreadFromIndex,
}: Readonly<{
  buckets: readonly ActivityBucket[];
  /**
   * ISS-5563 (code review): true when this strip's money was SYNTHESIZED rather
   * than measured, in which case no bucket gets a printed figure.
   *
   * `buildActivityBuckets` falls back to the transcript path when a session has
   * no persisted `activityBuckets`, and that path prices the whole strip from
   * `Math.max(session.estimatedCost, 0.01)` — a floor that exists so the bars
   * have something to draw — then splits each bucket by fixed in/out/cache
   * ratios. On a session whose `estimatedCost` is 0, the entire strip is that
   * one-cent placeholder spread over the eventful buckets, so a bar that used to
   * read `$0.0` would now read `$0.001`: four decimals of confidence on a number
   * nobody measured.
   *
   * That number is also self-refuting on its own screen. The same session's
   * Properties Cost row renders a dash, and after ISS-5572 that dash's tooltip
   * says "No token usage recorded to price" one panel above a strip printing
   * prices. The bars still draw at their placeholder heights — the floor keeps
   * doing the one job it was added for — but the strip stops PUBLISHING a
   * figure it cannot stand behind.
   */
  costsSynthesized: boolean;
  maxCost: number;
  unreadFromIndex: number;
}>): (string | null)[] {
  return buckets.map((bucket, index) => {
    if (costsSynthesized || index >= unreadFromIndex) {
      return null;
    }
    const cost = getBucketCost(bucket);
    const bar = getBarStyle(cost, maxCost, isInteriorGap(index, buckets));
    return bar.showLabel ? formatBucketBarLabel(cost) : null;
  });
}

/**
 * ISS-5761: which bucket the rail keeps when it can only afford one label — the
 * most expensive one, or `null` on a strip with no priced bucket to point at.
 *
 * Read off `getBucketCost` rather than off the printed labels, because a label
 * is a formatted string (`~$1.1k`, `$0.0025`) and parsing money back out of it
 * to compare magnitudes would be a second, weaker source of truth for a number
 * the caller already holds exactly.
 *
 * Ties go to the earliest bucket. Arbitrary, but deterministic, which is what
 * matters — two buckets at the identical peak are equally good answers and the
 * rail must not flicker between them across renders.
 */
export function getPeakBucketIndex(
  buckets: readonly ActivityBucket[]
): number | null {
  let peakIndex: number | null = null;
  let peakCost = 0;
  for (const [index, bucket] of buckets.entries()) {
    const cost = getBucketCost(bucket);
    if (cost > peakCost) {
      peakCost = cost;
      peakIndex = index;
    }
  }
  return peakIndex;
}

/**
 * ISS-5761: the cost fragment each bucket BUTTON's accessible name carries — one
 * entry per bucket, `null` where the strip has no figure it may publish.
 *
 * Deliberately not {@link buildBucketBarLabels}. That one answers "what does the
 * rail PRINT", and it is filtered twice over: by `getBarStyle`'s `showLabel`
 * threshold, which prints only buckets at or above 16% of the strip's peak, and
 * now by {@link fitBucketBarLabels}, which prints nothing at all when the
 * columns are too narrow. Neither filter is about whether the figure is KNOWN —
 * both are about whether there is room and reason to draw it — so neither
 * belongs in the accessible name. A screen-reader user moving across the strip
 * gets every priced bucket's cost regardless of what the rail decided to ink.
 *
 * The one filter that does carry over is provenance: `costsSynthesized` is
 * ISS-5566's withdrawal of figures the strip cannot stand behind, and a name
 * that announced them would republish exactly what the rail withdrew.
 *
 * Formatted with `formatBucketTooltipTotal` — the EXACT formatter — and
 * deliberately not the rail's `formatBucketBarLabel` (code review). Above
 * `BAR_LABEL_ABBREVIATION_FLOOR` the rail prints `~$1.1k`, and it does so for
 * ONE reason: four significant digits do not fit in an 18px bar. That is a
 * pixel-width constraint, and an accessible name has no width. Borrowing the
 * compact formatter here handed a screen-reader user a `~$1.1k` approximation
 * while a sighted user hovering the same bar got `$1,108.86` from the tooltip —
 * the abbreviation is announced as approximate, but the exact figure was then
 * reachable ONLY by pointer, which is the very access gap this function exists
 * to close.
 *
 * It does not reintroduce the two-precisions defect ISS-5563 removed. That
 * defect was two formatters DISAGREEING about a figure neither marked as
 * approximate. Here the rail's `~` says "approximate, exact value elsewhere",
 * and this is that elsewhere — the same relationship, and the same formatter
 * pairing, that {@link formatBucketTooltipTotal} already documents for the
 * hover card: "the tooltip has the room the bar does not […] That is a
 * refinement, not a contradiction."
 */
export function buildBucketAccessibleCosts({
  buckets,
  costsSynthesized,
}: Readonly<{
  buckets: readonly ActivityBucket[];
  costsSynthesized: boolean;
}>): (string | null)[] {
  return buckets.map((bucket) => {
    if (costsSynthesized) {
      return null;
    }
    const cost = getBucketCost(bucket);
    return cost > 0 ? formatBucketTooltipTotal(cost) : null;
  });
}

/**
 * Whether this session's timeline costs are the synthesized placeholder rather
 * than measured spend — the input to {@link buildBucketBarLabels}'s
 * `costsSynthesized`.
 *
 * Mirrors `buildActivityBuckets`'s own branch: persisted `activityBuckets` are
 * priced from the producer's per-event cost columns and are real, while the
 * transcript fallback prices the strip from `Math.max(estimatedCost, 0.01)`. It
 * is only that floor — an `estimatedCost` of 0 — that manufactures money, so a
 * fallback strip on a session with real spend still labels its bars.
 *
 * Written `!(estimatedCost > 0)` rather than `<= 0` so a missing or NaN cost
 * arriving across the JSON boundary counts as unpriced instead of slipping
 * through as measured.
 */
/**
 * ISS-5566 × ISS-5563: the one place that decides what a timeline strip is
 * allowed to say about money.
 *
 * Two provenance predicates met here, and they are NESTED rather than parallel:
 *
 * - `synthesized` (ISS-5566, from `buildActivityBuckets`) is true whenever the
 *   session persisted no `activityBuckets`, so the strip was reconstructed from
 *   the transcript. It says nothing about `estimatedCost`, because what it
 *   indicts is the PER-BUCKET figure: a `turns + toolCalls * 3` allocation split
 *   by three fixed in/out/cache ratios. Those are invented even when the
 *   session's total is real spend.
 * - `costsSynthesized` ({@link hasSynthesizedBucketCosts}) is true only for the
 *   narrower case where that reconstruction ALSO had no real total to spread —
 *   `estimatedCost <= 0`, so the whole strip is the `MIN_ACTIVITY_COST` floor.
 *
 * On any strip that actually renders, `costsSynthesized` implies `synthesized`:
 * both require the absence of persisted buckets, and a strip with no persisted
 * buckets and no transcript rows produces zero buckets and never reaches a
 * label. So when `disclosureEnabled` is on, `costUnmeasured` already covers
 * every case `costsSynthesized` covers and `barCostsUnpublished` EQUALS it —
 * one boolean governs the rail, the in/out/cache stack, the tooltip total and
 * the tooltip's per-model table together, so they cannot contradict each other.
 *
 * The union matters only while the flag is OFF, where it preserves ISS-5563's
 * already-shipped, ungated withdrawal of the `$0.001` floor labels instead of
 * regressing it. A MEASURED strip has persisted buckets, so both predicates are
 * false and its labels print either way.
 *
 * Returned as a pair rather than derived at the call site because
 * `agent-session-detail-view.tsx` is grandfathered shrink-only and sits on the
 * cognitive-complexity ceiling.
 */
export function resolveTimelineCostDisclosure({
  costsSynthesized,
  disclosureEnabled,
  synthesized,
}: Readonly<{
  costsSynthesized: boolean;
  disclosureEnabled: boolean;
  synthesized: boolean;
}>): Readonly<{ barCostsUnpublished: boolean; costUnmeasured: boolean }> {
  const costUnmeasured = synthesized && disclosureEnabled;
  return {
    barCostsUnpublished: costUnmeasured || costsSynthesized,
    costUnmeasured,
  };
}

export function hasSynthesizedBucketCosts(
  session: Readonly<{
    activityBuckets?: readonly ActivityBucket[] | null;
    estimatedCost: number;
  }>
): boolean {
  const hasPersistedBuckets =
    session.activityBuckets != null && session.activityBuckets.length > 0;
  return !(hasPersistedBuckets || session.estimatedCost > 0);
}
