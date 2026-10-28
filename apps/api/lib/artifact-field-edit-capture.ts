import {
  ArtifactActivityAction,
  type ArtifactActivityActorType,
  artifactFieldEditFieldForSessionMetadata,
  buildStatusChangeSnapshots,
  type SessionMetadataActivityField,
} from "@repo/api/src/types/artifact-activity";
import {
  ArtifactFieldEditField,
  type ArtifactFieldEditReceiptContext,
  buildArtifactFieldEditSnapshots,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import type { ArtifactStatusProvenance } from "@repo/api/src/types/artifact-status-contract";
import type { TransactionClient } from "@repo/database";
import type { ActivityActor } from "@/lib/artifact-activity-capture";
import { resolveActorType } from "@/lib/artifact-activity-capture";
import { recordArtifactActivityChanges } from "@/lib/artifact-activity-recording";
import { ArtifactActivityCaptureStage } from "@/lib/observability/artifact-activity-capture-telemetry";

/** Record one actual artifact metadata transition on its writer's transaction. */
export async function captureArtifactMetadataChange(params: {
  tx: TransactionClient;
  organizationId: string;
  artifactId: string;
  actorType: ArtifactActivityActorType;
  actorId: string | null;
  action:
    | typeof ArtifactActivityAction.FieldChange
    | typeof ArtifactActivityAction.Assignment;
  field: SessionMetadataActivityField;
  before: string | null;
  after: string | null;
  context?: ArtifactFieldEditReceiptContext;
}): Promise<void> {
  if (params.before === params.after) {
    return;
  }
  const field = artifactFieldEditFieldForSessionMetadata(params.field);
  await recordArtifactActivityChanges({
    tx: params.tx,
    organizationId: params.organizationId,
    artifactId: params.artifactId,
    actorType: params.actorType,
    actorId: params.actorId,
    stage: ArtifactActivityCaptureStage.SingleUpdate,
    field,
    surface: params.context?.provenance?.surface,
    commitGroupId: params.context?.provenance?.commitGroupId,
    changes: [
      {
        action: params.action,
        field,
        ...buildArtifactFieldEditSnapshots({
          field,
          before: params.before,
          after: params.after,
          context: params.context,
        }),
      },
    ],
  });
}

/** Capture changed Session grouping fields from values read under the write lock. */
export async function captureSessionGroupingChanges(params: {
  tx: TransactionClient;
  organizationId: string;
  artifactId: string;
  actor: ActivityActor;
  before: SessionGroupingValues;
  after: SessionGroupingValues;
  provenance?: ArtifactStatusProvenance;
}): Promise<void> {
  const changes = sessionGroupingChanges(
    params.before,
    params.after,
    params.provenance
  );
  if (changes.length === 0) {
    return;
  }
  await recordArtifactActivityChanges({
    tx: params.tx,
    organizationId: params.organizationId,
    artifactId: params.artifactId,
    actorType: resolveActorType(params.actor.authMethod),
    actorId: params.actor.userId,
    changes,
    stage: ArtifactActivityCaptureStage.SingleUpdate,
    surface: params.provenance?.surface,
    commitGroupId: params.provenance?.commitGroupId,
  });
}

type SessionGroupingValues = {
  status?: string;
  projectId?: string | null;
  ownerUserId?: string | null;
};

type GroupingChange = Parameters<
  typeof recordArtifactActivityChanges
>[0]["changes"][number];

function sessionGroupingChanges(
  before: SessionGroupingValues,
  after: SessionGroupingValues,
  provenance: ArtifactStatusProvenance | undefined
): GroupingChange[] {
  const changes: GroupingChange[] = [];
  appendStatusChange(changes, before, after, provenance);
  appendReferenceChange(
    changes,
    ArtifactFieldEditField.ProjectId,
    before.projectId,
    after.projectId,
    provenance,
    ArtifactActivityAction.FieldChange
  );
  appendReferenceChange(
    changes,
    ArtifactFieldEditField.AssigneeId,
    before.ownerUserId,
    after.ownerUserId,
    provenance,
    ArtifactActivityAction.Assignment
  );
  return changes;
}

function appendStatusChange(
  changes: GroupingChange[],
  before: SessionGroupingValues,
  after: SessionGroupingValues,
  provenance: ArtifactStatusProvenance | undefined
): void {
  if (after.status === undefined) {
    return;
  }
  if (before.status === undefined) {
    throw new Error("Session status write lacked its locked prior value");
  }
  if (before.status !== after.status) {
    changes.push({
      field: ArtifactFieldEditField.Status,
      action: ArtifactActivityAction.StatusChange,
      ...buildStatusChangeSnapshots({
        before: before.status,
        after: after.status,
        provenance,
      }),
    });
  }
}

function appendReferenceChange(
  changes: GroupingChange[],
  field:
    | typeof ArtifactFieldEditField.ProjectId
    | typeof ArtifactFieldEditField.AssigneeId,
  before: string | null | undefined,
  after: string | null | undefined,
  provenance: ArtifactStatusProvenance | undefined,
  action:
    | typeof ArtifactActivityAction.FieldChange
    | typeof ArtifactActivityAction.Assignment
): void {
  if (after === undefined) {
    return;
  }
  if (before === undefined) {
    throw new Error(`Session ${field} write lacked its locked prior value`);
  }
  if (before !== after) {
    changes.push({
      field,
      action,
      ...buildArtifactFieldEditSnapshots({
        field,
        before,
        after,
        context: provenance === undefined ? undefined : { provenance },
      }),
    });
  }
}
