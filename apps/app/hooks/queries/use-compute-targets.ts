"use client";

import type {
  ComputeTarget,
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
    mutationFn: async ({
      targetId,
      webAppOrigin,
    }: {
      targetId: string;
      webAppOrigin: string;
    }) => {
      const response = await apiClient.request(
        `/compute-targets/${targetId}/security-upgrade-attempt`,
        {
          method: "POST",
          body: JSON.stringify({ webAppOrigin }),
        }
      );
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          typeof body?.code === "string"
            ? body.code
            : "DESKTOP_SECURITY_UPGRADE_FAILED"
        );
      }
      return body as StartDesktopSecurityUpgradeResponse;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: computeTargetKeys.list() });
    },
    retry: 0,
  });
}
