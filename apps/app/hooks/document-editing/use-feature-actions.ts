"use client";

import { RunLoopCommand } from "@repo/api/src/types/loop";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useCallback } from "react";
import { useDocumentRunLoop } from "@/hooks/document-editing/use-document-run-loop";

type UseFeatureActionsConfig = {
  documentId: string;
};

/**
 * Hook to manage Feature-specific actions: evaluate feature.
 *
 * All operations route through the Loops run-loop endpoint.
 * Compute target resolution is handled server-side;
 * conflict resolution (multi-target, backend mismatch) is handled via useDocumentRunLoop.
 */
export function useFeatureActions({ documentId }: UseFeatureActionsConfig) {
  const {
    runLoop,
    prepareConflictRefs,
    routeConflictError,
    multiTargetState,
    selectTarget,
    backendMismatchState,
    confirmOriginalBackend,
    confirmPreferredBackend,
    dismissBackendMismatch,
  } = useDocumentRunLoop({ documentId });

  const handleEvaluateFeature = useCallback(() => {
    prepareConflictRefs({ command: RunLoopCommand.EvaluateFeature });
    runLoop.mutate(
      { documentId, command: RunLoopCommand.EvaluateFeature },
      {
        onSuccess: () => {
          toast.success("Feature evaluation started");
        },
        onError: routeConflictError,
      }
    );
  }, [documentId, runLoop, prepareConflictRefs, routeConflictError]);

  return {
    handleEvaluateFeature,
    isEvaluating: runLoop.isPending,
    multiTargetState,
    selectTarget,
    backendMismatchState,
    confirmOriginalBackend,
    confirmPreferredBackend,
    dismissBackendMismatch,
  };
}
