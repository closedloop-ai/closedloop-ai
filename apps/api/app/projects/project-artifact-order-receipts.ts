import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import {
  ProjectArtifactPlacementKind,
  type ProjectArtifactPlacementRequest,
  type ProjectArtifactPlacementResponse,
} from "@repo/api/src/types/project-artifact-placement";
import {
  ProjectHierarchyOperation,
  type ProjectHierarchyTransactionRequest,
} from "@repo/api/src/types/project-hierarchy-transaction";
import type { TransactionClient } from "@repo/database";
import type { BulkRankWrite } from "@/app/documents/artifact-bulk-rank-service";
import type { OperationReceiptRecorder } from "@/lib/operation-receipts/operation-receipt-recorder";

/**
 * What a committed placement, hierarchy transaction or placement recovery
 * wrote: the artifacts it moved, and the artifacts the caller asked to move.
 */
export type PlacementWrite = {
  movedArtifactIds: readonly string[];
  requestedArtifactIds: readonly string[];
};

/**
 * ISS-12552: one move receipt per root a bulk rank rewrote, on
 * the rank's own transaction. A root already at its slot did not change, so
 * its receipt is a no-op, as `POST /projects/[id]/artifacts/move` records it.
 */
export async function recordBulkRankReceipts(
  tx: TransactionClient,
  receipts: OperationReceiptRecorder,
  written: BulkRankWrite
): Promise<void> {
  for (const ranked of written.rankedArtifacts) {
    await receipts.record(
      tx,
      ranked.sortOrderChanged
        ? {
            operationKind: OperationKind.Move,
            outcome: OperationReceiptOutcome.Committed,
            targetArtifactId: ranked.artifactId,
            changedFields: ["sortOrder"],
          }
        : {
            operationKind: OperationKind.Move,
            outcome: OperationReceiptOutcome.NoOp,
            targetArtifactId: ranked.artifactId,
          }
    );
  }
}

/**
 * ISS-12552: one move receipt per artifact a placement moved, on the
 * placement's own transaction. A placement that moved nothing records a no-op
 * for each artifact the caller asked to move.
 */
export async function recordPlacementReceipts(
  tx: TransactionClient,
  receipts: OperationReceiptRecorder,
  written: PlacementWrite
): Promise<void> {
  const moved = written.movedArtifactIds.length > 0;
  const targets = moved
    ? written.movedArtifactIds
    : written.requestedArtifactIds;
  for (const artifactId of targets) {
    await receipts.record(tx, {
      operationKind: OperationKind.Move,
      outcome: moved
        ? OperationReceiptOutcome.Committed
        : OperationReceiptOutcome.NoOp,
      targetArtifactId: artifactId,
    });
  }
}

/**
 * What `POST /projects/[id]/artifacts/placement` wrote. An undo names no
 * artifacts in its request, so a no-op undo records nothing.
 */
export function placementWrite(
  placed: ProjectArtifactPlacementResponse,
  input: ProjectArtifactPlacementRequest
): PlacementWrite {
  return {
    movedArtifactIds: placed.affectedArtifactIds,
    requestedArtifactIds:
      input.kind === ProjectArtifactPlacementKind.Place
        ? input.sourceArtifactIds
        : [],
  };
}

/** What `POST /projects/[id]/artifacts/hierarchy-transactions` wrote. */
export function hierarchyPlacementWrite(
  placed: ProjectArtifactPlacementResponse,
  input: ProjectHierarchyTransactionRequest
): PlacementWrite {
  return {
    movedArtifactIds: placed.affectedArtifactIds,
    requestedArtifactIds:
      input.operation === ProjectHierarchyOperation.Move
        ? input.artifactIds
        : [],
  };
}
