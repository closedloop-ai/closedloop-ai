"use client";

import type { ComputeTarget } from "@repo/api/src/types/compute-target";
import type { useApiClient } from "../../shared/api/use-api-client";

type ApiClient = ReturnType<typeof useApiClient>;

/** The narrow read port {@link fetchComputeTargetsSnapshot} needs. */
export type ComputeTargetsSnapshotClient = Pick<ApiClient, "get">;

type ComputeTargetWire = Omit<
  ComputeTarget,
  "lastSeenAt" | "createdAt" | "updatedAt"
> & {
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};

function toComputeTarget(target: ComputeTargetWire): ComputeTarget {
  return {
    ...target,
    lastSeenAt: new Date(target.lastSeenAt),
    createdAt: new Date(target.createdAt),
    updatedAt: new Date(target.updatedAt),
  };
}

/** Fetches and materializes a full compute-target snapshot. */
export async function fetchComputeTargetsSnapshot(
  apiClient: ComputeTargetsSnapshotClient
): Promise<ComputeTarget[]> {
  const wire = await apiClient.get<ComputeTargetWire[]>("/compute-targets");
  return wire.map(toComputeTarget);
}
