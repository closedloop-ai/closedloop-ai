"use client";

import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import { invalidateArtifactLinkQueries } from "@repo/app/documents/hooks/use-artifact-links";
import { projectTreeKeys } from "@repo/app/projects/hooks/project-tree-keys";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

/**
 * Delete only the Closedloop Branch Artifact and invalidate every projection
 * that can still reference it. The upstream git Branch/PR is never modified.
 */
export function useDeleteBranch() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ deleted: true }>(`/branches/${id}`),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: projectTreeKeys.all });
      queryClient.invalidateQueries({ queryKey: documentKeys.all });
      invalidateArtifactLinkQueries(queryClient, id);
    },
  });
}
