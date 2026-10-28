import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { OperationReceiptRecorder } from "@/lib/operation-receipts/operation-receipt-recorder";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import type { FavoriteBatchWrite } from "./favorites-batch-service";
import type { FavoriteWrite } from "./favorites-service";

/**
 * ISS-12552: a favorite is the caller's own setting on an
 * artifact. Re-adding a favorite or removing one that is not there changes
 * nothing, so it is a no-op.
 */
export function favoriteReceiptWrite(
  artifactId: string,
  written: Pick<FavoriteWrite, "changed">
): OperationReceiptWrite {
  return {
    operationKind: OperationKind.SettingsWrite,
    outcome: written.changed
      ? OperationReceiptOutcome.Committed
      : OperationReceiptOutcome.NoOp,
    targetArtifactId: artifactId,
  };
}

/**
 * ISS-12552: one favorite receipt per artifact a batch found, on the batch's
 * own transaction; undefined for a request that gets no receipt, so the batch
 * skips the read that tells a change from a no-op.
 */
export function favoriteBatchReceiptRecorder(
  receipts: OperationReceiptRecorder
): RecordWriteInTransaction<FavoriteBatchWrite> | undefined {
  return receipts.whenRecording<FavoriteBatchWrite>(async (tx, written) => {
    const changed = new Set(written.changedIds);
    for (const artifactId of written.artifactIds) {
      await receipts.record(
        tx,
        favoriteReceiptWrite(artifactId, { changed: changed.has(artifactId) })
      );
    }
  });
}
