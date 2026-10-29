/**
 * The undoable-command registry (ISS-9089).
 *
 * One entry per member of `UndoMutationKind`, declared with `satisfies` over an
 * exhaustive `Record`. A new mutation kind fails `tsc` here until it says
 * whether it is undoable — the registry is never consulted through a lookup
 * that can return `undefined`, because an un-registered mutation resolving to
 * `undefined` reads at the call site as a successful no-op undo.
 *
 * Every inverse below is a real `apps/api` request. None of them mutate client
 * state directly.
 */

import { z } from "zod";
import { ApiKeyScope } from "./api-key.ts";
import {
  ARTIFACT_BULK_ACTION_SCOPE,
  ArtifactBulkAction,
} from "./artifact-bulk-action.ts";
import { BatchMutationRoute } from "./batch-mutation-routes.ts";
import { Priority } from "./common.ts";
import { DocumentStatus, IssueStatus } from "./document.ts";
import { TagEntityType } from "./tag.ts";
import {
  requireBatchableEntityIds,
  requireEntityIds,
  requireForwardChangedIds,
  requireNullableStringValue,
  requireStringValue,
  requireSubject,
  requireUniformStringValue,
  type UndoApiCall,
  UndoApiMethod,
  type UndoCommandContext,
  type UndoCommandValue,
  UndoEntityType,
  UndoMutationKind,
  type UndoRegistryEntry,
  undoOfTransactionBody,
} from "./undo-command.ts";

/**
 * A captured status/priority must be a member of the vocabulary the route it
 * will be replayed against accepts (`anyArtifactStatusEnum` / `priorityEnum` in
 * `apps/api/app/documents/validators.ts`). A bare `z.string()` would let a
 * typo'd capture pass this contract and only fail as a 400 at undo time.
 */
const statusValueSchema: z.ZodType<UndoCommandValue> = z.enum([
  ...Object.values(DocumentStatus),
  ...Object.values(IssueStatus),
]);
/**
 * ISS-9665: nullable. `PUT /documents/{id}` accepts `priority: null` to CLEAR
 * the field, so a clear captures a null `newValue` and the first set on an
 * unset artifact captures a null `priorValue`. A non-null schema rejects the
 * former while the log is being written and throws building the latter's
 * inverse — an undo the user was already offered. Same shape, and the same
 * reason, as `assigneeValueSchema` below.
 */
const priorityValueSchema: z.ZodType<UndoCommandValue> = z
  .enum(Object.values(Priority))
  .nullable();
/**
 * `PUT /documents/{id}` validates `assigneeId` with `z.uuid().nullable()`, so a
 * non-UUID capture is a 400 waiting to happen at undo time. Matching the route
 * here rejects it while the log is still being written, when the mutation can
 * still be declared un-loggable, rather than at replay when the user has
 * already been offered the undo.
 */
const assigneeValueSchema: z.ZodType<UndoCommandValue> = z.uuid().nullable();
const tagMembershipValueSchema: z.ZodType<UndoCommandValue> = z.boolean();

function countedItems(count: number): string {
  return `${count} ${count === 1 ? "item" : "items"}`;
}

/**
 * `PUT /documents/{id}` with a single artifact field. The three field-change
 * commands differ only in which key they send, so they share this builder.
 */
function artifactFieldCalls(
  context: UndoCommandContext,
  field: string,
  read: (entityId: string) => UndoCommandValue
): readonly UndoApiCall[] {
  return requireEntityIds(context).map((entityId) => ({
    method: UndoApiMethod.Put,
    path: `/documents/${entityId}`,
    requiredScope: ApiKeyScope.Write,
    body: { [field]: read(entityId) },
  }));
}

function entityTagApplyCall(
  context: UndoCommandContext,
  kind: UndoMutationKind,
  entityId: string
): UndoApiCall {
  const subject = requireSubject(context, kind);
  return {
    method: UndoApiMethod.Post,
    path: "/entity-tags",
    requiredScope: ApiKeyScope.Write,
    body: {
      tagId: subject.id,
      entityType: TagEntityType.Artifact,
      entityId,
    },
  };
}

