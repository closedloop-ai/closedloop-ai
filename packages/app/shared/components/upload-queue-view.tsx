"use client";

import {
  SESSION_UPLOAD_STATE_TONE,
  SessionUploadState,
} from "@repo/app/shared/lib/upload-state";
import { ToneBadge } from "@repo/design-system/components/ui/primitives/status-badge";
import type { Tone } from "@repo/design-system/components/ui/types";
import { cn } from "@repo/design-system/lib/utils";
import { useId } from "react";

/**
 * ISS-12529 (PRD-806, data controls flow 2): what is queued, in flight and
 * failed for upload from this device.
 *
 * Counts only. The upload lane reports content-blind counts and never session
 * ids (`AgentSessionSyncProgress`), and AC-003 drives this view from those
 * existing progress hooks rather than a new polling path, so there are no
 * per-session rows to list. The desktop host derives these counts with
 * `uploadQueueCounts` in
 * `apps/desktop/src/renderer/components/sessions/cloud-sync-pending-sessions.ts`.
 */
export type UploadQueueCounts = {
  queued: number;
  inFlight: number;
  failed: number;
};

/**
 * Every visible string, one per slot, all supplied by the host: this component
 * authors no copy (ISS-12529 ground rules).
 */
export type UploadQueueViewCopy = {
  /** The view's heading. */
  heading: string;
  queuedLabel: string;
  inFlightLabel: string;
  failedLabel: string;
  /** Shown when nothing is queued, in flight or failed (AC-002). */
  emptyText: string;
  /**
   * Shown while the lane has not measured its queues. Never the empty state:
   * "nobody has looked" and "nothing is owed" are different answers
   * (ISS-5768).
   */
  unmeasuredText: string;
};

export type UploadQueueViewProps = {
  /** `null` while the lane has not measured its queues. */
  counts: UploadQueueCounts | null;
  copy: UploadQueueViewCopy;
  className?: string;
};

type UploadQueueRow = {
  key: keyof UploadQueueCounts;
  labelSlot: keyof UploadQueueViewCopy;
  tone: Tone;
};

/**
 * The three rows, in queue order, each with the tone the session upload badge
 * gives the same fact. Read from the one shared map rather than copied, so a
 * retuned badge retunes this view too (PR #8877 review): queued is a session
 * not yet uploaded, in flight one uploading, failed one that did not finish.
 */
const ROWS: readonly UploadQueueRow[] = [
  {
    key: "queued",
    labelSlot: "queuedLabel",
    tone: SESSION_UPLOAD_STATE_TONE[SessionUploadState.LocalOnly],
  },
  {
    key: "inFlight",
    labelSlot: "inFlightLabel",
    tone: SESSION_UPLOAD_STATE_TONE[SessionUploadState.Uploading],
  },
  {
    key: "failed",
    labelSlot: "failedLabel",
    tone: SESSION_UPLOAD_STATE_TONE[SessionUploadState.Failed],
  },
];

/** Which of the three renders: unmeasured, empty, or the counted list. */
export function resolveUploadQueueViewState(
  counts: UploadQueueCounts | null
): "unmeasured" | "empty" | "list" {
  if (counts === null) {
    return "unmeasured";
  }
  // Failed counts toward "not empty": an empty state over a failed upload
  // would hide the failure.
  return counts.queued + counts.inFlight + counts.failed === 0
    ? "empty"
    : "list";
}

/**
 * The upload queue (ISS-12529): one row per state with its count (AC-001), an
 * empty state when nothing is owed (AC-002), and a separate unmeasured state
 * so an unsampled lane never reads as an empty one.
 *
 * Composes the shared `ToneBadge` for each row's label, so the rows sit at the
 * same height and type scale as every other status pill. The tone only
 * reinforces the label, which is always visible text (WCAG 1.4.1).
 *
 * The counts are not a live region: they move on every 1s poll, and
 * announcing each tick would drown a screen reader.
 *
 * Presentational only. No production host renders it yet: its copy has no
 * approved source.
 */
export function UploadQueueView({
  counts,
  copy,
  className,
}: UploadQueueViewProps) {
  const headingId = useId();
  const state = resolveUploadQueueViewState(counts);

  return (
    <div
      className={cn("space-y-2", className)}
      data-state={state}
      data-testid="upload-queue-view"
    >
      {/* Not a heading element: the host owns the page outline. */}
      <p className="font-medium text-sm" id={headingId}>
        {copy.heading}
      </p>
      {counts === null || state !== "list" ? (
        <p
          className="text-muted-foreground text-sm"
          data-testid="upload-queue-view-message"
        >
          {state === "empty" ? copy.emptyText : copy.unmeasuredText}
        </p>
      ) : (
        <ul aria-labelledby={headingId} className="space-y-2">
          {ROWS.map((row) => (
            <li
              className="flex items-center justify-between gap-4"
              data-testid={`upload-queue-view-row-${row.key}`}
              key={row.key}
            >
              <ToneBadge
                label={copy[row.labelSlot]}
                pulse={row.key === "inFlight" && counts.inFlight > 0}
                tone={row.tone}
              />
              <span className="font-medium text-sm tabular-nums">
                {counts[row.key].toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
