"use client";

/**
 * @file preview-trace-scrubber.tsx
 * @description Grab the session and pull a window out of it.
 *
 * A full-extent strip under the chart: span density behind, the current window
 * highlighted in front. Drag across it to cut a new window, drag the window
 * itself to pan, double-click to fit the whole session again.
 *
 * ACCESSIBILITY. Pointer dragging is an enhancement, not the only way in — the
 * toolbar's Fit / Zoom to span / Zoom out controls do the same three jobs from
 * the keyboard, so this strip is presentational and hidden from assistive
 * technology rather than being a keyboard trap that mimics a slider badly.
 */

import { cn } from "@repo/design-system/lib/utils";
import {
  type PointerEvent as ReactPointerEvent,
  useRef,
  useState,
} from "react";
import type { SessionTraceSpan } from "../../../../lib/session-trace/session-trace-node";
import {
  advanceScrubberDrag,
  beginScrubberDrag,
  type ScrubberDrag,
} from "./preview-trace-scrubber-drag";

/** Below this, a drag reads as a click and must not collapse the window. */
const MIN_DRAG_FRACTION = 0.01;
const DENSITY_BUCKETS = 96;

export type PreviewTraceScrubberProps = {
  spans: readonly SessionTraceSpan[];
  totalMs: number;
  windowFromMs: number;
  windowToMs: number;
  onWindowChange: (fromMs: number, toMs: number) => void;
  onReset: () => void;
};

export function PreviewTraceScrubber({
  spans,
  totalMs,
  windowFromMs,
  windowToMs,
  onWindowChange,
  onReset,
}: PreviewTraceScrubberProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<ScrubberDrag | null>(null);
  const extentMs = Math.max(1, totalMs);
  const windowFrom = windowFromMs / extentMs;
  const windowTo = windowToMs / extentMs;
  // A window covering the whole session has no inside to grab: every press
  // would pan a strip that cannot move, and the only gesture this control has
  // would stop cutting windows at all.
  const isWindowed = windowFromMs > 0 || windowToMs < totalMs;

  const fractionAt = (clientX: number): number => {
    const box = trackRef.current?.getBoundingClientRect();
    if (box === undefined || box.width === 0) {
      return 0;
    }
    return Math.min(1, Math.max(0, (clientX - box.left) / box.width));
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag(
      beginScrubberDrag(fractionAt(event.clientX), {
        isWindowed,
        windowFrom,
        windowTo,
      })
    );
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag === null) {
      return;
    }
    setDrag(advanceScrubberDrag(drag, fractionAt(event.clientX)));
  };

  const handlePointerUp = () => {
    if (drag === null) {
      return;
    }
    const low = Math.min(drag.from, drag.to);
    const high = Math.max(drag.from, drag.to);
    setDrag(null);
    if (drag.mode === "pan") {
      // A press that never moved is not a pan, and re-emitting the window it
      // started from would bury an identical range in the route state.
      if (Math.abs(low - windowFrom) > Number.EPSILON) {
        onWindowChange(low * totalMs, high * totalMs);
      }
      return;
    }
    // A tap is not a zoom to zero. Leaving the window alone is the only
    // non-destructive reading of a drag too short to mean anything.
    if (high - low < MIN_DRAG_FRACTION) {
      return;
    }
    onWindowChange(low * totalMs, high * totalMs);
  };

  const selection = drag ?? { from: windowFrom, to: windowTo };
  const left = Math.min(selection.from, selection.to) * 100;
  const width = Math.abs(selection.to - selection.from) * 100;

  return (
    <div className="flex items-center gap-2 border-border border-t px-2 py-2">
      <span className="w-60 shrink-0 text-muted-foreground text-xs uppercase tracking-wide max-sm:w-36">
        Drag to zoom
      </span>
      {/* Presentational: aria-hidden because the toolbar's Fit / Zoom to span /
          Zoom out controls are the keyboard-reachable equivalent of every
          gesture below. */}
      <div
        aria-hidden="true"
        className="relative h-8 min-w-0 flex-1 cursor-crosshair touch-none overflow-hidden rounded-[3px] bg-muted/50"
        onDoubleClick={onReset}
        onPointerCancel={handlePointerUp}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        ref={trackRef}
      >
        <SpanDensity spans={spans} totalMs={totalMs} />
        <div
          className={cn(
            "absolute inset-y-0 border-primary border-x-2 bg-primary/15",
            drag === null ? undefined : "bg-primary/25"
          )}
          style={{ left: `${left}%`, width: `${Math.max(0.5, width)}%` }}
        />
      </div>
      <span className="w-16 shrink-0" />
    </div>
  );
}

/** Where the session was busy, as a coarse histogram behind the window. */
function SpanDensity({
  spans,
  totalMs,
}: {
  spans: readonly SessionTraceSpan[];
  totalMs: number;
}) {
  const counts = new Array<number>(DENSITY_BUCKETS).fill(0);
  const span = Math.max(1, totalMs);
  for (const item of spans) {
    const first = clampBucket((item.startMs / span) * DENSITY_BUCKETS);
    const last = clampBucket((item.endMs / span) * DENSITY_BUCKETS);
    for (let index = first; index <= last; index += 1) {
      counts[index] += 1;
    }
  }
  const peak = Math.max(1, ...counts);
  // Each bucket is keyed by the position on the axis it represents, which is
  // its actual identity and is stable however the counts change.
  const buckets = counts.map((count, index) => ({
    atFraction: index / DENSITY_BUCKETS,
    count,
  }));

  return (
    <div className="absolute inset-0 flex items-end">
      {buckets.map((bucket) => (
        <span
          className="flex-1 bg-foreground/20"
          key={bucket.atFraction}
          style={{ height: `${(bucket.count / peak) * 100}%` }}
        />
      ))}
    </div>
  );
}

function clampBucket(raw: number): number {
  return Math.min(DENSITY_BUCKETS - 1, Math.max(0, Math.floor(raw)));
}
