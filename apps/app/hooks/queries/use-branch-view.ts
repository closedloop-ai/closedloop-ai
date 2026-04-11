"use client";

import type {
  BranchViewComment,
  BranchViewData,
  BranchViewFileDiff,
  ReplyToCommentInput,
} from "@repo/api/src/types/branch-view";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

export const branchViewKeys = {
  all: ["branch-view"] as const,
  details: () => [...branchViewKeys.all, "detail"] as const,
  detail: (id: string) => [...branchViewKeys.details(), id] as const,
  fileDiffs: () => [...branchViewKeys.all, "file-diff"] as const,
  fileDiff: (id: string, path: string) =>
    [...branchViewKeys.fileDiffs(), id, path] as const,
};

export function useBranchView(externalLinkId: string) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: branchViewKeys.detail(externalLinkId),
    queryFn: () =>
      apiClient.get<BranchViewData>(`/branch-view/${externalLinkId}`),
    enabled: !!externalLinkId,
  });
}

export function useBranchViewFileDiff(
  externalLinkId: string,
  path: string | null,
  previousPath?: string
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: branchViewKeys.fileDiff(externalLinkId, path ?? ""),
    queryFn: () => {
      const params = new URLSearchParams({ path: path! });
      if (previousPath) {
        params.set("previousPath", previousPath);
      }
      return apiClient.get<BranchViewFileDiff>(
        `/branch-view/${externalLinkId}/files/diff?${params.toString()}`
      );
    },
    enabled: !!externalLinkId && !!path,
  });
}

export function useSyncBranchView(externalLinkId: string) {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      apiClient.post<{ synced: boolean }>(
        `/branch-view/${externalLinkId}/sync`,
        {}
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: branchViewKeys.detail(externalLinkId),
      });
    },
  });
}

export function useReplyToComment(externalLinkId: string) {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: ReplyToCommentInput) =>
      apiClient.post<BranchViewComment>(
        `/branch-view/${externalLinkId}/comments/reply`,
        input
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: branchViewKeys.detail(externalLinkId),
      });
    },
  });
}
