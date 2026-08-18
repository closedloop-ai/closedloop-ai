import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import {
  formatCompact,
  formatCostPrecise,
} from "@repo/app/shared/lib/format-utils";

export function getBucketCost(bucket: ActivityBucket): number {
  return bucket.cIn + bucket.cOut + bucket.cCache;
}

/**
 * Why a click on this bar cannot land — `null` when it can.
 *
 * ISS-5479 review: the affordance was keyed to `tl0 == null`, which is only ONE
 * of the reasons. A bucket can carry a jump row that has no counterpart in the
 * transcript actually on screen (`toRendered` returns null), and that is not
 * rare — a `subagent:{id}` view publishes `allowNearestTime: false`, so only a
 * shared strong per-turn id binds and most root-timeline bars resolve null.
 * Those bars kept the pointer cursor, the hover outline and a "Jump to …" name
 * while every click reported failure.
 *
 * The two reasons stay distinct rather than collapsing into one "cannot jump"
 * flag, because they are different facts about the world and the reader is owed
 * the difference: nothing happened in that slice, versus something happened and
 * you are looking at a different file.
 */
export const BucketJumpBlock = {
  /** The bucket's time slice caught no transcript turn at all. */
  NoTurn: "no-turn",
  /** The turn exists but is absent from the transcript being rendered. */
  NotInReadTranscript: "not-in-read-transcript",
} as const;

export type BucketJumpBlock =
  (typeof BucketJumpBlock)[keyof typeof BucketJumpBlock];

/**
 * Resolve a bar's jump block. `isRowInReadTranscript` is the reactive mirror of
 * `TraceRowTranslators.toRendered`.
 *
 * ISS-6006 retired the `session-timeline-jump-feedback` gate ON, so this answers
 * from the bucket alone — there is no longer a dark-launch path that reports
 * every bar as unblocked.
 */
export function getBucketJumpBlock(
  bucket: ActivityBucket,
  isRowInReadTranscript: (row: number) => boolean
): BucketJumpBlock | null {
  if (bucket.tl0 == null) {
    return BucketJumpBlock.NoTurn;
  }
  return isRowInReadTranscript(bucket.tl0)
    ? null
    : BucketJumpBlock.NotInReadTranscript;
}

/**
 * ISS-5761: the name carries the bucket's COST when there is one to publish.
 *
 * The rail above the bars is `aria-hidden` on the stated ground that "every bar
 * is already a button whose accessible name carries its cost" — which was not
 * true: this returned the clock offset and nothing else, and the only other
 * place a per-bucket figure appeared was the hover card, which opens on
 * `onMouseEnter` alone. So the figure was reachable by pointer and by no other
 * means, and ISS-5761's fix — a rail that goes quiet when the columns are too
 * narrow to print legibly — would have made that the ONLY state on a long
 * session. Naming the cost here is what lets the rail stay silent without the
 * value leaving the page.
 *
 * `costLabel` is passed in rather than derived from `bucket` because whether a
 * strip may publish a figure at all is not a property of one bucket: ISS-5566's
 * synthesized strips withdraw every printed cost, and the caller already holds
 * that decision (`resolveTimelineCostDisclosure`). Passing `null` keeps today's
 * name exactly, so an unpriced strip does not start announcing money.
 */
export function getBucketButtonLabel(
  bucket: ActivityBucket,
  block: BucketJumpBlock | null = null,
  costLabel: string | null = null
): string {
  const action =
    bucket.tl0 == null || block != null
      ? `Activity bucket ${bucket.label}`
      : `Jump to activity bucket ${bucket.label}`;
  return costLabel == null ? action : `${action}, ${costLabel}`;
}

