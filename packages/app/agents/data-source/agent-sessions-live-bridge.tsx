"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  LIVE_BRIDGE_INVALIDATION_THROTTLE_MS,
  useLiveQueryBridge,
} from "../../shared/hooks/use-live-query-bridge";
import { agentSessionKeys } from "../hooks/use-agent-sessions";
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
 * invalidation policy:
 * - **List + usage always move** — any session change can shift the visible page
 *   and the aggregate summary.
 * - **Details** — a `{ sessionId }` change refreshes that one `detail` (keyed by
 *   the active source's scope, FEA-1771); a `{}` change (import/rebuild/backfill)
 *   refreshes all open details.
 * - **Analytics is NEVER invalidated** — it is off the Sessions page (its sole
 *   consumer is the web Monitoring view) and stays one-shot-on-load per PLN-941
 *   §5/§11.
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
      // List + usage always move; analytics is intentionally never invalidated
      // (off the Sessions page; one-shot-on-load per PLN-941 §5/§11).
      queryClient.invalidateQueries({ queryKey: agentSessionKeys.lists() });
      queryClient.invalidateQueries({ queryKey: agentSessionKeys.usages() });

      if (broad) {
        // A `{}` event (import/rebuild/backfill) can touch any session, so
        // refresh every open detail.
        queryClient.invalidateQueries({ queryKey: agentSessionKeys.details() });
        return;
      }
      // A scoped event only moves its own detail, keyed by the active source's
      // scope (detail keys are scope-qualified, FEA-1771).
      for (const sessionId of ids) {
        queryClient.invalidateQueries({
          queryKey: agentSessionKeys.detail(dataSource.scope, sessionId),
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
