import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document";
import type { DocumentStatusTransition } from "@repo/api/src/types/document-status-mutation";
import {
  ProjectArtifactPlacementKind,
  type ProjectArtifactPlacementRequest,
  type ProjectArtifactPlacementResponse,
} from "@repo/api/src/types/project-artifact-placement";
import { Result } from "@repo/api/src/types/result";
import { type TransactionClient, withDb } from "@repo/database";
import { z } from "zod";
import { resolveProjectArtifactLanePolicy } from "@/app/artifacts/project-artifact-lane-policy";
import {
  applyPreparedProjectArtifactPlacementLaneWrite,
  type PreparedPlacementLaneWrite,
  preparedLaneStatusTransitions,
  prepareProjectArtifactPlacementLaneWrite,
} from "@/app/artifacts/project-artifact-placement-lane-write";
import { emitBatchStatusSideEffects } from "@/app/documents/batch-status-side-effects";
import {
  applyProjectArtifactPlacementInTransaction,
  type PlacementError,
} from "@/app/documents/project-artifact-placement-service";
import {
  type PlacementActor,
  readAllKindsPlacementState,
} from "@/app/documents/project-artifact-placement-service-support";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";

/**
 * Run the PRD-725 placement step and the board's lane field write in one
 * transaction. A Place request's lane patch is validated through the
 * placement validator, before the placement owner writes anything. An Undo's
 * lane restore can only be checked after the hierarchy is restored, so a
 * refusal there throws to roll the whole transaction back.
 */
export async function placeProjectArtifactsWithLanePatch(
  routeProjectId: string,
  organizationId: string,
  input: ProjectArtifactPlacementRequest,
  actor: PlacementActor,
  options: {
    recordPlaced?: RecordWriteInTransaction<ProjectArtifactPlacementResponse>;
  } = {}
): Promise<Result<ProjectArtifactPlacementResponse, PlacementError>> {
  let committed: CommittedPlacement;
  try {
    committed = await withDb.tx((tx) =>
      placeInTransaction(
        tx,
        routeProjectId,
        organizationId,
        input,
        actor,
        options.recordPlaced
      )
    );
  } catch (error) {
    if (error instanceof LaneWriteRollback) {
      return Result.err(error.placementError);
    }
    throw error;
  }
  if (committed.result.ok) {
    await emitLaneStatusSideEffects({
      actor,
      input,
      organizationId,
      transactionId: committed.result.value.transactionId,
      transitions: committed.statusTransitions,
    });
  }
  return committed.result;
}

type CommittedPlacement = {
  result: Result<ProjectArtifactPlacementResponse, PlacementError>;
  statusTransitions: DocumentStatusTransition[];
};

async function placeInTransaction(
  tx: TransactionClient,
  routeProjectId: string,
  organizationId: string,
  input: ProjectArtifactPlacementRequest,
  actor: PlacementActor,
  recordPlaced:
    | RecordWriteInTransaction<ProjectArtifactPlacementResponse>
    | undefined
): Promise<CommittedPlacement> {
  let prepared: PreparedPlacementLaneWrite = { kind: "none" };
  const result = await applyProjectArtifactPlacementInTransaction(tx, {
    actor,
    fieldRevisions: false,
    includeAllTypes: true,
    input,
    organizationId,
    routeProjectId,
    validatePlacement: async (context) => {
      if (!context.input.lanePatch) {
        return null;
      }
      const laneWrite = await prepareLaneWrite(tx, {
        actor,
        affectedProjectIds: context.affectedProjectIds,
        destinationProjectId: context.input.destinationProjectId,
        organizationId,
        placement: context.input,
        sourceArtifactIds: context.sourceArtifactIds,
      });
      if (!laneWrite.ok) {
        return laneWrite.error;
      }
      prepared = laneWrite.value;
      return null;
    },
  });
  if (!result.ok || result.value.replayed) {
    return { result, statusTransitions: [] };
  }
  if (input.kind === ProjectArtifactPlacementKind.Undo) {
    const restore = await prepareLaneWrite(tx, {
      actor,
      affectedProjectIds: result.value.affectedProjectIds,
      destinationProjectId: result.value.placement.destinationProjectId,
      organizationId,
      placement: input,
      sourceArtifactIds: result.value.affectedArtifactIds,
    });
    if (!restore.ok) {
      throw new LaneWriteRollback(restore.error);
    }
    prepared = restore.value;
  }
  await applyPreparedProjectArtifactPlacementLaneWrite({
    organizationId,
    prepared,
    transactionId: result.value.transactionId,
    tx,
  });
  // ISS-12552: after the lane write, so a receipt that cannot be stored rolls
  // the placement and its lane field back together.
  await recordPlaced?.(tx, result.value);
  return { result, statusTransitions: preparedLaneStatusTransitions(prepared) };
}

/**
 * The audit ledger entry, status analytics and blocked-dependent sweep that the
 * list's status edit emits after it commits, so a board lane drop is not a
 * quieter status write than the same edit made anywhere else. One emission per
 * target status, because a board Undo can restore rows to different statuses.
 */
async function emitLaneStatusSideEffects(input: {
  actor: PlacementActor;
  input: ProjectArtifactPlacementRequest;
  organizationId: string;
  transactionId: string;
  transitions: readonly DocumentStatusTransition[];
}) {
  const byStatus = new Map<string, DocumentStatusTransition[]>();
  for (const transition of input.transitions) {
    byStatus.set(transition.after, [
      ...(byStatus.get(transition.after) ?? []),
      transition,
    ]);
  }
  for (const [after, transitions] of byStatus) {
    const status = ARTIFACT_STATUS_SCHEMA.safeParse(after);
    if (!status.success) {
      continue;
    }
    await emitBatchStatusSideEffects({
      authMethod: input.actor.authMethod,
      changedIds: transitions.map((transition) => transition.documentId),
      status: status.data,
      surface: ArtifactStatusEditSurface.Board,
      transactionId: input.transactionId,
      transitions,
      ...(input.input.kind === ProjectArtifactPlacementKind.Undo
        ? { undoOfTransactionId: input.input.undoOfTransactionId }
        : {}),
      user: { id: input.actor.userId, organizationId: input.organizationId },
    });
  }
}

async function prepareLaneWrite(
  tx: TransactionClient,
  input: {
    actor: PlacementActor;
    affectedProjectIds: readonly string[];
    destinationProjectId: string;
    organizationId: string;
    placement: ProjectArtifactPlacementRequest;
    sourceArtifactIds: readonly string[];
  }
) {
  const [policy, state] = await Promise.all([
    resolveProjectArtifactLanePolicy(
      input.destinationProjectId,
      input.organizationId
    ),
    readAllKindsPlacementState(tx, input.organizationId, [
      ...input.affectedProjectIds,
    ]),
  ]);
  return prepareProjectArtifactPlacementLaneWrite({
    actor: input.actor,
    destinationProjectId: input.destinationProjectId,
    organizationId: input.organizationId,
    placement: input.placement,
    policy,
    sourceArtifactIds: input.sourceArtifactIds,
    state,
    tx,
  });
}

class LaneWriteRollback extends Error {
  readonly placementError: PlacementError;

  constructor(placementError: PlacementError) {
    super(placementError.message);
    this.name = "LaneWriteRollback";
    this.placementError = placementError;
  }
}

const ARTIFACT_STATUS_SCHEMA = z.enum([
  ...Object.values(DocumentStatus),
  ...Object.values(IssueStatus),
]);
