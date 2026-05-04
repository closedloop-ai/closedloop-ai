"use client";

import { useAnalytics } from "@repo/analytics/client";
import {
  ComputePreference,
  type ComputePreferenceResponse,
  type ComputeTarget,
} from "@repo/api/src/types/compute-target";
import { useUser } from "@repo/auth/client";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { HealthCheckDialog } from "@/components/engineer/HealthCheckDialog";
import { env } from "@/env";
import { useComputePreference } from "@/hooks/queries/use-compute-preference";
import { useComputeTargets } from "@/hooks/queries/use-compute-targets";
import { useLatestElectronRelease } from "@/hooks/queries/use-electron-release";
import { resolveEffectiveComputeTargetSelection } from "@/lib/compute-target-selection";
import type { HealthCheckResponse } from "@/lib/engineer/queries/health-check";
import { healthCheckOptions } from "@/lib/engineer/queries/health-check";
import {
  buildPreLoopAnalyticsProperties,
  createPreLoopAttemptId,
  getPreLoopTargetKey,
  getRequiredFailureSummary,
  isPreLoopHealthCheckFresh,
  PRE_LOOP_HEALTH_CHECK_TIMEOUT_MS,
  PreLoopAnalyticsEvent,
  type PreLoopHealthCheckOutcome,
  type PreLoopMetadata,
  type PreLoopTarget,
} from "./pre-loop-health-check";

type ExecuteCallback = () => Promise<void> | void;

type PendingPreLoopAttempt = {
  attemptId: string;
  metadata: PreLoopMetadata;
  target: PreLoopTarget;
  healthCheckData?: HealthCheckResponse;
  latestVersion: string | null;
  failingRequiredFingerprint?: string;
  failingCheckIds: string[];
  recheckAttempts: number;
  execute: ExecuteCallback;
};

type HealthCheckFetchResult = {
  data: HealthCheckResponse;
  healthCheckCacheAgeMs: number | null;
  usedCachedHealthCheck: boolean;
};

type PreLoopHealthEvaluation =
  | { status: "skip_no_local_target" }
  | { status: "unavailable"; reason: string; target?: PreLoopTarget | null }
  | {
      status: "available";
      target: PreLoopTarget;
      latestVersion: string | null;
      healthResult: HealthCheckFetchResult;
    };

type PreLoopSystemCheckContextValue = {
  runWithPreLoopSystemCheck: (
    metadata: PreLoopMetadata,
    execute: ExecuteCallback
  ) => Promise<PreLoopHealthCheckOutcome>;
  cancelPendingPreLoopAttempt: (ownerKey: string) => void;
  isChecking: boolean;
  isDialogOpen: boolean;
  pendingOwnerKey: string | null;
  pendingCommand: PreLoopMetadata["command"] | null;
};

const PreLoopSystemCheckContext =
  createContext<PreLoopSystemCheckContextValue | null>(null);

function buildUnavailableHealthCheck(reason: string): HealthCheckResponse {
  return {
    checks: [
      {
        id: "pre-loop-health-check",
        label: "System Check",
        required: true,
        passed: false,
        error: "Unavailable",
        remediation: `Retry the system check. The command was not started. (${reason})`,
      },
    ],
    allRequiredPassed: false,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Pre-loop health check timed out"));
    }, timeoutMs);

    promise.then(resolve, reject).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    });
  });
}

function getTargetLabel(target: ComputeTarget): string {
  return target.machineName || target.ownerName || target.id;
}

