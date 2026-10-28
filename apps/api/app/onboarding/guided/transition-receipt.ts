import type { OperationReceiptRecorder } from "@/lib/operation-receipts/operation-receipt-recorder";
import { onboardingReceiptWrite } from "../onboarding-receipt";
import {
  type GuidedTransitionAcceptance,
  GuidedTransitionOutcome,
} from "./transition-service";

/**
 * ISS-12552: a redelivered command moved nothing, so it records
 * a no-op receipt in its own short transaction. An accepted transition already
 * recorded its receipt inside the write's transaction.
 */
export async function recordReplayedTransitionReceipt(
  acceptance: GuidedTransitionAcceptance,
  receipts: OperationReceiptRecorder
): Promise<void> {
  if (acceptance.outcome === GuidedTransitionOutcome.Replayed) {
    await receipts.recordStandalone(onboardingReceiptWrite({ changed: false }));
  }
}
