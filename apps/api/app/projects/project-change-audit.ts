import { AuditAction, AuditObjectType } from "@repo/api/src/types/audit";
import type { Priority } from "@repo/api/src/types/common";
import type { ProjectStatus } from "@repo/api/src/types/project";
import {
  type AuditActor,
  type AuditEmitInput,
  dispatchAuditEvents,
} from "@/app/audit/audit-emit-service";

/**
 * ISS-9688: the project write path's audit receipt.
 *
 * `PUT /projects/:id` emitted NOTHING. A user changing a project's status or
 * priority — `useUpdateProjectPriority` is live on three surfaces — left no
 * entry in the audit ledger, while the equivalent document write had emitted
 * `document.status_changed` since FEA-3862. The ledger's job is to say what the
 * organization's records were and who moved them; a whole entity class missing
 * from it is not a gap in coverage, it is a ledger that answers wrongly.
 *
 * The activity FEED is deliberately NOT written here, and cannot be:
 * `artifact_activity_events.artifact_id` is a hard FK to `artifacts` and
 * `artifactActivityService` re-verifies org ownership against that table before
 * inserting, so a project id cannot be stored in it at all. Giving projects a
 * feed means a polymorphic subject on that table plus a project-scoped read
 * surface that does not exist today — a schema migration on a hot append-only
 * table and a product decision, not an implementation detail. It is filed as
 * ISS-10186 rather than invented here.
 *
 * Mirrors the documents route's contract exactly: emitted only on a REAL
 * transition (a field re-saved at the value it already held is not a change and
 * must not put a phantom entry on the chain), and non-blocking — the shared
 * `dispatchAuditEvents` enqueues onto the durable outbox via `waitUntil` and
 * never throws, so a ledger hiccup can neither fail nor delay the update the
 * user just made.
 */

/** The project fields this module audits, before and after the write. */
export type AuditedProjectFields = {
  status: ProjectStatus;
  /** `null` is "no priority"; a set or a clear is a transition like any other. */
  priority: Priority | null;
};

/**
 * Emit one audit event per audited project field that actually moved.
 *
 * ONE bulk enqueue, not a call per field: `dispatchAuditEvents` collapses both
 * possible events into a single `createMany`, so a write that moved status and
 * priority together costs one pooled insert rather than two concurrent ones
 * (`apps/api/AGENTS.md` — Bounded fan-out).
 */
export function dispatchProjectChangeAuditEvents(params: {
  organizationId: string;
  projectId: string;
  actor: AuditActor;
  before: AuditedProjectFields;
  after: AuditedProjectFields;
}): void {
  const events: AuditEmitInput[] = [];

  if (params.before.status !== params.after.status) {
    events.push({
      organizationId: params.organizationId,
      actor: params.actor,
      action: AuditAction.ProjectStatusChanged,
      objectType: AuditObjectType.Project,
      objectId: params.projectId,
      detail: { from: params.before.status, to: params.after.status },
    });
  }

  if (params.before.priority !== params.after.priority) {
    events.push({
      organizationId: params.organizationId,
      actor: params.actor,
      action: AuditAction.ProjectPriorityChanged,
      objectType: AuditObjectType.Project,
      objectId: params.projectId,
      detail: { from: params.before.priority, to: params.after.priority },
    });
  }

  // `dispatchAuditEvents` is already a no-op for an empty array, but returning
  // early keeps a no-op PUT from scheduling a `waitUntil` at all.
  if (events.length === 0) {
    return;
  }

  dispatchAuditEvents(events);
}
