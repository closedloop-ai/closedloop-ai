"use client";

/**
 * Pre-loop attempt lifecycle: the non-React half of the Generate/Execute gate.
 *
 * Split out of `pre-loop-system-check-provider.tsx` (ISS-5169/5170/5171), which
 * had grown past the file-size ceiling. Everything here is state-machine and
 * failure-shaping logic for one attempt — cancellation bookkeeping, timeout
 * backstop, unavailable-check construction, reason formatting, and the explicit
 * compute-selection preflight. The provider keeps only the React context,
 * hooks, and rendering.
 */

import {
  ComputePreference,
  ComputePreferenceRequiredMessage,
  type ComputePreferenceResponse,
  type ComputeTarget,
} from "@repo/api/src/types/compute-target";
import { toast } from "@repo/design-system/components/ui/sonner";
import type { HealthCheckResponse } from "@/lib/engineer/queries/health-check";
import {
  describeHealthCheckFailure,
  HealthCheckFailureKind,
  HealthCheckTimeoutError,
} from "./health-check-failure";
import {
  type buildPreLoopAnalyticsProperties,
  PreLoopAnalyticsEvent,
  type PreLoopExecutionContext,
  type PreLoopHealthCheckOutcome,
  type PreLoopMetadata,
  type PreLoopTarget,
} from "./pre-loop-health-check";

export type ExecuteCallback = (
  context: PreLoopExecutionContext
) => void | Promise<void>;

export type PendingPreLoopAttempt = {
  attemptId: string;
  metadata: PreLoopMetadata;
  target: PreLoopTarget;
  healthCheckData?: HealthCheckResponse;
  latestVersion: string | null;
  pluginAutoUpdateEnabled: boolean;
  failingRequiredFingerprint?: string;
  failingCheckIds: string[];
  recheckAttempts: number;
  /**
   * Set only when the attempt was blocked because the check never produced a
   * verdict. Drives the dialog's footer emphasis: when the target could not be
   * reached, Re-check is the least likely control to work and Run on Cloud is
   * the way forward, so the two swap weight (ISS-5171).
   */
  failureKind?: HealthCheckFailureKind;
  execute: ExecuteCallback;
};

export type ActivePreLoopAttempt = {
  attemptId: string;
  metadata: PreLoopMetadata;
  target?: PreLoopTarget | null;
  failingRequiredFingerprint?: string;
  recheckAttempts: number;
  cancelled: boolean;
};

export type ActivePreLoopAttemptRef = {
  current: ActivePreLoopAttempt | null;
};

export type HealthCheckFetchResult = {
  data: HealthCheckResponse;
  healthCheckCacheAgeMs: number | null;
  latestVersion: string | null;
  usedCachedHealthCheck: boolean;
};

export type UpdateActivePendingAttemptInput = {
  attemptId: string;
  metadata: PreLoopMetadata;
  target: PreLoopTarget;
  latestVersion: string | null;
  pluginAutoUpdateEnabled: boolean;
  healthCheckData?: HealthCheckResponse;
  failureKind?: HealthCheckFailureKind;
  execute: ExecuteCallback;
  openedDialog: boolean;
};

export type UpdatePendingAttemptInput = Pick<
  UpdateActivePendingAttemptInput,
  "target" | "latestVersion" | "healthCheckData" | "failureKind"
> & { pluginAutoUpdateEnabled: boolean };

export type AttemptBranchCallbacks = {
  wasCancelled: () => boolean;
  clearActiveAttempt: () => void;
};

export type CachedHealthCheckFetchResult = HealthCheckFetchResult & {
  dataUpdatedAt: number;
};

export function getLatestVersionFromHealthCheckQueryKey(
  queryKey: readonly unknown[]
): string | null {
  const latestVersion = queryKey[3];
  return typeof latestVersion === "string" && latestVersion.length > 0
    ? latestVersion
    : null;
}

export type PreLoopHealthEvaluation =
  | { status: "skip_no_local_target" }
  | {
      status: "unavailable";
      reason: string;
      /** Classified cause — drives the copy and the Cloud-fallback decision. */
      failureKind: HealthCheckFailureKind;
      target?: PreLoopTarget | null;
      latestVersion?: string | null;
      pluginAutoUpdateEnabled?: boolean;
    }
  | {
      status: "available";
      target: PreLoopTarget;
      latestVersion: string | null;
      pluginAutoUpdateEnabled: boolean;
      healthResult: HealthCheckFetchResult;
    };

export function buildUnavailableHealthCheck({
  failureKind,
  targetLabel,
}: {
  failureKind: HealthCheckFailureKind;
  targetLabel?: string | null;
}): HealthCheckResponse {
  const { title, description } = describeHealthCheckFailure(
    failureKind,
    targetLabel
  );
  return {
    checks: [
      {
        id: "pre-loop-health-check",
        label: "System Check",
        required: true,
        passed: false,
        // "Couldn't reach the target" and "the target says it is unhealthy" are
        // different problems with different remedies; say which one this is
        // instead of one flat "Unavailable" (ISS-5169).
        error: title,
        // The classified reason code rides the analytics event, not the
        // dialog: `health_check:relay_timeout:Health check timed out reaching
        // the relay target after 20000ms` is diagnostics, not remediation.
        remediation: `${description} The command was not started.`,
      },
    ],
    allRequiredPassed: false,
  };
}

