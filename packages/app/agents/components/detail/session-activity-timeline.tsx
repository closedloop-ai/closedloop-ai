"use client";

import type {
  ActivityBucket,
  SessionSpan,
} from "@repo/api/src/types/agent-session";
import {
  getBucketCost,
  getBucketJumpBlock,
  getUnreadFromIndex,
} from "@repo/app/agents/components/detail/activity-bucket-rendering";
import {
  buildBucketAccessibleCosts,
  buildBucketBarLabels,
  getPeakBucketIndex,
  SessionTimelineBarLabels,
} from "@repo/app/agents/components/detail/session-timeline-bar-labels";
import { SessionTimelineBars } from "@repo/app/agents/components/detail/session-timeline-bars";
import {
  SessionTimelineControls,
  SessionTimelineScrubber,
} from "@repo/app/agents/components/detail/session-timeline-controls";
import { SessionTimelineDotRail } from "@repo/app/agents/components/detail/session-timeline-dot-rail";
import {
  SessionTimelineHeading,
  SessionTimelineRegion,
} from "@repo/app/agents/components/detail/session-timeline-header";
import { SessionTimelineLegend } from "@repo/app/agents/components/detail/session-timeline-legend";
import type { SessionTimelineSummarySession } from "@repo/app/agents/components/detail/session-timeline-summary";
import type { TimelinePeakBucket } from "@repo/app/agents/components/detail/timeline-peak-bucket-fact";
import {
  type SessionTimelineScaleState,
  useSessionTimelineScale,
} from "@repo/app/agents/hooks/use-session-timeline-scale";
import {
  TimelineColumnCoverage,
  type TimelineSourceExtent,
} from "@repo/app/agents/lib/session-timeline-projection";
import type { TraceScrollOutcome } from "@repo/app/agents/lib/trace-scroll-target";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { SESSION_TIMELINE_SOURCE_EXTENT_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  TRACE_EVENTS_TRUNCATED_CAPTION,
  TRACE_TOO_MANY_EVENTS_TO_PLOT,
  TRACE_UNREAD_TAIL_LEGEND,
} from "@repo/app/shared/lib/trace-truncation-copy";
import { useMemo, useState } from "react";
import {
  type ActivityMarker,
  SessionTimelineAxis,
} from "./session-timeline-axis";
import { buildDotCells } from "./session-timeline-dot-cells";
import {
  type HoverBucket,
  type HoverDot,
  SessionTimelineHoverCards,
  withStackBreakdown,
} from "./session-timeline-strip-parts";

