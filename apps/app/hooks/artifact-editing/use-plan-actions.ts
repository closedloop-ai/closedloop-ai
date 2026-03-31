"use client";

import type {
  BackendMismatchBody,
  ComputeTargetConflictBody,
} from "@repo/api/src/types/compute-target";
import type { CreateLoopRequest } from "@repo/api/src/types/loop";
import { RunLoopCommand } from "@repo/api/src/types/loop";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useCallback, useRef, useState } from "react";
import { useUpdateArtifact } from "@/hooks/queries/use-artifacts";
import { useRunLoop } from "@/hooks/queries/use-loops";
import { handleRunLoopResponse } from "@/lib/run-loop-response";

type UsePlanActionsConfig = {
  artifactId: string | null;
};

type RunLoopParams = {
  command: RunLoopCommand;
  prompt?: string;
  computeTargetId?: string;
  backendOverride?: boolean;
  repo?: CreateLoopRequest["repo"];
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

  // TanStack Query mutation — all plan operations route through run-loop
  const runLoop = useRunLoop();

  // Tracks which evaluate command is currently active (null when idle)
  const activeCommandRef = useRef<RunLoopCommand | null>(null);

  // Multi-target conflict state
  const [multiTargetState, setMultiTargetState] = useState<{
    availableTargets: ComputeTargetConflictBody["availableTargets"];
  } | null>(null);
  // Backend mismatch state
  const [backendMismatchState, setBackendMismatchState] =
    useState<BackendMismatchBody | null>(null);
  /** Command last passed to `prepareConflictRefs` — used to restore evaluate loading state on conflict replay. */
  const pendingConflictCommandRef = useRef<RunLoopCommand | null>(null);
  const pendingActionRef = useRef<((targetId: string) => Promise<void>) | null>(
    null
  );
  const pendingMismatchActionRef = useRef<
    | ((targetId: string | null, backendOverride: boolean) => Promise<void>)
    | null
  >(null);

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

  const restoreEvaluateActiveCommandBeforeReplay = useCallback((): void => {
    const pendingCommand = pendingConflictCommandRef.current;
    if (
      pendingCommand === RunLoopCommand.EvaluatePlan ||
      pendingCommand === RunLoopCommand.EvaluateCode
    ) {
      activeCommandRef.current = pendingCommand;
    }
  }, []);

  /**
   * Set up pending-action refs so that selectTarget / confirmOriginalBackend /
   * confirmPreferredBackend can replay the same command with the resolved target.
   */
  const prepareConflictRefs = useCallback(
    (baseParams: RunLoopParams): void => {
      pendingConflictCommandRef.current = baseParams.command;
      const { command } = baseParams;
      const clearEvaluateActiveCommandAfterReplay = (): void => {
        if (
          command === RunLoopCommand.EvaluatePlan ||
          command === RunLoopCommand.EvaluateCode
        ) {
          activeCommandRef.current = null;
        }
      };
      pendingActionRef.current = async (targetId: string) => {
        if (!artifactId) {
          return;
        }
        try {
          await runLoop.mutateAsync({
            ...baseParams,
            artifactId,
            computeTargetId: targetId,
          });
        } finally {
          clearEvaluateActiveCommandAfterReplay();
        }
      };
      pendingMismatchActionRef.current = async (
        targetId: string | null,
        backendOverride: boolean
      ) => {
        if (!artifactId) {
          return;
        }
        try {
          await runLoop.mutateAsync({
            ...baseParams,
            artifactId,
            computeTargetId: targetId ?? undefined,
            backendOverride,
          });
        } finally {
          clearEvaluateActiveCommandAfterReplay();
        }
      };
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
      onRateLimited: (message) => toast.error(message),
    });
  }, []);

  /**
   * Approve the implementation plan.
   * Updates the artifact status to APPROVED.
   * (Approval is always a direct update, not a loop.)
   */
  const handleApprove = useCallback(() => {
    if (!artifactId) {
      return;
    }
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
  const handleRequestChanges = useCallback(
    async (changes: string): Promise<boolean> => {
      if (!artifactId) {
        return false;
      }
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
    prepareConflictRefs({ command: RunLoopCommand.EvaluatePlan });
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
      prepareConflictRefs({ command: RunLoopCommand.EvaluateCode, repo });
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

  const selectTarget = useCallback(
    (targetId: string) => {
      setMultiTargetState(null);
      restoreEvaluateActiveCommandBeforeReplay();
      pendingActionRef.current?.(targetId);
    },
    [restoreEvaluateActiveCommandBeforeReplay]
  );

  const confirmOriginalBackend = useCallback(() => {
    if (!backendMismatchState) {
      return;
    }
    const targetId = backendMismatchState.originalComputeTargetId;
    setBackendMismatchState(null);
    restoreEvaluateActiveCommandBeforeReplay();
    pendingMismatchActionRef.current?.(targetId, true);
  }, [backendMismatchState, restoreEvaluateActiveCommandBeforeReplay]);

  const confirmPreferredBackend = useCallback(() => {
    if (!backendMismatchState) {
      return;
    }
    const targetId = backendMismatchState.preferredComputeTargetId;
    setBackendMismatchState(null);
    restoreEvaluateActiveCommandBeforeReplay();
    pendingMismatchActionRef.current?.(targetId, true);
  }, [backendMismatchState, restoreEvaluateActiveCommandBeforeReplay]);

  const dismissBackendMismatch = useCallback(() => {
    setBackendMismatchState(null);
  }, []);

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
