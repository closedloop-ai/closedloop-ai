import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
} from "@repo/api/src/types/artifact-activity";
import type { ProjectArtifactPlacementSource } from "@repo/api/src/types/project-artifact-placement";
import type { TransactionClient } from "@repo/database";
import type { PlacementPlan } from "@/app/documents/project-artifact-placement-persistence";
import type { PlacementActivityReceipt } from "@/app/documents/project-artifact-placement-receipt";
import type { PlacementActor } from "@/app/documents/project-artifact-placement-service-support";
import { captureBatchProjectChange } from "@/lib/artifact-activity-capture";
import {
  ArtifactActivityCaptureStage,
  reportArtifactActivityCaptureFailure,
} from "@/lib/observability/artifact-activity-capture-telemetry";

/** Record the roots whose placement changed in the artifact activity ledger. */
export async function recordPlacementActivity(
  tx: TransactionClient,
  organizationId: string,
  actor: PlacementActor,
  transactionId: string,
  undoOfTransactionId: string | undefined,
  plan: PlacementPlan,
  source: ProjectArtifactPlacementSource,
  receipt?: PlacementActivityReceipt
): Promise<void> {
  const beforeById = new Map(
    plan.beforeState.map((row) => [row.artifactId, row])
  );
  const restoredById = new Map(
    (plan.restoreState?.rankRows ?? []).map((row) => [row.artifactId, row])
  );
  const actorType =
    actor.authMethod === "api_key"
      ? ArtifactActivityActorType.Agent
      : ArtifactActivityActorType.User;
  const data = plan.sourceArtifactIds.map((artifactId, index) => {
    const restored = restoredById.get(artifactId);
    const after =
      plan.mode === "restore" && restored
        ? {
            field: "placement",
            projectId: restored.projectId,
            parentId: restored.parentId,
            sortOrder: restored.sortOrder,
            source,
            movedDescendantCount:
              plan.movedArtifactIds.length - plan.sourceArtifactIds.length,
          }
        : {
            field: "placement",
            projectId: plan.placement.destinationProjectId,
            parentId: plan.destinationParentId,
            position: plan.placement.position,
            targetArtifactId: plan.placement.targetArtifactId ?? null,
            source,
            movedDescendantCount:
              plan.movedArtifactIds.length - plan.sourceArtifactIds.length,
          };
    return {
      organizationId,
      artifactId,
      actorType,
      actorId: actor.userId,
      action: ArtifactActivityAction.FieldChange,
      before: {
        field: "placement",
        projectId: beforeById.get(artifactId)?.projectId ?? null,
        parentId: beforeById.get(artifactId)?.parentId ?? null,
        sortOrder: beforeById.get(artifactId)?.sortOrder ?? null,
        source,
        movedDescendantCount:
          plan.movedArtifactIds.length - plan.sourceArtifactIds.length,
      },
      after: index === 0 && receipt ? { ...after, receipt } : after,
      transactionId,
      undoOfTransactionId,
    };
  });
  try {
    const inserted = await tx.artifactActivityEvent.createMany({ data });
    if (inserted.count !== data.length) {
      throw new Error(
        "Placement activity receipts did not reconcile with committed artifacts."
      );
    }
  } catch (error) {
    reportArtifactActivityCaptureFailure({
      stage: ArtifactActivityCaptureStage.BatchProject,
      organizationId,
      userId: actor.userId,
      rolledBackReceiptCount: data.length,
      commitGroupId: transactionId,
      ...(undoOfTransactionId
        ? { undoOfCommitGroupId: undoOfTransactionId }
        : {}),
      error,
    });
    throw error;
  }
}

/** Capture every moved descendant when a placement crosses projects. */
export async function captureMovedProjectChanges(
  tx: TransactionClient,
  organizationId: string,
  actor: PlacementActor,
  transactionId: string,
  plan: PlacementPlan
): Promise<void> {
  const beforeById = new Map(
    plan.beforeState.map((row) => [row.artifactId, row.projectId])
  );
  const restoredById = new Map(
    (plan.restoreState?.rankRows ?? []).map((row) => [
      row.artifactId,
      row.projectId,
    ])
  );
  const artifactIds =
    plan.mode === "restore"
      ? (plan.restoreState?.rankRows.map((row) => row.artifactId) ?? [])
      : plan.movedArtifactIds;
  await captureBatchProjectChange({
    tx,
    organizationId,
    actor,
    transactionId,
    changes: artifactIds.map((artifactId) => ({
      artifactId,
      before: beforeById.get(artifactId) ?? null,
      after:
        plan.mode === "restore"
          ? (restoredById.get(artifactId) ?? null)
          : plan.placement.destinationProjectId,
    })),
  });
}
