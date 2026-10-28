import {
  ProjectArtifactPlacementKind,
  type ProjectArtifactPlacementRequest,
  type ProjectArtifactPlacementResponse,
} from "@repo/api/src/types/project-artifact-placement";
import type { TransactionClient } from "@repo/database";
import { ArtifactType } from "@repo/database";
import {
  captureMovedProjectChanges,
  recordPlacementActivity,
} from "./project-artifact-placement-activity";
import {
  applyPlacementPlan,
  type PlacementPlan,
} from "./project-artifact-placement-persistence";
import type { PlacementActivityReceipt } from "./project-artifact-placement-receipt";
import {
  type PlacementRootFieldCommit,
  writePlacementRootFields,
} from "./project-artifact-placement-root-fields";
import type { PlacementRootFieldSnapshot } from "./project-artifact-placement-service-support";
import {
  type PlacementActor,
  parentIdsSnapshot,
  readPlacementState,
  snapshotRows,
} from "./project-artifact-placement-service-support";

/** Write hierarchy, root fields, and their reversible receipt on one transaction. */
export async function commitProjectArtifactPlacement(
  tx: TransactionClient,
  params: {
    organizationId: string;
    routeProjectId: string;
    input: ProjectArtifactPlacementRequest;
    actor: PlacementActor;
    requestHash: string;
    plan: PlacementPlan;
    rootFields: {
      before: PlacementRootFieldSnapshot[];
      after: PlacementRootFieldSnapshot[];
    } | null;
    onRootFieldsCommitted?: (commit: PlacementRootFieldCommit) => void;
    includeAllTypes?: boolean;
    fieldRevisions?: boolean;
  }
): Promise<ProjectArtifactPlacementResponse> {
  const {
    organizationId,
    routeProjectId,
    input,
    actor,
    requestHash,
    plan,
    rootFields,
  } = params;
  const transactionId = crypto.randomUUID();
  await applyPlacementPlan(tx, organizationId, plan);
  const documentArtifactIds =
    rootFields && params.includeAllTypes
      ? (
          await tx.artifact.findMany({
            where: {
              organizationId,
              id: { in: plan.sourceArtifactIds },
              type: ArtifactType.DOCUMENT,
            },
            select: { id: true },
          })
        ).map((row) => row.id)
      : undefined;
  if (rootFields) {
    await writePlacementRootFields(
      tx,
      organizationId,
      rootFields.before,
      rootFields.after,
      {
        actor,
        transactionId,
        ...(input.kind === ProjectArtifactPlacementKind.Undo
          ? { undoOfTransactionId: input.undoOfTransactionId }
          : { surface: input.surface }),
      },
      params.includeAllTypes
    );
  }
  const after = await readPlacementState(
    tx,
    organizationId,
    plan.affectedProjectIds,
    params.includeAllTypes,
    params.fieldRevisions ?? params.includeAllTypes
  );
  const response: ProjectArtifactPlacementResponse = {
    placed: true,
    transactionId,
    affectedArtifactIds: plan.affectedArtifactIds,
    affectedProjectIds: plan.affectedProjectIds,
    descendantCount:
      plan.movedArtifactIds.length - plan.sourceArtifactIds.length,
    projectVersions: after.projectVersions,
    placement: plan.placement,
    ...(input.kind === ProjectArtifactPlacementKind.Place
      ? { sourceRootMappings: plan.sourceRootMappings }
      : {}),
    replayed: false,
    undoAvailable: input.kind === ProjectArtifactPlacementKind.Place,
  };
  const receipt: PlacementActivityReceipt = {
    version: 1,
    routeProjectId,
    idempotencyKey: input.idempotencyKey,
    requestHash,
    affectedProjectIds: plan.affectedProjectIds,
    sourceArtifactIds: plan.sourceArtifactIds,
    beforeState: {
      ...plan.receiptBeforeState,
      ...(rootFields ? { rootFields: rootFields.before } : {}),
    },
    afterState: {
      version: 2,
      rankRows: snapshotRows(new Set(plan.affectedArtifactIds), after),
      movedRootParents: parentIdsSnapshot(
        plan.resultParentIds,
        plan.sourceArtifactIds
      ),
      ...(rootFields ? { rootFields: rootFields.after } : {}),
    },
    response,
  };
  await recordPlacementActivity(
    tx,
    organizationId,
    actor,
    transactionId,
    input.kind === ProjectArtifactPlacementKind.Undo
      ? input.undoOfTransactionId
      : undefined,
    plan,
    input.source,
    receipt
  );
  await captureMovedProjectChanges(
    tx,
    organizationId,
    actor,
    transactionId,
    plan
  );
  if (rootFields) {
    params.onRootFieldsCommitted?.({
      before: rootFields.before,
      after: rootFields.after,
      actor,
      organizationId,
      transactionId,
      ...(documentArtifactIds ? { documentArtifactIds } : {}),
      ...(input.kind === ProjectArtifactPlacementKind.Undo
        ? { undoOfTransactionId: input.undoOfTransactionId }
        : { surface: input.surface }),
    });
  }
  return response;
}
