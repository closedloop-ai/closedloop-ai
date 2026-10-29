"use client";

import type { AgentSessionListResponse } from "@repo/api/src/types/agent-session";
import {
  NavigationCountStatus,
  type NavigationDestinationCount,
  pendingNavigationCount,
  toNavigationCount,
  unavailableNavigationCount,
} from "@repo/api/src/types/navigation-view-model";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { timestampMs } from "@repo/lib/sessions/agent-session-projection-utils";
import { useCallback, useEffect } from "react";
import { useAuthSnapshot } from "../../shared/auth/use-auth-snapshot";
import { useLocalStorageState } from "../../shared/hooks/use-local-storage-state";
// Cross-slice on purpose: the Agents label must pluralize exactly as the v2
// sidebar's count badge does, so it takes the rule from the shell's model.
import { navigationCountNounFor } from "../../shell/v2/lib/navigation-section-model";
import { agentsLastVisitedKey } from "../lib/agents-activity-storage-key";
import { AGENTS_NAV_COUNT_NOUN } from "../lib/agents-nav-count";
import { useAgentSessions } from "./use-agent-sessions";

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

type AgentsNavActivityParams = {
  /**
   * True when the Agents surface is the active route. Stamps the visit, and gates
   * the count query off: the badge is hidden and the marker is draining, so the
   * read would be discarded.
   */
  isActive: boolean;
  /**
   * Whether the host offers an Agents row at all. False gates the count query
   * off: there is nothing to badge, and the v2 sidebar adapters call this hook
   * unconditionally, so a closed container would otherwise keep a five-minute
   * poll alive for a row that is not in the tree. Defaults true for the legacy
   * badge, which only ever mounts inside the row it counts for.
   */
  offered?: boolean;
};

export type AgentsNavActivity = {
  /**
   * Finished (terminal, not-failed) sessions since the last Agents visit, as a
   * count that says which read it came from: pending while in flight,
   * unavailable when the read failed, ready with the total once it landed.
   * Undefined when there is nothing to count — no visit marker yet, or Agents is
   * the open route.
   */
  count: NavigationDestinationCount | undefined;
  /** Accessible name announcing the settled count with meaning (WCAG 1.1.1). */
  label: string;
  /** Stamp "now" as the last-visited time, draining the count. */
  markVisited: () => void;
};

/**
 * Shared activity signal for the Agents sidebar row (FEA-3009), used by the
 * legacy badge on both sidebars and by the v2 sidebar's count, so the two trees
 * cannot disagree on when the count drains or whether it shows.
 *
 * Counts sessions that finished (terminal, not-failed) since the user last
 * opened Agents using the existing agent-sessions read, scoped per org via a
 * localStorage "last visited" marker. The org id is read from the injected auth
 * port (not a prop) so both surfaces get a scoped key automatically — a shared
 * machine with more than one org/user never drains one person's badge with
 * another's visit.
 *
 * The count query only runs once a last-visited marker exists (`enabled`), so a
 * brand-new user or a just-cleared marker shows no badge instead of counting the
 * entire history — and it never fires a redundant fetch before we know the lower
 * bound to count from. It is also skipped while the Agents route is active
 * (`isActive`): the badge is hidden then and the marker is being drained, so the
 * count would be discarded — no reason to keep polling for it. And skipped when
 * the host is not offering an Agents row at all (`offered`), which is the case a
 * hook called from a sidebar ADAPTER meets and the legacy badge never could.
 */
