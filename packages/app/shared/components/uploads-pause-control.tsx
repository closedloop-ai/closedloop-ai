"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { ToneBadge } from "@repo/design-system/components/ui/primitives/status-badge";
import { cn } from "@repo/design-system/lib/utils";
import { useId } from "react";

/**
 * ISS-12528 (PRD-806, data controls flow 2): whether uploads from this device
 * are running or paused. Pausing does not change the sync level; it only stops
 * new uploads until the user resumes.
 *
 * There are exactly two states, and deliberately no "pausing" state between
 * them. Marisol Ashgrove ruled on the ticket (ISS-12528 thread
 * 01a144ff-4c9b-7518-8955-9ffe0c736f63, 2026-10-16): "we should show in the UI
 * it's paused as soon as the user clicks it." So a host flips `state` to
 * `paused` inside its `onPause` handler, not after the upload pipeline
 * confirms; the pipeline acknowledgement is not what this control waits on.
 */
export const UPLOADS_STATE = {
  UPLOADING: "uploading",
  PAUSED: "paused",
} as const;

export type UploadsState = (typeof UPLOADS_STATE)[keyof typeof UPLOADS_STATE];

type UploadsPauseControlBaseProps = {
  /** The control's heading. */
  heading: string;
  /**
   * The summary line for the current state (AC-002). Supplied by the host for
   * each state: this component authors no copy (ISS-12528 ground rules), and
   * none of it may suggest earlier uploads were deleted (AC-003).
   */
  summary: string;
  className?: string;
};

type UploadsPauseControlProps = UploadsPauseControlBaseProps &
  (
    | {
        state: typeof UPLOADS_STATE.UPLOADING;
        /** The pause control's text. */
        pauseLabel: string;
        /** Fires on pause. The host sets `state` to paused right here. */
        onPause: () => void;
      }
    | {
        state: typeof UPLOADS_STATE.PAUSED;
        /** The paused badge's text and accessible name (AC-002). */
        pausedLabel: string;
        /** The resume control's text. */
        resumeLabel: string;
        onResume: () => void;
        /**
         * Set only while the host reports that an upload which started before
         * the pause is still finishing; omit it otherwise. Never inferred here.
         *
         * Marisol Ashgrove ruled on in-flight uploads (ISS-12528 thread
         * 01a144fe-9031-74cf-b91f-da83819ab224, 2026-10-16), choosing option
         * (a), let the current upload finish, then stop: "when you pause; it
         * stops processing new records." So paused means no NEW upload starts,
         * not that nothing is uploading right now, and the paused state must
         * never claim the latter. This detail is how a host says so honestly.
         */
        finishingUploadDetail?: string;
      }
  );

/**
 * Pause and resume uploads from the Data settings surface (ISS-12528 AC-001).
 *
 * When paused, the control shows its own amber paused badge (AC-002), the
 * shared `ToneBadge` from
 * `packages/design-system/components/ui/primitives/status-badge.tsx` in its
 * warning tone, so it sits at the same height and type scale as every other
 * status pill.
 *
 * Paused is a separate axis from the data-sync policy state, not a fifth
 * `POLICY_STATUS`: pausing does not change the level, and a device can be
 * paused AND have a failed apply (Marisol Ashgrove, PR #8870 review). A host that
 * shows both renders `PolicyStatusIndicator` and this control side by side, so
 * a failed apply keeps its retry path while uploads are paused.
 *
 * The control is one outline button whose label follows the state:
 * it keeps focus across pause and resume, and it is never the destructive
 * variant, because pausing stops future uploads and removes nothing (AC-003).
 *
 * Presentational only: state, copy and handlers all come from the host. No
 * production host renders it yet; the upload pipeline has no pause today
 * (PRD-806 "Non-component dependencies").
 */
export function UploadsPauseControl(props: UploadsPauseControlProps) {
  const { heading, summary, className } = props;
  const paused = props.state === UPLOADS_STATE.PAUSED;
  const detailId = useId();

  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-x-4 gap-y-3",
        className
      )}
      data-state={props.state}
      data-testid="uploads-pause-control"
    >
      <div className="min-w-0 flex-1 space-y-1">
        {/* Not a heading element: the host owns the page outline, and this
            row sits inside whatever section heading the host already has. */}
        <p className="font-medium text-sm">{heading}</p>
        <p
          className="text-muted-foreground text-sm"
          data-testid="uploads-pause-summary"
        >
          {summary}
        </p>
        {props.state === UPLOADS_STATE.PAUSED ? (
          <div className="inline-flex flex-wrap items-center gap-2 pt-1">
            {/* The visible label is the accessible name (WCAG 1.4.1): the
                amber fill only reinforces it. */}
            <ToneBadge
              aria-describedby={
                props.finishingUploadDetail ? detailId : undefined
              }
              aria-label={props.pausedLabel}
              data-testid="uploads-paused-badge"
              label={props.pausedLabel}
              role="status"
              tone="warning"
            />
            {props.finishingUploadDetail ? (
              <span className="text-muted-foreground text-xs" id={detailId}>
                {props.finishingUploadDetail}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {/* One button for both states, not two conditional ones, so focus stays
          on it when the label flips from pause to resume. */}
      <Button
        onClick={paused ? props.onResume : props.onPause}
        size="sm"
        type="button"
        variant="outline"
      >
        {paused ? props.resumeLabel : props.pauseLabel}
      </Button>
    </div>
  );
}
