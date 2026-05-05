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

type ExecuteCallback = () => void;

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

type ActivePreLoopAttempt = {
  attemptId: string;
  metadata: PreLoopMetadata;
  target?: PreLoopTarget | null;
  failingRequiredFingerprint?: string;
  recheckAttempts: number;
  cancelled: boolean;
};

type ActivePreLoopAttemptRef = {
  current: ActivePreLoopAttempt | null;
};

type HealthCheckFetchResult = {
  data: HealthCheckResponse;
  healthCheckCacheAgeMs: number | null;
  usedCachedHealthCheck: boolean;
};

type UpdateActivePendingAttemptInput = {
  attemptId: string;
  metadata: PreLoopMetadata;
  target: PreLoopTarget;
  latestVersion: string | null;
  healthCheckData?: HealthCheckResponse;
  execute: ExecuteCallback;
  openedDialog: boolean;
};

type UpdatePendingAttemptInput = Pick<
  UpdateActivePendingAttemptInput,
  "target" | "latestVersion" | "healthCheckData"
>;

type AttemptBranchCallbacks = {
  wasCancelled: () => boolean;
  clearActiveAttempt: () => void;
};

const BLOCKING_DIALOG_CANCEL_DISMISS_MS = 250;

type CachedHealthCheckFetchResult = HealthCheckFetchResult & {
  dataUpdatedAt: number;
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

function formatUnavailableReason(scope: string, error: unknown): string {
  return error instanceof Error
    ? `${scope}:${error.message}`
    : `${scope}:unknown`;
}

function isActivePreLoopAttemptCancelled(
  activeAttempt: ActivePreLoopAttempt | null,
  attemptId: string
): boolean {
  return (
    !activeAttempt ||
    activeAttempt.attemptId !== attemptId ||
    activeAttempt.cancelled
  );
}

function hasPreLoopAttemptBeenCancelled({
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

function clearActivePreLoopAttempt(
  activeAttemptRef: ActivePreLoopAttemptRef,
  attemptId: string
): void {
  if (activeAttemptRef.current?.attemptId === attemptId) {
    activeAttemptRef.current = null;
  }
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
  const activeAttemptRef = useRef<ActivePreLoopAttempt | null>(null);
  const pendingAttemptRef = useRef<PendingPreLoopAttempt | null>(null);
  const pendingRemovalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
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

  const clearCheckingForAttempt = useCallback(
    (attemptId: string) => {
      const activeAttempt = activeAttemptRef.current;
      if (activeAttempt && activeAttempt.attemptId !== attemptId) {
        return;
      }
      clearChecking();
    },
    [clearChecking]
  );

  const clearPendingAttemptState = useCallback((delayMs = 0) => {
    if (pendingRemovalTimerRef.current) {
      clearTimeout(pendingRemovalTimerRef.current);
      pendingRemovalTimerRef.current = null;
    }

    if (delayMs > 0) {
      pendingRemovalTimerRef.current = setTimeout(() => {
        pendingRemovalTimerRef.current = null;
        setPendingAttempt(null);
      }, delayMs);
      return;
    }

    setPendingAttempt(null);
  }, []);

  const executeAttempt = useCallback(
    (attempt: PendingPreLoopAttempt) => {
      clearActivePreLoopAttempt(activeAttemptRef, attempt.attemptId);
      pendingAttemptRef.current = null;
      clearPendingAttemptState();
      attempt.execute();
    },
    [clearPendingAttemptState]
  );

  const warnAndBlockUnavailable = useCallback(
    ({
      attemptId,
      metadata,
      target,
      reason,
      description,
    }: {
      attemptId: string;
      metadata: PreLoopMetadata;
      target?: PreLoopTarget | null;
      reason: string;
      description?: string;
    }): PreLoopHealthCheckOutcome => {
      capture(PreLoopAnalyticsEvent.SystemCheckUnavailable, {
        attemptId,
        metadata,
        target,
        reason,
      });
      toast.warning("System check unavailable", {
        description:
          description ??
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
  }, [latestReleaseQuery.data, latestReleaseQuery.refetch]);

  const getFreshCachedHealthCheck = useCallback(
    ({
      target,
      latestVersion,
    }: {
      target: PreLoopTarget;
      latestVersion?: string | null;
    }): HealthCheckFetchResult | null => {
      const now = Date.now();
      const toCachedResult = (
        data: unknown,
        dataUpdatedAt: number
      ): CachedHealthCheckFetchResult | null => {
        if (
          data === undefined ||
          !isPreLoopHealthCheckFresh({ dataUpdatedAt, now })
        ) {
          return null;
        }

        return {
          data: data as HealthCheckResponse,
          dataUpdatedAt,
          healthCheckCacheAgeMs: now - dataUpdatedAt,
          usedCachedHealthCheck: true,
        };
      };

      if (latestVersion !== undefined) {
        const options = healthCheckOptions(target.targetKey, expectedMcpUrl, {
          relayTargetId: target.computeTargetId,
          latestVersion,
        });
        const queryState = queryClient.getQueryState<HealthCheckResponse>(
          options.queryKey
        );
        const cachedResult = toCachedResult(
          queryState?.data,
          queryState?.dataUpdatedAt ?? 0
        );
        if (!cachedResult) {
          return null;
        }

        const { dataUpdatedAt: _dataUpdatedAt, ...result } = cachedResult;
        return result;
      }

      const queryKeyPrefix = healthCheckOptions(
        target.targetKey,
        expectedMcpUrl,
        {
          relayTargetId: target.computeTargetId,
        }
      ).queryKey.slice(0, 3);
      const cachedResults = queryClient
        .getQueryCache()
        .findAll({ queryKey: queryKeyPrefix })
        .map((query) =>
          toCachedResult(query.state.data, query.state.dataUpdatedAt)
        )
        .filter((result): result is CachedHealthCheckFetchResult =>
          Boolean(result)
        )
        .sort((left, right) => right.dataUpdatedAt - left.dataUpdatedAt);

      const cachedResult = cachedResults[0];
      if (!cachedResult) {
        return null;
      }

      const { dataUpdatedAt: _dataUpdatedAt, ...result } = cachedResult;
      return result;
    },
    [expectedMcpUrl, queryClient]
  );

  const fetchHealthCheck = useCallback(
    async ({
      target,
      latestVersion,
    }: {
      target: PreLoopTarget;
      latestVersion: string | null;
    }): Promise<HealthCheckFetchResult> => {
      const cachedResult = getFreshCachedHealthCheck({
        target,
        latestVersion,
      });
      if (cachedResult) {
        return cachedResult;
      }

      const options = healthCheckOptions(target.targetKey, expectedMcpUrl, {
        relayTargetId: target.computeTargetId,
        latestVersion,
      });
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
    [expectedMcpUrl, getFreshCachedHealthCheck, queryClient]
  );

  const getFreshPassingCachedHealthCheck = useCallback(
    (
      target: PreLoopTarget,
      latestVersion?: string | null
    ): HealthCheckFetchResult | null => {
      const cachedResult = getFreshCachedHealthCheck({
        target,
        latestVersion,
      });
      if (!cachedResult) {
        return null;
      }

      if (
        getRequiredFailureSummary(cachedResult.data, expectedMcpUrl).checkIds
          .length > 0
      ) {
        return null;
      }

      return cachedResult;
    },
    [expectedMcpUrl, getFreshCachedHealthCheck]
  );

  const updateActivePendingAttempt = useCallback(
    ({
      attemptId,
      metadata,
      target,
      latestVersion,
      healthCheckData,
      execute,
      openedDialog,
    }: UpdateActivePendingAttemptInput): boolean => {
      if (
        isActivePreLoopAttemptCancelled(activeAttemptRef.current, attemptId)
      ) {
        return false;
      }

      const current = pendingAttemptRef.current;
      if (openedDialog && current?.attemptId !== attemptId) {
        return false;
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
      activeAttemptRef.current = {
        attemptId,
        metadata,
        target,
        failingRequiredFingerprint: nextAttempt.failingRequiredFingerprint,
        recheckAttempts: nextAttempt.recheckAttempts,
        cancelled: false,
      };
      pendingAttemptRef.current = nextAttempt;
      setPendingAttempt(nextAttempt);
      return true;
    },
    [expectedMcpUrl]
  );

  const finishSkippedNoLocalTarget = useCallback(
    ({
      attemptId,
      execute,
      wasCancelled,
      clearActiveAttempt,
    }: AttemptBranchCallbacks & {
      attemptId: string;
      execute: ExecuteCallback;
    }): PreLoopHealthCheckOutcome => {
      clearCheckingForAttempt(attemptId);
      if (wasCancelled()) {
        clearActiveAttempt();
        return { status: "cancelled", attemptId };
      }

      clearActiveAttempt();
      execute();
      return { status: "skipped_no_local_target", attemptId };
    },
    [clearCheckingForAttempt]
  );

  const finishUnavailablePreLoopEvaluation = useCallback(
    ({
      attemptId,
      metadata,
      evaluation,
      latestVersion,
      wasCancelled,
      clearActiveAttempt,
      updatePendingAttempt,
    }: AttemptBranchCallbacks & {
      attemptId: string;
      metadata: PreLoopMetadata;
      evaluation: Extract<PreLoopHealthEvaluation, { status: "unavailable" }>;
      latestVersion: string | null;
      updatePendingAttempt: (input: UpdatePendingAttemptInput) => void;
    }): PreLoopHealthCheckOutcome => {
      clearCheckingForAttempt(attemptId);
      if (wasCancelled()) {
        clearActiveAttempt();
        return { status: "cancelled", attemptId };
      }

      let openedUnavailableDialog = false;
      if (evaluation.target) {
        updatePendingAttempt({
          target: evaluation.target,
          latestVersion,
          healthCheckData: buildUnavailableHealthCheck(evaluation.reason),
        });
        openedUnavailableDialog = true;
      }

      const outcome = warnAndBlockUnavailable({
        attemptId,
        metadata,
        target: evaluation.target,
        reason: evaluation.reason,
      });
      if (!openedUnavailableDialog) {
        clearActiveAttempt();
      }
      return outcome;
    },
    [clearCheckingForAttempt, warnAndBlockUnavailable]
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
          reason: formatUnavailableReason("target_resolution", error),
        };
      }

      if (!target) {
        return { status: "skip_no_local_target" };
      }

      const hasPassingCacheForSelectedTarget = Boolean(
        getFreshPassingCachedHealthCheck(target)
      );
      if (!hasPassingCacheForSelectedTarget) {
        onTargetReady?.(target, null);
      }

      let latestVersion: string | null = null;
      try {
        latestVersion = await getLatestVersion();
      } catch (error) {
        return {
          status: "unavailable",
          target,
          reason: formatUnavailableReason("latest_release", error),
        };
      }

      const exactCachedResult = getFreshPassingCachedHealthCheck(
        target,
        latestVersion
      );
      if (exactCachedResult) {
        return {
          status: "available",
          target,
          latestVersion,
          healthResult: exactCachedResult,
        };
      }

      onTargetReady?.(target, latestVersion);

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
          reason: formatUnavailableReason("health_check", error),
        };
      }
    },
    [
      fetchHealthCheck,
      getFreshPassingCachedHealthCheck,
      getLatestVersion,
      resolveTarget,
    ]
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
      capture(PreLoopAnalyticsEvent.CommandAttempted, {
        attemptId,
        metadata,
      });
      if (!userId) {
        return warnAndBlockUnavailable({
          attemptId,
          metadata,
          reason: "auth_unavailable",
          description:
            "We could not verify your session, so the command was not started. Try again after the page finishes loading.",
        });
      }

      activeAttemptRef.current = {
        attemptId,
        metadata,
        target: null,
        recheckAttempts: 0,
        cancelled: false,
      };
      isCheckingRef.current = true;
      setIsChecking(true);

      let openedDialog = false;
      let latestVersionForAttempt: string | null = null;
      const clearActiveAttempt = () => {
        clearActivePreLoopAttempt(activeAttemptRef, attemptId);
      };
      const updatePendingAttempt = ({
        target,
        latestVersion,
        healthCheckData,
      }: {
        target: PreLoopTarget;
        latestVersion: string | null;
        healthCheckData?: HealthCheckResponse;
      }) => {
        const updated = updateActivePendingAttempt({
          attemptId,
          metadata,
          target,
          latestVersion,
          healthCheckData,
          execute,
          openedDialog,
        });
        if (updated) {
          latestVersionForAttempt = latestVersion;
          openedDialog = true;
        }
      };
      const wasDialogCancelled = () =>
        hasPreLoopAttemptBeenCancelled({
          activeAttempt: activeAttemptRef.current,
          pendingAttempt: pendingAttemptRef.current,
          attemptId,
          openedDialog,
        });

      const evaluation = await evaluatePreLoopTargetHealth(
        metadata,
        (target, latestVersion) => {
          updatePendingAttempt({ target, latestVersion });
        }
      );
      if (evaluation.status === "skip_no_local_target") {
        return finishSkippedNoLocalTarget({
          attemptId,
          execute,
          wasCancelled: wasDialogCancelled,
          clearActiveAttempt,
        });
      }
      if (evaluation.status === "unavailable") {
        return finishUnavailablePreLoopEvaluation({
          attemptId,
          metadata,
          evaluation,
          latestVersion: latestVersionForAttempt,
          wasCancelled: wasDialogCancelled,
          clearActiveAttempt,
          updatePendingAttempt,
        });
      }

      if (wasDialogCancelled()) {
        clearCheckingForAttempt(attemptId);
        clearActiveAttempt();
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
        clearActiveAttempt();
        pendingAttemptRef.current = null;
        clearPendingAttemptState();
        clearCheckingForAttempt(attemptId);
        execute();
        return { status: "executed", attemptId };
      }

      clearCheckingForAttempt(attemptId);
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
      clearCheckingForAttempt,
      clearPendingAttemptState,
      expectedMcpUrl,
      evaluatePreLoopTargetHealth,
      finishSkippedNoLocalTarget,
      finishUnavailablePreLoopEvaluation,
      updateActivePendingAttempt,
      userId,
      warnAndBlockUnavailable,
    ]
  );

  const cancelPendingAttempt = useCallback(
    (reason: string, ownerKey?: string) => {
      const pendingAttempt = pendingAttemptRef.current;
      const activeAttempt = activeAttemptRef.current;
      const metadata = pendingAttempt?.metadata ?? activeAttempt?.metadata;
      if (!metadata || (ownerKey && metadata.ownerKey !== ownerKey)) {
        return;
      }
      if (activeAttempt?.cancelled && !pendingAttempt) {
        return;
      }

      const attemptId = pendingAttempt?.attemptId ?? activeAttempt?.attemptId;
      if (!attemptId) {
        return;
      }
      const target = pendingAttempt?.target ?? activeAttempt?.target;
      const failingRequiredFingerprint =
        pendingAttempt?.failingRequiredFingerprint ??
        activeAttempt?.failingRequiredFingerprint;
      const recheckAttempts =
        pendingAttempt?.recheckAttempts ?? activeAttempt?.recheckAttempts ?? 0;

      capture(PreLoopAnalyticsEvent.SystemCheckCancelled, {
        attemptId,
        metadata,
        target,
        failingRequiredFingerprint,
        recheckAttempts,
        reason,
      });

      if (activeAttempt?.attemptId === attemptId) {
        activeAttemptRef.current = {
          ...activeAttempt,
          target,
          failingRequiredFingerprint,
          recheckAttempts,
          cancelled: true,
        };
      }
      pendingAttemptRef.current = null;
      clearPendingAttemptState(
        pendingAttempt ? BLOCKING_DIALOG_CANCEL_DISMISS_MS : 0
      );
      clearChecking();
    },
    [capture, clearChecking, clearPendingAttemptState]
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
      if (pendingRemovalTimerRef.current) {
        clearTimeout(pendingRemovalTimerRef.current);
        pendingRemovalTimerRef.current = null;
      }
      activeAttemptRef.current = null;
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
