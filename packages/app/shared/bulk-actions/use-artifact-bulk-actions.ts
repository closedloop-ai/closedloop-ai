"use client";

import type { BatchMutationResponse } from "@repo/api/src/types/batch-mutation-result";
import { useApiClientOptional } from "@repo/app/shared/api/use-api-client-optional";
import { useMemo } from "react";
import {
  type ArtifactBulkActionEntry,
  type ArtifactBulkHost,
  type ArtifactBulkRow,
  createArtifactBulkActionRegistry,
} from "./registry";

/** React adapter for the shared action registry in web and Desktop hosts. */
export function useArtifactBulkActions(input: {
  rows: readonly ArtifactBulkRow[];
  host?: Omit<ArtifactBulkHost, "post">;
  extras?: readonly ArtifactBulkActionEntry[];
}): ArtifactBulkActionEntry[] {
  const apiClient = useApiClientOptional();
  return useMemo(
    () =>
      createArtifactBulkActionRegistry({
        rows: input.rows,
        host: {
          ...input.host,
          post: (route, body) => {
            if (!apiClient) {
              throw new Error("Bulk action API is unavailable");
            }
            return apiClient.post<BatchMutationResponse>(route, body);
          },
        },
        extras: input.extras,
      }),
    [apiClient, input.rows, input.host, input.extras]
  );
}
