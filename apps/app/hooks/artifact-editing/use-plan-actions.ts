"use client";

import type {
  BackendMismatchBody,
  ComputeTargetConflictBody,
} from "@repo/api/src/types/compute-target";
import { RunLoopCommand } from "@repo/api/src/types/loop";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useCallback, useRef, useState } from "react";
import { useUpdateArtifact } from "@/hooks/queries/use-artifacts";
import { useRunLoop } from "@/hooks/queries/use-loops";
import { handleRunLoopResponse } from "@/lib/run-loop-response";

type UsePlanActionsConfig = {
  artifactId: string;
};

type RunLoopParams = {
  command: RunLoopCommand;
  prompt?: string;
  computeTargetId?: string;
  backendOverride?: boolean;
};

/**
 * Hook to manage plan-specific actions: approve, regenerate, request changes, and execute.
 *
 * **Use this hook when:** Your component handles plan workflow operations (approval, execution, regeneration).
 *
 * **What it provides:**
 * - Approve operation (updates status to APPROVED)
 * - Regenerate operation (triggers plan regeneration via Loops)
 * - Request changes operation (submits feedback and triggers regeneration with changes)
 * - Execute operation (triggers implementation execution, creates PR)
 * - Loading states for each operation
 * - Multi-target state and selectTarget for compute target conflict resolution
 *
 * All regenerate/execute/request-changes operations route through the Loops run-loop endpoint.
 * Compute target resolution is handled server-side.
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

  // TanStack Query mutation for artifact approval
  const updateArtifact = useUpdateArtifact();

  // TanStack Query mutation — all plan operations route through run-loop
  const runLoop = useRunLoop();

  // Multi-target conflict state
  const [multiTargetState, setMultiTargetState] = useState<{
    availableTargets: ComputeTargetConflictBody["availableTargets"];
  } | null>(null);
  // Backend mismatch state
  const [backendMismatchState, setBackendMismatchState] =
    useState<BackendMismatchBody | null>(null);
  const pendingActionRef = useRef<((targetId: string) => void) | null>(null);
  const pendingMismatchActionRef = useRef<
    ((targetId: string | null, backendOverride: boolean) => void) | null
  >(null);

  // Derived state
  const isApproving = updateArtifact.isPending;
  const isRegenerating = runLoop.isPending;
  const isRequestingChanges = runLoop.isPending;
  const isExecuting = runLoop.isPending;

  /**
   * Set up pending-action refs so that selectTarget / confirmOriginalBackend /
   * confirmPreferredBackend can replay the same command with the resolved target.
   */
  const prepareConflictRefs = useCallback(
    (baseParams: RunLoopParams): void => {
      pendingActionRef.current = (targetId: string) =>
        runLoop.mutateAsync({
          ...baseParams,
          artifactId,
          computeTargetId: targetId,
        });
      pendingMismatchActionRef.current = (
        targetId: string | null,
        backendOverride: boolean
      ) =>
        runLoop.mutateAsync({
          ...baseParams,
          artifactId,
          computeTargetId: targetId ?? undefined,
          backendOverride,
        });
    },
    [artifactId, runLoop]
  );

  /** Route conflict errors (409) from a run-loop call to the appropriate state setter. */
  const routeConflictError = useCallback((error: unknown): void => {
    handleRunLoopResponse(error, {
      onMultipleTargets: (conflict) =>
        setMultiTargetState({ availableTargets: conflict.availableTargets }),
      onBackendMismatch: (body) => setBackendMismatchState(body),
      onSuccess: () => {
        // unreachable: error handlers only receive thrown errors
      },
    });
  }, []);

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
   * Regenerate the implementation plan via Loops.
   * Creates a Loop with command="plan". Compute target is resolved server-side.
   */
  const handleRegenerate = useCallback(() => {
    prepareConflictRefs({ command: RunLoopCommand.Plan });
    runLoop.mutate(
      { artifactId, command: RunLoopCommand.Plan },
      {
        onSuccess: () => toast.success("Plan regeneration started via Loop"),
        onError: routeConflictError,
      }
    );
  }, [artifactId, runLoop, prepareConflictRefs, routeConflictError]);

  /**
   * Request changes to the implementation plan via Loops.
   * Creates a Loop with command="request_changes". Compute target is resolved server-side.
   * Returns a promise that resolves to true on success, false on error.
   */
  const handleRequestChanges = useCallback(
    async (changes: string): Promise<boolean> => {
      prepareConflictRefs({
        command: RunLoopCommand.RequestChanges,
        prompt: changes,
      });
      try {
        await runLoop.mutateAsync(
          {
            artifactId,
            command: RunLoopCommand.RequestChanges,
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
      } catch (error) {
        routeConflictError(error);
        return false;
      }
    },
    [artifactId, runLoop, prepareConflictRefs, routeConflictError]
  );

  /**
   * Execute the approved implementation plan via Loops.
   * Creates a Loop with command="execute". Compute target is resolved server-side.
   */
  const handleExecute = useCallback(async (): Promise<boolean> => {
    prepareConflictRefs({ command: RunLoopCommand.Execute });
    try {
      await runLoop.mutateAsync(
        { artifactId, command: RunLoopCommand.Execute },
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
      routeConflictError(error);
      // Non-conflict errors are toasted by the global QueryClient mutations.onError handler.
      return false;
    }
  }, [artifactId, runLoop, prepareConflictRefs, routeConflictError]);

  const selectTarget = useCallback((targetId: string) => {
    setMultiTargetState(null);
    pendingActionRef.current?.(targetId);
  }, []);

  const confirmOriginalBackend = useCallback(() => {
    if (!backendMismatchState) {
      return;
    }
    const targetId = backendMismatchState.originalComputeTargetId;
    setBackendMismatchState(null);
    pendingMismatchActionRef.current?.(targetId, true);
  }, [backendMismatchState]);

  const confirmPreferredBackend = useCallback(() => {
    if (!backendMismatchState) {
      return;
    }
    const targetId = backendMismatchState.preferredComputeTargetId;
    setBackendMismatchState(null);
    pendingMismatchActionRef.current?.(targetId, true);
  }, [backendMismatchState]);

  const dismissBackendMismatch = useCallback(() => {
    setBackendMismatchState(null);
  }, []);

  return {
    // Action handlers
    handleApprove,
    handleRegenerate,
    handleRequestChanges,
    handleExecute,
    selectTarget,
    confirmOriginalBackend,
    confirmPreferredBackend,
    dismissBackendMismatch,

    // Loading states
    isApproving,
    isRegenerating,
    isRequestingChanges,
    isExecuting,

    // Multi-target conflict state
    multiTargetState,
    // Backend mismatch state
    backendMismatchState,
  };
}
