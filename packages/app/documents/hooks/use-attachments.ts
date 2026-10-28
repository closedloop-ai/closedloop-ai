"use client";

import type {
  AttachmentDownloadResponse,
  AttachmentPurpose,
  CreateAttachmentResponse,
  FileAttachment,
  ResolvedInlineImage,
  ResolveInlineImagesResponse,
  SkippedInlineImage,
} from "@repo/api/src/types/attachment";
import {
  AttachmentPurposeSelector,
  AttachmentPurpose as AttachmentPurposeValues,
  buildInlineAttachmentRef,
  chunkInlineImageAttachmentIds,
} from "@repo/api/src/types/attachment";
import type { UseQueryResult } from "@tanstack/react-query";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";
import {
  type MutationToastOptions,
  mutationToastMeta,
} from "../../shared/query/query-client";

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
  /**
   * The purpose is part of the key, not just the URL: two selectors return
   * different rows, so sharing one entry would serve a `context`-only response
   * to an `inline` read. It nests under `list` so every
   * `invalidateQueries({ queryKey: list(documentId) })` still prefix-matches —
   * there are four such call sites, three here and one in `add-context-dialog`.
   */
  listByPurpose: (documentId: string, purpose: AttachmentPurposeSelector) =>
    [...attachmentKeys.list(documentId), purpose] as const,
  detail: (id: string) => [...attachmentKeys.all, "detail", id] as const,
};

// Queries

/**
 * The one definition of an attachments-list read. Both legs of
 * {@link useDocumentAttachments} are built from it, so a drift in the key or the
 * query string can only happen in one place — and is therefore assertable.
 */
export function attachmentsListQueryOptions(
  apiClient: ReturnType<typeof useApiClient>,
  documentId: string,
  purpose: AttachmentPurposeSelector
) {
  const query = new URLSearchParams({ purpose });
  return {
    queryKey: attachmentKeys.listByPurpose(documentId, purpose),
    queryFn: () =>
      apiClient.get<FileAttachment[]>(
        `/documents/${documentId}/attachments?${query.toString()}`
      ),
    enabled: !!documentId,
  };
}

/**
 * Every attachment a panel may list: the `context` rows, plus the `inline` rows
 * so an unreferenced one can be surfaced instead of being invisible (ISS-8036).
 *
 * Two scoped reads rather than one `purpose=all`, because the server caps a
 * listing at 200 rows with no pagination — under one request, inline pastes
 * would push context attachments off the response, hiding files that are visible
 * today. Each purpose gets its own budget instead.
 *
 * Inline rows are ADDITIVE to a successful `context` read: if that leg fails,
 * the hook returns `[]` whatever the inline leg did. A merge of the inline leg
 * alone would render a populated panel with every user-added context attachment
 * silently missing, and a failed list fetch raises no toast — the global
 * `QueryCache.onError` handles auth rejections only.
 *
 * That holds on a FAILED REFETCH too, not just a cold failure — see
 * {@link combineAttachmentLegs}.
 */
export function useDocumentAttachments(
  documentId: string,
  options?: { enabled?: boolean }
) {
  const apiClient = useApiClient();

  return useQueries({
    queries: [
      {
        ...attachmentsListQueryOptions(
          apiClient,
          documentId,
          AttachmentPurposeSelector.Context
        ),
        enabled: !!documentId && (options?.enabled ?? true),
      },
      {
        ...attachmentsListQueryOptions(
          apiClient,
          documentId,
          AttachmentPurposeSelector.Inline
        ),
        enabled: !!documentId && (options?.enabled ?? true),
      },
    ],
    combine: combineAttachmentLegs,
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
 *
 * One document can hold more refs than the endpoint accepts in a request, so
 * the call is split at the API's own cap — the same split `get-document` does
 * for the MCP reader. A chunk that fails contributes nothing rather than
 * rejecting its siblings: its refs then read as unavailable while the rest of
 * the document still renders. Every chunk failing still rejects, so a total
 * outage is never reported as a document whose images merely went missing.
 */
export function useResolveInlineImages(documentId: string) {
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: async (
      attachmentIds: string[]
    ): Promise<ResolveInlineImagesResponse> => {
      const chunks = chunkInlineImageAttachmentIds(attachmentIds);
      if (chunks.length === 0) {
        return { images: [], skipped: [] };
      }

      const settled = await Promise.allSettled(
        chunks.map((chunk) =>
          apiClient.post<ResolveInlineImagesResponse>(
            `/documents/${documentId}/attachments/resolve`,
            { attachmentIds: chunk }
          )
        )
      );

      const images: ResolvedInlineImage[] = [];
      const skipped: SkippedInlineImage[] = [];
      let fulfilledCount = 0;
      let firstRejectionReason: unknown;
      let hasRejection = false;
      for (const result of settled) {
        if (result.status === "fulfilled") {
          fulfilledCount += 1;
          images.push(...(result.value.images ?? []));
          skipped.push(...(result.value.skipped ?? []));
        } else if (!hasRejection) {
          hasRejection = true;
          firstRejectionReason = result.reason;
        }
      }

      if (fulfilledCount === 0 && hasRejection) {
        throw firstRejectionReason;
      }

      return { images, skipped };
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
        src: buildInlineAttachmentRef(upload.attachmentId),
      };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: attachmentKeys.list(documentId),
      });
    },
  });
}

export function useDeleteAttachment(
  documentId: string,
  options?: Readonly<MutationToastOptions>
) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    meta: mutationToastMeta(options),
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

/**
 * Module scope, not an inline arrow: `useQueries` re-invokes `combine` whenever
 * its identity changes, so a fresh closure per render would re-sort both legs on
 * every keystroke in the editor body.
 */
function combineAttachmentLegs([context, inline]: [
  UseQueryResult<FileAttachment[]>,
  UseQueryResult<FileAttachment[]>,
]) {
  // Each leg is read only when its OWN fetch is good. A query keeps its previous
  // `data` when a refetch fails, so a leg that has ever succeeded still carries
  // rows while `isError` is true — reading `data` alone would serve stale
  // context rows after a failed invalidation instead of the `[]` this hook
  // documents, and would keep inline rows a failed inline refetch can no longer
  // vouch for. Both are attachment lists a user acts on, including by deleting.
  const contextRows = context.isError ? undefined : context.data;
  const inlineRows = inline.isError ? undefined : inline.data;
  return {
    data: contextRows ? mergeAttachments(contextRows, inlineRows) : [],
    isPending: context.isPending || inline.isPending,
    isError: context.isError || inline.isError,
  };
}

/**
 * The service orders on `createdAt desc` with no secondary key, so merging two
 * independently ordered streams needs the `id` tie-break to be a total order —
 * without it, rows sharing a timestamp would shuffle between renders.
 */
function mergeAttachments(
  context: FileAttachment[],
  inline: FileAttachment[] | undefined
): FileAttachment[] {
  return [...context, ...(inline ?? [])].sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? 1 : -1;
    }
    return a.id < b.id ? -1 : 1;
  });
}
