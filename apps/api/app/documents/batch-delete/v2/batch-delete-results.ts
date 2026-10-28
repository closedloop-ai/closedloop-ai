import {
  BatchItemFailureCode,
  type BatchItemResult,
  batchItemApplied,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";

/**
 * v1's `{ deletedIds, failedIds }` as one result per id v1 ACCOUNTED FOR.
 *
 * Deliberately not `batchResultsByFound`: that derives the failures from the
 * requested set, which would relabel an id v1 answered for neither way as
 * `artifacts_not_found` — a confident wrong answer. Keying only what v1
 * returned leaves `orderBatchResults` free to report such an id
 * `outcome_unknown` and log the service bug behind it (ISS-9464).
 */
export function batchDeleteResultsById(
  deletedIds: readonly string[],
  failedIds: readonly string[]
): Map<string, BatchItemResult> {
  const results = new Map<string, BatchItemResult>();
  for (const id of deletedIds) {
    results.set(id, batchItemApplied(id));
  }
  for (const id of failedIds) {
    results.set(
      id,
      batchItemFailed(id, BatchItemFailureCode.ArtifactsNotFound)
    );
  }
  return results;
}
