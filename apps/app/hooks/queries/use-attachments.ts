"use client";

import type {
  AttachmentDownloadResponse,
  CreateAttachmentResponse,
  FileAttachment,
} from "@repo/api/src/types/attachment";
import type { UseQueryOptions } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

// Query keys
export const attachmentKeys = {
  all: ["attachments"] as const,
  lists: () => [...attachmentKeys.all, "list"] as const,
  list: (documentId: string) =>
    [...attachmentKeys.lists(), documentId] as const,
  detail: (id: string) => [...attachmentKeys.all, "detail", id] as const,
};

// Queries

export function useAttachments(
  documentId: string,
  options?: Omit<UseQueryOptions<FileAttachment[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: attachmentKeys.list(documentId),
    queryFn: () =>
      apiClient.get<FileAttachment[]>(`/documents/${documentId}/attachments`),
    enabled: !!documentId,
    ...options,
  });
}

// Mutations

export function useRequestAttachmentUpload() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      documentId,
      filename,
      mimeType,
      sizeBytes,
    }: {
      documentId: string;
      filename: string;
      mimeType: string;
      sizeBytes: number;
    }) =>
      apiClient.post<CreateAttachmentResponse>(
        `/documents/${documentId}/attachments`,
        { filename, mimeType, sizeBytes }
      ),
    onSuccess: (_, { documentId }) => {
      queryClient.invalidateQueries({
        queryKey: attachmentKeys.list(documentId),
      });
    },
  });
}

export function useDeleteAttachment(documentId: string) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (attachmentId: string) =>
      apiClient.delete<{ deleted: true }>(
        `/documents/${documentId}/attachments/${attachmentId}`
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: attachmentKeys.list(documentId),
      });
    },
  });
}

export function useDownloadAttachment() {
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: async ({
      documentId,
      attachmentId,
    }: {
      documentId: string;
      attachmentId: string;
    }) => {
      const { downloadUrl } = await apiClient.get<AttachmentDownloadResponse>(
        `/documents/${documentId}/attachments/${attachmentId}`
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
