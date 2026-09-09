import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import {
  getBarStyle,
  getBucketCost,
  isInteriorGap,
  UNREAD_BAR_STYLE,
} from "./activity-bucket-rendering";
import {
  buildBucketBarLabels,
  getPeakBucketIndex,
  SessionTimelineBarLabels,
} from "./session-timeline-bar-labels";

/**
 * ISS-5563 review (krisw-story-reviewer). `SessionTimelineBarLabels` exists
 * because the old label — a `position: absolute; top: -14px` span inside an
 * `overflow: hidden` bar — was clipped in BOTH axes and never rendered at all.
 * Its unit test says so in as many words: "that one is fixed in markup/CSS (the
 * rail) and is not assertable here." `buildBucketBarLabels`'s null/precision
 * decisions are covered there; what is NOT covered anywhere is the thing the
 * component was built for — that a label actually appears, over its own bar,
 * without being clipped.
 *
 * That is only checkable by looking, and only if the rail is rendered AGAINST
 * the bars: the rail's whole design is that it mirrors `.sd3-bars2`'s flex
 * geometry (one `flex: 1 1 0` cell per bucket, the same 2px gap) so each label
 * centers over its own bar with no absolute positioning. A story of the rail
 * alone would prove nothing about alignment, so {@link BarRailStage} reproduces
 * the bar row beneath it.
 *
 * The scenarios are the precision boundaries the component's own docstring
 * argues about — `$1.02` (~28px, the figure the old clip reduced to `1.0`),
 * `$0.0025` (~40px, the widest exact label), `~$1.1k` (the abbreviation that has
 * to announce itself) — plus the two cases where the rail deliberately says
 * NOTHING: the unread tail and a synthesized-cost strip.
 *
 * No `autodocs` tag: these stories are about horizontal geometry at a realistic
 * strip width, and the docs page renders each canvas narrower than the detail
 * panel it models, which is the one dimension that matters here.
 */
/*
 * No `component` on the meta: every story here renders the rail through
 * {@link BarRailStage}, which derives the labels from `buildBucketBarLabels`
 * rather than taking them as an arg — that derivation IS the behaviour the
 * blank-rail stories exist to show. Declaring the component would make
 * `StoryObj` demand a `labels` arg that nothing reads, so the stories would
 * carry a fabricated input beside the real one. The catalog maps this file by
 * its stem, not by this field.
 */
const meta = {
  title: "App Core/Agents/Timeline/Session Timeline Cost Rail",
  parameters: { layout: "padded" },
} satisfies Meta<typeof SessionTimelineBarLabels>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A bucket carrying `cost`, split across cache/out/in in the ~59/29/12
 * proportion a real priced bucket tends to land on. Only the total drives the
 * label; the split exists so the bars render their stacked segments and the
 * strip looks like the surface being modelled rather than a bar chart.
 */
function bucketAt(cost: number, index: number): ActivityBucket {
  const cCache = cost * 0.59;
  const cOut = cost * 0.29;
  return {
    label: `bucket ${index}`,
    cCache,
    cOut,
    cIn: cost - cCache - cOut,
    total: cost > 0 ? 12 : 0,
    toolStart: cost > 0 ? 3 : 0,
    tl0: cost > 0 ? index : null,
    byModel: {},
  };
}

/** The tight strip the pre-ISS-5761 precision stories were calibrated against. */
const STAGE_NARROW_WIDTH_PX = 560;

/**
 * The strip measured on the real session-detail panel at a 1440px window
 * (design review). The ISS-5761 density stories use this, because a stage
 * narrower than the product's own is calibrated to a width nobody sees and would
 * put the fit threshold in the wrong place.
 */
const STAGE_DETAIL_WIDTH_PX = 936;

