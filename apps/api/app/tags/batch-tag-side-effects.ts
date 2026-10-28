import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { AuditAction } from "@repo/api/src/types/audit";
import type { TransactionClient } from "@repo/database";
import { buildBulkArtifactMutationAuditEvents } from "@/app/audit/artifact-mutation-audit-event";
import {
  dispatchAuditEvents,
  userAuditActor,
} from "@/app/audit/audit-emit-service";
import {
  type ActivityActor,
  captureBatchTagApplied,
  captureBatchTagRemoved,
} from "@/lib/artifact-activity-capture";
import { createArtifactFieldEditAnalyticsContext } from "@/lib/artifact-field-edit-analytics-context";

export type BatchTagSideEffectInput = {
  user: { id: string; organizationId: string };
  authMethod: ActivityActor["authMethod"];
  tagId: string;
  action:
    | typeof AuditAction.ArtifactTagApplied
    | typeof AuditAction.ArtifactTagRemoved;
  /** Only artifacts whose tag membership actually changed. */
  changedIds: readonly string[];
  /** {@link newBulkTransactionId} — one id for every receipt of this commit. */
  transactionId: string;
};

/**
 * Everything a bulk tag membership mutation emits AFTER it commits.
 *
 * Both `/entity-tags/batch` and its `/v2` sibling call this. Neither wrote to
 * the ledger or the activity feed before; ruling 6 put every bulk route on the
 * ledger and ruling 1 required the receipt be per artifact rather than a count.
 *
 * The activity receipt is NOT emitted here; see {@link captureBatchTagActivity}.
 *
 * `AuditObjectType.Artifact`, not `Document`: the validator pins the entity
 * type to Artifact and any artifact subtype is taggable, so a branch or a
 * session can be the object here.
 *
 * Driven off changed membership ids, never the requested set: idempotent apply
 * and remove requests write no row, so recording them would invent an event.
 */
export function emitBatchTagSideEffects(input: BatchTagSideEffectInput): void {
  const { action, changedIds, tagId, transactionId, user } = input;
  if (changedIds.length === 0) {
    emitTagEditAnalytics(input, ArtifactFieldEditOutcome.NoChange);
    return;
  }

  const actor = userAuditActor(user.id);
  // Guarded because a `waitUntil` throw here would 500 a batch that already
  // committed. The activity receipt is NOT here — it commits with the write, in
  // {@link captureBatchTagActivity}.
  try {
    dispatchAuditEvents(
      buildBulkArtifactMutationAuditEvents({
        organizationId: user.organizationId,
        actor,
        changes: changedIds.map((artifactId) => ({
          action,
          objectId: artifactId,
          tagId,
        })),
        transactionId,
      })
    );
  } catch {
    // Swallowed by design: a receipt must never fail the write.
  }
  emitTagEditAnalytics(input, ArtifactFieldEditOutcome.Committed);
}

/**
 * The activity receipt for a bulk tag mutation, recorded INSIDE that write's
 * transaction (ISS-10993). Call it from within the `withDb.tx` the mutation runs
 * in, after the rows are written: a receipt that cannot be persisted rolls the
 * tag application back rather than leaving a hole in the published feed.
 *
 * Driven off changed membership ids, never the requested set.
 */
export function captureBatchTagActivity(
  tx: TransactionClient,
  input: BatchTagSideEffectInput
): Promise<void> {
  if (input.changedIds.length === 0) {
    return Promise.resolve();
  }
  const common = {
    tx,
    organizationId: input.user.organizationId,
    actor: { userId: input.user.id, authMethod: input.authMethod },
    tagId: input.tagId,
    transactionId: input.transactionId,
  };
  if (input.action === AuditAction.ArtifactTagRemoved) {
    return captureBatchTagRemoved({
      ...common,
      untaggedArtifactIds: input.changedIds,
    });
  }
  return captureBatchTagApplied({
    ...common,
    taggedArtifactIds: input.changedIds,
  });
}

function emitTagEditAnalytics(
  input: BatchTagSideEffectInput,
  result: ArtifactFieldEditOutcome
): void {
  createArtifactFieldEditAnalyticsContext({
    organizationId: input.user.organizationId,
    userId: input.user.id,
    surface: ArtifactStatusEditSurface.Bulk,
    authMethod: input.authMethod,
    commitGroupId: input.transactionId,
  }).capture({
    field: ArtifactFieldEditField.Tag,
    result,
    before:
      input.action === AuditAction.ArtifactTagRemoved ? input.tagId : null,
    after: input.action === AuditAction.ArtifactTagRemoved ? null : input.tagId,
    ...(input.changedIds.length === 0
      ? {}
      : { artifactCount: input.changedIds.length }),
  });
}
