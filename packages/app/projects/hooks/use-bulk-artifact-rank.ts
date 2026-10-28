"use client";

import type {
  BulkRankArtifactsRequest,
  BulkRankArtifactsResponse,
  ProjectRankStateResponse,
} from "@repo/api/src/types/project-artifact-bulk-rank";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ApiError } from "../../shared/api/api-error";
import { useApiClient } from "../../shared/api/use-api-client";
import { projectTreeKeys } from "./project-tree-keys";

/**
 * Stack-ranking client for the atomic bulk rank endpoint (ISS-8999).
 *
 * The single-move client (`useMoveArtifact` in `use-project-tree.ts`) sends one
 * request per root, so applying a whole computed order costs one round trip per
 * artifact and leaves the project partially ordered in between. These hooks
 * read the project's current order plus its epoch, then commit a complete new
 * order in one request that either lands entirely or not at all.
 *
 * FALLBACK FOR OLDER SERVERS. A server that predates this endpoint has no
 * handler at `/projects/:id/artifacts/rank` and answers 404 — the same status a
 * current server uses for a project outside the caller's organization. The two
 * are not distinguishable from the bulk response alone, so a caller that must
 * degrade uses {@link isBulkRankUnsupported}: it reports "this server may not
 * support bulk rank" and the caller confirms by re-reading the project through
 * an endpoint that has always existed. When bulk is genuinely unavailable, fall
 * back to `useMoveArtifact` and issue the moves in order, bottom root first, so
 * each `MovePosition.Top` push leaves the already-placed prefix intact. That
 * fallback gives up atomicity by construction: it is N independent writes, so a
 * failure part way through leaves a partial order the caller must reconcile by
 * re-reading. Prefer bulk whenever it is available.
 */

export const projectRankKeys = {
  all: ["project-rank"] as const,
  state: (projectId: string) =>
    [...projectRankKeys.all, projectId, "state"] as const,
};

/**
 * The project's current root order and the epoch it was read at. Feed
 * `rankEpoch` straight back as `expectedRankEpoch`; it is opaque, and the only
 * defined operation on it is equality against a later read.
 *
 * `staleTime: 0` is deliberate and NOT the default-by-omission: this value is a
 * concurrency token, so a cached one is exactly the input that produces a
 * spurious 409. Always read it immediately before computing an order.
 */
export function useProjectRankState(
  projectId: string,
  options?: Omit<
    UseQueryOptions<ProjectRankStateResponse>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: projectRankKeys.state(projectId),
    queryFn: () =>
      apiClient.get<ProjectRankStateResponse>(
        `/projects/${projectId}/artifacts/rank`
      ),
    enabled: !!projectId,
    staleTime: 0,
    ...options,
  });
}

/**
 * Commit a complete new root order for one project atomically.
 *
 * No optimistic cache update, unlike `useMoveArtifact`: a bulk rewrite can be
 * rejected for a reason the client cannot predict (the population moved under
 * it), and painting a full reorder that then rolls back is a worse lie than a
 * brief wait. Both the tree and the rank-state caches are invalidated on
 * settle — including on error, because a 409 means the client's picture of the
 * order is already known to be stale.
 */
export function useBulkRankArtifacts(projectId: string) {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation<
    BulkRankArtifactsResponse,
    Error,
    BulkRankArtifactsRequest
  >({
    mutationFn: (body) =>
      apiClient.post<BulkRankArtifactsResponse>(
        `/projects/${projectId}/artifacts/rank`,
        body
      ),
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: projectTreeKeys.detail(projectId),
      });
      queryClient.invalidateQueries({
        queryKey: projectRankKeys.state(projectId),
      });
    },
  });
}

/**
 * Whether `error` is consistent with a server that has no bulk rank endpoint.
 *
 * Reports a POSSIBILITY, not a fact — a current server returns the same 404 for
 * a project the caller cannot see — so a caller that acts on it must confirm
 * the project is reachable before concluding the endpoint is missing, and must
 * surface the original error if it is not.
 */
export function isBulkRankUnsupported(error: unknown): boolean {
  return error instanceof ApiError && error.isNotFound();
}
