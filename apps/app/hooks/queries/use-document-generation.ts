"use client";

import type { ComputeTargetConflictBody } from "@repo/api/src/types/compute-target";
import type {
  CreateDocumentInput,
  Document,
} from "@repo/api/src/types/document";
import {
  type AdditionalRepoRef,
  RunLoopCommand,
} from "@repo/api/src/types/loop";
import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import { loopKeys } from "@repo/app/loops/hooks/loop-keys";
import { handleRunLoopResponse } from "@repo/app/loops/lib/run-loop-response";
import { projectTreeKeys } from "@repo/app/projects/hooks/use-project-tree";
import { getErrorMessage } from "@repo/app/shared/api/api-error";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { refreshComputeTargetForReplay } from "@/hooks/queries/compute-target-replay-refresh";
import { postRunLoop } from "@/lib/loops/run-loop-launcher";

export type CreateAndGenerateDocumentResult = {
  artifact: Document;
  status: "launched" | "pending_target_selection";
};

export type GeneratePrdLaunchResult =
  | {
      artifact: Document;
      status: "launched";
    }
  | {
      additionalRepos?: AdditionalRepoRef[];
      artifact: Document;
      availableTargets: ComputeTargetConflictBody["availableTargets"];
      status: "pending_target_selection";
    };

/**
 * Create an artifact and immediately trigger generation workflow via Loops.
 * Used for implementation plans generated from a PRD.
 *
 * Always triggers plan generation via the run-loop endpoint (ECS Loops).
 * Compute target resolution is handled server-side.
 *
 * Stays in apps/app (not @repo/app): `postRunLoop` reaches the Engineer
 * compute-target signing path (`@/lib/loops/run-loop-launcher` →
 * `@/lib/engineer/*`), which is local-only and not surface-agnostic.
 */
export function useCreateAndGenerateDocument() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  const [multiTargetState, setMultiTargetState] = useState<{
    availableTargets: ComputeTargetConflictBody["availableTargets"];
    pendingArtifact: Document;
    pendingDocumentId: string;
    additionalRepos?: AdditionalRepoRef[];
  } | null>(null);

  const mutation = useMutation({
    meta: { suppressDefaultErrorToast: true },
    mutationFn: async ({
      input,
      additionalRepos,
      computeTargetId,
    }: {
      input: CreateDocumentInput;
      additionalRepos?: AdditionalRepoRef[];
      computeTargetId?: string | null;
    }): Promise<CreateAndGenerateDocumentResult> => {
      let artifact: Document;
      try {
        artifact = await apiClient.post<Document>("/documents", input);
      } catch (error) {
        toast.error(getErrorMessage(error));
        throw error;
      }

      // Trigger generation via Loops — compute target resolved server-side
      try {
        await postRunLoop(apiClient, {
          documentId: artifact.id,
          command: RunLoopCommand.Plan,
          ...(computeTargetId === undefined ? {} : { computeTargetId }),
          ...(additionalRepos?.length ? { additionalRepos } : {}),
        });
        return { artifact, status: "launched" };
      } catch (error) {
        let isPendingTargetSelection = false;
        handleRunLoopResponse(error, {
          onMultipleTargets: (conflict) => {
            isPendingTargetSelection = true;
            setMultiTargetState({
              availableTargets: conflict.availableTargets,
              pendingArtifact: artifact,
              pendingDocumentId: artifact.id,
              additionalRepos,
            });
          },
          onBackendMismatch: () => {
            // Surface the mismatch so the create+generate flow isn't a silent
            // failure (the created document is otherwise orphaned with no
            // feedback). Mirrors useGeneratePrdLaunch below; a richer
            // BackendMismatchModal is tracked separately in T-3.4.
            toast.error(getErrorMessage(error));
          },
          onSuccess: () => {
            // unreachable: catch only receives thrown errors
          },
        });
        if (isPendingTargetSelection) {
          return { artifact, status: "pending_target_selection" };
        }
        throw error;
      }
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: documentKeys.lists() });
      queryClient.invalidateQueries({ queryKey: documentKeys.bySlugs() });
      queryClient.invalidateQueries({
        queryKey: documentKeys.generationStatus(data.artifact.id),
      });
      if (data.artifact.projectId) {
        queryClient.invalidateQueries({
          queryKey: projectTreeKeys.detail(data.artifact.projectId),
        });
      }
    },
  });

  const selectTarget = useCallback(
    async (targetId: string) => {
      if (!multiTargetState) {
        return;
      }
      const { pendingArtifact, pendingDocumentId, additionalRepos } =
        multiTargetState;
      try {
        await refreshComputeTargetForReplay(apiClient, queryClient, targetId);
        await postRunLoop(apiClient, {
          documentId: pendingDocumentId,
          command: RunLoopCommand.Plan,
          computeTargetId: targetId,
          ...(additionalRepos?.length ? { additionalRepos } : {}),
        });
        // Clear only after the retry succeeds — keeping the pending state
        // until then leaves the target picker mounted so the user can re-pick
        // if this launch fails, rather than being stranded with an orphaned
        // document and a dismissed dialog.
        setMultiTargetState(null);
        queryClient.invalidateQueries({
          queryKey: documentKeys.generationStatus(pendingDocumentId),
        });
        return { artifact: pendingArtifact, status: "launched" } as const;
      } catch (retryError) {
        toast.error(
          retryError instanceof Error
            ? retryError.message
            : "Failed to start plan generation"
        );
        return undefined;
      }
    },
    [multiTargetState, apiClient, queryClient]
  );

  const clearTargetSelection = useCallback(() => {
    setMultiTargetState(null);
  }, []);

  return { ...mutation, clearTargetSelection, multiTargetState, selectTarget };
}

