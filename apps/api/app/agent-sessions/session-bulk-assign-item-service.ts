import {
  BatchItemFailureCode,
  type BatchItemResult,
  batchItemApplied,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import { Result, Status } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";
import {
  type BulkAssignChange,
  type BulkAssignSessionsInput,
  bulkAssignWhere,
  type RecordBulkAssignReceipt,
  sessionWriteService,
} from "./session-write-service";

/**
 * Per-item results for `POST /agent-sessions/bulk-assign/v2` (ISS-9464).
 *
 * Bulk-assign stays ALL-OR-NOTHING (ISS-8649). The write is the one v1 commits,
 * unchanged (`commitBulkAssignment`), without the assigned-row read v1 answers
 * with: v2 never uses those rows, and that read failing after the commit would
 * report an applied write as a 500. The write refuses a set containing any id it
 * cannot write and rolls the whole transaction back. It cannot say WHICH id was
 * bad, because it only sees a row-count shortfall, so on that refusal, and only
 * once it has returned, this reads which requested ids the write predicate could
 * reach. Those were refused because a sibling failed; the rest were not found.
 * The read labels results and writes nothing.
 *
 * Both halves of that depend on this being reached with NO ambient transaction
 * open (ISS-10993). `withDb.tx` joins one rather than nesting, so a caller
 * holding its own would leave the refusal's rollback unperformed and would put
 * the labelling read on the same transaction as the partial write it is
 * labelling. The activity receipt therefore arrives as a callback the write
 * runs on its own transaction, never as a transaction wrapped around this
 * call.
 */
export const sessionBulkAssignItemService = {
  async bulkAssign(
    input: BulkAssignSessionsInput,
    recordReceipt?: RecordBulkAssignReceipt
  ): Promise<Result<BulkAssignPerItemResult>> {
    const ids = [...new Set(input.sessionIds)];
    const outcome = await sessionWriteService.commitBulkAssignment(
      input,
      recordReceipt
    );
    if (outcome.ok) {
      return Result.ok({
        results: resultsFor(ids, batchItemApplied),
        changes: outcome.value.changes,
      });
    }
    // Only the per-id refusal is item-shaped. A target project or owner outside
    // the org fails every item the same way, so it stays an envelope error.
    if (outcome.error !== Status.NotFound) {
      return Result.err(outcome.error);
    }

    const reachableIds = await readReachableSessionIds(input, ids);
    return Result.ok({
      results: resultsFor(ids, (id) =>
        reachableIds.has(id)
          ? batchItemFailed(id, BatchItemFailureCode.BatchRefused)
          : batchItemFailed(id, BatchItemFailureCode.ArtifactsNotFound)
      ),
      // Nothing was written, so there is nothing to receipt. Not an empty
      // "we could not tell" — the write is all-or-nothing and it refused.
      changes: [],
    });
  },
};

/**
 * `bulkAssign`'s answer: the per-item results the route serializes, plus the
 * transitions it feeds to the receipt and the ledger and never puts on the wire
 * (ISS-9465). Empty on a refusal, because a refused batch wrote no row.
 */
export type BulkAssignPerItemResult = {
  results: Map<string, BatchItemResult>;
  changes: BulkAssignChange[];
};

/**
 * The requested ids the refused write's predicate could reach, read with the
 * write's own predicate (`bulkAssignWhere`). Both fields write the SESSION
 * artifact row: the project, and the Owner as its assignee (ISS-12251 D-1).
 */
async function readReachableSessionIds(
  input: BulkAssignSessionsInput,
  ids: string[]
): Promise<Set<string>> {
  const rows = await withDb((db) =>
    db.artifact.findMany({
      where: bulkAssignWhere(input.organizationId, ids),
      select: { id: true },
    })
  );
  return new Set(rows.map((row) => row.id));
}

function resultsFor(
  ids: readonly string[],
  decide: (id: string) => BatchItemResult
): Map<string, BatchItemResult> {
  const results = new Map<string, BatchItemResult>();
  for (const id of ids) {
    results.set(id, decide(id));
  }
  return results;
}