export function SessionActivityTimeline({
  activeRow,
  activeRowMs,
  axisDurationLabel,
  barCostsUnpublished,
  buckets,
  costUnmeasured = false,
  legendId,
  disabled = false,
  eventsTruncated,
  isRowInReadTranscript,
  limitDotEvents,
  markers,
  onJump,
  ownerLabel,
  sourceExtent,
  sourceWindow,
  span,
  summarySession,
}: Readonly<{
  activeRow: number | null;
  /** ISS-7115: the instant of {@link activeRow} — see `useSessionTimelineScale`. */
  activeRowMs: number | null;
  /**
   * ISS-4684: the axis total in the same `Hh Mm` unit system as the "Activity
   * phases" caption below it, so the two totals visibly reconcile.
   */
  axisDurationLabel: string;
  /**
   * ISS-5566 × ISS-5563, resolved by the PARENT so the caller can render the
   * disclosure legend outside the pinned header (see the call site). Every
   * figure-bearing element on the strip reads this one answer.
   */
  barCostsUnpublished: boolean;
  buckets: ActivityBucket[];
  /**
   * ISS-5566: `true` when this strip's per-bucket money was synthesized AND the
   * disclosure flag is on, so the strip withdraws every figure it cannot back.
   * Resolved by the caller alongside {@link barCostsUnpublished} — see
   * `resolveTimelineCostDisclosure`. Defaults to `false`: a caller that cannot
   * answer the question must not have the strip claim a fabrication it has not
   * established.
   */
  costUnmeasured?: boolean;
  /**
   * ISS-7427 AC5: the id of the caption line rendered BELOW the pinned box, so
   * the region can be described by the sentence that withdraws part of its
   * claim. Resolved by the caller, which owns that caption (FEA-4025).
   */
  legendId?: string;
  /**
   * FEA-4252: `true` while the trace is still a skeleton (no rendered
   * `[data-row]` to scroll to). Disables the bar/dot jump controls so they stop
   * promising navigation they cannot perform yet.
   */
  disabled?: boolean;
  /*
   * ISS-5075 (stage review): the bars and the dot rail are plotted from the
   * session's `turnItems`/`events`, which the detail read serves as a
   * chronological PREFIX once it hits its row ceiling. The axis still measures
   * the whole run, so the strip's empty tail would otherwise read as "nothing
   * happened" instead of "we stopped reading". The tail past the last plotted
   * bucket carries its own treatment ({@link UNREAD_BAR_STYLE}) — a caption
   * cannot undo what the eye has already read off the strip.
   */
  eventsTruncated?: true;
  /**
   * ISS-5479 review: whether a timeline row has a counterpart in the transcript
   * actually rendered. The affordance follows THIS, not `tl0` alone — a bar can
   * carry a jump row that resolves nowhere (most root-timeline bars do on a
   * `subagent:{id}` view) and it must not keep advertising a jump.
   */
  isRowInReadTranscript: (row: number) => boolean;
  limitDotEvents: ActivityMarker[];
  markers: ActivityMarker[];
  /**
   * ISS-5479: accepts `null` so an idle bar/dot (no jump row) reports "nothing
   * to scroll to" on the one outcome path instead of being dropped by a guard
   * here and reading as a dead control.
   */
  onJump: (
    row: number | null,
    flash?: boolean,
    missingRowOutcome?: TraceScrollOutcome
  ) => void;
  /** ISS-5819: the "Session Owner" grouping's one segment label. */
  ownerLabel: string;
  /**
   * ISS-5819: the wall-clock span `buckets` uniformly tiles, which is what makes
   * them re-projectable onto a clock window. `null` when no window resolved, and
   * the strip then renders the bars exactly as given.
   */
  sourceWindow: { endMs: number; startMs: number } | null;
  /**
   * ISS-5850: the extent the producer's bins actually TILE — a different clock
   * from {@link sourceWindow}, which is the one the reader is shown. `null` when
   * the producer stated none, and every column's coverage is then `Unknown`
   * rather than assumed.
   */
  sourceExtent: TimelineSourceExtent | null;
  span: SessionSpan;
  /**
   * ISS-5970: the session the run-level cost/tokens/duration summary reads.
   * Passed in whole rather than as three pre-formatted strings so the strip can
   * run the SAME canonical derivations the Properties rows run — pre-formatting
   * it here would put a second answer on the page, which is the failure the
   * ticket is about.
   */
  summarySession: SessionTimelineSummarySession;
}>) {
  const [hoverBucket, setHoverBucket] = useState<HoverBucket | null>(null);
  const [hoverDot, setHoverDot] = useState<HoverDot | null>(null);
  const timelineScale = useSessionTimelineScale({
    activeRow,
    activeRowMs,
    buckets,
    limitDotEvents,
    markers,
    ownerLabel,
    sourceExtent,
    sourceWindow,
  });
  /*
   * ISS-5850, `…Optional` for the same reason the sibling disclosure above is:
   * this strip also renders in Storybook and in tests, which mount no flag
   * provider.
   *
   * The COVERAGE is resolved unconditionally by the hook — it is inert data —
   * and only its DISCLOSURE is gated here, in one place, so the tooltip and the
   * accessible names cannot end up disagreeing about whether a column is
   * withheld. Flag off, and `columnCoverage` is `undefined` everywhere
   * downstream, which is exactly the pre-ISS-5850 render.
   */
  const sourceExtentDisclosureEnabled = useFeatureFlagEnabledOptional(
    SESSION_TIMELINE_SOURCE_EXTENT_FEATURE_FLAG_KEY
  );
  const columnCoverage = sourceExtentDisclosureEnabled
    ? timelineScale.columnCoverage
    : undefined;
  // ONE name each, resolved once inside the hook: the bars, the label rail, the
  // dot rail, the tooltip and the "you are here" marker must all be plotted over
  // the SAME columns, or the strip disagrees with itself the moment the window
  // moves.
  const { columnLimitDots, columnMarkers, columns } = timelineScale;
  const maxCost = Math.max(0.01, ...columns.map(getBucketCost));
  const cells = buildDotCells(columnMarkers, columnLimitDots, columns.length);
  const hoverIndex = hoverBucket?.index ?? null;
  const hoveredBucket = hoverBucket == null ? null : columns[hoverBucket.index];
  const hoveredEvents =
    hoverDot == null ? null : cells[hoverDot.bucketIndex]?.[hoverDot.color];
  const hoveredSegments =
    hoverIndex == null ? undefined : timelineScale.stacks?.[hoverIndex];
  // Memoized: `toRendered` walks the turn-item projections, and a strip can hold
  // 48 bars — recomputing per bar per render would be quadratic on a long session.
  const jumpBlocks = useMemo(
    () =>
      columns.map((bucket) =>
        getBucketJumpBlock(bucket, isRowInReadTranscript)
      ),
    [columns, isRowInReadTranscript]
  );
  const unreadFromIndex = getUnreadFromIndex(columns, eventsTruncated === true);
  const barLabels = buildBucketBarLabels({
    buckets: columns,
    costsSynthesized: barCostsUnpublished,
    maxCost,
    unreadFromIndex,
  });
  // ISS-5761: the spoken cost, which is NOT the printed one — the rail prints
  // only prominent buckets and only when the columns are wide enough, while the
  // name carries every priced bucket unconditionally.
  /*
   * ISS-5819: the "Group by" cut is otherwise conveyed by COLOUR ALONE — the
   * stack segments carry no text and no class. Folding each column's segment
   * labels into the button's accessible name is what makes changing the
   * grouping perceivable without sight (WCAG 1.4.1); the hover card carries the
   * same breakdown for a sighted reader.
   *
   * ISS-5632: both provenance answers, because they govern the clause
   * differently — `costsUnpublished` drops the per-segment FIGURE, while
   * `costUnmeasured` drops the clause entirely, the state where the stack is
   * hatched and there is no colour cut left to name.
   */
  const barAccessibleCosts = withStackBreakdown(
    buildBucketAccessibleCosts({
      buckets: columns,
      columnCoverage,
      costsSynthesized: barCostsUnpublished,
    }),
    timelineScale.stacks,
    { costUnmeasured, costsUnpublished: barCostsUnpublished }
  );
  /*
   * ISS-5819: the "you are here" marker reads the ONE position model the hook
   * holds — the same number the scrubber thumb sits on — rather than deriving
   * its own. When no source window resolves, that model falls back to
   * `getRowPercent` over the caller's own bars.
   *
   * `.tl-here` is shared with the Branch PR activity timeline
   * (`packages/app/branches/components/branch-pr-activity-timeline.tsx`), which
   * computes its own left offset and is untouched by this: nothing here changes
   * the class, the stylesheet, or that component.
   */
  const herePercent = timelineScale.herePercent;
  const peakBucket = resolvePeakBucket(timelineScale, barCostsUnpublished);

  if (buckets.length === 0) {
    return (
      <SessionTimelineRegion describedById={legendId}>
        <div className="sd3-actbar">
          <SessionTimelineHeading
            peakBucket={peakBucket}
            summarySession={summarySession}
          />
          <p className="text-muted-foreground text-sm">
            {eventsTruncated
              ? TRACE_TOO_MANY_EVENTS_TO_PLOT
              : "No activity recorded for this session."}
          </p>
        </div>
      </SessionTimelineRegion>
    );
  }

  return (
    <SessionTimelineRegion describedById={legendId}>
      <div className="sd3-actbar">
        <SessionTimelineHeading
          peakBucket={peakBucket}
          summarySession={summarySession}
        />
        {timelineScale.controls ? (
          <SessionTimelineControls
            grouping={timelineScale.controls.grouping}
            onGroupingChange={timelineScale.controls.setGrouping}
            onScaleChange={timelineScale.controls.setScale}
            scale={timelineScale.controls.scale}
            subColumnSource={timelineScale.subColumnSource}
          />
        ) : null}
        <SessionTimelineLegend
          buckets={columns}
          cells={cells}
          costUnmeasured={costUnmeasured}
          stacks={timelineScale.stacks}
        />
        <div className="sd3-bars2-wrap">
          {herePercent == null ? null : (
            <div
              aria-hidden
              className="tl-here"
              style={{ left: `${herePercent}%` }}
            />
          )}
          <SessionTimelineBarLabels
            labels={barLabels}
            peakIndex={getPeakBucketIndex(columns)}
          />
          <SessionTimelineBars
            accessibleCosts={barAccessibleCosts}
            buckets={columns}
            columnCoverage={columnCoverage}
            costUnmeasured={costUnmeasured}
            disabled={disabled}
            hoverIndex={hoverIndex}
            jumpBlocks={jumpBlocks}
            maxCost={maxCost}
            onHover={setHoverBucket}
            onJump={onJump}
            stacks={timelineScale.stacks}
            unreadFromIndex={unreadFromIndex}
          />

          <SessionTimelineDotRail
            buckets={columns}
            cells={cells}
            disabled={disabled}
            hoverDot={hoverDot}
            onHoverDot={setHoverDot}
            onJump={onJump}
          />

          <SessionTimelineHoverCards
            block={hoverIndex == null ? null : (jumpBlocks[hoverIndex] ?? null)}
            costsUnpublished={barCostsUnpublished}
            costUnmeasured={costUnmeasured}
            grouping={timelineScale.controls?.grouping}
            hoverBucket={hoverBucket}
            hoverDot={hoverDot}
            hoveredBucket={hoveredBucket}
            hoveredEvents={hoveredEvents}
            intervalUnmeasured={
              hoverIndex != null &&
              columnCoverage?.[hoverIndex] === TimelineColumnCoverage.Unmeasured
            }
            segments={hoveredSegments}
          />
        </div>
        {/*
          ISS-5819: when the strip is showing a WINDOW smaller than the session,
          the axis names that window's two edges, not the session's. Session-wide
          ticks under a windowed chart would put an end time on the right that the
          rightmost bar is nowhere near — the axis would be describing a chart
          that is not on screen. Unwindowed (`maxWindowStart === 0`, which is
          every session that fits, and every flag-off render) the window IS the
          session and both branches print the same thing.
        */}
        {/* The TICKS follow the window; the duration caption between them does
            NOT (#4753). It measures the run, and a window is a viewport — see
            `getWindowedAxis`. */}
        <SessionTimelineAxis
          axisDurationLabel={axisDurationLabel}
          span={timelineScale.windowedAxis?.span ?? span}
        />
        {timelineScale.scrubber ? (
          <SessionTimelineScrubber
            onPositionChange={timelineScale.scrubber.onPositionChange}
            position={timelineScale.scrubber.position}
            totalColumns={timelineScale.scrubber.totalColumns}
          />
        ) : null}
        {/* ISS-5566 design review: `mb-1` on THIS caption rather than a wrapper
          around both. A synthesized strip can also be truncated, and the two
          captions would otherwise sit flush and read as one run-on block. The
          margin lives on the flag-gated element so the flag-off DOM is
          unchanged. */}
        {/* ISS-5566 × FEA-4025: the synthesized-cost legend is NOT rendered here.
          This strip mounts inside `.sd3-stickyhead`, which FEA-4025 pins and
          holds to "only the identity row + the Session Timeline, small by
          construction" so it can never blanket the transcript. Measured on a
          600px viewport, this one caption line took the pinned header to 281px
          against a 267.5px budget (half the scroll pane). The caption is
          explanatory prose rather than orientation data, so the CALLER renders
          it just below the pinned box — see the `costUnmeasured` legend at the
          `SessionActivityTimeline` call site. It cannot be hidden by CSS here:
          `is-sticky` is static markup, not a scroll state, so a
          `.is-sticky` rule would withhold it always. */}
        {eventsTruncated ? (
          <p className="text-muted-foreground text-xs">
            {/*
             * Against `columns`, NOT `buckets`: the shading is applied over the
             * PROJECTED strip (`index >= unreadFromIndex` in the bar row and the
             * label rail), and `unreadFromIndex` is derived from `columns` too.
             * Comparing against the pre-projection `buckets.length` made any
             * projection that shrinks the column count (40 source bins onto 24
             * columns) satisfy the test unconditionally, so the strip promised a
             * shaded tail it had rendered none of.
             */}
            {unreadFromIndex < columns.length
              ? TRACE_UNREAD_TAIL_LEGEND
              : TRACE_EVENTS_TRUNCATED_CAPTION}
          </p>
        ) : null}
      </div>
    </SessionTimelineRegion>
  );
}

/**
 * ISS-12665: the peak publishes a figure exactly when the bars do — the same
 * `barCostsUnpublished` answer — and is drawn only when there is a scale to
 * name its interval by.
 */
function resolvePeakBucket(
  timelineScale: SessionTimelineScaleState,
  barCostsUnpublished: boolean
): TimelinePeakBucket | null {
  if (timelineScale.controls == null) {
    return null;
  }
  return {
    costUsd: barCostsUnpublished ? null : timelineScale.peakColumnCost,
    scale: timelineScale.controls.scale,
  };
}
