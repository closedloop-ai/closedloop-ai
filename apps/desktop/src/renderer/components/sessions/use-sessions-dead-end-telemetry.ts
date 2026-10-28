import type { SessionDetailErrorKind } from "@repo/app/agents/components/detail/agent-session-detail-states";
import { readApiErrorStatus } from "@repo/app/shared/api/read-api-error-status";
import { useLoadingStall } from "@repo/app/shared/hooks/use-loading-stall";
import { useCallback } from "react";
import {
  type DeadEndTelemetry,
  useDeadEndTelemetry,
} from "../../hooks/use-dead-end-telemetry";
import {
  resolveSessionDetailDeadEnd,
  resolveSessionsListDeadEnd,
  type SessionsListDeadEndInputs,
} from "./dead-end-cause";
import { SESSIONS_LIST_STALL_THRESHOLDS } from "./sessions-list-stall-thresholds";
import { isSessionsPageOutOfRange } from "./sessions-page-bounds";

/**
 * ISS-7249 — assembled here rather than in the views: `SessionsView` is a
 * grandfathered over-size file, so each view gains a single call.
 */

export type SessionsListDeadEndTelemetryInputs = Omit<
  SessionsListDeadEndInputs,
  "httpStatus" | "isPageOutOfRange"
> & {
  /** A successful, non-placeholder response established {@link total}. */
  hasSettledTotal: boolean;
  /**
   * The host read's offset ceiling, so this classifier and the clamp effect
   * agree on which pages are past the end (ISS-9074). Omitted for a host whose
   * source has no ceiling.
   */
  maxOffset?: number;
  page: number;
  total: number;
  /**
   * The list read's error, classified for a status here — the same conversion
   * the detail does, so one `ApiError` cannot mean two things (whitlockk review).
   */
  listError: unknown;
  /** Whether this surface is the content on screen — see `useDeadEndTelemetry`. */
  isActive: boolean;
  /** The list's own Retry handler, which resolves when its read has settled. */
  onRetry: () => Promise<unknown>;
  /**
   * The errored empty's "Clear filters and reload" recovery, which resolves the
   * same way. `ErroredEmpty` PREFERS this over the Retry button, so on the
   * unavailable treatment it is the only affordance the user can actually click
   * — untracked, `retryOffered: true` would be true about the screen and never
   * once be followed by a `retry_attempted` (ISS-7249, review cid 3821326374).
   */
  onClearFiltersAndReload: () => Promise<unknown>;
  /**
   * ISS-9692: the rows-per-page the read actually used. Taken from the caller
   * rather than the module constant it used to read — desktop's page size is a
   * reader choice now, so a fixed 25 here would decide "is this page past the
   * end?" against a window nobody requested.
   */
  pageSize: number;
};

/**
 * Returns the SAME handlers, wrapped so each attempt and its outcome are
 * recorded. Wrapped here rather than at the call sites so no future recovery
 * affordance can be wired to an untracked handler by accident.
 *
 * Both share one `trackRetry`, so they share one attempt tally and one in-flight
 * guard: a user who presses Retry and then the recovery Link is one person still
 * trying to escape one dead end, not two independent retries.
 */
export function useSessionsListDeadEndTelemetry({
  onRetry,
  onClearFiltersAndReload,
  hasSettledTotal,
  listError,
  isActive,
  maxOffset,
  page,
  pageSize,
  total,
  ...inputs
}: SessionsListDeadEndTelemetryInputs): {
  onRetry: () => void;
  onClearFiltersAndReload: () => void;
} {
  const { trackRetry } = useDeadEndTelemetry({
    active: isActive,
    cause: resolveSessionsListDeadEnd({
      ...inputs,
      httpStatus: readApiErrorStatus(listError),
      isPageOutOfRange: isSessionsPageOutOfRange({
        hasSettledTotal,
        maxOffset,
        pageIndex: page,
        pageSize,
        total,
      }),
    }),
  });
  return {
    onClearFiltersAndReload: useCallback(() => {
      trackRetry(onClearFiltersAndReload).catch(() => undefined);
    }, [onClearFiltersAndReload, trackRetry]),
    onRetry: useCallback(() => {
      trackRetry(onRetry).catch(() => undefined);
    }, [onRetry, trackRetry]),
  };
}

export type SessionDetailDeadEndTelemetryInputs = {
  isLoading: boolean;
  isError: boolean;
  hasSession: boolean;
  errorKind: SessionDetailErrorKind | undefined;
  /** The detail read's error, classified for a status here. */
  error: unknown;
};

export function useSessionDetailDeadEndTelemetry(
  inputs: SessionDetailDeadEndTelemetryInputs
): DeadEndTelemetry {
  // FEA-3639's list budget, applied to the DETAIL for telemetry only — nothing
  // on screen changes when it elapses. It buys the fifth `why`: still-loading
  // is a different fact from a read that failed. The list's own constant, so
  // the two surfaces cannot disagree about what "too long" means.
  const stallPhase = useLoadingStall(
    inputs.isLoading && !inputs.hasSession,
    SESSIONS_LIST_STALL_THRESHOLDS
  );
  return useDeadEndTelemetry({
    cause: resolveSessionDetailDeadEnd({
      errorKind: inputs.errorKind,
      hasSession: inputs.hasSession,
      httpStatus: readApiErrorStatus(inputs.error),
      isError: inputs.isError,
      isLoading: inputs.isLoading,
      stallPhase,
    }),
  });
}
