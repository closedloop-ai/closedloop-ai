import type { LoopCommand } from "@repo/api/src/types/loop";

/**
 * Query-key factory for document queries. Lives in the shared app-core layer
 * (FEA-1510) so portable hooks (e.g. tags) can invalidate document caches;
 * the document hooks themselves migrate here in the hooks wave (PLN-810
 * Phase 3).
 */
export const documentKeys = {
  all: ["documents"] as const,
  lists: () => [...documentKeys.all, "list"] as const,
  list: (filters: Record<string, unknown>) =>
    [...documentKeys.lists(), filters] as const,
  details: () => [...documentKeys.all, "detail"] as const,
  detail: (id: string) => [...documentKeys.details(), id] as const,
  bySlugs: () => [...documentKeys.all, "by-slug"] as const,
  bySlug: (slug: string) => [...documentKeys.all, "by-slug", slug] as const,
  versions: (id: string) => [...documentKeys.detail(id), "versions"] as const,
  version: (id: string, version: number) =>
    [...documentKeys.versions(id), version] as const,
  generationStatus: (id: string) =>
    [...documentKeys.detail(id), "generation-status"] as const,
  previewDeployment: (id: string) =>
    [...documentKeys.detail(id), "preview-deployment"] as const,
  related: (id: string) => [...documentKeys.detail(id), "related"] as const,
  inheritedAdditionalRepos: (id: string, command: LoopCommand) =>
    [
      ...documentKeys.detail(id),
      "inherited-additional-repos",
      command,
    ] as const,
};
