"use client";

import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useCallback } from "react";
import {
  useExecuteImplementationPlan,
  useRegenerateArtifact,
  useRequestPlanChanges,
  useUpdateArtifact,
} from "@/hooks/queries/use-artifacts";

type UsePlanActionsConfig = {
  artifact: ArtifactWithWorkstream;
};

/**
 * Hook to manage plan-specific actions: approve, regenerate, request changes, and execute.
 *
 * **Use this hook when:** Your component handles plan workflow operations (approval, execution, regeneration).
 *
 * **What it provides:**
 * - Approve operation (updates status to APPROVED)
 * - Regenerate operation (triggers plan regeneration via symphony-dispatch GitHub Actions workflow)
 * - Request changes operation (submits feedback and triggers regeneration with changes)
 * - Execute operation (triggers implementation execution via symphony-dispatch, creates PR)
 * - Loading states for each operation
 *
 * **Example usage:**
 * ```tsx
 * const { handleApprove, handleExecute, handleRequestChanges, isExecuting } =
 *   usePlanActions({ artifact });
 *
 * <Button onClick={handleApprove}>Approve Plan</Button>
 * <Button onClick={handleExecute} disabled={isExecuting}>Execute Plan</Button>
 * <Button onClick={() => handleRequestChanges("Please add error handling")}>Request Changes</Button>
 * ```
 *
 * **Important:** Execute operation requires plan to be APPROVED. Request changes returns a Promise<boolean> for modal handling.
 */
export function usePlanActions(config: UsePlanActionsConfig) {
  const { artifact } = config;

  // TanStack Query mutations
  const updateArtifact = useUpdateArtifact();
  const regenerateArtifact = useRegenerateArtifact();
  const requestPlanChanges = useRequestPlanChanges();
  const executeImplementationPlan = useExecuteImplementationPlan();

  // Derived state
  const isApproving = updateArtifact.isPending;
  const isRegenerating = regenerateArtifact.isPending;
  const isRequestingChanges = requestPlanChanges.isPending;
  const isExecuting = executeImplementationPlan.isPending;

  /**
   * Approve the implementation plan.
   * Updates the artifact status to APPROVED.
   */
  const handleApprove = useCallback(() => {
    updateArtifact.mutate(
      { id: artifact.id, status: "APPROVED" },
      {
        onSuccess: () => toast.success("Plan approved"),
      }
    );
  }, [artifact.id, updateArtifact]);

  /**
   * Regenerate the implementation plan.
   * Triggers the symphony-dispatch workflow to regenerate the plan via GitHub Actions.
   */
  const handleRegenerate = useCallback(() => {
    regenerateArtifact.mutate(
      { id: artifact.id },
      { onSuccess: () => toast.success("Plan regeneration started") }
    );
  }, [artifact.id, regenerateArtifact]);

  /**
   * Request changes to the implementation plan.
   * Submits feedback and triggers regeneration with the requested changes.
   * Returns a promise that resolves to true on success, false on error.
   */
  const handleRequestChanges = useCallback(
    async (changes: string): Promise<boolean> => {
      const result = await requestPlanChanges.mutateAsync(
        { artifactId: artifact.id, changes },
        {
          onSuccess: () => {
            toast.success(
              "Change request submitted - generating updated plan..."
            );
          },
        }
      );
      return result.success ?? false;
    },
    [artifact.id, requestPlanChanges]
  );

  /**
   * Execute the approved implementation plan.
   * Triggers the symphony-dispatch workflow with command="execute" to generate code and create a PR.
   */
  const handleExecute = useCallback(async (): Promise<boolean> => {
    const result = await executeImplementationPlan.mutateAsync(artifact.id, {
      onSuccess: () => {
        toast.success("Plan execution started - a PR will be created shortly");
      },
    });
    return result.success ?? false;
  }, [artifact.id, executeImplementationPlan]);

  return {
    // Action handlers
    handleApprove,
    handleRegenerate,
    handleRequestChanges,
    handleExecute,

    // Loading states
    isApproving,
    isRegenerating,
    isRequestingChanges,
    isExecuting,
  };
}
