import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import type { FavoriteWrite } from "@/app/artifacts/favorites-service";
import type { OperationReceiptWrite } from "@/lib/operation-receipts/operation-receipt-writer";

/**
 * ISS-12552: deleting a project is a committed project write. A
 * project is not an artifact, so the receipt names no target.
 */
export function projectDeleteReceiptWrite(): OperationReceiptWrite {
  return {
    operationKind: OperationKind.ProjectWrite,
    outcome: OperationReceiptOutcome.Committed,
  };
}

/**
 * ISS-12552: a project favorite is the caller's own setting. Re-adding a
 * favorite or removing one that is not there changes nothing, so it is a
 * no-op. A project is not an artifact, so the receipt names no target.
 */
export function projectFavoriteReceiptWrite(
  written: FavoriteWrite
): OperationReceiptWrite {
  return {
    operationKind: OperationKind.SettingsWrite,
    outcome: written.changed
      ? OperationReceiptOutcome.Committed
      : OperationReceiptOutcome.NoOp,
  };
}
