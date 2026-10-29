"use client";

import {
  IdleConcept,
  idleConceptLabel,
} from "@repo/api/src/types/idle-concepts";
import { formatDurationMs } from "@repo/lib/sessions/agent-session-projection-utils";
import { memo } from "react";
import type { TraceGroup } from "./session-trace-groups";

/**
 * ISS-8652: the pause between two stamped trace items, rendered as its own row.
 *
 * The span was already computed (`buildMergedTrace`) and already adapted to a
 * turn item; only the render was missing, so the reader saw two turns three
 * minutes apart with nothing between them saying so. The row carries the whole
 * timing statement — a gap has no transcript row of its own to hang it on.
 *
 * Reuses the system row's separator styling rather than inventing a treatment:
 * an idle span is the same class of quiet, non-actionable interstitial as a
 * system event line, and the duration is the only thing it has to say.
 */
export const TraceIdleRow = memo(function TraceIdleRow({
  group,
}: Readonly<{ group: Extract<TraceGroup, { kind: "idle" }> }>) {
  return (
    <div className="st-sysline">
      <span className="st-sysline-text">{formatIdleRowLabel(group.gapMs)}</span>
    </div>
  );
});

/**
 * The row's whole statement, as ONE string rather than interpolated siblings —
 * a reader (and a test) sees a single phrase, not three adjacent text nodes.
 * Reads the concept's canonical label from `IDLE_CONCEPTS` so the row and the
 * vocabulary registry cannot drift.
 *
 * The HOUR-ROLLING `formatDurationMs` (`@repo/lib/sessions/…`), not the
 * minute-capped one in `@repo/app/shared/lib/format-duration-ms`: the duration
 * IS this row, the merged trace opens a gap at two minutes and spans a branch's
 * whole life, so an overnight pause is ordinary here rather than an edge — and
 * the capped formatter would print it as "240m 0s".
 */
export function formatIdleRowLabel(gapMs: number): string {
  return `${idleConceptLabel(IdleConcept.TraceGap)} · ${formatDurationMs(gapMs)}`;
}
