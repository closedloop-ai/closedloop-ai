"use client";

import type {
  ActivityBucket,
  SyncedActivitySegmentRow,
} from "@repo/api/src/types/agent-session";
import {
  type DotColor,
  getDotColorToken,
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
import {
  type TooltipAnchor,
  useViewportTooltipStyle,
  ViewportTooltipPortal,
} from "./viewport-tooltip";

/**
 * ISS-5819 — the Session Timeline strip's own small parts.
 *
 * A SIBLING module rather than more lines in `agent-session-detail-view.tsx`,
 * which is one of the grandfathered over-size files and therefore shrink-only
 * (AGENTS.md -> "File Size and Organization"): the ISS-5819 additions had to land
 * somewhere, and "somewhere" cannot be a file already past the ceiling.
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

/**
 * Stable empty tiling for a session that carries none, so the strip's projection
 * memo does not see a fresh array identity on every render.
 */
export const EMPTY_SEGMENT_ROWS: readonly SyncedActivitySegmentRow[] = [];

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
            <span
              aria-hidden
              className="sd3-tip-swatch"
              style={{ background: getDotColorToken(color) }}
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
        <div className="sd3-tip-meta">
          click the dot to jump to {events.length > 1 ? "the first" : "this"} in
          the trace
        </div>
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
  costUnmeasured,
  grouping,
  hoverBucket,
  hoverDot,
  hoveredBucket,
  hoveredEvents,
  segments,
}: Readonly<{
  block: ReturnType<typeof getBucketJumpBlock>;
  costUnmeasured: boolean;
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
        costUnmeasured={costUnmeasured}
        grouping={grouping}
        segments={segments}
      />
    );
  }
  return null;
}

/**
 * Append each column's stack breakdown to its spoken cost fragment.
 *
 * Returns the input untouched when there is no grouping (ungated), so the
 * flag-off accessible names are the ones that shipped. A column with no priced
 * segments is left alone rather than given an empty trailing clause.
 */
export function withStackBreakdown(
  costs: (string | null)[],
  stacks: TimelineStackSegment[][] | null
): (string | null)[] {
  if (!stacks) {
    return costs;
  }
  return costs.map((cost, index) => {
    const segments = stacks[index];
    if (!segments || segments.length === 0) {
      return cost;
    }
    const breakdown = segments
      .map(
        (segment) =>
          `${segment.label} ${formatBucketTooltipTotal(segment.value)}`
      )
      .join(", ");
    return cost == null ? breakdown : `${cost}, ${breakdown}`;
  });
}
