"use client";

import {
  RELATED_SESSIONS_BATCH_ROUTE,
  RELATED_SESSIONS_PAGE_ARTIFACT_CAP,
  type RelatedSessionSummary,
  type RelatedSessionsBatchRequest,
  type RelatedSessionsBatchResponse,
  type RelatedSessionsResult,
} from "@repo/api/src/types/related-session";
import { relatedSessionsScopeResponseSchema } from "@repo/api/src/types/related-session-schema";
import { useQuery } from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";

export const relatedSessionKeys = {
  all: ["related-sessions"] as const,
  list: (artifactId: string) =>
    [...relatedSessionKeys.all, artifactId] as const,
};

/**
 * ISS-7235 — the read-only Related Sessions field's data.
 *
 * Reads `GET /artifacts/:id/related-sessions`, the artifact-generic route, so
 * every non-Session type resolves the field the same way. Read-only by
 * construction: the module exports no mutation, and the API exposes only GET on
 * that path, so there is no write for a caller to reach for.
 *
 * `enabled` defers the fetch until the field is actually gated on and revealed,
 * so a document page whose flag is off issues no request at all.
 */
export function useRelatedSessions(artifactId: string, enabled = true) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: relatedSessionKeys.list(artifactId),
    queryFn: () =>
      apiClient.get<RelatedSessionsResult>(
        `/artifacts/${artifactId}/related-sessions`
      ),
    enabled,
  });
}

export function useRelatedSessionsPage(
  artifactIds: readonly string[],
  enabled: boolean
) {
  const apiClient = useApiClient();
  const ids = [...new Set(artifactIds)].sort();
  return useQuery({
    queryKey: [...relatedSessionKeys.all, "page", ids],
    enabled: enabled && ids.length > 0,
    queryFn: async () => {
      const results: RelatedSessionsBatchResponse["results"] = {};
      for (
        let offset = 0;
        offset < ids.length;
        offset += RELATED_SESSIONS_PAGE_ARTIFACT_CAP
      ) {
        const response = await apiClient.post<RelatedSessionsBatchResponse>(
          RELATED_SESSIONS_BATCH_ROUTE,
          {
            artifactIds: ids.slice(
              offset,
              offset + RELATED_SESSIONS_PAGE_ARTIFACT_CAP
            ),
          }
        );
        Object.assign(results, response.results);
      }
      return { results };
    },
  });
}

/** ISS-12653: filter the full evidence cohort, not the eight visible pills. */
export function useRelatedSessionsMatches(
  artifactIds: readonly string[],
  sessionArtifactIds: readonly string[],
  enabled: boolean
) {
  const apiClient = useApiClient();
  const ids = [...new Set(artifactIds)].sort();
  const selected = [...new Set(sessionArtifactIds)].sort();
  return useQuery({
    queryKey: [...relatedSessionKeys.all, "matches", ids, selected],
    enabled: enabled && ids.length > 0 && selected.length > 0,
    queryFn: async () => {
      const matches = new Set<string>();
      for (
        let start = 0;
        start < selected.length;
        start += RELATED_SESSIONS_PAGE_ARTIFACT_CAP
      ) {
        const sessionIds = selected.slice(
          start,
          start + RELATED_SESSIONS_PAGE_ARTIFACT_CAP
        );
        for (
          let offset = 0;
          offset < ids.length;
          offset += RELATED_SESSIONS_PAGE_ARTIFACT_CAP
        ) {
          const result = await readRelatedSessionsScope(apiClient, {
            artifactIds: ids.slice(
              offset,
              offset + RELATED_SESSIONS_PAGE_ARTIFACT_CAP
            ),
            sessionArtifactIds: sessionIds,
          });
          for (const [id, entry] of Object.entries(result.results)) {
            if (entry.total > 0) {
              matches.add(id);
            }
          }
        }
      }
      return { matchingArtifactIds: [...matches] };
    },
  });
}

/** Search before the display cap so a facet can discover later contributions. */
export function useRelatedSessionsSearch(
  artifactIds: readonly string[],
  searchText: string,
  enabled: boolean
) {
  const apiClient = useApiClient();
  const ids = [...new Set(artifactIds)].sort();
  const search = searchText.trim();
  return useQuery({
    queryKey: [...relatedSessionKeys.all, "search", ids, search],
    enabled: enabled && ids.length > 0 && search.length > 0,
    queryFn: async () => {
      const items = new Map<
        string,
        Pick<RelatedSessionSummary, "sessionArtifactId" | "name" | "slug">
      >();
      for (
        let offset = 0;
        offset < ids.length;
        offset += RELATED_SESSIONS_PAGE_ARTIFACT_CAP
      ) {
        const result = await readRelatedSessionsScope(apiClient, {
          artifactIds: ids.slice(
            offset,
            offset + RELATED_SESSIONS_PAGE_ARTIFACT_CAP
          ),
          sessionSearch: search,
        });
        for (const entry of Object.values(result.results)) {
          for (const item of entry.items) {
            items.set(item.sessionArtifactId, {
              sessionArtifactId: item.sessionArtifactId,
              name: item.name,
              slug: item.slug,
            });
          }
        }
      }
      return { items: [...items.values()] };
    },
  });
}

async function readRelatedSessionsScope(
  apiClient: ReturnType<typeof useApiClient>,
  request: RelatedSessionsBatchRequest
): Promise<RelatedSessionsBatchResponse> {
  const response = relatedSessionsScopeResponseSchema.parse(
    await apiClient.post<unknown>(RELATED_SESSIONS_BATCH_ROUTE, request)
  );
  const scopeMatches = request.sessionArtifactIds
    ? JSON.stringify(response.appliedSessionArtifactIds?.slice().sort()) ===
      JSON.stringify(request.sessionArtifactIds.slice().sort())
    : response.appliedSessionSearch === request.sessionSearch;
  if (
    !scopeMatches ||
    request.artifactIds.some((id) => response.results[id] === undefined)
  ) {
    throw new Error("Invalid Related Sessions filter scope");
  }
  return response;
}
