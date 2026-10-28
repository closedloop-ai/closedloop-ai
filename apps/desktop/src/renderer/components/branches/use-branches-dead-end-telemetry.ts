import type { BranchesListStateSignals } from "@repo/app/branches/lib/branch-list-state";
import { readApiErrorStatus } from "@repo/app/shared/api/read-api-error-status";
import { useCallback } from "react";
import { useDeadEndTelemetry } from "../../hooks/use-dead-end-telemetry";
import { resolveBranchesListDeadEnd } from "./branches-dead-end-cause";

export type BranchesListDeadEndTelemetryInputs = BranchesListStateSignals & {
  /** The list read's error, classified for a status here. */
  listError: unknown;
  /**
   * Whether this surface is the content on screen. Branches is NOT excluded
   * from `KeepAliveExcludedNavIds`, so a visited Branches tree stays mounted and
   * keeps polling behind whatever the user navigated to — see
   * `useDeadEndTelemetry`, where emitting from a hidden surface would suppress
   * the record for the occurrence a person actually saw.
   */
  isActive: boolean;
  /** The list's own Retry handler, which resolves when its read has settled. */
  onRetry: () => Promise<unknown>;
};

/**
 * ISS-9725 — returns the SAME Retry handler, wrapped so the attempt and its
 * outcome are recorded. Wrapped here rather than at the two call sites (the v1
 * body and the v2 surface both take `onRetry`) so neither rollout branch can be
 * wired to an untracked handler: the `unavailable` record claims
 * `retryOffered: true`, and an untracked handler would make that claim true
 * about the screen and never once be followed by a `retry_attempted`.
 */
export function useBranchesListDeadEndTelemetry({
  isActive,
  listError,
  onRetry,
  ...signals
}: BranchesListDeadEndTelemetryInputs): { onRetry: () => void } {
  const { trackRetry } = useDeadEndTelemetry({
    active: isActive,
    cause: resolveBranchesListDeadEnd({
      ...signals,
      httpStatus: readApiErrorStatus(listError),
    }),
  });
  return {
    onRetry: useCallback(() => {
      trackRetry(onRetry).catch(() => undefined);
    }, [onRetry, trackRetry]),
  };
}
