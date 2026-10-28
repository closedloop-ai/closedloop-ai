import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";

/**
 * ISS-12552: a provisioning attempt is the caller's own
 * onboarding state, so it records a settings receipt in the transaction that
 * stores the attempt. Every request mints a new attempt, so it always commits.
 */
export function provisioningAttemptReceiptWrite(): OperationReceiptWrite {
  return {
    operationKind: OperationKind.SettingsWrite,
    outcome: OperationReceiptOutcome.Committed,
  };
}