/**
 * Launches PRD generation for a newly-created artifact through a dedicated
 * mutation so component call sites can use mutate callbacks instead of
 * `mutateAsync` try/catch flows.
 */
export function useGeneratePrdLaunch() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    meta: { suppressDefaultErrorToast: true },
    mutationFn: async ({
      additionalRepos,
      artifact,
      computeTargetId,
    }: {
      additionalRepos?: AdditionalRepoRef[];
      artifact: Document;
      computeTargetId?: string | null;
    }): Promise<GeneratePrdLaunchResult> => {
      try {
        if (typeof computeTargetId === "string") {
          try {
            await refreshComputeTargetForReplay(
              apiClient,
              queryClient,
              computeTargetId
            );
          } catch (refreshError) {
            toast.error(
              refreshError instanceof Error
                ? refreshError.message
                : "Failed to refresh compute targets before retrying."
            );
            throw refreshError;
          }
        }
        await postRunLoop(apiClient, {
          documentId: artifact.id,
          command: RunLoopCommand.GeneratePrd,
          ...(computeTargetId === undefined ? {} : { computeTargetId }),
          ...(additionalRepos?.length ? { additionalRepos } : {}),
        });
        return { artifact, status: "launched" };
      } catch (error) {
        let availableTargets:
          | ComputeTargetConflictBody["availableTargets"]
          | undefined;

        handleRunLoopResponse(error, {
          onMultipleTargets: (conflict) => {
            availableTargets = conflict.availableTargets;
          },
          onBackendMismatch: () => {
            toast.error(getErrorMessage(error));
          },
          onSuccess: () => {
            // unreachable: catch only receives thrown errors
          },
        });

        if (availableTargets) {
          return {
            additionalRepos,
            artifact,
            availableTargets,
            status: "pending_target_selection",
          };
        }
        throw error;
      }
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({
        queryKey: documentKeys.generationStatus(data.artifact.id),
      });
      queryClient.invalidateQueries({ queryKey: loopKeys.all });
    },
  });
}
