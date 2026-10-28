/**
 * Query-key factory for document queries. Lives in the shared app-core layer
 * (FEA-1510) so portable hooks (e.g. tags) can invalidate document caches;
 * the document hooks themselves migrate here in the hooks wave (PLN-810
 * Phase 3).
 */
export const documentKeys = {
  all: ["documents"] as const,
  lists: () => [...documentKeys.all, "list"] as const,
  /**
   * The Documents summary band's reads (ISS-8936). A sibling of `lists()` rather
   * than a child: the band and the table answer different questions over the same
   * filters, so one key would have each overwrite the other's payload. Because it
   * IS a sibling, `invalidateArtifactCaches` must name it explicitly — a
   * `lists()` invalidation does not prefix-match it, and a band left on a stale
   * total beside a refreshed table is two screens disagreeing (review-soul).
   */
  summaries: () => [...documentKeys.all, "summary"] as const,
  list: (filters: Record<string, unknown>) =>
    [...documentKeys.lists(), filters] as const,
  details: () => [...documentKeys.all, "detail"] as const,
  detail: (id: string) => [...documentKeys.details(), id] as const,
  bySlugs: () => [...documentKeys.all, "by-slug"] as const,
  bySlug: (slug: string) => [...documentKeys.all, "by-slug", slug] as const,
  versions: (id: string) => [...documentKeys.detail(id), "versions"] as const,
  version: (id: string, version: number) =>
    [...documentKeys.versions(id), version] as const,
  previewDeployment: (id: string) =>
    [...documentKeys.detail(id), "preview-deployment"] as const,
  related: (id: string) => [...documentKeys.detail(id), "related"] as const,
};
