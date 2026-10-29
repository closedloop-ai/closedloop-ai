/**
 * Undoable-command contract (ISS-9089).
 *
 * The canonical, single-source declaration of how an artifact mutation says
 * "I can be undone". Shared by `apps/app` (which dispatches the inverse) and
 * `apps/api` (which owns the routes the inverse calls), so it lives here rather
 * than co-located in either app.
 *
 * Scope boundary: this module is a CONTRACT only — no UI, no keybinding, no
 * persistence. The Yjs/Liveblocks editor path is explicitly excluded; it has
 * its own `UndoManager` and is never wrapped by this registry.
 *
 * An inverse is always expressed as a real `apps/api` request descriptor, never
 * as a client-side state rollback: a rollback would leave the server holding
 * the post-mutation value while the client rendered the pre-mutation one.
 */

import type { z } from "zod";
import type { ApiKeyScope } from "./api-key.ts";
import { BATCH_MUTATION_ENTITY_LIMIT } from "./batch-mutation-limits.ts";
import type { JsonValue } from "./common.ts";

/**
 * Every artifact-table mutation the undo system knows about — including the
 * ones that are NOT undoable.
 *
 * This set is deliberately wider than "the undoable ones". The registry is an
 * exhaustive `Record` over it, so adding a member here fails `tsc` until it
 * declares undoability one way or the other. A registry keyed only by the
 * undoable subset would let a new mutation resolve to `undefined`, which reads
 * at the call site as a successful no-op undo.
 */
export const UndoMutationKind = {
  ArtifactStatusChange: "artifact_status_change",
  ArtifactPriorityChange: "artifact_priority_change",
  ArtifactAssigneeChange: "artifact_assignee_change",
  ArtifactTagApply: "artifact_tag_apply",
  ArtifactTagRemove: "artifact_tag_remove",
  ArtifactBulkStatusChange: "artifact_bulk_status_change",
  ArtifactBulkTagApply: "artifact_bulk_tag_apply",
  ArtifactBulkTagRemove: "artifact_bulk_tag_remove",
  ArtifactBulkDelete: "artifact_bulk_delete",
  ArtifactMerge: "artifact_merge",
} as const;
export type UndoMutationKind =
  (typeof UndoMutationKind)[keyof typeof UndoMutationKind];

/** The kind of record an undoable command acts on. */
export const UndoEntityType = {
  Artifact: "ARTIFACT",
} as const;
export type UndoEntityType =
  (typeof UndoEntityType)[keyof typeof UndoEntityType];

/** HTTP methods an inverse may use against `apps/api`. */
export const UndoApiMethod = {
  Post: "POST",
  Put: "PUT",
  Delete: "DELETE",
} as const;
export type UndoApiMethod = (typeof UndoApiMethod)[keyof typeof UndoApiMethod];

/**
 * The entity identity a command acted on. Carried so a later conflict check can
 * ask "has anyone else touched these rows since?" without re-deriving identity
 * from the payload. `ids` is a list so single-row and bulk commands share one
 * shape.
 */
export type UndoEntityRef = {
  type: UndoEntityType;
  ids: readonly string[];
};

/**
 * The value an undoable command moves. Every registered command changes one
 * scalar per entity — a status, a priority, an assignee id (nullable), or tag
 * membership (boolean) — so the captured prior value is always one of these.
 */
export type UndoCommandValue = string | boolean | null;

/**
 * A single request against `apps/api`. `path` is the API-relative route path
 * (what `apiClient` is handed), so it names a real route rather than describing
 * a local state edit.
 *
 * `requiredScope` is the API-key scope that route enforces, and it is on the
 * CALL rather than the command because an inverse does not always need what its
 * forward needed: undoing a tag apply turns a `write` POST into a `delete`
 * DELETE. A caller holding a write-only key can therefore run a forward it
 * cannot reverse, and the only way it can know that before offering an undo is
 * if the descriptor says so.
 */
export type UndoApiCall = {
  method: UndoApiMethod;
  path: string;
  requiredScope: ApiKeyScope;
  body?: Readonly<Record<string, JsonValue>>;
};

/**
 * Everything a command needs to build its forward and inverse calls.
 *
 * `priorValue` / `newValue` are keyed by entity id because a bulk mutation
 * moves rows that were not all at the same value: undoing "set 3 artifacts to
 * DONE" has to put each row back where it individually was.
 *
 * `subject` names a second participant the entity ids do not carry — the tag in
 * a tag apply/remove. Absent for the field-change commands.
 *
 * `forwardChangedIds` is the forward call's RESULT: which entities the server
 * reported it actually moved. It is absent until the forward has run, which is
 * why it is optional on the type and demanded by `requireForwardChangedIds` at
 * the moment an inverse is built.
 *
 * `forwardTransactionId` is the other half of that result: the transaction
 * identity the forward's `/v2` response reported (ISS-9465), carried so the
 * inverse can name the commit it reverses (ISS-10458). Optional in the same way
 * and for a stronger reason — a forward issued against a `/v1` route, or
 * against an api deployment that predates the field, reports none, and an undo
 * must still run when it cannot be traced.
 */
