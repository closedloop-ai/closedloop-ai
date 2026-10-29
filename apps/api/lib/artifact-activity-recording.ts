import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
  type ArtifactActivityActorType as ArtifactActivityActorTypeValue,
  artifactFieldEditFieldForSessionMetadata,
  buildStatusChangeSnapshots,
  type RecordActivityEventInput,
  type SessionMetadataActivityField as SessionMetadataActivityFieldValue,
} from "@repo/api/src/types/artifact-activity";
import {
  ArtifactFieldEditField,
  buildArtifactFieldEditSnapshots,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import type { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type { TransactionClient } from "@repo/database";
import { artifactActivityService } from "@/app/documents/artifact-activity-service";
import {
  ArtifactActivityCaptureStage,
  type ArtifactActivityCaptureStage as ArtifactActivityCaptureStageValue,
  reportArtifactActivityCaptureFailure,
} from "@/lib/observability/artifact-activity-capture-telemetry";

type ArtifactActivityChange = Pick<
  RecordActivityEventInput,
  "action" | "before" | "after"
> & { field?: ArtifactFieldEditField };

/**
 * Persist field receipts on the caller's transaction and report failures.
 * Sequential writes keep a rejected receipt from leaving sibling statements
 * queued on an interactive transaction that must roll back.
 */
export async function recordArtifactActivityChanges(params: {
  tx: TransactionClient;
  organizationId: string;
  artifactId: string;
  actorType: ArtifactActivityActorTypeValue;
  actorId: string | null;
  changes: readonly ArtifactActivityChange[];
  stage: ArtifactActivityCaptureStageValue;
  field?: ArtifactFieldEditField;
  surface?: ArtifactStatusEditSurface;
  commitGroupId?: string;
  undoOfCommitGroupId?: string;
  transactionId?: string;
  undoOfTransactionId?: string;
}): Promise<void> {
  try {
    for (const change of params.changes) {
      await artifactActivityService.recordActivityEvent(
        {
          organizationId: params.organizationId,
          artifactId: params.artifactId,
          actorType: params.actorType,
          actorId: params.actorId,
          action: change.action,
          before: change.before,
          after: change.after,
          ...(params.transactionId
            ? { transactionId: params.transactionId }
            : {}),
          ...(params.undoOfTransactionId
            ? { undoOfTransactionId: params.undoOfTransactionId }
            : {}),
        },
        params.tx
      );
    }
  } catch (error) {
    const fields = [
      ...new Set(
        params.changes
          .map((change) => change.field ?? params.field)
          .filter(
            (field): field is ArtifactFieldEditField => field !== undefined
          )
      ),
    ];
    reportArtifactActivityCaptureFailure({
      stage: params.stage,
      organizationId: params.organizationId,
      ...(params.actorId === null ? {} : { userId: params.actorId }),
      artifactId: params.artifactId,
      rolledBackReceiptCount: params.changes.length,
      ...(fields.length === 1 ? { field: fields[0] } : {}),
      ...(fields.length > 1 ? { fields } : {}),
      ...(params.surface === undefined ? {} : { surface: params.surface }),
      ...(params.commitGroupId === undefined
        ? {}
        : { commitGroupId: params.commitGroupId }),
      ...(params.undoOfCommitGroupId === undefined
        ? {}
        : { undoOfCommitGroupId: params.undoOfCommitGroupId }),
      error,
    });
    throw error;
  }
}

/** Record a net lifecycle transition committed by a System Session writer. */
export async function captureSystemSessionStatusChange(params: {
  tx: TransactionClient;
  organizationId: string;
  artifactId: string;
  before: string;
  after: string;
}): Promise<void> {
  if (params.before === params.after) {
    return;
  }
  await recordArtifactActivityChanges({
    tx: params.tx,
    organizationId: params.organizationId,
    artifactId: params.artifactId,
    actorType: ArtifactActivityActorType.System,
    actorId: null,
    stage: ArtifactActivityCaptureStage.SingleUpdate,
    changes: [
      {
        action: ArtifactActivityAction.StatusChange,
        field: ArtifactFieldEditField.Status,
        ...buildStatusChangeSnapshots({
          before: params.before,
          after: params.after,
        }),
      },
    ],
  });
}

/** Record a net System Session field change on its writer's transaction. */
export async function captureSystemSessionMetadataChange(params: {
  tx: TransactionClient;
  organizationId: string;
  artifactId: string;
  field: SessionMetadataActivityFieldValue;
  before: string | null;
  after: string | null;
}): Promise<void> {
  if (params.before === params.after) {
    return;
  }
  await recordArtifactActivityChanges({
    tx: params.tx,
    organizationId: params.organizationId,
    artifactId: params.artifactId,
    actorType: ArtifactActivityActorType.System,
    actorId: null,
    stage: ArtifactActivityCaptureStage.SingleUpdate,
    changes: [
      {
        action: ArtifactActivityAction.FieldChange,
        field: artifactFieldEditFieldForSessionMetadata(params.field),
        ...buildArtifactFieldEditSnapshots({
          field: artifactFieldEditFieldForSessionMetadata(params.field),
          before: params.before,
          after: params.after,
        }),
      },
    ],
    field: artifactFieldEditFieldForSessionMetadata(params.field),
  });
}