/**
 * The trailing fragment of the bucket tooltip's meta line — the one that tells
 * the reader what a click on this bar will do.
 *
 * ISS-5479: the idle case is answered HERE rather than in a corner toast. On a
 * real session most bars carry no jump row, so that is the frequent answer, and
 * the reader's eye is on the bar — this tooltip is already anchored to it and
 * already open at click time. A card at the screen edge repeated what the
 * withdrawn cursor and outline had just said, somewhere the reader was not
 * looking. `Unresolvable` and `EmptyTranscript` keep the toast: those the reader
 * genuinely could not have seen coming from the control's appearance.
 *
 * Deliberately about the CLICK ("nothing to open here"), not about the activity.
 * A bucket can hold events while holding no transcript turn, and this fragment
 * renders inches from `bucket.total` events — a line denying activity would
 * contradict the number beside it.
 */
export function getBucketJumpHint(
  bucket: ActivityBucket,
  block: BucketJumpBlock | null
): string {
  if (block === BucketJumpBlock.NoTurn) {
    return " | nothing to open here";
  }
  /*
   * The sidechain case earns its own sentence rather than borrowing the
   * partial-upload one. "Not in the read transcript" reads as a data-integrity
   * claim about the upload, when the honest answer on a `subagent:{id}` view is
   * simply that the reader is looking at a different file.
   */
  if (block === BucketJumpBlock.NotInReadTranscript) {
    return " | not in the transcript on screen";
  }
  return bucket.tl0 == null ? "" : " | click to open in trace";
}

export function getBucketKey(
  bucket: ActivityBucket | undefined,
  index: number
): string {
  if (!bucket) {
    return `missing-bucket-${index}`;
  }
  if (bucket.key) {
    return bucket.key;
  }
  return [
    index,
    bucket.label,
    bucket.tl0 ?? "idle",
    bucket.total,
    bucket.toolStart,
    bucket.cCache,
    bucket.cOut,
    bucket.cIn,
  ].join(":");
}

/**
 * The three mutually exclusive bar treatments {@link getBarStyle} chooses
 * between, named so callers can branch on the answer instead of re-deriving it
 * from `cost`/`gap` or comparing against a copied string literal.
 *
 * ISS-5566 review: `SYNTHESIZED_BAR_CLASS` must be applied ONLY on top of
 * `Stacked`. It replaces the in/out/cache stack, and a zero-cost bar never had
 * one — layering it over `Idle` or `Gap` would repaint "nothing happened here"
 * as "something happened, unpriced", which is a different and false claim.
 */
export const BucketBarClass = {
  /** An interior quiet slice between two active ones. */
  Gap: "cb-gap",
  /** Zero cost — nothing landed in this slice. */
  Idle: "idle",
  /** An active bar carrying the in/out/cache stack. */
  Stacked: "stacked",
} as const;

export type BucketBarClass =
  (typeof BucketBarClass)[keyof typeof BucketBarClass];

/**
 * Resolve the visual properties for a single activity bar: height percentage,
 * CSS class, and whether the cost label is shown. Consolidates the gap/idle/
 * active decision tree that was previously three nested ternaries in the
 * component.
 */
export function getBarStyle(
  cost: number,
  maxCost: number,
  gap: boolean
): { height: number; barClass: BucketBarClass; showLabel: boolean } {
  if (gap) {
    return { height: 4, barClass: BucketBarClass.Gap, showLabel: false };
  }
  if (cost === 0) {
    return { height: 0, barClass: BucketBarClass.Idle, showLabel: false };
  }
  return {
    height: Math.max(
      9,
      Math.round((Math.sqrt(cost) / Math.sqrt(maxCost)) * 100)
    ),
    barClass: BucketBarClass.Stacked,
    showLabel: cost >= maxCost * 0.16,
  };
}

export function isInteriorGap(
  index: number,
  buckets: readonly ActivityBucket[]
): boolean {
  if (getBucketCost(buckets[index]) !== 0) {
    return false;
  }
  let hasBefore = false;
  for (let i = 0; i < index; i++) {
    if (getBucketCost(buckets[i]) > 0) {
      hasBefore = true;
      break;
    }
  }
  if (!hasBefore) {
    return false;
  }
  for (let i = index + 1; i < buckets.length; i++) {
    if (getBucketCost(buckets[i]) > 0) {
      return true;
    }
  }
  return false;
}

