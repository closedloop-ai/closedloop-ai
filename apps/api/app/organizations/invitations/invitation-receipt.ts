import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { InviteMembersResponse } from "@repo/api/src/types/onboarding";
import type { OperationReceiptRecorder } from "@/lib/operation-receipts/operation-receipt-recorder";

/**
 * ISS-12552: the invitations are minted in Clerk, outside any
 * transaction of ours, so the receipt is recorded after the sends in its own
 * short transaction and fails open. A
 * batch that invited nobody wrote nothing, so it records none.
 */
export async function recordInvitationReceipt(
  response: InviteMembersResponse,
  receipts: OperationReceiptRecorder
): Promise<void> {
  if (response.invited > 0) {
    await receipts.recordStandalone({
      operationKind: OperationKind.OrganizationWrite,
      outcome: OperationReceiptOutcome.Committed,
    });
  }
}
