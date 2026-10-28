"use client";

import type {
  AgentSessionAnalytics,
  AgentSessionDetail,
  AgentSessionListResponse,
  AgentSessionsPageData,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import {
  type UseQueryOptions,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import type {
  AgentSessionQueryFilters,
  AgentSessionUsageQueryFilters,
} from "../data-source/agent-sessions-data-source";
import { useAgentSessionsDataSource } from "../data-source/provider";

import { agentSessionKeys } from "./agent-session-keys";
import { queryReadInitiator } from "./read-initiator";

export type {
  AgentSessionQueryFilters,
  AgentSessionUsageQueryFilters,
} from "../data-source/agent-sessions-data-source";

export function useAgentSessionUsage(
  filters: AgentSessionUsageQueryFilters = {},
  options?: Omit<
    UseQueryOptions<AgentSessionUsageSummary>,
    "queryKey" | "queryFn"
  >
) {
  const dataSource = useAgentSessionsDataSource();

  return useQuery({
    ...options,
    queryKey: agentSessionKeys.usage(dataSource.scope, filters),
    // ISS-7852: hand the read TanStack Query's own signal, which it aborts when
    // this query is superseded (a range switch) or its last observer unmounts.
    // Correctness never depended on it — the key above carries `filters`, so a
    // late answer lands in its own entry — it is the heaviest read on the page
    // that makes it worth handing over. ISS-9806: what the abort actually stops
    // is the TRANSPORT's to say, not this hook's and not the source's — only
    // the platform `fetch` tears down work already running, and desktop reaches
    // this same source over a bridge that does not. See
    // `AgentSessionsReadOptions` for all three.
    queryFn: ({ signal, client, queryKey }) =>
      dataSource.usage(filters, {
        signal,
        readInitiator: queryReadInitiator({ client, queryKey }),
      }),
    enabled: isAgentSessionQueryEnabled(filters) && (options?.enabled ?? true),
  });
}

export function useAgentSessions(
  filters: AgentSessionQueryFilters = {},
  options?: Omit<
    UseQueryOptions<AgentSessionListResponse>,
    "queryKey" | "queryFn"
  >
) {
  const dataSource = useAgentSessionsDataSource();

  return useQuery({
    ...options,
    queryKey: agentSessionKeys.list(dataSource.scope, filters),
    queryFn: (context) =>
      dataSource.list(filters, {
        readInitiator: queryReadInitiator(context),
      }),
    enabled: isAgentSessionQueryEnabled(filters) && (options?.enabled ?? true),
  });
}

/**
 * Combined list + usage read (FEA-4157). Both surfaces mount the Sessions table
 * and its prop-driven summary cards together, so this is one query — one
 * underlying `pageData` read — instead of the table and the cards each issuing
 * an independent fetch that redundantly scans the same rows. Mirrors
 * `useBranchesPageData`: a stable scope+filters `queryKey` shares/reuses the
 * cache across navigation, and callers pass the Branches caching affordances
 * (`placeholderData`/`keepPreviousData`, `staleTime`/`gcTime`) so a filter or
 * time-range change shows last-good instead of a spinner. `useAgentSessions`
 * (list-only) stays for surfaces that render the list without the summary cards.
 *
 * ISS-6041: takes the USAGE filter shape, so a host that renders the summary
 * cards can ask this one read for the ISS-5809 period-over-period comparison
 * exactly as `useAgentSessionUsage` does. The opt-in rides the `queryKey` like
 * every other filter, so a surface that starts (or stops) asking for it never
 * serves the other shape from cache.
 */
export function useAgentSessionsPageData(
  filters: AgentSessionUsageQueryFilters = {},
  options?: Omit<UseQueryOptions<AgentSessionsPageData>, "queryKey" | "queryFn">
) {
  const dataSource = useAgentSessionsDataSource();

  return useQuery({
    ...options,
    queryKey: agentSessionKeys.pageData(dataSource.scope, filters),
    // ISS-7852: same thread as `useAgentSessionUsage`. This is the read the
    // DESKTOP Sessions view takes its summary out of, so leaving it unsignalled
    // would leave that surface with no supersession handling at all. ISS-9806:
    // what it gains there is bounded, and differs by desktop MODE — Local skips
    // a read superseded before it is issued and discards a running one; Cloud
    // builds the HTTP source over an IPC bridge that reads no signal at all, so
    // it skips nothing. See `AgentSessionsReadOptions`.
    queryFn: ({ signal, client, queryKey }) =>
      dataSource.pageData(filters, {
        signal,
        readInitiator: queryReadInitiator({ client, queryKey }),
      }),
    enabled: isAgentSessionQueryEnabled(filters) && (options?.enabled ?? true),
  });
}

export function useAgentSessionDetail(
  id: string,
  options?: Omit<UseQueryOptions<AgentSessionDetail>, "queryKey" | "queryFn">
) {
  const dataSource = useAgentSessionsDataSource();

  return useQuery({
    ...options,
    queryKey: agentSessionKeys.detail(dataSource.scope, id),
    queryFn: (context) =>
      dataSource.detail(id, { readInitiator: queryReadInitiator(context) }),
    enabled: Boolean(id) && (options?.enabled ?? true),
  });
}

export function useAgentSessionAnalytics(
  filters: AgentSessionQueryFilters = {},
  options?: Omit<UseQueryOptions<AgentSessionAnalytics>, "queryKey" | "queryFn">
) {
  const dataSource = useAgentSessionsDataSource();

  return useQuery({
    ...options,
    queryKey: agentSessionKeys.analytics(dataSource.scope, filters),
    // ISS-9741: same thread as `useAgentSessionUsage`. `analyticsRoot` converges
    // on every live-bridge flush, and query-core's `cancelRefetch` only drops the
    // superseded promise — without the signal the aggregate underneath it keeps
    // running to completion and its answer is thrown away.
    //
    // Scoped to sources that can actually honor it, because TOUCHING `signal` is
    // itself the decision: query-core watches for the access and, having seen it,
    // stops leaving an unobserved fetch to finish and populate the cache
    // (`removeObserver` → `cancel({ revert: true })`). That trade is a straight
    // loss against a source the abort cannot reach — an unmount/remount pays for
    // a discarded 27s `aggregateAnalytics` AND a fresh one behind it on the same
    // bounded-read lane, where before it deduplicated against the first. WHICH
    // desktop source is in that position changed with ISS-9802: the LOCAL one
    // carries a cancellation token across IPC and now reports `true`, while
    // desktop CLOUD mode still reports `false`. The rule is unchanged — read the
    // signal only where cancelling means something, and ask the source which.
    queryFn: (context) =>
      dataSource.analytics(
        filters,
        dataSource.cancelsInFlightReads === false
          ? undefined
          : { signal: context.signal }
      ),
    enabled: isAgentSessionQueryEnabled(filters) && (options?.enabled ?? true),
  });
}

function isAgentSessionQueryEnabled(
  filters: AgentSessionQueryFilters
): boolean {
  return !(
    filters.viewerScope === AgentSessionViewerScope.Team && !filters.teamId
  );
}

/**
 * ISS-7249: cancel the EXACT in-flight `pageData` read for these filters, so a
 * caller's follow-up `refetch()` issues a genuinely new request.
 *
 * `refetch({ cancelRefetch: true })` — the default — is NOT equivalent, which is
 * the whole reason this exists. query-core only takes the cancel branch when the
 * query already holds data; on a first read that is still pending it returns the
 * existing retryer promise instead, so a Retry against a wedged initial load
 * starts nothing and waits on the same hung request forever.
 *
 * It lives beside {@link useAgentSessionsPageData} so the key is built by the
 * one owner of that key rather than reconstructed at a call site, where a drift
 * would silently cancel nothing.
 */
export function useCancelAgentSessionsPageData(
  filters: AgentSessionUsageQueryFilters = {}
): () => void {
  const queryClient = useQueryClient();
  const dataSource = useAgentSessionsDataSource();
  const queryKey = agentSessionKeys.pageData(dataSource.scope, filters);
  const queryKeyRef = useRef(queryKey);
  queryKeyRef.current = queryKey;

  // Fired, never awaited: `cancelQueries` dispatches synchronously and batches
  // its notification, so a caller can refetch in the same tick without the
  // surface committing an idle frame in between. It self-catches internally.
  return useCallback(() => {
    queryClient.cancelQueries({ exact: true, queryKey: queryKeyRef.current });
  }, [queryClient]);
}

/**
 * ISS-9857: whether a cache key names a walk past a session detail's event
 * prefix (`agentSessionKeys.eventsPages`), for the broad sweep that resets
 * every such walk at once. Positional on purpose — the walk keys extend the
 * detail key, so a prefix match on `details()` reaches them and the detail
 * entries alike, and only the `"events"` segment tells the two apart.
 */
export function isAgentSessionEventsPagesKey(
  queryKey: readonly unknown[]
): boolean {
  const eventsSegmentIndex = agentSessionKeys.details().length + 2;
  return (
    queryKey.length === eventsSegmentIndex + 2 &&
    queryKey[eventsSegmentIndex] === "events"
  );
}
