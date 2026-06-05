"use client";

import { ArtifactStatus } from "@repo/api/src/types/artifact";
import { RunLoopCommand } from "@repo/api/src/types/loop";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useCallback, useMemo, useRef } from "react";
import { useArtifactRunLoop } from "@/hooks/artifact-editing/use-artifact-run-loop";
import { useUpdateArtifact } from "@/hooks/queries/use-artifacts";

type UsePlanActionsConfig = {
  artifactId: string | null;
  slug?: string;
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
 * - Evaluate PR operation (code judges on the open PR branch; requires PR in UI)
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

  // Generic conflict-resolution machinery
  const {
    runLoop,
    prepareConflictRefs,
    routeConflictError,
    makeRequestChangesHandler,
    selectTarget: selectTargetRaw,
    confirmOriginalBackend: confirmOriginalBackendRaw,
    confirmPreferredBackend: confirmPreferredBackendRaw,
    dismissBackendMismatch,
    multiTargetState,
    backendMismatchState,
  } = useArtifactRunLoop({ artifactId });

  // Tracks which evaluate command is currently active (null when idle)
  const activeCommandRef = useRef<RunLoopCommand | null>(null);

  // Derived state
  const isApproving = updateArtifact.isPending;
  const isRegenerating = runLoop.isPending;
  const isRequestingChanges = runLoop.isPending;
  const isExecuting = runLoop.isPending;
  const isEvaluatingPlan =
    activeCommandRef.current === RunLoopCommand.EvaluatePlan &&
    runLoop.isPending;
  const isEvaluatingCode =
    activeCommandRef.current === RunLoopCommand.EvaluateCode &&
    runLoop.isPending;

  /**
   * Approve the implementation plan.
   * Updates the artifact status to APPROVED.
   * Cache invalidation is handled by useUpdateArtifact's onSuccess.
   */
  const handleApprove = useCallback((): void => {
    if (!artifactId) {
      return;
    }
    updateArtifact.mutate(
      { id: artifactId, status: ArtifactStatus.Approved },
      { onSuccess: () => toast.success("Plan approved") }
    );
  }, [artifactId, updateArtifact]);

  /**
   * Regenerate the implementation plan via Loops.
   * Creates a Loop with command="plan". Compute target is resolved server-side.
   */
  const handleRegenerate = useCallback(() => {
    if (!artifactId) {
      return;
    }
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
  const handleRequestChanges = useMemo(
    () =>
      makeRequestChangesHandler(
        RunLoopCommand.RequestChanges,
        "Change request submitted via Loop - generating updated plan..."
      ),
    [makeRequestChangesHandler]
  );

  /**
   * Execute the approved implementation plan via Loops.
   * Creates a Loop with command="execute". Compute target is resolved server-side.
   */
  const handleExecute = useCallback(async (): Promise<boolean> => {
    if (!artifactId) {
      return false;
    }
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

  /**
   * Evaluate the implementation plan via Loops.
   * Creates a Loop with command="evaluate_plan". Invalidates plan judge cache on success.
   */
  const handleEvaluatePlan = useCallback(() => {
    if (!artifactId) {
      return;
    }
    activeCommandRef.current = RunLoopCommand.EvaluatePlan;
    prepareConflictRefs(
      { command: RunLoopCommand.EvaluatePlan },
      activeCommandRef
    );
    runLoop.mutate(
      { artifactId, command: RunLoopCommand.EvaluatePlan },
      {
        onSuccess: () => {
          toast.success("Plan evaluation started via Loop");
        },
        onError: routeConflictError,
        onSettled: () => {
          activeCommandRef.current = null;
        },
      }
    );
  }, [artifactId, runLoop, prepareConflictRefs, routeConflictError]);

  /**
   * Evaluate the implementation code on the open PR branch via Loops.
   * Creates a Loop with command="evaluate_code". Invalidates code judge cache on success.
   */
  const handleEvaluateCode = useCallback(
    (prHeadBranch: string, repoFullName: string | null) => {
      if (!artifactId) {
        return;
      }
      activeCommandRef.current = RunLoopCommand.EvaluateCode;
      const repo =
        repoFullName && repoFullName.length > 0
          ? { fullName: repoFullName, branch: prHeadBranch }
          : undefined;
      prepareConflictRefs(
        { command: RunLoopCommand.EvaluateCode, repo },
        activeCommandRef
      );
      runLoop.mutate(
        {
          artifactId,
          command: RunLoopCommand.EvaluateCode,
          ...(repo ? { repo } : {}),
        },
        {
          onSuccess: () => {
            toast.success("PR evaluation started via Loop");
          },
          onError: routeConflictError,
          onSettled: () => {
            activeCommandRef.current = null;
          },
        }
      );
    },
    [artifactId, runLoop, prepareConflictRefs, routeConflictError]
  );

  // Wrap raw conflict functions to close over the local activeCommandRef
  const selectTarget = useCallback(
    (targetId: string) => {
      selectTargetRaw(targetId, activeCommandRef);
    },
    [selectTargetRaw]
  );

  const confirmOriginalBackend = useCallback(() => {
    confirmOriginalBackendRaw(activeCommandRef);
  }, [confirmOriginalBackendRaw]);

  const confirmPreferredBackend = useCallback(() => {
    confirmPreferredBackendRaw(activeCommandRef);
  }, [confirmPreferredBackendRaw]);

  return {
    // Action handlers
    handleApprove,
    handleRegenerate,
    handleRequestChanges,
    handleExecute,
    handleEvaluatePlan,
    handleEvaluateCode,
    selectTarget,
    confirmOriginalBackend,
    confirmPreferredBackend,
    dismissBackendMismatch,

    // Loading states
    isApproving,
    isRegenerating,
    isRequestingChanges,
    isExecuting,
    isEvaluatingPlan,
    isEvaluatingCode,

    // Multi-target conflict state
    multiTargetState,
    // Backend mismatch state
    backendMismatchState,
  };
}
