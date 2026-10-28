import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { OperationReceiptRecorder } from "@/lib/operation-receipts/operation-receipt-recorder";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import type { SessionMeshWrite } from "./service";

/**
 * ISS-12552: a Session Mesh message, presence, delivery state,
 * subscription or feedback names no artifact. A replayed publish or feedback
 * key, or an acknowledgement or disposition that matched no open delivery,
 * changes nothing and is a no-op.
 *
 * Routes wrap `withOperationReceipts` INSIDE `withSessionMeshAuth`, so a
 * request its budget or rollout flag refuses never reaches the recorder and
 * records nothing.
 */
export function sessionMeshReceiptWrite(
  written: SessionMeshWrite
): OperationReceiptWrite {
  return {
    operationKind: OperationKind.SessionMeshWrite,
    outcome: written.changed
      ? OperationReceiptOutcome.Committed
      : OperationReceiptOutcome.NoOp,
  };
}

/**
 * The service callback that records a mesh write's receipt in its transaction,
 * or undefined when the request records nothing, so the service runs its
 * write as it did before receipts.
 */
export function recordSessionMeshWrite(
  receipts: OperationReceiptRecorder
): RecordWriteInTransaction<SessionMeshWrite> | undefined {
  return receipts.whenRecording((tx, written: SessionMeshWrite) =>
    receipts.record(tx, sessionMeshReceiptWrite(written))
  );
}
