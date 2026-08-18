"use client";

import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { useCallback } from "react";
import { useAuthSnapshot } from "../../shared/auth/use-auth-snapshot";
import { useLocalStorageState } from "../../shared/hooks/use-local-storage-state";
import { useAgentSessions } from "./use-agent-sessions";

/**
 * localStorage key prefix for the "last time this user opened Agents" marker
 * (per org). The badge counts sessions finished since this timestamp, so
 * clearing it on visit is what makes the badge drain to zero.
 */
const AGENTS_LAST_VISITED_KEY_PREFIX = "closedloop.app.agents.lastVisitedAt";

/**
 * How many finished sessions the badge query fetches. The badge only needs the
 * `total` count, not the rows, so we request the smallest page the API allows
 * and read `total` off the response — no full list is materialized.
 */
const ACTIVITY_COUNT_PAGE_LIMIT = 1;

/**
 * How often the badge re-reads the completed-since-visit count while the sidebar
 * stays mounted. `staleTime` alone only affects cache freshness — it never fires
 * a fetch — so without a bounded interval a session that completes after the
 * first result would never light the badge on a long-lived surface (the web
 * query client disables focus/reconnect refetches). Five minutes keeps this
 * low-urgency ambient signal current without putting the sidebar on a tight poll
 * loop. `useAgentSessions` gates the query on `enabled`, so a first-time user
 * with no marker still fires nothing.
 */
const ACTIVITY_COUNT_REFETCH_INTERVAL_MS = 5 * 60_000;

function activityKeyForOrg(orgId: string | null): string {
  return orgId
    ? `${AGENTS_LAST_VISITED_KEY_PREFIX}.${orgId}`
    : AGENTS_LAST_VISITED_KEY_PREFIX;
}

type AgentsActivityCountParams = {
  /**
   * True when the Agents surface is the active route. Gates the count query off
   * (the badge is hidden and the marker is draining, so the read is discarded).
   */
  isActive: boolean;
};

type AgentsActivityCount = {
  /** Finished (terminal, not-failed) sessions since the last Agents visit. */
  count: number;
  /** Whether the badge should render (count > 0). */
  hasActivity: boolean;
  /** Accessible name announcing the count with meaning (WCAG 1.1.1). */
  label: string;
  /**
   * Stamp "now" as the last-visited time, draining the badge. Call this when the
   * user opens the Agents surface.
   */
  markVisited: () => void;
};

/**
 * Shared activity signal for the Agents sidebar badge (FEA-3009).
 *
 * Counts sessions that finished (terminal, not-failed) since the user last
 * opened Agents using the existing agent-sessions read, scoped per org via a
 * localStorage
 * "last visited" marker. The org id is read from the injected auth port (not a
 * prop) so both surfaces get a scoped key automatically — a shared machine with
 * more than one org/user never drains one person's badge with another's visit.
 * Reused by both the web sidebar and the desktop renderer sidebar so the two
 * surfaces stay in lockstep.
 *
 * The count query only runs once a last-visited marker exists (`enabled`), so a
 * brand-new user or a just-cleared marker shows no badge instead of counting the
 * entire history — and it never fires a redundant fetch before we know the lower
 * bound to count from. It is also skipped while the Agents route is active
 * (`isActive`): the badge is hidden then and the marker is being drained, so the
 * count would be discarded — no reason to keep polling for it.
 */
export function useAgentsActivityCount({
  isActive,
}: AgentsActivityCountParams): AgentsActivityCount {
  const { orgId } = useAuthSnapshot();
  const [lastVisitedAt, setLastVisitedAt] = useLocalStorageState<string | null>(
    activityKeyForOrg(orgId),
    null
  );

  const { data } = useAgentSessions(
    {
      // ISS-4586: the badge counts finished-not-failed sessions, whose canonical
      // status is now `inactive` (the reapers stamp reaped orphans `inactive`, not
      // `completed`). ISS-4654: the CLOUD still expands a requested `inactive`
      // facet to also match a straggler `completed`/`abandoned` row
      // (`buildStatusFacetPredicate`); the DESKTOP no longer needs to, because
      // migration 0042 runs at boot and leaves none locally. Either way `INACTIVE`
      // is the right request — it catches the reaped sessions the old `COMPLETED`
      // request silently dropped, on both surfaces. The
      // Sessions facet and API predicate speak canonical lowercase `SESSION_STATUS`
      // (`"inactive"`), which both query builders match against `artifact.status`;
      // the projected UI vocabulary (`AgentSessionState`) would match nothing on
      // web, so the badge sends the wire value the Sessions filter already sends.
      statuses: [SESSION_STATUS.INACTIVE],
      // FEA-3009: filter on the COMPLETION timestamp, not `startDate`. `startDate`
      // is not a completion boundary — the list route applies it to
      // `lastActivityAt` on cloud and desktop applies it to `startedAt`, so a
      // long-running session that started before the last visit but completed
      // after it was counted inconsistently across surfaces (and could miscount).
      // `completedAfter` filters both surfaces on the terminal `endedAt`/
      // `sessionEndedAt`, so "completed since you last opened Agents" means the
      // same thing on web and desktop.
      completedAfter: lastVisitedAt ?? undefined,
      limit: ACTIVITY_COUNT_PAGE_LIMIT,
      // FEA-4142: the badge reads only `total`, so mark the read count-only. The
      // desktop-local source answers it with a single SQL `COUNT(*)` instead of
      // hydrating up to MAX_WORKING_SET_SESSIONS full sessions just to size the
      // list — this query's `completedAfter` + `statuses` filters otherwise
      // disable both desktop SQL fast paths and fall to the full-corpus
      // hydration fallback (the FEA-2038 db-host OOM), fired every 5 minutes from
      // the global sidebar. The cloud source ignores the hint (its `count()` is
      // already cheap).
      countOnly: true,
    },
    {
      // No marker yet → nothing to count from; skip the fetch entirely so the
      // sidebar adds no reflexive on-mount request for first-time users. Also
      // skip while Agents is the active route: the result is discarded (badge
      // hidden, marker draining), so polling for it is wasted work.
      enabled: Boolean(lastVisitedAt) && !isActive,
      // Recent-completions is a low-urgency ambient signal; a minute of
      // staleness is fine and keeps the sidebar off the network on every route
      // change.
      staleTime: 60_000,
      // A mounted sidebar never remounts, and the web query client disables
      // focus/reconnect refetches, so a bounded interval is what actually lets
      // a completion that lands after the first read light the badge.
      refetchInterval: ACTIVITY_COUNT_REFETCH_INTERVAL_MS,
    }
  );

  const markVisited = useCallback(() => {
    setLastVisitedAt(new Date().toISOString());
  }, [setLastVisitedAt]);

  const count = data?.total ?? 0;
  const hasActivity = count > 0;

  return {
    count,
    hasActivity,
    label: `${count} recently finished ${count === 1 ? "session" : "sessions"}`,
    markVisited,
  };
}
