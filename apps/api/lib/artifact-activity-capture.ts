import "server-only";

import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
  type ArtifactActivityActorType as ArtifactActivityActorTypeValue,
  type RecordActivityEventInput,
} from "@repo/api/src/types/artifact-activity";
import type { JsonValue } from "@repo/api/src/types/common";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { artifactActivityService } from "@/app/documents/artifact-activity-service";

/**
 * Artifact activity capture at the write path (FEA-3864 / FEA-3535 Slice 2).
 *
 * Diffs the before/after of a document mutation and records one
 * `ArtifactActivityEvent` per changed field so the activity feed (Slice 3
 * endpoint) has a persisted trail. Both human (Clerk session / desktop session)
 * and agent (API-key / MCP) writes funnel through `PUT /documents/[id]` and
 * `POST /documents/batch-update-status`, so capturing here covers every actor.
 *
 * FAILURE-ISOLATION (load-bearing): capture is strictly best-effort and MUST
 * NEVER fail the user's write. Every entry point wraps the record calls so a
 * capture error (validation, DB, serialization) is logged and swallowed — the
 * mutation the user requested has already committed by the time we record.
 * Recording is also fire-and-forget via `waitUntil`, matching the assignment
 * notification dispatch precedent, so it never adds latency to the response.
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
  authMethod: "session" | "api_key" | "desktop_session";
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
  priority: string;
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
  after: CapturedArtifactFields
): FieldChange[] {
  const changes: FieldChange[] = [];

  if (before.status !== after.status) {
    changes.push({
      action: ArtifactActivityAction.StatusChange,
      before: before.status,
      after: after.status,
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
      action: ArtifactActivityAction.Assignment,
      before: { field: "assigneeId", value: before.assigneeId },
      after: { field: "assigneeId", value: after.assigneeId },
    });
  }

  if (before.approverId !== after.approverId) {
    changes.push({
      action: ArtifactActivityAction.Assignment,
      before: { field: "approverId", value: before.approverId },
      after: { field: "approverId", value: after.approverId },
    });
  }

  if (before.priority !== after.priority) {
    changes.push({
      action: ArtifactActivityAction.FieldChange,
      before: { field: "priority", value: before.priority },
      after: { field: "priority", value: after.priority },
    });
  }

  if (before.title !== after.title) {
    changes.push({
      action: ArtifactActivityAction.FieldChange,
      before: { field: "title", value: before.title },
      after: { field: "title", value: after.title },
    });
  }

  const beforeDue = toDateSnapshot(before.dueDate);
  const afterDue = toDateSnapshot(after.dueDate);
  if (beforeDue !== afterDue) {
    changes.push({
      action: ArtifactActivityAction.FieldChange,
      before: { field: "dueDate", value: beforeDue },
      after: { field: "dueDate", value: afterDue },
    });
  }

  if (before.projectId !== after.projectId) {
    changes.push({
      action: ArtifactActivityAction.FieldChange,
      before: { field: "projectId", value: before.projectId },
      after: { field: "projectId", value: after.projectId },
    });
  }

  return changes;
}

/**
 * Record all the events for a set of field changes, best-effort. Each record is
 * awaited inside a single try/catch: a failure is logged and swallowed so the
 * caller's write is never affected. Returns nothing — callers treat this as
 * fire-and-forget.
 */
async function recordChanges(params: {
  organizationId: string;
  artifactId: string;
  actorType: ArtifactActivityActorTypeValue;
  actorId: string | null;
  changes: FieldChange[];
}): Promise<void> {
  try {
    await Promise.all(
      params.changes.map((change) =>
        artifactActivityService.recordActivityEvent({
          organizationId: params.organizationId,
          artifactId: params.artifactId,
          actorType: params.actorType,
          actorId: params.actorId,
          action: change.action,
          before: change.before,
          after: change.after,
        })
      )
    );
  } catch (error) {
    log.error("Failed to record artifact activity events", {
      artifactId: params.artifactId,
      organizationId: params.organizationId,
      error: parseError(error),
    });
  }
}

