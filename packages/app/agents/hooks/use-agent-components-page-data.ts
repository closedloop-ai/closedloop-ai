"use client";

import type {
  AgentComponentPageDataRequest,
  AgentComponentPageDataResult,
} from "@repo/api/src/utils/agent-component-page-data";
import { useQuery } from "@tanstack/react-query";
import { useAgentComponentsDataSource } from "../data-source/provider";
import {
  type AgentComponentsQueryIdentity,
  agentComponentKeys,
} from "./use-agent-components";

/**
 * ISS-6822 — read the Agents workspace's page, facet counts, and both summary
 * windows in ONE bounded call.
 *
 * The query is DISABLED — and resolves nothing — when the active data source
 * does not implement `pageData`. That is the whole compatibility story: a
 * desktop build whose preload predates the IPC method, a Phase-1 stub, or a test
 * double simply has no `pageData`, the query never runs, and the caller keeps
 * using the `list`-based path. Nothing throws and nothing 404s.
 */
export function useAgentComponentsPageData(
  request: AgentComponentPageDataRequest,
  options?: { enabled?: boolean },
  identity?: AgentComponentsQueryIdentity
) {
  const dataSource = useAgentComponentsDataSource();
  const readPageData = dataSource.pageData;

  return useQuery<AgentComponentPageDataResult>({
    queryKey: agentComponentKeys.pageData(dataSource.scope, request, identity),
    queryFn: (context) => {
      // Unreachable while `enabled` gates on the same value; kept as a real
      // rejection rather than a non-null assertion so a future caller that
      // forces `enabled` gets an error it can render, not `undefined is not a
      // function`.
      if (!readPageData) {
        return Promise.reject(
          new Error("This data source does not support page-data reads.")
        );
      }
      // ISS-11170: each settled search term is a new key, so the read it
      // supersedes loses its observer and query-core aborts this signal. Read
      // `context.signal` only for a source that can act on it — touching it
      // is what opts the query out of the unmount dedupe (ISS-9741). This is
      // `useAgentSessionAnalytics`' policy, and deliberately not
      // `useAgentSessionsPageData`'s, which hands its signal down
      // unconditionally (ISS-7852/ISS-9806): on desktop cloud the abort reaches
      // nothing, so reading the signal there would only cost the dedupe.
      return readPageData(
        request,
        dataSource.cancelsInFlightReads === false
          ? undefined
          : { signal: context.signal }
      );
    },
    enabled: readPageData !== undefined && (options?.enabled ?? true),
  });
}
