"use client";

import { useEffect, useRef } from "react";

const POLL_MAX_MS = 45 * 60_000;
const POLL_FAST_MS = 15_000;
const POLL_MEDIUM_MS = 30_000;
const POLL_SLOW_MS = 60_000;

const TERMINAL_STATES = ["READY", "SUCCESS", "FAILURE", "ERROR", "INACTIVE"];

type UsePreviewDeploymentPollingOptions = {
  /** Current deployment state (e.g. "READY", "PENDING"). */
  previewState: string | null;
  /** Whether a preview ref exists (indicates deployment was created). */
  hasPreviewRef: boolean;
  /** PR number — polling starts when a PR or preview ref exists. */
  pullRequestNumber: number | undefined;
  /** Whether artifact generation is still running. */
  isGenerationRunning: boolean;
  /** Refetch function from the preview deployment query. */
  refetch: () => Promise<{ data?: unknown[] }>;
};

/**
 * Adaptive polling for preview deployment status.
 *
 * Starts polling when a PR exists, a preview ref is present, or generation is running.
 * Uses adaptive intervals: fast (15s) for first 5 min, medium (30s) up to 15 min,
 * slow (60s) after. Stops on terminal states, after 45 min, or after 3 consecutive
 * empty responses.
 *
 * Resets when the PR number changes (new execution = new deployment).
 */
export function usePreviewDeploymentPolling({
  previewState,
  hasPreviewRef,
  pullRequestNumber,
  isGenerationRunning,
  refetch,
}: UsePreviewDeploymentPollingOptions): void {
  const pollStartRef = useRef<number | null>(null);
  const pollStoppedRef = useRef(false);
  const emptyRefreshCountRef = useRef(0);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  // Reset poll state when the PR changes (new execution = new deployment)
  const prevPrRef = useRef(pullRequestNumber);
  if (prevPrRef.current !== pullRequestNumber) {
    prevPrRef.current = pullRequestNumber;
    pollStartRef.current = null;
    pollStoppedRef.current = false;
    emptyRefreshCountRef.current = 0;
  }

  useEffect(() => {
    if (
      !(pullRequestNumber || hasPreviewRef || isGenerationRunning) ||
      pollStoppedRef.current
    ) {
      return;
    }

    const normalized = previewState?.toUpperCase();
    if (normalized && TERMINAL_STATES.includes(normalized)) {
      return;
    }

    pollStartRef.current ??= Date.now();

    function trackEmptyPollResponse() {
      emptyRefreshCountRef.current += 1;
      if (emptyRefreshCountRef.current >= 3) {
        pollStoppedRef.current = true;
      }
    }

    // Self-scheduling poll loop: each tick schedules the next via setTimeout
    function schedulePoll() {
      if (pollStoppedRef.current || pollStartRef.current === null) {
        return;
      }

      const elapsed = Date.now() - pollStartRef.current;
      if (elapsed > POLL_MAX_MS) {
        return;
      }

      let interval = POLL_SLOW_MS;
      if (elapsed < 5 * 60_000) {
        interval = POLL_FAST_MS;
      } else if (elapsed < 15 * 60_000) {
        interval = POLL_MEDIUM_MS;
      }

      pollTimeoutRef.current = setTimeout(async () => {
        try {
          const result = await refetchRef.current();
          if (result.data?.length) {
            emptyRefreshCountRef.current = 0;
          } else {
            trackEmptyPollResponse();
          }
        } catch (err) {
          console.warn("[preview-poll] refetch failed:", {
            message: err instanceof Error ? err.message : String(err),
          });
          trackEmptyPollResponse();
        }
        schedulePoll();
      }, interval);
    }

    schedulePoll();

    return () => {
      clearTimeout(pollTimeoutRef.current);
    };
  }, [pullRequestNumber, previewState, isGenerationRunning, hasPreviewRef]);
}
