import { ArtifactType } from "@repo/api/src/types/artifact";
import type { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { AuditAction } from "@repo/api/src/types/audit";
import type { ArtifactStatus } from "@repo/api/src/types/document";
import { statusOptionsForSubtype } from "@repo/api/src/types/document";
import type { ProjectArtifactPlacementRootUpdates } from "@repo/api/src/types/project-artifact-placement";
import { ProjectArtifactPlacementErrorReason } from "@repo/api/src/types/project-artifact-placement";
import { Status } from "@repo/api/src/types/result";
import type { ArtifactTagPermissions } from "@repo/api/src/types/tag";
import type { TransactionClient } from "@repo/database";
import { waitUntil } from "@vercel/functions";
import { buildBulkArtifactMutationAuditEvents } from "@/app/audit/artifact-mutation-audit-event";
import {
  dispatchAuditEvents,
  userAuditActor,
} from "@/app/audit/audit-emit-service";
import {
  captureBatchPriorityChange,
  captureBatchStatusChange,
} from "@/lib/artifact-activity-capture";
import { resolveStatusProvenance } from "@/lib/artifact-status-provenance";
import { chunksOf } from "@/lib/chunks-of";
import { reconcileLinkedPullRequestLabelsForArtifacts } from "@/lib/github/artifact-tag-label-reconciliation";
import { isUserInOrganization } from "@/lib/user-org-membership";
import { emitBatchPrioritySideEffects } from "./batch-priority-side-effects";
import { emitBatchStatusSideEffects } from "./batch-status-side-effects";
import type { PlacementError } from "./project-artifact-placement-service";
import type {
  PlacementActor,
  PlacementRootFieldSnapshot,
} from "./project-artifact-placement-service-support";

/** Read the root fields carried by a placement receipt, including tag identity. */
export async function readPlacementRootFields(
  tx: TransactionClient,
  organizationId: string,
  artifactIds: readonly string[],
  includeAllTypes = false
): Promise<PlacementRootFieldSnapshot[]> {
  const rows = await tx.artifact.findMany({
    where: {
      id: { in: [...artifactIds] },
      organizationId,
      ...placementTypeFilter(includeAllTypes),
    },
    select: {
      id: true,
      status: true,
      assigneeId: true,
      priority: true,
      tagArtifacts: { select: { tagId: true } },
    },
  });
  return rows
    .map((row) => ({
      artifactId: row.id,
      status: row.status,
      assigneeId: row.assigneeId,
      priority: row.priority,
      tagIds: row.tagArtifacts.map((tag) => tag.tagId).sort(),
    }))
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
}

/** Refuse unauthorized or unavailable field changes before the placement write. */
export async function validatePlacementRootFields(
  tx: TransactionClient,
  organizationId: string,
  artifactIds: readonly string[],
  before: readonly PlacementRootFieldSnapshot[],
  after: readonly PlacementRootFieldSnapshot[],
  permissions: ArtifactTagPermissions | undefined,
  includeAllTypes = false
): Promise<PlacementError | null> {
  if (
    before.length !== artifactIds.length ||
    after.length !== artifactIds.length
  ) {
    return invalidRootFields(
      "A selected artifact does not support this field update"
    );
  }
  const beforeById = new Map(before.map((row) => [row.artifactId, row]));
  const afterById = new Map(after.map((row) => [row.artifactId, row]));
  const rows = await tx.artifact.findMany({
    where: {
      id: { in: [...artifactIds] },
      organizationId,
      ...placementTypeFilter(includeAllTypes),
    },
    select: { id: true, type: true, subtype: true },
  });
  if (rows.length !== artifactIds.length) {
    return invalidRootFields(
      "A selected artifact does not support this field update"
    );
  }
  for (const row of rows) {
    const previous = beforeById.get(row.id);
    const next = afterById.get(row.id);
    if (!(previous && next)) {
      return invalidRootFields(
        "A selected artifact does not support this field update"
      );
    }
    const fieldError = validateRootFieldChange(
      row.type,
      row.subtype,
      previous,
      next,
      permissions
    );
    if (fieldError) {
      return fieldError;
    }
  }
  const assigneeIds = [
    ...new Set(
      after.flatMap((row) => (row.assigneeId ? [row.assigneeId] : []))
    ),
  ];
  for (const assigneeId of assigneeIds) {
    if (!(await isUserInOrganization(tx, assigneeId, organizationId))) {
      return invalidRootFields("The assignee is not in this organization");
    }
  }
  const tagIds = [...new Set(after.flatMap((row) => row.tagIds))];
  if (tagIds.length > 0) {
    const count = await tx.tag.count({
      where: { id: { in: tagIds }, organizationId },
    });
    if (count !== tagIds.length) {
      return invalidRootFields("A tag is not in this organization");
    }
  }
  return null;
}

/** Apply a validated root field projection in the caller's placement transaction. */
export async function writePlacementRootFields(
  tx: TransactionClient,
  organizationId: string,
  before: readonly PlacementRootFieldSnapshot[],
  after: readonly PlacementRootFieldSnapshot[],
  activity?: {
    actor: PlacementActor;
    transactionId: string;
    undoOfTransactionId?: string;
    surface?: typeof ArtifactStatusEditSurface.Board;
  },
  includeAllTypes = false
): Promise<void> {
  const beforeById = new Map(before.map((row) => [row.artifactId, row]));
  const scalarGroups = new Map<string, PlacementRootFieldSnapshot[]>();
  const tagged: PlacementRootFieldSnapshot[] = [];
  for (const row of after) {
    const previous = beforeById.get(row.artifactId);
    if (!previous) {
      throw new Error("Placement root field snapshot is incomplete");
    }
    if (
      previous.status !== row.status ||
      previous.assigneeId !== row.assigneeId ||
      previous.priority !== row.priority
    ) {
      const key = JSON.stringify([row.status, row.assigneeId, row.priority]);
      const group = scalarGroups.get(key) ?? [];
      group.push(row);
      scalarGroups.set(key, group);
    }
    if (JSON.stringify(previous.tagIds) !== JSON.stringify(row.tagIds)) {
      tagged.push(row);
    }
  }
  for (const group of scalarGroups.values()) {
    const target = group[0];
    if (!target) {
      continue;
    }
    const artifactIds = group.map((row) => row.artifactId);
    const updated = await tx.artifact.updateMany({
      where: {
        id: { in: artifactIds },
        organizationId,
        ...placementTypeFilter(includeAllTypes),
      },
      data: {
        status: target.status,
        assigneeId: target.assigneeId,
        priority: target.priority,
      },
    });
    if (updated.count !== artifactIds.length) {
      throw new Error("Placement root field write did not reconcile");
    }
    const projectedIds = group
      .filter((row) => {
        const previous = beforeById.get(row.artifactId);
        return (
          previous?.assigneeId !== row.assigneeId ||
          previous?.priority !== row.priority
        );
      })
      .map((row) => row.artifactId);
    if (projectedIds.length > 0) {
      await tx.searchDocument.updateMany({
        where: { entityId: { in: projectedIds }, organizationId },
        data: { assigneeId: target.assigneeId, priority: target.priority },
      });
    }
  }
  for (const group of chunksOf(tagged, 250)) {
    await tx.tagArtifact.deleteMany({
      where: {
        artifactId: { in: group.map((row) => row.artifactId) },
        artifact: { organizationId },
      },
    });
  }
  const tagRows = tagged.flatMap((row) =>
    row.tagIds.map((tagId) => ({ tagId, artifactId: row.artifactId }))
  );
  for (const group of chunksOf(tagRows, 1000)) {
    await tx.tagArtifact.createMany({ data: group });
  }
  if (activity) {
    await captureBatchStatusChange({
      tx,
      organizationId,
      actor: activity.actor,
      transactionId: activity.transactionId,
      undoOfTransactionId: activity.undoOfTransactionId,
      provenance: resolveStatusProvenance({
        surface: activity.surface,
        authMethod: activity.actor.authMethod,
        commitGroupId: activity.transactionId,
      }),
      changes: after.map((row) => ({
        artifactId: row.artifactId,
        before: beforeById.get(row.artifactId)?.status ?? row.status,
        after: row.status,
      })),
    });
    await captureBatchPriorityChange({
      tx,
      organizationId,
      actor: activity.actor,
      transactionId: activity.transactionId,
      changes: after.map((row) => ({
        artifactId: row.artifactId,
        before: beforeById.get(row.artifactId)?.priority ?? null,
        after: row.priority,
      })),
    });
  }
}

export function placementRootFieldsAfter(
  before: readonly PlacementRootFieldSnapshot[],
  updates: ProjectArtifactPlacementRootUpdates
): PlacementRootFieldSnapshot[] {
  return before.map((row) => ({
    ...row,
    status: updates.status ?? row.status,
    assigneeId:
      updates.assigneeId === undefined ? row.assigneeId : updates.assigneeId,
    priority: updates.priority === undefined ? row.priority : updates.priority,
    tagIds:
      updates.tagIds === undefined ? row.tagIds : [...updates.tagIds].sort(),
  }));
}

export type PlacementRootFieldCommit = {
  before: readonly PlacementRootFieldSnapshot[];
  after: readonly PlacementRootFieldSnapshot[];
  actor: PlacementActor;
  organizationId: string;
  transactionId: string;
  documentArtifactIds?: readonly string[];
  undoOfTransactionId?: string;
  surface?: typeof ArtifactStatusEditSurface.Board;
};

/** Emit the canonical audit and analytics work only after the placement commits. */
export async function emitPlacementRootFieldEffects(
  commit: PlacementRootFieldCommit
): Promise<void> {
  const beforeById = new Map(commit.before.map((row) => [row.artifactId, row]));
  const user = {
    id: commit.actor.userId,
    organizationId: commit.organizationId,
  };
  const statuses = new Map<string, PlacementRootFieldSnapshot[]>();
  const priorities = new Map<
    PlacementRootFieldSnapshot["priority"],
    PlacementRootFieldSnapshot[]
  >();
  const documentArtifactIds = new Set(
    commit.documentArtifactIds ?? commit.after.map((row) => row.artifactId)
  );
  const changedTagArtifactIds: string[] = [];
  for (const row of commit.after) {
    const previous = beforeById.get(row.artifactId);
    if (JSON.stringify(previous?.tagIds) !== JSON.stringify(row.tagIds)) {
      changedTagArtifactIds.push(row.artifactId);
    }
    if (previous?.status !== row.status) {
      const group = statuses.get(row.status) ?? [];
      group.push(row);
      statuses.set(row.status, group);
    }
    if (
      previous?.priority !== row.priority &&
      documentArtifactIds.has(row.artifactId)
    ) {
      const group = priorities.get(row.priority) ?? [];
      group.push(row);
      priorities.set(row.priority, group);
    }
  }
  scheduleTagReconciliation(commit.organizationId, changedTagArtifactIds);
  for (const [status, rows] of statuses) {
    await emitBatchStatusSideEffects({
      user,
      authMethod: commit.actor.authMethod,
      status: status as ArtifactStatus,
      surface: commit.surface,
      transactionId: commit.transactionId,
      undoOfTransactionId: commit.undoOfTransactionId,
      changedIds: rows.map((row) => row.artifactId),
      transitions: rows.map((row) => ({
        documentId: row.artifactId,
        before: (beforeById.get(row.artifactId)?.status ??
          row.status) as ArtifactStatus,
        after: status as ArtifactStatus,
      })),
    });
  }
  for (const [priority, rows] of priorities) {
    const changedIds = rows.map((row) => row.artifactId);
    const beforePriorities = new Map(
      rows.map(
        (row) =>
          [
            row.artifactId,
            beforeById.get(row.artifactId)?.priority ?? null,
          ] as const
      )
    );
    if (priority === null) {
      try {
        dispatchAuditEvents(
          buildBulkArtifactMutationAuditEvents({
            organizationId: commit.organizationId,
            actor: userAuditActor(commit.actor.userId),
            changes: changedIds.map((id) => ({
              action: AuditAction.DocumentPriorityChanged,
              objectId: id,
              before: beforePriorities.get(id) ?? null,
              after: null,
            })),
            transactionId: commit.transactionId,
          })
        );
      } catch {
        // A committed placement must not fail on best-effort audit dispatch.
      }
    } else {
      emitBatchPrioritySideEffects({
        user,
        authMethod: commit.actor.authMethod,
        priority,
        surface: undefined,
        changedIds,
        beforePriorities,
        transactionId: commit.transactionId,
      });
    }
  }
}

function scheduleTagReconciliation(
  organizationId: string,
  artifactIds: string[]
): void {
  if (artifactIds.length === 0) {
    return;
  }
  waitUntil(
    reconcileLinkedPullRequestLabelsForArtifacts({
      organizationId,
      artifactIds,
    })
  );
}

function validateRootFieldChange(
  type: ArtifactType,
  subtype: Parameters<typeof statusOptionsForSubtype>[0],
  previous: PlacementRootFieldSnapshot,
  next: PlacementRootFieldSnapshot,
  permissions: ArtifactTagPermissions | undefined
): PlacementError | null {
  if (
    previous.status !== next.status &&
    (type !== ArtifactType.Document ||
      !statusOptionsForSubtype(subtype).some(
        (status) => status === next.status
      ))
  ) {
    return invalidRootFields(
      "Status is source-managed or is not valid for this artifact"
    );
  }
  if (
    previous.assigneeId !== next.assigneeId &&
    type !== ArtifactType.Document &&
    type !== ArtifactType.Session
  ) {
    return invalidRootFields(
      "A selected artifact does not support this field update"
    );
  }
  if (
    previous.priority !== next.priority &&
    type !== ArtifactType.Document &&
    type !== ArtifactType.Session &&
    type !== ArtifactType.Branch
  ) {
    return invalidRootFields(
      "A selected artifact does not support this field update"
    );
  }
  const oldTags = new Set(previous.tagIds);
  const newTags = new Set(next.tagIds);
  if (
    (!permissions?.canApply && next.tagIds.some((id) => !oldTags.has(id))) ||
    (!permissions?.canRemove && previous.tagIds.some((id) => !newTags.has(id)))
  ) {
    return {
      status: Status.Forbidden,
      message: "Forbidden",
      detail: {
        reason: ProjectArtifactPlacementErrorReason.PermissionDenied,
      },
    };
  }
  return null;
}

function invalidRootFields(message: string): PlacementError {
  return {
    status: Status.BadRequest,
    message,
    detail: { reason: ProjectArtifactPlacementErrorReason.InvalidRequest },
  };
}

function placementTypeFilter(includeAllTypes: boolean) {
  return includeAllTypes ? {} : { type: ArtifactType.Document };
}
