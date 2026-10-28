"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  LIVE_BRIDGE_INVALIDATION_THROTTLE_MS,
  useLiveQueryBridge,
} from "../../shared/hooks/use-live-query-bridge";
import {
  agentSessionAlwaysConvergePrefixes,
  agentSessionBroadConvergePrefixes,
} from "../hooks/agent-session-cache-convergence";
import { agentSessionKeys } from "../hooks/agent-session-keys";
import { isAgentSessionEventsPagesKey } from "../hooks/use-agent-sessions";
import type { AgentSessionsChange } from "./agent-sessions-data-source";
import { useAgentSessionsDataSource } from "./provider";

/**
 * Bridges a live data source's change stream to the React Query cache: when the
 * source emits a change (surfaced via its `subscribe` — e.g. the desktop local
 * DB's push notifications), it invalidates the agent-session queries so the
 * Sessions views refresh without polling (FEA-1834 / PLN-941 Phase 3).
 *
 * The throttle / visibility / cleanup machinery lives in the shared
 * {@link useLiveQueryBridge} hook (shared with BranchesLiveBridge); this
 * component supplies only the session-specific change-id extraction and the
 * per-entity fan-out.
 *
 * ISS-9553: the invalidation POLICY is no longer written here. Which families
 * converge, which sweep only on a broad change, and which are deliberately
 * excluded is declared once in `agentSessionCacheConvergence` over `keyof
 * agentSessionKeys`, and this bridge iterates the prefixes that declaration
 * derives. Restating the list inline is what let each newly added family ship
 * uninvalidated until someone noticed; a family added to `agentSessionKeys` now
 * fails `tsc` until it is classified, and one classified as converging is
 * invalidated here without this file changing.
 *
 * NOTE: Desktop keep-alive leaves visited surfaces mounted-but-hidden, so the
 * active-route gating in PLN-941 §5 (hidden surfaces marked stale *without*
 * refetching) is a tracked follow-up; today a DB event also refetches hidden
 * keep-alive surfaces, which on desktop are cheap O(page) local reads.
 *
 * Renders nothing.
 */
export function AgentSessionsLiveBridge() {
  const dataSource = useAgentSessionsDataSource();
  const queryClient = useQueryClient();

  useLiveQueryBridge<AgentSessionsChange>({
    subscribe: dataSource.subscribe,
    getChangeId: (change) => change.sessionId,
    flush: ({ broad, ids }) => {
      for (const queryKey of agentSessionAlwaysConvergePrefixes()) {
        queryClient.invalidateQueries({ queryKey });
      }

      if (broad) {
        // A `{}` event (import/rebuild/backfill) can touch any session, so
        // refresh every open detail — and reset every walk past one, for the
        // reason the scoped arm below gives.
        for (const queryKey of agentSessionBroadConvergePrefixes()) {
          queryClient.invalidateQueries({ queryKey });
        }
        queryClient.resetQueries({
          queryKey: agentSessionKeys.details(),
          predicate: (query) => isAgentSessionEventsPagesKey(query.queryKey),
        });
        return;
      }
      // A scoped event only moves its own detail, keyed by the active source's
      // scope (detail keys are scope-qualified, FEA-1771).
      for (const sessionId of ids) {
        queryClient.invalidateQueries({
          queryKey: agentSessionKeys.detail(dataSource.scope, sessionId),
        });
        // ISS-9857: the walk past that detail's prefix is `enabled: false`, so
        // the invalidation above marks it and never refetches it, and a tail
        // append leaves the first cursor — the walk's key — unchanged. Reset it
        // to "nothing loaded yet" so an exhausted walk stops reporting "no
        // more" over rows it never saw; the next click re-walks from the
        // refetched prefix.
        queryClient.resetQueries({
          queryKey: agentSessionKeys.eventsPagesOf(dataSource.scope, sessionId),
        });
      }
    },
  });

  return null;
}

/**
 * Re-exported from the shared hook so tests assert against this single source of
 * truth rather than a duplicated literal.
 */
export const INVALIDATION_THROTTLE_MS = LIVE_BRIDGE_INVALIDATION_THROTTLE_MS;