/**
 * The rail over the bar row it labels, at the geometry the real detail uses:
 * `.sd3-bars2-wrap` wrapping the rail and `.sd3-bars2`, each bar sized by the
 * SAME `getBarStyle` decision `buildBucketBarLabels` consulted. Reproduced here
 * rather than mounting `AgentSessionDetailView` because the parent needs a whole
 * session fixture, a jump handler and hover state to render this strip at all —
 * and none of that is what these stories are about.
 *
 * Width is pinned to a realistic detail-panel measure. A bar is roughly 18px at
 * the producer's bucket target, which is precisely why the old in-bar label
 * could not hold an exact figure; a story stretched to an arbitrary canvas width
 * would give every label room the real surface does not have and prove nothing.
 */
function BarRailStage({
  buckets,
  caption,
  costsSynthesized = false,
  unreadFromIndex = Number.POSITIVE_INFINITY,
  widthPx = STAGE_NARROW_WIDTH_PX,
}: Readonly<{
  buckets: readonly ActivityBucket[];
  caption: ReactNode;
  costsSynthesized?: boolean;
  unreadFromIndex?: number;
  /**
   * ISS-5761 (design review): the stage width is now an INPUT, because the rail
   * measures itself and the width is therefore the whole variable under review.
   * {@link STAGE_DETAIL_WIDTH_PX} is the strip measured on the real detail panel
   * at a 1440px window; the narrower default is kept so the pre-existing
   * precision stories above still model the tight case they were written for.
   */
  widthPx?: number;
}>) {
  const maxCost = Math.max(...buckets.map(getBucketCost));
  const labels = buildBucketBarLabels({
    buckets,
    costsSynthesized,
    maxCost,
    unreadFromIndex,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <p style={{ fontSize: 13, margin: 0, maxWidth: "44rem", opacity: 0.75 }}>
        {caption}
      </p>
      <div className="sd3-actbar" style={{ maxWidth: widthPx }}>
        <div className="sd3-act-head">
          <span className="sd3-act-title">Session Timeline</span>
        </div>
        <div className="sd3-bars2-wrap">
          <SessionTimelineBarLabels
            labels={labels}
            peakIndex={getPeakBucketIndex(buckets)}
          />
          <div className="sd3-bars2">
            {buckets.map((bucket, index) => (
              <StageBar
                bucket={bucket}
                buckets={buckets}
                index={index}
                // Positional by construction, exactly as the rail is: cell N
                // belongs to bar N.
                // biome-ignore lint/suspicious/noArrayIndexKey: positional bar
                key={index}
                maxCost={maxCost}
                unread={index >= unreadFromIndex}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** One bar, drawn from the same style decision the rail consulted. */
function StageBar({
  bucket,
  buckets,
  index,
  maxCost,
  unread,
}: Readonly<{
  bucket: ActivityBucket;
  buckets: readonly ActivityBucket[];
  index: number;
  maxCost: number;
  unread: boolean;
}>) {
  if (unread) {
    return (
      <div
        aria-hidden
        className={`sd3-bar2 ${UNREAD_BAR_STYLE.barClass}`}
        style={{ height: `${UNREAD_BAR_STYLE.height}%` }}
      />
    );
  }

  const cost = getBucketCost(bucket);
  const bar = getBarStyle(cost, maxCost, isInteriorGap(index, buckets));

  return (
    <div
      aria-hidden
      className={`sd3-bar2 ${bar.barClass}`}
      style={{ height: `${bar.height}%` }}
    >
      {cost > 0 ? (
        <>
          <i
            className="cb-cache"
            style={{ height: `${(bucket.cCache / cost) * 100}%` }}
          />
          <i
            className="cb-out"
            style={{ height: `${(bucket.cOut / cost) * 100}%` }}
          />
          <i
            className="cb-in"
            style={{ height: `${(bucket.cIn / cost) * 100}%` }}
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * The reported figure, and the reason the rail exists. `$1.02` wants roughly
 * 28px against an ~18px bar, so inside the old `overflow: hidden` bar it was
 * clipped a glyph off each end and read `1.0` — worse than the `$1` rounding
 * ISS-5563 set out to replace, because a rounded number at least still looks
 * like a number. Here it should sit whole and centered over its bar, overflowing
 * its rail cell freely.
 */
export const MeasuredDollars: Story = {
  render: () => (
    <BarRailStage
      buckets={[1.02, 0.94, 0.21, 0, 0.78, 1.01, 0.34, 0.88].map(bucketAt)}
      caption="Measured dollars: $1.02 rendered whole and centered over its own bar. This is the figure the pre-rail clip reduced to `1.0`."
    />
  ),
};

/**
 * The other precision boundary: a genuinely sub-cent strip, where
 * `formatCostPrecise` widens to four decimals rather than flattening real money
 * to `$0.00` (ISS-4919). `$0.0025` is the widest exact label the rail has to
 * carry — about 40px over an ~18px bar — so if anything is going to collide with
 * a neighbour or get clipped, it is this.
 */
export const MeasuredSubCent: Story = {
  render: () => (
    <BarRailStage
      buckets={[0.0025, 0.0021, 0.0009, 0, 0.0018, 0.0024].map(bucketAt)}
      caption="Sub-cent strip: four decimals rather than a flattened $0.00. The widest exact label the rail carries — watch for collision with its neighbours."
    />
  ),
};

/**
 * Past `$1,000` the exact figure cannot fit even on the rail, so the label
 * abbreviates — but marks itself `~` so it reads as an approximation rather than
 * an exact figure, with the precise value one hover away in the bucket tooltip.
 * An abbreviation that announces itself is honest; the silent `$1109` the old
 * label produced was the bug.
 */
export const AbbreviatedThousands: Story = {
  render: () => (
    <BarRailStage
      buckets={[1108.86, 980.4, 1201.5, 0, 1044.2, 1150.75].map(bucketAt)}
      caption="Above $1,000 the label abbreviates and marks itself with `~`, so it reads as approximate rather than as a silently rounded exact figure."
    />
  ),
};

/**
 * A truncated read: the axis still spans the whole run, so the trailing buckets
 * are real TIME with no evidence either way. They draw as the full-height
 * `unread` wash — deliberately NOT the idle hatch, which would claim observed
 * quiet — and the rail prints nothing above them. A figure over an unread bar
 * would be a measurement of a stretch nobody read.
 */
export const UnreadTail: Story = {
  render: () => (
    <BarRailStage
      buckets={[1.02, 0.9, 0.44, 0.81, 0, 0, 0, 0].map(bucketAt)}
      caption="Unread tail: the last four buckets were never read, so they draw as the full-height wash and the rail stays blank above them."
      unreadFromIndex={4}
    />
  ),
};

/**
 * REGRESSION GUARD, and the subtlest of the five. When a session has no
 * persisted `activityBuckets` the strip is priced from
 * `Math.max(estimatedCost, 0.01)` — a floor that exists purely so the bars have
 * something to draw. On a session whose `estimatedCost` is 0, the whole strip is
 * that one-cent placeholder spread across the eventful buckets, so ISS-5563's
 * added precision would have published `$0.001`: four decimals of confidence on
 * a number nobody measured, one panel below a Properties Cost row rendering a
 * dash whose tooltip says "No token usage recorded to price".
 *
 * So the rail goes **entirely blank** while the bars still draw at their
 * placeholder heights — the floor keeps doing the one job it was added for, and
 * the strip stops publishing a figure it cannot stand behind. The test is
 * provenance, not magnitude: `MeasuredSubCent` above prints `$0.0025` because
 * that money was measured. If any label appears in this story, that distinction
 * has been lost.
 */
export const SynthesizedCosts: Story = {
  render: () => (
    <BarRailStage
      buckets={[0.004, 0.0035, 0.0012, 0, 0.0028, 0.0015].map(bucketAt)}
      caption="Synthesized costs: the bars still draw at their placeholder heights, but the rail publishes nothing. Compare with the sub-cent strip above, whose identical magnitudes ARE labelled because they were measured."
      costsSynthesized
    />
  ),
};

/*
 * ISS-5761 — the DENSITY regime, which is why the collision reached a user.
 *
 * Every story above models a short session: six to eight buckets, ~70px of room
 * each, where nothing can collide. That is not the shape the product produces.
 * `SESSION_TRACE_BUCKET_TARGET` is 40 and the desktop producer emits one bucket
 * per five minutes, so a session past ~3h20m pins the strip at 40 columns, and
 * the reported 3h35m session printed 37 figures into ~19px cells. They abutted
 * into one run and handed the reader `$724.0` — `$7` and `$24.0` touching, a
 * number no bucket holds.
 *
 * These four exercise that regime at the MEASURED detail width, so the rail's
 * self-measurement is being judged against the geometry the product actually has.
 */

/** 40 five-minute buckets, all priced above the 16%-of-peak label threshold. */
function denseBuckets(count: number): ActivityBucket[] {
  return Array.from({ length: count }, (_, index) =>
    bucketAt(8.55 + (index % 7) * 3.2, index)
  );
}

/**
 * The reported strip. Thirty-seven priced buckets on a real detail panel: no
 * label fits, so the rail keeps the single most expensive figure and drops the
 * rest. That one label is unambiguous by construction — the tallest bar is its
 * own pointer — and every other bucket's cost stays on its bar button's
 * accessible name and in its hover card.
 */
export const DenseReportedSession: Story = {
  render: () => (
    <BarRailStage
      buckets={denseBuckets(37)}
      caption="37 priced buckets (a 3h05m session) at the real detail width. Before ISS-5761 this rail printed $8.55$15.3$20.20 … $724.0 in one unreadable run; now it prints the peak alone."
      widthPx={STAGE_DETAIL_WIDTH_PX}
    />
  ),
};

/**
 * The producer's ceiling, which every session past ~3h20m lands on. Same
 * behaviour as the reported case, one column tighter, so a fix keyed off the cap
 * itself rather than off the width would show a difference here.
 */
export const DenseBucketCeiling: Story = {
  render: () => (
    <BarRailStage
      buckets={denseBuckets(40)}
      caption="40 buckets — the producer's cap. The rail keeps the peak and nothing else."
      widthPx={STAGE_DETAIL_WIDTH_PX}
    />
  ),
};

/**
 * The case the fit rule is proudest of, and the one that would have hidden
 * finding after finding if it were missing: 40 columns, but only three buckets
 * clear `getBarStyle`'s cost threshold, so each printed label has a dozen blank
 * cells beside it and the rail prints ALL of them. Density is what constrains
 * this rail, not column count — and this is where a mis-centred label points at
 * the wrong bar, so it is the story to look at when touching the rail's CSS.
 */
export const SparseSpikesAtCeiling: Story = {
  render: () => (
    <BarRailStage
      buckets={Array.from({ length: 40 }, (_, index) =>
        bucketAt(index % 13 === 0 ? 27.75 : 1.2, index)
      )}
      caption="40 columns, three spikes. Every printed label has room, so all three print — each one centred over its own bar, not its neighbour's."
      widthPx={STAGE_DETAIL_WIDTH_PX}
    />
  ),
};

/**
 * Where the rail switches over. On a 936px panel a five-character figure stops
 * fitting at roughly 25 columns — about a two-hour session — so this is the
 * story to check when changing the rail's type scale, its gutter, or the width
 * model in `session-timeline-bar-label-fit.ts`.
 */
export const DensityThreshold: Story = {
  render: () => (
    <BarRailStage
      buckets={denseBuckets(25)}
      caption="25 priced buckets — the width at which a full rail stops fitting on a real detail panel."
      widthPx={STAGE_DETAIL_WIDTH_PX}
    />
  ),
};
