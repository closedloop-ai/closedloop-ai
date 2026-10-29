"use client";

import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import {
  type DotColor,
  getDotJumpRow,
  getDotLabel,
} from "@repo/app/agents/components/detail/activity-dot-rendering";
import type { ActivityMarker } from "@repo/app/agents/components/detail/session-timeline-axis";
import type {
  TimelineStackGrouping,
  TimelineStackSegment,
} from "@repo/app/agents/lib/session-timeline-stacks";
import {
  formatBucketTooltipTotal,
  type getBucketJumpBlock,
} from "./activity-bucket-rendering";
import { ActivityBucketTooltip } from "./activity-bucket-tooltip";
import { SessionTimelineMarkSwatch } from "./session-timeline-mark-swatch";
import {
  type TooltipAnchor,
  useViewportTooltipStyle,
  ViewportTooltipPortal,
} from "./viewport-tooltip";

/**
 * ISS-5819 — the Session Timeline strip's own small parts.
 *
 * A SIBLING module rather than more lines in `agent-session-detail-view.tsx`
 * (AGENTS.md -> "File Size and Organization"): the ISS-5819 additions had to land
 * somewhere, and "somewhere" is a module that owns them.
 *
 * The seam is a real one, not a line count picked at random. Everything here is
 * PRESENTATIONAL and stateless — it takes the strip's already-resolved hover
 * state and already-resolved stacks and renders them, holding no session, no
 * flag read and no derivation of its own. The view keeps what only it can own:
 * the state, the memos, and the decision of WHICH column the reader is pointing
 * at. The three hover types move with the components that consume them, so the
 * shape of a hover is declared beside the card that reads it.
 */

/** A marker as the dot rail carries it: everything but its plotted position. */
export type TimelineDotEvent = Omit<ActivityMarker, "x">;

export type HoverBucket = {
  anchor: TooltipAnchor;
  index: number;
};

export type HoverDot = {
  anchor: TooltipAnchor;
  bucketIndex: number;
  color: DotColor;
};

export function EventDotTooltip({
  anchor,
  color,
  events,
}: Readonly<{
  anchor: TooltipAnchor;
  color: DotColor;
  events: TimelineDotEvent[];
}>) {
  const { placement, ref, style } = useViewportTooltipStyle(anchor);
  return (
    <ViewportTooltipPortal>
      <div
        className="sd3-tip sd3-tip-mk"
        data-placement={placement}
        ref={ref}
        style={style}
      >
        <div className="sd3-tip-mkhead">
          <span className="sd3-tip-mklabel">
            <SessionTimelineMarkSwatch
              className="sd3-tip-swatch"
              color={color}
            />
            <span className="sd3-tip-mklabel-text">{getDotLabel(color)}</span>
          </span>
          {events.length > 1 ? (
            <span className="sd3-tip-mktime">{events.length} events</span>
          ) : null}
        </div>
        <div className="sd3-tip-list">
          {events.map((event) => (
            <div
              className="sd3-tip-li"
              key={`${event.kind}-${event.t}-${event.tl}`}
            >
              <span className="sd3-tip-lt mono">{event.t}</span>
              <span className="sd3-tip-lk">{event.kind}</span>
              <span className="sd3-tip-ll">{event.label}</span>
            </div>
          ))}
        </div>
        {getDotJumpRow(events) === null ? null : (
          <div className="sd3-tip-meta">
            click the dot to jump to {events.length > 1 ? "the first" : "this"}{" "}
            in the trace
          </div>
        )}
      </div>
    </ViewportTooltipPortal>
  );
}

/**
 * The strip's two hover cards, which are mutually exclusive.
 *
 * The exclusivity rule — a dot hover WINS over the bar hover beneath it, since
 * the reader is pointing at the dot — is a real rule that deserves to be stated
 * in one place rather than spelled out across two sibling ternaries.
 */
