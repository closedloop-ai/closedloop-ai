"use client";

import type { AgentComponentInvocationReadRow } from "@repo/api/src/types/agent-component-invocation";
import type {
  AgentComponentInvocationSessionTreeBound,
  AgentComponentInvocationSessionTreePage,
} from "@repo/api/src/types/agent-component-invocation-session-tree";
import {
  AGENT_COMPONENT_INVOCATION_SESSION_TREE_MAX_PAGES,
  agentComponentInvocationSessionTreeBound,
} from "@repo/api/src/types/agent-component-invocation-session-tree";
import { useQuery } from "@tanstack/react-query";
import {
  AgentSessionCapability,
  agentSessionSourceSupports,
} from "../data-source/agent-sessions-data-source";
import { useAgentSessionsDataSource } from "../data-source/provider";
import { agentSessionKeys } from "./agent-session-keys";

export type SessionInvocationTree = {
  items: AgentComponentInvocationReadRow[];
  /** Every invocation the session holds, as the producer counted it. */
  total: number;
  /** What this walk says about its own completeness. */
  bound: AgentComponentInvocationSessionTreeBound;
};

export type SessionInvocationTreeResult = {
  data: SessionInvocationTree | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  /**
   * The active data source cannot serve a tree at all — a mirrored renderer on
   * an installed build whose preload predates the channel, or a test double.
   *
   * Deliberately NOT folded into `isError` or into an empty page: "this source
   * cannot tell you" and "this session ran no components" are different facts,
   * and the surface says which one it has.
   */
  isUnsupported: boolean;
};

type TreeReader = (request: {
  sessionId: string;
  cursor?: string;
}) => Promise<AgentComponentInvocationSessionTreePage>;

/**
 * ISS-10737: the session-scoped invocation tree behind the Trace tab.
 *
 * IT WALKS THE PAGES. A tree clipped at a page boundary orphans every descendant
 * of a dropped row, so a partial answer is not a smaller tree but a wrong one —
 * which is why the producer's bound is followable and why this hook follows it
 * to exhaustion rather than rendering the first page. The walk is bounded by
 * {@link AGENT_COMPONENT_INVOCATION_SESSION_TREE_MAX_PAGES} so a producer bug
 * cannot become an unbounded client loop, and stopping at that ceiling is
 * DISCLOSED through `bound.droppedCount` rather than passed off as the whole
 * tree.
 *
 * `enabled` is the flag gate's only appearance in the data layer, and it does
 * not need one: this hook is called from `SessionTraceTab`, which is mounted
 * only on the flag-on branch of the single read site in
 * `SessionDetailWorkspace`. The query is gated by NOT EXISTING when the flag is
 * off, rather than by a boolean threaded down to it — which is what the
 * `no-threaded-feature-flag` rule asks for.
 */
export function useSessionInvocationTree(
  sessionId: string
): SessionInvocationTreeResult {
  const dataSource = useAgentSessionsDataSource();
  const supported = agentSessionSourceSupports(
    dataSource,
    sessionId,
    AgentSessionCapability.SessionInvocationTree
  );
  const read = supported
    ? dataSource.sessionInvocationTree?.bind(dataSource)
    : undefined;
  const query = useQuery<SessionInvocationTree, Error>({
    queryKey: agentSessionKeys.invocationTree(dataSource.scope, sessionId),
    queryFn: () => {
      if (!read) {
        throw new Error("Session invocation tree is not served here.");
      }
      return walkSessionInvocationTree(read, sessionId);
    },
    enabled: Boolean(sessionId) && read !== undefined,
    throwOnError: false,
  });
  return {
    data: query.data,
    isLoading: read !== undefined && query.isPending,
    isError: query.isError,
    error: query.error ?? null,
    isUnsupported: read === undefined,
  };
}

/**
 * Follow `nextCursor` to exhaustion, or to the page ceiling.
 *
 * `total` is taken from the LAST page read, so the completeness check is made
 * against the most recent count rather than one taken before the walk began.
 */
export async function walkSessionInvocationTree(
  read: TreeReader,
  sessionId: string,
  maxPages: number = AGENT_COMPONENT_INVOCATION_SESSION_TREE_MAX_PAGES
): Promise<SessionInvocationTree> {
  const items: AgentComponentInvocationReadRow[] = [];
  let cursor: string | undefined;
  let total = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await read({
      sessionId,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...result.items);
    total = result.total;
    if (result.nextCursor === undefined) {
      return {
        items,
        total,
        bound: agentComponentInvocationSessionTreeBound(
          total,
          items.length,
          maxPages
        ),
      };
    }
    cursor = result.nextCursor;
  }
  return {
    items,
    total,
    bound: agentComponentInvocationSessionTreeBound(
      total,
      items.length,
      maxPages
    ),
  };
}
