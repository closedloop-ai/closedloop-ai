import {
  ProjectArtifactPlacementErrorReason,
  type ProjectArtifactPlacementVerificationResponse,
  ProjectArtifactPlacementVerificationStatus,
} from "@repo/api/src/types/project-artifact-placement";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { Prisma, type TransactionClient, withDb } from "@repo/database";
import { lockProjectRank } from "@/app/documents/document-sort-order";
import { staleVersionDetail } from "@/app/documents/project-artifact-placement-helpers";
import { readPlacementReceipt } from "@/app/documents/project-artifact-placement-receipt";
import {
  type PlacementError,
  recoverProjectArtifactPlacementSnapshotInTransaction,
} from "@/app/documents/project-artifact-placement-service";
import type { PlacementActor } from "@/app/documents/project-artifact-placement-service-support";
import {
  authorizePlacementDomain,
  type PlacementReceiptSnapshot,
  readAllKindsPlacementState,
  snapshotRows,
} from "@/app/documents/project-artifact-placement-service-support";
import type { PlacementWrite } from "@/app/projects/project-artifact-order-receipts";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";

type VerificationInput = {
  routeProjectId: string;
  organizationId: string;
  transactionId: string;
  actor: PlacementActor;
};

type PlacementVerificationReceipt = {
  affectedProjectIds: string[];
  afterState: PlacementReceiptSnapshot;
  sourceArtifactIds: string[];
  transactionId: string;
};

/** Compare a durable placement receipt with the current canonical hierarchy. */
function verifyProjectArtifactPlacement(
  input: VerificationInput
): Promise<
  Result<ProjectArtifactPlacementVerificationResponse, PlacementError>
> {
  return withDb.tx((tx) => verifyInTransaction(tx, input, false), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  });
}

/** Restore the receipt's known-good after-state behind a stale-view fence. */
function recoverProjectArtifactPlacement(
  input: VerificationInput & {
    expectedProjectVersions: Record<string, string>;
  },
  recordRecovered?: RecordWriteInTransaction<PlacementWrite>
): Promise<
  Result<ProjectArtifactPlacementVerificationResponse, PlacementError>
> {
  return withDb.tx(async (tx) => {
    const receiptResult = await readReceipt(tx, input);
    if (!receiptResult.ok) {
      return receiptResult;
    }
    const receipt = receiptResult.value;
    for (const projectId of receipt.affectedProjectIds) {
      await lockProjectRank(tx, projectId);
    }
    const authorization = await authorizePlacementDomain(
      tx,
      input.organizationId,
      receipt.affectedProjectIds,
      input.actor,
      true
    );
    if (!authorization.authorized) {
      return verificationFailure(
        Status.NotFound,
        "Placement receipt not found",
        ProjectArtifactPlacementErrorReason.PermissionDenied
      );
    }
    const current = await readAllKindsPlacementState(
      tx,
      input.organizationId,
      receipt.affectedProjectIds
    );
    const stale = staleVersionDetail(
      receipt.affectedProjectIds,
      input.expectedProjectVersions,
      current.projectVersions
    );
    if (stale) {
      return Result.err({
        status: Status.Conflict,
        message: "Project hierarchy changed since it was read",
        detail: stale,
      });
    }
    const driftedArtifactIds = findDriftedArtifactIds(
      receipt.afterState,
      current
    );
    if (driftedArtifactIds.length === 0) {
      await recordRecovered?.(tx, {
        movedArtifactIds: [],
        requestedArtifactIds: receipt.sourceArtifactIds,
      });
      return Result.ok(
        verificationResponse(receipt, current.projectVersions, [], true)
      );
    }
    const recovered =
      await recoverProjectArtifactPlacementSnapshotInTransaction(tx, {
        organizationId: input.organizationId,
        actor: input.actor,
        transactionId: input.transactionId,
        affectedProjectIds: receipt.affectedProjectIds,
        sourceArtifactIds: receipt.sourceArtifactIds,
        snapshot: receipt.afterState,
        current,
      });
    if (!recovered.ok) {
      return recovered;
    }
    await recordRecovered?.(tx, {
      movedArtifactIds: driftedArtifactIds,
      requestedArtifactIds: receipt.sourceArtifactIds,
    });
    return Result.ok(verificationResponse(receipt, recovered.value, [], true));
  });
}

