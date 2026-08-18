"use client";

import type {
  CatalogItemDto,
  CreateCatalogItemRequest,
  ImportPackRepoRequest,
  ImportPackZipResponse,
  UpdateCatalogItemRequest,
} from "@repo/api/src/types/distribution";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LONG_RUNNING_API_TIMEOUT_MS } from "../../shared/api/api-timeout";
import { useApiClient } from "../../shared/api/use-api-client";

/**
 * TanStack Query key factory for the catalog slice (FEA-2923 / T-17).
 */
export const catalogKeys = {
  all: ["catalog"] as const,
  lists: () => [...catalogKeys.all, "list"] as const,
  list: () => [...catalogKeys.lists()] as const,
  details: () => [...catalogKeys.all, "detail"] as const,
  detail: (id: string) => [...catalogKeys.details(), id] as const,
};

// ---------------------------------------------------------------------------
// Upload-intent types (not yet in distribution.ts — unique to catalog upload flow)
// ---------------------------------------------------------------------------

/**
 * Request body for POST /catalog/upload-intent (admin-only, AC-016).
 * Requests a presigned S3 PUT URL for a zip or logo asset.
 */
export type UploadIntentRequest = {
  catalogItemId: string;
  /** "zip" for the plugin bundle, "logo" for the image. */
  fileType: "zip" | "logo";
  /** MIME type of the file (e.g. "application/zip", "image/png"). */
  contentType: string;
  /** File size in bytes — enforced server-side for the ZIP_MAX_SIZE cap. */
  fileSizeBytes: number;
};

/**
 * Response from POST /catalog/upload-intent.
 */
export type UploadIntentResponse = {
  /** Short-lived (15 min) presigned S3 PUT URL. */
  presignedUrl: string;
  /** S3 object key to pass back to POST /catalog/confirm. */
  s3Key: string;
};

/**
 * Request body for POST /catalog/confirm (admin-only, AC-016).
 * Triggers a HeadObject check and updates the CatalogItem asset key.
 */
export type ConfirmUploadRequest = {
  catalogItemId: string;
  fileType: "zip" | "logo";
  s3Key: string;
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Fetches the org-visible catalog (org-custom + curated items).
 * GET /catalog
 */
export function useCatalogItems() {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: catalogKeys.list(),
    queryFn: () => apiClient.get<CatalogItemDto[]>("/catalog"),
  });
}

/**
 * Fetches a single catalog item by ID.
 * GET /catalog/{id}
 */
export function useCatalogItem(id: string) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: catalogKeys.detail(id),
    queryFn: () => apiClient.get<CatalogItemDto>(`/catalog/${id}`),
    enabled: Boolean(id),
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Creates a new org-custom CatalogItem.
 * POST /catalog (admin-only)
 */
export function useCreateCatalogItem() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateCatalogItemRequest) =>
      apiClient.post<CatalogItemDto>("/catalog", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: catalogKeys.lists() });
    },
  });
}

/**
 * Updates a CatalogItem (name, description, sortOrder, enabled, coaching fields).
 * PATCH /catalog/{id}. Admins can update catalog-management fields; creators
 * can update their own editable org-custom metadata/content.
 */
export function useUpdateCatalogItem() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...data }: UpdateCatalogItemRequest & { id: string }) =>
      apiClient.patch<CatalogItemDto>(`/catalog/${id}`, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: catalogKeys.detail(variables.id),
      });
      queryClient.invalidateQueries({ queryKey: catalogKeys.lists() });
    },
  });
}

/**
 * Archives a CatalogItem (soft-delete).
 * DELETE /catalog/{id} (admin-only)
 */
export function useArchiveCatalogItem() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<CatalogItemDto>(`/catalog/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: catalogKeys.lists() });
    },
  });
}

/**
 * Requests a presigned S3 PUT URL for uploading a zip or logo asset.
 * POST /catalog/upload-intent (admin-only)
 */
export function useUploadIntent() {
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: UploadIntentRequest) =>
      apiClient.post<UploadIntentResponse>("/catalog/upload-intent", input),
  });
}

/**
 * Confirms that an S3 upload has completed (HeadObject verification).
 * POST /catalog/confirm (admin-only)
 */
export function useConfirmUpload() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: ConfirmUploadRequest) =>
      apiClient.post<CatalogItemDto>("/catalog/confirm", input),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: catalogKeys.detail(variables.catalogItemId),
      });
      queryClient.invalidateQueries({ queryKey: catalogKeys.lists() });
    },
  });
}

/**
 * Parses a Pack's uploaded zip (canonical Claude Code layout) into child
 * components. POST /catalog/{id}/import-zip (admin-only).
 */
export function useImportPackZip() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (packId: string) =>
      // Long-running by design: the route downloads and parses a Pack zip of
      // up to ZIP_MAX_BYTES and creates every child component before it
      // responds, so it needs more than the default client deadline.
      apiClient.post<ImportPackZipResponse>(
        `/catalog/${packId}/import-zip`,
        {},
        { timeoutMs: LONG_RUNNING_API_TIMEOUT_MS }
      ),
    // ISS-5013: invalidate on SETTLED, not only on success. The import is
    // server-side idempotent and commits under a per-pack advisory lock, so a
    // client deadline can abandon a request whose children already landed. On
    // `onSuccess` alone the pack would keep rendering its pre-import child count
    // beside a toast about the same import — two claims about one pack, one of
    // them false. `onSettled` does not replace the shared default error toast
    // the way an `onError` override would.
    onSettled: (_data, _error, packId) => {
      queryClient.invalidateQueries({ queryKey: catalogKeys.detail(packId) });
      queryClient.invalidateQueries({ queryKey: catalogKeys.lists() });
    },
  });
}

/**
 * Imports components from a GitHub repo the org has App visibility to (canonical
 * Claude Code layout). POST /catalog/{id}/import-repo (admin-only).
 */
export function useImportPackRepo() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      packId,
      ...body
    }: ImportPackRepoRequest & { packId: string }) =>
      // Long-running by design: the route walks the repo tree and fetches up
      // to MAX_COMPONENT_FILES blobs at BLOB_FETCH_CONCURRENCY before it
      // responds, so it needs more than the default client deadline.
      apiClient.post<ImportPackZipResponse>(
        `/catalog/${packId}/import-repo`,
        body,
        { timeoutMs: LONG_RUNNING_API_TIMEOUT_MS }
      ),
    // Settled, not success — see `useImportPackZip` for why a client deadline
    // must still reconcile the pack's child count.
    onSettled: (_data, _error, { packId }) => {
      queryClient.invalidateQueries({ queryKey: catalogKeys.detail(packId) });
      queryClient.invalidateQueries({ queryKey: catalogKeys.lists() });
    },
  });
}
