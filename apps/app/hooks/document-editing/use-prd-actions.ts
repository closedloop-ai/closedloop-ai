"use client";

import type { ComputeTargetConflictBody } from "@repo/api/src/types/compute-target";
import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
import { RunLoopCommand } from "@repo/api/src/types/loop";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useMemo, useState } from "react";
import { useDocumentRunLoop } from "@/hooks/document-editing/use-document-run-loop";
import { parseComputeTargetConflict } from "@/lib/compute-target-conflict";

type UsePrdActionsConfig = {
  documentId: string;
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
 *   usePrdActions({ documentId });
 *
 * <Button onClick={() => handleRequestChanges("Please add more detail")}>Request Changes</Button>
 * ```
 *
 * **Important:** Request changes returns a Promise<boolean> for modal handling.
 */
export function usePrdActions({ documentId }: UsePrdActionsConfig) {
  const { runLoop, makeRequestChangesHandler, multiTargetState, selectTarget } =
    useDocumentRunLoop({
      documentId,
    });

  const [pendingCommand, setPendingCommand] = useState<RunLoopCommand | null>(
    null
  );

  const [decomposeTargetState, setDecomposeTargetState] = useState<{
    availableTargets: ComputeTargetConflictBody["availableTargets"];
  } | null>(null);

  /**
   * Request changes to the PRD via Loops.
   * Creates a Loop with command="request_prd_changes". Compute target is resolved server-side.
   * Returns a promise that resolves to true on success, false on error.
   */
  const handleRequestChanges = useMemo(() => {
    const handler = makeRequestChangesHandler(
      RunLoopCommand.RequestPrdChanges,
      "Change request submitted via Loop - generating updated PRD..."
    );
    return (changes: string) => {
      setPendingCommand(RunLoopCommand.RequestPrdChanges);
      return handler(changes).finally(() => {
        setPendingCommand(null);
      });
    };
  }, [makeRequestChangesHandler]);

  const handleGeneratePrd = (additionalRepos?: AdditionalRepoRef[]) => {
    setPendingCommand(RunLoopCommand.GeneratePrd);
    runLoop.mutate(
      {
        documentId,
        command: RunLoopCommand.GeneratePrd,
        ...(additionalRepos &&
          additionalRepos.length > 0 && { additionalRepos }),
      },
      {
        onSuccess: () => {
          toast.success("PRD generation started");
          setPendingCommand(null);
        },
        onError: () => {
          setPendingCommand(null);
        },
      }
    );
  };

  const handleDecomposeFeatures = (computeTargetId?: string) => {
    setPendingCommand(RunLoopCommand.Decompose);
    runLoop.mutate(
      { documentId, command: RunLoopCommand.Decompose, computeTargetId },
      {
        onSuccess: () => {
          toast.success("Feature decomposition started");
          setPendingCommand(null);
        },
        onError: (error) => {
          setPendingCommand(null);
          const conflict = parseComputeTargetConflict(error);
          if (conflict) {
            setDecomposeTargetState({
              availableTargets: conflict.availableTargets,
            });
          }
        },
      }
    );
  };

  const handleEvaluatePrd = () => {
    setPendingCommand(RunLoopCommand.EvaluatePrd);
    runLoop.mutate(
      { documentId, command: RunLoopCommand.EvaluatePrd },
      {
        onSuccess: () => {
          toast.success("PRD evaluation started");
          setPendingCommand(null);
        },
        onError: () => {
          setPendingCommand(null);
        },
      }
    );
  };

  return {
    handleRequestChanges,
    isRequestingChanges: pendingCommand === RunLoopCommand.RequestPrdChanges,
    handleGeneratePrd,
    isGenerating: pendingCommand === RunLoopCommand.GeneratePrd,
    handleDecomposeFeatures,
    isDecomposing: pendingCommand === RunLoopCommand.Decompose,
    handleEvaluatePrd,
    isEvaluating: pendingCommand === RunLoopCommand.EvaluatePrd,
    decomposeTargetState,
    clearDecomposeTargetState: () => setDecomposeTargetState(null),
    multiTargetState,
    selectTarget,
  };
}
