"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { ToneBadge } from "@repo/design-system/components/ui/primitives/status-badge";
import type { Tone } from "@repo/design-system/components/ui/types";
import { cn } from "@repo/design-system/lib/utils";
import { useId } from "react";

/**
 * ISS-12526 (PRD-806, data controls flow 2): the four states a data-sync policy
 * can be in, as one indicator reads them.
 *
 * Shaped so a host can later derive it from the desktop's applied policy
 * (`apps/desktop/src/main/settings/apply-data-sync-level.ts`) without this
 * component learning anything about the desktop. A renderer reaches that file
 * through the host port `useLocalSyncPolicy`
 * (`packages/app/shared/settings-host/use-local-sync-policy.ts`), whose calls
 * SETTLE with a projection rather than reject. Not wired yet; the proposed
 * mapping from that hook, for whoever wires it:
 *
 * - `failed`: `writeOutcome` is a non-ready projection, a write the host did
 *   not apply (a thrown call is folded into `read-failed` by the hook). Check
 *   it BEFORE `active`: the hook leaves the last ready projection in `state`
 *   when a write fails, so the `active` condition below is still true while
 *   `writeOutcome` is non-ready, and failed must win over that stale active.
 *   The non-ready projection carries no level, and `write()` does not hand
 *   the requested level back, so the host has to stash the level it asked for
 *   before calling `write()`; the retry path calls `write` again with that
 *   stashed level.
 * - `active`: `state` settled with a `ready` projection, `isWriting` is
 *   false and `writeOutcome` is not a non-ready projection. The projection is
 *   the level actually in force, which `applyDataSyncLevel` may have
 *   reconciled down from the one asked for.
 * - `pending`: `isWriting` is true: a level was chosen and the host has not
 *   answered yet. A retry is a fresh `write()`, which sets `isWriting` and
 *   clears `writeOutcome` up front, so a retry in flight maps here, not to a
 *   failed state with a busy control: the failed indicator, and its retry
 *   button, unmount until the host answers.
 * - `unavailable`: `supported` is false (web has no local policy path), or the
 *   read itself settled non-ready (`not-desktop-host`, `bridge-unavailable`,
 *   `read-failed`, `malformed-payload`), so there is no policy to show.
 *
 * The hook's initial read (`state.status === "pending"`) is loading, not a
 * pending change, so it does not map to `pending`. Golden mode is not in the
 * projection today: `applyDataSyncLevel` keeps cloud egress off whatever level
 * is chosen, and showing that as `unavailable` needs the host to report it.
 * That is a dependency, not something this component resolves.
 */
export const POLICY_STATUS = {
  ACTIVE: "active",
  PENDING: "pending",
  FAILED: "failed",
  UNAVAILABLE: "unavailable",
} as const;

export type PolicyStatus = (typeof POLICY_STATUS)[keyof typeof POLICY_STATUS];

/**
 * The shared status badge's tone for each state. Tone is never the only
 * carrier: every state renders its `label` as visible text and as the
 * indicator's accessible name (WCAG 1.4.1), so the fill only reinforces it.
 */
const POLICY_STATUS_TONE: Record<PolicyStatus, Tone> = {
  [POLICY_STATUS.ACTIVE]: "success",
  [POLICY_STATUS.PENDING]: "info",
  [POLICY_STATUS.FAILED]: "danger",
  [POLICY_STATUS.UNAVAILABLE]: "muted",
};

type PolicyStatusIndicatorBaseProps = {
  /**
   * The state's visible text, and the indicator's accessible name. Required
   * and supplied by the host: this component authors no copy (ISS-12526
   * ground rules), and approved wording comes from the PRD owner.
   */
  label: string;
  /** Optional supporting line, e.g. which machine the policy applies to. */
  detail?: string;
  className?: string;
};

export type PolicyStatusIndicatorProps = PolicyStatusIndicatorBaseProps &
  (
    | {
        status: Exclude<PolicyStatus, typeof POLICY_STATUS.FAILED>;
      }
    | {
        status: typeof POLICY_STATUS.FAILED;
        /**
         * The failed state's retry path (AC-003). Required, so a failed
         * indicator can never ship without a way out.
         */
        onRetry: () => void;
        /** The retry control's text, supplied by the host. */
        retryLabel: string;
      }
  );

/**
 * One indicator for whether the data-sync policy is active, a change is
 * pending, applying failed, or the policy is unavailable (ISS-12526).
 *
 * Composes the shared `ToneBadge` from
 * `packages/design-system/components/ui/primitives/status-badge.tsx` rather
 * than drawing its own pill, so it sits at the same height, weight and type
 * scale as every other status pill in the app. The pending state pulses the
 * badge's dot; the pulse is decorative and stills under reduced motion, and the
 * label carries the state either way.
 *
 * Presentational only: state, copy and the retry handler all come from the
 * host. No production host renders it yet.
 */
export function PolicyStatusIndicator(props: PolicyStatusIndicatorProps) {
  const { status, label, detail, className } = props;
  const detailId = useId();

  return (
    <div
      className={cn("inline-flex flex-wrap items-center gap-2", className)}
      data-state={status}
      data-testid="policy-status-indicator"
    >
      <ToneBadge
        aria-describedby={detail ? detailId : undefined}
        aria-label={label}
        label={label}
        pulse={status === POLICY_STATUS.PENDING}
        role="status"
        tone={POLICY_STATUS_TONE[status]}
      />
      {detail ? (
        <span className="text-muted-foreground text-xs" id={detailId}>
          {detail}
        </span>
      ) : null}
      {props.status === POLICY_STATUS.FAILED ? (
        <Button
          onClick={props.onRetry}
          size="sm"
          type="button"
          variant="outline"
        >
          {props.retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
