"use client";

import { DocumentStatus } from "@repo/api/src/types/document";
import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
import { RunLoopCommand } from "@repo/api/src/types/loop";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useCallback, useMemo, useRef } from "react";
import { useDocumentRunLoop } from "@/hooks/document-editing/use-document-run-loop";
import { useUpdateDocument } from "@/hooks/queries/use-documents";

type UsePlanActionsConfig = {
  documentId: string | null;
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
 *   usePlanActions({ documentId });
 *
 * <Button onClick={handleApprove}>Approve Plan</Button>
 * <Button onClick={handleExecute} disabled={isExecuting}>Execute Plan</Button>
 * <Button onClick={() => handleRequestChanges("Please add error handling")}>Request Changes</Button>
 * ```
 *
 * **Important:** Execute operation requires plan to be APPROVED. Request changes returns a Promise<boolean> for modal handling.
 */
export function usePlanActions(config: UsePlanActionsConfig) {
  const { documentId } = config;

  // TanStack Query mutation for artifact approval
  const updateArtifact = useUpdateDocument();

  // Generic conflict-resolution machinery
  const {
    runLoop,
    runLoopWithPreLoopSystemCheck,
    isPreLoopExecutePending,
    prepareConflictRefs,
    routeConflictError,
    makeRequestChangesHandler,
    selectTarget: selectTargetRaw,
    confirmOriginalBackend: confirmOriginalBackendRaw,
    confirmPreferredBackend: confirmPreferredBackendRaw,
    dismissBackendMismatch,
    multiTargetState,
    backendMismatchState,
  } = useDocumentRunLoop({ documentId });

  // Tracks which evaluate command is currently active (null when idle)
  const activeCommandRef = useRef<RunLoopCommand | null>(null);

  // Derived state
  const isApproving = updateArtifact.isPending;
  const isRegenerating = runLoop.isPending;
  const isRequestingChanges = runLoop.isPending;
  const isExecuting = runLoop.isPending || isPreLoopExecutePending;
  const isEvaluatingPlan =
    activeCommandRef.current === RunLoopCommand.EvaluatePlan &&
    runLoop.isPending;
  const isEvaluatingCode =
    activeCommandRef.current === RunLoopCommand.EvaluateCode &&
    runLoop.isPending;

  /**
   * Approve the implementation plan.
   * Updates the artifact status to APPROVED.
   * Cache invalidation is handled by useUpdateDocument's onSuccess.
   */
  const handleApprove = useCallback((): void => {
    if (!documentId) {
      return;
    }
    updateArtifact.mutate(
      { id: documentId, status: DocumentStatus.Approved },
      { onSuccess: () => toast.success("Plan approved") }
    );
  }, [documentId, updateArtifact]);

  /**
   * Regenerate the implementation plan via Loops.
   * Creates a Loop with command="plan". Compute target is resolved server-side.
   */
  const handleRegenerate = useCallback(
    (additionalRepos?: AdditionalRepoRef[]) => {
      if (!documentId) {
        return;
      }
      const params = {
        command: RunLoopCommand.Plan,
        ...(additionalRepos?.length ? { additionalRepos } : {}),
      };
      prepareConflictRefs(params);
      runLoop.mutate(
        { documentId, ...params },
        {
          onSuccess: () => toast.success("Plan regeneration started via Loop"),
          onError: routeConflictError,
        }
      );
    },
    [documentId, runLoop, prepareConflictRefs, routeConflictError]
  );

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
  const handleExecute = useCallback(
    (additionalRepos?: AdditionalRepoRef[], onSuccess?: () => void): void => {
      if (!documentId) {
        return;
      }
      const params = {
        command: RunLoopCommand.Execute,
        ...(additionalRepos?.length ? { additionalRepos } : {}),
      };
      prepareConflictRefs(params);
      runLoopWithPreLoopSystemCheck(
        { documentId, ...params },
        {
          onSuccess: () => {
            toast.success(
              "Plan execution started via Loop - a PR will be created shortly"
            );
            onSuccess?.();
          },
          onError: routeConflictError,
        }
      );
    },
    [
      documentId,
      runLoopWithPreLoopSystemCheck,
      prepareConflictRefs,
      routeConflictError,
    ]
  );

  /**
   * Evaluate the implementation plan via Loops.
   * Creates a Loop with command="evaluate_plan". Invalidates plan judge cache on success.
   */
  const handleEvaluatePlan = useCallback(() => {
    if (!documentId) {
      return;
    }
    activeCommandRef.current = RunLoopCommand.EvaluatePlan;
    prepareConflictRefs(
      { command: RunLoopCommand.EvaluatePlan },
      activeCommandRef
    );
    runLoop.mutate(
      { documentId, command: RunLoopCommand.EvaluatePlan },
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
  }, [documentId, runLoop, prepareConflictRefs, routeConflictError]);

  /**
   * Evaluate the implementation code on the open PR branch via Loops.
   * Creates a Loop with command="evaluate_code". Invalidates code judge cache on success.
   */
  const handleEvaluateCode = useCallback(
    (prHeadBranch: string, repoFullName: string | null) => {
      if (!documentId) {
        return;
      }
      activeCommandRef.current = RunLoopCommand.EvaluateCode;
      const repo = repoFullName
        ? { fullName: repoFullName, branch: prHeadBranch }
        : undefined;
      prepareConflictRefs(
        { command: RunLoopCommand.EvaluateCode, repo },
        activeCommandRef
      );
      runLoop.mutate(
        {
          documentId,
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
    [documentId, runLoop, prepareConflictRefs, routeConflictError]
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
