"use client";

import { RunLoopCommand } from "@repo/api/src/types/loop";
import { useMemo } from "react";
import { useArtifactRunLoop } from "@/hooks/artifact-editing/use-artifact-run-loop";

type UsePrdActionsConfig = {
  artifactId: string | null;
};

/**
 * Hook to manage PRD-specific actions: request changes.
 *
 * **Use this hook when:** Your component handles PRD workflow operations (requesting changes).
 *
 * **What it provides:**
 * - Request changes operation (submits feedback and triggers PRD regeneration with changes)
 * - Loading state for the request changes operation
 * - Multi-target state and selectTarget for compute target conflict resolution
 *
 * All operations route through the Loops run-loop endpoint.
 * Compute target resolution is handled server-side.
 *
 * **Example usage:**
 * ```tsx
 * const { handleRequestChanges, isRequestingChanges, multiTargetState } =
 *   usePrdActions({ artifactId });
 *
 * <Button onClick={() => handleRequestChanges("Please add more detail")}>Request Changes</Button>
 * ```
 *
 * **Important:** Request changes returns a Promise<boolean> for modal handling.
 */
export function usePrdActions({ artifactId }: UsePrdActionsConfig) {
  const {
    runLoop,
    makeRequestChangesHandler,
    selectTarget,
    confirmOriginalBackend,
    confirmPreferredBackend,
    dismissBackendMismatch,
    multiTargetState,
    backendMismatchState,
  } = useArtifactRunLoop({ artifactId });

  const isRequestingChanges = runLoop.isPending;

  /**
   * Request changes to the PRD via Loops.
   * Creates a Loop with command="request_prd_changes". Compute target is resolved server-side.
   * Returns a promise that resolves to true on success, false on error.
   */
  const handleRequestChanges = useMemo(
    () =>
      makeRequestChangesHandler(
        RunLoopCommand.RequestPrdChanges,
        "Change request submitted via Loop - generating updated PRD..."
      ),
    [makeRequestChangesHandler]
  );

  return {
    runLoop,
    handleRequestChanges,
    isRequestingChanges,
    multiTargetState,
    backendMismatchState,
    selectTarget,
    confirmOriginalBackend,
    confirmPreferredBackend,
    dismissBackendMismatch,
  };
}
