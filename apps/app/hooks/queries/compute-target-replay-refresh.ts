import type { ComputeTarget } from "@repo/api/src/types/compute-target";
import type { QueryClient } from "@tanstack/react-query";
import { computeTargetKeys } from "./compute-target-query-keys";
import { fetchComputeTargetsSnapshot } from "./use-compute-targets";

type ComputeTargetsApiClient = {
  get<T>(path: string): Promise<T>;
};

/**
 * Refreshes the full compute-target snapshot before selected-target replay.
 * Conflict rows are hints only; signing and mutation replay must use this
 * full snapshot so stale eligibility cannot authorize a signed command.
 */
export async function refreshComputeTargetForReplay(
  apiClient: ComputeTargetsApiClient,
  queryClient: QueryClient,
  targetId: string
): Promise<ComputeTarget> {
  let targets: ComputeTarget[];
  try {
    targets = await fetchComputeTargetsSnapshot(apiClient);
  } catch (error) {
    throw new Error("Failed to refresh compute targets before retrying.", {
      cause: error,
    });
  }

  queryClient.setQueryData(computeTargetKeys.list(), targets);
  const target = targets.find((candidate) => candidate.id === targetId);
  if (!target) {
    throw new Error(
      "Selected compute target is no longer available. Choose a target again."
    );
  }
  return target;
}
