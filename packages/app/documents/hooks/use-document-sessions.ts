"use client";

import type { DocumentSessionsResponse } from "@repo/api/src/types/document-sessions";
import { useQuery } from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";
import { documentKeys } from "./document-keys";

/** Mounted only inside the active Sessions tab, in either product shell. */
export function useDocumentSessions(documentId: string) {
  const apiClient = useApiClient();
  return useQuery({
    queryKey: [...documentKeys.detail(documentId), "sessions"],
    queryFn: () =>
      apiClient.get<DocumentSessionsResponse>(
        `/documents/${documentId}/sessions`
      ),
  });
}
