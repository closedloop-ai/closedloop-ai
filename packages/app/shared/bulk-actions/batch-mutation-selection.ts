import {
  BATCH_ITEM_APPLIED_STATUS,
  BatchItemFailureCode,
  type BatchItemResult,
} from "@repo/api/src/types/batch-mutation-result";

export type BatchMutationSelectionOutcome = {
  appliedIds: string[];
  failedIds: string[];
  failureCode: BatchItemFailureCode | null;
};

/** Reconcile one per-item batch response against the selection that initiated it. */
export function batchMutationSelectionOutcome(
  results: readonly BatchItemResult[],
  selectedIds: readonly string[]
): BatchMutationSelectionOutcome {
  const byId = new Map(results.map((result) => [result.id, result]));
  const appliedIds = selectedIds.filter(
    (id) => byId.get(id)?.status === BATCH_ITEM_APPLIED_STATUS
  );
  const failedIds = selectedIds.filter(
    (id) => byId.get(id)?.status !== BATCH_ITEM_APPLIED_STATUS
  );
  const firstFailure = byId.get(failedIds[0] ?? "");
  let failureCode: BatchItemFailureCode | null = null;
  if (firstFailure && "code" in firstFailure) {
    failureCode = firstFailure.code;
  } else if (failedIds.length > 0) {
    failureCode = BatchItemFailureCode.OutcomeUnknown;
  }
  return { appliedIds, failedIds, failureCode };
}
