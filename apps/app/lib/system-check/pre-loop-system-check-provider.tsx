"use client";

import { useAnalytics, useFeatureFlag } from "@repo/analytics/client";
import {
  ComputePreference,
  ComputePreferenceRequiredMessage,
  type ComputePreferenceResponse,
  type ComputeTarget,
  type ComputeTargetHealthCheckSnapshot,
  EXPLICIT_COMPUTE_SELECTION_FEATURE_FLAG_KEY,
} from "@repo/api/src/types/compute-target";
import { useComputePreference } from "@repo/app/compute/hooks/use-compute-preference";
import { useLatestElectronRelease } from "@repo/app/desktop/hooks/use-electron-release";
import { resolveEffectiveComputeTargetSelection } from "@repo/app/loops/lib/compute-target-selection";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
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
import { HEALTH_CHECK_AUTO_UPDATE_QUERY_SEGMENT } from "@/hooks/queries/compute-target-query-keys";
import {
  computeTargetHealthCheckSnapshotQueryOptions,
  useComputeTargets,
} from "@/hooks/queries/use-compute-targets";
import { useApiClient } from "@/hooks/use-api-client";
import type { HealthCheckResponse } from "@/lib/engineer/queries/health-check";
import { healthCheckOptions } from "@/lib/engineer/queries/health-check";
import { getHealthCheckCacheAgeMs } from "./health-check-freshness";
import { getPreLoopHealthCheckTimeoutMs } from "./health-check-timeouts";
import { PLUGIN_AUTO_UPDATE_FEATURE_FLAG_KEY } from "./plugin-auto-update";
import {
  buildPreLoopAnalyticsProperties,
  createPreLoopAttemptId,
  getPreLoopTargetKey,
  getRequiredFailureSummary,
  isPreLoopHealthCheckFresh,
  PreLoopAnalyticsEvent,
  type PreLoopExecutionContext,
  type PreLoopHealthCheckOutcome,
  type PreLoopMetadata,
  type PreLoopTarget,
} from "./pre-loop-health-check";

type ExecuteCallback = (
  context: PreLoopExecutionContext
) => void | Promise<void>;

type PendingPreLoopAttempt = {
  attemptId: string;
  metadata: PreLoopMetadata;
  target: PreLoopTarget;
  healthCheckData?: HealthCheckResponse;
  latestVersion: string | null;
  pluginAutoUpdateEnabled: boolean;
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
  latestVersion: string | null;
  usedCachedHealthCheck: boolean;
};

type UpdateActivePendingAttemptInput = {
  attemptId: string;
  metadata: PreLoopMetadata;
  target: PreLoopTarget;
  latestVersion: string | null;
  pluginAutoUpdateEnabled: boolean;
  healthCheckData?: HealthCheckResponse;
  execute: ExecuteCallback;
  openedDialog: boolean;
};

type UpdatePendingAttemptInput = Pick<
  UpdateActivePendingAttemptInput,
  "target" | "latestVersion" | "healthCheckData"
> & { pluginAutoUpdateEnabled: boolean };

type AttemptBranchCallbacks = {
  wasCancelled: () => boolean;
  clearActiveAttempt: () => void;
};

const BLOCKING_DIALOG_CANCEL_DISMISS_MS = 250;

type CachedHealthCheckFetchResult = HealthCheckFetchResult & {
  dataUpdatedAt: number;
};

function getLatestVersionFromHealthCheckQueryKey(
  queryKey: readonly unknown[]
): string | null {
  const latestVersion = queryKey[3];
  return typeof latestVersion === "string" && latestVersion.length > 0
    ? latestVersion
    : null;
}

