import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { AuditAction } from "@repo/api/src/types/audit";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import type { TransactionClient } from "@repo/database";
import { buildBulkArtifactMutationAuditEvents } from "@/app/audit/artifact-mutation-audit-event";
import {
  dispatchAuditEvents,
  userAuditActor,
} from "@/app/audit/audit-emit-service";
import { searchIndexService } from "@/app/search/search-index-service";
import {
  type ActivityActor,
  captureBatchProjectChange,
  captureBatchSessionOwnerAssignment,
} from "@/lib/artifact-activity-capture";
import { createArtifactFieldEditAnalyticsContext } from "@/lib/artifact-field-edit-analytics-context";
import type { BulkAssignChange } from "./session-write-service";
import { AgentSessionBulkAssignField } from "./write-contract";

export type BulkAssignSideEffectInput = {
  user: { id: string; organizationId: string };
  authMethod: ActivityActor["authMethod"];
  field: AgentSessionBulkAssignField;
  /** The committed transitions; empty when the all-or-nothing write refused. */
  changes: BulkAssignChange[];
  /** {@link newBulkTransactionId} — one id for every receipt of this commit. */
  transactionId: string;
};

/**
 * Everything a bulk session assignment emits AFTER it commits (ISS-9465).
 *
 * Both `/agent-sessions/bulk-assign` and its `/v2` sibling call this. Neither
 * wrote to the ledger or the activity feed before.
 *
 * The owner arm is audited as `agent_session.assigned` on
 * `AuditObjectType.AgentSession`, the shape it has always written. The owner
 * itself moved onto the artifact assignee in ISS-12251 (D-1); `objectId` is the
 * session's artifact id either way.
 *
 * The activity receipt is NOT emitted here; see
 * {@link captureBulkAssignActivity}.
 *
 * There is no per-item filtering to do beyond dropping a no-op re-assign: the
 * write is all-or-nothing by construction (ISS-8649), so either every requested
 * id changed or `changes` is empty.
 */
export function emitBulkAssignSideEffects(
  input: BulkAssignSideEffectInput
): void {
  const { changes, field, transactionId, user } = input;

  const moved = movedAssignments(changes);
  if (moved.length === 0) {
    emitBulkAssignAnalytics(input, moved, ArtifactFieldEditOutcome.NoChange);
    return;
  }

  // The PROJECT arm is a project move and is audited as one, exactly like the
  // three `batch-move` routes: one event kind earns one permanent member, and a
  // session row is an artifact row. Auditing it as `agent_session.assigned`
  // would hide every session move from an operator querying
  // `artifact.project_changed`, permanently — the value is hashed. The activity
  // side splits the same way (`captureBulkAssignActivity` routes the project arm
  // through the same function every other move uses), so the two halves describe
  // the batch identically.
  const action =
    field === AgentSessionBulkAssignField.Project
      ? AuditAction.ArtifactProjectChanged
      : AuditAction.AgentSessionAssigned;

  const actor = userAuditActor(user.id);
  // Guarded because a `waitUntil` throw here would 500 a batch that already
  // committed. The activity receipt is NOT here — it commits with the write, in
  // {@link captureBulkAssignActivity}.
  try {
    dispatchAuditEvents(
      buildBulkArtifactMutationAuditEvents({
        organizationId: user.organizationId,
        actor,
        changes: moved.map((change) => ({
          action,
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

  if (field === AgentSessionBulkAssignField.Owner) {
    refreshAssigneeProjection(user.organizationId, moved);
  }

  emitBulkAssignAnalytics(input, moved, ArtifactFieldEditOutcome.Committed);
}

/**
 * The activity receipt for a bulk session assignment, recorded INSIDE that
 * write's transaction (ISS-10993). Call it from within the `withDb.tx` the
 * mutation runs in, after the rows are written: a receipt that cannot be
 * persisted rolls the assignment back rather than leaving a hole in the
 * published feed.
 *
 * The PROJECT arm goes through `captureBatchProjectChange`, the same function
 * every other bulk move uses, so moving sessions and moving documents leave one
 * row shape in the feed. Only the OWNER arm needs a function of its own.
 */
export function captureBulkAssignActivity(
  tx: TransactionClient,
  input: BulkAssignSideEffectInput
): Promise<void> {
  const moved = movedAssignments(input.changes);
  if (moved.length === 0) {
    return Promise.resolve();
  }
  const shared = {
    tx,
    organizationId: input.user.organizationId,
    actor: { userId: input.user.id, authMethod: input.authMethod },
    changes: moved,
    transactionId: input.transactionId,
  };
  return input.field === AgentSessionBulkAssignField.Project
    ? captureBatchProjectChange(shared)
    : captureBatchSessionOwnerAssignment(shared);
}

/**
 * A session already holding the target project or owner was written but did not
 * MOVE, so an entry for it would record an event that never happened — the same
 * real-transition guard the status ledger takes.
 */
function movedAssignments(changes: BulkAssignChange[]): BulkAssignChange[] {
  return changes.filter((change) => change.before !== change.after);
}

/**
 * `@owner` search reads `search_document.assignee_id`, which the transcript
 * indexer refreshes only when a transcript lands (ISS-12251). Every change in a
 * batch carries the batch's one target, so one statement covers them all.
 */
function refreshAssigneeProjection(
  organizationId: string,
  moved: BulkAssignChange[]
): void {
  try {
    searchIndexService.updateAssigneeManyAfterCommit(
      { organizationId, entityType: SearchEntityType.AgentSession },
      moved.map((change) => change.artifactId),
      moved[0].after
    );
  } catch {
    // Swallowed by design: a projection refresh must never fail the write.
  }
}

function emitBulkAssignAnalytics(
  input: BulkAssignSideEffectInput,
  moved: BulkAssignChange[],
  result: ArtifactFieldEditOutcome
): void {
  const target = moved[0]?.after ?? input.changes[0]?.after;
  createArtifactFieldEditAnalyticsContext({
    organizationId: input.user.organizationId,
    userId: input.user.id,
    surface: ArtifactStatusEditSurface.Bulk,
    authMethod: input.authMethod,
    commitGroupId: input.transactionId,
  }).capture({
    field:
      input.field === AgentSessionBulkAssignField.Project
        ? ArtifactFieldEditField.ProjectId
        : ArtifactFieldEditField.AssigneeId,
    result,
    ...(target === undefined ? {} : { after: target }),
    ...(moved.length === 0 ? {} : { artifactCount: moved.length }),
  });
}
