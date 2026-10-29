import { ArtifactBulkKind } from "@repo/api/src/types/artifact-bulk-action";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { BATCH_MUTATION_ENTITY_LIMIT } from "@repo/api/src/types/batch-mutation-limits";
import {
  BatchItemFailureCode,
  type BatchItemResult,
  type BatchMutationResponse,
  batchItemApplied,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
import { isPriority } from "@repo/api/src/types/priority-contract";
import type {
  ArtifactBulkExecution,
  ArtifactBulkRow,
} from "@repo/app/shared/bulk-actions/registry";

/** Dispatch each applicable priority row through its existing kind-owned API path. */
export async function executeProjectSelectionPriority(
  rows: readonly ArtifactBulkRow[],
  value: string | boolean | null,
  api: {
    post: (path: string, body: unknown) => Promise<BatchMutationResponse>;
    patch: (path: string, body: unknown) => Promise<unknown>;
  }
): Promise<ArtifactBulkExecution> {
  if (rows.length === 0 || rows.length > BATCH_MUTATION_ENTITY_LIMIT) {
    throw new RangeError("Bulk priority selection is outside the entity limit");
  }
  if (!isPriority(value)) {
    throw new TypeError("Bulk priority requires a priority");
  }
  const documentIds = rows
    .filter(
      (row) =>
        row.kind === ArtifactBulkKind.Document ||
        row.kind === ArtifactBulkKind.Issue
    )
    .map((row) => row.id);
  const patchRows = rows.filter(
    (row) =>
      row.kind === ArtifactBulkKind.Session ||
      row.kind === ArtifactBulkKind.Branch
  );
  if (documentIds.length + patchRows.length !== rows.length) {
    throw new TypeError("Bulk priority received an unsupported row kind");
  }
  let transactionId: string | undefined;
  const documentResults = documentIds.length
    ? api
        .post(`${BatchMutationRoute.DocumentsUpdatePriority}/v2`, {
          documentIds,
          priority: value,
          surface: ArtifactStatusEditSurface.Bulk,
        })
        .then((response) => {
          transactionId = response.transactionId;
          const byId = new Map(
            response.results.map((result) => [result.id, result])
          );
          return documentIds.map(
            (id) =>
              byId.get(id) ??
              batchItemFailed(id, BatchItemFailureCode.OutcomeUnknown)
          );
        })
        .catch(() =>
          documentIds.map((id) =>
            batchItemFailed(id, BatchItemFailureCode.OutcomeUnknown)
          )
        )
    : Promise.resolve<BatchItemResult[]>([]);
  const patchResults = patchRows.map(async (row) => {
    const path =
      row.kind === ArtifactBulkKind.Session
        ? `/agent-sessions/${encodeURIComponent(row.id)}`
        : `/branches/${encodeURIComponent(row.id)}`;
    try {
      await api.patch(path, {
        priority: value,
        surface: ArtifactStatusEditSurface.Bulk,
      });
      return batchItemApplied(row.id);
    } catch {
      return batchItemFailed(row.id, BatchItemFailureCode.OutcomeUnknown);
    }
  });
  const [documents, ...patches] = await Promise.all([
    documentResults,
    ...patchResults,
  ]);
  const byId = new Map(
    [...documents, ...patches].map((result) => [result.id, result])
  );
  return {
    results: rows.map(
      (row) =>
        byId.get(row.id) ??
        batchItemFailed(row.id, BatchItemFailureCode.OutcomeUnknown)
    ),
    transactionIds: transactionId ? [transactionId] : [],
  };
}
