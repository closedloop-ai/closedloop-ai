"use client";

import {
  LIVE_BRIDGE_INVALIDATION_THROTTLE_MS,
  useLiveQueryBridge,
} from "../../shared/hooks/use-live-query-bridge";
import {
  branchAlwaysConvergePrefixes,
  branchBroadConvergePrefixes,
} from "../hooks/branch-cache-convergence";
import { branchesKeys } from "../hooks/use-branches";
import type { BranchesChange } from "./branches-data-source";
import { useBranchesDataSource, useBranchesQueryContext } from "./provider";

/**
 * Bridges a live branch data source's change stream to the React Query cache:
 * when the source emits a change (via its `subscribe` — the desktop local DB's
 * `desktop:db:changed` push), it invalidates the branch queries so the Branches
 * views refresh without polling (PLN-983 / Epic A — A5).
 *
 * The throttle / visibility / cleanup machinery lives in the shared
 * {@link useLiveQueryBridge} hook (identical to AgentSessionsLiveBridge); this
 * component supplies only the branch-specific change-id extraction and the
 * per-entity fan-out.
 *
 * ISS-9553: the invalidation POLICY is declared once in
 * `branchCacheConvergence` over `keyof branchesKeys`, and this bridge iterates
 * the prefixes that declaration derives. The inline list this replaced had gone
 * stale in a way only a total classification could catch: it omitted `lists`.
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
  const { queryClient, queryIdentity } = useBranchesQueryContext();

  useLiveQueryBridge<BranchesChange>({
    subscribe: dataSource.subscribe,
    getChangeId: (change) => change.branchId,
    flush: ({ broad, ids }) => {
      for (const queryKey of branchAlwaysConvergePrefixes()) {
        queryClient.invalidateQueries({ queryKey });
      }

      if (broad) {
        // A `{}` event can touch any branch, so refresh every open detail and
        // its lazily-fetched trace (PLN-1148 Phase 2).
        for (const queryKey of branchBroadConvergePrefixes()) {
          queryClient.invalidateQueries({ queryKey });
        }
        return;
      }
      // A scoped event only moves its own detail + trace + comments, keyed by the active
      // source's scope (detail/trace keys are scope-qualified).
      for (const branchId of ids) {
        queryClient.invalidateQueries({
          queryKey: branchesKeys
            .detail(dataSource.scope, branchId, queryIdentity)
            .slice(0, -1),
        });
        queryClient.invalidateQueries({
          queryKey: branchesKeys.trace(
            dataSource.scope,
            branchId,
            queryIdentity
          ),
        });
        queryClient.invalidateQueries({
          queryKey: branchesKeys.comments(
            dataSource.scope,
            branchId,
            queryIdentity
          ),
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
