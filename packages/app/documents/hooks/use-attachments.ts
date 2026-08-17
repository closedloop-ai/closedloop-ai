"use client";

import type {
  AttachmentDownloadResponse,
  AttachmentPurpose,
  CreateAttachmentResponse,
  FileAttachment,
  ResolveInlineImagesResponse,
} from "@repo/api/src/types/attachment";
import { AttachmentPurpose as AttachmentPurposeValues } from "@repo/api/src/types/attachment";
import type { UseQueryOptions } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";

/**
 * The thrown message IS the toast a user reads — `inline-image-upload.ts` puts
 * `error.message` straight into `onInlineImageUploadError`. It has to say what
 * to do next, because with the console diagnostics removed it is now the only
 * signal a failed paste or drop produces.
 */
const INLINE_IMAGE_UPLOAD_FAILED_MESSAGE =
  "Couldn't upload the image. Try again.";

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
      purpose,
      sizeBytes,
    }: {
      documentId: string;
      filename: string;
      mimeType: string;
      purpose?: AttachmentPurpose;
      sizeBytes: number;
    }) =>
      apiClient.post<CreateAttachmentResponse>(
        `/documents/${documentId}/attachments`,
        { filename, mimeType, purpose, sizeBytes }
      ),
    onSuccess: (_, { documentId }) => {
      queryClient.invalidateQueries({
        queryKey: attachmentKeys.list(documentId),
      });
    },
  });
}

/**
 * Resolve document-scoped inline image references to short-lived display URLs.
 * The query is intentionally caller-triggered so editor pages do not fetch
 * unless inline image rendering is enabled and image refs are present.
 */
export function useResolveInlineImages(documentId: string) {
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (attachmentIds: string[]) =>
      apiClient.post<ResolveInlineImagesResponse>(
        `/documents/${documentId}/attachments/resolve`,
        { attachmentIds }
      ),
  });
}

/**
 * Request an inline-image upload, PUT the file to S3, and clean up the DB row if
 * the direct upload fails after the row is created.
 */
export function useUploadInlineImage(documentId: string) {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (file: File) => {
      const upload = await apiClient.post<CreateAttachmentResponse>(
        `/documents/${documentId}/attachments`,
        {
          filename: file.name,
          mimeType: file.type,
          purpose: AttachmentPurposeValues.Inline,
          sizeBytes: file.size,
        }
      );

      // Best-effort: the caller already sees the thrown upload failure, so a
      // cleanup failure must not mask it.
      const cleanupCreatedAttachment = async () => {
        try {
          await apiClient.delete<{ deleted: true }>(
            `/documents/${documentId}/attachments/${upload.attachmentId}`
          );
        } catch {
          // swallowed deliberately — see above
        }
      };

      let response: Response;
      try {
        response = await globalThis.fetch(upload.uploadUrl, {
          body: file,
          headers: { "Content-Type": file.type },
          method: "PUT",
        });
      } catch {
        await cleanupCreatedAttachment();
        throw new Error(INLINE_IMAGE_UPLOAD_FAILED_MESSAGE);
      }

      if (!response.ok) {
        await cleanupCreatedAttachment();
        throw new Error(INLINE_IMAGE_UPLOAD_FAILED_MESSAGE);
      }

      return {
        attachmentId: upload.attachmentId,
        src: `attachment://${upload.attachmentId}`,
      };
    },
    onSuccess: () => {
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