export function useAgentsNavActivity({
  isActive,
  offered = true,
}: AgentsNavActivityParams): AgentsNavActivity {
  const { orgId } = useAuthSnapshot();
  const [lastVisitedAt, setLastVisitedAt] = useLocalStorageState<string | null>(
    agentsLastVisitedKey(orgId),
    null,
    usableVisitMarker
  );
  const enabled = offered && Boolean(lastVisitedAt) && !isActive;

  const { data, isError } = useAgentSessions(
    {
      // ISS-4586: the badge counts finished-not-failed sessions, whose canonical
      // status is now `inactive` (the reapers stamp reaped orphans `inactive`, not
      // `completed`). ISS-4985 had the CLOUD expand a requested `inactive` facet
      // to also match a straggler `completed`/`abandoned` row
      // (`buildStatusFacetPredicate`), but ISS-5592 removed that widening; the
      // DESKTOP no longer needs one either, because migration 0042 runs at boot
      // and leaves none locally. Either way `INACTIVE` is the right request — it
      // catches the reaped sessions the old `COMPLETED` request silently
      // dropped, on both surfaces.
      //
      // The request is the lowercase wire value, but the two sources read it
      // against DIFFERENT stores, so parity work has to follow both: cloud
      // matches the artifact row (`artifact.status`), desktop the local session
      // row via `canonicalSharedStatus` (`session-status-filter-match.ts`) and
      // its SQL twin `lower(s.status)` (`session-aggregate-filters.ts`). The
      // extra `DISPLAYED_SESSION_STATUS` words are derived per read and no
      // current producer writes one — legacy rows predating that CAN still hold
      // a literal `waiting` on both stores (`db-constants.ts`), which is exactly
      // why a request must be a lifecycle value rather than a display word. So
      // the badge sends the wire value the Sessions filter already sends.
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
      // hidden, marker draining), so polling for it is wasted work. And skip
      // when the row is not offered, for the same reason one step earlier: the
      // count has nowhere to land.
      enabled,
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

  // Opening Agents clears the "new since last visit" window. Effect (not render)
  // so the visit stamp is a committed side effect, not a render-phase write.
  useEffect(() => {
    if (isActive) {
      markVisited();
    }
  }, [isActive, markVisited]);

  const count = enabled ? activityCount(data, isError) : undefined;
  const settled =
    count?.status === NavigationCountStatus.Ready ? count.value : 0;

  return {
    count,
    label: `${settled} ${navigationCountNounFor(settled, AGENTS_NAV_COUNT_NOUN)}`,
    markVisited,
  };
}

/**
 * The count for an enabled read. A total that has landed wins even when a later
 * refetch failed, as the badge always behaved; only a read that has never
 * produced a total reports pending or unavailable — never the zero this used to
 * fold both into.
 */
function activityCount(
  data: AgentSessionListResponse | undefined,
  isError: boolean
): NavigationDestinationCount {
  if (data !== undefined) {
    return toNavigationCount(data.total);
  }
  return isError ? unavailableNavigationCount() : pendingNavigationCount();
}

/**
 * A stored last-visited marker, or `null` when the bytes cannot bound a query.
 *
 * `markVisited` always writes `toISOString()`, so an unusable marker needs version
 * skew, a foreign writer, or a hand-edited key — but the failure is silent and
 * asymmetric (ISS-8533). A bare epoch NUMBER is truthy, so the `enabled` gate opens,
 * and then the two surfaces disagree: desktop drops the non-string bound and counts its
 * entire inactive corpus behind the word "recently", while web interpolates it and
 * 400s. A marker that cannot bound the query must read as ABSENT on both, which is the
 * badge-hidden path a first-time user already takes.
 *
 * `timestampMs` also accepts a raw number, so the `typeof` test is load-bearing rather
 * than defensive: it is exactly the input this exists to reject.
 *
 * Parsing to a finite instant is the floor, not the ceiling, and the round-trip is what
 * raises it. `Date.parse` accepts DATE-ONLY and YEAR-ONLY strings — `"2026-01-01"` and
 * `"2026"` are each a finite instant — and either would send an arbitrary midnight
 * boundary to both surfaces, counting old sessions as recent instead of dropping the
 * marker. Requiring the value to equal its own `toISOString()` admits exactly the
 * canonical instant this key is ever written with, byte for byte, and nothing else.
 */
function usableVisitMarker(
  value: unknown,
  fallback: string | null
): string | null {
  if (typeof value !== "string") {
    return fallback;
  }
  const parsed = timestampMs(value);
  if (parsed === undefined) {
    return fallback;
  }
  const asInstant = new Date(parsed);
  if (Number.isNaN(asInstant.getTime())) {
    return fallback;
  }
  return asInstant.toISOString() === value ? value : fallback;
}
