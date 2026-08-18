"use client";

import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import { TraceScrollOutcome } from "@repo/app/agents/lib/trace-scroll-target";
import { cn } from "@repo/design-system/lib/utils";
import { getBucketKey } from "./activity-bucket-rendering";
import { type DotColor, getDotButtonLabel } from "./activity-dot-rendering";
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
 * ISS-5761 extracted the bar row: that file is grandfathered shrink-only under
 * the file-size ceiling, and the rail is the last inline piece of a strip whose
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
    <div className="sd3-drail">
      {cells.map((cell, bucketIndex) => (
        <div
          className="sd3-dcell"
          key={`dots-${getBucketKey(buckets[bucketIndex], bucketIndex)}`}
        >
          {DOT_ORDER.map((color) =>
            cell[color].length > 0 ? (
              <TimelineDot
                bucketIndex={bucketIndex}
                color={color}
                disabled={disabled}
                // ISS-5479: `tl` is typed `number` but a synced marker can
                // deserialize without it. Resolved ONCE, here, so the label, the
                // affordance and the click all answer from the same value —
                // previously the dot took only half the bar's treatment and kept
                // its pointer cursor and scale-1.4 hover while announcing a jump
                // it could not make.
                dotRow={cell[color][0]?.tl ?? null}
                hot={
                  hoverDot?.bucketIndex === bucketIndex &&
                  hoverDot.color === color
                }
                key={color}
                onHoverDot={onHoverDot}
                onJump={onJump}
              />
            ) : null
          )}
        </div>
      ))}
    </div>
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
    <button
      aria-disabled={dotNoJump}
      aria-label={getDotButtonLabel(color, dotNoJump)}
      className={cn(`sd3-dot d-${color}`, hot && "hot", dotNoJump && "no-jump")}
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
      type="button"
    />
  );
}

const DOT_ORDER: DotColor[] = ["b", "g", "r"];