/**
 * ISS-5075 (stage VQA review): the bar style for a bucket the detail read never
 * reached. A full-height wash, NOT the idle hatch — an empty region on this
 * strip already means "nothing happened here" (`.sd3-bar2.idle`,
 * `.sd3-bar2.cb-gap`), so without its own treatment an unread tail and a quiet
 * tail look identical, and a reader who skims the strip and skips the caption
 * walks away with the wrong number of hours.
 *
 * The tail renders decorative (`aria-hidden`) and is named ONCE by the caption
 * under the strip: it spans many buckets and none of them is a control, so
 * per-bucket labelling would put a run of identically-named inert elements in a
 * screen-reader user's path.
 */
export const UNREAD_BAR_STYLE = {
  height: 100,
  barClass: "unread",
  showLabel: false,
} as const;

/**
 * ISS-5566: the bar treatment for an ACTIVE bar on a SYNTHESIZED strip — one
 * whose buckets were reconstructed from the transcript because the collector
 * persisted none.
 *
 * A hatch rather than the solid fill, and deliberately NOT the in/out/cache
 * stack: that stack is the strip's vocabulary for "this is where the money
 * went", and on a synthesized bucket the split behind it is three fixed ratios
 * repeated identically on every bar.
 *
 * Review (BHA / BHB / logical-metric, independently): this composes ONLY with
 * {@link BucketBarClass.Stacked}. `.sd3-bar2.synthesized` ties on specificity
 * with `.sd3-bar2.idle` and `.sd3-bar2.cb-gap`, so a bar carrying both would
 * silently lose the zero-cost hatch and read as active-but-unpriced. The caller
 * gates on `bar.barClass`, and the stylesheet declares this rule BEFORE the two
 * zero-cost rules so they would still win if a future caller stopped gating.
 */
export const SYNTHESIZED_BAR_CLASS = "synthesized";

/**
 * Named ONCE beneath the strip, the way {@link UNREAD_BAR_STYLE}'s tail is —
 * per-bar copy would repeat the same line up to 48 times into a screen reader's
 * path for a fact about the strip as a whole.
 *
 * Says what was NOT recorded rather than hedging ("approximate", "estimated"),
 * which would leave a reader treating the shape as a cost readout with error
 * bars. Three review notes shaped the rest of the wording:
 *
 * - NO leading treatment word. `TRACE_UNREAD_TAIL_LEGEND` can open "Shaded:"
 *   because read and unread bars sit side by side on one strip, so the word has
 *   something to point at. Here the WHOLE strip is synthesized, there is no
 *   measured bar on screen to contrast against, and the two treatments that are
 *   also hatched (`.idle`, `.cb-gap`) mean the opposite thing — observed, and
 *   nothing happened. "Hatched:" sent the eye to exactly the wrong bars.
 * - "Cost over time", not "per-bucket". A bucket is our word for a slice of this
 *   strip, not the reader's. It cannot shorten to "Cost not recorded" either:
 *   the Cost property a few inches up the same panel can be showing a real
 *   figure for this same session, and this caption must stay distinct from it.
 * - "Taller bars saw more activity", not "bar heights show relative activity".
 *   {@link getBarStyle} sizes on `sqrt(cost)/sqrt(maxCost)` while the
 *   synthesized cost is linear in turns plus tool calls, so a slice with four
 *   times the activity comes out only twice as tall. With the dollars withdrawn
 *   this caption is the only instruction anyone gets for reading the shape, so
 *   it must not promise a proportional read the encoding does not deliver.
 *   Ordering is true and is all the sqrt scale actually guarantees.
 */
export const TIMELINE_SYNTHESIZED_COST_LEGEND =
  "Cost over time wasn't recorded for this session; taller bars saw more activity.";

