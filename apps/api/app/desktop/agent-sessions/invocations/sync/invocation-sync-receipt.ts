import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { IngestAgentComponentInvocationPartResult } from "@/app/agent-sessions/service/component-invocations";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";

/**
 * ISS-12552: one Desktop sync receipt per invocation part,
 * recorded in the part's ingest transaction. A part the ingest refused stored
 * none of its own data, so it is a no-op; an accepted part is committed.
 */
export function invocationSyncReceiptWrite(
  ingested: IngestAgentComponentInvocationPartResult
): OperationReceiptWrite {
  return {
    operationKind: OperationKind.DesktopSync,
    outcome: ingested.ok
      ? OperationReceiptOutcome.Committed
      : OperationReceiptOutcome.NoOp,
  };
}
