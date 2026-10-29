"use client";

import type {
  ComputeTarget,
  ComputeTargetHealthCheckSnapshot,
} from "@repo/api/src/types/compute-target";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";
import { computeTargetKeys } from "./compute-target-query-keys";
import { fetchComputeTargetsSnapshot } from "./compute-targets-snapshot";

/**
 * Surface-agnostic compute-target READ path (PLN-1915 Step 1, D8).
 *
 * READ only, deliberately. The dispatch and compute-target WRITE hooks stay in
 * `apps/app`: the Desktop's cloud-API bridge refuses every non-GET to
 * `/compute-targets`, so a Desktop caller of a shared write hook would get the
 * bridge's generic network error rather than a refusal it could report. They
 * move here when that capability is deliberately opened, not before.
 *
 * The fetch and the date materialization live in `./compute-targets-snapshot`.
 */

type ApiClient = ReturnType<typeof useApiClient>;

type ComputeTargetHealthCheckSnapshotWire = Omit<
  ComputeTargetHealthCheckSnapshot,
  "checkedAt" | "createdAt" | "updatedAt"
> & {
  checkedAt: string;
  createdAt: string;
  updatedAt: string;
};

function toHealthCheckSnapshot(
  snapshot: ComputeTargetHealthCheckSnapshotWire | null
): ComputeTargetHealthCheckSnapshot | null {
  if (!snapshot) {
    return null;
  }
  return {
    ...snapshot,
    pluginAutoUpdateEnabled: snapshot.pluginAutoUpdateEnabled ?? false,
    checkedAt: new Date(snapshot.checkedAt),
    createdAt: new Date(snapshot.createdAt),
    updatedAt: new Date(snapshot.updatedAt),
  };
}

/** The compute-target list, on one query key, for every surface. */
export function useComputeTargets(
  options?: Omit<UseQueryOptions<ComputeTarget[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: computeTargetKeys.list(),
    queryFn: () => fetchComputeTargetsSnapshot(apiClient),
    ...options,
  });
}

function computeTargetHealthCheckSnapshotQueryOptions(
  apiClient: ApiClient,
  targetId: string | null | undefined,
  pluginAutoUpdateEnabled = false
) {
  return {
    queryKey: computeTargetKeys.healthCheckMode(
      targetId ?? "",
      pluginAutoUpdateEnabled
    ),
    queryFn: async () => {
      if (!targetId) {
        return null;
      }
      const snapshot =
        await apiClient.get<ComputeTargetHealthCheckSnapshotWire | null>(
          `/compute-targets/${targetId}/health-check`
        );
      return toHealthCheckSnapshot(snapshot);
    },
    enabled: Boolean(targetId),
  } as const;
}

export function useComputeTargetHealthCheckSnapshot(
  targetId: string | null | undefined,
  pluginAutoUpdateEnabledOrOptions?:
    | boolean
    | Omit<
        UseQueryOptions<ComputeTargetHealthCheckSnapshot | null>,
        "queryKey" | "queryFn"
      >,
  options?: Omit<
    UseQueryOptions<ComputeTargetHealthCheckSnapshot | null>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();
  const pluginAutoUpdateEnabled =
    typeof pluginAutoUpdateEnabledOrOptions === "boolean"
      ? pluginAutoUpdateEnabledOrOptions
      : false;
  const queryOptionsOverride =
    typeof pluginAutoUpdateEnabledOrOptions === "boolean"
      ? options
      : pluginAutoUpdateEnabledOrOptions;

  return useQuery({
    ...computeTargetHealthCheckSnapshotQueryOptions(
      apiClient,
      targetId,
      pluginAutoUpdateEnabled
    ),
    ...queryOptionsOverride,
  });
}
