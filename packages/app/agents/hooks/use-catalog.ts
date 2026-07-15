"use client";

import type {
  CatalogItemDto,
  CreateCatalogItemRequest,
  ImportPackRepoRequest,
  ImportPackZipResponse,
  UpdateCatalogItemRequest,
} from "@repo/api/src/types/distribution";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
      apiClient.post<ImportPackZipResponse>(
        `/catalog/${packId}/import-zip`,
        {}
      ),
    onSuccess: (_, packId) => {
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
      apiClient.post<ImportPackZipResponse>(
        `/catalog/${packId}/import-repo`,
        body
      ),
    onSuccess: (_, { packId }) => {
      queryClient.invalidateQueries({ queryKey: catalogKeys.detail(packId) });
      queryClient.invalidateQueries({ queryKey: catalogKeys.lists() });
    },
  });
}
