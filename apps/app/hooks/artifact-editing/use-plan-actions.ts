"use client";

import type { ComputeTargetConflictBody } from "@repo/api/src/types/compute-target";
import { RunLoopCommand } from "@repo/api/src/types/loop";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useCallback, useRef, useState } from "react";
import { useIsLoopsEnabledForArtifact } from "@/hooks/queries/use-artifact-execution-backend";
import {
  useExecuteImplementationPlan,
  useRegenerateArtifact,
  useRequestPlanChanges,
  useUpdateArtifact,
} from "@/hooks/queries/use-artifacts";
import { useRunLoop } from "@/hooks/queries/use-loops";
import { parseComputeTargetConflict } from "@/lib/compute-target-conflict";
import { useEngineerRoutingSelection } from "@/lib/engineer/routing-store";

type UsePlanActionsConfig = {
  artifactId: string;
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
 * - Multi-target state and selectTarget for compute target conflict resolution
 *
 * Routes regenerate/execute/request-changes operations to either Loops or GitHub Actions
 * based on the artifact's execution history, falling back to the org's compute mode setting.
 *
 * **Example usage:**
 * ```tsx
 * const { handleApprove, handleExecute, handleRequestChanges, isExecuting } =
 *   usePlanActions({ artifactId });
 *
 * <Button onClick={handleApprove}>Approve Plan</Button>
 * <Button onClick={handleExecute} disabled={isExecuting}>Execute Plan</Button>
 * <Button onClick={() => handleRequestChanges("Please add error handling")}>Request Changes</Button>
 * ```
 *
 * **Important:** Execute operation requires plan to be APPROVED. Request changes returns a Promise<boolean> for modal handling.
 */
export function usePlanActions(config: UsePlanActionsConfig) {
  const { artifactId } = config;
  const { isLoopsEnabled: useLoops, isLoading: isComputeModeLoading } =
    useIsLoopsEnabledForArtifact(artifactId);
  // TanStack Query mutations - GitHub Actions path
  const updateArtifact = useUpdateArtifact();
  const regenerateArtifact = useRegenerateArtifact();
  const requestPlanChanges = useRequestPlanChanges();
  const executeImplementationPlan = useExecuteImplementationPlan();

  // TanStack Query mutation - Loops path
  const runLoop = useRunLoop();

  const routing = useEngineerRoutingSelection();
  // Pass computeTargetId for both CloudRelay and LocalElectron modes.
  const computeTargetId = routing.computeTargetId;

  // Multi-target conflict state
  const [multiTargetState, setMultiTargetState] = useState<{
    availableTargets: ComputeTargetConflictBody["availableTargets"];
  } | null>(null);
  const pendingActionRef = useRef<((targetId: string) => void) | null>(null);

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
      { id: artifactId, status: "APPROVED" },
      {
        onSuccess: () => toast.success("Plan approved"),
      }
    );
  }, [artifactId, updateArtifact]);

  /**
   * Regenerate the implementation plan.
   * When loops are enabled, creates a Loop with command="plan".
   * Otherwise, triggers the symphony-dispatch GitHub Actions workflow.
   */
  const handleRegenerate = useCallback(() => {
    if (useLoops) {
      pendingActionRef.current = (targetId: string) =>
        runLoop.mutateAsync({
          artifactId,
          command: RunLoopCommand.Plan,
          computeTargetId: targetId,
        });

      runLoop.mutate(
        { artifactId, command: RunLoopCommand.Plan, computeTargetId },
        {
          onSuccess: () => toast.success("Plan regeneration started via Loop"),
          onError: (error) => {
            const conflict = parseComputeTargetConflict(error);
            if (conflict) {
              setMultiTargetState({
                availableTargets: conflict.availableTargets,
              });
            }
          },
        }
      );
    } else {
      regenerateArtifact.mutate(
        { id: artifactId },
        {
          onSuccess: () => toast.success("Plan regeneration started"),
        }
      );
    }
  }, [artifactId, useLoops, runLoop, regenerateArtifact, computeTargetId]);

  /**
   * Request changes to the implementation plan.
   * When loops are enabled, creates a Loop with command="request_changes".
   * Otherwise, submits feedback and triggers regeneration via GitHub Actions.
   * Returns a promise that resolves to true on success, false on error.
   */
  const handleRequestChanges = useCallback(
    async (changes: string): Promise<boolean> => {
      if (useLoops) {
        pendingActionRef.current = (targetId: string) =>
          runLoop.mutateAsync({
            artifactId,
            command: RunLoopCommand.RequestChanges,
            prompt: changes,
            computeTargetId: targetId,
          });

        try {
          await runLoop.mutateAsync(
            {
              artifactId,
              command: RunLoopCommand.RequestChanges,
              prompt: changes,
              computeTargetId,
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
        } catch (error) {
          const conflict = parseComputeTargetConflict(error);

          if (conflict) {
            setMultiTargetState({
              availableTargets: conflict.availableTargets,
            });
          }
          return false;
        }
      }

      const result = await requestPlanChanges.mutateAsync(
        { artifactId, changes },
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
    [artifactId, useLoops, runLoop, requestPlanChanges, computeTargetId]
  );

  /**
   * Execute the approved implementation plan.
   * When loops are enabled, creates a Loop with command="execute".
   * Otherwise, triggers the symphony-dispatch workflow with command="execute".
   */
  const handleExecute = useCallback(async (): Promise<boolean> => {
    if (useLoops) {
      pendingActionRef.current = (targetId: string) =>
        runLoop.mutateAsync({
          artifactId,
          command: RunLoopCommand.Execute,
          computeTargetId: targetId,
        });

      try {
        await runLoop.mutateAsync(
          { artifactId, command: RunLoopCommand.Execute, computeTargetId },
          {
            onSuccess: () => {
              toast.success(
                "Plan execution started via Loop - a PR will be created shortly"
              );
            },
          }
        );
        return true;
      } catch (error) {
        const conflict = parseComputeTargetConflict(error);

        if (conflict) {
          setMultiTargetState({ availableTargets: conflict.availableTargets });
        }
        // Non-conflict errors are toasted by the global QueryClient mutations.onError handler.
        return false;
      }
    }

    const result = await executeImplementationPlan.mutateAsync(artifactId, {
      onSuccess: () => {
        toast.success("Plan execution started - a PR will be created shortly");
      },
    });
    return result.success ?? false;
  }, [
    artifactId,
    useLoops,
    runLoop,
    executeImplementationPlan,
    computeTargetId,
  ]);

  const selectTarget = useCallback((targetId: string) => {
    setMultiTargetState(null);
    pendingActionRef.current?.(targetId);
  }, []);

  return {
    // Action handlers
    handleApprove,
    handleRegenerate,
    handleRequestChanges,
    handleExecute,
    selectTarget,

    // Loading states
    isApproving,
    isRegenerating,
    isRequestingChanges,
    isExecuting,
    isComputeModeLoading,

    // Multi-target conflict state
    multiTargetState,
  };
}