type PreLoopHealthEvaluation =
  | { status: "skip_no_local_target" }
  | {
      status: "unavailable";
      reason: string;
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

type CapturePreLoopEvent = (
  event: PreLoopAnalyticsEvent,
  params: Parameters<typeof buildPreLoopAnalyticsProperties>[0]
) => void;

type WarnAndBlockUnavailable = (args: {
  attemptId: string;
  metadata: PreLoopMetadata;
  target?: PreLoopTarget | null;
  reason: string;
  description?: string;
}) => PreLoopHealthCheckOutcome;

async function resolveExplicitPreLoopExecutionContext({
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

/**
 * Owns the global Generate/Execute pre-loop gate, pending command callback,
 * selected or explicitly requested target health lookup, and modal bridge.
 */
export function PreLoopSystemCheckProvider({
  children,
}: Readonly<{ children: ReactNode }>) {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const apiClient = useApiClient();
  const pluginAutoUpdateFlag = useFeatureFlag(
    PLUGIN_AUTO_UPDATE_FEATURE_FLAG_KEY
  );
  const pluginAutoUpdateFlagEnabled =
    Boolean(env.NEXT_PUBLIC_POSTHOG_KEY) &&
    pluginAutoUpdateFlag?.enabled === true;
  const { user } = useUser();
  const userId = user?.id ?? "";
  const requireExplicitSelection = useFeatureFlagEnabled(
    EXPLICIT_COMPUTE_SELECTION_FEATURE_FLAG_KEY
  );
  const expectedMcpUrl = env.NEXT_PUBLIC_MCP_SERVER_URL ?? null;
  const isCheckingRef = useRef(false);
  const activeAttemptRef = useRef<ActivePreLoopAttempt | null>(null);
  const pendingAttemptRef = useRef<PendingPreLoopAttempt | null>(null);
  const pendingRemovalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const [isChecking, setIsChecking] = useState(false);
  const [activeAttemptTarget, setActiveAttemptTarget] =
    useState<PreLoopTarget | null>(null);
  const [pendingAttempt, setPendingAttempt] =
    useState<PendingPreLoopAttempt | null>(null);

  const computePreferenceQuery = useComputePreference(userId, {
    enabled: Boolean((pendingAttempt || activeAttemptTarget) && userId),
  });
  const computeTargetsQuery = useComputeTargets({
    enabled: Boolean(pendingAttempt || activeAttemptTarget),
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

  const recordActiveAttemptTarget = useCallback(
    (attemptId: string, target: PreLoopTarget) => {
      const activeAttempt = activeAttemptRef.current;
      if (
        !activeAttempt ||
        activeAttempt.attemptId !== attemptId ||
        activeAttempt.cancelled
      ) {
        return;
      }
      activeAttemptRef.current = {
        ...activeAttempt,
        target,
      };
      setActiveAttemptTarget(target);
    },
    []
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
      setActiveAttemptTarget(null);
      pendingAttemptRef.current = null;
      clearPendingAttemptState();
      attempt.execute({ computeTargetId: attempt.target.computeTargetId });
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
          isOnline: requestedTarget.isOnline,
          isOwnedByCurrentUser: !requestedTarget.ownerName,
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
        isOnline: selection.effectiveTarget.isOnline,
        isOwnedByCurrentUser: !selection.effectiveTarget.ownerName,
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
      pluginAutoUpdateEnabled,
    }: {
      target: PreLoopTarget;
      latestVersion?: string | null;
      pluginAutoUpdateEnabled: boolean;
    }): HealthCheckFetchResult | null => {
      const now = Date.now();
      const toCachedResult = ({
        data,
        dataUpdatedAt,
        latestVersion,
        entryPluginAutoUpdateEnabled,
      }: {
        data: unknown;
        dataUpdatedAt: number;
        latestVersion: string | null;
        entryPluginAutoUpdateEnabled: boolean;
      }): CachedHealthCheckFetchResult | null => {
        const healthCheckData = data as HealthCheckResponse | undefined;
        if (
          healthCheckData === undefined ||
          !isPreLoopHealthCheckFresh({
            entry: {
              data: healthCheckData,
              checkedAt: dataUpdatedAt,
              expectedMcpUrl,
              latestVersion,
              pluginAutoUpdateEnabled: entryPluginAutoUpdateEnabled,
            },
            expectedMcpUrl,
            latestVersion,
            pluginAutoUpdateEnabled,
            now,
          })
        ) {
          return null;
        }

        return {
          data: healthCheckData,
          dataUpdatedAt,
          healthCheckCacheAgeMs: now - dataUpdatedAt,
          latestVersion,
          usedCachedHealthCheck: true,
        };
      };

      if (latestVersion !== undefined) {
        const options = healthCheckOptions(target.targetKey, expectedMcpUrl, {
          relayTargetId: target.computeTargetId,
          latestVersion,
          pluginAutoUpdateEnabled,
        });
        const queryState = queryClient.getQueryState<HealthCheckResponse>(
          options.queryKey
        );
        const cachedResult = toCachedResult({
          data: queryState?.data,
          dataUpdatedAt: queryState?.dataUpdatedAt ?? 0,
          latestVersion,
          entryPluginAutoUpdateEnabled: pluginAutoUpdateEnabled,
        });
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
          pluginAutoUpdateEnabled,
        }
      ).queryKey.slice(0, 3);
      const cachedResults = queryClient
        .getQueryCache()
        .findAll({ queryKey: queryKeyPrefix })
        .map((query) =>
          toCachedResult({
            data: query.state.data,
            dataUpdatedAt: query.state.dataUpdatedAt,
            latestVersion: getLatestVersionFromHealthCheckQueryKey(
              query.queryKey
            ),
            entryPluginAutoUpdateEnabled:
              query.queryKey[4] === HEALTH_CHECK_AUTO_UPDATE_QUERY_SEGMENT,
          })
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

  const getFreshPersistedHealthCheck = useCallback(
    async ({
      target,
      latestVersion,
      pluginAutoUpdateEnabled,
    }: {
      target: PreLoopTarget;
      latestVersion: string | null;
      pluginAutoUpdateEnabled: boolean;
    }): Promise<HealthCheckFetchResult | null> => {
      if (!target.isOnline) {
        return null;
      }

      const snapshotOptions = computeTargetHealthCheckSnapshotQueryOptions(
        apiClient,
        target.computeTargetId,
        pluginAutoUpdateEnabled
      );
      const cachedSnapshot =
        queryClient.getQueryData<ComputeTargetHealthCheckSnapshot | null>(
          snapshotOptions.queryKey
        );
      const snapshot =
        cachedSnapshot === undefined
          ? await queryClient.fetchQuery<ComputeTargetHealthCheckSnapshot | null>(
              snapshotOptions
            )
          : cachedSnapshot;
      if (!snapshot) {
        return null;
      }

      const entry = {
        data: snapshot.result,
        checkedAt: snapshot.checkedAt,
        expectedMcpUrl: snapshot.expectedMcpUrl,
        latestVersion: snapshot.latestVersion,
        pluginAutoUpdateEnabled: snapshot.pluginAutoUpdateEnabled,
      };
      if (
        !isPreLoopHealthCheckFresh({
          entry,
          expectedMcpUrl,
          latestVersion,
          pluginAutoUpdateEnabled,
        })
      ) {
        return null;
      }

      const queryLatestVersion = snapshot.latestVersion ?? latestVersion;
      queryClient.setQueryData(
        healthCheckOptions(target.targetKey, expectedMcpUrl, {
          relayTargetId: target.computeTargetId,
          latestVersion: queryLatestVersion,
          pluginAutoUpdateEnabled,
        }).queryKey,
        snapshot.result,
        { updatedAt: snapshot.checkedAt.getTime() }
      );

      return {
        data: snapshot.result,
        healthCheckCacheAgeMs: getHealthCheckCacheAgeMs(entry),
        latestVersion: queryLatestVersion,
        usedCachedHealthCheck: true,
      };
    },
    [apiClient, expectedMcpUrl, queryClient]
  );

  const fetchHealthCheck = useCallback(
    async ({
      target,
      latestVersion,
      pluginAutoUpdateEnabled,
    }: {
      target: PreLoopTarget;
      latestVersion: string | null;
      pluginAutoUpdateEnabled: boolean;
    }): Promise<HealthCheckFetchResult> => {
      const cachedResult = getFreshCachedHealthCheck({
        target,
        latestVersion,
        pluginAutoUpdateEnabled,
      });
      if (cachedResult) {
        return cachedResult;
      }

      const persistedResult = await getFreshPersistedHealthCheck({
        target,
        latestVersion,
        pluginAutoUpdateEnabled,
      });
      if (persistedResult) {
        return persistedResult;
      }

      const options = healthCheckOptions(target.targetKey, expectedMcpUrl, {
        relayTargetId: target.computeTargetId,
        latestVersion,
        pluginAutoUpdateEnabled,
      });
      const data = await withTimeout(
        queryClient.fetchQuery(options),
        getPreLoopHealthCheckTimeoutMs(pluginAutoUpdateEnabled)
      );
      return {
        data,
        healthCheckCacheAgeMs: null,
        latestVersion,
        usedCachedHealthCheck: false,
      };
    },
    [
      expectedMcpUrl,
      getFreshCachedHealthCheck,
      getFreshPersistedHealthCheck,
      queryClient,
    ]
  );

  const updateActivePendingAttempt = useCallback(
    ({
      attemptId,
      metadata,
      target,
      latestVersion,
      pluginAutoUpdateEnabled,
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
        pluginAutoUpdateEnabled,
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
      setActiveAttemptTarget(target);
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
      executionContext,
      wasCancelled,
      clearActiveAttempt,
    }: AttemptBranchCallbacks & {
      attemptId: string;
      execute: ExecuteCallback;
      executionContext: PreLoopExecutionContext;
    }): PreLoopHealthCheckOutcome => {
      clearCheckingForAttempt(attemptId);
      if (wasCancelled()) {
        clearActiveAttempt();
        return { status: "cancelled", attemptId };
      }

      clearActiveAttempt();
      execute(executionContext);
      return { status: "skipped_no_local_target", attemptId };
    },
    [clearCheckingForAttempt]
  );

  const finishUnavailablePreLoopEvaluation = useCallback(
    ({
      attemptId,
      metadata,
      evaluation,
      wasCancelled,
      clearActiveAttempt,
      updatePendingAttempt,
    }: AttemptBranchCallbacks & {
      attemptId: string;
      metadata: PreLoopMetadata;
      evaluation: Extract<PreLoopHealthEvaluation, { status: "unavailable" }>;
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
          latestVersion: evaluation.latestVersion ?? null,
          pluginAutoUpdateEnabled: evaluation.pluginAutoUpdateEnabled ?? false,
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
      attemptId: string
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
      recordActiveAttemptTarget(attemptId, target);

      if (!target.isOnline) {
        return {
          status: "unavailable",
          target,
          reason: "target_offline",
          pluginAutoUpdateEnabled: false,
        };
      }

      const pluginAutoUpdateEnabled =
        pluginAutoUpdateFlagEnabled && target.isOwnedByCurrentUser;

      let latestVersion: string | null = null;
      try {
        latestVersion = await getLatestVersion();
      } catch (error) {
        return {
          status: "unavailable",
          target,
          reason: formatUnavailableReason("latest_release", error),
          pluginAutoUpdateEnabled,
        };
      }

      const cachedResult = getFreshCachedHealthCheck({
        target,
        latestVersion,
        pluginAutoUpdateEnabled,
      });
      if (cachedResult) {
        return {
          status: "available",
          target,
          latestVersion,
          pluginAutoUpdateEnabled,
          healthResult: cachedResult,
        };
      }

      try {
        return {
          status: "available",
          target,
          latestVersion,
          pluginAutoUpdateEnabled,
          healthResult: await fetchHealthCheck({
            target,
            latestVersion,
            pluginAutoUpdateEnabled,
          }),
        };
      } catch (error) {
        return {
          status: "unavailable",
          target,
          latestVersion,
          reason: formatUnavailableReason("health_check", error),
          pluginAutoUpdateEnabled,
        };
      }
    },
    [
      fetchHealthCheck,
      getFreshCachedHealthCheck,
      getLatestVersion,
      pluginAutoUpdateFlagEnabled,
      recordActiveAttemptTarget,
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
      setActiveAttemptTarget(null);
      isCheckingRef.current = true;
      setIsChecking(true);

      let openedDialog = false;
      const clearActiveAttempt = () => {
        clearActivePreLoopAttempt(activeAttemptRef, attemptId);
        setActiveAttemptTarget(null);
      };
      const updatePendingAttempt = ({
        target,
        latestVersion,
        pluginAutoUpdateEnabled,
        healthCheckData,
      }: {
        target: PreLoopTarget;
        latestVersion: string | null;
        pluginAutoUpdateEnabled: boolean;
        healthCheckData?: HealthCheckResponse;
      }) => {
        const updated = updateActivePendingAttempt({
          attemptId,
          metadata,
          target,
          latestVersion,
          pluginAutoUpdateEnabled,
          healthCheckData,
          execute,
          openedDialog,
        });
        openedDialog = updated || openedDialog;
      };
      const wasDialogCancelled = () =>
        hasPreLoopAttemptBeenCancelled({
          activeAttempt: activeAttemptRef.current,
          pendingAttempt: pendingAttemptRef.current,
          attemptId,
          openedDialog,
        });

      let executionContext: PreLoopExecutionContext = {};
      if (requireExplicitSelection) {
        const explicitSelection = await resolveExplicitPreLoopExecutionContext({
          attemptId,
          capture,
          clearActiveAttempt,
          clearCheckingForAttempt,
          currentPreference: computePreferenceQuery.data,
          metadata,
          refetchPreference: async () => {
            const result = await computePreferenceQuery.refetch();
            return {
              data: result.data,
              error: result.error instanceof Error ? result.error : null,
            };
          },
          warnAndBlockUnavailable,
        });
        if (explicitSelection.outcome) {
          return explicitSelection.outcome;
        }
        executionContext = explicitSelection.executionContext;
      }

      const evaluation = await evaluatePreLoopTargetHealth(metadata, attemptId);
      if (evaluation.status === "skip_no_local_target") {
        return finishSkippedNoLocalTarget({
          attemptId,
          execute,
          executionContext,
          wasCancelled: wasDialogCancelled,
          clearActiveAttempt,
        });
      }
      if (evaluation.status === "unavailable") {
        return finishUnavailablePreLoopEvaluation({
          attemptId,
          metadata,
          evaluation,
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

      const { healthResult, latestVersion, pluginAutoUpdateEnabled, target } =
        evaluation;
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
        execute({ computeTargetId: target.computeTargetId });
        return { status: "executed", attemptId };
      }

      clearCheckingForAttempt(attemptId);
      updatePendingAttempt({
        target,
        healthCheckData: healthResult.data,
        latestVersion,
        pluginAutoUpdateEnabled,
      });
      capture(PreLoopAnalyticsEvent.SystemCheckBlocked, analyticsBase);
      return { status: "blocked", attemptId };
    },
    [
      capture,
      clearCheckingForAttempt,
      clearPendingAttemptState,
      computePreferenceQuery.data,
      computePreferenceQuery.refetch,
      expectedMcpUrl,
      evaluatePreLoopTargetHealth,
      finishSkippedNoLocalTarget,
      finishUnavailablePreLoopEvaluation,
      requireExplicitSelection,
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
      setActiveAttemptTarget(null);
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
    const attemptMetadata =
      pendingAttempt?.metadata ?? activeAttemptRef.current?.metadata;
    const attemptTarget = pendingAttempt?.target ?? activeAttemptTarget;
    if (!(attemptMetadata && attemptTarget)) {
      return;
    }
    if (attemptMetadata.computeTargetId !== undefined) {
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
      selection.effectiveTargetId !== attemptTarget.computeTargetId
    ) {
      cancelPendingAttempt("target_changed");
    }
  }, [
    activeAttemptTarget,
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

  const activeAttempt = activeAttemptRef.current;
  const activeOwnerKey =
    pendingAttempt?.metadata.ownerKey ??
    (isChecking ? (activeAttempt?.metadata.ownerKey ?? null) : null);
  const activeCommand =
    pendingAttempt?.metadata.command ??
    (isChecking ? (activeAttempt?.metadata.command ?? null) : null);

  const contextValue = useMemo<PreLoopSystemCheckContextValue>(
    () => ({
      runWithPreLoopSystemCheck,
      cancelPendingPreLoopAttempt,
      isChecking,
      isDialogOpen: pendingAttempt !== null,
      pendingOwnerKey: activeOwnerKey,
      pendingCommand: activeCommand,
    }),
    [
      activeCommand,
      activeOwnerKey,
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
          isOwnedTarget={pendingAttempt.target.isOwnedByCurrentUser}
          latestVersionOverride={pendingAttempt.latestVersion}
          mode="blocking-pre-loop"
          onCancel={() => cancelPendingAttempt("dialog_cancelled")}
          onRecheckClick={handleRecheckClick}
          onRecheckResult={handleRecheckResult}
          onRecheckUnavailable={handleRecheckUnavailable}
          onResolvedAfterRecheck={handleResolvedAfterRecheck}
          pluginAutoUpdateEnabled={pendingAttempt.pluginAutoUpdateEnabled}
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
