"use client";

import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import type { TimelineStackSegment } from "@repo/app/agents/lib/session-timeline-stacks";
import { cn } from "@repo/design-system/lib/utils";
import {
  BucketBarClass,
  type BucketJumpBlock,
  getBarStyle,
  getBucketButtonLabel,
  getBucketCost,
  getBucketKey,
  getBucketReachClass,
  isInteriorGap,
  SYNTHESIZED_BAR_CLASS,
  UNREAD_BAR_STYLE,
} from "./activity-bucket-rendering";
import {
  getTimelineTooltipAnchor,
  type TooltipAnchor,
} from "./viewport-tooltip";

/**
 * The Session Timeline's BAR ROW — `.sd3-bars2` and the one control per bucket
 * inside it.
 *
 * Extracted from `agent-session-detail-view.tsx` (ISS-5761), which is
 * grandfathered shrink-only under the file-size ceiling and had accumulated the
 * whole strip inline. It is a clean seam: the row is a pure projection of
 * `buckets` plus the per-index decisions its caller already computed, it shares
 * no state with the rest of the view, and the cost rail above it
 * (`SessionTimelineBarLabels`) and the dot rail below it are already their own
 * units — this one was the odd one out.
 *
 * Presentational only, and DOM-identical to what the view rendered inline: the
 * same element, the same class list in the same order, the same handlers. The
 * per-bucket decisions (`jumpBlocks`, `accessibleCosts`) are passed in rather
 * than recomputed here, because the view derives them once for the whole strip
 * and the tooltip reads the same values — deriving them twice is how the bar and
 * its own hover card start disagreeing.
 */
export function SessionTimelineBars({
  accessibleCosts,
  buckets,
  columnHitTargetEnabled,
  costUnmeasured,
  disabled,
  hoverIndex,
  jumpBlocks,
  maxCost,
  onHover,
  onJump,
  stacks = null,
  unreadFromIndex,
}: Readonly<{
  /**
   * ISS-5761: the cost fragment each button's accessible name carries, by index.
   * NOT the rail's printed labels — the rail prints only prominent buckets, and
   * only when the columns are wide enough to print legibly, while the name
   * carries every priced bucket unconditionally.
   */
  accessibleCosts: readonly (string | null)[];
  buckets: readonly ActivityBucket[];
  columnHitTargetEnabled: boolean;
  costUnmeasured: boolean;
  disabled: boolean;
  hoverIndex: number | null;
  jumpBlocks: readonly (BucketJumpBlock | null)[];
  maxCost: number;
  onHover: (hover: { anchor: TooltipAnchor; index: number } | null) => void;
  onJump: (row: number | null) => void;
  /**
   * ISS-5819: the stacked segments to paint, by index, when the "Group by"
   * control is live. `null` — the default, and what every flag-off caller passes
   * — keeps the three hardcoded in/out/cache `<i>`s below, so the ungated DOM is
   * byte-identical to what shipped before this prop existed.
   *
   * A parallel array rather than a field on `ActivityBucket`: that type is a
   * cross-repo sync payload, and a purely local rendering choice has no business
   * on the wire.
   */
  stacks?: readonly TimelineStackSegment[][] | null;
  unreadFromIndex: number;
}>) {
  return (
    <div className="sd3-bars2">
      {buckets.map((bucket, index) => {
        const cost = getBucketCost(bucket);
        const gap = isInteriorGap(index, buckets);
        /*
         * The tail is many buckets wide (up to 48 on a day-long span), and it is
         * a WASH, not a control — there is nothing behind it to jump to.
         * Rendering it as buttons would put ~47 identically-named, inert
         * controls in a keyboard/screen-reader user's path, so the region is
         * decorative here and named ONCE, in the caption below.
         */
        if (index >= unreadFromIndex) {
          return (
            <div
              aria-hidden
              className={cn("sd3-bar2", UNREAD_BAR_STYLE.barClass)}
              key={getBucketKey(bucket, index)}
              style={{ height: `${UNREAD_BAR_STYLE.height}%` }}
            />
          );
        }
        const bar = getBarStyle(cost, maxCost, gap);
        // `null` when the click CAN land; otherwise which of the two reasons it
        // cannot. Drives the name, the affordance and the tooltip hint from one
        // value so they cannot disagree.
        const block = jumpBlocks[index] ?? null;
        return (
          <button
            aria-disabled={block != null}
            aria-label={getBucketButtonLabel(
              bucket,
              block,
              accessibleCosts[index] ?? null
            )}
            className={cn(
              "sd3-bar2",
              bar.barClass,
              hoverIndex === index && "hot",
              // ISS-5566: a hatch instead of the solid in/out/cache stack,
              // because that stack is this strip's way of saying "here is where
              // the money went" and on a synthesized bucket its split is three
              // fixed ratios, identical on every bar. Gated on `Stacked`
              // (review): a zero-cost bar never carried the stack, and
              // `.synthesized` ties on specificity with `.idle`/`.cb-gap`, so
              // layering it there would repaint "nothing happened here" as
              // "something happened, unpriced".
              costUnmeasured &&
                bar.barClass === BucketBarClass.Stacked &&
                SYNTHESIZED_BAR_CLASS,
              getBucketReachClass(bucket, columnHitTargetEnabled, disabled),
              // ISS-5479: a bar with no jump row keeps `cursor: pointer` and the
              // hover outline today, so it looks exactly like a live control
              // while being announced as unavailable and doing nothing.
              // `.no-jump` settles those three signals on one answer, matching
              // how `.unread` already reads. Deliberately NOT the existing
              // `.idle` class: that one is keyed off COST and only paints the
              // hatch, while jumpability is keyed off `tl0` — the two genuinely
              // disagree (a zero-cost bucket can still carry a turn, and a
              // costly one can carry none).
              block != null && "no-jump"
            )}
            disabled={disabled}
            key={getBucketKey(bucket, index)}
            // ISS-5479: hand `null` through rather than dropping the click.
            // `aria-disabled` (not `disabled`) marks the idle bar unavailable
            // while keeping its hover tooltip and its cost in the a11y tree.
            onClick={() => onJump(bucket.tl0)}
            // ISS-5548 design review: on a `.reach` bar the outlined region is
            // the whole column, so the readout hangs off the region that just
            // outlined itself, not the 6px bar at the floor.
            onMouseEnter={(event) =>
              onHover({
                anchor: getTimelineTooltipAnchor(event.currentTarget),
                index,
              })
            }
            onMouseLeave={() => onHover(null)}
            style={{ height: `${bar.height}%` }}
            type="button"
          >
            {/*
             * ISS-5566: no in-bar label here. The cost rail above the bars
             * (`SessionTimelineBarLabels`) owns every printed figure, and
             * `costUnmeasured` reaches it through `buildBucketBarLabels` — an
             * in-bar span would be clipped away by this button's
             * `overflow: hidden` anyway (see the rail's own note).
             */}
            {renderBarStack({
              cost,
              costUnmeasured,
              segments: stacks?.[index] ?? null,
              stackedBucket: bucket,
            })}
          </button>
        );
      })}
    </div>
  );
}

