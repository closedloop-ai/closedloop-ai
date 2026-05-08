"use client";

import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { HealthCheckDialog } from "@/components/engineer/HealthCheckDialog";
import { env } from "@/env";
import {
  useComputeTargetHealthCheckSnapshot,
  useComputeTargets,
} from "@/hooks/queries/use-compute-targets";
import { useLatestElectronRelease } from "@/hooks/queries/use-electron-release";
import {
  CLOUD_RELAY_ENABLED,
  COMPUTE_TARGETS_QUERY_OPTIONS,
} from "@/lib/engineer/constants";
import {
  getHealthCheckTargetKey,
  type HealthCheckResponse,
  healthCheckOptions,
} from "@/lib/engineer/queries/health-check";
import { resolveTargetLabel } from "@/lib/engineer/routing-label";
import { useEngineerRoutingSelection } from "@/lib/engineer/routing-store";
import { isHealthCheckCacheEntryFresh } from "@/lib/system-check/health-check-freshness";
import { useOptionalPreLoopSystemCheckGate } from "@/lib/system-check/pre-loop-system-check-provider";
import { useSystemCheckEligibility } from "@/lib/system-check/use-system-check-eligibility";

const LATEST_RELEASE_STALE_TIME_MS = 5 * 60 * 1000;

function getAmbientSystemCheckTargetKey(
  routing: ReturnType<typeof useEngineerRoutingSelection>
): string {
  if (routing.mode === EngineerRoutingMode.LocalElectron) {
    return "local-gateway";
  }

  return getHealthCheckTargetKey(routing);
}

function getAmbientRelayTargetId(
  routing: ReturnType<typeof useEngineerRoutingSelection>
): string | null {
  return routing.mode === EngineerRoutingMode.CloudRelay
    ? routing.computeTargetId
    : null;
}

export function SystemCheckBootstrap() {
  const { isLoading, shouldRunSystemCheck } = useSystemCheckEligibility();
  const preLoopGate = useOptionalPreLoopSystemCheckGate();
  const routing = useEngineerRoutingSelection();
  const queryClient = useQueryClient();
  const expectedMcpUrl = env.NEXT_PUBLIC_MCP_SERVER_URL ?? null;
  const { data: targets = [] } = useComputeTargets({
    ...COMPUTE_TARGETS_QUERY_OPTIONS,
    enabled: CLOUD_RELAY_ENABLED,
  });
  const targetKey = getAmbientSystemCheckTargetKey(routing);
  const relayTargetId = getAmbientRelayTargetId(routing);
  const prefetchEnabled =
    !isLoading && shouldRunSystemCheck && !preLoopGate?.isDialogOpen;
  const { data: latestRelease, isLoading: isLatestReleaseLoading } =
    useLatestElectronRelease({
      enabled: prefetchEnabled,
      staleTime: LATEST_RELEASE_STALE_TIME_MS,
    });
  const latestVersion = latestRelease?.version ?? null;
  const persistedSnapshotQuery = useComputeTargetHealthCheckSnapshot(
    relayTargetId,
    {
      enabled: prefetchEnabled && Boolean(relayTargetId),
      staleTime: 60_000,
    }
  );
  const persistedSnapshot = persistedSnapshotQuery.data ?? null;
  const hasFreshPersistedSnapshot =
    Boolean(persistedSnapshot) &&
    !isLatestReleaseLoading &&
    isHealthCheckCacheEntryFresh({
      entry: {
        data: persistedSnapshot?.result ?? {
          checks: [],
          allRequiredPassed: false,
        },
        checkedAt: persistedSnapshot?.checkedAt ?? 0,
        expectedMcpUrl: persistedSnapshot?.expectedMcpUrl ?? null,
        latestVersion: persistedSnapshot?.latestVersion ?? null,
      },
      expectedMcpUrl,
      latestVersion,
    });

  useEffect(() => {
    if (!(persistedSnapshot && hasFreshPersistedSnapshot)) {
      return;
    }

    const options = healthCheckOptions(targetKey, expectedMcpUrl, {
      latestVersion,
      relayTargetId,
    });
    const snapshotUpdatedAt = persistedSnapshot.checkedAt.getTime();
    const existingState = queryClient.getQueryState<HealthCheckResponse>(
      options.queryKey
    );
    if (
      existingState?.dataUpdatedAt &&
      existingState.dataUpdatedAt >= snapshotUpdatedAt
    ) {
      return;
    }

    queryClient.setQueryData(options.queryKey, persistedSnapshot.result, {
      updatedAt: snapshotUpdatedAt,
    });
  }, [
    expectedMcpUrl,
    hasFreshPersistedSnapshot,
    latestVersion,
    persistedSnapshot,
    queryClient,
    relayTargetId,
    targetKey,
  ]);

  useEffect(() => {
    if (!prefetchEnabled || isLatestReleaseLoading) {
      return;
    }
    if (relayTargetId && persistedSnapshotQuery.isLoading) {
      return;
    }
    if (hasFreshPersistedSnapshot) {
      return;
    }

    queryClient
      .prefetchQuery(
        healthCheckOptions(targetKey, expectedMcpUrl, {
          latestVersion,
          relayTargetId,
        })
      )
      .catch(() => undefined);
  }, [
    expectedMcpUrl,
    hasFreshPersistedSnapshot,
    isLatestReleaseLoading,
    latestVersion,
    persistedSnapshotQuery.isLoading,
    prefetchEnabled,
    queryClient,
    relayTargetId,
    targetKey,
  ]);

  if (isLoading || !shouldRunSystemCheck || preLoopGate?.isDialogOpen) {
    return null;
  }

  // Key forces HealthCheckDialog to remount when the ambient check target
  // changes. Local Electron always uses the localhost gateway, so its key must
  // not churn when the loop-dispatch compute target ID hydrates.
  const targetLabel = resolveTargetLabel(routing, targets);

  return (
    <HealthCheckDialog
      key={targetKey}
      latestVersionOverride={isLatestReleaseLoading ? undefined : latestVersion}
      relayTargetId={relayTargetId}
      targetKey={targetKey}
      targetLabel={targetLabel}
    />
  );
}