async function verifyInTransaction(
  tx: TransactionClient,
  input: VerificationInput,
  requireWrite: boolean
): Promise<
  Result<ProjectArtifactPlacementVerificationResponse, PlacementError>
> {
  const receiptResult = await readReceipt(tx, input);
  if (!receiptResult.ok) {
    return receiptResult;
  }
  const receipt = receiptResult.value;
  const authorization = await authorizePlacementDomain(
    tx,
    input.organizationId,
    receipt.affectedProjectIds,
    input.actor,
    requireWrite
  );
  if (!authorization.authorized) {
    return verificationFailure(
      Status.NotFound,
      "Placement receipt not found",
      ProjectArtifactPlacementErrorReason.PermissionDenied
    );
  }
  const current = await readAllKindsPlacementState(
    tx,
    input.organizationId,
    receipt.affectedProjectIds
  );
  return Result.ok(
    verificationResponse(
      receipt,
      current.projectVersions,
      findDriftedArtifactIds(receipt.afterState, current),
      authorization.canWrite
    )
  );
}

async function readReceipt(
  tx: TransactionClient,
  input: VerificationInput
): Promise<Result<PlacementVerificationReceipt, PlacementError>> {
  const event = await readPlacementReceipt(tx, input.organizationId, {
    transactionId: input.transactionId,
  });
  if (!event || event.routeProjectId !== input.routeProjectId) {
    return verificationFailure(
      Status.NotFound,
      "Placement receipt not found",
      ProjectArtifactPlacementErrorReason.ArtifactNotFound
    );
  }
  return Result.ok({
    affectedProjectIds: [...event.affectedProjectIds].sort(),
    afterState: event.afterState,
    sourceArtifactIds: event.sourceArtifactIds,
    transactionId: input.transactionId,
  });
}

function findDriftedArtifactIds(
  expected: PlacementReceiptSnapshot,
  current: Awaited<ReturnType<typeof readAllKindsPlacementState>>
): string[] {
  const expectedById = new Map(
    expected.rankRows.map((row) => [row.artifactId, row])
  );
  const actualById = new Map(
    snapshotRows(new Set(expectedById.keys()), current).map((row) => [
      row.artifactId,
      row,
    ])
  );
  return [...expectedById.keys()].filter((artifactId) => {
    const expectedRow = expectedById.get(artifactId);
    const actualRow = actualById.get(artifactId);
    return !(
      expectedRow &&
      actualRow &&
      expectedRow.projectId === actualRow.projectId &&
      expectedRow.parentId === actualRow.parentId &&
      expectedRow.sortOrder === actualRow.sortOrder
    );
  });
}

function verificationResponse(
  receipt: {
    affectedProjectIds: string[];
    transactionId: string;
  },
  projectVersions: Record<string, string>,
  driftedArtifactIds: string[],
  canRecover: boolean
): ProjectArtifactPlacementVerificationResponse {
  return {
    transactionId: receipt.transactionId,
    status:
      driftedArtifactIds.length === 0
        ? ProjectArtifactPlacementVerificationStatus.Consistent
        : ProjectArtifactPlacementVerificationStatus.Drifted,
    affectedProjectIds: receipt.affectedProjectIds,
    projectVersions,
    driftedArtifactIds,
    canRecover,
  };
}

function verificationFailure<T>(
  status: StatusCode,
  message: string,
  reason: ProjectArtifactPlacementErrorReason
): Result<T, PlacementError> {
  return Result.err<T, PlacementError>({
    status,
    message,
    detail: { reason },
  });
}

export const projectArtifactPlacementVerificationService = {
  verifyProjectArtifactPlacement,
  recoverProjectArtifactPlacement,
};
