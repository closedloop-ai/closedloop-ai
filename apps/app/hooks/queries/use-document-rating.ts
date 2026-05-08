"use client";

import type {
  DocumentRatingSummary,
  SubmitRatingRequest,
} from "@repo/api/src/types/rating";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

// Query keys
export const ratingKeys = {
  all: ["ratings"] as const,
  details: () => [...ratingKeys.all, "detail"] as const,
  detail: (documentId: string) =>
    [...ratingKeys.details(), documentId] as const,
};

// Query hook
export function useDocumentRating(
  documentId: string,
  options?: Omit<UseQueryOptions<DocumentRatingSummary>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: ratingKeys.detail(documentId),
    queryFn: () =>
      apiClient.get<DocumentRatingSummary>(`/documents/${documentId}/rating`),
    enabled: !!documentId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    ...options,
  });
}

// Mutation hook
export function useSubmitRating() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({
      documentId,
      score,
      comment,
    }: SubmitRatingRequest & { documentId: string }) =>
      apiClient.put<DocumentRatingSummary>(`/documents/${documentId}/rating`, {
        score,
        comment,
      }),
    onSuccess: (_, { documentId }) => {
      queryClient.invalidateQueries({
        queryKey: ratingKeys.detail(documentId),
      });
    },
  });
}
