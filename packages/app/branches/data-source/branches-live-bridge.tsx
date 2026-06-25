"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  LIVE_BRIDGE_INVALIDATION_THROTTLE_MS,
  useLiveQueryBridge,
} from "../../shared/hooks/use-live-query-bridge";
import { branchesKeys } from "../hooks/use-branches";
import type { BranchesChange } from "./branches-data-source";
import { useBranchesDataSource } from "./provider";

/**
 * Bridges a live branch data source's change stream to the React Query cache:
 * when the source emits a change (via its `subscribe` — the desktop local DB's
 * `desktop:db:changed` push), it invalidates the branch queries so the Branches
 * views refresh without polling (PLN-983 / Epic A — A5).
 *
 * The throttle / visibility / cleanup machinery lives in the shared
 * {@link useLiveQueryBridge} hook (identical to AgentSessionsLiveBridge); this
 * component supplies only the branch-specific change-id extraction and the
 * invalidation policy:
 * - **List + usage + analytics always move** — any branch change can shift the
 *   visible page, the aggregate summary, AND the KPI cards (B6 wired the
 *   always-on `BranchesSummaryCards` to `useBranchAnalytics`, so a local DB
 *   change such as a PR merging must refresh the merge-rate card too, not leave
 *   it stale until remount). Analytics reads the same bounded grouped queries
 *   the list/usage refetch already issues, so the extra invalidation is
 *   proportionate — not a new hot path.
 * - **Details** — a `{ branchId }` change refreshes that one `detail` (keyed by
 *   the active source's scope); a broad `{}` change refreshes all open details.
 *
 * NOTE (openQuestion #1): the desktop local source maps `onDbChanged`'s
 * `{ sessionId? }` to a BROAD `{}` change (no stable per-branch identity yet), so
 * v1 invalidations are list/usage + all details. The scoped `{ branchId }` path
 * is wired and tested for when a per-branch change identity exists.
 *
 * Renders nothing.
 */
export function BranchesLiveBridge() {
  const dataSource = useBranchesDataSource();
  const queryClient = useQueryClient();

  useLiveQueryBridge<BranchesChange>({
    subscribe: dataSource.subscribe,
    getChangeId: (change) => change.branchId,
    flush: ({ broad, ids }) => {
      // List + usage + analytics always move: all three are derived from the
      // local branch corpus, and the KPI cards (B6) read analytics, so a branch
      // change must refresh them too rather than leave the cards stale.
      queryClient.invalidateQueries({ queryKey: branchesKeys.lists() });
      queryClient.invalidateQueries({ queryKey: branchesKeys.usages() });
      queryClient.invalidateQueries({ queryKey: branchesKeys.analyticsRoot() });

      if (broad) {
        // A `{}` event can touch any branch, so refresh every open detail.
        queryClient.invalidateQueries({ queryKey: branchesKeys.details() });
        return;
      }
      // A scoped event only moves its own detail, keyed by the active source's
      // scope (detail keys are scope-qualified).
      for (const branchId of ids) {
        queryClient.invalidateQueries({
          queryKey: branchesKeys.detail(dataSource.scope, branchId),
        });
      }
    },
  });

  return null;
}

/**
 * Re-exported from the shared hook so the branches slice does not couple to the
 * agents slice and tests assert against this single source of truth.
 */
export const INVALIDATION_THROTTLE_MS = LIVE_BRIDGE_INVALIDATION_THROTTLE_MS;