export type UndoCommandContext = {
  entity: UndoEntityRef;
  priorValue: Readonly<Record<string, UndoCommandValue>>;
  newValue: Readonly<Record<string, UndoCommandValue>>;
  subject?: { id: string; label: string };
  forwardChangedIds?: readonly string[];
  forwardTransactionId?: string;
};

/**
 * A mutation that can be reversed by a real API call.
 *
 * `valueSchema` is the contract for what the log must capture BEFORE the
 * forward call runs — the prior value cannot be re-derived afterwards, because
 * by then the row holds the new one.
 */
export type UndoableCommand = {
  kind: UndoMutationKind;
  undoable: true;
  entityType: UndoEntityType;
  valueSchema: z.ZodType<UndoCommandValue>;
  label: (context: UndoCommandContext) => string;
  forward: (context: UndoCommandContext) => readonly UndoApiCall[];
  inverse: (context: UndoCommandContext) => readonly UndoApiCall[];
};

/**
 * A mutation deliberately declared un-undoable. `reason` is why no clean
 * server-side inverse exists — it is the thing a reviewer reads when asking
 * whether the omission was considered or forgotten.
 */
export type NonUndoableCommand = {
  kind: UndoMutationKind;
  undoable: false;
  reason: string;
};

export type UndoRegistryEntry = UndoableCommand | NonUndoableCommand;

/** Narrow a registry entry to the undoable arm. */
export function isUndoableCommand(
  entry: UndoRegistryEntry
): entry is UndoableCommand {
  return entry.undoable;
}

/**
 * Read a captured prior/new value for one entity, or throw naming the gap.
 *
 * An absent value is not "no change" — it is a capture that never happened, and
 * building an inverse from it would send a request that asserts a value nobody
 * measured. The command builders below call this rather than defaulting.
 */
export function requireCommandValue(
  values: Readonly<Record<string, UndoCommandValue>>,
  entityId: string,
  kind: UndoMutationKind
): UndoCommandValue {
  if (!Object.hasOwn(values, entityId)) {
    throw new Error(
      `undo command ${kind}: no captured value for entity ${entityId}`
    );
  }
  return values[entityId];
}

/**
 * Read a captured value that must be a string (status, priority), or throw.
 * Keeps the per-command builders free of casts.
 */
export function requireStringValue(
  values: Readonly<Record<string, UndoCommandValue>>,
  entityId: string,
  kind: UndoMutationKind
): string {
  const value = requireCommandValue(values, entityId, kind);
  if (typeof value !== "string") {
    throw new Error(
      `undo command ${kind}: expected a string value for entity ${entityId}`
    );
  }
  return value;
}

/**
 * Read a captured value that must be a string or null (assignee id), or throw.
 */
export function requireNullableStringValue(
  values: Readonly<Record<string, UndoCommandValue>>,
  entityId: string,
  kind: UndoMutationKind
): string | null {
  const value = requireCommandValue(values, entityId, kind);
  if (value !== null && typeof value !== "string") {
    throw new Error(
      `undo command ${kind}: expected a string or null value for entity ${entityId}`
    );
  }
  return value;
}

/**
 * The tag a tag apply/remove acted on. Throws rather than inventing an id,
 * because a tag call without one would target the wrong row.
 */
export function requireSubject(
  context: UndoCommandContext,
  kind: string
): {
  id: string;
  label: string;
} {
  if (!context.subject) {
    throw new Error(`undo command ${kind}: requires a subject (tag) identity`);
  }
  return context.subject;
}

/**
 * The entities a command acted on, or a throw when there are none.
 *
 * Every builder maps over this list, so an empty one would yield zero requests —
 * which a dispatcher cannot distinguish from an undo that ran and legitimately
 * had nothing to change. A command that targeted nothing is a capture bug, not
 * a no-op, so it fails loudly here rather than reporting success.
 */
export function requireEntityIds(
  context: UndoCommandContext
): readonly string[] {
  if (context.entity.ids.length === 0) {
    throw new Error(
      `undo command ${context.entity.type}: no entity ids were captured`
    );
  }
  return context.entity.ids;
}

/**
 * The entities a BATCH command acted on, or a throw when there are more of them
 * than one request may name.
 *
 * `POST /documents/batch-update-status` and `POST /entity-tags/batch` both cap
 * their id array at `BATCH_MUTATION_ENTITY_LIMIT`. A command that builds a
 * single request over a longer selection is declared undoable and then fails
 * with a 400 the caller only discovers at dispatch — the same "looks
 * reversible, is not" failure this registry exists to prevent — so it refuses
 * here, while the log is still being written.
 *
 * Deliberately NOT chunked. Splitting one batch into several makes a
 * half-applied undo reachable, and whether an undo may partially apply is a
 * product decision this contract does not get to make on its own.
 */
