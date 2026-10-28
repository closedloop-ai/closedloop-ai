"use client";

import type { AgentComponentsChange } from "@repo/api/src/types/agent-component";
import { useQueryClient } from "@tanstack/react-query";
import {
  LIVE_BRIDGE_INVALIDATION_THROTTLE_MS,
  useLiveQueryBridge,
} from "../../shared/hooks/use-live-query-bridge";
import { agentComponentKeys } from "../hooks/use-agent-components";
import { useAgentComponentsDataSource } from "./provider";

/**
 * Bridges a live agent-components source's change stream to the React Query
 * cache: when the source emits a change (via its `subscribe` — the desktop local
 * DB's change push), it invalidates the component queries so the Agents
 * workspace refreshes without polling (ISS-6882).
 *
 * The desktop local QueryClient runs `staleTime: Infinity` with focus and
 * reconnect refetches off, so this bridge is the ONLY channel that can make a
 * cached component query move. Without it an import, install, uninstall, or
 * rescan leaves the visible population stale until the renderer restarts —
 * which is exactly the defect this component exists to close.
 *
 * The throttle / visibility / cleanup machinery lives in the shared
 * {@link useLiveQueryBridge} hook (identical to AgentSessionsLiveBridge and
 * BranchesLiveBridge); this component supplies only the component-specific
 * change-id extraction and the invalidation policy:
 * - **Lists always move** — the Agents workspace derives the table, the summary
 *   cards, the facet-option universe, and the empty state from `useAgentComponents`
 *   reads, all under `agentComponentKeys.lists()`. On the desktop LOCAL scope
 *   only the one unwindowed read is live (`agents-grouped-list` gates the facet
 *   universe and the preceding-window baseline on the HTTP scope, which supports
 *   a date window); invalidating the `lists()` PREFIX rather than the active
 *   filters covers that read and stays correct if a windowed local source ever
 *   turns the other two on.
 * - **Details** — a broad `{}` change refreshes every open detail; a scoped
 *   `{ componentId }` change refreshes just that one, keyed by the active
 *   source's scope. Detail keys are addressed by the component's org-identity
 *   `slug`, so a future scoped producer must carry that slug as `componentId`.
 *
 * NOTE: no producer emits a scoped change today. The desktop local source maps
 * `onDbChanged`'s `{ sessionId? }` payload to a BROAD `{}` change, because a
 * session id is not a component identity (the same call the local branches
 * source makes); the scoped path below is wired and tested for when a real
 * per-component change identity exists.
 *
 * Mounted by the desktop app-core provider. On the web/cloud HTTP source there
 * is no `subscribe`, so the shared hook makes this an inert no-op.
 *
 * Renders nothing.
 */
export function AgentComponentsLiveBridge() {
  const dataSource = useAgentComponentsDataSource();
  const queryClient = useQueryClient();

  useLiveQueryBridge<AgentComponentsChange>({
    subscribe: dataSource.subscribe,
    getChangeId: (change) => change.componentId,
    flush: ({ broad, ids }) => {
      queryClient.invalidateQueries({ queryKey: agentComponentKeys.lists() });
      // ISS-6822: the bounded page-data read is a SECOND way the same population
      // reaches the table, the summary cards, and the facet menu. It caches
      // under its own key branch, so invalidating only `lists()` would leave the
      // page-data path frozen on a stale inventory after an install, uninstall,
      // import, or rescan — the very defect this bridge exists to close, moved
      // to the new read.
      queryClient.invalidateQueries({
        queryKey: agentComponentKeys.pageDatas(),
      });

      if (broad) {
        queryClient.invalidateQueries({
          queryKey: agentComponentKeys.details(),
        });
        return;
      }
      for (const componentId of ids) {
        queryClient.invalidateQueries({
          queryKey: agentComponentKeys.detail(dataSource.scope, componentId),
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
export const COMPONENTS_INVALIDATION_THROTTLE_MS =
  LIVE_BRIDGE_INVALIDATION_THROTTLE_MS;