/**
 * ISS-5819: the coloured stack inside one bar.
 *
 * Two shapes, and the split is deliberate. Without `segments` this renders the
 * three hardcoded `<i className="cb-*">` elements exactly as before — same
 * elements, same order, same classes — so the ungated strip's DOM is unchanged.
 * With `segments` it paints whatever the "Group by" control resolved, taking the
 * colour from the segment rather than from a class, because model names and
 * phase keys are open sets and cannot each have a stylesheet rule.
 *
 * `costUnmeasured` suppresses BOTH shapes: a synthesized bucket's split is three
 * fixed ratios identical on every bar, and re-cutting an invented split by model
 * or phase would dress a guess up as a finer measurement.
 */
function renderBarStack({
  cost,
  costUnmeasured,
  segments,
  stackedBucket,
}: {
  cost: number;
  costUnmeasured: boolean;
  segments: readonly TimelineStackSegment[] | null;
  stackedBucket: ActivityBucket;
}) {
  if (cost <= 0 || costUnmeasured) {
    return null;
  }
  if (segments) {
    return segments.map((segment) => (
      <i
        key={segment.key}
        style={{
          background: segment.colorVar,
          height: `${(segment.value / cost) * 100}%`,
        }}
      />
    ));
  }
  return (
    <>
      <i
        className="cb-cache"
        style={{ height: `${(stackedBucket.cCache / cost) * 100}%` }}
      />
      <i
        className="cb-out"
        style={{ height: `${(stackedBucket.cOut / cost) * 100}%` }}
      />
      <i
        className="cb-in"
        style={{ height: `${(stackedBucket.cIn / cost) * 100}%` }}
      />
    </>
  );
}
