"use client";

import type {
  AgentComponentDetail,
  AgentComponentListResponse,
  AgentComponentQueryFilters,
} from "@repo/api/src/types/agent-component";
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
