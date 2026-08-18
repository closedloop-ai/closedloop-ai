"use client";

import {
  type ComputeTargetHealthCheckSnapshot,
  HEALTH_CHECK_SNAPSHOT_SCHEMA_VERSION,
} from "@repo/api/src/types/compute-target";
import type { QueryClient } from "@tanstack/react-query";
import { healthCheckOptions } from "@/lib/engineer/queries/health-check";
import { getHealthCheckCacheAgeMs } from "./health-check-freshness";
import type { HealthCheckFetchResult } from "./pre-loop-attempt";
import {
  isPreLoopHealthCheckFresh,
  type PreLoopTarget,
} from "./pre-loop-health-check";

type PersistedSnapshotInput = {
  snapshot: ComputeTargetHealthCheckSnapshot;
  target: PreLoopTarget;
  expectedMcpUrl: string | null;
  latestVersion: string | null;
  pluginAutoUpdateEnabled: boolean;
  queryClient: QueryClient;
};

/**
 * Decides whether a SERVER-PERSISTED System Check snapshot may stand in for a
 * live check, and seeds the live query's cache from it when it may.
 *
 * Split out of `pre-loop-system-check-provider` because it is its own
 * responsibility — "is this stored row still an honest answer?" — and answering
 * it takes two independent tests that are easy to confuse: the row must be
 * READABLE by this build (schema version) and it must be CURRENT (freshness).
 * Returning `null` from either always degrades to a live check, which is the
 * only safe direction: a live check costs a round trip, a wrong stored row
 * blocks the user's command.
 */
export function readPersistedHealthCheckSnapshot({
  snapshot,
  target,
  expectedMcpUrl,
  latestVersion,
  pluginAutoUpdateEnabled,
  queryClient,
}: PersistedSnapshotInput): HealthCheckFetchResult | null {
  // A snapshot written before ISS-5811 is not merely old, it is WRONG: the API
  // validator of the day stripped `severity` from every row, and a stripped
  // severity resolves back to `error`, so an undeterminable plugin row
  // rehydrates as a proven failure and blocks the command the fix was meant to
  // unblock. Plugin rows sit in the one-day freshness window, so the freshness
  // test below would happily accept one for another 24h.
  if (snapshot.schemaVersion < HEALTH_CHECK_SNAPSHOT_SCHEMA_VERSION) {
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
}
