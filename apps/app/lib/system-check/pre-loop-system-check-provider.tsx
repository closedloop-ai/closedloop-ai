"use client";

import { useAnalytics, useFeatureFlag } from "@repo/analytics/client";
import {
  ComputePreference,
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
import { PRE_LOOP_CLOUD_FALLBACK_FEATURE_FLAG_KEY } from "./cloud-fallback";
import { CLOUD_TARGET_VALIDATION_FEATURE_FLAG_KEY } from "./cloud-target-readiness";
import {
  classifyHealthCheckFailure,
  describeHealthCheckFailure,
  HealthCheckFailureKind,
  isUnreachableHealthCheckFailure,
} from "./health-check-failure";
import { getPreLoopHealthCheckOverallTimeoutMs } from "./health-check-timeouts";
import { readPersistedHealthCheckSnapshot } from "./persisted-health-check-snapshot";
import { PLUGIN_AUTO_UPDATE_FEATURE_FLAG_KEY } from "./plugin-auto-update";
import {
  type ActivePreLoopAttempt,
  type AttemptBranchCallbacks,
  buildUnavailableHealthCheck,
  type CachedHealthCheckFetchResult,
  clearActivePreLoopAttempt,
  type ExecuteCallback,
  formatHealthCheckFailureReason,
  formatUnavailableReason,
  getLatestVersionFromHealthCheckQueryKey,
  getTargetLabel,
  type HealthCheckFetchResult,
  hasPreLoopAttemptBeenCancelled,
  isActivePreLoopAttemptCancelled,
  type PendingPreLoopAttempt,
  type PreLoopHealthEvaluation,
  requireQueryData,
  resolveExplicitPreLoopExecutionContext,
  type UpdateActivePendingAttemptInput,
  type UpdatePendingAttemptInput,
  withTimeout,
} from "./pre-loop-attempt";
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
import { useCloudTargetPreflight } from "./use-cloud-target-preflight";

const BLOCKING_DIALOG_CANCEL_DISMISS_MS = 250;

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
  const validateCloudTarget = useFeatureFlagEnabled(
    CLOUD_TARGET_VALIDATION_FEATURE_FLAG_KEY
  );
  // Closed-by-default gate for the ISS-5171 Cloud fallback. Off => the previous
  // hard-block behaviour, so only the ungated bug fixes change for everyone.
  const cloudFallbackEnabled = useFeatureFlagEnabled(
    PRE_LOOP_CLOUD_FALLBACK_FEATURE_FLAG_KEY
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

  const cancelScheduledPendingAttemptRemoval = useCallback(() => {
    if (pendingRemovalTimerRef.current) {
      clearTimeout(pendingRemovalTimerRef.current);
      pendingRemovalTimerRef.current = null;
    }
  }, []);

  const clearPendingAttemptState = useCallback(
    (delayMs = 0) => {
      cancelScheduledPendingAttemptRemoval();

      if (delayMs > 0) {
        pendingRemovalTimerRef.current = setTimeout(() => {
          pendingRemovalTimerRef.current = null;
          setPendingAttempt(null);
        }, delayMs);
        return;
      }

      setPendingAttempt(null);
    },
    [cancelScheduledPendingAttemptRemoval]
  );

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

      return readPersistedHealthCheckSnapshot({
        snapshot,
        target,
        expectedMcpUrl,
        latestVersion,
        pluginAutoUpdateEnabled,
        queryClient,
      });
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
      // Pre-loop checks always carry a `relayTargetId`, so this is always the
      // relay path — browser -> app -> relay socket -> Electron gateway ->
      // process spawn. Budget it as such, not as a loopback call (ISS-5169).
      const data = await withTimeout(
        queryClient.fetchQuery(options),
        getPreLoopHealthCheckOverallTimeoutMs({
          pluginAutoUpdateEnabled,
          relayTarget: true,
        })
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
      failureKind,
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

      // A previous cancel schedules `setPendingAttempt(null)` on a delay so the
      // dialog can play its exit animation. Installing a new pending attempt
      // must cancel that timer, or it fires afterwards and blanks the *new*
      // dialog while the gate still considers an attempt pending (ISS-5170).
      cancelScheduledPendingAttemptRemoval();

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
        failureKind: failureKind ?? current?.failureKind,
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
    [cancelScheduledPendingAttemptRemoval, expectedMcpUrl]
  );

  const { finishSkippedNoLocalTarget } = useCloudTargetPreflight({
    capture,
    clearCheckingForAttempt,
    preferredComputeMode: computePreferenceQuery.data?.preferredComputeMode,
    validateCloudTarget,
  });

  const finishUnavailablePreLoopEvaluation = useCallback(
    ({
      attemptId,
      metadata,
      evaluation,
      execute,
      wasCancelled,
      clearActiveAttempt,
      updatePendingAttempt,
    }: AttemptBranchCallbacks & {
      attemptId: string;
      metadata: PreLoopMetadata;
      evaluation: Extract<PreLoopHealthEvaluation, { status: "unavailable" }>;
      execute: ExecuteCallback;
      updatePendingAttempt: (input: UpdatePendingAttemptInput) => void;
    }): PreLoopHealthCheckOutcome => {
      clearCheckingForAttempt(attemptId);
      if (wasCancelled()) {
        clearActiveAttempt();
        return { status: "cancelled", attemptId };
      }

      // ISS-5171: `isOnline` is a heartbeat, not proof the relay can carry a
      // command. When the resolved Local target cannot be reached, running on
      // Cloud is strictly better than refusing to run the command at all.
      if (
        cloudFallbackEnabled &&
        evaluation.target &&
        isUnreachableHealthCheckFailure(evaluation.failureKind)
      ) {
        clearActiveAttempt();
        capture(PreLoopAnalyticsEvent.SystemCheckCloudFallback, {
          attemptId,
          metadata,
          target: evaluation.target,
          reason: evaluation.reason,
        });
        // One sentence, because the toast auto-dismisses: which target we
        // could not reach, and what we did about it.
        toast.info(
          `Couldn't reach ${evaluation.target.label}, so this ran on Cloud.`
        );
        execute({ computeTargetId: null });
        return { status: "fell_back_to_cloud", attemptId };
      }

      let openedUnavailableDialog = false;
      if (evaluation.target) {
        updatePendingAttempt({
          target: evaluation.target,
          latestVersion: evaluation.latestVersion ?? null,
          pluginAutoUpdateEnabled: evaluation.pluginAutoUpdateEnabled ?? false,
          failureKind: evaluation.failureKind,
          healthCheckData: buildUnavailableHealthCheck({
            failureKind: evaluation.failureKind,
            targetLabel: evaluation.target.label,
          }),
        });
        openedUnavailableDialog = true;
      }

      const outcome = warnAndBlockUnavailable({
        attemptId,
        metadata,
        target: evaluation.target,
        reason: evaluation.reason,
        description: `${
          describeHealthCheckFailure(
            evaluation.failureKind,
            evaluation.target?.label
          ).description
        } The command was not started.`,
      });
      if (!openedUnavailableDialog) {
        clearActiveAttempt();
      }
      return outcome;
    },
    [
      capture,
      clearCheckingForAttempt,
      cloudFallbackEnabled,
      warnAndBlockUnavailable,
    ]
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
          failureKind: HealthCheckFailureKind.Unknown,
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
          failureKind: HealthCheckFailureKind.TargetOffline,
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
          failureKind: HealthCheckFailureKind.Unknown,
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
        const failureKind = classifyHealthCheckFailure(error, {
          relayTarget: true,
        });
        return {
          status: "unavailable",
          target,
          latestVersion,
          failureKind,
          reason: formatHealthCheckFailureReason(failureKind, error),
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

  const runPreLoopAttempt = useCallback(
    async (
      attemptId: string,
      metadata: PreLoopMetadata,
      execute: ExecuteCallback
    ): Promise<PreLoopHealthCheckOutcome> => {
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
        failureKind,
      }: UpdatePendingAttemptInput) => {
        const updated = updateActivePendingAttempt({
          attemptId,
          metadata,
          target,
          latestVersion,
          pluginAutoUpdateEnabled,
          healthCheckData,
          failureKind,
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
        return await finishSkippedNoLocalTarget({
          attemptId,
          metadata,
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
          execute,
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

  /**
   * Duplicate-suppression gate around one attempt.
   *
   * ISS-5170: `isCheckingRef` / `pendingAttemptRef` make every later command a
   * silent `duplicate_ignored`, so anything that leaves them latched reads to
   * the operator as the whole app freezing — no dialog, no toast, buttons that
   * do nothing. The attempt body therefore runs inside try/catch/finally: an
   * unexpected throw becomes a visible blocked outcome, and the gate is always
   * released unless a dismissable dialog is deliberately holding it.
   */
  const runWithPreLoopSystemCheck = useCallback(
    async (
      metadata: PreLoopMetadata,
      execute: ExecuteCallback
    ): Promise<PreLoopHealthCheckOutcome> => {
      if (isCheckingRef.current || pendingAttemptRef.current) {
        return { status: "duplicate_ignored", attemptId: null };
      }

      const attemptId = createPreLoopAttemptId();
      try {
        return await runPreLoopAttempt(attemptId, metadata, execute);
      } catch (error) {
        return warnAndBlockUnavailable({
          attemptId,
          metadata,
          reason: formatUnavailableReason("pre_loop_unexpected", error),
          description:
            "The system check failed unexpectedly, so the command was not started. Try again.",
        });
      } finally {
        // A pending attempt means a dialog owns the gate and has its own
        // dismissal path; anything else must hand the gate back now.
        if (!pendingAttemptRef.current) {
          clearCheckingForAttempt(attemptId);
          if (clearActivePreLoopAttempt(activeAttemptRef, attemptId)) {
            setActiveAttemptTarget(null);
          }
        }
      }
    },
    [clearCheckingForAttempt, runPreLoopAttempt, warnAndBlockUnavailable]
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

  /**
   * Escape hatch from the blocking dialog: run the blocked command on Cloud
   * compute instead of leaving the operator with only "Cancel" and "Re-check"
   * when the local target cannot answer (ISS-5170 / ISS-5171).
   */
  const handleRunOnCloud = useCallback(() => {
    const attempt = pendingAttemptRef.current;
    if (!attempt) {
      return;
    }
    capture(PreLoopAnalyticsEvent.SystemCheckCloudFallback, {
      attemptId: attempt.attemptId,
      metadata: attempt.metadata,
      target: attempt.target,
      failingRequiredFingerprint: attempt.failingRequiredFingerprint,
      recheckAttempts: attempt.recheckAttempts,
      reason: "dialog_run_on_cloud",
    });
    clearActivePreLoopAttempt(activeAttemptRef, attempt.attemptId);
    setActiveAttemptTarget(null);
    pendingAttemptRef.current = null;
    clearPendingAttemptState();
    clearChecking();
    attempt.execute({ computeTargetId: null });
  }, [capture, clearChecking, clearPendingAttemptState]);

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
          onCancel={() => cancelPendingAttempt("dialog_cancelled")}
          onRecheckClick={handleRecheckClick}
          onRecheckResult={handleRecheckResult}
          onRecheckUnavailable={handleRecheckUnavailable}
          onResolvedAfterRecheck={handleResolvedAfterRecheck}
          onRunOnCloud={cloudFallbackEnabled ? handleRunOnCloud : undefined}
          pluginAutoUpdateEnabled={pendingAttempt.pluginAutoUpdateEnabled}
          relayTargetId={pendingAttempt.target.computeTargetId}
          targetKey={pendingAttempt.target.targetKey}
          targetLabel={pendingAttempt.target.label}
          targetUnreachable={
            pendingAttempt.failureKind !== undefined &&
            isUnreachableHealthCheckFailure(pendingAttempt.failureKind)
          }
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
