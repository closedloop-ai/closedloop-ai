"use client";

import type {
  AttachmentDownloadResponse,
  CreateAttachmentResponse,
  FileAttachment,
} from "@repo/api/src/types/attachment";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

// Query keys
export const attachmentKeys = {
  all: ["attachments"] as const,
  list: (artifactId: string) => ["attachments", "list", artifactId] as const,
};

// Queries

export function useAttachments(artifactId: string) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: attachmentKeys.list(artifactId),
    queryFn: () =>
      apiClient.get<FileAttachment[]>(`/artifacts/${artifactId}/attachments`),
    enabled: !!artifactId,
  });
}

// Mutations

export function useRequestAttachmentUpload() {
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({
      artifactId,
      filename,
      mimeType,
      sizeBytes,
    }: {
      artifactId: string;
      filename: string;
      mimeType: string;
      sizeBytes: number;
    }) =>
      apiClient.post<CreateAttachmentResponse>(
        `/artifacts/${artifactId}/attachments`,
        { filename, mimeType, sizeBytes }
      ),
  });
}

export function useDeleteAttachment(artifactId: string) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (attachmentId: string) =>
      apiClient.delete<{ deleted: true }>(
        `/artifacts/${artifactId}/attachments/${attachmentId}`
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: attachmentKeys.list(artifactId),
      });
    },
  });
}

export function useDownloadAttachment() {
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: async ({
      artifactId,
      attachmentId,
    }: {
      artifactId: string;
      attachmentId: string;
    }) => {
      const { downloadUrl } = await apiClient.get<AttachmentDownloadResponse>(
        `/artifacts/${artifactId}/attachments/${attachmentId}`
      );

      if (globalThis.window === undefined) {
        return;
      }

      const a = globalThis.window.document.createElement("a");
      a.href = downloadUrl;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      globalThis.window.document.body.appendChild(a);
      a.click();
      globalThis.window.document.body.removeChild(a);
    },
  });
}