function entityTagRemoveCall(
  context: UndoCommandContext,
  kind: UndoMutationKind,
  entityId: string
): UndoApiCall {
  const subject = requireSubject(context, kind);
  const query = new URLSearchParams({
    tagId: subject.id,
    entityType: TagEntityType.Artifact,
    entityId,
  });
  return {
    method: UndoApiMethod.Delete,
    path: `/entity-tags?${query.toString()}`,
    requiredScope: ApiKeyScope.Delete,
  };
}

/** Builds one bounded tag batch call, or no call when the forward changed none. */
function batchTagCall(
  context: UndoCommandContext,
  kind: UndoMutationKind,
  path: string,
  requiredScope: ApiKeyScope,
  entityIds: readonly string[]
): readonly UndoApiCall[] {
  if (entityIds.length === 0) {
    return [];
  }
  return [
    {
      method: UndoApiMethod.Post,
      path,
      requiredScope,
      body: {
        tagId: requireSubject(context, kind).id,
        entityType: TagEntityType.Artifact,
        entityIds: [...entityIds],
      },
    },
  ];
}

/**
 * Undoing a bulk status change cannot send one status for the whole selection —
 * the rows were not all at the same status before. Group the ids by the status
 * each individually held and issue one batch call per group.
 *
 * EVERY group carries the same `undoOfTransactionId` (ISS-10458). The forward
 * was one commit however many statuses its rows came from, so one group naming
 * it and the rest not would split the undo's own receipts into a traceable part
 * and an untraceable one — which is the partial-run failure this ticket exists
 * to prevent, produced by the undo instead of by the forward.
 */
function bulkStatusInverseCalls(
  context: UndoCommandContext
): readonly UndoApiCall[] {
  const byPriorStatus = new Map<string, string[]>();
  // Guarding the whole selection covers every group: each group is a subset, so
  // no group can exceed a limit the total already respects.
  const entityIds = requireBatchableEntityIds(
    context,
    UndoMutationKind.ArtifactBulkStatusChange
  );
  for (const entityId of entityIds) {
    const prior = requireStringValue(
      context.priorValue,
      entityId,
      UndoMutationKind.ArtifactBulkStatusChange
    );
    const group = byPriorStatus.get(prior);
    if (group) {
      group.push(entityId);
    } else {
      byPriorStatus.set(prior, [entityId]);
    }
  }
  const undoOf = undoOfTransactionBody(context);
  return [...byPriorStatus].map(([status, documentIds]) => ({
    method: UndoApiMethod.Post,
    path: "/documents/batch-update-status",
    requiredScope: ApiKeyScope.Write,
    body: { documentIds, status, ...undoOf },
  }));
}

const artifactStatusChange: UndoRegistryEntry = {
  kind: UndoMutationKind.ArtifactStatusChange,
  undoable: true,
  entityType: UndoEntityType.Artifact,
  valueSchema: statusValueSchema,
  label: (context) =>
    `Change status of ${countedItems(context.entity.ids.length)}`,
  forward: (context) =>
    artifactFieldCalls(context, "status", (entityId) =>
      requireStringValue(
        context.newValue,
        entityId,
        UndoMutationKind.ArtifactStatusChange
      )
    ),
  inverse: (context) =>
    artifactFieldCalls(context, "status", (entityId) =>
      requireStringValue(
        context.priorValue,
        entityId,
        UndoMutationKind.ArtifactStatusChange
      )
    ),
};

const artifactPriorityChange: UndoRegistryEntry = {
  kind: UndoMutationKind.ArtifactPriorityChange,
  undoable: true,
  entityType: UndoEntityType.Artifact,
  valueSchema: priorityValueSchema,
  label: (context) =>
    `Change priority of ${countedItems(context.entity.ids.length)}`,
  forward: (context) =>
    artifactFieldCalls(context, "priority", (entityId) =>
      requireNullableStringValue(
        context.newValue,
        entityId,
        UndoMutationKind.ArtifactPriorityChange
      )
    ),
  inverse: (context) =>
    artifactFieldCalls(context, "priority", (entityId) =>
      requireNullableStringValue(
        context.priorValue,
        entityId,
        UndoMutationKind.ArtifactPriorityChange
      )
    ),
};

