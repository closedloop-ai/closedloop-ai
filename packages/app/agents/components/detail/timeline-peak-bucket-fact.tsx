"use client";

import type { TimelineScale } from "@repo/app/agents/lib/session-timeline-scale";
import { formatCostPrecise } from "@repo/app/shared/lib/format-utils";
import { CHIP_FOCUS_RING_CLASS } from "@repo/design-system/components/ui/chip";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";

/**
 * ISS-12665 — the timeline header's "Peak {scale} bucket" fact, shared by the
 * Session Timeline summary and the Branch PR timeline stats.
 *
 * Label, order and explanation are the prototype's own strings
 * (`packages/app/agents/components/sessions/web-master-legacy-preview/components/session-timeline.tsx`, the
 * `ml-auto` header row). The figure is `formatCostPrecise`, the format each
 * strip's bar hover card prints a column's total in, so the peak reads the same
 * as the tallest bar's own tooltip.
 *
 * Only the VALUE is stated, never which column holds it, so two columns tied at
 * the peak need no tie-break here. `costUsd: null` is the em-dash, never `$0.00`.
 */
export function TimelinePeakBucketFact({
  costUsd,
  describedBy,
  explainsFullSession,
  markValue,
  scale,
}: Readonly<{
  costUsd: number | null;
  /** Id of the caller's disclosure for a marked figure, as `aria-describedby`. */
  describedBy?: string;
  /**
   * Whether the figure was taken across the full session — the only scope the
   * prototype's explanation describes. A caller whose peak spans something else
   * (a Branch's many sessions) omits the explanation rather than carrying a
   * sentence that is not true of it.
   */
  explainsFullSession: boolean;
  /**
   * The caller's completeness marker for the formatted figure — the Branch
   * header passes `formatTimelineEvidenceValue`, the same marker its cost and
   * duration carry (#9008 review, whitlockk). Not applied to the dash.
   */
  markValue?: (formatted: string) => string;
  scale: TimelineScale;
}>) {
  const body = (
    <>
      {timelinePeakBucketLabel(scale)}{" "}
      <b
        aria-describedby={describedBy}
        className="font-semibold text-foreground tabular-nums"
      >
        {costUsd == null ? (
          <GridEmptyValue />
        ) : (
          (markValue ?? identity)(formatCostPrecise(costUsd))
        )}
      </b>
    </>
  );
  if (!explainsFullSession) {
    return <span className="whitespace-nowrap">{body}</span>;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={`cursor-default whitespace-nowrap rounded-sm ${CHIP_FOCUS_RING_CLASS}`}
          type="button"
        >
          {body}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs break-words">
        {timelinePeakBucketExplanation(scale)}
      </TooltipContent>
    </Tooltip>
  );
}

/** The prototype's label (`session-timeline.tsx`, "Peak {scale} bucket"). */
export function timelinePeakBucketLabel(scale: TimelineScale): string {
  return `Peak ${scale} bucket`;
}

/** The prototype's tooltip sentence for the same fact, verbatim. */
export function timelinePeakBucketExplanation(scale: TimelineScale): string {
  return `Highest-cost ${scale} interval across the full session. This scale stays fixed while you scroll.`;
}

/** ISS-12665: what a timeline header needs to state its peak column. */
export type TimelinePeakBucket = Readonly<{
  costUsd: number | null;
  scale: TimelineScale;
}>;

function identity(formatted: string): string {
  return formatted;
}
