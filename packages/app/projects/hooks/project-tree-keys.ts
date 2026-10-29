import type { ProjectTreeQueryFilters } from "@repo/api/src/types/project-tree";

export const projectTreeKeys = {
  all: ["project-tree"] as const,
  detail: (projectId: string, filters?: ProjectTreeQueryFilters) =>
    hasProjectTreeFilters(filters)
      ? ([...projectTreeKeys.all, projectId, "filters", filters] as const)
      : ([...projectTreeKeys.all, projectId] as const),
  /**
   * Detailed-tree variant (`?include=details`, PLN-874). Nested under
   * `detail` so every existing detail-prefix invalidation (and the
   * optimistic stack-rank update) covers it automatically.
   */
  withDetails: (projectId: string, filters?: ProjectTreeQueryFilters) =>
    [...projectTreeKeys.detail(projectId, filters), "with-details"] as const,
};

function hasProjectTreeFilters(filters?: ProjectTreeQueryFilters): boolean {
  // `limit` counts as a filter for cache purposes: two reads of the same
  // project under different bounds return different node sets, so they must not
  // collide on one cache key (ISS-5307). `category` for the same reason: a
  // filtered population and the unfiltered tree are different node sets.
  return (
    Boolean(filters?.contributorUserId) ||
    filters?.limit !== undefined ||
    filters?.category !== undefined ||
    filters?.hierarchy !== undefined ||
    filters?.parentArtifactId !== undefined ||
    filters?.childCursor !== undefined ||
    filters?.childLimit !== undefined ||
    filters?.rootCursor !== undefined ||
    filters?.includeHierarchyRevision === true
  );
}