const artifactAssigneeChange: UndoRegistryEntry = {
  kind: UndoMutationKind.ArtifactAssigneeChange,
  undoable: true,
  entityType: UndoEntityType.Artifact,
  valueSchema: assigneeValueSchema,
  label: (context) =>
    `Change assignee of ${countedItems(context.entity.ids.length)}`,
  forward: (context) =>
    artifactFieldCalls(context, "assigneeId", (entityId) =>
      requireNullableStringValue(
        context.newValue,
        entityId,
        UndoMutationKind.ArtifactAssigneeChange
      )
    ),
  inverse: (context) =>
    artifactFieldCalls(context, "assigneeId", (entityId) =>
      requireNullableStringValue(
        context.priorValue,
        entityId,
        UndoMutationKind.ArtifactAssigneeChange
      )
    ),
};

const artifactTagApply: UndoRegistryEntry = {
  kind: UndoMutationKind.ArtifactTagApply,
  undoable: true,
  entityType: UndoEntityType.Artifact,
  valueSchema: tagMembershipValueSchema,
  label: (context) =>
    `Apply tag "${requireSubject(context, UndoMutationKind.ArtifactTagApply).label}"`,
  forward: (context) =>
    requireEntityIds(context).map((entityId) =>
      entityTagApplyCall(context, UndoMutationKind.ArtifactTagApply, entityId)
    ),
  inverse: (context) =>
    requireForwardChangedIds(context, UndoMutationKind.ArtifactTagApply).map(
      (entityId) =>
        entityTagRemoveCall(
          context,
          UndoMutationKind.ArtifactTagApply,
          entityId
        )
    ),
};

const artifactTagRemove: UndoRegistryEntry = {
  kind: UndoMutationKind.ArtifactTagRemove,
  undoable: true,
  entityType: UndoEntityType.Artifact,
  valueSchema: tagMembershipValueSchema,
  label: (context) =>
    `Remove tag "${requireSubject(context, UndoMutationKind.ArtifactTagRemove).label}"`,
  forward: (context) =>
    requireEntityIds(context).map((entityId) =>
      entityTagRemoveCall(context, UndoMutationKind.ArtifactTagRemove, entityId)
    ),
  inverse: (context) =>
    requireForwardChangedIds(context, UndoMutationKind.ArtifactTagRemove).map(
      (entityId) =>
        entityTagApplyCall(
          context,
          UndoMutationKind.ArtifactTagRemove,
          entityId
        )
    ),
};

const artifactBulkStatusChange: UndoRegistryEntry = {
  kind: UndoMutationKind.ArtifactBulkStatusChange,
  undoable: true,
  entityType: UndoEntityType.Artifact,
  valueSchema: statusValueSchema,
  label: (context) =>
    `Change status of ${countedItems(context.entity.ids.length)}`,
  forward: (context) => {
    const entityIds = requireBatchableEntityIds(
      context,
      UndoMutationKind.ArtifactBulkStatusChange
    );
    return [
      {
        method: UndoApiMethod.Post,
        path: "/documents/batch-update-status",
        requiredScope: ApiKeyScope.Write,
        body: {
          documentIds: [...entityIds],
          // One call, one status: `requireUniformStringValue` rejects a context
          // whose per-entity targets disagree instead of promoting the first
          // id's status to the whole selection.
          status: requireUniformStringValue(
            context.newValue,
            entityIds,
            UndoMutationKind.ArtifactBulkStatusChange
          ),
        },
      },
    ];
  },
  inverse: bulkStatusInverseCalls,
};

const artifactBulkTagApply: UndoRegistryEntry = {
  kind: UndoMutationKind.ArtifactBulkTagApply,
  undoable: true,
  entityType: UndoEntityType.Artifact,
  valueSchema: tagMembershipValueSchema,
  label: (context) =>
    `Apply tag "${requireSubject(context, UndoMutationKind.ArtifactBulkTagApply).label}" to ${countedItems(context.entity.ids.length)}`,
  forward: (context) =>
    batchTagCall(
      context,
      UndoMutationKind.ArtifactBulkTagApply,
      BatchMutationRoute.EntityTags,
      ApiKeyScope.Write,
      requireBatchableEntityIds(context, UndoMutationKind.ArtifactBulkTagApply)
    ),
  inverse: (context) =>
    requireForwardChangedIds(
      context,
      UndoMutationKind.ArtifactBulkTagApply
    ).map((entityId) =>
      entityTagRemoveCall(
        context,
        UndoMutationKind.ArtifactBulkTagApply,
        entityId
      )
    ),
};

