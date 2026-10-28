"use client";

import type {
  ComputeTarget,
  CreateDesktopCommandInput,
  CreateDesktopCommandResponse,
  DesktopCommandSummary,
} from "@repo/api/src/types/compute-target";
import {
  isTerminalStatus,
  UPDATE_AND_RESTART_OPERATION_ID,
} from "@repo/api/src/types/compute-target";
import { computeTargetKeys } from "@repo/app/compute/hooks/compute-target-query-keys";
import {
  hasEffectiveCommandSigningSupport,
  signDesktopCommand,
} from "@repo/app/compute/lib/command-signing/command-signer";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import {
  type UseMutationResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

/**
 * Web-shell compute-target hooks.
 *
 * The READ path moved to `@repo/app/compute/hooks/use-compute-targets` so the
 * Desktop renderer can consume it too (PLN-1915 Step 1 / D8). Two groups stay
 * here: the command-signing hooks and the compute-target write hooks below.
 * The write hooks stay by decision rather than by constraint — the Desktop's
 * cloud-API bridge refuses every non-GET to `/compute-targets`, so a Desktop
 * caller of a shared write hook would get the bridge's generic network error
 * instead of a refusal it could report. They move only when that capability is
 * deliberately opened.
 *
 * The read symbols are re-exported so no call site outside this file changed.
 */
// biome-ignore lint/performance/noBarrelFile: migration seam, not a hub — these moved to @repo/app/compute/hooks (PLN-1915 Step 1 / D8) and the re-export is what keeps every existing apps/app importer on its current specifier.
export {
  useComputeTargetHealthCheckSnapshot,
  useComputeTargets,
} from "@repo/app/compute/hooks/use-compute-targets";

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
  target: ComputeTarget
): UseMutationResult<
  CreateDesktopCommandResponse,
  Error,
  { idempotencyKey: string }
> {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: async ({ idempotencyKey }: { idempotencyKey: string }) => {
      const payload: UpdateAndRestartCommandInput = {
        operationId: UPDATE_AND_RESTART_OPERATION_ID,
        idempotencyKey,
        path: "/api/gateway/update-and-restart",
        method: "POST",
      };
      if (hasEffectiveCommandSigningSupport(target)) {
        const signed = await signDesktopCommand(
          {
            method: payload.method,
            pathWithQuery: payload.path,
            body: undefined,
          },
          target
        );
        Object.assign(payload, {
          commandId: signed.commandId,
          path: signed.path,
          ...(signed.query ? { query: signed.query } : {}),
          signature: signed.signature,
          signaturePayload: signed.signaturePayload,
          publicKeyFingerprint: signed.publicKeyFingerprint,
        });
      }
      return apiClient.post<CreateDesktopCommandResponse>(
        `/compute-targets/${target.id}/commands`,
        payload
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: computeTargetKeys.list() });
    },
    retry: 0,
  });
}

export function useDeleteComputeTarget() {
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
    },
  });
}
