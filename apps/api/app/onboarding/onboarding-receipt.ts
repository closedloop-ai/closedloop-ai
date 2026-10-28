import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { OperationReceiptRecorder } from "@/lib/operation-receipts/operation-receipt-recorder";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";

/** What an onboarding write did, for its receipt. */
export type OnboardingWrite = { changed: boolean };

/**
 * ISS-12552: onboarding progress is the caller's own setting, so
 * its receipt is a settings write with no artifact target. A write that moved
 * nothing, such as a redelivered guided transition, is a no-op.
 */
export function onboardingReceiptWrite(
  written: OnboardingWrite
): OperationReceiptWrite {
  return {
    operationKind: OperationKind.SettingsWrite,
    outcome: written.changed
      ? OperationReceiptOutcome.Committed
      : OperationReceiptOutcome.NoOp,
  };
}

/**
 * ISS-12552: the record an onboarding write takes, or undefined when the
 * request records nothing, so the write keeps its pre-receipt shape.
 */
export function recordOnboardingWrite(
  receipts: OperationReceiptRecorder
): RecordWriteInTransaction<OnboardingWrite> | undefined {
  return receipts.whenRecording<OnboardingWrite>((tx, written) =>
    receipts.record(tx, onboardingReceiptWrite(written))
  );
}