const artifactBulkTagRemove: UndoRegistryEntry = {
  kind: UndoMutationKind.ArtifactBulkTagRemove,
  undoable: true,
  entityType: UndoEntityType.Artifact,
  valueSchema: tagMembershipValueSchema,
  label: (context) =>
    `Remove tag "${requireSubject(context, UndoMutationKind.ArtifactBulkTagRemove).label}" from ${countedItems(context.entity.ids.length)}`,
  forward: (context) =>
    batchTagCall(
      context,
      UndoMutationKind.ArtifactBulkTagRemove,
      `${BatchMutationRoute.EntityTagsRemove}/v2`,
      ARTIFACT_BULK_ACTION_SCOPE[ArtifactBulkAction.RemoveTag],
      requireBatchableEntityIds(context, UndoMutationKind.ArtifactBulkTagRemove)
    ),
  inverse: (context) =>
    batchTagCall(
      context,
      UndoMutationKind.ArtifactBulkTagRemove,
      BatchMutationRoute.EntityTags,
      ApiKeyScope.Write,
      requireForwardChangedIds(context, UndoMutationKind.ArtifactBulkTagRemove)
    ),
};

const artifactBulkDelete: UndoRegistryEntry = {
  kind: UndoMutationKind.ArtifactBulkDelete,
  undoable: false,
  reason:
    "Deleting an artifact cascades its links, versions and activity rows; apps/api exposes no restore endpoint, so there is no server-side inverse.",
};

const artifactMerge: UndoRegistryEntry = {
  kind: UndoMutationKind.ArtifactMerge,
  undoable: false,
  reason:
    "Merging deletes the secondary artifact and rewrites the primary's content through a generation step; apps/api exposes no un-merge endpoint.",
};

/**
 * The exhaustive registry. `satisfies` rather than an annotation, for two
 * reasons that both matter: a missing key is still a `tsc` error at this
 * declaration (never an `undefined` at a call site), AND the inferred type keeps
 * the literal key set, so `keyof typeof UNDO_COMMAND_REGISTRY` reports what is
 * actually declared here. Under a `Record<UndoMutationKind, …>` annotation that
 * `keyof` is `UndoMutationKind` by definition, which makes every downstream
 * key-coverage guard vacuous.
 */
export const UNDO_COMMAND_REGISTRY = {
  [UndoMutationKind.ArtifactStatusChange]: artifactStatusChange,
  [UndoMutationKind.ArtifactPriorityChange]: artifactPriorityChange,
  [UndoMutationKind.ArtifactAssigneeChange]: artifactAssigneeChange,
  [UndoMutationKind.ArtifactTagApply]: artifactTagApply,
  [UndoMutationKind.ArtifactTagRemove]: artifactTagRemove,
  [UndoMutationKind.ArtifactBulkStatusChange]: artifactBulkStatusChange,
  [UndoMutationKind.ArtifactBulkTagApply]: artifactBulkTagApply,
  [UndoMutationKind.ArtifactBulkTagRemove]: artifactBulkTagRemove,
  [UndoMutationKind.ArtifactBulkDelete]: artifactBulkDelete,
  [UndoMutationKind.ArtifactMerge]: artifactMerge,
} satisfies Record<UndoMutationKind, UndoRegistryEntry>;

/**
 * Resolve a mutation kind to its registry entry.
 *
 * Total by construction: the parameter is `UndoMutationKind` and the registry
 * is exhaustive over it, so this never returns `undefined` and callers never
 * have to decide what an unknown mutation means.
 */
export function undoRegistryEntryFor(
  kind: UndoMutationKind
): UndoRegistryEntry {
  return UNDO_COMMAND_REGISTRY[kind];
}
