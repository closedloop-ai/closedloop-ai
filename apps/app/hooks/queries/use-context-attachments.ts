"use client";

import type {
  CreateContextAttachmentResponse,
  ImportGDriveContextResponse,
} from "@repo/api/src/types/context-attachment";
import {
  type UseMutationOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { entityLinkKeys } from "@/hooks/queries/use-entity-links";
import { useApiClient } from "@/hooks/use-api-client";

export type CreateContextAttachmentInput = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  projectId?: string;
};

export type ImportGDriveContextInput = {
  docIds: string[];
  projectId: string;
};

export function useCreateContextAttachment(
  issueId: string,
  options?: UseMutationOptions<
    CreateContextAttachmentResponse,
    Error,
    CreateContextAttachmentInput
  >
) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    ...options,
    mutationFn: (input: CreateContextAttachmentInput) =>
      apiClient.post<CreateContextAttachmentResponse>(
        `/issues/${issueId}/context-attachments`,
        input
      ),
    onSuccess: (data, variables, onMutateResult, mutationContext) => {
      queryClient.invalidateQueries({ queryKey: entityLinkKeys.lists() });
      options?.onSuccess?.(data, variables, onMutateResult, mutationContext);
    },
  });
}

export function useImportGDriveContext(
  issueId: string,
  options?: UseMutationOptions<
    ImportGDriveContextResponse,
    Error,
    ImportGDriveContextInput
  >
) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    ...options,
    mutationFn: (input: ImportGDriveContextInput) =>
      apiClient.post<ImportGDriveContextResponse>(
        `/issues/${issueId}/context-attachments/gdrive`,
        input
      ),
    onSuccess: (data, variables, onMutateResult, mutationContext) => {
      queryClient.invalidateQueries({ queryKey: entityLinkKeys.lists() });
      options?.onSuccess?.(data, variables, onMutateResult, mutationContext);
    },
  });
}