/**
 * Capture the field changes on a document update. Diffs `before`/`after`,
 * resolves the actor, and schedules the record via `waitUntil` so it neither
 * blocks nor can fail the response. Safe to call unconditionally after a
 * successful `documentService.update` — a no-op diff records nothing.
 */
export function captureArtifactUpdate(params: {
  organizationId: string;
  artifactId: string;
  actor: ActivityActor;
  before: CapturedArtifactFields;
  after: CapturedArtifactFields;
}): void {
  try {
    const changes = diffArtifactFields(params.before, params.after);
    if (changes.length === 0) {
      return;
    }
    waitUntil(
      recordChanges({
        organizationId: params.organizationId,
        artifactId: params.artifactId,
        actorType: resolveActorType(params.actor.authMethod),
        actorId: params.actor.userId,
        changes,
      })
    );
  } catch (error) {
    // Belt-and-suspenders: diffing/scheduling itself must never throw into the
    // write path. `recordChanges` already isolates the DB failure; this guards
    // the synchronous setup.
    log.error("Failed to capture artifact update activity", {
      artifactId: params.artifactId,
      organizationId: params.organizationId,
      error: parseError(error),
    });
  }
}

/**
 * Record a batch of status-change events best-effort, in a SINGLE tenant-scoped
 * transaction. A batch status update can touch hundreds of artifacts; recording
 * one event per artifact through per-row transactions would open one pooled DB
 * connection per event and starve the pool (`apps/api/AGENTS.md` bounded-fan-out
 * rule). `recordActivityEvents` collapses the whole batch into one `findMany`
 * + one `createMany` inside one transaction, so the cost is one connection
 * regardless of batch size. Failures are logged and swallowed — the caller's
 * write already committed.
 */
async function recordBatchStatusChanges(params: {
  organizationId: string;
  actorType: ArtifactActivityActorTypeValue;
  actorId: string | null;
  moved: Array<{ artifactId: string; before: string; after: string }>;
}): Promise<void> {
  try {
    await artifactActivityService.recordActivityEvents({
      organizationId: params.organizationId,
      events: params.moved.map((change) => ({
        artifactId: change.artifactId,
        actorType: params.actorType,
        actorId: params.actorId,
        action: ArtifactActivityAction.StatusChange,
        before: change.before,
        after: change.after,
      })),
    });
  } catch (error) {
    log.error("Failed to record batch artifact activity events", {
      organizationId: params.organizationId,
      count: params.moved.length,
      error: parseError(error),
    });
  }
}

/**
 * Capture the status changes in a batch status update. The batch path only
 * mutates `status`, so this records a single `status_change` event per artifact
 * whose status actually moved. All events go through ONE batched insert so a
 * 500-item batch does not spawn 500 concurrent transactions on the write path.
 * Best-effort / non-blocking.
 */
export function captureBatchStatusChange(params: {
  organizationId: string;
  changes: Array<{ artifactId: string; before: string; after: string }>;
  actor: ActivityActor;
}): void {
  const moved = params.changes.filter(
    (change) => change.before !== change.after
  );
  if (moved.length === 0) {
    return;
  }
  waitUntil(
    recordBatchStatusChanges({
      organizationId: params.organizationId,
      actorType: resolveActorType(params.actor.authMethod),
      actorId: params.actor.userId,
      moved,
    })
  );
}

/**
 * Capture the creation of a new artifact. Records a single `creation` event
 * (no `before`) with an `after` snapshot of the created artifact's initial
 * status/title. Best-effort / non-blocking.
 */
export function captureArtifactCreation(params: {
  organizationId: string;
  artifactId: string;
  actor: ActivityActor;
  after: { status: string; title: string };
}): void {
  waitUntil(
    recordChanges({
      organizationId: params.organizationId,
      artifactId: params.artifactId,
      actorType: resolveActorType(params.actor.authMethod),
      actorId: params.actor.userId,
      changes: [
        {
          action: ArtifactActivityAction.Creation,
          before: null,
          after: { status: params.after.status, title: params.after.title },
        },
      ],
    })
  );
}
