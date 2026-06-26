"use client";

import type {
  BackendMismatchBody,
  ComputeTargetConflictBody,
} from "@repo/api/src/types/compute-target";
import type {
  AdditionalRepoRef,
  CreateLoopRequest,
  LoopAlreadyActiveBody,
} from "@repo/api/src/types/loop";
import { RunLoopCommand } from "@repo/api/src/types/loop";
import { getCommandLabels } from "@repo/app/loops/lib/loop-display";
import { handleRunLoopResponse } from "@repo/app/loops/lib/run-loop-response";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { refreshComputeTargetForReplay } from "@/hooks/queries/compute-target-replay-refresh";
import { useRunLoop } from "@/hooks/queries/use-loops";
import { useApiClient } from "@/hooks/use-api-client";
import { useOrgSlug } from "@/hooks/use-org-slug";
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
type PendingReplayAction = (
  targetId: string,
  previousState?: {
    availableTargets: ComputeTargetConflictBody["availableTargets"];
  } | null
) => void;
type PendingBackendMismatchAction = (
  targetId: string | null,
  backendOverride: boolean,
  previousState?: BackendMismatchBody | null
) => void;

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
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const orgSlug = useOrgSlug();
  const navigation = useNavigation();
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
  const pendingActionRef = useRef<PendingReplayAction | null>(null);
  const pendingMismatchActionRef = useRef<PendingBackendMismatchAction | null>(
    null
  );
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

  /**
   * Route run-loop errors to the appropriate state setter. Replay callers can
   * provide a restore callback so non-conflict failures reopen the previous
   * selector instead of stranding the user after the selector was dismissed.
   */
  const routeRunLoopError = useCallback(
    (error: unknown, restorePreviousConflictState?: () => void): void => {
      let routedToRetryableConflict = false;
      handleRunLoopResponse(error, {
        onMultipleTargets: (conflict) => {
          routedToRetryableConflict = true;
          setMultiTargetState({ availableTargets: conflict.availableTargets });
        },
        onBackendMismatch: (body) => {
          routedToRetryableConflict = true;
          setBackendMismatchState(body);
        },
        onLoopAlreadyActive: (payload: LoopAlreadyActiveBody) => {
          const label = getCommandLabels(payload.command).noun;
          toast.error(`${label} is already running on this document`, {
            action: {
              label: "View Loop",
              onClick: () => {
                navigation.navigate(`/${orgSlug}/loops/${payload.loopId}`);
              },
            },
          });
        },
        onSuccess: () => {
          // unreachable: error handlers only receive thrown errors
        },
        onRateLimited: (message) => toast.error(message),
      });
      if (!routedToRetryableConflict) {
        restorePreviousConflictState?.();
      }
    },
    [orgSlug, navigation]
  );
  const routeConflictError = useCallback(
    (error: unknown): void => routeRunLoopError(error),
    [routeRunLoopError]
  );

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

  const refreshReplayTarget = useCallback(
    (targetId: string) =>
      refreshComputeTargetForReplay(apiClient, queryClient, targetId),
    [apiClient, queryClient]
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
      const replayRunLoop = (
        replayParams: RunLoopMutationParams,
        restorePreviousConflictState?: () => void
      ): void => {
        runLoop.mutate(replayParams, {
          onError: (error) =>
            routeRunLoopError(error, restorePreviousConflictState),
          onSettled: clearEvaluateActiveCommandAfterReplay,
        });
      };
      pendingActionRef.current = (targetId: string, previousState) => {
        if (!documentId) {
          return;
        }

        const replayParams = {
          ...baseParams,
          documentId,
          computeTargetId: targetId,
        };
        const restorePreviousConflictState = previousState
          ? () => setMultiTargetState(previousState)
          : undefined;
        const queuedPreLoopCheck = runLoopMutationWithOptionalPreLoopCheck(
          replayParams,
          () => replayRunLoop(replayParams, restorePreviousConflictState)
        );
        if (!queuedPreLoopCheck) {
          replayRunLoop(replayParams, restorePreviousConflictState);
        }
      };
      pendingMismatchActionRef.current = (
        targetId: string | null,
        backendOverride: boolean,
        previousState
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
        const restorePreviousConflictState = previousState
          ? () => setBackendMismatchState(previousState)
          : undefined;
        const queuedPreLoopCheck = runLoopMutationWithOptionalPreLoopCheck(
          replayParams,
          () => replayRunLoop(replayParams, restorePreviousConflictState)
        );
        if (!queuedPreLoopCheck) {
          replayRunLoop(replayParams, restorePreviousConflictState);
        }
      };
    },
    [
      documentId,
      routeRunLoopError,
      runLoop,
      runLoopMutationWithOptionalPreLoopCheck,
    ]
  );

  /**
   * Resolve a multi-target conflict by selecting a specific compute target.
   * Pass `activeCommandRef` when the caller tracks EvaluatePlan/EvaluateCode loading state.
   */
  const selectTarget = useCallback(
    async (
      targetId: string,
      activeCommandRef?: React.MutableRefObject<RunLoopCommand | null>
    ) => {
      const previousState = multiTargetState;
      setMultiTargetState(null);
      try {
        await refreshReplayTarget(targetId);
      } catch (error) {
        setMultiTargetState(previousState);
        toast.error(error instanceof Error ? error.message : "Failed to retry");
        return;
      }
      if (activeCommandRef) {
        restoreEvaluateActiveCommandBeforeReplay(activeCommandRef);
      }
      pendingActionRef.current?.(targetId, previousState);
    },
    [
      multiTargetState,
      refreshReplayTarget,
      restoreEvaluateActiveCommandBeforeReplay,
    ]
  );

  /**
   * Confirm the original compute backend to resolve a backend mismatch.
   * Pass `activeCommandRef` when the caller tracks EvaluatePlan/EvaluateCode loading state.
   */
  const confirmOriginalBackend = useCallback(
    async (
      activeCommandRef?: React.MutableRefObject<RunLoopCommand | null>
    ) => {
      if (!backendMismatchState) {
        return;
      }
      const previousState = backendMismatchState;
      const targetId = backendMismatchState.originalComputeTargetId;
      setBackendMismatchState(null);
      if (targetId !== null) {
        try {
          await refreshReplayTarget(targetId);
        } catch (error) {
          setBackendMismatchState(previousState);
          toast.error(
            error instanceof Error ? error.message : "Failed to retry"
          );
          return;
        }
      }
      if (activeCommandRef) {
        restoreEvaluateActiveCommandBeforeReplay(activeCommandRef);
      }
      pendingMismatchActionRef.current?.(targetId, true, previousState);
    },
    [
      backendMismatchState,
      refreshReplayTarget,
      restoreEvaluateActiveCommandBeforeReplay,
    ]
  );

  /**
   * Confirm the preferred compute backend to resolve a backend mismatch.
   * Pass `activeCommandRef` when the caller tracks EvaluatePlan/EvaluateCode loading state.
   */
  const confirmPreferredBackend = useCallback(
    async (
      activeCommandRef?: React.MutableRefObject<RunLoopCommand | null>
    ) => {
      if (!backendMismatchState) {
        return;
      }
      const previousState = backendMismatchState;
      const targetId = backendMismatchState.preferredComputeTargetId;
      setBackendMismatchState(null);
      if (targetId !== null) {
        try {
          await refreshReplayTarget(targetId);
        } catch (error) {
          setBackendMismatchState(previousState);
          toast.error(
            error instanceof Error ? error.message : "Failed to retry"
          );
          return;
        }
      }
      if (activeCommandRef) {
        restoreEvaluateActiveCommandBeforeReplay(activeCommandRef);
      }
      pendingMismatchActionRef.current?.(targetId, true, previousState);
    },
    [
      backendMismatchState,
      refreshReplayTarget,
      restoreEvaluateActiveCommandBeforeReplay,
    ]
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
