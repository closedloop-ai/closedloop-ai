"use client";

import type {
  ArtifactCollaboratorBatchResponse,
  ArtifactCollaboratorEntry,
  CollaboratorArtifactType,
} from "@repo/api/src/types/artifact-collaborators";
import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { useApiAdapter } from "../api/provider";
import { useApiClient } from "../api/use-api-client";
import { useAuthSnapshot } from "../auth/use-auth-snapshot";
import {
  type ArtifactCommentsCollection,
  artifactCommentKeys,
} from "../comments/artifact-comments-cache";
import { readArtifactCollaborators } from "../lib/artifact-collaborators";

/** One bounded, shared read for each visible artifact's people and direct comment count. */
export function useArtifactCollaborators({
  artifactType,
  artifactIds,
  enabled = true,
}: {
  artifactType: CollaboratorArtifactType;
  artifactIds: readonly string[];
  enabled?: boolean;
}) {
  const api = useApiClient();
  const { orgId, userId } = useAuthSnapshot();
  const { deploymentId } = useApiAdapter();
  const queryScope = useMemo(
    () => [deploymentId, orgId, userId],
    [deploymentId, orgId, userId]
  );
  return useArtifactCollaboratorSource({
    artifactType,
    artifactIds,
    enabled,
    queryScope,
    read: (ids) => readArtifactCollaborators(api, artifactType, ids),
  });
}

/** The same bounded cohort/cache behavior through a shell-owned data-source port. */
export function useArtifactCollaboratorSource({
  artifactType,
  artifactIds,
  enabled = true,
  queryScope,
  read,
  queryClient,
}: {
  artifactType: CollaboratorArtifactType;
  artifactIds: readonly string[];
  enabled?: boolean;
  queryScope: readonly unknown[];
  read: (
    ids: readonly string[]
  ) => Promise<ArtifactCollaboratorBatchResponse | null | undefined>;
  queryClient?: QueryClient;
}) {
  const client = useQueryClient(queryClient);
  const idKey = JSON.stringify([...new Set(artifactIds)].sort());
  const ids = useMemo<string[]>(() => JSON.parse(idKey), [idKey]);
  const queryKey = useMemo(
    () =>
      ["artifact-collaborators", ...queryScope, artifactType, idKey] as const,
    [queryScope, artifactType, idKey]
  );
  const query = useQuery(
    {
      queryKey,
      queryFn: async (): Promise<
        ReadonlyMap<string, ArtifactCollaboratorEntry>
      > => {
        const response = await read(ids);
        return new Map(
          response?.results.map((entry) => [entry.artifactId, entry])
        );
      },
      enabled: enabled && ids.length > 0,
      staleTime: 0,
    },
    client
  );
  // Shared comment writes and realtime reloads update this cache. Refresh only
  // the mounted cohort containing the changed artifact, including inline comments.
  useEffect(() => {
    if (!enabled || ids.length === 0) {
      return;
    }
    const cohort = new Set(ids);
    return client.getQueryCache().subscribe((event) => {
      if (
        event.type !== "updated" ||
        event.action.type !== "success" ||
        event.query.queryKey[0] !== artifactCommentKeys.all[0]
      ) {
        return;
      }
      const collection = event.query.state.data as
        | ArtifactCommentsCollection
        | undefined;
      if (collection?.artifactId && cohort.has(collection.artifactId)) {
        client.invalidateQueries({ queryKey, exact: true });
      }
    });
  }, [client, enabled, ids, queryKey]);
  return query;
}
