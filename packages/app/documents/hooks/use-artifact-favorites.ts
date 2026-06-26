"use client";

import type { Artifact } from "@repo/api/src/types/artifact";
import type { FavoriteResponse } from "@repo/api/src/types/project";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";

export const artifactFavoriteKeys = {
  all: ["artifact-favorites"] as const,
  list: () => [...artifactFavoriteKeys.all, "list"] as const,
};

export function useFavoriteArtifacts(
  options?: Omit<UseQueryOptions<Artifact[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: artifactFavoriteKeys.list(),
    queryFn: () => apiClient.get<Artifact[]>("/artifacts/favorites"),
    ...options,
  });
}

export function useIsFavoriteArtifact(artifactId: string): boolean {
  const { data: favorites } = useFavoriteArtifacts();
  return favorites?.some((f) => f.id === artifactId) ?? false;
}

export function useToggleFavoriteArtifact() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({
      artifactId,
      isFavorite,
    }: {
      artifactId: string;
      isFavorite: boolean;
    }) => {
      if (isFavorite) {
        return apiClient.delete<FavoriteResponse>(
          `/artifacts/${artifactId}/favorite`
        );
      }
      return apiClient.post<FavoriteResponse>(
        `/artifacts/${artifactId}/favorite`,
        {}
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: artifactFavoriteKeys.list(),
      });
    },
  });
}
