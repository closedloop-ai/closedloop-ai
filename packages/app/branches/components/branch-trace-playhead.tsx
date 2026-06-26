"use client";

import { cn } from "@repo/design-system/lib/utils";
import { GripVerticalIcon } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { fractionOf, type TimeRange } from "../lib/branch-timeline-range";
import { useBranchTracePlayhead } from "../lib/branch-trace-playhead";

/**
 * Draggable "you are here" scrubber (Epic E / E2) — the design handoff's
 * `bq-playhead`. Overlays the E1 timeline and binds ONLY to the shared playhead
 * controller (never the trace component). Positioned over a `range` shared with
 * the timeline (so the handle aligns with the bars). Dragging maps x → timestamp
 * → `scrubToTimestamp`; the handle reads back from `activeTimestamp`, so trace-
 * driven scrubs move the handle too. Renders nothing without a range.
 */
export type BranchTracePlayheadProps = {
  range: TimeRange | null;
  className?: string;
};

const HOUR_MS = 3_600_000;

export function BranchTracePlayhead({
  range,
  className,
}: BranchTracePlayheadProps) {
  const controller = useBranchTracePlayhead();
  const railRef = useRef<HTMLDivElement>(null);
  // Holds the teardown for an in-flight drag so an unmount mid-drag (before
  // pointerup fires) still detaches the document-level listeners.
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const scrubToClientX = useCallback(
    (clientX: number) => {
      const rail = railRef.current;
      if (!(rail && range)) {
        return;
      }
      const rect = rail.getBoundingClientRect();
      const fraction = Math.min(
        1,
        Math.max(0, (clientX - rect.left) / Math.max(1, rect.width))
      );
      const ms = range.startMs + fraction * range.spanMs;
      controller.scrubToTimestamp(new Date(ms).toISOString());
    },
    [controller, range]
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      scrubToClientX(event.clientX);
      const onMove = (moveEvent: PointerEvent) =>
        scrubToClientX(moveEvent.clientX);
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        dragCleanupRef.current = null;
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      dragCleanupRef.current = onUp;
    },
    [scrubToClientX]
  );

  // Detach any still-attached drag listeners if the scrubber unmounts mid-drag.
  useEffect(() => () => dragCleanupRef.current?.(), []);

  if (!range) {
    return null;
  }

  const activeMs = controller.activeTimestamp
    ? Date.parse(controller.activeTimestamp)
    : null;
  const leftPercent =
    activeMs != null && !Number.isNaN(activeMs)
      ? fractionOf(range, activeMs) * 100
      : 0;

  const onKeyDown = (event: { key: string; preventDefault(): void }) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    const current = activeMs ?? range.startMs;
    const step = event.key === "ArrowLeft" ? -HOUR_MS : HOUR_MS;
    const ms = Math.min(range.endMs, Math.max(range.startMs, current + step));
    controller.scrubToTimestamp(new Date(ms).toISOString());
  };

  return (
    <div className={cn("bq-playhead-rail", className)} ref={railRef}>
      <button
        aria-label="Scrub the trace timeline"
        className="bq-playhead"
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        style={{ left: `${leftPercent}%` }}
        type="button"
      >
        <span className="bq-playhead-grip">
          <GripVerticalIcon size={10} />
        </span>
      </button>
    </div>
  );
}