export function requireBatchableEntityIds(
  context: UndoCommandContext,
  kind: UndoMutationKind
): readonly string[] {
  const entityIds = requireEntityIds(context);
  if (entityIds.length > BATCH_MUTATION_ENTITY_LIMIT) {
    throw new Error(
      `undo command ${kind}: ${entityIds.length} entities exceeds the ${BATCH_MUTATION_ENTITY_LIMIT}-entity batch limit`
    );
  }
  return entityIds;
}

/**
 * The entities the forward call actually CHANGED, as the server reported them.
 *
 * Three different sets get confused here, so they are named apart: `entity.ids`
 * is what the forward was AIMED at, `priorValue` is what the client BELIEVED
 * beforehand, and this is what the server SAYS it moved. For a mutation whose
 * forward is idempotent — both tag-apply paths skip a row that already carries
 * the tag, and tag-remove deletes nothing from a row that does not — the three
 * can disagree: a concurrent apply between capture and forward makes the
 * forward a silent no-op for that row, and an inverse built from `priorValue`
 * then deletes a tag this command never created, clobbering the other caller's
 * write.
 *
 * Demanded rather than defaulted. Falling back to `priorValue` is precisely the
 * wrong write, and a wrong write that reports itself as a successful undo is
 * worse than a loud refusal. Conflict POLICY — what to tell the user when the
 * sets disagree, and whether to offer the undo at all — is ISS-9091's; this is
 * only the evidence that policy will read.
 */
export function requireForwardChangedIds(
  context: UndoCommandContext,
  kind: UndoMutationKind
): readonly string[] {
  const changed = context.forwardChangedIds;
  if (changed === undefined) {
    throw new Error(
      `undo command ${kind}: the forward result was not captured, so which entities it changed is unknown`
    );
  }
  const targeted = new Set(requireEntityIds(context));
  const stray = changed.filter((entityId) => !targeted.has(entityId));
  if (stray.length > 0) {
    throw new Error(
      `undo command ${kind}: forward reported changing entities it never targeted: ${stray.join(", ")}`
    );
  }
  return changed;
}

/**
 * The one value a batch call may send for EVERY id it names, or a throw.
 *
 * A batch route takes a single target value for the whole selection, so a
 * context whose per-entity values disagree cannot be expressed as one call at
 * all. Reading the first id's value and sending it for the rest would silently
 * apply one artifact's status to every selected artifact, so a mixed capture
 * fails here instead of shipping.
 */
export function requireUniformStringValue(
  values: Readonly<Record<string, UndoCommandValue>>,
  entityIds: readonly string[],
  kind: UndoMutationKind
): string {
  const [firstId, ...restIds] = entityIds;
  const shared = requireStringValue(values, firstId, kind);
  for (const entityId of restIds) {
    const value = requireStringValue(values, entityId, kind);
    if (value !== shared) {
      throw new Error(
        `undo command ${kind}: a batch call needs one shared value, but entity ${firstId} captured ${shared} and entity ${entityId} captured ${value}`
      );
    }
  }
  return shared;
}

/**
 * The body fields that name the commit an inverse REVERSES (ISS-10458).
 *
 * Spread into an inverse's body so the route it replays against can stamp the
 * reference onto every receipt the undo writes, making the pair joinable
 * instead of two unrelated bulk mutations a reader has to infer a relationship
 * between.
 *
 * OMITTED, never `null`, when the forward reported no transaction: the batch
 * validators are `.strict()`, so a `null` would have to be declared nullable at
 * every route before a client could send it, and an absent reference and a null
 * one mean the same thing — this undo cannot be traced. An undo still runs
 * either way; traceability is not a precondition for reversing a mutation.
 */
/**
 * What {@link undoOfTransactionBody} actually emits: the reference, or nothing.
 *
 * Narrower than the `UndoApiCall["body"]` slot it fills, deliberately. The wide
 * `Readonly<Record<string, JsonValue>>` says this could carry any key, so a
 * caller cannot tell from the type that the only key is the undo reference and
 * a reviewer cannot tell that the empty case is the no-forward-id case.
 */
export type UndoOfTransactionBody = Readonly<{
  undoOfTransactionId?: string;
}>;

export function undoOfTransactionBody(
  context: UndoCommandContext
): UndoOfTransactionBody {
  const { forwardTransactionId } = context;
  if (forwardTransactionId === undefined) {
    return {};
  }
  return { undoOfTransactionId: forwardTransactionId };
}
