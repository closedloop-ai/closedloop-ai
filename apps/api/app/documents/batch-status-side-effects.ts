import { ArtifactStatusCommitResult } from "@repo/api/src/types/artifact-activity";
import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import type { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { AuditAction, AuditObjectType } from "@repo/api/src/types/audit";
import type { ArtifactStatus } from "@repo/api/src/types/document";
import type { DocumentStatusTransition } from "@repo/api/src/types/document-status-mutation";
import type { TransactionClient } from "@repo/database";
import type { z } from "zod";
import {
  dispatchAuditEvents,
  userAuditActor,
} from "@/app/audit/audit-emit-service";
import {
  type ActivityActor,
  captureBatchStatusChange,
} from "@/lib/artifact-activity-capture";
import { createArtifactFieldEditAnalyticsContext } from "@/lib/artifact-field-edit-analytics-context";
import { captureArtifactStatusChangeAnalytics } from "@/lib/artifact-status-analytics";
import {
  withBulkTransaction,
  withUndoneBulkTransaction,
} from "@/lib/bulk-mutation-transaction";
import { resolveUniformOrigin } from "@/lib/resolve-uniform-origin";
import { blockedDependentUnblockService } from "./blocked-dependent-unblock-service";
import type { batchUpdateStatusValidator } from "./validators";

/**
 * The bulk route's surface comes from its validator; Board comes from the
 * placement transaction, which shares these committed status side effects.
 * Provenance and analytics must attribute both from the same input.
 */
type BatchStatusEditSurface =
  | z.infer<typeof batchUpdateStatusValidator>["surface"]
  | typeof ArtifactStatusEditSurface.Board;

export type BatchStatusSideEffectInput = {
  user: { id: string; organizationId: string };
  authMethod: ActivityActor["authMethod"];
  status: ArtifactStatus;
  surface: BatchStatusEditSurface;
  transitions: DocumentStatusTransition[];
  changedIds: string[];
  /** {@link newBulkTransactionId} — one id for every receipt of this commit. */
  transactionId: string;
  /**
   * ISS-10458: the transaction THIS commit reverses, when the request came from
   * an undo. Stamped onto every receipt below, so the undo and the mutation it
   * undid join on one id however many rows either of them actually moved — a
   * forward that committed two of five and an undo that restores those two
   * still resolve to each other.
   */
  undoOfTransactionId?: string;
  /** False when v2 produced refusals rather than a successful no-op. */
  reportNoChange?: boolean;
};

/**
 * The activity receipt for a bulk status write, recorded INSIDE that write's
 * transaction (ISS-10993). Call it from within the `withDb.tx` the mutation runs
 * in, after the rows are written: a receipt that cannot be persisted rolls the
 * batch back rather than leaving a hole in the published feed.
 *
 * Keyed off `transitions` — the same real-transition set the audit ledger uses —
 * so a no-op re-apply (before === target) is never recorded as a change.
 *
 * ISS-9436: every row of ONE bulk commit shares one `commitGroupId`, so a
 * receipt reader can tell a ten-row bulk change from ten separate edits. It is
 * THE SAME VALUE as the ledger's transaction id, not a second one minted here
 * (ISS-9465): the receipt's JSON and the row's column must not answer "which
 * commit" differently. A grouping key, not an idempotency key — a retry is a new
 * group, and the no-op suppression above is what keeps a re-applied status from
 * recording twice.
 */
export function captureBatchStatusActivity(
  tx: TransactionClient,
  input: BatchStatusSideEffectInput
): Promise<void> {
  return captureBatchStatusChange({
    tx,
    organizationId: input.user.organizationId,
    actor: { userId: input.user.id, authMethod: input.authMethod },
    changes: input.transitions.map((transition) => ({
      artifactId: transition.documentId,
      before: transition.before,
      after: transition.after,
    })),
    provenance: batchStatusProvenance(input),
    transactionId: input.transactionId,
    undoOfTransactionId: input.undoOfTransactionId,
  });
}

/**
 * Everything the bulk status write emits AFTER it commits (ISS-9464).
 *
 * Both `/documents/batch-update-status` and its `/v2` sibling call this, so the
 * audit, activity, analytics and unblock rules — each hardened in review
 * (ISS-9436, ISS-9443, ISS-9632) — exist once. Driven off `transitions` and
 * `changedIds`, never the requested ids, so a v2 batch that refused some items
 * emits nothing for them.
 */
export async function emitBatchStatusSideEffects(
  input: BatchStatusSideEffectInput
): Promise<void> {
  const {
    changedIds,
    status,
    transactionId,
    transitions,
    undoOfTransactionId,
    user,
  } = input;

  // Record each real transition on the tamper-evident audit ledger
  // (FEA-3862). Only transitions — documents already at the target status
  // did not transition, so emitting for them would forge ledger entries for
  // events that never happened (mirrors the single-document PUT guard).
  // Non-blocking and best-effort: a SINGLE bulk outbox insert off the
  // response path, so ledger emission never fails the batch update and the
  // enqueue is one pooled write regardless of batch size (not one per doc).
  // ISS-9465 ruling 3: the transaction id REPLACES the `batch: true` boolean
  // this detail used to carry. Both say the change was part of a bulk action
  // and only one of them says WHICH — and two overlapping signals in an
  // append-only, hash-chained table can never be reconciled later.
  // Its own `try`, separate from the analytics emission below: one shared guard
  // would let either emission's failure silently cost the other. The activity
  // receipt is NOT here — it commits with the write, in
  // {@link captureBatchStatusActivity}.
  const actor = userAuditActor(user.id);
  try {
    dispatchAuditEvents(
      transitions.map((transition) => ({
        organizationId: user.organizationId,
        actor,
        action: AuditAction.DocumentStatusChanged,
        objectType: AuditObjectType.Document,
        objectId: transition.documentId,
        detail: withUndoneBulkTransaction(
          withBulkTransaction(
            { from: transition.before, to: status },
            transactionId
          ),
          undoOfTransactionId
        ),
      }))
    );
  } catch {
    // Swallowed by design: a receipt must never fail the write.
  }

  const from = resolveUniformOrigin(
    transitions.map((transition) => transition.before)
  );
  emitLegacyBatchStatusChangeAnalytics(input, from);

  if (transitions.length === 0 && input.reportNoChange === false) {
    return;
  }
  batchStatusAnalyticsContext(input).capture({
    field: ArtifactFieldEditField.Status,
    result:
      transitions.length === 0
        ? ArtifactFieldEditOutcome.NoChange
        : ArtifactFieldEditOutcome.Committed,
    ...(from === undefined ? {} : { before: from }),
    after: status,
    ...(transitions.length === 0 ? {} : { artifactCount: transitions.length }),
    ...(undoOfTransactionId === undefined
      ? {}
      : { undoOfCommitGroupId: undoOfTransactionId }),
  });

  // ISS-9632: a bulk triage closing many artifacts at once is exactly when
  // the largest number of dependents should come off `BLOCKED`. Driven off
  // `changedIds` — the same real-transition set the ledger and the feed use
  // — so a no-op re-apply never re-triggers a sweep. Awaited (never
  // fire-and-forget) but internally best-effort: it cannot fail this write.
  await blockedDependentUnblockService.resolveBlocksForChangedArtifacts({
    organizationId: user.organizationId,
    changedArtifactIds: changedIds,
  });
}

/**
 * Where the write came from, for the two emissions that attribute by it. One
 * derivation for both so the receipt inside the transaction and the analytics
 * event after it cannot name different surfaces for one commit. The resolver
 * drops an API-key caller's claimed surface as unattributed.
 */
function batchStatusAnalyticsContext(input: BatchStatusSideEffectInput) {
  return createArtifactFieldEditAnalyticsContext({
    organizationId: input.user.organizationId,
    userId: input.user.id,
    surface: input.surface,
    authMethod: input.authMethod,
    commitGroupId: input.transactionId,
  });
}

function batchStatusProvenance(input: BatchStatusSideEffectInput) {
  return batchStatusAnalyticsContext(input).provenance;
}

/**
 * ISS-9436: the shipped `artifact_status_changed` event, one per commit, kept
 * beside `artifact_field_edit_result` because #8967 removed it without a
 * ruling (PRD-722 AC6). Suppressed when no trusted surface was named or nothing
 * moved; `from` is omitted when the rows left different statuses.
 */
function emitLegacyBatchStatusChangeAnalytics(
  input: BatchStatusSideEffectInput,
  from: string | null | undefined
): void {
  const provenance = batchStatusProvenance(input);
  if (provenance === undefined || input.transitions.length === 0) {
    return;
  }
  try {
    captureArtifactStatusChangeAnalytics({
      organizationId: input.user.organizationId,
      userId: input.user.id,
      surface: provenance.surface,
      result: ArtifactStatusCommitResult.Committed,
      from,
      to: input.status,
      artifactCount: input.transitions.length,
    });
  } catch {
    // Swallowed by design: analytics must never fail the write.
  }
}
