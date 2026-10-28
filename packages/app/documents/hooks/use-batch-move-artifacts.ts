"use client";

import type {
  BatchMoveArtifactsInput,
  BatchMoveArtifactsResult,
} from "@repo/api/src/types/artifact";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import {
  type QueryClient,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  bulkReceiptFromCommittedIds,
  invalidateForBulkArtifactMutation,
} from "./bulk-artifact-invalidation";

/**
 * Move a selection of artifacts to another parent.
 *
 * Its own module so the shared invalidation registry can own its refresh
 * without `use-artifact-links` and that registry importing each other: the
 * registry narrows link views, this hook drives the registry.
 *
 * `extraQueryClients` are clients the mover must refresh ALONGSIDE the parent
 * one, for a surface whose rows a data source reads from a client of its own —
 * Desktop's `DesktopBranchesSource` injects one, the same reason
 * `useUpdateBranchPriority` takes its client from that context. Each gets the
 * WHOLE registry: a surface reading three families from an injected client
 * reads the other ten from it too, so a hand-picked slice leaves them stale.
 *
 * The refresh runs from this hook's own `onSuccess` and never from a per-call
 * `mutate` callback, because TanStack drops those once the component that
 * called `mutate` unmounts — a user switching tabs while the POST is in flight
 * would otherwise come back to the old value (davetho review, PR #8735).
 */
export function useBatchMoveArtifacts(
  extraQueryClients?: readonly QueryClient[]
) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: BatchMoveArtifactsInput) =>
      apiClient.post<BatchMoveArtifactsResult>(
        "/artifact-links/batch-move",
        input
      ),
    // `movedArtifacts` is the receipt this path used to ignore (ISS-9578
    // review). A move re-parents links whose endpoints are not in the request,
    // so the link views cannot be narrowed to the moved ids.
    onSuccess: ({ movedArtifacts }) => {
      const receipt = bulkReceiptFromCommittedIds(
        movedArtifacts.map((artifact) => artifact.id)
      );
      for (const client of [queryClient, ...(extraQueryClients ?? [])]) {
        invalidateForBulkArtifactMutation(client, receipt, {
          allLinkViews: true,
        });
      }
    },
  });
}
