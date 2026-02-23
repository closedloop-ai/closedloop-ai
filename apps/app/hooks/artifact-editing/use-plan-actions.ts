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
import { useIsLoopsEnabled } from "@/hooks/queries/use-compute-mode";
import { useRunLoop } from "@/hooks/queries/use-loops";

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
 * - Regenerate operation (triggers plan regeneration via GitHub Actions or Loops)
 * - Request changes operation (submits feedback and triggers regeneration with changes)
 * - Execute operation (triggers implementation execution, creates PR)
 * - Loading states for each operation
 *
 * When the organization's compute mode is set to "LOOPS" (via Settings > Integrations),
 * regenerate/execute/request-changes operations create Loops instead of triggering GitHub Actions.
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
  const { isLoopsEnabled: useLoops, isLoading: isComputeModeLoading } =
    useIsLoopsEnabled();

  // TanStack Query mutations - GitHub Actions path
  const updateArtifact = useUpdateArtifact();
  const regenerateArtifact = useRegenerateArtifact();
  const requestPlanChanges = useRequestPlanChanges();
  const executeImplementationPlan = useExecuteImplementationPlan();

  // TanStack Query mutation - Loops path
  const runLoop = useRunLoop();

  // Derived state
  const isApproving = updateArtifact.isPending;
  const isRegenerating = useLoops
    ? runLoop.isPending
    : regenerateArtifact.isPending;
  const isRequestingChanges = useLoops
    ? runLoop.isPending
    : requestPlanChanges.isPending;
  const isExecuting = useLoops
    ? runLoop.isPending
    : executeImplementationPlan.isPending;

  /**
   * Approve the implementation plan.
   * Updates the artifact status to APPROVED.
   * (Approval is always a direct update, not a loop.)
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
   * When loops are enabled, creates a Loop with command="plan".
   * Otherwise, triggers the symphony-dispatch GitHub Actions workflow.
   */
  const handleRegenerate = useCallback(() => {
    if (useLoops) {
      runLoop.mutate(
        { artifactId: artifact.id, command: "plan" },
        {
          onSuccess: () => toast.success("Plan regeneration started via Loop"),
        }
      );
    } else {
      regenerateArtifact.mutate(artifact.id, {
        onSuccess: () => toast.success("Plan regeneration started"),
      });
    }
  }, [artifact.id, useLoops, runLoop, regenerateArtifact]);

  /**
   * Request changes to the implementation plan.
   * When loops are enabled, creates a Loop with command="request_changes".
   * Otherwise, submits feedback and triggers regeneration via GitHub Actions.
   * Returns a promise that resolves to true on success, false on error.
   */
  const handleRequestChanges = useCallback(
    async (changes: string): Promise<boolean> => {
      if (useLoops) {
        try {
          await runLoop.mutateAsync(
            {
              artifactId: artifact.id,
              command: "request_changes",
              prompt: changes,
            },
            {
              onSuccess: () => {
                toast.success(
                  "Change request submitted via Loop - generating updated plan..."
                );
              },
            }
          );
          return true;
        } catch {
          return false;
        }
      }

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
    [artifact.id, useLoops, runLoop, requestPlanChanges]
  );

  /**
   * Execute the approved implementation plan.
   * When loops are enabled, creates a Loop with command="execute".
   * Otherwise, triggers the symphony-dispatch workflow with command="execute".
   */
  const handleExecute = useCallback(async (): Promise<boolean> => {
    if (useLoops) {
      try {
        await runLoop.mutateAsync(
          { artifactId: artifact.id, command: "execute" },
          {
            onSuccess: () => {
              toast.success(
                "Plan execution started via Loop - a PR will be created shortly"
              );
            },
          }
        );
        return true;
      } catch {
        return false;
      }
    }

    const result = await executeImplementationPlan.mutateAsync(artifact.id, {
      onSuccess: () => {
        toast.success("Plan execution started - a PR will be created shortly");
      },
    });
    return result.success ?? false;
  }, [artifact.id, useLoops, runLoop, executeImplementationPlan]);

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
    isComputeModeLoading,
  };
}