/**
 * The tooltip's replacement for a per-model dollar table it cannot honestly
 * fill. The same two claims as {@link TIMELINE_SYNTHESIZED_COST_LEGEND} in
 * fewer words, because the reader is hovering a single bar and the caption
 * beneath the strip has already made the long version available.
 */
export const TIMELINE_SYNTHESIZED_COST_TOOLTIP =
  "Cost over time wasn't recorded | taller bars saw more activity";

/**
 * The synthesized strip's answer for a bucket that caught nothing.
 *
 * ISS-5566 review (logical-metric-reconciliation-auditor): a zero-cost
 * synthesized bucket has `total === 0` — the transcript recorded no turn in
 * that slice, which IS an observation, so answering it with
 * {@link TIMELINE_SYNTHESIZED_COST_TOOLTIP} would throw away a fact we hold.
 * But the measured strip's idle line ends "no tokens billed", and on a session
 * with no recorded cost that is a billing claim nothing backs. This keeps the
 * true-zero/unknown distinction the reader is owed while making neither claim.
 */
export const TIMELINE_SYNTHESIZED_IDLE_TOOLTIP =
  "Nothing recorded in this slice";

/**
 * The first bucket index the detail read never reached — everything from here to
 * the end of the strip is unread rather than idle. `buckets.length` (nothing
 * unread) whenever the stream was whole, and `0` when the cut landed before
 * anything plottable survived.
 *
 * The axis still spans the whole run on a truncated read
 * (`resolveSessionTimelineWindow`), so these trailing buckets are real TIME with
 * no evidence either way, not observed quiet.
 */
export function getUnreadFromIndex(
  buckets: readonly ActivityBucket[],
  eventsTruncated: boolean
): number {
  if (!eventsTruncated) {
    return buckets.length;
  }
  for (let index = buckets.length - 1; index >= 0; index--) {
    const bucket = buckets[index];
    if (bucket.total > 0 || getBucketCost(bucket) > 0) {
      return index + 1;
    }
  }
  return 0;
}

/**
 * The bar's hit-target modifier, or `""` when the bar keeps today's geometry.
 *
 * ISS-5548: `.sd3-bars2` is `align-items: flex-end` and a bar's height IS its
 * value, so the `<button>` — which is the control, and therefore the whole click
 * target — shrinks with the bucket. `getBarStyle` floors an active bar at 9% of
 * a 62px column (about 6px) and the `.idle` / `.cb-gap` rules pin theirs at 7px
 * and 4px. `.reach` lets the stylesheet extend that target up its own column
 * without moving the bar, which stays the visual encoding of magnitude.
 *
 * Keyed off `tl0`, NOT off the bar's value. A bucket with no transcript anchor
 * has nowhere to send a click, so it is deliberately left at today's size: this
 * flag must never turn inert space into a bigger dead target, which is the
 * defect ISS-5479 (PR #4615) fixed. An unreachable bar and a reachable-but-inert
 * bar stay distinguishable in either position of this flag.
 *
 * ## What this box governs: the CLICK. The hover rides along.
 *
 * Said out loud because the box carries three things at once and the choice is
 * only obvious for one of them (code review). The same `<button>` takes the
 * click, the hover outline AND `onMouseEnter`, so widening it also widens the
 * region that pops the bucket tooltip — the only place a reader gets the cost
 * split, the event count and the tool-call count. The predicate is chosen for
 * the CLICK, and the tooltip follows because it is on the same element.
 *
 * The consequence is real and is the intended trade, not an oversight: an idle
 * or interior-gap bucket with no anchor keeps its 7px / 4px hover region while
 * an anchored neighbour gets the full 62px, so the smallest targets on the strip
 * are the ones this flag skips. The alternative — extending the box on
 * anchorless bars for the tooltip's sake — is rejected because it re-creates
 * exactly the defect ISS-5479 (PR #4615) fixed, at ten times the size: those
 * bars are deliberately marked `aria-disabled` with the affordance withdrawn
 * (`.no-jump`), and a 62px region that announces itself as unavailable is a
 * worse control than a 7px one. Making a quiet bucket's tooltip easier to reach
 * is a separate problem from making its jump easier to hit, and it wants its own
 * treatment (a hover band that is not also a click target) rather than a wider
 * dead button.
 *
 * ## Two anchored-looking bars that behave differently
 *
 * A costly-but-anchorless bucket (`cIn: 0.4, tl0: null`) sits beside a jumpable
 * one and, on geometry alone, nothing distinguishes them. What tells them apart
 * is `.no-jump` — ISS-5479's withdrawn affordance, which lives in this same
 * module (`getBucketJumpBlock`) and stylesheet and is unconditional since
 * ISS-6006 retired its gate ON. That treatment governs what a click SAYS while
 * this flag governs where it LANDS, so the anchorless bar already reads as
 * unavailable at the moment its neighbour grows a column-tall target.
 *
 * `disabled` is part of the predicate, not a styling detail left to CSS (code
 * review). FEA-4252 passes `disabled` for the whole strip while the trace has no
 * rendered rows — and `traceHasRenderedRows` is not merely a first-paint flash,
 * it mirrors the trace's rendered rows and can sit false indefinitely. Scoping
 * only the outline in CSS is not enough, because the hit box itself carries two
 * further signals: `.sd3-bar2 { cursor: pointer }` is unscoped and inherits into
 * `::before`, so a dead control would show a click cursor over the full column;
 * and the base `.sd3-bar2:hover` outline is likewise unscoped, so hovering blank
 * space 50px up the column would light the 6px sliver at the floor with nothing
 * under the pointer. Withholding the class settles all three at once and keeps a
 * disabled bar on exactly today's geometry — this flag changes where a live
 * click LANDS, never what a dead control offers.
 */
