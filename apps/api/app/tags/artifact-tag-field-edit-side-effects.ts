import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  ArtifactActivityAction,
  SessionMetadataActivityField,
} from "@repo/api/src/types/artifact-activity";
import {
  ArtifactFieldEditField,
  type ArtifactFieldEditOutcome,
  type ArtifactFieldEditReceiptContext,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import type { TransactionClient } from "@repo/database";
import {
  type ActivityActor,
  resolveActorType,
} from "@/lib/artifact-activity-capture";
import { captureArtifactFieldEditAnalytics } from "@/lib/artifact-field-edit-analytics";
import { captureArtifactMetadataChange } from "@/lib/artifact-field-edit-capture";

type ReceiptArtifactType =
  | typeof ArtifactType.Document
  | typeof ArtifactType.Session
  | typeof ArtifactType.Branch;

/** Narrow artifact kinds whose field edits have activity receipts. */
export function isReceiptArtifactType(
  type: ArtifactType | null
): type is ReceiptArtifactType {
  return (
    type === ArtifactType.Document ||
    type === ArtifactType.Session ||
    type === ArtifactType.Branch
  );
}

/** Persist one tag transition on the mutation's transaction. */
export async function captureSingleTagReceipt(params: {
  tx: TransactionClient;
  organizationId: string;
  artifactId: string;
  actor: ActivityActor;
  context?: ArtifactFieldEditReceiptContext;
  before: string | null;
  after: string | null;
}): Promise<void> {
  await captureArtifactMetadataChange({
    tx: params.tx,
    organizationId: params.organizationId,
    artifactId: params.artifactId,
    actorType: resolveActorType(params.actor.authMethod),
    actorId: params.actor.userId,
    action: ArtifactActivityAction.FieldChange,
    field: SessionMetadataActivityField.Tag,
    before: params.before,
    after: params.after,
    ...(params.context === undefined ? {} : { context: params.context }),
  });
}

/** Emit one value-safe tag outcome after the mutation resolves. */
export function emitSingleTagAnalytics(params: {
  organizationId: string;
  actor: ActivityActor;
  context?: ArtifactFieldEditReceiptContext;
  result: ArtifactFieldEditOutcome;
  before: string | null;
  after: string | null;
}): void {
  captureArtifactFieldEditAnalytics({
    organizationId: params.organizationId,
    userId: params.actor.userId,
    field: ArtifactFieldEditField.Tag,
    result: params.result,
    artifactCount: 1,
    before: params.before,
    after: params.after,
    provenance: params.context?.provenance,
  });
}
