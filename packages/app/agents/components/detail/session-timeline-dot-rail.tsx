"use client";

import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import { TraceScrollOutcome } from "@repo/app/agents/lib/trace-scroll-target";
import {
  TimelineMarkerRail,
  TimelineMarkerTrigger,
} from "@repo/app/shared/components/timeline-marker-rail";
import { cn } from "@repo/design-system/lib/utils";
import { getBucketKey } from "./activity-bucket-rendering";
import {
  type DotColor,
  getDotButtonLabel,
  getDotJumpRow,
  getDotShape,
  getDotShapeClassName,
} from "./activity-dot-rendering";
import type { ActivityMarker } from "./session-timeline-axis";
import {
  getTimelineTooltipAnchor,
  type TooltipAnchor,
} from "./viewport-tooltip";

/**
 * The Session Timeline's DOT RAIL — `.sd3-drail` and the one control per
 * marker lane per column inside it.
 *
 * Extracted from `agent-session-detail-view.tsx` (ISS-5819) for the same reason
 * ISS-5761 extracted the bar row: the rail is the last inline piece of a strip whose
 * bars, cost rail and tooltips are already their own units. Pulling it out also
 * took the strip's cognitive complexity back under the lint ceiling, which the
 * timeline controls had pushed it over.
 *
 * Presentational only, and DOM-identical to what the view rendered inline: same
 * elements, same class lists in the same order, same handlers, same guards.
 */
export function SessionTimelineDotRail({
  buckets,
  cells,
  disabled,
  hoverDot,
  onHoverDot,
  onJump,
}: Readonly<{
  buckets: readonly ActivityBucket[];
  cells: readonly Record<DotColor, Omit<ActivityMarker, "x">[]>[];
  disabled: boolean;
  hoverDot: { bucketIndex: number; color: DotColor } | null;
  onHoverDot: (
    hover: {
      anchor: TooltipAnchor;
      bucketIndex: number;
      color: DotColor;
    } | null
  ) => void;
  onJump: (
    row: number | null,
    flash?: boolean,
    missingRowOutcome?: TraceScrollOutcome
  ) => void;
}>) {
  return (
    <TimelineMarkerRail
      className="sd3-drail"
      columns={cells.map((cell, bucketIndex) => ({
        id: `dots-${getBucketKey(buckets[bucketIndex], bucketIndex)}`,
        markers: DOT_ORDER.flatMap((color) =>
          cell[color].length > 0
            ? [
                {
                  bucketIndex,
                  color,
                  dotRow: getDotJumpRow(cell[color]),
                },
              ]
            : []
        ),
      }))}
      layout="bucketed"
      renderColumn={(column, children) => (
        <div className="sd3-dcell" key={column.id}>
          {children}
        </div>
      )}
      renderMarker={(marker) => (
        <TimelineDot
          bucketIndex={marker.bucketIndex}
          color={marker.color}
          disabled={disabled}
          // ISS-5479: a synced marker can deserialize without a row, and
          // ISS-7632 made `ActivityMarker.tl` optional so the type says so
          // (the wire type `SessionMarker.tl` stays required). Resolved by the
          // shared `getDotJumpRow`, so the label, the affordance, the click AND
          // the hover card all answer from the same value.
          dotRow={marker.dotRow}
          hot={
            hoverDot?.bucketIndex === marker.bucketIndex &&
            hoverDot.color === marker.color
          }
          key={marker.color}
          onHoverDot={onHoverDot}
          onJump={onJump}
        />
      )}
    />
  );
}

function TimelineDot({
  bucketIndex,
  color,
  disabled,
  dotRow,
  hot,
  onHoverDot,
  onJump,
}: Readonly<{
  bucketIndex: number;
  color: DotColor;
  disabled: boolean;
  dotRow: number | null;
  hot: boolean;
  onHoverDot: (
    hover: {
      anchor: TooltipAnchor;
      bucketIndex: number;
      color: DotColor;
    } | null
  ) => void;
  onJump: (
    row: number | null,
    flash?: boolean,
    missingRowOutcome?: TraceScrollOutcome
  ) => void;
}>) {
  const dotNoJump = dotRow == null;
  return (
    <TimelineMarkerTrigger
      ariaDisabled={dotNoJump}
      ariaLabel={getDotButtonLabel(color, dotNoJump)}
      className={cn(
        `sd3-dot d-${color}`,
        getDotShapeClassName(color),
        hot && "hot",
        dotNoJump && "no-jump"
      )}
      data-shape={getDotShape(color)}
      disabled={disabled}
      onClick={() => {
        // Never a silent `?? 0` jump to the top of the transcript, and never a
        // silent nothing either. `Unresolvable`, NOT the bar's `NoJumpTarget`:
        // this dot is on screen only because its lane holds events, so "nothing
        // recorded here" would deny the very activity the reader clicked.
        onJump(dotRow, true, TraceScrollOutcome.Unresolvable);
      }}
      onMouseEnter={(event) =>
        onHoverDot({
          anchor: getTimelineTooltipAnchor(event.currentTarget),
          bucketIndex,
          color,
        })
      }
      onMouseLeave={() => onHoverDot(null)}
    />
  );
}

const DOT_ORDER: DotColor[] = ["b", "g", "r"];