export function getBucketReachClass(
  bucket: ActivityBucket,
  columnHitTargetEnabled: boolean,
  disabled = false
): string {
  if (columnHitTargetEnabled && !disabled && bucket.tl0 != null) {
    return "reach";
  }
  return "";
}

/**
 * Where the read-only "you are here" line sits, as a percentage across the
 * strip: the centre of the last bucket whose jump row is at or before
 * `activeRow`. `0` when there is nothing to point at.
 *
 * ISS-5548 moved this out of `agent-session-detail-view.tsx` — it is pure
 * bucket-array geometry with no view state, so it belongs beside the rest of
 * this module's bucket math rather than in that shrink-only view.
 */
export function getRowPercent(
  activeRow: number | null,
  buckets: readonly ActivityBucket[]
): number {
  if (buckets.length === 0 || activeRow == null) {
    return 0;
  }
  let bucketIndex = 0;
  for (const [index, bucket] of buckets.entries()) {
    if (bucket.tl0 != null && bucket.tl0 <= activeRow) {
      bucketIndex = index;
    }
  }
  return ((bucketIndex + 0.5) / buckets.length) * 100;
}

/**
 * ISS-5563: the cost label painted inside an activity bar.
 *
 * It used to be `` `$${cost < 1 ? cost.toFixed(1) : Math.round(cost)}` ``, which
 * rounded every figure at or above a dollar to whole dollars. On the reported
 * session that put `$1` on the most visually prominent instance of a number the
 * Properties panel and the Activity breakdown both printed as `$1.02` — the same
 * figure, on one screen, in three precisions, with the LEAST precise one leading
 * the eye. At $1.49 it lost 49 cents; at $1,108.86 it read `$1109`, which is not
 * an abbreviation a reader can detect.
 *
 * The rule now: below {@link BAR_LABEL_ABBREVIATION_FLOOR} the label is the
 * SHARED `formatCostPrecise`, the same formatter behind the figures it has to
 * tie out against, so the bar and the breakdown cannot disagree by construction
 * rather than by two formatters that happen to round alike. (`formatCostPrecise`
 * rather than `formatCost` because a genuine sub-cent bucket must not be flattened
 * to `$0.00` — ISS-4919 — and `showLabel` can select a bucket that small.)
 *
 * At or above the floor the label is abbreviated, because four significant digits
 * do not fit inside a bar — but it is marked `~` so it reads as an approximation
 * instead of an exact figure. The exact value stays one hover away in the bucket
 * tooltip. An abbreviation that announces itself is honest; a silently rounded
 * one is the bug.
 */
