/**
 * Query-key factory for loop queries. Lives in the shared app-core layer
 * (FEA-1510) so portable hooks (e.g. tags) can invalidate loop caches; the
 * loop hooks themselves migrate here in the hooks wave (PLN-810 Phase 3).
 */
export const loopKeys = {
  all: ["loops"] as const,
  lists: () => [...loopKeys.all, "list"] as const,
  list: (filters: Record<string, unknown>) =>
    [...loopKeys.lists(), filters] as const,
  details: () => [...loopKeys.all, "detail"] as const,
  detail: (id: string) => [...loopKeys.details(), id] as const,
  events: (id: string) => [...loopKeys.detail(id), "events"] as const,
  eventsPaginated: (id: string, filters: Record<string, unknown>) =>
    [...loopKeys.detail(id), "events-paginated", filters] as const,
  usage: (filters: Record<string, unknown>) =>
    [...loopKeys.all, "usage", filters] as const,
  summaries: (documentIds: string[]) =>
    [...loopKeys.all, "summaries", documentIds] as const,
};
