import type { QueryFilters, QueryKey } from "@tanstack/react-query";

/**
 * One cached region an optimistic artifact write touches.
 *
 * A bare `QueryKey` is a PREFIX and matches everything under it, which is right
 * for the filter-keyed reads (`lists()`, `pageDataRoot()`): every cached filter
 * combination can carry the row.
 *
 * A function is for a region where the prefix is too broad. `agentSessionKeys`
 * nests a session's events pages and invocation tree UNDER its detail key, so
 * invalidating `details()` refetches every loaded events page of every cached
 * session for a one-field write (tamsinb review, PR #8315). Such a root is
 * resolved against the row being written and returns a `QueryFilters` that
 * names exactly its own entry — see `agentSessionKeys.detailRow`.
 */
export type ArtifactCacheRoot =
  | QueryKey
  | ((artifactId: string) => QueryFilters);

/** The filters one root means for this row. */
export function resolveArtifactCacheRoot(
  root: ArtifactCacheRoot,
  artifactId: string
): QueryFilters {
  if (typeof root === "function") {
    return root(artifactId);
  }
  return { queryKey: root };
}
