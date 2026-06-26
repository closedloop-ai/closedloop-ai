/**
 * Query-key factory for project queries. Lives in the shared app-core layer
 * (FEA-1510) so portable hooks (e.g. tags) can invalidate project caches;
 * the project hooks themselves migrate here in the hooks wave (PLN-810
 * Phase 3).
 */
export const projectKeys = {
  all: ["projects"] as const,
  lists: () => [...projectKeys.all, "list"] as const,
  list: (filters: Record<string, unknown>) =>
    [...projectKeys.lists(), filters] as const,
  details: () => [...projectKeys.all, "detail"] as const,
  detail: (id: string) => [...projectKeys.details(), id] as const,
  recent: (teamId: string) => [...projectKeys.all, "recent", teamId] as const,
  favorites: () => [...projectKeys.all, "favorites"] as const,
  bySlug: (slug: string) => [...projectKeys.all, "by-slug", slug] as const,
};
