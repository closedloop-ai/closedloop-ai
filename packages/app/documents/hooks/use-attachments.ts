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

const INLINE_IMAGE_LOG_PREFIX = "[inline-document-images]";

function getSafeErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function countInlineImageSkipReasons(
  skipped: ResolveInlineImagesResponse["skipped"]
): Record<string, number> {
  return skipped.reduce<Record<string, number>>((counts, item) => {
    counts[item.reason] = (counts[item.reason] ?? 0) + 1;
    return counts;
  }, {});
}

function logInlineImageInfo(
  message: string,
  metadata: Record<string, unknown>
) {
  console.info(`${INLINE_IMAGE_LOG_PREFIX} ${message}`, metadata);
}

function logInlineImageWarn(
  message: string,
  metadata: Record<string, unknown>
) {
  console.warn(`${INLINE_IMAGE_LOG_PREFIX} ${message}`, metadata);
}

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
    mutationFn: async (attachmentIds: string[]) => {
      const requestMetadata = {
        documentId,
        requestedCount: attachmentIds.length,
      };
      logInlineImageInfo("resolve request started", requestMetadata);

      try {
        const result = await apiClient.post<ResolveInlineImagesResponse>(
          `/documents/${documentId}/attachments/resolve`,
          { attachmentIds }
        );
        logInlineImageInfo("resolve request completed", {
          ...requestMetadata,
          resolvedCount: result.images.length,
          skippedCount: result.skipped.length,
          skipReasonCounts: countInlineImageSkipReasons(result.skipped),
        });
        return result;
      } catch (error) {
        logInlineImageWarn("resolve request failed", {
          ...requestMetadata,
          reason: "api_request_failed",
          statusCode: getSafeErrorStatus(error),
        });
        throw error;
      }
    },
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
      const uploadMetadata = {
        documentId,
        mimeType: file.type,
        purpose: AttachmentPurposeValues.Inline,
        sizeBytes: file.size,
      };
      logInlineImageInfo("upload request started", uploadMetadata);

      let upload: CreateAttachmentResponse;
      try {
        upload = await apiClient.post<CreateAttachmentResponse>(
          `/documents/${documentId}/attachments`,
          {
            filename: file.name,
            mimeType: file.type,
            purpose: AttachmentPurposeValues.Inline,
            sizeBytes: file.size,
          }
        );
      } catch (error) {
        logInlineImageWarn("upload request failed", {
          ...uploadMetadata,
          reason: "api_request_failed",
          statusCode: getSafeErrorStatus(error),
        });
        throw error;
      }

      logInlineImageInfo("upload request created attachment", {
        ...uploadMetadata,
        attachmentId: upload.attachmentId,
      });

      const cleanupCreatedAttachment = async (reason: string) => {
        const cleanupMetadata = {
          attachmentId: upload.attachmentId,
          documentId,
          purpose: AttachmentPurposeValues.Inline,
          reason,
        };
        logInlineImageInfo("cleanup attempted", cleanupMetadata);
        try {
          await apiClient.delete<{ deleted: true }>(
            `/documents/${documentId}/attachments/${upload.attachmentId}`
          );
          logInlineImageInfo("cleanup completed", cleanupMetadata);
        } catch (error) {
          logInlineImageWarn("cleanup failed", {
            ...cleanupMetadata,
            statusCode: getSafeErrorStatus(error),
          });
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
        logInlineImageWarn("signed upload PUT failed", {
          ...uploadMetadata,
          attachmentId: upload.attachmentId,
          reason: "put_exception",
        });
        await cleanupCreatedAttachment("put_exception");
        throw new Error("Image upload failed");
      }

      if (!response.ok) {
        logInlineImageWarn("signed upload PUT failed", {
          ...uploadMetadata,
          attachmentId: upload.attachmentId,
          reason: "put_non_ok",
          statusCode: response.status,
        });
        await cleanupCreatedAttachment("put_non_ok");
        throw new Error("Image upload failed");
      }

      logInlineImageInfo("signed upload PUT completed", {
        ...uploadMetadata,
        attachmentId: upload.attachmentId,
        statusCode: response.status,
      });

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
