"use client";

import type {
  ComputeTarget,
  ComputeTargetHealthCheckSnapshot,
  CreateDesktopCommandInput,
  CreateDesktopCommandResponse,
  DesktopCommandSummary,
  SetComputeTargetSharingResponse,
  StartDesktopSecurityUpgradeResponse,
} from "@repo/api/src/types/compute-target";
import {
  isTerminalStatus,
  UPDATE_AND_RESTART_OPERATION_ID,
} from "@repo/api/src/types/compute-target";
import {
  type UseMutationResult,
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { computePreferenceKeys } from "@/hooks/queries/use-compute-preference";
import { useApiClient } from "@/hooks/use-api-client";

type ApiClient = ReturnType<typeof useApiClient>;

type ComputeTargetWire = Omit<
  ComputeTarget,
  "lastSeenAt" | "createdAt" | "updatedAt"
> & {
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};

type ComputeTargetHealthCheckSnapshotWire = Omit<
  ComputeTargetHealthCheckSnapshot,
  "checkedAt" | "createdAt" | "updatedAt"
> & {
  checkedAt: string;
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

function toHealthCheckSnapshot(
  snapshot: ComputeTargetHealthCheckSnapshotWire | null
): ComputeTargetHealthCheckSnapshot | null {
  if (!snapshot) {
    return null;
  }
  return {
    ...snapshot,
    checkedAt: new Date(snapshot.checkedAt),
    createdAt: new Date(snapshot.createdAt),
    updatedAt: new Date(snapshot.updatedAt),
  };
}

export const computeTargetKeys = {
  all: ["compute-targets"] as const,
  list: () => [...computeTargetKeys.all, "list"] as const,
  healthCheck: (targetId: string) =>
    [...computeTargetKeys.all, targetId, "health-check"] as const,
  commandKeys: (targetId: string, commandId: string) =>
    [...computeTargetKeys.all, targetId, "commands", commandId] as const,
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

export function computeTargetHealthCheckSnapshotQueryOptions(
  apiClient: ApiClient,
  targetId: string | null | undefined
) {
  return {
    queryKey: computeTargetKeys.healthCheck(targetId ?? ""),
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
  options?: Omit<
    UseQueryOptions<ComputeTargetHealthCheckSnapshot | null>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    ...computeTargetHealthCheckSnapshotQueryOptions(apiClient, targetId),
    ...options,
  });
}

export function useDeleteComputeTarget(userId: string) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ deleted: true }>(`/compute-targets/${id}`),
    onSuccess: (_result, id) => {
      queryClient.invalidateQueries({ queryKey: computeTargetKeys.list() });
      queryClient.removeQueries({
        queryKey: computeTargetKeys.healthCheck(id),
      });
      queryClient.invalidateQueries({
        queryKey: computePreferenceKeys.detail(userId),
      });
    },
  });
}

export function useToggleComputeTargetSharing() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({
      id,
      isSharedWithOrg,
    }: {
      id: string;
      isSharedWithOrg: boolean;
    }) =>
      apiClient.patch<SetComputeTargetSharingResponse>(
        `/compute-targets/${id}/sharing`,
        { isSharedWithOrg }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: computeTargetKeys.list() });
    },
  });
}

type UpdateAndRestartCommandInput = Omit<
  CreateDesktopCommandInput,
  "operationId" | "idempotencyKey" | "path" | "method"
> & {
  operationId: typeof UPDATE_AND_RESTART_OPERATION_ID;
  idempotencyKey: string;
  path: string;
  method: "POST";
};

export function useDesktopCommandStatus(
  targetId: string,
  commandId: string | null
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: computeTargetKeys.commandKeys(targetId, commandId ?? ""),
    queryFn: () =>
      apiClient.get<DesktopCommandSummary>(
        `/compute-targets/${targetId}/commands/${commandId}`
      ),
    enabled: commandId !== null,
    refetchInterval: (query) =>
      query.state.data && isTerminalStatus(query.state.data.status)
        ? false
        : 2000,
    refetchIntervalInBackground: false,
  });
}

export function useDispatchDesktopCommand(
  targetId: string
): UseMutationResult<
  CreateDesktopCommandResponse,
  Error,
  { idempotencyKey: string }
> {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({ idempotencyKey }: { idempotencyKey: string }) => {
      const payload: UpdateAndRestartCommandInput = {
        operationId: UPDATE_AND_RESTART_OPERATION_ID,
        idempotencyKey,
        path: "/api/gateway/update-and-restart",
        method: "POST",
      };
      return apiClient.post<CreateDesktopCommandResponse>(
        `/compute-targets/${targetId}/commands`,
        payload
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: computeTargetKeys.list() });
    },
    retry: 0,
  });
}

export function useStartDesktopSecurityUpgrade() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({
      targetId,
      webAppOrigin,
    }: {
      targetId: string;
      webAppOrigin: string;
    }) => {
      return apiClient.postRaw<StartDesktopSecurityUpgradeResponse>(
        `/compute-targets/${targetId}/security-upgrade-attempt`,
        { webAppOrigin }
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: computeTargetKeys.list() });
    },
    retry: 0,
  });
}
