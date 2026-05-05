"use client";

import type {
  BackendMismatchBody,
  ComputeTargetConflictBody,
} from "@repo/api/src/types/compute-target";
import type {
  AdditionalRepoRef,
  CreateLoopRequest,
} from "@repo/api/src/types/loop";
import { RunLoopCommand } from "@repo/api/src/types/loop";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRunLoop } from "@/hooks/queries/use-loops";
import { handleRunLoopResponse } from "@/lib/run-loop-response";
import { PreLoopCommand } from "@/lib/system-check/pre-loop-health-check";
import { useOptionalPreLoopSystemCheckGate } from "@/lib/system-check/pre-loop-system-check-provider";

type UseArtifactRunLoopConfig = {
  documentId: string | null;
};

export type RunLoopParams = {
  command: RunLoopCommand;
  prompt?: string;
  computeTargetId?: string | null;
  backendOverride?: boolean;
  repo?: CreateLoopRequest["repo"];
  additionalRepos?: AdditionalRepoRef[];
};

type RunLoopMutationParams = RunLoopParams & { documentId: string };
type RunLoopMutationOptions = Parameters<
  ReturnType<typeof useRunLoop>["mutate"]
>[1];
type RequestChangesResolver = (result: boolean) => void;

/**
 * Generic conflict-resolution machinery for run-loop operations.
 *
 * Extracts the shared compute target conflict handling (multi-target selection,
 * backend mismatch resolution) used across artifact action hooks.
 *
 * **What it provides:**
 * - `runLoop` — the TanStack mutation for posting to the run-loop endpoint
 * - `prepareConflictRefs` — sets up pending-action refs for conflict replay
 * - `routeConflictError` — routes 409 errors to the appropriate state setter
 * - `selectTarget` — resolves multi-target conflict by choosing a target
 * - `confirmOriginalBackend` / `confirmPreferredBackend` — resolves backend mismatch
 * - `dismissBackendMismatch` — dismisses the backend mismatch dialog without retrying
 * - `multiTargetState` / `backendMismatchState` — UI state for conflict dialogs
 * - `pendingConflictCommandRef` / `pendingActionRef` / `pendingMismatchActionRef` — refs
 *
 * **Example usage:**
 * ```tsx
 * const {
 *   runLoop,
 *   prepareConflictRefs,
 *   routeConflictError,
 *   selectTarget,
 *   confirmOriginalBackend,
 *   confirmPreferredBackend,
 *   dismissBackendMismatch,
 *   multiTargetState,
 *   backendMismatchState,
 * } = useDocumentRunLoop({ documentId });
 * ```
 */
