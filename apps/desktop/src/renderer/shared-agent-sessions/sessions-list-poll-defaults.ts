import { agentSessionKeys } from "@repo/app/agents/hooks/use-agent-sessions";
import type { Query, QueryClient } from "@tanstack/react-query";
import {
  createServiceTimeTracker,
  nextPollIntervalMs,
  type ServiceTimeTracker,
} from "./sessions-poll-service-time";

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
 * Upper bound on the SERVICE-AWARE list/page-data cadence.
 *
 * The interval above is now a FLOOR rather than the whole story: a read that
 * takes longer than 2 s pushes the next poll out to match it, holding the duty
 * cycle at ~50% instead of letting it climb with the read cost (see
 * `sessions-poll-service-time.ts`). This caps how far out that can go, so a
 * pathologically slow read cannot defer the FEA-2187 heal indefinitely and
 * reintroduce the stuck-list bug from the other direction.
 */
export const DESKTOP_SESSIONS_LIST_MAX_REFETCH_INTERVAL_MS = 30_000;

/**
 * FEA-3481 (G4) — desktop-only fallback poll interval (ms) for an OPEN Sessions
 * DETAIL query. The FEA-2187 poll above heals only LIST staleness; an
 * already-open detail view rides the same visibility-gated live bridge, so on a
 * permanently-hidden/offscreen renderer (which never fires `visibilitychange`)
 * a post-import detail change is deferred forever — the detail stays stale until
 * a manual refresh. A modest background poll on the detail key heals that same
 * missed flush for the case the list poll does not cover.
 *
 * Kept slower than the list poll: detail is a single-row local read, but only
 * the open detail(s) have observers so the poll cost is O(open details), not
 * O(all sessions); a 5 s cadence is well within "one poll interval" freshness
 * while staying cheap.
 */
export const DESKTOP_SESSIONS_DETAIL_REFETCH_INTERVAL_MS = 5000;

/**
 * Apply the desktop Sessions poll fallbacks as QueryClient defaults scoped to
 * the `agentSessionKeys.lists()`, `agentSessionKeys.pageDataRoot()`, and
 * `agentSessionKeys.details()` key prefixes — so they ride on every
 * list/page-data/detail query without leaking desktop concerns into the shared
 * `@repo/app` hooks (kept surface-agnostic by the agent source guardrails).
 * Desktop-only by placement: the web app builds its own QueryClient and never
 * calls this. Only queries with active observers poll, so a default on the
 * `details()` prefix costs nothing for closed details (no observer) and heals
 * only the open ones.
 *
 * FEA-4157: the org Sessions view reads its list + summary through the combined
 * `pageData` query, so its key prefix must carry the same list-cadence fallback
 * or a permanently-hidden renderer's Sessions table + cards would stay stuck on
 * their initial (immediately-empty) fetch, exactly as the list poll heals for
 * the list-only surfaces.
 *
 * `refetchIntervalInBackground: true` is LOAD-BEARING on all: without it React
 * Query pauses the poll exactly when the window is hidden — the case we must
 * cover (a permanently-hidden renderer never fires `visibilitychange`).
 *
 * ISS-4772: the detail defaults ALSO carry `refetchOnMount: "always"`. The
 * detail query runs `staleTime: Infinity` with push-driven freshness, so a
 * freshly-mounted detail whose cache entry predates a detached live-bridge push
 * (the push stops flushing after long uptime) would render the stale/empty
 * cached value and never read. Forcing a read on every mount guarantees a newly
 * opened detail issues a fresh single-row local read regardless of the push
 * state. Scoped to `details()` only — the list/page-data already self-heal via
 * their background poll and keep-previous data, so this narrower guarantee is
 * exactly where the empty-detail wedge lands.
 */
export function applyDesktopSessionsListPollDefaults(
  client: QueryClient
): void {
  const tracker = createServiceTimeTracker();
  observeSessionsReadServiceTime(client, tracker);
  // A FUNCTION, not a constant: the list and page-data reads are corpus-scale,
  // so a fixed interval lets their duty cycle climb with the read cost. Deriving
  // the interval from the measured cost pins it at ~50% instead (see
  // `sessions-poll-service-time.ts`, which also records what this does NOT fix).
  // The detail key keeps its constant — it is a single-row read.
  const listInterval = () =>
    nextPollIntervalMs({
      observedServiceMs: tracker.observedMs(),
      floorMs: DESKTOP_SESSIONS_LIST_REFETCH_INTERVAL_MS,
      ceilingMs: DESKTOP_SESSIONS_LIST_MAX_REFETCH_INTERVAL_MS,
    });

  client.setQueryDefaults(agentSessionKeys.lists(), {
    refetchInterval: listInterval,
    refetchIntervalInBackground: true,
  });
  client.setQueryDefaults(agentSessionKeys.pageDataRoot(), {
    refetchInterval: listInterval,
    refetchIntervalInBackground: true,
  });
  client.setQueryDefaults(agentSessionKeys.details(), {
    refetchInterval: DESKTOP_SESSIONS_DETAIL_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: true,
    refetchOnMount: "always",
  });
}

/** True when `key` begins with every element of `prefix`. */
function hasKeyPrefix(
  key: readonly unknown[],
  prefix: readonly unknown[]
): boolean {
  return (
    key.length >= prefix.length &&
    prefix.every((part, index) => Object.is(key[index], part))
  );
}

/** The two polled, corpus-scale key families whose cost drives the cadence. */
function isServiceTimedSessionsQuery(query: Query): boolean {
  const key = query.queryKey;
  return (
    hasKeyPrefix(key, agentSessionKeys.lists()) ||
    hasKeyPrefix(key, agentSessionKeys.pageDataRoot())
  );
}

/**
 * Feed observed list/page-data read durations into `tracker`.
 *
 * Written to FAIL SAFE: if this never records a sample — a React Query version
 * whose cache events differ, a build where the subscription is torn down — the
 * tracker stays empty and `nextPollIntervalMs` returns the floor, which is
 * exactly the fixed cadence this replaced. A broken observer degrades to the
 * old behaviour, never to a stalled poll.
 *
 * `pending` is bounded by construction: an entry is written when a fetch starts
 * and deleted when it settles or the query leaves the cache, so it holds at most
 * one entry per in-flight polled query.
 */
function observeSessionsReadServiceTime(
  client: QueryClient,
  tracker: ServiceTimeTracker
): void {
  const pending = new Map<string, number>();
  client.getQueryCache().subscribe((event) => {
    if (!isServiceTimedSessionsQuery(event.query)) {
      return;
    }
    const hash = event.query.queryHash;
    if (event.type === "removed") {
      pending.delete(hash);
      return;
    }
    if (event.type !== "updated") {
      return;
    }
    const action = event.action.type;
    if (action === "fetch") {
      pending.set(hash, Date.now());
      return;
    }
    if (action !== "success" && action !== "error") {
      return;
    }
    const startedAt = pending.get(hash);
    pending.delete(hash);
    if (startedAt !== undefined) {
      tracker.record(Date.now() - startedAt);
    }
  });
}
