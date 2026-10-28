"use client";

import { useMutation } from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";

/**
 * PLN-2190 T-3.2: resets the live doc-sync draft to the latest version on the
 * server. The content reaches the editor as a Yjs sync, so the hook returns
 * nothing to apply. A failure surfaces through the default mutation-error
 * toast.
 */
export function useResetLiveDraft(documentId: string) {
  const apiClient = useApiClient();
  return useMutation({
    mutationFn: () =>
      apiClient.post<unknown>(`/documents/${documentId}/live-draft/reset`, {}),
  });
}
