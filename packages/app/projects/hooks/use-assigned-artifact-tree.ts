"use client";

import {
  ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM,
  ASSIGNED_ARTIFACT_TREE_PATH,
  type ProjectTreeResponse,
} from "@repo/api/src/types/project-tree";
import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { z } from "zod";
import { useApiClient } from "../../shared/api/use-api-client";
import { projectTreeKeys } from "./use-project-tree";

/**
 * Nested UNDER the canonical project-tree prefix on purpose.
 *
 * The document and artifact-link mutation paths invalidate
 * `projectTreeKeys.all` and nothing else (`documents/hooks/use-artifact-links`,
 * `tags/hooks/use-tags`). A sibling top-level key would sit outside every one
 * of those invalidators, so an edit or a reparent would leave My Tasks stale
 * until an incidental refetch. Nesting means the existing invalidators cover
 * this cache with no second list to keep in sync.
 */
export const assignedArtifactTreeKeys = {
  all: [...projectTreeKeys.all, "assigned"] as const,
  detail: (assigneeId: string) =>
    [...assignedArtifactTreeKeys.all, assigneeId] as const,
};

type AssignedArtifactTreeOptions = {
  enabled?: boolean;
};

/**
 * Runtime shape guard for the tree payload.
 *
 * The API client returns parsed JSON without checking it, so a 200 carrying
 * `data: {}` (a deploy skew, a proxy that swallowed the body, a route that
 * changed shape) would otherwise be cached as a `ProjectTreeResponse` and
 * crash the board on `treeData.nodes.filter`. This validates the STRUCTURE the
 * consumer actually walks — the arrays and their node shape — and deliberately
 * leaves the artifact bodies loose: they are owned by the API contract, and a
 * strict re-declaration here would reject additive server fields, which is
 * exactly the version-skew failure the repo's cross-repo rule forbids.
 */
const treeNodeSchema = z.looseObject({
  root: z.looseObject({ id: z.string() }),
  children: z.array(z.looseObject({ id: z.string() })),
});

const assignedArtifactTreeSchema = z.looseObject({
  nodes: z.array(treeNodeSchema),
  externalParents: z.array(z.looseObject({ childId: z.string() })),
});

/**
 * Fetch one assignee's merged, org-scoped artifact tree in a SINGLE request
 * (FEA-1651, parent FEA-908; flagged by wongk in the PR #1077 review).
 *
 * Replaces `useMergedProjectTrees`, which issued one `GET /projects/:id/tree`
 * per project the user is assigned in — an N-request fan-out that grew with the
 * number of projects. The server now resolves the anchors, walks the graph, and
 * merges the result, so this hook is one `useQuery` over
 * `GET /artifacts/assigned-tree`.
 *
 * WHAT THE PAYLOAD CONTAINS — the return TYPE matches `useMergedProjectTrees`,
 * but matching `ProjectTreeResponse` only means the board compiles against
 * either hook; it does NOT mean the two render the same screen, and this is the
 * line to read before treating the swap as free. The per-project fan-out
 * returned every artifact in each project. This endpoint returns the user's own
 * two task streams — artifacts assigned to them AND branches they have commit
 * authorship on — plus each anchor's parent chain and its descendants. Other
 * people's unrelated artifacts in the same project are NOT included.
 *
 * The response may also carry `truncation` when the server hit one of its
 * bounds; a tree WITHOUT that field is a claim of completeness, and consumers
 * must not present a truncated tree as a complete one.
 *
 * @param assigneeId - User whose work anchors the tree. A null or empty value
 *   disables the read (there is nothing to scope it to).
 * @param options.enabled - When false, no fetch is issued and `data` is null.
 *   Defaults to true. Used to defer the read until the consuming panel is
 *   actually visible (per `apps/app/AGENTS.md` on-mount fetch convention).
 */
export function useAssignedArtifactTree(
  assigneeId: string | null | undefined,
  options?: AssignedArtifactTreeOptions
): {
  data: ProjectTreeResponse | null;
  isLoading: boolean;
  isError: boolean;
  /**
   * Re-run this read. Exposed so a consumer's "Try again" can retry the tree
   * stream it actually failed on, rather than only the reads it happens to hold
   * a refetch for.
   */
  refetch: () => void;
} {
  const apiClient = useApiClient();
  const enabled = options?.enabled !== false && Boolean(assigneeId);
  const resolvedAssigneeId = assigneeId ?? "";

  const query = useQuery({
    queryKey: assignedArtifactTreeKeys.detail(resolvedAssigneeId),
    queryFn: async () => {
      const response = await apiClient.get<ProjectTreeResponse>(
        assignedArtifactTreePath(resolvedAssigneeId)
      );
      // Throwing here puts the query into `isError`, which the board already
      // renders as a load failure — a malformed 200 must surface as an error,
      // not be cached and crash the render downstream.
      assignedArtifactTreeSchema.parse(response);
      return response;
    },
    enabled,
  });

  const { refetch } = query;
  const refetchTree = useCallback(() => {
    refetch().catch(() => {
      // The retried query records its own error state; this catch only stops
      // the refetch rejection surfacing as an unhandled rejection.
    });
  }, [refetch]);

  return {
    data: enabled ? (query.data ?? null) : null,
    isLoading: enabled && query.isLoading,
    isError: enabled && query.isError,
    refetch: refetchTree,
  };
}

export function assignedArtifactTreePath(assigneeId: string): string {
  const params = new URLSearchParams({
    [ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM]: assigneeId,
  });
  return `${ASSIGNED_ARTIFACT_TREE_PATH}?${params.toString()}`;
}
