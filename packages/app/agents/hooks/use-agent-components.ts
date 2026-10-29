"use client";

import {
  AGENT_COMPONENT_INVENTORY_CAP,
  type AgentComponentDetail,
  type AgentComponentListResponse,
  type AgentComponentQueryFilters,
} from "@repo/api/src/types/agent-component";
import { AGENT_COMPONENT_PAGE_SIZE } from "@repo/api/src/utils/agent-component-page-data";
import { collectComponentPopulation } from "@repo/api/src/utils/agent-component-population";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useAgentComponentsDataSource } from "../data-source/provider";

export type { AgentComponentQueryFilters } from "@repo/api/src/types/agent-component";

export type AgentComponentsQueryIdentity = {
  /** Caller-owned cache segment, such as the hosted web org identity. */
  cacheScope?: string;
};

/**
 * Query-key factory for the Agents workspace component inventory slice.
 *
 * Root is `["agent-components"]` — distinct from `agentSessionKeys`
 * (use-agent-sessions.ts) to prevent
 * cross-cache collisions.
 *
 * The `list` and `detail` variants embed the data-source scope so a surface
 * that swaps sources never serves stale rows from a different source's cache.
 * Callers may add a `cacheScope` segment for surface-local identities (e.g.
 * hosted web org), preventing cross-org stale reads while preserving defaults.
 */
export const agentComponentKeys = {
  all: ["agent-components"] as const,
  lists: () => [...agentComponentKeys.all, "list"] as const,
  list: (
    scope: string,
    filters: Record<string, unknown>,
    identity?: AgentComponentsQueryIdentity
  ) =>
    [
      ...agentComponentKeys.lists(),
      scope,
      cacheScope(identity),
      filters,
    ] as const,
  /**
   * ISS-6891: the COMPLETE-population read — every page of one filter set, not
   * one page of it. Nested under `lists()` on purpose (unlike `pageDatas()`),
   * because the live bridge's `lists()` invalidation must move it exactly as it
   * moves a single-page list; the extra segment only keeps the two from serving
   * each other's cache entry for identical filters.
   */
  population: (
    scope: string,
    filters: Record<string, unknown>,
    identity?: AgentComponentsQueryIdentity
  ) =>
    [
      ...agentComponentKeys.lists(),
      "complete",
      scope,
      cacheScope(identity),
      filters,
    ] as const,
  /**
   * ISS-6822: the bounded page-data read. A SEPARATE branch from `lists()` on
   * purpose — its cache entry is one page plus compact results, not a
   * population, so it must not be served from (or invalidated as) a list entry.
   * The live bridge invalidates both branches, since a local DB push moves the
   * page exactly as it moves a list.
   */
  pageDatas: () => [...agentComponentKeys.all, "page-data"] as const,
  pageData: (
    scope: string,
    request: Record<string, unknown>,
    identity?: AgentComponentsQueryIdentity
  ) =>
    [
      ...agentComponentKeys.pageDatas(),
      scope,
      cacheScope(identity),
      request,
    ] as const,
  details: () => [...agentComponentKeys.all, "detail"] as const,
  detail: (
    scope: string,
    slug: string,
    identity?: AgentComponentsQueryIdentity
  ) =>
    [
      ...agentComponentKeys.details(),
      scope,
      cacheScope(identity),
      slug,
    ] as const,
  /**
   * ISS-10467/ISS-10468: one detail's per-CONTENT-VERSION usage drill-down.
   *
   * Nested under `details()` so the live bridge's detail invalidation moves it
   * with the page it belongs to; the version set is the last segment because a
   * compare of {A,B} and a drill-down of {A} are different answers and must not
   * serve each other's cache entry.
   */
  versionUsage: (
    scope: string,
    slug: string,
    versionHashes: readonly string[],
    identity?: AgentComponentsQueryIdentity
  ) =>
    [
      ...agentComponentKeys.details(),
      scope,
      cacheScope(identity),
      slug,
      "version-usage",
      [...versionHashes],
    ] as const,
};

export function useAgentComponents(
  filters: AgentComponentQueryFilters = {},
  options?: Omit<
    UseQueryOptions<AgentComponentListResponse>,
    "queryKey" | "queryFn"
  >,
  identity?: AgentComponentsQueryIdentity
) {
  const dataSource = useAgentComponentsDataSource();
  const queryKey = agentComponentKeys.list(dataSource.scope, filters, identity);

  return useQuery({
    queryKey,
    queryFn: () => dataSource.list(filters),
    ...options,
  });
}

/**
 * ISS-6891: read the COMPLETE component population for `filters`, following the
 * endpoint's own `hasMore`/`total` continuation rather than keeping the first
 * page and calling it the inventory.
 *
 * The Agents workspace computes its filters, groups, summary cards, facet menu,
 * and its own pagination over whatever this returns, so a first-page-only read
 * makes every one of those numbers describe a prefix while presenting it as the
 * org's inventory — the client half of the truncation ISS-6891 removed from the
 * server. `filters.limit` is the PAGE size here, not a ceiling.
 *
 * The following itself is the shared `collectComponentPopulation`, so this hook,
 * the cloud page-data reducer, and the desktop one cannot drift into three
 * different notions of "complete".
 */
export function useCompleteAgentComponents(
  filters: AgentComponentQueryFilters = {},
  options?: Omit<
    UseQueryOptions<AgentComponentListResponse>,
    "queryKey" | "queryFn"
  >,
  identity?: AgentComponentsQueryIdentity
) {
  const dataSource = useAgentComponentsDataSource();

  return useQuery({
    queryKey: agentComponentKeys.population(
      dataSource.scope,
      filters,
      identity
    ),
    queryFn: () =>
      collectComponentPopulation(
        (page) => dataSource.list({ ...filters, ...page }),
        {
          pageSize: filters.limit ?? DEFAULT_POPULATION_PAGE_SIZE,
          offset: filters.offset,
          // #6483: this one goes over the WIRE, where the list validator
          // REJECTS (does not clamp) a `limit` above the shared page bound. So
          // the follower's single wide re-read is capped here at the widest page
          // the endpoint accepts; past that it pages, as before.
          maxPageSize: AGENT_COMPONENT_INVENTORY_CAP,
        }
      ),
    ...options,
  });
}

export function useAgentComponentDetail(
  slug: string,
  options?: Omit<UseQueryOptions<AgentComponentDetail>, "queryKey" | "queryFn">,
  identity?: AgentComponentsQueryIdentity
) {
  const dataSource = useAgentComponentsDataSource();

  return useQuery({
    queryKey: agentComponentKeys.detail(dataSource.scope, slug, identity),
    queryFn: () => dataSource.detail(slug),
    enabled: Boolean(slug),
    ...options,
  });
}

function cacheScope(identity?: AgentComponentsQueryIdentity): string {
  return identity?.cacheScope ?? "default";
}

/**
 * Page size used when a caller names none. Matches the list endpoint's own
 * default so the paged read issues the same request the single-page read would.
 */
const DEFAULT_POPULATION_PAGE_SIZE = AGENT_COMPONENT_PAGE_SIZE;