/**
 * Caller-side backstop around the whole health-check query. The query already
 * aborts each attempt on its own budget; this guards against the query never
 * settling at all. Its budget is deliberately larger than the per-attempt one
 * (see `getPreLoopHealthCheckOverallTimeoutMs`) so the specific per-attempt
 * reason wins the race instead of two timeouts producing the same opaque text.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new HealthCheckTimeoutError(
          HealthCheckFailureKind.OverallTimeout,
          timeoutMs
        )
      );
    }, timeoutMs);

    promise.then(resolve, reject).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    });
  });
}

export function getTargetLabel(target: ComputeTarget): string {
  return target.machineName || target.ownerName || target.id;
}

export function formatUnavailableReason(scope: string, error: unknown): string {
  return error instanceof Error
    ? `${scope}:${error.message}`
    : `${scope}:unknown`;
}

/**
 * Reason string for a health-check failure, keyed on the classified kind rather
 * than a raw message, so analytics can tell "timed out reaching the relay" from
 * "target reported unhealthy" without string-matching (ISS-5169).
 */
export function formatHealthCheckFailureReason(
  kind: HealthCheckFailureKind,
  error: unknown
): string {
  return error instanceof Error
    ? `health_check:${kind}:${error.message}`
    : `health_check:${kind}`;
}

export function isActivePreLoopAttemptCancelled(
  activeAttempt: ActivePreLoopAttempt | null,
  attemptId: string
): boolean {
  return (
    !activeAttempt ||
    activeAttempt.attemptId !== attemptId ||
    activeAttempt.cancelled
  );
}

export function hasPreLoopAttemptBeenCancelled({
  activeAttempt,
  pendingAttempt,
  attemptId,
  openedDialog,
}: {
  activeAttempt: ActivePreLoopAttempt | null;
  pendingAttempt: PendingPreLoopAttempt | null;
  attemptId: string;
  openedDialog: boolean;
}): boolean {
  return (
    isActivePreLoopAttemptCancelled(activeAttempt, attemptId) ||
    (openedDialog && pendingAttempt?.attemptId !== attemptId)
  );
}

/** Clears the active attempt only when it is still the given one. */
export function clearActivePreLoopAttempt(
  activeAttemptRef: ActivePreLoopAttemptRef,
  attemptId: string
): boolean {
  if (activeAttemptRef.current?.attemptId === attemptId) {
    activeAttemptRef.current = null;
    return true;
  }
  return false;
}

export async function requireQueryData<T>(
  currentData: T | undefined,
  refetch: () => Promise<{ data: T | undefined; error: Error | null }>
): Promise<T> {
  if (currentData !== undefined) {
    return currentData;
  }

  const result = await refetch();
  if (result.error) {
    throw result.error;
  }
  if (result.data === undefined) {
    throw new Error("Required pre-loop query returned no data");
  }
  return result.data;
}

export type CapturePreLoopEvent = (
  event: PreLoopAnalyticsEvent,
  params: Parameters<typeof buildPreLoopAnalyticsProperties>[0]
) => void;

export type WarnAndBlockUnavailable = (args: {
  attemptId: string;
  metadata: PreLoopMetadata;
  target?: PreLoopTarget | null;
  reason: string;
  description?: string;
}) => PreLoopHealthCheckOutcome;

export async function resolveExplicitPreLoopExecutionContext({
  attemptId,
  capture,
  clearActiveAttempt,
  clearCheckingForAttempt,
  currentPreference,
  metadata,
  refetchPreference,
  warnAndBlockUnavailable,
}: {
  attemptId: string;
  capture: CapturePreLoopEvent;
  clearActiveAttempt: () => void;
  clearCheckingForAttempt: (attemptId: string) => void;
  currentPreference: ComputePreferenceResponse | undefined;
  metadata: PreLoopMetadata;
  refetchPreference: () => Promise<{
    data: ComputePreferenceResponse | undefined;
    error: Error | null;
  }>;
  warnAndBlockUnavailable: WarnAndBlockUnavailable;
}): Promise<{
  executionContext: PreLoopExecutionContext;
  outcome: PreLoopHealthCheckOutcome | null;
}> {
  if (metadata.computeTargetId !== undefined) {
    return {
      executionContext: { computeTargetId: metadata.computeTargetId },
      outcome: null,
    };
  }

  let preference: ComputePreferenceResponse;
  try {
    preference = await requireQueryData<ComputePreferenceResponse>(
      currentPreference,
      refetchPreference
    );
  } catch (error) {
    clearCheckingForAttempt(attemptId);
    clearActiveAttempt();
    return {
      executionContext: {},
      outcome: warnAndBlockUnavailable({
        attemptId,
        metadata,
        reason: formatUnavailableReason("compute_preference", error),
        description:
          "We could not verify your compute preference, so the command was not started. Try again after the page finishes loading.",
      }),
    };
  }

  if (preference.isExplicit !== true) {
    capture(PreLoopAnalyticsEvent.ComputeSelectionBlocked, {
      attemptId,
      metadata,
      reason: "missing_explicit_compute_selection",
    });
    toast.error(ComputePreferenceRequiredMessage);
    clearCheckingForAttempt(attemptId);
    clearActiveAttempt();
    return {
      executionContext: {},
      outcome: { status: "blocked_missing_compute_selection", attemptId },
    };
  }

  return {
    executionContext:
      preference.preferredComputeMode === ComputePreference.Cloud
        ? { computeTargetId: null }
        : {},
    outcome: null,
  };
}
