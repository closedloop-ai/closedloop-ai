import { agentSessionKeys } from "@repo/app/agents/hooks/use-agent-sessions";
import type { QueryClient } from "@tanstack/react-query";

/**
 * FEA-2187 — desktop-only fallback poll interval (ms) for the Sessions LIST
 * query. The desktop QueryClient runs a pure push model (staleTime: Infinity)
 * and refreshes the list off the local DB's `desktop:db:changed` stream via the
 * throttled, VISIBILITY-GATED shared live bridge. That gating defers a flush
 * while the renderer reports `document.hidden` — which a CI/offscreen Electron
 * window can report indefinitely — so a single post-import change can be
 * deferred forever, leaving the list stuck on its initial (reader-pool,
 * immediately-empty) fetch. A modest background poll heals that missed flush.
 */
export const DESKTOP_SESSIONS_LIST_REFETCH_INTERVAL_MS = 2000;

/**
 * Apply the desktop Sessions-list poll fallback as a QueryClient default scoped
 * to the `agentSessionKeys.lists()` key prefix — so it rides on every list
 * query without leaking desktop concerns into the shared `@repo/app` hooks (kept
 * surface-agnostic by the agent source guardrails). Desktop-only by placement:
 * the web app builds its own QueryClient and never calls this.
 *
 * `refetchIntervalInBackground: true` is LOAD-BEARING: without it React Query
 * pauses the poll exactly when the window is hidden — the case we must cover.
 */
export function applyDesktopSessionsListPollDefaults(
  client: QueryClient
): void {
  client.setQueryDefaults(agentSessionKeys.lists(), {
    refetchInterval: DESKTOP_SESSIONS_LIST_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: true,
  });
}