export function useDocumentRunLoop({ documentId }: UseArtifactRunLoopConfig) {
  // TanStack Query mutation — all loop operations route through run-loop
  const runLoop = useRunLoop();
  const preLoopGate = useOptionalPreLoopSystemCheckGate();

  // Multi-target conflict state
  const [multiTargetState, setMultiTargetState] = useState<{
    availableTargets: ComputeTargetConflictBody["availableTargets"];
  } | null>(null);

  // Backend mismatch state
  const [backendMismatchState, setBackendMismatchState] =
    useState<BackendMismatchBody | null>(null);

  /** Command last passed to `prepareConflictRefs` — used to restore evaluate loading state on conflict replay. */
  const pendingConflictCommandRef = useRef<RunLoopCommand | null>(null);
  const pendingActionRef = useRef<((targetId: string) => void) | null>(null);
  const pendingMismatchActionRef = useRef<
    ((targetId: string | null, backendOverride: boolean) => void) | null
  >(null);
  const requestChangesResolversRef = useRef<Set<RequestChangesResolver>>(
    new Set()
  );
  const executeOwnerKey = documentId
    ? `run-loop:${RunLoopCommand.Execute}:${documentId}`
    : null;

  useEffect(
    () => () => {
      for (const resolveRequestChanges of requestChangesResolversRef.current) {
        resolveRequestChanges(false);
      }
      requestChangesResolversRef.current.clear();
    },
    []
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

  const runLoopMutationWithOptionalPreLoopCheck = useCallback(
    (params: RunLoopMutationParams, execute: () => void): boolean => {
      if (
        params.command !== RunLoopCommand.Execute ||
        !preLoopGate ||
        !executeOwnerKey
      ) {
        return false;
      }

      preLoopGate
        .runWithPreLoopSystemCheck(
          {
            command: PreLoopCommand.ExecutePlan,
            computeTargetId: params.computeTargetId,
            documentType: "implementation_plan",
            documentId: params.documentId,
            ownerKey: executeOwnerKey,
          },
          execute
        )
        .catch(() => undefined);
      return true;
    },
    [executeOwnerKey, preLoopGate]
  );

  /**
   * Restores the activeCommandRef before replaying a conflicted evaluate command.
   * Pass the caller's activeCommandRef if the hook uses EvaluatePlan/EvaluateCode tracking.
   */
  const restoreEvaluateActiveCommandBeforeReplay = useCallback(
    (activeCommandRef: React.MutableRefObject<RunLoopCommand | null>): void => {
      const pendingCommand = pendingConflictCommandRef.current;
      if (
        pendingCommand === RunLoopCommand.EvaluatePlan ||
        pendingCommand === RunLoopCommand.EvaluateCode
      ) {
        activeCommandRef.current = pendingCommand;
      }
    },
    []
  );

  /**
   * Set up pending-action refs so that selectTarget / confirmOriginalBackend /
   * confirmPreferredBackend can replay the same command with the resolved target.
   *
   * Pass `activeCommandRef` when the caller tracks EvaluatePlan/EvaluateCode loading state.
   */
  const prepareConflictRefs = useCallback(
    (
      baseParams: RunLoopParams,
      activeCommandRef?: React.MutableRefObject<RunLoopCommand | null>
    ): void => {
      pendingConflictCommandRef.current = baseParams.command;
      const { command } = baseParams;
      const clearEvaluateActiveCommandAfterReplay = (): void => {
        if (
          activeCommandRef &&
          (command === RunLoopCommand.EvaluatePlan ||
            command === RunLoopCommand.EvaluateCode)
        ) {
          activeCommandRef.current = null;
        }
      };
      const replayRunLoop = (replayParams: RunLoopMutationParams): void => {
        runLoop.mutate(replayParams, {
          onError: routeConflictError,
          onSettled: clearEvaluateActiveCommandAfterReplay,
        });
      };
      pendingActionRef.current = (targetId: string) => {
        if (!documentId) {
          return;
        }

        const replayParams = {
          ...baseParams,
          documentId,
          computeTargetId: targetId,
        };
        const queuedPreLoopCheck = runLoopMutationWithOptionalPreLoopCheck(
          replayParams,
          () => replayRunLoop(replayParams)
        );
        if (!queuedPreLoopCheck) {
          replayRunLoop(replayParams);
        }
      };
      pendingMismatchActionRef.current = (
        targetId: string | null,
        backendOverride: boolean
      ) => {
        if (!documentId) {
          return;
        }

        const replayParams = {
          ...baseParams,
          documentId,
          computeTargetId: targetId,
          backendOverride,
        };
        const queuedPreLoopCheck = runLoopMutationWithOptionalPreLoopCheck(
          replayParams,
          () => replayRunLoop(replayParams)
        );
        if (!queuedPreLoopCheck) {
          replayRunLoop(replayParams);
        }
      };
    },
    [
      documentId,
      routeConflictError,
      runLoop,
      runLoopMutationWithOptionalPreLoopCheck,
    ]
  );

  /**
   * Resolve a multi-target conflict by selecting a specific compute target.
   * Pass `activeCommandRef` when the caller tracks EvaluatePlan/EvaluateCode loading state.
   */
  const selectTarget = useCallback(
    (
      targetId: string,
      activeCommandRef?: React.MutableRefObject<RunLoopCommand | null>
    ) => {
      setMultiTargetState(null);
      if (activeCommandRef) {
        restoreEvaluateActiveCommandBeforeReplay(activeCommandRef);
      }
      pendingActionRef.current?.(targetId);
    },
    [restoreEvaluateActiveCommandBeforeReplay]
  );

  /**
   * Confirm the original compute backend to resolve a backend mismatch.
   * Pass `activeCommandRef` when the caller tracks EvaluatePlan/EvaluateCode loading state.
   */
  const confirmOriginalBackend = useCallback(
    (activeCommandRef?: React.MutableRefObject<RunLoopCommand | null>) => {
      if (!backendMismatchState) {
        return;
      }
      const targetId = backendMismatchState.originalComputeTargetId;
      setBackendMismatchState(null);
      if (activeCommandRef) {
        restoreEvaluateActiveCommandBeforeReplay(activeCommandRef);
      }
      pendingMismatchActionRef.current?.(targetId, true);
    },
    [backendMismatchState, restoreEvaluateActiveCommandBeforeReplay]
  );

  /**
   * Confirm the preferred compute backend to resolve a backend mismatch.
   * Pass `activeCommandRef` when the caller tracks EvaluatePlan/EvaluateCode loading state.
   */
  const confirmPreferredBackend = useCallback(
    (activeCommandRef?: React.MutableRefObject<RunLoopCommand | null>) => {
      if (!backendMismatchState) {
        return;
      }
      const targetId = backendMismatchState.preferredComputeTargetId;
      setBackendMismatchState(null);
      if (activeCommandRef) {
        restoreEvaluateActiveCommandBeforeReplay(activeCommandRef);
      }
      pendingMismatchActionRef.current?.(targetId, true);
    },
    [backendMismatchState, restoreEvaluateActiveCommandBeforeReplay]
  );

  const dismissBackendMismatch = useCallback(() => {
    setBackendMismatchState(null);
  }, []);

  const isPreLoopExecutePending = Boolean(
    executeOwnerKey && preLoopGate?.pendingOwnerKey === executeOwnerKey
  );

  /**
   * Runs Execute Plan through the pre-loop system-check gate while preserving
   * the raw run-loop mutation path for every other command in this launch.
   */
  const runLoopWithPreLoopSystemCheck = useCallback(
    (params: RunLoopMutationParams, options?: RunLoopMutationOptions): void => {
      if (
        runLoopMutationWithOptionalPreLoopCheck(params, () =>
          runLoop.mutate(params, options)
        )
      ) {
        return;
      }
      runLoop.mutate(params, options);
    },
    [runLoop, runLoopMutationWithOptionalPreLoopCheck]
  );

  /**
   * Factory that creates a `handleRequestChanges`-style handler for a given run-loop command.
   *
   * Eliminates boilerplate shared between plan and PRD request-changes flows:
   * `prepareConflictRefs` → `mutate` → success toast → `routeConflictError` on failure.
   *
   * @param command - The RunLoopCommand to send (e.g. RequestChanges, RequestPrdChanges)
   * @param successMessage - Toast text shown on success
   * @returns An async handler `(changes: string) => Promise<boolean>`
   */
  const makeRequestChangesHandler = useCallback(
    (command: RunLoopCommand, successMessage: string) =>
      (changes: string): Promise<boolean> => {
        if (!documentId) {
          return Promise.resolve(false);
        }
        prepareConflictRefs({ command, prompt: changes });
        return new Promise<boolean>((resolve) => {
          let settled = false;
          const resolveOnce: RequestChangesResolver = (result) => {
            if (settled) {
              return;
            }
            settled = true;
            requestChangesResolversRef.current.delete(resolveOnce);
            resolve(result);
          };
          requestChangesResolversRef.current.add(resolveOnce);

          try {
            runLoop.mutate(
              { documentId, command, prompt: changes },
              {
                onSuccess: () => {
                  toast.success(successMessage);
                  resolveOnce(true);
                },
                onError: (error) => {
                  routeConflictError(error);
                  resolveOnce(false);
                },
              }
            );
          } catch (error) {
            routeConflictError(error);
            resolveOnce(false);
          }
        });
      },
    [documentId, prepareConflictRefs, runLoop, routeConflictError]
  );

  return {
    runLoop,
    prepareConflictRefs,
    routeConflictError,
    selectTarget,
    confirmOriginalBackend,
    confirmPreferredBackend,
    dismissBackendMismatch,
    makeRequestChangesHandler,
    runLoopWithPreLoopSystemCheck,
    isPreLoopExecutePending,
    multiTargetState,
    backendMismatchState,
    pendingConflictCommandRef,
    pendingActionRef,
    pendingMismatchActionRef,
  };
}
