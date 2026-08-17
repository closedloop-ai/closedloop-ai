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
 * Create a DRAFT PRD seeded from an evergreen Document (DocumentType.Doc) in a
 * chosen project, then launch the existing GENERATE_PRD engine against it.
 *
 * Two server calls, mirroring the CreateDocumentModal "Generate PRD" flow:
 *   1. POST /documents/:id/generate-prd-from-doc — server seeds the PRD with the
 *      source Document's content and writes the RelatesTo provenance link.
 *   2. postRunLoop(RunLoopCommand.GeneratePrd) — the run-loop endpoint picks up
 *      that seeded content as the primary artifact in the context pack.
 *
 * The seed and the launch are two separate writes. When the launch conflicts on
 * compute target, the seeded PRD is held in `multiTargetState` and only the
 * launch is replayed via `selectTarget` — never the seed. Re-running the whole
 * mutation on every target pick would create a duplicate DRAFT PRD per pick and
 * strand the earlier one (mirrors `useCreateAndGenerateDocument`).
 *
 * `selectTarget` routes replay through `refreshComputeTargetForReplay` before
 * `postRunLoop` so signing reads a fresh full-target snapshot, not the cold or
 * stale conflict hint.
 *
 * Stays in apps/app (not @repo/app) for the same reason as the other launch
 * hooks: `postRunLoop` reaches the local-only Engineer compute-target signing
 * path, which is not surface-agnostic.
 */
export function useGeneratePrdFromDocument() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  const [multiTargetState, setMultiTargetState] = useState<{
    availableTargets: ComputeTargetConflictBody["availableTargets"];
    pendingArtifact: Document;
  } | null>(null);

  // Invalidate the create-owned caches as soon as the seed commits, so the new
  // DRAFT PRD is visible in lists and the project tree even if the subsequent
  // launch throws or waits on target selection.
  const invalidateAfterSeed = useCallback(
    (artifact: Document) => {
      queryClient.invalidateQueries({ queryKey: documentKeys.lists() });
      queryClient.invalidateQueries({ queryKey: documentKeys.bySlugs() });
      queryClient.invalidateQueries({
        queryKey: documentKeys.generationStatus(artifact.id),
      });
      if (artifact.projectId) {
        queryClient.invalidateQueries({
          queryKey: projectTreeKeys.detail(artifact.projectId),
        });
      }
    },
    [queryClient]
  );

  const mutation = useMutation({
    meta: { suppressDefaultErrorToast: true },
    mutationFn: async ({
      documentId,
      projectId,
      title,
      computeTargetId,
    }: {
      documentId: string;
      projectId: string;
      title?: string;
      computeTargetId?: string | null;
    }): Promise<GeneratePrdLaunchResult> => {
      let artifact: Document;
      try {
        artifact = await apiClient.post<Document>(
          `/documents/${documentId}/generate-prd-from-doc`,
          { projectId, ...(title ? { title } : {}) }
        );
      } catch (error) {
        toast.error(getErrorMessage(error));
        throw error;
      }

      // Seed committed — surface it in the caches immediately.
      invalidateAfterSeed(artifact);

      try {
        await postRunLoop(apiClient, {
          documentId: artifact.id,
          command: RunLoopCommand.GeneratePrd,
          ...(computeTargetId === undefined ? {} : { computeTargetId }),
        });
        return { artifact, status: "launched" };
      } catch (error) {
        let availableTargets:
          | ComputeTargetConflictBody["availableTargets"]
          | undefined;
        let handled = false;

        handleRunLoopResponse(error, {
          onMultipleTargets: (conflict) => {
            availableTargets = conflict.availableTargets;
            handled = true;
          },
          onBackendMismatch: () => {
            toast.error(getErrorMessage(error));
            handled = true;
          },
          onSuccess: () => {
            // unreachable: catch only receives thrown errors
          },
        });

        if (availableTargets) {
          // Hold the already-seeded PRD so target selection replays only the
          // launch, never a second seed POST.
          setMultiTargetState({
            availableTargets,
            pendingArtifact: artifact,
          });
          return {
            artifact,
            availableTargets,
            status: "pending_target_selection",
          };
        }
        // The seed PRD already committed, so a generic launch failure would
        // otherwise strand it with no feedback (the global error toast is
        // suppressed for this mutation). Surface it before re-throwing, unless
        // a specific handler above already toasted.
        if (!handled) {
          toast.error(getErrorMessage(error));
        }
        throw error;
      }
    },
    onSuccess: () => {
      // Seed-owned caches were already invalidated in `invalidateAfterSeed`;
      // once the launch settles, refresh the loop list too.
      queryClient.invalidateQueries({ queryKey: loopKeys.all });
    },
  });

  const selectTarget = useCallback(
    // `null` is the pre-loop gate's "run this on Cloud" verdict (ISS-5171),
    // not an absent selection: there is no local target to refresh, and the
    // launch must carry the null through rather than fall back to a machine
    // the gate just found unreachable.
    async (targetId: string | null) => {
      if (!multiTargetState) {
        return;
      }
      const { pendingArtifact } = multiTargetState;
      try {
        if (targetId !== null) {
          await refreshComputeTargetForReplay(apiClient, queryClient, targetId);
        }
        await postRunLoop(apiClient, {
          documentId: pendingArtifact.id,
          command: RunLoopCommand.GeneratePrd,
          computeTargetId: targetId,
        });
        // Clear only after the replay launch succeeds — keeping the pending
        // state until then leaves the target picker mounted so the user can
        // re-pick if this launch fails.
        setMultiTargetState(null);
        queryClient.invalidateQueries({
          queryKey: documentKeys.generationStatus(pendingArtifact.id),
        });
        queryClient.invalidateQueries({ queryKey: loopKeys.all });
        return { artifact: pendingArtifact, status: "launched" } as const;
      } catch (retryError) {
        toast.error(
          retryError instanceof Error
            ? retryError.message
            : "Failed to start PRD generation"
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
