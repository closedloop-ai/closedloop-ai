"use client";

import type { ComputeTarget } from "@repo/api/src/types/compute-target";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { computePreferenceKeys } from "@/hooks/queries/use-compute-preference";
import { useApiClient } from "@/hooks/use-api-client";

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

export const computeTargetKeys = {
  all: ["compute-targets"] as const,
  list: () => [...computeTargetKeys.all, "list"] as const,
};

export function useComputeTargets(
  options?: Omit<UseQueryOptions<ComputeTarget[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: computeTargetKeys.list(),
    queryFn: async () => {
      const targets =
        await apiClient.get<ComputeTargetWire[]>("/compute-targets");
      return targets.map(toComputeTarget);
    },
    ...options,
  });
}

export function useDeleteComputeTarget(userId: string) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ deleted: true }>(`/compute-targets/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: computeTargetKeys.list() });
      queryClient.invalidateQueries({
        queryKey: computePreferenceKeys.detail(userId),
      });
    },
  });
}
