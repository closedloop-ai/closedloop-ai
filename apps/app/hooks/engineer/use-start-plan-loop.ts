"use client";

import type { StartPlanLoopResponse } from "@repo/api/src/types/plan-loop";
import { log } from "@repo/observability/log";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { artifactKeys } from "@/hooks/queries/use-artifacts";
import { entityLinkKeys } from "@/hooks/queries/use-entity-links";
import { useApiClient } from "@/hooks/use-api-client";
import { getRequiredLoopComputeTargetId } from "@/lib/engineer/get-required-loop-compute-target-id";
import type { EngineerTicket } from "@/types/engineer";

export type UseStartPlanLoopResult = {
  /** Non-null when the backend returned needs-selection (multiple linked plans) */
  pendingArtifacts: { id: string; title: string }[] | null;
  startPlanLoop: (
    ticket: EngineerTicket,
    repoPath: string,
    baseBranch?: string
  ) => Promise<{ launched: boolean; alreadyRunning: boolean }>;
  selectArtifact: (artifactId: string) => Promise<void>;
  /** Dismiss the multi-plan picker without making an API call */
  clearPendingArtifacts: () => void;
};

/** Result from the gateway prepare step (filesystem-only, no API call). */
type PrepareResult = {
  repoPath: string;
  worktreeDir: string;
  repo: { fullName: string; branch: string };
};

type PendingContext = {
  ticket: EngineerTicket;
  repoPath: string;
  baseBranch?: string;
  prepareResult: PrepareResult;
};

/**
 * Hook to start a real PLAN loop for issue-sourced engineer tickets.
 *
 * Uses a three-phase approach to avoid the CloudRelay deadlock:
 *
 * Phase 1 -- Gateway prepare (via fetch interceptor):
 *   Validates repoPath (sandbox), resolves worktree + git remote info.
 *   Filesystem-only, no API call. Completes instantly.
 *
 * Phase 2 -- API call (direct browser-to-API with Clerk token):
 *   Creates artifact + Loop, dispatches via waitUntil(launchLoop()).
 *   No gateway involvement, no relay nesting.
 *
 * Phase 3 -- Gateway confirm (fire-and-forget via fetch interceptor):
 *   Writes launch-metadata.json + updates JobStore.
 *   Filesystem-only, no API call.
 */
