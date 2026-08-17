"use client";

import type { ArtifactActivityFeedResult } from "@repo/api/src/types/artifact-activity-feed";
import { ARTIFACT_ACTIVITY_FEED_DEFAULT_LIMIT } from "@repo/api/src/types/artifact-activity-feed";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";

/**
 * Artifact activity FEED query hook (FEA-3875 / FEA-3535 Slice 4).
 *
 * Reads the merged, actor-normalized, newest-first, cursor-paginated activity
 * timeline for one artifact from `GET /documents/[id]/activity` (the aggregate
 * endpoint shipped in FEA-3864). Powers the `Activity` feed source in the
 * document feed rail.
 *
 * Cross-surface: goes through `useApiClient` (the surface-agnostic transport +
 * auth port), so it works unchanged in both the web app and the desktop
 * renderer. Pagination is delegated to TanStack's `useInfiniteQuery` — each
 * page carries the prior page's opaque `nextCursor`; the query stops when
 * `nextCursor` is null. `select` flattens every fetched page into one
 * newest-first item array so consumers never reason about page boundaries.
 */

export const artifactActivityFeedKeys = {
  all: ["artifact-activity-feed"] as const,
  detail: (documentId: string) =>
    [...artifactActivityFeedKeys.all, documentId] as const,
};

/** The opaque page cursor; `null` on the first page. */
type ActivityCursor = string | null;

export function useArtifactActivityFeed(
  documentId: string,
  options?: { enabled?: boolean }
) {
  const apiClient = useApiClient();

  return useInfiniteQuery({
    queryKey: artifactActivityFeedKeys.detail(documentId),
    queryFn: ({ pageParam }: { pageParam: ActivityCursor }) => {
      const params = new URLSearchParams({
        limit: String(ARTIFACT_ACTIVITY_FEED_DEFAULT_LIMIT),
      });
      if (pageParam) {
        params.set("cursor", pageParam);
      }
      return apiClient.get<ArtifactActivityFeedResult>(
        `/documents/${documentId}/activity?${params.toString()}`
      );
    },
    initialPageParam: null as ActivityCursor,
    getNextPageParam: (lastPage): ActivityCursor => lastPage.nextCursor,
    select: (data) => data.pages.flatMap((page) => page.items),
    enabled: options?.enabled ?? !!documentId,
    staleTime: 30 * 1000,
  });
}
