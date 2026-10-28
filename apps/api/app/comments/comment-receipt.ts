import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { OperationReceiptRecorder } from "@/lib/operation-receipts/operation-receipt-recorder";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import type { CommentWritten } from "./service/comment-command-pipeline";
import type { CommentThreadResolution } from "./service/thread-resolution";

/**
 * ISS-12552: a comment write's receipt names the artifact the
 * comment is on and the comment it made or acted on. A write that stored
 * nothing, such as a replayed client id or a repeated reaction or resolve, is
 * a no-op.
 */
export function commentReceiptWrite(
  operationKind: OperationKind,
  written: CommentWritten
): OperationReceiptWrite {
  return {
    operationKind,
    outcome: written.changed
      ? OperationReceiptOutcome.Committed
      : OperationReceiptOutcome.NoOp,
    targetArtifactId: written.target.artifactId,
    ...(written.commentId ? { commentId: written.commentId } : {}),
  };
}

/**
 * Records {@link commentReceiptWrite} on the comment write's own transaction,
 * or undefined when the request records nothing, so the comment service runs
 * its write with no record, as on main (ISS-12552 flag-off parity).
 */
export function recordCommentReceipt(
  receipts: OperationReceiptRecorder,
  operationKind: OperationKind
): RecordWriteInTransaction<CommentWritten> | undefined {
  return receipts.whenRecording<CommentWritten>((tx, written) =>
    receipts.record(tx, commentReceiptWrite(operationKind, written))
  );
}

/**
 * ISS-12552: resolving or reopening a document thread is a
 * comment write on the document. A thread already in that state changes
 * nothing, so it is a no-op. A thread with no local row yet still changed in
 * Liveblocks, so it is committed.
 */
export function threadResolutionReceiptWrite(
  artifactId: string,
  resolution: CommentThreadResolution | null
): OperationReceiptWrite {
  return {
    operationKind: OperationKind.Comment,
    outcome:
      resolution?.kind === "noop"
        ? OperationReceiptOutcome.NoOp
        : OperationReceiptOutcome.Committed,
    targetArtifactId: artifactId,
  };
}
