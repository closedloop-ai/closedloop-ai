import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import { AuditAction } from "@repo/api/src/types/audit";
import type { Priority } from "@repo/api/src/types/common";
import { ArtifactPriorityCommitResult } from "@repo/api/src/types/priority-contract";
import type { TransactionClient } from "@repo/database";
import type { z } from "zod";
import { buildBulkArtifactMutationAuditEvents } from "@/app/audit/artifact-mutation-audit-event";
import {
  dispatchAuditEvents,
  userAuditActor,
} from "@/app/audit/audit-emit-service";
import {
  type ActivityActor,
  captureBatchPriorityChange,
} from "@/lib/artifact-activity-capture";
import { createArtifactFieldEditAnalyticsContext } from "@/lib/artifact-field-edit-analytics-context";
import { captureArtifactPriorityChangeAnalytics } from "@/lib/artifact-priority-analytics";
import type { batchUpdatePriorityValidator } from "./validators";

/**
 * The surfaces the bulk priority body accepts, taken from its own validator so
 * the two cannot drift. Surface reaches this helper at all because the priority
 * analytics event attributes by it.
 */
type BatchPriorityEditSurface = z.infer<
  typeof batchUpdatePriorityValidator
>["surface"];

export type BatchPrioritySideEffectInput = {
  user: { id: string; organizationId: string };
  authMethod: ActivityActor["authMethod"];
  priority: Priority;
  surface: BatchPriorityEditSurface;
  changedIds: string[];
  beforePriorities: ReadonlyMap<string, Priority | null>;
  /** {@link newBulkTransactionId} — one id for every receipt of this commit. */
  transactionId: string;
  /** False when v2 produced refusals rather than a successful no-op. */
  reportNoChange?: boolean;
};

/**
 * The activity receipt for a bulk priority write, recorded INSIDE that write's
 * transaction (ISS-10993). Keyed off `changedIds` so a no-op re-apply is never
 * recorded as a change. Every changed id has a `beforePriorities` key, so no
 * membership filter is needed; the value may legitimately be null, because an
 * artifact whose priority was unset records unset -> chosen as a real
 * transition.
 */
export function captureBatchPriorityActivity(
  tx: TransactionClient,
  input: BatchPrioritySideEffectInput
): Promise<void> {
  return captureBatchPriorityChange({
    tx,
    organizationId: input.user.organizationId,
    actor: { userId: input.user.id, authMethod: input.authMethod },
    transactionId: input.transactionId,
    provenance: batchPriorityAnalyticsContext(input).provenance,
    preserveProvenanceOmission: true,
    changes: input.changedIds.map((id) => ({
      artifactId: id,
      before: input.beforePriorities.get(id) ?? null,
      after: input.priority,
    })),
  });
}

/**
 * Everything the bulk priority write emits AFTER it commits (ISS-9464).
 *
 * Both `/documents/batch-update-priority` and its `/v2` sibling call this, so
 * the audit entry (ISS-9465), the receipt and the ISS-9443 analytics guard
 * exist once. Driven off `changedIds`, never the requested ids, so a v2 batch
 * that refused some items emits nothing for them.
 */
export function emitBatchPrioritySideEffects(
  input: BatchPrioritySideEffectInput
): void {
  const {
    authMethod,
    beforePriorities,
    changedIds,
    priority,
    surface,
    transactionId,
    user,
  } = input;

  // ISS-9465 ruling 6: a bulk priority change goes on the tamper-evident
  // ledger, reversing ISS-9688's decision to withhold the member from
  // artifacts. Keyed off `changedIds` — the same real-transition set the
  // receipt below uses — so a no-op re-apply never forges an entry for a
  // change that did not happen. One bulk outbox insert off the response path,
  // never one per document (`apps/api/AGENTS.md` — Bounded fan-out).
  const actor = userAuditActor(user.id);
  // Guarded, and separately from the analytics emission below: a `waitUntil`
  // throw here would 500 a batch that already committed, and one shared `try`
  // would let either emission's failure silently cost the other. The activity
  // receipt is NOT here — it commits with the write, in
  // {@link captureBatchPriorityActivity}.
  try {
    dispatchAuditEvents(
      buildBulkArtifactMutationAuditEvents({
        organizationId: user.organizationId,
        actor,
        changes: changedIds.map((id) => ({
          action: AuditAction.DocumentPriorityChanged,
          objectId: id,
          before: beforePriorities.get(id) ?? null,
          after: priority,
        })),
        transactionId,
      })
    );
  } catch {
    // Swallowed by design: a receipt must never fail the write.
  }

  // ISS-9443: the shipped `artifact_priority_changed` event, one per commit,
  // kept beside `artifact_field_edit_result` because #8967 removed it without
  // a ruling (PRD-722 AC6). An API-key write is unattributed by contract.
  if (
    surface !== undefined &&
    authMethod !== "api_key" &&
    changedIds.length > 0
  ) {
    try {
      captureArtifactPriorityChangeAnalytics({
        organizationId: user.organizationId,
        userId: user.id,
        surface,
        result: ArtifactPriorityCommitResult.Committed,
        // `from` is OMITTED: a bulk commit has as many priors as rows, and
        // `null` already means "the artifact held none".
        to: priority,
        artifactCount: changedIds.length,
      });
    } catch {
      // Swallowed by design: telemetry must never fail the write.
    }
  }

  if (changedIds.length === 0 && input.reportNoChange === false) {
    return;
  }
  batchPriorityAnalyticsContext(input).capture({
    field: ArtifactFieldEditField.Priority,
    result:
      changedIds.length === 0
        ? ArtifactFieldEditOutcome.NoChange
        : ArtifactFieldEditOutcome.Committed,
    after: priority,
    ...(changedIds.length === 0 ? {} : { artifactCount: changedIds.length }),
  });
}

function batchPriorityAnalyticsContext(input: BatchPrioritySideEffectInput) {
  return createArtifactFieldEditAnalyticsContext({
    organizationId: input.user.organizationId,
    userId: input.user.id,
    authMethod: input.authMethod,
    surface: input.surface,
    commitGroupId: input.transactionId,
  });
}
