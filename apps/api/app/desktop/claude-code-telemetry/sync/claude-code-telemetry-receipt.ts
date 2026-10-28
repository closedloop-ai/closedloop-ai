import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { DesktopClaudeCodeTelemetrySyncResponse } from "@repo/api/src/types/desktop-claude-code-telemetry-sync";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";

/**
 * ISS-12552: one telemetry receipt per delivery, recorded in
 * the delivery's transaction. A delivery whose session is not synced yet and
 * that carried no usable drop counter stored nothing, so it is a no-op.
 */
export function claudeCodeTelemetryReceiptWrite(
  written: DesktopClaudeCodeTelemetrySyncResponse
): OperationReceiptWrite {
  const wroteSession =
    written.accepted && written.externalSessionId !== undefined;
  const wroteCounters = (written.dropCountersRecorded ?? 0) > 0;
  return {
    operationKind: OperationKind.Telemetry,
    outcome:
      wroteSession || wroteCounters
        ? OperationReceiptOutcome.Committed
        : OperationReceiptOutcome.NoOp,
  };
}
