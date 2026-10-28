import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import type { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { AuditAction } from "@repo/api/src/types/audit";
import type { TransactionClient } from "@repo/database";
import { buildBulkArtifactMutationAuditEvents } from "@/app/audit/artifact-mutation-audit-event";
import {
  dispatchAuditEvents,
  userAuditActor,
} from "@/app/audit/audit-emit-service";
import {
  type ActivityActor,
  type BatchProjectChange,
  captureBatchProjectChange,
} from "@/lib/artifact-activity-capture";
import { createArtifactFieldEditAnalyticsContext } from "@/lib/artifact-field-edit-analytics-context";

export type BatchMoveSideEffectInput = {
  user: { id: string; organizationId: string };
  authMethod: ActivityActor["authMethod"];
  /** Only the rows that actually changed project, read under the write's lock. */
  projectChanges: BatchProjectChange[];
  /** {@link newBulkTransactionId} — one id for every receipt of this commit. */
  transactionId: string;
  surface?: ArtifactStatusEditSurface;
};

/**
 * Everything a bulk project move emits AFTER it commits.
 *
 * All THREE move routes call this — `/documents/batch-move`, its `/v2` sibling,
 * and `/artifact-links/batch-move` — so the audit entry ISS-9465 ruling 6 adds
 * and the ISS-9158 receipt are written the same way from each, rather than
 * three copies that can drift apart.
 *
 * One `AuditAction.ArtifactProjectChanged` over `AuditObjectType.Artifact` for
 * all three, and not a document-flavoured variant for the two document routes:
 * `/artifact-links/batch-move` walks a link graph carrying branches and
 * deployments, a document row is an artifact row, and one event kind earns one
 * permanent member in a vocabulary that can never be renamed.
 *
 * Driven off `projectChanges`, never the requested ids: it holds the rows whose
 * project actually moved, so a move that refused some items and a re-move onto
 * the project a row already had both emit nothing for those rows.
 */
export function emitBatchMoveSideEffects(
  input: BatchMoveSideEffectInput
): void {
  const { projectChanges, transactionId, user } = input;

  const moved = movedRows(projectChanges);

  const actor = userAuditActor(user.id);
  // Guarded because a `waitUntil` throw here would 500 a batch that already
  // committed. The activity receipt is NOT here — it commits with the write, in
  // {@link captureBatchMoveActivity}.
  try {
    dispatchAuditEvents(
      buildBulkArtifactMutationAuditEvents({
        organizationId: user.organizationId,
        actor,
        changes: moved.map((change) => ({
          action: AuditAction.ArtifactProjectChanged,
          objectId: change.artifactId,
          before: change.before,
          after: change.after,
        })),
        transactionId,
      })
    );
  } catch {
    // Swallowed by design: a receipt must never fail the write.
  }
  const target = projectChanges[0]?.after;
  batchMoveAnalyticsContext(input).capture({
    field: ArtifactFieldEditField.ProjectId,
    result:
      moved.length === 0
        ? ArtifactFieldEditOutcome.NoChange
        : ArtifactFieldEditOutcome.Committed,
    ...(target === undefined ? {} : { after: target }),
    artifactCount: moved.length,
  });
}

/**
 * The activity receipt for a bulk project move, recorded INSIDE that move's
 * transaction (ISS-10993). Call it from within the `withDb.tx` the mutation runs
 * in, after the rows are written: a receipt that cannot be persisted rolls the
 * move back rather than leaving a hole in the published feed.
 */
export function captureBatchMoveActivity(
  tx: TransactionClient,
  input: BatchMoveSideEffectInput
): Promise<void> {
  return captureBatchProjectChange({
    tx,
    organizationId: input.user.organizationId,
    actor: { userId: input.user.id, authMethod: input.authMethod },
    changes: movedRows(input.projectChanges),
    transactionId: input.transactionId,
    provenance: batchMoveAnalyticsContext(input).provenance,
    ...(input.surface === undefined
      ? { preserveProvenanceOmission: true }
      : {}),
  });
}

/**
 * A row already sitting in the target project was locked and rewritten but did
 * not MOVE, so an entry for it would record an event that never happened — the
 * same real-transition guard the status ledger takes.
 * `captureBatchProjectChange` applies it again for its own callers; one
 * derivation here keeps the ledger and the receipt describing one set of rows.
 */
function movedRows(projectChanges: BatchProjectChange[]): BatchProjectChange[] {
  return projectChanges.filter((change) => change.before !== change.after);
}

function batchMoveAnalyticsContext(input: BatchMoveSideEffectInput) {
  return createArtifactFieldEditAnalyticsContext({
    organizationId: input.user.organizationId,
    userId: input.user.id,
    surface: input.surface,
    authMethod: input.authMethod,
    commitGroupId: input.transactionId,
  });
}
