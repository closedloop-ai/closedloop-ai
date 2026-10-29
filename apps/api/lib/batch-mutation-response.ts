import { SpanErrorSource } from "@closedloop-ai/telemetry-contract/span";
import {
  BatchItemFailureCode,
  type BatchItemResult,
  type BatchMutationResponse,
  batchItemApplied,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import type { ApiResult } from "@repo/api/src/types/common";
import { log } from "@repo/observability/log";
import type { NextResponse } from "next/server";
import { recordRequestErrorCause } from "@/lib/observability/request-span-attribution";
import { scheduleLogFlush, successResponse } from "@/lib/route-utils";

/** Ids quoted in the server-error log; the count carries the full size. */
const MISSING_RESULT_ID_SAMPLE_SIZE = 10;

/**
 * The 200 envelope every `/v2` batch mutation route answers with (ISS-9464).
 *
 * `transactionId` names the commit this response describes, and is the id every
 * activity row and audit entry the same request wrote also carries (ISS-9465).
 * OMITTED, never serialized as `null`, when the caller has none — that is what
 * lets a client on an older build read the body unchanged.
 */
export function batchMutationResponse(
  results: BatchItemResult[],
  transactionId?: string
): NextResponse<ApiResult<BatchMutationResponse>> {
  return successResponse<BatchMutationResponse>({
    results,
    ...(transactionId === undefined ? {} : { transactionId }),
  });
}

/**
 * One result per DISTINCT requested id, in the order the caller first named it.
 *
 * Services decide items under a lock taken in id order, which is not the order
 * the caller sent; re-keying by id here keeps that ordering off the wire.
 *
 * An id with no result is a service bug, and it surfaces only after the batch
 * has committed. Throwing would turn it into a 500 envelope that hides the
 * items that did land, so a retry re-applies them blind. Instead that id is
 * reported `outcome_unknown` and the bug is recorded as a server error.
 */
export function orderBatchResults(
  requestedIds: readonly string[],
  resultsById: ReadonlyMap<string, BatchItemResult>
): BatchItemResult[] {
  const ordered: BatchItemResult[] = [];
  const missingIds: string[] = [];
  for (const id of new Set(requestedIds)) {
    const result = resultsById.get(id);
    if (result) {
      ordered.push(result);
    } else {
      missingIds.push(id);
      ordered.push(batchItemFailed(id, BatchItemFailureCode.OutcomeUnknown));
    }
  }
  if (missingIds.length > 0) {
    reportMissingBatchResults(missingIds);
  }
  return ordered;
}

function reportMissingBatchResults(missingIds: readonly string[]): void {
  const error = new Error(
    "Batch mutation produced no result for one or more requested ids"
  );
  log.error(error.message, {
    error,
    missingIdCount: missingIds.length,
    missingIdSample: missingIds.slice(0, MISSING_RESULT_ID_SAMPLE_SIZE),
  });
  recordRequestErrorCause(error, SpanErrorSource.RouteHandler);
  scheduleLogFlush();
}

/**
 * One result per requested id: applied for an id the service's own read
 * reached, `artifacts_not_found` for one it did not.
 *
 * This is the home for the PLAIN split, so the batches that need only that
 * cannot spell `artifacts_not_found` differently (ISS-9464). A batch whose
 * per-item failures layer on top of it — an invalid status for the subtype, a
 * stale precondition — classifies inline instead, and `batch-delete/v2` opts
 * out for a third reason it records itself. Those are not drift.
 */
export function batchResultsByFound(
  requestedIds: readonly string[],
  foundIds: ReadonlySet<string>,
  normalizeId: (id: string) => string = (id) => id
): Map<string, BatchItemResult> {
  const results = new Map<string, BatchItemResult>();
  const normalizedFoundIds = new Set([...foundIds].map(normalizeId));
  for (const id of requestedIds) {
    results.set(
      id,
      normalizedFoundIds.has(normalizeId(id))
        ? batchItemApplied(id)
        : batchItemFailed(id, BatchItemFailureCode.ArtifactsNotFound)
    );
  }
  return results;
}
