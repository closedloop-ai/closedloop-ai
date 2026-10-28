"use client";

import type { AgentComponentVersionUsageResponse } from "@repo/api/src/types/agent-component-version-usage";
import { useQuery } from "@tanstack/react-query";
import { useAgentComponentsDataSource } from "../data-source/provider";
import {
  type AgentComponentsQueryIdentity,
  agentComponentKeys,
} from "./use-agent-components";

/**
 * ISS-10467/ISS-10468 — the component detail's per-CONTENT-VERSION usage read,
 * behind the drill-down and the side-by-side compare.
 *
 * `supported` is the SOURCE CAPABILITY, surfaced rather than swallowed: a data
 * source with no `versionUsage` method cannot scope usage by version at all, and
 * the panel must say that instead of rendering zeroes nobody measured. It is
 * distinct from a supported source that answered with measured zeroes, which is
 * the whole ISS-5363 distinction this feature has to keep.
 *
 * The query stays idle while no version is selected — the drill-down is
 * on-demand, so opening the page costs nothing until a version is chosen.
 */
export function useAgentComponentVersionUsage(
  slug: string,
  versionHashes: readonly string[],
  identity?: AgentComponentsQueryIdentity
) {
  const dataSource = useAgentComponentsDataSource();
  const versionUsage = dataSource.versionUsage;
  const supported = typeof versionUsage === "function";

  const query = useQuery<AgentComponentVersionUsageResponse, Error>({
    queryKey: agentComponentKeys.versionUsage(
      dataSource.scope,
      slug,
      versionHashes,
      identity
    ),
    queryFn: () => {
      if (!versionUsage) {
        // Unreachable while `enabled` gates on `supported`; kept because the
        // optional method is a capability probe, not a type-guaranteed value.
        return Promise.reject(
          new Error("This data source cannot scope usage by version.")
        );
      }
      return versionUsage(slug, versionHashes);
    },
    enabled: supported && Boolean(slug) && versionHashes.length > 0,
    throwOnError: false,
  });

  return { ...query, supported };
}