export function formatBucketBarLabel(cost: number): string {
  if (cost >= BAR_LABEL_ABBREVIATION_FLOOR) {
    return `~$${formatCompact(cost)}`;
  }
  return formatCostPrecise(cost);
}

/**
 * ISS-5563: the money format for the bucket TOOLTIP — the bar label's exact
 * counterpart, moved here from `agent-session-detail-view.tsx` so the two
 * formatters that render one bucket's cost sit together and a change to either
 * is made with the other in view. (That file is grandfathered shrink-only, so
 * the move also pays down a little of it.)
 *
 * Scope: the per-model BREAKDOWN ROWS only — never the tooltip's header total.
 * The rows are a decomposition, and a long tail of `$0.0000` cells there is
 * noise, so flooring sub-cent to `$0.00` is right for them. The header is a
 * different figure with a different obligation: it is the SAME value the bar
 * label shows, so it must agree with it — see {@link formatBucketTooltipTotal}.
 *
 * ISS-5563 code review (logical-metric-reconciliation): this floor used to back
 * the header too, which meant a sub-cent bucket rendered `$0.0042` on the bar
 * and `$0.00` in its own hover — one figure, one screen, two precisions, which
 * is the exact defect ISS-5563 exists to remove, reintroduced one hover away.
 * `getBarStyle`'s `showLabel` really can select a bucket that small, so the
 * case is reachable, not theoretical.
 *
 * ISS-5563 second review: moving the header alone left the card disagreeing with
 * ITSELF — a sub-cent bucket showed a `$0.0042` header over a table whose every
 * cache/out/in cell read `$0.00`, a decomposition that does not add up to the
 * total printed two lines above it. `bucketTotal` is what settles it: the rows
 * keep the cent floor at every normal magnitude (a long tail of `$0.0000` cells
 * IS noise), and drop to the shared precise formatter exactly when the bucket
 * they decompose is itself sub-cent, so one hover card always states one
 * magnitude. The fallback strip makes this routine rather than exotic —
 * `applyBucketCost` splits a floored bucket into three slices that are each well
 * under a cent.
 */
export function formatBucketTooltipMoney(
  value: number,
  bucketTotal: number
): string {
  if (bucketTotal < 0.01) {
    return formatCostPrecise(value);
  }
  return `$${value < 0.01 ? "0.00" : value.toFixed(2)}`;
}

/**
 * ISS-5563: the bucket tooltip's HEADER total — the same cost the bar label
 * renders, so it is formatted to the same precision and the two can never
 * disagree about one bucket.
 *
 * Exact at every magnitude rather than borrowing {@link formatBucketBarLabel}
 * wholesale: the tooltip has the room the bar does not, so above the bar's
 * abbreviation floor it shows the full `$1,108.86` where the bar shows a
 * `~$1.1k` that already announces itself as approximate. That is a refinement,
 * not a contradiction — the reader hovers precisely to get the exact figure.
 */
export function formatBucketTooltipTotal(value: number): string {
  return formatCostPrecise(value);
}

/**
 * Where the bar label stops being exact and starts being an explicitly-marked
 * abbreviation. `$999.99` is seven glyphs and still fits; past a thousand the
 * exact figure crowds the bar, and that is the only reason to abbreviate — so
 * the threshold is the width limit, not a precision preference.
 */
const BAR_LABEL_ABBREVIATION_FLOOR = 1000;