export function useStartPlanLoop(
  onSessionPersist: (
    ticketIdentifier: string,
    repoPath: string,
    worktreePath: string,
    loopId: string,
    artifactId: string
  ) => Promise<void>
): UseStartPlanLoopResult {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();
  const [pendingArtifacts, setPendingArtifacts] = useState<
    { id: string; title: string }[] | null
  >(null);
  const [pendingContext, setPendingContext] = useState<PendingContext | null>(
    null
  );

  const invalidateCaches = useCallback(
    (artifactId: string) => {
      queryClient.invalidateQueries({ queryKey: entityLinkKeys.lists() });
      queryClient.invalidateQueries({
        queryKey: artifactKeys.detail(artifactId),
      });
      queryClient.invalidateQueries({
        queryKey: artifactKeys.generationStatus(artifactId),
      });
    },
    [queryClient]
  );

  // Guard against double-clicks: prevent concurrent startPlanLoop calls
  // from creating duplicate artifacts and loops for the same ticket.
  const launchInFlightRef = useRef(false);

  /**
   * Phase 1: Call gateway prepare endpoint. Validates repoPath and resolves
   * worktree + git remote info. No API call -- filesystem only.
   */
  const gatewayPrepare = useCallback(
    async (
      ticketIdentifier: string,
      repoPath: string,
      baseBranch?: string
    ): Promise<PrepareResult> => {
      const prepareBody: Record<string, unknown> = { repoPath };
      if (baseBranch) {
        prepareBody.baseBranch = baseBranch;
      }

      const response = await fetch(
        `/api/engineer/symphony/plan-loop/${encodeURIComponent(ticketIdentifier)}/prepare`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(prepareBody),
        }
      );

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error ?? "Gateway prepare failed");
      }

      return (await response.json()) as PrepareResult;
    },
    []
  );

  /**
   * Phase 3: Call gateway confirm endpoint. Writes launch-metadata.json and
   * updates JobStore. Returns the actual loop-style worktreeDir so the
   * session stores the correct path that the loop handler will create.
   */
  const gatewayConfirm = useCallback(
    async (
      ticketIdentifier: string,
      repoPath: string,
      loopId: string,
      artifactId: string,
      artifactSlug: string,
      featureId: string,
      ticketTitle: string | undefined,
      outcome: "launched" | "already-running"
    ): Promise<string | null> => {
      const confirmBody: Record<string, unknown> = {
        repoPath,
        loopId,
        artifactId,
        artifactSlug,
        featureId,
        outcome,
      };
      if (ticketTitle) {
        confirmBody.ticketTitle = ticketTitle;
      }

      try {
        const response = await fetch(
          `/api/engineer/symphony/plan-loop/${encodeURIComponent(ticketIdentifier)}/confirm`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(confirmBody),
          }
        );
        if (response.ok) {
          const data = (await response.json()) as {
            ok: boolean;
            worktreeDir?: string;
          };
          return data.worktreeDir ?? null;
        }
      } catch (err) {
        console.error("[use-start-plan-loop] confirm failed:", err);
      }
      return null;
    },
    []
  );

  const handleSuccessfulLaunch = useCallback(
    async (
      response: Extract<
        StartPlanLoopResponse,
        { outcome: "launched" | "already-running" }
      >,
      ticket: EngineerTicket,
      repoPath: string,
      worktreePath: string,
      canonicalRepoPath?: string
    ): Promise<{ launched: boolean; alreadyRunning: boolean }> => {
      const { loopId, artifactId } = response;
      const alreadyRunning = response.outcome === "already-running";

      // For already-running, use the canonical repoPath from the existing loop
      // (not the caller's newly selected path) to avoid binding to a wrong worktree.
      const effectiveRepoPath = canonicalRepoPath ?? repoPath;

      await onSessionPersist(
        ticket.identifier,
        effectiveRepoPath,
        worktreePath,
        loopId,
        artifactId
      );

      invalidateCaches(artifactId);

      return { launched: true, alreadyRunning };
    },
    [onSessionPersist, invalidateCaches]
  );

  const startPlanLoop = useCallback(
    async (
      ticket: EngineerTicket,
      repoPath: string,
      baseBranch?: string
    ): Promise<{ launched: boolean; alreadyRunning: boolean }> => {
      if (!ticket.featureId) {
        throw new Error("startPlanLoop requires a ticket with featureId");
      }

      if (launchInFlightRef.current) {
        return { launched: false, alreadyRunning: false };
      }
      launchInFlightRef.current = true;

      try {
        const computeResult = getRequiredLoopComputeTargetId();
        if (!computeResult.ok) {
          log.warn(
            "[engineer-debug] startPlanLoop aborted: no compute target",
            { error: computeResult.error, ticketId: ticket.identifier }
          );
          toast.error(computeResult.error);
          return { launched: false, alreadyRunning: false };
        }

        log.debug("[engineer-debug] startPlanLoop Phase 1: prepare", {
          ticketId: ticket.identifier,
          computeTargetId: computeResult.computeTargetId,
          repoPath,
        });

        // Phase 1: Gateway prepare -- filesystem-only, no API call
        const prepareResult = await gatewayPrepare(
          ticket.identifier,
          repoPath,
          baseBranch
        );

        log.debug("[engineer-debug] startPlanLoop Phase 2: API call", {
          ticketId: ticket.identifier,
          prepareResult,
        });

        // Phase 2: Direct browser-to-API call with Clerk token
        const apiBody: Record<string, unknown> = {
          featureId: ticket.featureId,
          computeTargetId: computeResult.computeTargetId,
          localRepoPath: prepareResult.repoPath,
        };
        if (ticket.title) {
          apiBody.ticketTitle = ticket.title;
        }
        if (prepareResult.repo.fullName || prepareResult.repo.branch) {
          apiBody.repo = prepareResult.repo;
        }

        const data = await apiClient.post<StartPlanLoopResponse>(
          "/plans/start-loop-from-local",
          apiBody
        );

        if (data.outcome === "launched" || data.outcome === "already-running") {
          let canonicalRepoPath: string | undefined;
          if (data.outcome === "already-running") {
            canonicalRepoPath = data.localRepoPath;
          }

          // Phase 3: Gateway confirm -- returns the actual loop-style worktreeDir
          const confirmedWorktreeDir = await gatewayConfirm(
            ticket.identifier,
            canonicalRepoPath ?? prepareResult.repoPath,
            data.loopId,
            data.artifactId,
            data.artifactSlug,
            ticket.featureId,
            ticket.title,
            data.outcome
          );

          // Use the confirmed worktreeDir (matches what symphony-loop.ts creates).
          // If confirm failed, leave worktreePath undefined rather than persisting
          // the placeholder ticket-based path -- the status handler's JobStore
          // fallback will find the correct path once the process spawns.
          const worktreePath = confirmedWorktreeDir ?? "";

          return handleSuccessfulLaunch(
            data,
            ticket,
            repoPath,
            worktreePath,
            canonicalRepoPath
          );
        }

        if (data.outcome === "needs-selection") {
          setPendingArtifacts(data.artifacts);
          setPendingContext({ ticket, repoPath, baseBranch, prepareResult });
          return { launched: false, alreadyRunning: false };
        }

        if (data.outcome === "invalid-artifact") {
          toast.error(
            "The selected artifact is not a valid implementation plan."
          );
          return { launched: false, alreadyRunning: false };
        }

        if (data.outcome === "error") {
          toast.error(
            "Cannot resume: the existing loop is missing its local repo path. Stop the loop and try again."
          );
          return { launched: false, alreadyRunning: false };
        }

        return { launched: false, alreadyRunning: false };
      } finally {
        launchInFlightRef.current = false;
      }
    },
    [apiClient, gatewayPrepare, gatewayConfirm, handleSuccessfulLaunch]
  );

  const selectArtifact = useCallback(
    async (artifactId: string): Promise<void> => {
      if (!pendingContext) {
        return;
      }

      const { ticket, repoPath, prepareResult } = pendingContext;

      if (!ticket.featureId) {
        return;
      }

      const computeResult = getRequiredLoopComputeTargetId();
      if (!computeResult.ok) {
        toast.error(computeResult.error);
        return;
      }

      // Phase 2: Direct browser-to-API call with selected artifact
      const apiBody: Record<string, unknown> = {
        featureId: ticket.featureId,
        selectedArtifactId: artifactId,
        computeTargetId: computeResult.computeTargetId,
        localRepoPath: prepareResult.repoPath,
      };
      if (ticket.title) {
        apiBody.ticketTitle = ticket.title;
      }
      if (prepareResult.repo.fullName || prepareResult.repo.branch) {
        apiBody.repo = prepareResult.repo;
      }

      const data = await apiClient.post<StartPlanLoopResponse>(
        "/plans/start-loop-from-local",
        apiBody
      );

      if (data.outcome === "launched" || data.outcome === "already-running") {
        setPendingArtifacts(null);
        setPendingContext(null);

        let canonicalRepoPath: string | undefined;
        if (data.outcome === "already-running") {
          canonicalRepoPath = data.localRepoPath;
        }

        // Phase 3: Gateway confirm -- returns the actual loop-style worktreeDir
        const confirmedWorktreeDir = await gatewayConfirm(
          ticket.identifier,
          canonicalRepoPath ?? prepareResult.repoPath,
          data.loopId,
          data.artifactId,
          data.artifactSlug,
          ticket.featureId,
          ticket.title,
          data.outcome
        );

        const worktreePath = confirmedWorktreeDir ?? "";

        await handleSuccessfulLaunch(
          data,
          ticket,
          repoPath,
          worktreePath,
          canonicalRepoPath
        );
      } else if (
        data.outcome === "invalid-artifact" &&
        "existingArtifacts" in data
      ) {
        // Picker data was stale -- replace with refreshed list from the server
        setPendingArtifacts(data.existingArtifacts);
      } else {
        // error or unexpected outcome -- dismiss picker
        setPendingArtifacts(null);
        setPendingContext(null);
        toast.error("Failed to select artifact for planning.");
      }
    },
    [apiClient, pendingContext, gatewayConfirm, handleSuccessfulLaunch]
  );

  const clearPendingArtifacts = useCallback(() => {
    setPendingArtifacts(null);
    setPendingContext(null);
  }, []);

  return {
    pendingArtifacts,
    startPlanLoop,
    selectArtifact,
    clearPendingArtifacts,
  };
}
