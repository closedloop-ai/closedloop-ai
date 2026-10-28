"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { ToneBadge } from "@repo/design-system/components/ui/primitives/status-badge";
import type { Tone } from "@repo/design-system/components/ui/types";
import { cn } from "@repo/design-system/lib/utils";
import { useId } from "react";

/**
 * ISS-12538 (PRD-808, data controls flow 4): where a deletion request stands
 * after the user confirmed it in the deletion scope review (ISS-12537).
 *
 * Four outcomes (AC-001): pending, completed, failed and unavailable. There is
 * no deletion endpoint yet (PRD-808), so this is props in, callbacks out: the
 * host passes the request's state and every string, and handles retry.
 */
export const DELETION_REQUEST_STATUS = {
  PENDING: "pending",
  COMPLETED: "completed",
  FAILED: "failed",
  UNAVAILABLE: "unavailable",
} as const;

export type DeletionRequestStatus =
  (typeof DELETION_REQUEST_STATUS)[keyof typeof DELETION_REQUEST_STATUS];

/**
 * The request as the backend reports it.
 *
 * `completed` carries `verified: true` and the evidence behind it (AC-003).
 * A host may only build that variant from an explicit, verified backend
 * signal; it must never infer completion from elapsed time, a missing row or
 * a pending request that went quiet. The type makes `verified: true`
 * mandatory, and the component checks it again at runtime (see
 * {@link resolveDeletionRequestStatus}), so an unverified completion can never
 * render as completed.
 */
export type DeletionRequest =
  | {
      status: typeof DELETION_REQUEST_STATUS.PENDING;
      /** Optional evidence line, e.g. when the request was submitted. */
      detail?: string;
    }
  | {
      status: typeof DELETION_REQUEST_STATUS.COMPLETED;
      /** Set only from a verified backend signal. */
      verified: true;
      /** What the backend verified, e.g. the confirmation it returned. */
      evidence: string;
    }
  | {
      status: typeof DELETION_REQUEST_STATUS.FAILED;
      /** Optional evidence line, e.g. the reason the backend gave. */
      detail?: string;
    }
  | {
      status: typeof DELETION_REQUEST_STATUS.UNAVAILABLE;
    };

/**
 * Every visible string, one per slot, all supplied by the host: this component
 * authors no copy (ISS-12538 ground rules). Approved wording comes from the
 * PRD owner; wording about timing or completed removal is subject to technical
 * verification (PRD-796).
 */
export type DeletionRequestTrackerCopy = {
  pendingLabel: string;
  completedLabel: string;
  failedLabel: string;
  unavailableLabel: string;
  /** The unavailable state's statement that nothing was removed (AC-002). */
  unavailableExplanation: string;
  /** The failed state's retry control (AC-002). */
  retryLabel: string;
};

export type DeletionRequestTrackerProps = {
  request: DeletionRequest;
  copy: DeletionRequestTrackerCopy;
  /**
   * The failed state's retry path (AC-002). Required, so a tracker can never
   * show a failure without a way to try again.
   */
  onRetry: () => void;
  /** While a retry is in flight the control is disabled. */
  isRetrying?: boolean;
  className?: string;
};

/**
 * The status shown for `request`. Completed only when the request says
 * `verified === true`; anything else that claims completion is still pending,
 * because completion is never inferred (AC-003). The strict check guards
 * callers that reach this through an untyped boundary (a wire payload, a
 * cast).
 */
export function resolveDeletionRequestStatus(
  request: DeletionRequest
): DeletionRequestStatus {
  if (request.status === DELETION_REQUEST_STATUS.COMPLETED) {
    return request.verified === true
      ? DELETION_REQUEST_STATUS.COMPLETED
      : DELETION_REQUEST_STATUS.PENDING;
  }
  return request.status;
}

/**
 * The shared status badge's tone for each state. Tone is never the only
 * carrier: every state renders its label as visible text and as the badge's
 * accessible name (WCAG 1.4.1).
 */
