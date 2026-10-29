import "server-only";

import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
  type ArtifactActivityActorType as ArtifactActivityActorTypeValue,
  buildStatusChangeSnapshots,
  type RecordActivityEventBatchRow,
  type RecordActivityEventInput,
} from "@repo/api/src/types/artifact-activity";
import {
  ArtifactFieldEditField,
  type ArtifactFieldEditReceiptContext,
  buildArtifactFieldEditSnapshots,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import {
  ArtifactStatusEditSurface,
  type ArtifactStatusProvenance,
} from "@repo/api/src/types/artifact-status-contract";
import type { JsonValue } from "@repo/api/src/types/common";
import type { TransactionClient } from "@repo/database";
import { artifactActivityService } from "@/app/documents/artifact-activity-service";
import { recordArtifactActivityChanges as recordChanges } from "@/lib/artifact-activity-recording";
import type { ArtifactEditAuthMethod } from "@/lib/auth/artifact-edit-auth-method";
import {
  ArtifactActivityCaptureStage,
  reportArtifactActivityCaptureFailure,
} from "@/lib/observability/artifact-activity-capture-telemetry";

/**
 * Artifact activity capture at the write path (FEA-3864 / FEA-3535 Slice 2).
 *
 * Diffs the before/after of a document mutation and records one
 * `ArtifactActivityEvent` per changed field so the activity feed (Slice 3
 * endpoint) has a persisted trail. Both human (Clerk session / desktop session)
 * and agent (API-key / MCP) writes funnel through `PUT /documents/[id]` and
 * `POST /documents/batch-update-status`, so capturing here covers every actor.
 *
 * ATOMICITY (load-bearing, and the REVERSE of the rule this file carried until
 * ISS-10993). Every entry point takes the MUTATION's transaction client and is
 * awaited inside it, so the receipt and the change it describes commit or roll
 * back together. A capture failure therefore FAILS THE USER'S WRITE. Cosimo
 * Corrigan ruled that trade on 2026-09-23 over two alternatives: these rows back
 * a published, paginated product API (`GET /documents/[id]/activity`), nothing
 * re-derives a lost one, and a refused write is reported in minutes where a
 * silently dropped receipt eroded the feed for an unknown period with nobody
 * able to see it.
 *
 * A failure is still REPORTED before it propagates through
 * `reportArtifactActivityCaptureFailure`. Its stable snake_case event is
 * queryable today; ISS-10185 tracks a future monitor expected to use it, but it
 * does not page today.
 *
 * WHERE THAT ONE TRANSACTION IS OPENED is not a style choice, because
 * `withDb.tx` JOINS an ambient transaction rather than nesting inside it. A
 * route may open it only when the service it calls has NOTHING it defers past
 * its own commit and raises NO refusal it catches itself. Otherwise the receipt
 * goes in as a CALLBACK the service runs on its own transaction — `POST
 * /entity-tags/batch` (+ v2) and `POST /agent-sessions/bulk-assign` (+ v2) are
 * the four that must, and the create paths already were. Wrapping those would
 * pull the tag path's GitHub label reconciliation inside the transaction, and
 * would leave `SessionWriteRefusal` caught by `runSessionWrite` INSIDE the route's
 * transaction, which then commits the partial write the refusal exists to
 * unwind.
 *
 * USER-CONTENT `title` IS SNAPSHOTTED VERBATIM, by explicit decision (Marisol
 * Ashgrove, 2026-09-11, ISS-9688). The value belongs in the ledger, so it is
 * stored whole: do NOT add a redaction, truncation, hashing, or "sanitized"
 * rendering pass on the way in. A truncated title is the worst of both options —
 * it can no longer be matched against the artifact it describes, and it still
 * carries whatever it did not cut. The snapshot is point-in-time, so a later
 * rename does not rewrite it; that is what an audit ledger is for, not drift.
 * This authorizes the artifact `title` FIELD AND NOTHING ELSE — any other
 * user-content field a receipt might carry is a separate decision to raise.
 */

/**
 * The minimal auth shape the capture path needs to attribute an event. Mirrors
 * the fields the route already has in hand from `AuthContext` — we do not pull
 * in the full type to keep this helper decoupled from the auth module.
 */
export type ActivityActor = {
  /** The platform user id (always present, even for API-key callers). */
  userId: string;
  /** How the caller authenticated — decides human vs agent attribution. */
  authMethod: ArtifactEditAuthMethod;
};

/**
 * The subset of an artifact's mutable fields the feed captures. Both the
 * before and after snapshots are projected onto this shape so the diff is a
 * plain field-by-field comparison.
 */
export type CapturedArtifactFields = {
  status: string;
  assigneeId: string | null;
  approverId: string | null;
  /**
   * ISS-9665: nullable, because "no priority" is a real state. While the
   * serializer folded a stored null to `MEDIUM`, the very first time a user set
   * a priority the diff compared `MEDIUM` to `MEDIUM` and recorded NOTHING — the
   * transition was invisible in the feed — or, when they picked something else,
   * recorded a `MEDIUM` before that was never true. With null flowing through,
   * that first set records `null → HIGH` and clearing records `HIGH → null`.
   */
  priority: string | null;
  title: string;
  dueDate: Date | null;
  projectId: string | null;
};

/**
 * Resolve the persisted `actorType` from the caller's auth method. An API-key
 * caller (MCP agent / programmatic write) is an `agent`; a Clerk session or a
 * desktop session is a `human` user. The platform itself never writes through
 * these routes, so `system` is not produced here.
 */
export function resolveActorType(
  authMethod: ActivityActor["authMethod"]
): ArtifactActivityActorTypeValue {
  return authMethod === "api_key"
    ? ArtifactActivityActorType.Agent
    : ArtifactActivityActorType.User;
}

/**
 * A single field-scoped change to record, already resolved to its action and
 * before/after snapshot.
 */
type FieldChange = {
  action: RecordActivityEventInput["action"];
  before: JsonValue | null;
  after: JsonValue | null;
};

type DimensionedFieldChange = FieldChange & {
  field: ArtifactFieldEditField;
};

/**
 * Normalize a Date (or null) to an ISO string (or null) for the JSON snapshot.
 */
function toDateSnapshot(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Diff two field snapshots and return one `FieldChange` per field that actually
 * changed. A non-mutating update (nothing changed, or a field re-set to its
 * current value) yields an empty array — so no spurious rows are recorded and
 * the feed never double-counts a no-op PUT.
 */
export function diffArtifactFields(
  before: CapturedArtifactFields,
  after: CapturedArtifactFields,
  provenance?: ArtifactStatusProvenance
): FieldChange[] {
  return diffArtifactFieldsWithDimensions(before, after, provenance).map(
    ({ field: _field, ...change }) => change
  );
}

function diffArtifactFieldsWithDimensions(
  before: CapturedArtifactFields,
  after: CapturedArtifactFields,
  provenance?: ArtifactStatusProvenance
): DimensionedFieldChange[] {
  const changes: DimensionedFieldChange[] = [];

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

  // Both roles record under the single `assignment` action, so without a field
  // envelope the reader cannot tell an assignee swap from an approver swap and
  // two rows from one save read as the same field changing twice (ISS-5007
  // review). The envelope matches the shape the other field changes already
  // use; readers accept the bare-id shape too, so rows written before this
  // still render.
  if (before.assigneeId !== after.assigneeId) {
    changes.push({
      field: ArtifactFieldEditField.AssigneeId,
      action: ArtifactActivityAction.Assignment,
      ...buildArtifactFieldEditSnapshots({
        field: ArtifactFieldEditField.AssigneeId,
        before: before.assigneeId,
        after: after.assigneeId,
        context: receiptContext(provenance),
      }),
    });
  }

  if (before.approverId !== after.approverId) {
    changes.push({
      field: ArtifactFieldEditField.ApproverId,
      action: ArtifactActivityAction.Assignment,
      ...buildArtifactFieldEditSnapshots({
        field: ArtifactFieldEditField.ApproverId,
        before: before.approverId,
        after: after.approverId,
        context: receiptContext(provenance),
      }),
    });
  }

  if (before.priority !== after.priority) {
    changes.push({
      field: ArtifactFieldEditField.Priority,
      action: ArtifactActivityAction.FieldChange,
      ...buildArtifactFieldEditSnapshots({
        field: ArtifactFieldEditField.Priority,
        before: before.priority,
        after: after.priority,
        context: receiptContext(provenance),
      }),
    });
  }

  if (before.title !== after.title) {
    changes.push({
      field: ArtifactFieldEditField.Title,
      action: ArtifactActivityAction.FieldChange,
      ...buildArtifactFieldEditSnapshots({
        field: ArtifactFieldEditField.Title,
        before: before.title,
        after: after.title,
        context: receiptContext(provenance),
      }),
    });
  }

  const beforeDue = toDateSnapshot(before.dueDate);
  const afterDue = toDateSnapshot(after.dueDate);
  if (beforeDue !== afterDue) {
    changes.push({
      field: ArtifactFieldEditField.DueDate,
      action: ArtifactActivityAction.FieldChange,
      ...buildArtifactFieldEditSnapshots({
        field: ArtifactFieldEditField.DueDate,
        before: beforeDue,
        after: afterDue,
        context: receiptContext(provenance),
      }),
    });
  }

  if (before.projectId !== after.projectId) {
    changes.push({
      field: ArtifactFieldEditField.ProjectId,
      action: ArtifactActivityAction.FieldChange,
      ...buildArtifactFieldEditSnapshots({
        field: ArtifactFieldEditField.ProjectId,
        before: before.projectId,
        after: after.projectId,
        context: receiptContext(provenance),
      }),
    });
  }

  return changes;
}

/**
 * Capture the field changes on a document update. Diffs `before`/`after`,
 * resolves the actor, and writes the rows on the update's own transaction. Call
 * it inside that transaction, after the write — a no-op diff records nothing.
 */
export async function captureArtifactUpdate(params: {
  /** The mutation's transaction; see this file's ATOMICITY note. */
  tx: TransactionClient;
  organizationId: string;
  artifactId: string;
  actor: ActivityActor;
  before: CapturedArtifactFields;
  after: CapturedArtifactFields;
  /**
   * Where the write came from (ISS-9436). Optional and omission-preserving: a
   * caller that cannot name its surface — an API-key write, an MCP agent, a
   * browser on a build older than this one — records the same bare snapshot it
   * always has rather than an invented or null provenance.
   */
  provenance?: ArtifactStatusProvenance;
  transactionId?: string;
  undoOfTransactionId?: string;
}): Promise<void> {
  const provenance =
    params.provenance ??
    (params.transactionId
      ? {
          surface: ArtifactStatusEditSurface.Board,
          commitGroupId: params.transactionId,
        }
      : undefined);
  const changes = diffArtifactFieldsWithDimensions(
    params.before,
    params.after,
    provenance
  );
  if (changes.length === 0) {
    return;
  }
  await recordChanges({
    tx: params.tx,
    organizationId: params.organizationId,
    artifactId: params.artifactId,
    actorType: resolveActorType(params.actor.authMethod),
    actorId: params.actor.userId,
    changes,
    stage: ArtifactActivityCaptureStage.SingleUpdate,
    surface: provenance?.surface,
    commitGroupId: provenance?.commitGroupId,
    undoOfCommitGroupId: params.undoOfTransactionId,
    ...(params.transactionId ? { transactionId: params.transactionId } : {}),
    ...(params.undoOfTransactionId
      ? { undoOfTransactionId: params.undoOfTransactionId }
      : {}),
  });
}

/**
 * Record a batch of status-change events best-effort, in a SINGLE tenant-scoped
 * transaction. A batch status update can touch hundreds of artifacts; recording
 * one event per artifact through per-row transactions would open one pooled DB
 * connection per event and starve the pool (`apps/api/AGENTS.md` bounded-fan-out
 * rule). `recordActivityEvents` collapses the whole batch into one transaction
 * — one `findMany` + one `createMany` per bind-budget slice — so the cost is
 * one connection regardless of batch size. A failure is reported and re-thrown,
 * rolling the caller's write back with it.
 */
function recordBatchStatusChanges(params: {
  tx: TransactionClient;
  organizationId: string;
  actorType: ArtifactActivityActorTypeValue;
  actorId: string | null;
  moved: Array<{ artifactId: string; before: string; after: string }>;
  provenance?: ArtifactStatusProvenance;
  transactionId?: string;
  undoOfTransactionId?: string;
}): Promise<void> {
  return recordBatchEvents({
    tx: params.tx,
    organizationId: params.organizationId,
    stage: ArtifactActivityCaptureStage.BatchStatus,
    field: ArtifactFieldEditField.Status,
    ...(params.actorId === null ? {} : { userId: params.actorId }),
    surface: params.provenance?.surface,
    transactionId: params.transactionId,
    undoOfTransactionId: params.undoOfTransactionId,
    events: params.moved.map((change) => ({
      artifactId: change.artifactId,
      actorType: params.actorType,
      actorId: params.actorId,
      action: ArtifactActivityAction.StatusChange,
      ...buildStatusChangeSnapshots({
        before: change.before,
        after: change.after,
        provenance: params.provenance,
        undoOfCommitGroupId: params.undoOfTransactionId,
      }),
    })),
  });
}

/**
 * Capture the status changes in a batch status update. The batch path only
 * mutates `status`, so this records a single `status_change` event per artifact
 * whose status actually moved. All events go through ONE batched insert so a
 * 500-item batch does not spawn 500 concurrent transactions on the write path.
 * Awaited inside the batch's own transaction.
 */
export async function captureBatchStatusChange(params: {
  /** The mutation's transaction; see this file's ATOMICITY note. */
  tx: TransactionClient;
  organizationId: string;
  changes: Array<{ artifactId: string; before: string; after: string }>;
  actor: ActivityActor;
  /**
   * Where the write came from, and the id shared by every row of this commit
   * (ISS-9436), so a receipt reader can tell a ten-row bulk change from ten
   * separate edits. One value rather than two, so the group id cannot go
   * missing from a grouped surface or appear on a single-row one.
   */
  provenance?: ArtifactStatusProvenance;
  /** {@link BulkTransactionCapture.transactionId}. */
  transactionId?: string;
  /** {@link BulkTransactionCapture.undoOfTransactionId}. */
  undoOfTransactionId?: string;
}): Promise<void> {
  const moved = params.changes.filter(
    (change) => change.before !== change.after
  );
  if (moved.length === 0) {
    return;
  }
  await recordBatchStatusChanges({
    tx: params.tx,
    organizationId: params.organizationId,
    actorType: resolveActorType(params.actor.authMethod),
    actorId: params.actor.userId,
    moved,
    provenance: params.provenance,
    transactionId: params.transactionId,
    undoOfTransactionId: params.undoOfTransactionId,
  });
}

/**
 * Capture the priority changes in a batch priority update, as one
 * `field_change` event per artifact that actually moved, through ONE batched
 * insert. Priority carries the `{ field, value }` envelope the single-artifact
 * path already uses, so the feed renders a bulk edit exactly like a single one.
 *
 * Both bulk and single paths have an audit-ledger counterpart:
 * `AuditAction.DocumentPriorityChanged`, emitted after their transaction
 * commits. ISS-9688 reasoned the opposite way and withheld the member from
 * artifacts entirely; ISS-9465 and ISS-10681 supersede that conclusion.
 * Awaited inside the write's own transaction.
 */
export async function captureBatchPriorityChange(params: {
  /** The mutation's transaction; see this file's ATOMICITY note. */
  tx: TransactionClient;
  organizationId: string;
  changes: Array<{
    artifactId: string;
    before: string | null;
    /** Null when the write CLEARS the priority (ISS-10332 single writes). */
    after: string | null;
  }>;
  actor: ActivityActor;
  /** Optional authoritative source for single-row and batch adapters. */
  provenance?: ArtifactStatusProvenance;
  /** Keep validated omission instead of inferring `bulk` from a transaction id. */
  preserveProvenanceOmission?: boolean;
  /** {@link BulkTransactionCapture.transactionId}. */
  transactionId?: string;
  /** Single-row adapters override the batch monitoring stage. */
  stage?: ArtifactActivityCaptureStage;
}): Promise<void> {
  const moved = params.changes.filter(
    (change) => change.before !== change.after
  );
  if (moved.length === 0) {
    return;
  }
  const actorType = resolveActorType(params.actor.authMethod);
  const context =
    params.provenance === undefined && !params.preserveProvenanceOmission
      ? bulkReceiptContext(params.transactionId, params.actor.authMethod)
      : receiptContext(params.provenance);
  await recordBatchEvents({
    tx: params.tx,
    organizationId: params.organizationId,
    stage: params.stage ?? ArtifactActivityCaptureStage.BatchPriority,
    field: ArtifactFieldEditField.Priority,
    userId: params.actor.userId,
    surface: context?.provenance?.surface,
    transactionId: params.transactionId ?? params.provenance?.commitGroupId,
    events: moved.map((change) => ({
      artifactId: change.artifactId,
      actorType,
      actorId: params.actor.userId,
      action: ArtifactActivityAction.FieldChange,
      ...buildArtifactFieldEditSnapshots({
        field: ArtifactFieldEditField.Priority,
        before: change.before,
        after: change.after,
        context,
      }),
    })),
  });
}

/**
 * One artifact's project transition in a batch move. `before` is null for an
 * artifact that had no project; `after` is the batch's target project, and is
 * null when the write CLEARS the project — `POST /agent-sessions/bulk-assign`
 * takes a nullable value, so "remove these sessions from their project" is a
 * real transition this receipt has to be able to name (ISS-9465).
 */
export type BatchProjectChange = {
  artifactId: string;
  before: string | null;
  after: string | null;
};

/**
 * Capture the project changes in a batch move (ISS-9158), as one
 * `field_change` event per artifact that actually changed project, through
 * ONE batched `recordActivityEvents` call, which slices the insert at the bind
 * budget itself: an uncapped `includeDownstream` move can carry thousands of
 * rows. Same `{ field: "projectId", value }` envelope the
 * single-artifact path emits, so the feed renders a bulk move exactly like a
 * single one. Emits for every moved row whatever its type: a project change
 * is a fact about the artifact, and the row is inert where no surface reads
 * it.
 *
 * Awaited inside the move's own transaction.
 */
export async function captureBatchProjectChange(params: {
  /** The mutation's transaction; see this file's ATOMICITY note. */
  tx: TransactionClient;
  organizationId: string;
  changes: BatchProjectChange[];
  actor: ActivityActor;
  provenance?: ArtifactStatusProvenance;
  /** Keep validated omission instead of inferring `bulk` from a transaction id. */
  preserveProvenanceOmission?: boolean;
  /** {@link BulkTransactionCapture.transactionId}. */
  transactionId?: string;
}): Promise<void> {
  const moved = params.changes.filter(
    (change) => change.before !== change.after
  );
  if (moved.length === 0) {
    return;
  }
  const actorType = resolveActorType(params.actor.authMethod);
  const context =
    params.provenance === undefined && !params.preserveProvenanceOmission
      ? bulkReceiptContext(params.transactionId, params.actor.authMethod)
      : receiptContext(params.provenance);
  await recordBatchEvents({
    tx: params.tx,
    organizationId: params.organizationId,
    stage: ArtifactActivityCaptureStage.BatchProject,
    field: ArtifactFieldEditField.ProjectId,
    userId: params.actor.userId,
    surface: context?.provenance?.surface,
    transactionId: params.transactionId,
    events: moved.map((change) => ({
      artifactId: change.artifactId,
      actorType,
      actorId: params.actor.userId,
      action: ArtifactActivityAction.FieldChange,
      ...buildArtifactFieldEditSnapshots({
        field: ArtifactFieldEditField.ProjectId,
        before: change.before,
        after: change.after,
        context,
      }),
    })),
  });
}

/**
 * Capture the creation of a new artifact. Records a single `creation` event
 * (no `before`) with an `after` snapshot of the created artifact's initial
 * status/title. Awaited inside the create's own transaction.
 */
export async function captureArtifactCreation(params: {
  /** The mutation's transaction; see this file's ATOMICITY note. */
  tx: TransactionClient;
  organizationId: string;
  artifactId: string;
  actor: ActivityActor;
  after: { status: string; title: string };
}): Promise<void> {
  await recordChanges({
    tx: params.tx,
    organizationId: params.organizationId,
    artifactId: params.artifactId,
    actorType: resolveActorType(params.actor.authMethod),
    actorId: params.actor.userId,
    stage: ArtifactActivityCaptureStage.Creation,
    changes: [
      {
        action: ArtifactActivityAction.Creation,
        before: null,
        after: { status: params.after.status, title: params.after.title },
      },
    ],
  });
}

/**
 * Capture the automated `BLOCKED` → `TODO` transitions the blocker-resolution
 * path performs (ISS-9632). Attributed to `system` with a null `actorId` —
 * `ArtifactActivityActorType.System` exists for exactly this ("the platform
 * itself … automated transitions"), so the feed can tell a status the platform
 * moved from one a human moved. A status that changes with no actor and no
 * audit row is indistinguishable from a bug.
 *
 * Same batched single-transaction insert as `captureBatchStatusChange`, so a
 * bulk triage that unblocks hundreds of dependents still costs one connection.
 * Awaited inside the chunk's own transaction.
 *
 * ONE function, where ISS-9632 needed two (`captureAutomatedUnblock` for the
 * request path plus `recordAutomatedUnblock` for the backfill script): the split
 * existed only because the request path went through `waitUntil`, which the
 * script had no request lifetime to flush. Nothing schedules now, so both
 * callers await the same thing.
 */
export async function captureAutomatedUnblock(params: {
  /** The unblock chunk's transaction; see this file's ATOMICITY note. */
  tx: TransactionClient;
  organizationId: string;
  changes: Array<{ artifactId: string; before: string; after: string }>;
}): Promise<void> {
  const moved = params.changes.filter(
    (change) => change.before !== change.after
  );
  if (moved.length === 0) {
    return;
  }
  await recordBatchStatusChanges({
    tx: params.tx,
    organizationId: params.organizationId,
    actorType: ArtifactActivityActorType.System,
    actorId: null,
    moved,
  });
}

/**
 * The transaction identity a BULK capture entry point carries (ISS-9465).
 * Declared once so each of them can point at one explanation of what the value
 * is and when it is absent.
 */
export type BulkTransactionCapture = {
  /**
   * The id every row of THIS bulk mutation carries, so a reader can tell one
   * fifty-row action from fifty separate edits. Absent on the single-artifact
   * paths, which have no transaction to group.
   */
  transactionId?: string;
  /**
   * The transaction these rows REVERSE (ISS-10458). Absent unless the write
   * came from an undo, which is most of them.
   */
  undoOfTransactionId?: string;
};

/**
 * The record-and-report body every BATCH capture shares: ONE tenant-scoped
 * batched insert on the caller's transaction, and a failure reported on the
 * monitored event name and then re-thrown, rolling back the write it describes.
 *
 * `stage` is required and never defaulted, for the reason the `creation` stage
 * was split out of `single_update`: a default files every batch path's loss
 * under one label, and an operator grouping by it cannot tell which path is
 * failing.
 */
async function recordBatchEvents(params: {
  tx: TransactionClient;
  organizationId: string;
  stage: ArtifactActivityCaptureStage;
  field: ArtifactFieldEditField;
  userId?: string;
  surface?: ArtifactStatusEditSurface;
  events: RecordActivityEventBatchRow[];
  transactionId?: string;
  undoOfTransactionId?: string;
}): Promise<void> {
  try {
    const inserted = await artifactActivityService.recordActivityEvents(
      {
        organizationId: params.organizationId,
        transactionId: params.transactionId,
        undoOfTransactionId: params.undoOfTransactionId,
        events: params.events,
      },
      params.tx
    );
    if (inserted !== params.events.length) {
      throw new Error(
        `artifact activity receipt cardinality mismatch: expected ${params.events.length}, inserted ${inserted}`
      );
    }
  } catch (error) {
    reportArtifactActivityCaptureFailure({
      stage: params.stage,
      organizationId: params.organizationId,
      ...(params.userId === undefined ? {} : { userId: params.userId }),
      rolledBackReceiptCount: params.events.length,
      field: params.field,
      ...(params.surface === undefined ? {} : { surface: params.surface }),
      ...(params.transactionId === undefined
        ? {}
        : { commitGroupId: params.transactionId }),
      ...(params.undoOfTransactionId === undefined
        ? {}
        : { undoOfCommitGroupId: params.undoOfTransactionId }),
      error,
    });
    throw error;
  }
}

/**
 * Capture a bulk tag application (ISS-9465), as one `field_change` event per
 * artifact that ACTUALLY GAINED the tag — never per requested id. The write is
 * a `createMany` with `skipDuplicates`, which reports a count and discards row
 * identity, so the caller differences the tag's rows inside its own write
 * transaction and passes the result here (ruling 1).
 *
 * `before` is absent rather than an empty tag set: the receipt records the one
 * tag this write ADDED and claims nothing about the tags the artifact already
 * carried. Awaited inside the tag write's own transaction.
 */
export function captureBatchTagApplied(params: {
  /** The mutation's transaction; see this file's ATOMICITY note. */
  tx: TransactionClient;
  organizationId: string;
  tagId: string;
  taggedArtifactIds: readonly string[];
  actor: ActivityActor;
  /** {@link BulkTransactionCapture.transactionId}. */
  transactionId?: string;
}): Promise<void> {
  return captureBatchTagMutation({
    ...params,
    artifactIds: params.taggedArtifactIds,
    removed: false,
  });
}

/** Records one in-transaction activity row per membership actually removed. */
export function captureBatchTagRemoved(params: {
  tx: TransactionClient;
  organizationId: string;
  tagId: string;
  untaggedArtifactIds: readonly string[];
  actor: ActivityActor;
  transactionId?: string;
}): Promise<void> {
  return captureBatchTagMutation({
    ...params,
    artifactIds: params.untaggedArtifactIds,
    removed: true,
  });
}

async function captureBatchTagMutation(params: {
  tx: TransactionClient;
  organizationId: string;
  tagId: string;
  artifactIds: readonly string[];
  actor: ActivityActor;
  transactionId?: string;
  removed: boolean;
}): Promise<void> {
  if (params.artifactIds.length === 0) {
    return;
  }
  const actorType = resolveActorType(params.actor.authMethod);
  await recordBatchEvents({
    tx: params.tx,
    organizationId: params.organizationId,
    stage: ArtifactActivityCaptureStage.BatchTag,
    field: ArtifactFieldEditField.Tag,
    userId: params.actor.userId,
    surface: bulkReceiptContext(params.transactionId, params.actor.authMethod)
      ?.provenance?.surface,
    transactionId: params.transactionId,
    events: params.artifactIds.map((artifactId) =>
      batchTagActivityEvent({
        artifactId,
        actorId: params.actor.userId,
        actorType,
        removed: params.removed,
        tagId: params.tagId,
        context: bulkReceiptContext(
          params.transactionId,
          params.actor.authMethod
        ),
      })
    ),
  });
}

function batchTagActivityEvent(params: {
  artifactId: string;
  actorId: string;
  actorType: ArtifactActivityActorTypeValue;
  removed: boolean;
  tagId: string;
  context?: ArtifactFieldEditReceiptContext;
}): RecordActivityEventBatchRow {
  const snapshots = buildArtifactFieldEditSnapshots({
    field: ArtifactFieldEditField.Tag,
    before: params.removed ? params.tagId : null,
    after: params.removed ? null : params.tagId,
    ...(params.context === undefined ? {} : { context: params.context }),
  });
  return {
    artifactId: params.artifactId,
    actorType: params.actorType,
    actorId: params.actorId,
    action: ArtifactActivityAction.FieldChange,
    ...(params.removed ? { before: snapshots.before } : {}),
    after: snapshots.after,
  };
}

/**
 * Capture a bulk artifact assignee assignment as one `assignment` event per
 * row whose owner actually moved. Sessions and documents share this artifact
 * field and receipt shape; a project move uses {@link captureBatchProjectChange}.
 *
 * The envelope names `assigneeId`, the field the document paths use, because a
 * session's Owner is its artifact assignee (ISS-12251 D-1). Receipts written
 * before that name `ownerUserId` and still render. Awaited inside the
 * assignment's own transaction.
 */
export async function captureBatchAssigneeAssignment(params: {
  /** The mutation's transaction; see this file's ATOMICITY note. */
  tx: TransactionClient;
  organizationId: string;
  changes: Array<{
    artifactId: string;
    before: string | null;
    after: string | null;
  }>;
  actor: ActivityActor;
  /** {@link BulkTransactionCapture.transactionId}. */
  transactionId?: string;
}): Promise<void> {
  const moved = params.changes.filter(
    (change) => change.before !== change.after
  );
  if (moved.length === 0) {
    return;
  }
  const actorType = resolveActorType(params.actor.authMethod);
  await recordBatchEvents({
    tx: params.tx,
    organizationId: params.organizationId,
    stage: ArtifactActivityCaptureStage.BatchAssign,
    field: ArtifactFieldEditField.AssigneeId,
    userId: params.actor.userId,
    surface: bulkReceiptContext(params.transactionId, params.actor.authMethod)
      ?.provenance?.surface,
    transactionId: params.transactionId,
    events: moved.map((change) => ({
      artifactId: change.artifactId,
      actorType,
      actorId: params.actor.userId,
      action: ArtifactActivityAction.Assignment,
      ...buildArtifactFieldEditSnapshots({
        field: ArtifactFieldEditField.AssigneeId,
        before: change.before,
        after: change.after,
        context: bulkReceiptContext(
          params.transactionId,
          params.actor.authMethod
        ),
      }),
    })),
  });
}

/** Compatibility name for the existing session bulk-assign consumer. */
export const captureBatchSessionOwnerAssignment =
  captureBatchAssigneeAssignment;

function receiptContext(
  provenance: ArtifactStatusProvenance | undefined
): ArtifactFieldEditReceiptContext | undefined {
  return provenance === undefined ? undefined : { provenance };
}

function bulkReceiptContext(
  transactionId: string | undefined,
  authMethod: ActivityActor["authMethod"],
  undoOfTransactionId?: string
): ArtifactFieldEditReceiptContext | undefined {
  if (transactionId === undefined || authMethod === "api_key") {
    return;
  }
  return {
    provenance: {
      surface: ArtifactStatusEditSurface.Bulk,
      commitGroupId: transactionId,
    },
    ...(undoOfTransactionId === undefined
      ? {}
      : { undoOfCommitGroupId: undoOfTransactionId }),
  };
}
