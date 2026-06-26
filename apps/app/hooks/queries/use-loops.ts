"use client";

import type { JsonValue } from "@repo/api/src/types/common";
import {
  ComputePreference,
  type ComputePreferenceResponse,
  type ComputeTarget,
  EXPLICIT_COMPUTE_SELECTION_FEATURE_FLAG_KEY,
} from "@repo/api/src/types/compute-target";
import type { CreateLoopResponse, Loop } from "@repo/api/src/types/loop";
import { RunLoopCommand } from "@repo/api/src/types/loop";
import { useComputePreference } from "@repo/app/compute/hooks/use-compute-preference";
import { judgesKeys } from "@repo/app/judges-analytics/hooks/use-judges";
import { loopKeys } from "@repo/app/loops/hooks/loop-keys";
import { resolveEffectiveComputeTargetSelection } from "@repo/app/loops/lib/compute-target-selection";
import { ComputePreferenceRequiredClientError } from "@repo/app/loops/lib/run-loop-response";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useUser } from "@repo/auth/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useComputeTargets } from "@/hooks/queries/use-compute-targets";
import {
  hasEffectiveCommandSigningSupport,
  signDesktopCommand,
} from "@/lib/desktop-command-signing/command-signer";
import { getCachedComputeTargetForSigning } from "@/lib/desktop-command-signing/compute-target-signing-cache";
import {
  postRunLoop,
  type RunLoopLaunchInput,
} from "@/lib/loops/run-loop-launcher";

/**
 * Loop mutations that reach the desktop command-signing seam stay in apps/app
 * (not @repo/app): `useCancelLoop`'s signed-kill path and `useRunLoop`'s
 * `postRunLoop` launch both depend on `@/lib/desktop-command-signing/*` and
 * `@/lib/loops/run-loop-launcher`, which sign commands for the local gateway
 * and are not surface-agnostic. The portable loop queries/mutations live in
 * `@repo/app/loops/hooks/use-loops`.
 */
export function useCancelLoop() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: async (
      input: string | { id: string; computeTargetId?: string | null }
    ) => {
      const id = typeof input === "string" ? input : input.id;
      const target =
        typeof input === "string" || !input.computeTargetId
          ? null
          : getCachedComputeTargetForSigning(input.computeTargetId);
      if (target && hasEffectiveCommandSigningSupport(target)) {
        const userIntent = {
          loopId: id,
          computeTargetId: target.id,
          action: "cancel_loop",
        } satisfies JsonValue;
        const signed = await signDesktopCommand(
          {
            method: "POST",
            pathWithQuery: "/api/gateway/symphony/loop/kill",
            body: userIntent,
          },
          target
        );
        return apiClient.post<Loop>(`/loops/${id}/cancel`, {
          userIntentSignature: {
            commandId: signed.commandId,
            signature: signed.signature,
            signaturePayload: signed.signaturePayload,
            publicKeyFingerprint: signed.publicKeyFingerprint,
            body: userIntent,
          },
        });
      }
      return apiClient.delete<Loop>(`/loops/${id}`);
    },
    onSuccess: (_, input) => {
      const id = typeof input === "string" ? input : input.id;
      queryClient.invalidateQueries({ queryKey: loopKeys.detail(id) });
      queryClient.invalidateQueries({ queryKey: loopKeys.lists() });
    },
  });
}

/**
 * Run a Loop from an artifact action (plan, execute, request_changes).
 * Posts to the artifact-scoped run-loop endpoint which creates a Loop
 * and launches it on ECS.
 */
export function useRunLoop() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();
  const { user } = useUser();
  const userId = user?.id ?? "";
  const requireExplicitSelection = useFeatureFlagEnabled(
    EXPLICIT_COMPUTE_SELECTION_FEATURE_FLAG_KEY
  );
  const computePreferenceQuery = useComputePreference(userId, {
    enabled: false,
  });
  const computeTargetsQuery = useComputeTargets({ enabled: false });

  return useMutation({
    meta: { suppressDefaultErrorToast: true },
    mutationFn: async (input: RunLoopLaunchInput) => {
      const launchInput = requireExplicitSelection
        ? await resolveExplicitComputeSelectionLaunchInput({
            input,
            fetchPreference: async () =>
              requireQueryDataFromRefetch<ComputePreferenceResponse>(
                await computePreferenceQuery.refetch()
              ),
            fetchTargets: async () =>
              requireQueryDataFromRefetch<ComputeTarget[]>(
                await computeTargetsQuery.refetch()
              ),
            userId,
          })
        : input;

      return postRunLoop<CreateLoopResponse>(apiClient, launchInput);
    },
    onSuccess: (_, { documentId, command }) => {
      queryClient.invalidateQueries({ queryKey: loopKeys.lists() });
      queryClient.invalidateQueries({
        queryKey: loopKeys.list({ documentId }),
      });
      // Also invalidate artifact generation status so the UI reflects the pending loop
      queryClient.invalidateQueries({
        queryKey: ["documents", "detail", documentId, "generation-status"],
      });
      if (command === RunLoopCommand.EvaluatePlan) {
        queryClient.invalidateQueries({
          queryKey: judgesKeys.detail(documentId),
        });
      }
      if (command === RunLoopCommand.EvaluateCode) {
        queryClient.invalidateQueries({
          queryKey: judgesKeys.codeDetail(documentId),
        });
      }
      if (command === RunLoopCommand.EvaluateFeature) {
        queryClient.invalidateQueries({
          queryKey: judgesKeys.featureDetail(documentId),
        });
      }
      if (command === RunLoopCommand.EvaluatePrd) {
        queryClient.invalidateQueries({
          queryKey: judgesKeys.prdDetail(documentId),
        });
      }
    },
  });
}

type ResolveExplicitComputeSelectionInput = {
  input: RunLoopLaunchInput;
  fetchPreference: () => Promise<ComputePreferenceResponse>;
  fetchTargets: () => Promise<ComputeTarget[]>;
  userId: string;
};

async function resolveExplicitComputeSelectionLaunchInput({
  fetchPreference,
  fetchTargets,
  input,
  userId,
}: ResolveExplicitComputeSelectionInput): Promise<RunLoopLaunchInput> {
  if (input.computeTargetId !== undefined || !userId) {
    return input;
  }

  const preference = await fetchPreference();
  if (preference.isExplicit !== true) {
    throw new ComputePreferenceRequiredClientError();
  }
  if (preference.preferredComputeMode !== ComputePreference.Local) {
    return input;
  }

  const targets = await fetchTargets();
  const selection = resolveEffectiveComputeTargetSelection({
    preference,
    requireExplicitSelection: true,
    targets,
  });
  if (selection.effectiveTarget?.isOnline && selection.effectiveTargetId) {
    return { ...input, computeTargetId: selection.effectiveTargetId };
  }
  return input;
}

function requireQueryDataFromRefetch<T>({
  data,
  error,
}: {
  data: T | undefined;
  error: Error | null;
}): T {
  if (error) {
    throw error;
  }
  if (data === undefined) {
    throw new Error("Required run-loop query returned no data");
  }
  return data;
}