const DELETION_REQUEST_TONE: Record<DeletionRequestStatus, Tone> = {
  [DELETION_REQUEST_STATUS.PENDING]: "info",
  [DELETION_REQUEST_STATUS.COMPLETED]: "success",
  [DELETION_REQUEST_STATUS.FAILED]: "danger",
  [DELETION_REQUEST_STATUS.UNAVAILABLE]: "muted",
};

const LABEL_SLOT: Record<
  DeletionRequestStatus,
  keyof DeletionRequestTrackerCopy
> = {
  [DELETION_REQUEST_STATUS.PENDING]: "pendingLabel",
  [DELETION_REQUEST_STATUS.COMPLETED]: "completedLabel",
  [DELETION_REQUEST_STATUS.FAILED]: "failedLabel",
  [DELETION_REQUEST_STATUS.UNAVAILABLE]: "unavailableLabel",
};

/** The supporting line under the badge for the status actually shown. */
function detailFor(
  request: DeletionRequest,
  status: DeletionRequestStatus,
  copy: DeletionRequestTrackerCopy
): string | undefined {
  switch (status) {
    case DELETION_REQUEST_STATUS.COMPLETED:
      return request.status === DELETION_REQUEST_STATUS.COMPLETED
        ? request.evidence
        : undefined;
    case DELETION_REQUEST_STATUS.UNAVAILABLE:
      return copy.unavailableExplanation;
    case DELETION_REQUEST_STATUS.PENDING:
    case DELETION_REQUEST_STATUS.FAILED:
      // An unverified "completed" resolves to pending but carries no pending
      // detail: its evidence is exactly what was not verified, so it is not
      // shown.
      return request.status === status && "detail" in request
        ? request.detail
        : undefined;
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
}

/**
 * One tracker for a deletion request: pending, completed, failed (with retry)
 * or unavailable (ISS-12538).
 *
 * Composes the shared `ToneBadge` from
 * `packages/design-system/components/ui/primitives/status-badge.tsx` rather
 * than drawing its own pill, so it sits at the same height, weight and type
 * scale as every other status pill in the app. Pending pulses the badge's
 * dot; the pulse is decorative and the label carries the state either way.
 */
export function DeletionRequestTracker({
  request,
  copy,
  onRetry,
  isRetrying = false,
  className,
}: DeletionRequestTrackerProps) {
  const labelId = useId();
  const detailId = useId();
  const status = resolveDeletionRequestStatus(request);
  const label = copy[LABEL_SLOT[status]];
  const detail = detailFor(request, status, copy);

  // One live region holds the label AND the detail, so a status change (say
  // pending to failed) is announced as one statement: the new label with its
  // reason. It stays mounted across states, because a live region inserted
  // with its content is not reliably announced. The retry control sits
  // outside it, so the button's text is never read as part of the status.
  return (
    <div
      className={cn("flex min-w-0 flex-wrap items-start gap-2", className)}
      data-state={status}
      data-testid="deletion-request-tracker"
    >
      <div
        aria-atomic="true"
        aria-describedby={detail ? detailId : undefined}
        aria-labelledby={labelId}
        className="flex min-w-0 flex-col items-start gap-1.5"
        data-testid="deletion-request-tracker-status"
        role="status"
      >
        <ToneBadge
          id={labelId}
          label={label}
          pulse={status === DELETION_REQUEST_STATUS.PENDING}
          tone={DELETION_REQUEST_TONE[status]}
        />
        {detail ? (
          <p
            className="break-words text-muted-foreground text-xs"
            id={detailId}
          >
            {detail}
          </p>
        ) : null}
      </div>
      {status === DELETION_REQUEST_STATUS.FAILED ? (
        <Button
          disabled={isRetrying}
          onClick={onRetry}
          size="sm"
          type="button"
          variant="outline"
        >
          {copy.retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