export function SessionTimelineHoverCards({
  block,
  costsUnpublished,
  costUnmeasured,
  grouping,
  hoverBucket,
  hoverDot,
  hoveredBucket,
  hoveredEvents,
  intervalUnmeasured = false,
  segments,
}: Readonly<{
  block: ReturnType<typeof getBucketJumpBlock>;
  /**
   * ISS-5632: whether the strip may publish a dollar figure at all — the same
   * answer the bar rail gets, so the card cannot quote money the rail withheld.
   */
  costsUnpublished: boolean;
  costUnmeasured: boolean;
  /**
   * ISS-5850: `true` when the hovered column lies outside the extent the
   * producer actually measured, so the card must not answer with the idle line.
   * Resolved by the caller from `ProjectedTimeline.columnCoverage` and the
   * disclosure flag; defaults to `false` so an unwired caller keeps today's
   * card.
   */
  intervalUnmeasured?: boolean;
  /**
   * The active "Group by" cut and this column's segments, so the card describes
   * the stack the reader is actually looking at. `undefined` when ungated, and
   * the card prints the per-model table it always printed.
   */
  grouping?: TimelineStackGrouping;
  hoverBucket: HoverBucket | null;
  hoverDot: HoverDot | null;
  hoveredBucket: ActivityBucket | null;
  hoveredEvents: TimelineDotEvent[] | null | undefined;
  segments?: readonly TimelineStackSegment[];
}>) {
  if (hoverDot) {
    return hoveredEvents && hoveredEvents.length > 0 ? (
      <EventDotTooltip
        anchor={hoverDot.anchor}
        color={hoverDot.color}
        events={hoveredEvents}
      />
    ) : null;
  }
  if (hoverBucket && hoveredBucket) {
    return (
      <ActivityBucketTooltip
        anchor={hoverBucket.anchor}
        block={block}
        bucket={hoveredBucket}
        costsUnpublished={costsUnpublished}
        costUnmeasured={costUnmeasured}
        grouping={grouping}
        intervalUnmeasured={intervalUnmeasured}
        segments={segments}
      />
    );
  }
  return null;
}

/**
 * Append each column's stack breakdown to its spoken cost fragment.
 *
 * Returns the input untouched when there is no grouping, so the names are the
 * ones that shipped. A column with no priced segments is left alone rather than
 * given an empty trailing clause.
 *
 * ISS-5632: `costsUnpublished` drops the per-segment FIGURE and keeps the
 * label. Without it this function re-published exactly what its own caller had
 * just withheld — `buildBucketAccessibleCosts` returns `null` for every bucket
 * on a floor-priced strip, and the `cost == null` branch below then returned the
 * breakdown as the whole fragment, so a screen-reader user heard
 * "claude-opus-4 $0.0013" off a bar whose rail, hover card and Properties Cost
 * row all showed nothing. That is the ISS-5563 defect surviving in the one place
 * it is least likely to be noticed.
 *
 * The LABELS stay while the stack is still PAINTED, because there they are not
 * the fabricated part. ISS-5819 folded them in so the "Group by" cut — conveyed
 * to a sighted reader by colour alone — is perceivable without sight (WCAG
 * 1.4.1). Which models or phases a bucket contains is observed; only the money
 * apportioned to them is invented, so dropping the whole clause there would
 * trade an accessibility regression for a correctness fix rather than just
 * making the name honest.
 *
 * ISS-5632 (#5146 review, whitlockk): `costUnmeasured` is where that argument stops
 * holding, so it drops the clause outright. On the flag-on strip the stack is
 * HATCHED rather than cut into coloured segments, and the disclosure says the
 * cost was not recorded — there is no colour-to-label mapping left for the name
 * to carry. Worse, the default Token Type segments on a floor-priced strip are
 * the fixed 69/23/8 synthesis, so their very CATEGORIES are invented, not just
 * their amounts: naming them would put a certainty in the accessibility tree
 * that the screen beside it has already withdrawn.
 */
export function withStackBreakdown(
  costs: (string | null)[],
  stacks: TimelineStackSegment[][] | null,
  provenance: Readonly<{
    costsUnpublished?: boolean;
    costUnmeasured?: boolean;
  }> = {}
): (string | null)[] {
  const { costsUnpublished = false, costUnmeasured = false } = provenance;
  if (!stacks || costUnmeasured) {
    return costs;
  }
  return costs.map((cost, index) => {
    const segments = stacks[index];
    if (!segments || segments.length === 0) {
      return cost;
    }
    const breakdown = segments
      .map((segment) =>
        costsUnpublished
          ? segment.label
          : `${segment.label} ${formatBucketTooltipTotal(segment.value)}`
      )
      .join(", ");
    return cost == null ? breakdown : `${cost}, ${breakdown}`;
  });
}
