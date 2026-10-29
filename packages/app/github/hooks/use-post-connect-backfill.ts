"use client";

import type { GitHubBackfillResponse } from "@repo/api/src/types/github";
import {
  GitHubBackfillMode,
  GitHubBackfillRetryErrorCode,
  GitHubBackfillStatus,
} from "@repo/api/src/types/github";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { branchesKeys } from "../../branches/hooks/use-branches";
import { ApiError } from "../../shared/api/api-error";
import { useApiClient } from "../../shared/api/use-api-client";
import { githubKeys } from "./use-github-integration";

/**
 * How often to re-read the backfill status while a run is in flight. Apply
 * mode writes projections incrementally, so every poll that still reports
 * `running` is also the cue to re-read branches: the list fills in as the
 * sweep progresses instead of staying empty until it ends.
 */
const BACKFILL_POLL_INTERVAL_MS = 5000;

/**
 * Stop polling after this long even while the server still says `running`.
 *
 * `running` is derived from the durable run-gate lease, and that lease is 20
 * minutes (`BACKFILL_RUN_LEASE_MS`). A sweep killed mid-run — the platform
 * hitting `maxDuration` on the waitUntil lane, an instance recycle — never
 * releases it, so the status outlives the run that earned it. Unbounded, that
 * dead lease would drive ~240 status reads and ~240 branch refetches for work
 * that already stopped. Comfortably above the 90s-180s a live sweep takes.
 */
const BACKFILL_POLL_CEILING_MS = 6 * 60 * 1000;

/**
 * The route answers 429 when an Apply run is ALREADY in flight for the org, or
 * within the 30s cooldown after one. That is the opposite of a failed start:
 * there is a run to follow, so it accepts rather than reports.
 *
 * The STATUS alone does not identify that case — a platform throttle or an edge
 * rate limiter answers 429 too, and neither leaves a run behind. The route's
 * `Deferred` code is what distinguishes them (#5689 review).
 */
const BACKFILL_ALREADY_RUNNING_STATUS = 429;

export type PostConnectBackfillInput = {
  /** Start the run only once the connect round-trip reported success. */
  enabled: boolean;
  /**
   * Test-and-set claim for this reconnect, returning whether THIS mount won it
   * (ISS-7338). Injected rather than imported: the claim is document-scoped
   * `apps/app` client state, which this package cannot reach, and document
   * scope is the point — a React remount must not re-fire the run, while a real
   * reconnect always arrives via a document navigation that clears the claim.
   */
  claimStart: () => boolean;
  /** Called when the run could not be STARTED; polling never begins. */
  onError?: () => void;
};

/**
 * Start the post-connect GitHub backfill and follow it to completion.
 *
 * ISS-7408: `POST /integrations/github/backfill` used to run the whole sweep
 * before responding — 90s-180s measured — and both call sites discarded the
 * summary they had blocked on. The route now returns 202 and the run continues
 * off the request path, so the caller's job changes from "await the response"
 * to "watch the status surface": poll `GET /integrations/github/backfill` and
 * refresh branches as projections land.
 *
 * Extracted rather than duplicated: the branches list and the branch detail
 * page ran byte-identical copies of the old effect, so a fix to one silently
 * left the other on the old behavior.
 */
export function usePostConnectBackfill({
  enabled,
  claimStart,
  onError,
}: PostConnectBackfillInput): void {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const pollStartedAtRef = useRef<number | null>(null);
  const [accepted, setAccepted] = useState(false);

  const acceptRun = useCallback(() => {
    pollStartedAtRef.current = Date.now();
    setAccepted(true);
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    // Unconditional on a connected return, ahead of the claim: a mount that
    // does not own the run still needs the caches it is rendering from dropped.
    queryClient.invalidateQueries({ queryKey: githubKeys.all });
    queryClient.invalidateQueries({ queryKey: branchesKeys.all });
    if (!claimStart()) {
      // A sibling mount already started this reconnect's run. Follow it rather
      // than firing a second Apply sweep — same query key, so the poll dedupes
      // to one request no matter how many mounts are watching.
      acceptRun();
      return;
    }
    apiClient
      .post("/integrations/github/backfill", {
        mode: GitHubBackfillMode.Apply,
      })
      .then(acceptRun)
      .catch((error: unknown) => {
        if (isBackfillAlreadyRunning(error)) {
          // A run IS in flight (or just finished). Follow it instead of
          // reporting a failure the user would read as "refresh broke".
          acceptRun();
          return;
        }
        onError?.();
      })
      .finally(() => {
        // ISS-5013, carried over from the blocking era and still load-bearing:
        // Apply writes repos → branches → PRs → projections incrementally, so a
        // start that FAILED can still have left rows behind. Invalidating only
        // on success would leave the list asserting "nothing here" about an org
        // that now has branches.
        queryClient.invalidateQueries({ queryKey: branchesKeys.all });
      });
  }, [acceptRun, apiClient, claimStart, enabled, onError, queryClient]);

  const statusQuery = useQuery({
    queryKey: githubKeys.backfill(),
    queryFn: () =>
      apiClient.get<GitHubBackfillResponse>("/integrations/github/backfill"),
    enabled: accepted,
    refetchInterval: (query) => {
      // Stop on a failing read, not just on a terminal status. TanStack keeps
      // the last SUCCESSFUL data through an error, so a status-only check would
      // keep hammering a broken endpoint every 5s until the ceiling — the exact
      // infinite-retry case packages/app/AGENTS.md calls out (#5689 review).
      if (query.state.status === "error") {
        return false;
      }
      if (query.state.data?.summary.status !== GitHubBackfillStatus.Running) {
        return false;
      }
      return hasExceededPollCeiling(pollStartedAtRef.current)
        ? false
        : BACKFILL_POLL_INTERVAL_MS;
    },
  });

  const { dataUpdatedAt } = statusQuery;
  useEffect(() => {
    if (!(accepted && dataUpdatedAt)) {
      return;
    }
    // Keyed on `dataUpdatedAt`, not on the status value: the status stays
    // `running` across every poll, so a status-keyed effect would fire once and
    // never again, and the list would sit empty until the run settled. ISS-5013
    // is the same lesson from the blocking era — rows exist before the run ends,
    // so a refresh that waits for success asserts "nothing here" about an org
    // that already has branches.
    queryClient.invalidateQueries({ queryKey: branchesKeys.all });
  }, [accepted, dataUpdatedAt, queryClient]);
}

function isBackfillAlreadyRunning(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === BACKFILL_ALREADY_RUNNING_STATUS &&
    error.code === GitHubBackfillRetryErrorCode.Deferred
  );
}

function hasExceededPollCeiling(startedAt: number | null): boolean {
  if (startedAt === null) {
    return false;
  }
  return Date.now() - startedAt > BACKFILL_POLL_CEILING_MS;
}