async function requireQueryData<T>(
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

/**
 * Owns the global Generate/Execute pre-loop gate, pending command callback,
 * selected or explicitly requested target health lookup, and modal bridge.
 */
export function PreLoopSystemCheckProvider({
  children,
}: Readonly<{ children: ReactNode }>) {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const { user } = useUser();
  const userId = user?.id ?? "";
  const expectedMcpUrl = env.NEXT_PUBLIC_MCP_SERVER_URL ?? null;
  const isCheckingRef = useRef(false);
  const pendingAttemptRef = useRef<PendingPreLoopAttempt | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [pendingAttempt, setPendingAttempt] =
    useState<PendingPreLoopAttempt | null>(null);

  const computePreferenceQuery = useComputePreference(userId, {
    enabled: Boolean(pendingAttempt && userId),
  });
  const computeTargetsQuery = useComputeTargets({
    enabled: Boolean(pendingAttempt),
  });
  const latestReleaseQuery = useLatestElectronRelease({
    enabled: false,
  });

  useEffect(() => {
    pendingAttemptRef.current = pendingAttempt;
  }, [pendingAttempt]);

  const capture = useCallback(
    (
      event: PreLoopAnalyticsEvent,
      params: Parameters<typeof buildPreLoopAnalyticsProperties>[0]
    ) => {
      analytics.capture(event, buildPreLoopAnalyticsProperties(params));
    },
    [analytics]
  );

  const clearChecking = useCallback(() => {
    isCheckingRef.current = false;
    setIsChecking(false);
  }, []);

  const executeAttempt = useCallback((attempt: PendingPreLoopAttempt) => {
    pendingAttemptRef.current = null;
    setPendingAttempt(null);
    attempt.execute();
  }, []);

  const warnAndBlockUnavailable = useCallback(
    ({
      attemptId,
      metadata,
      target,
      reason,
    }: {
      attemptId: string;
      metadata: PreLoopMetadata;
      target?: PreLoopTarget | null;
      reason: string;
    }): PreLoopHealthCheckOutcome => {
      capture(PreLoopAnalyticsEvent.SystemCheckUnavailable, {
        attemptId,
        metadata,
        target,
        reason,
      });
      toast.warning("System check unavailable", {
        description:
          "We could not verify the selected local compute target, so the command was not started.",
      });
      return { status: "blocked_unavailable", attemptId };
    },
    [capture]
  );

  const resolveTarget = useCallback(
    async (
      requestedComputeTargetId?: string | null
    ): Promise<PreLoopTarget | null> => {
      if (requestedComputeTargetId === null) {
        return null;
      }
      if (requestedComputeTargetId === undefined && !userId) {
        return null;
      }

      const targets = await requireQueryData<ComputeTarget[]>(
        computeTargetsQuery.data,
        async () => {
          const result = await computeTargetsQuery.refetch();
          return {
            data: result.data,
            error: result.error instanceof Error ? result.error : null,
          };
        }
      );

      if (requestedComputeTargetId !== undefined) {
        const requestedTarget = targets.find(
          (target) => target.id === requestedComputeTargetId
        );
        if (!requestedTarget) {
          throw new Error(
            `Requested compute target ${requestedComputeTargetId} was not found`
          );
        }
        return {
          targetKey: getPreLoopTargetKey(requestedComputeTargetId),
          computeTargetId: requestedComputeTargetId,
          label: getTargetLabel(requestedTarget),
          mode: "local_compute_target",
        };
      }

      if (!userId) {
        return null;
      }

      const preference = await requireQueryData<ComputePreferenceResponse>(
        computePreferenceQuery.data,
        async () => {
          const result = await computePreferenceQuery.refetch();
          return {
            data: result.data,
            error: result.error instanceof Error ? result.error : null,
          };
        }
      );

      const selection = resolveEffectiveComputeTargetSelection({
        preference,
        targets,
      });
      if (
        selection.currentPreference === ComputePreference.Cloud ||
        selection.effectiveTargetId === null ||
        selection.effectiveTarget === null
      ) {
        return null;
      }

      return {
        targetKey: getPreLoopTargetKey(selection.effectiveTargetId),
        computeTargetId: selection.effectiveTargetId,
        label: getTargetLabel(selection.effectiveTarget),
        mode: "local_compute_target",
      };
    },
    [
      computePreferenceQuery.data,
      computePreferenceQuery.refetch,
      computeTargetsQuery.data,
      computeTargetsQuery.refetch,
      userId,
    ]
  );

  const getLatestVersion = useCallback(async (): Promise<string | null> => {
    if (latestReleaseQuery.data) {
      return latestReleaseQuery.data.version ?? null;
    }
    const result = await latestReleaseQuery.refetch();
    if (result.error) {
      throw result.error;
    }
    return result.data?.version ?? null;
  }, [latestReleaseQuery]);

  const fetchHealthCheck = useCallback(
    async ({
      target,
      latestVersion,
    }: {
      target: PreLoopTarget;
      latestVersion: string | null;
    }): Promise<HealthCheckFetchResult> => {
      const options = healthCheckOptions(target.targetKey, expectedMcpUrl, {
        relayTargetId: target.computeTargetId,
        latestVersion,
      });
      const queryState = queryClient.getQueryState<HealthCheckResponse>(
        options.queryKey
      );
      const now = Date.now();

      if (
        queryState?.data &&
        isPreLoopHealthCheckFresh({
          dataUpdatedAt: queryState.dataUpdatedAt,
          now,
        })
      ) {
        return {
          data: queryState.data,
          healthCheckCacheAgeMs: now - queryState.dataUpdatedAt,
          usedCachedHealthCheck: true,
        };
      }

      const data = await withTimeout(
        queryClient.fetchQuery(options),
        PRE_LOOP_HEALTH_CHECK_TIMEOUT_MS
      );
      return {
        data,
        healthCheckCacheAgeMs: null,
        usedCachedHealthCheck: false,
      };
    },
    [expectedMcpUrl, queryClient]
  );

  const evaluatePreLoopTargetHealth = useCallback(
    async (
      metadata: PreLoopMetadata,
      onTargetReady?: (
        target: PreLoopTarget,
        latestVersion: string | null
      ) => void
    ): Promise<PreLoopHealthEvaluation> => {
      let target: PreLoopTarget | null = null;
      try {
        target = await resolveTarget(metadata.computeTargetId);
      } catch (error) {
        return {
          status: "unavailable",
          reason:
            error instanceof Error
              ? `target_resolution:${error.message}`
              : "target_resolution:unknown",
        };
      }

      if (!target) {
        return { status: "skip_no_local_target" };
      }

      onTargetReady?.(target, null);

      let latestVersion: string | null = null;
      try {
        latestVersion = await getLatestVersion();
        onTargetReady?.(target, latestVersion);
      } catch (error) {
        return {
          status: "unavailable",
          target,
          reason:
            error instanceof Error
              ? `latest_release:${error.message}`
              : "latest_release:unknown",
        };
      }

      try {
        return {
          status: "available",
          target,
          latestVersion,
          healthResult: await fetchHealthCheck({ target, latestVersion }),
        };
      } catch (error) {
        return {
          status: "unavailable",
          target,
          reason:
            error instanceof Error
              ? `health_check:${error.message}`
              : "health_check:unknown",
        };
      }
    },
    [fetchHealthCheck, getLatestVersion, resolveTarget]
  );

  const runWithPreLoopSystemCheck = useCallback(
    async (
      metadata: PreLoopMetadata,
      execute: ExecuteCallback
    ): Promise<PreLoopHealthCheckOutcome> => {
      if (isCheckingRef.current || pendingAttemptRef.current) {
        return { status: "duplicate_ignored", attemptId: null };
      }

      const attemptId = createPreLoopAttemptId();
      isCheckingRef.current = true;
      setIsChecking(true);
      capture(PreLoopAnalyticsEvent.CommandAttempted, {
        attemptId,
        metadata,
      });

      let openedDialog = false;
      let latestVersionForAttempt: string | null = null;
      const updatePendingAttempt = ({
        target,
        latestVersion,
        healthCheckData,
      }: {
        target: PreLoopTarget;
        latestVersion: string | null;
        healthCheckData?: HealthCheckResponse;
      }) => {
        latestVersionForAttempt = latestVersion;
        const current = pendingAttemptRef.current;
        if (openedDialog && current?.attemptId !== attemptId) {
          return;
        }

        const summary = healthCheckData
          ? getRequiredFailureSummary(healthCheckData, expectedMcpUrl)
          : null;
        const nextAttempt = {
          attemptId,
          metadata,
          target,
          healthCheckData: healthCheckData ?? current?.healthCheckData,
          latestVersion,
          failingRequiredFingerprint:
            summary?.fingerprint ?? current?.failingRequiredFingerprint,
          failingCheckIds: summary?.checkIds ?? current?.failingCheckIds ?? [],
          recheckAttempts: current?.recheckAttempts ?? 0,
          execute,
        };
        openedDialog = true;
        pendingAttemptRef.current = nextAttempt;
        setPendingAttempt(nextAttempt);
      };
      const wasDialogCancelled = () =>
        openedDialog && pendingAttemptRef.current?.attemptId !== attemptId;

      const evaluation = await evaluatePreLoopTargetHealth(
        metadata,
        (target, latestVersion) => {
          updatePendingAttempt({ target, latestVersion });
        }
      );
      if (evaluation.status === "skip_no_local_target") {
        clearChecking();
        execute();
        return { status: "skipped_no_local_target", attemptId };
      }
      if (evaluation.status === "unavailable") {
        clearChecking();
        if (wasDialogCancelled()) {
          return { status: "cancelled", attemptId };
        }
        if (evaluation.target) {
          const healthCheckData = buildUnavailableHealthCheck(
            evaluation.reason
          );
          updatePendingAttempt({
            target: evaluation.target,
            latestVersion: latestVersionForAttempt,
            healthCheckData,
          });
        }
        return warnAndBlockUnavailable({
          attemptId,
          metadata,
          target: evaluation.target,
          reason: evaluation.reason,
        });
      }

      if (wasDialogCancelled()) {
        clearChecking();
        return { status: "cancelled", attemptId };
      }

      const { healthResult, latestVersion, target } = evaluation;
      const summary = getRequiredFailureSummary(
        healthResult.data,
        expectedMcpUrl
      );
      const analyticsBase = {
        attemptId,
        metadata,
        target,
        healthCheckCacheAgeMs: healthResult.healthCheckCacheAgeMs,
        usedCachedHealthCheck: healthResult.usedCachedHealthCheck,
        failingChecks: summary.checks,
        failingRequiredFingerprint: summary.fingerprint,
      };

      if (summary.checkIds.length === 0) {
        pendingAttemptRef.current = null;
        setPendingAttempt(null);
        clearChecking();
        execute();
        return { status: "executed", attemptId };
      }

      clearChecking();
      updatePendingAttempt({
        target,
        healthCheckData: healthResult.data,
        latestVersion,
      });
      capture(PreLoopAnalyticsEvent.SystemCheckBlocked, analyticsBase);
      return { status: "blocked", attemptId };
    },
    [
      capture,
      clearChecking,
      expectedMcpUrl,
      warnAndBlockUnavailable,
      evaluatePreLoopTargetHealth,
    ]
  );

  const cancelPendingAttempt = useCallback(
    (reason: string, ownerKey?: string) => {
      const attempt = pendingAttemptRef.current;
      if (!attempt || (ownerKey && attempt.metadata.ownerKey !== ownerKey)) {
        return;
      }
      capture(PreLoopAnalyticsEvent.SystemCheckCancelled, {
        attemptId: attempt.attemptId,
        metadata: attempt.metadata,
        target: attempt.target,
        failingRequiredFingerprint: attempt.failingRequiredFingerprint,
        recheckAttempts: attempt.recheckAttempts,
        reason,
      });
      pendingAttemptRef.current = null;
      setPendingAttempt(null);
    },
    [capture]
  );

  const cancelPendingPreLoopAttempt = useCallback(
    (ownerKey: string) => {
      cancelPendingAttempt("owner_cancelled", ownerKey);
    },
    [cancelPendingAttempt]
  );

  const handleRecheckClick = useCallback(() => {
    const attempt = pendingAttemptRef.current;
    if (!attempt) {
      return;
    }
    capture(PreLoopAnalyticsEvent.SystemCheckRecheckClicked, {
      attemptId: attempt.attemptId,
      metadata: attempt.metadata,
      target: attempt.target,
      failingRequiredFingerprint: attempt.failingRequiredFingerprint,
      recheckAttempts: attempt.recheckAttempts + 1,
    });
  }, [capture]);

  const handleRecheckResult = useCallback(
    (data: HealthCheckResponse) => {
      const attempt = pendingAttemptRef.current;
      if (!attempt) {
        return;
      }
      const summary = getRequiredFailureSummary(data, expectedMcpUrl);
      const nextAttempt = {
        ...attempt,
        healthCheckData: data,
        failingRequiredFingerprint: summary.fingerprint,
        failingCheckIds: summary.checkIds,
        recheckAttempts: attempt.recheckAttempts + 1,
      };
      pendingAttemptRef.current = nextAttempt;
      setPendingAttempt(nextAttempt);
    },
    [expectedMcpUrl]
  );

  const handleRecheckUnavailable = useCallback(
    (reason: string) => {
      const attempt = pendingAttemptRef.current;
      if (!attempt) {
        return;
      }
      const nextAttempt = {
        ...attempt,
        recheckAttempts: attempt.recheckAttempts + 1,
      };
      pendingAttemptRef.current = nextAttempt;
      setPendingAttempt(nextAttempt);
      capture(PreLoopAnalyticsEvent.SystemCheckUnavailable, {
        attemptId: attempt.attemptId,
        metadata: attempt.metadata,
        target: attempt.target,
        failingRequiredFingerprint: attempt.failingRequiredFingerprint,
        failingChecks: getRequiredFailureSummary(
          attempt.healthCheckData,
          expectedMcpUrl
        ).checks,
        recheckAttempts: nextAttempt.recheckAttempts,
        reason: `recheck:${reason}`,
      });
      toast.warning("System check unavailable", {
        description:
          "We could not re-run the selected local compute target check. Fix the failing checks and try again.",
      });
    },
    [capture, expectedMcpUrl]
  );

  const handleResolvedAfterRecheck = useCallback(() => {
    const attempt = pendingAttemptRef.current;
    if (!attempt) {
      return;
    }
    capture(PreLoopAnalyticsEvent.SystemCheckResolved, {
      attemptId: attempt.attemptId,
      metadata: attempt.metadata,
      target: attempt.target,
      recheckAttempts: attempt.recheckAttempts,
    });
    executeAttempt(attempt);
  }, [capture, executeAttempt]);

  useEffect(() => {
    const latestPreference = computePreferenceQuery.data;
    const latestTargets = computeTargetsQuery.data;
    if (!pendingAttempt) {
      return;
    }
    if (pendingAttempt.metadata.computeTargetId !== undefined) {
      return;
    }
    if (!latestPreference) {
      return;
    }
    if (!latestTargets) {
      return;
    }

    const selection = resolveEffectiveComputeTargetSelection({
      preference: latestPreference,
      targets: latestTargets,
    });
    if (
      selection.currentPreference !== ComputePreference.Local ||
      selection.effectiveTargetId !== pendingAttempt.target.computeTargetId
    ) {
      cancelPendingAttempt("target_changed");
    }
  }, [
    cancelPendingAttempt,
    computePreferenceQuery.data,
    computeTargetsQuery.data,
    pendingAttempt,
  ]);

  useEffect(() => {
    return () => {
      pendingAttemptRef.current = null;
      isCheckingRef.current = false;
    };
  }, []);

  const contextValue = useMemo<PreLoopSystemCheckContextValue>(
    () => ({
      runWithPreLoopSystemCheck,
      cancelPendingPreLoopAttempt,
      isChecking,
      isDialogOpen: pendingAttempt !== null,
      pendingOwnerKey: pendingAttempt?.metadata.ownerKey ?? null,
      pendingCommand: pendingAttempt?.metadata.command ?? null,
    }),
    [
      cancelPendingPreLoopAttempt,
      isChecking,
      pendingAttempt,
      runWithPreLoopSystemCheck,
    ]
  );

  return (
    <PreLoopSystemCheckContext.Provider value={contextValue}>
      {children}
      {pendingAttempt ? (
        <HealthCheckDialog
          initialData={pendingAttempt.healthCheckData}
          latestVersionOverride={pendingAttempt.latestVersion}
          mode="blocking-pre-loop"
          onCancel={() => cancelPendingAttempt("dialog_cancelled")}
          onRecheckClick={handleRecheckClick}
          onRecheckResult={handleRecheckResult}
          onRecheckUnavailable={handleRecheckUnavailable}
          onResolvedAfterRecheck={handleResolvedAfterRecheck}
          relayTargetId={pendingAttempt.target.computeTargetId}
          targetKey={pendingAttempt.target.targetKey}
          targetLabel={pendingAttempt.target.label}
        />
      ) : null}
    </PreLoopSystemCheckContext.Provider>
  );
}

/** Returns the pre-loop gate controller for Plan/Execute callers. */
export function usePreLoopSystemCheckGate(): PreLoopSystemCheckContextValue {
  const context = useContext(PreLoopSystemCheckContext);
  if (!context) {
    throw new Error(
      "usePreLoopSystemCheckGate must be used within PreLoopSystemCheckProvider"
    );
  }
  return context;
}

/** Returns the pre-loop gate controller when the provider is mounted. */
export function useOptionalPreLoopSystemCheckGate(): PreLoopSystemCheckContextValue | null {
  return useContext(PreLoopSystemCheckContext);
}
