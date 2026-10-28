/**
 * Artifact activity event types (FEA-3859 / FEA-3535 Slice 1).
 *
 * Canonical shared contract for the append-only artifact activity log that
 * backs the artifact activity feed. Used by the `apps/api` write/list services,
 * the `GET /documents/[id]/activity` read endpoint, and the Feed sidebar source
 * in `packages/app` (FEA-3864) — so it lives here, in `@repo/api`, rather than
 * co-located in `apps/api`.
 *
 * All enums follow the repo-sanctioned `{...} as const` +
 * `(typeof X)[keyof typeof X]` idiom — never a TypeScript `enum`. The values
 * are the exact strings persisted to the freeform `actor_type` / `action`
 * columns on `artifact_activity_events` (Prisma model `ArtifactActivityEvent`);
 * the columns are intentionally plain `String`, so this const-object is the
 * single source of truth for the vocabulary (mirrors the `Artifact.status`
 * freeform-status precedent).
 */

import { z } from "zod";
import {
  ArtifactFieldEditField,
  ArtifactFieldEditReceiptResult,
  type ArtifactFieldEditValueClassification,
  buildArtifactFieldEditSnapshots,
} from "./artifact-field-edit-receipt.ts";
import type {
  ArtifactStatusEditSurface,
  ArtifactStatusProvenance,
} from "./artifact-status-contract.js";
import type { BranchActivityEvidenceCompleteness } from "./branch-activity.js";
import type { JsonValue } from "./common.js";
import type {
  MonitoredActivityTarget,
  MonitoredHoldExpiryCause,
  MonitoredTargetDisposition,
} from "./monitored-activity-target.js";
import type { MonitoredSessionActivityEventKind } from "./session-monitored-activity.js";

/**
 * Recursive JSON-value schema, mirroring `jsonValueSchema` in
 * `apps/api/lib/json-schema.ts`. Duplicated here because `packages/api` cannot
 * import from `apps/api`; this lets `before` / `after` be validated as real
 * `JsonValue`s at the boundary instead of accepted as `z.unknown()` and cast.
 */
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ])
);

/**
 * Who performed the mutation captured by an activity event.
 *
 * - `user`   — a human (Clerk-authenticated) actor. `actorId` is the user id.
 * - `agent`  — an autonomous agent / API-key caller (e.g. an MCP write).
 *              `actorId` is the platform user id the key belongs to, NOT the
 *              key id: capture switches only the actor TYPE on `authMethod`
 *              and always passes `actor.userId`.
 * - `system` — the platform itself (background jobs, automated transitions).
 *              `actorId` is typically null.
 */
export const ArtifactActivityActorType = {
  User: "user",
  Agent: "agent",
  System: "system",
} as const;
export type ArtifactActivityActorType =
  (typeof ArtifactActivityActorType)[keyof typeof ArtifactActivityActorType];

/**
 * The kind of mutation an activity event records.
 *
 * - `status_change` — the artifact's lifecycle status changed.
 * - `field_change`  — a scalar field changed (title, priority, due date, …).
 * - `assignment`    — the assignee or approver changed.
 * - `creation`      — the artifact was created (no `before`).
 * - `monitored_activity_retained` — ISS-9182: a session's run touched a target
 *   the delivery could write no branch-activity evidence against, so the
 *   evidence is filed on the SESSION artifact instead of discarded. Its `after`
 *   is a {@link MonitoredActivityRetainedSnapshot}; it has no `before`, because
 *   nothing about the artifact changed.
 *
 * Additive by design: new actions can be appended here without a schema
 * migration, because the DB column is a freeform string.
 */
export const ArtifactActivityAction = {
  StatusChange: "status_change",
  FieldChange: "field_change",
  Assignment: "assignment",
  Creation: "creation",
  MonitoredActivityRetained: "monitored_activity_retained",
} as const;
export type ArtifactActivityAction =
  (typeof ArtifactActivityAction)[keyof typeof ArtifactActivityAction];

/**
 * A single persisted activity event, as returned by `listActivityEvents`.
 *
 * `before` / `after` carry the snapshot of the change — field-scoped for the
 * change actions, an action-specific payload for `monitored_activity_retained`.
 * Both are nullable: a `creation` or `monitored_activity_retained` event has no
 * `before`, and clearing a field yields a null `after`.
 */
export type ArtifactActivityEvent = {
  id: string;
  organizationId: string;
  artifactId: string;
  actorType: ArtifactActivityActorType;
  actorId: string | null;
  action: ArtifactActivityAction;
  before: JsonValue | null;
  after: JsonValue | null;
  createdAt: Date;
};

/** Upper bound on rows a single `listActivityEvents` page may return. */
export const ARTIFACT_ACTIVITY_LIST_MAX_LIMIT = 100;

/** Default page size when a caller omits `limit`. */
export const ARTIFACT_ACTIVITY_LIST_DEFAULT_LIMIT = 50;

const actorTypeSchema = z.enum([
  ArtifactActivityActorType.User,
  ArtifactActivityActorType.Agent,
  ArtifactActivityActorType.System,
]);

const actionSchema = z.enum([
  ArtifactActivityAction.StatusChange,
  ArtifactActivityAction.FieldChange,
  ArtifactActivityAction.Assignment,
  ArtifactActivityAction.Creation,
  ArtifactActivityAction.MonitoredActivityRetained,
]);

/**
 * Validation schema for `recordActivityEvent` input. `before` / `after` accept
 * any JSON value (or are omitted). `actorId` is optional — omit or pass null
 * for `system` actors.
 */
export const recordActivityEventInputSchema = z
  .object({
    action: actionSchema,
    actorId: z.string().min(1).nullish(),
    actorType: actorTypeSchema,
    after: jsonValueSchema.optional(),
    artifactId: z.string().min(1),
    before: jsonValueSchema.optional(),
    organizationId: z.string().min(1),
    transactionId: z.uuid().optional(),
    undoOfTransactionId: z.uuid().optional(),
  })
  .superRefine((input, context) => {
    if (
      input.undoOfTransactionId !== undefined &&
      input.transactionId === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "undoOfTransactionId requires transactionId",
        path: ["undoOfTransactionId"],
      });
    }
  });
export type RecordActivityEventInput = z.infer<
  typeof recordActivityEventInputSchema
>;

/**
 * Validation schema for `listActivityEvents` input. `cursor` is the opaque
 * `id` of the last row from the prior page (keyset pagination). `limit` must be
 * a positive integer; the service clamps it down to
 * `ARTIFACT_ACTIVITY_LIST_MAX_LIMIT` rather than rejecting an over-large
 * request, so a caller asking for "everything" gets a full page.
 */
export const listActivityEventsInputSchema = z.object({
  organizationId: z.string().min(1),
  artifactId: z.string().min(1),
  cursor: z.string().min(1).nullish(),
  limit: z.number().int().positive().optional(),
});
export type ListActivityEventsInput = z.infer<
  typeof listActivityEventsInputSchema
>;

/**
 * A cursor-paginated page of activity events, newest first. `nextCursor` is the
 * `id` to pass as `cursor` for the following page, or null when the returned
 * page is the last one.
 */
export type ListActivityEventsResult = {
  items: ArtifactActivityEvent[];
  nextCursor: string | null;
};

/**
 * One event in a batch write. All events in a `recordActivityEvents` call share
 * the same `organizationId`, so it is hoisted to the batch input and omitted
 * here. Each row still carries its own `artifactId` / `actorType` / `action` /
 * snapshots so a single batch can record heterogeneous events.
 */
export const recordActivityEventBatchRowSchema = z.object({
  artifactId: z.string().min(1),
  actorType: actorTypeSchema,
  actorId: z.string().min(1).nullish(),
  action: actionSchema,
  before: jsonValueSchema.optional(),
  after: jsonValueSchema.optional(),
});
export type RecordActivityEventBatchRow = z.infer<
  typeof recordActivityEventBatchRowSchema
>;

/**
 * Validation schema for `recordActivityEvents` (the batch write). The whole
 * batch is tenant-scoped by a single `organizationId`. The activity service may
 * filter foreign artifacts, while field-edit capture treats a short insert as
 * an atomicity failure and aborts the owning mutation transaction.
 */
export const recordActivityEventsInputSchema = z
  .object({
    organizationId: z.string().min(1),
    events: z.array(recordActivityEventBatchRowSchema),
    /**
     * ISS-9465. Hoisted to the batch rather than carried per row, for the same
     * reason `organizationId` is: every row of one bulk mutation shares it by
     * construction, so no row can be written without it while its siblings have
     * it, and no two rows of one batch can disagree.
     *
     * Optional, because the single-artifact write path records through
     * `recordActivityEvent` and has no transaction to group.
     */
    transactionId: z.string().min(1).optional(),
    /**
     * ISS-10458. The transaction these rows REVERSE, hoisted to the batch for the
     * same reason `transactionId` is. Present only when the write came from an
     * undo, and only alongside a `transactionId`: a row that names what it undid
     * without naming itself could never be joined from the other side.
     */
    undoOfTransactionId: z.uuid().optional(),
  })
  .superRefine((input, context) => {
    if (
      input.undoOfTransactionId !== undefined &&
      input.transactionId === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["undoOfTransactionId"],
        message:
          "undoOfTransactionId requires transactionId: a row naming what it reversed without naming itself cannot be joined from the other side.",
      });
    }
  });
export type RecordActivityEventsInput = z.infer<
  typeof recordActivityEventsInputSchema
>;

/**
 * What a status receipt says about the write it describes.
 *
 * Exactly one member, deliberately. Every receipt that exists today describes a
 * change that COMMITTED: a no-op status write records nothing (the write path
 * suppresses it), and whether a REFUSED attempt is recorded at all is the open
 * product question `artifact-status-contract.ts` leaves unanswered. The field is
 * still persisted rather than implied, because that is what makes a future
 * member distinguishable from a legacy row that simply predates the receipt —
 * absent and `committed` are different claims, and only one of them is a
 * measurement.
 */
export const ArtifactStatusCommitResult = ArtifactFieldEditReceiptResult;
export type ArtifactStatusCommitResult =
  (typeof ArtifactStatusCommitResult)[keyof typeof ArtifactStatusCommitResult];

/**
 * The `before` half of a status receipt: the `{ field, value }` envelope the
 * feed already unwraps, naming the status the artifact left. It carries no
 * provenance — the surface, the result and the commit group describe the WRITE,
 * and the prior state was not written by it.
 *
 * `value` is `string | null` rather than a narrowed status: a prior value may be
 * one this build has never heard of (a version-skewed producer, or a row written
 * before a vocabulary changed), and an artifact whose stored status was absent
 * has no prior status to name.
 */
export type ArtifactStatusBeforeSnapshot = Readonly<{
  field: typeof ARTIFACT_STATUS_SNAPSHOT_FIELD;
  value: string | null;
  valueClassification: ArtifactFieldEditValueClassification;
}>;

/**
 * The `after` half: the same envelope plus the provenance ISS-9436 adds —
 * WHERE the write was made from, and WHAT became of it.
 *
 * `commitGroupId` is present only for the two grouped surfaces (`board`,
 * `bulk`), matching `ArtifactStatusCommit` in `./artifact-status-contract.ts`:
 * it is one id shared by every row of one commit, so a reader can tell a ten-row
 * drag from ten separate edits. It stays ABSENT rather than `null` on a
 * single-row commit, which is what keeps the envelope additive for a reader that
 * predates it.
 */
export type ArtifactStatusReceiptSnapshot = Readonly<{
  field: typeof ARTIFACT_STATUS_SNAPSHOT_FIELD;
  value: string;
  surface: ArtifactStatusEditSurface;
  result: ArtifactStatusCommitResult;
  valueClassification: ArtifactFieldEditValueClassification;
  commitGroupId?: string;
  undoOfCommitGroupId?: string;
}>;

/**
 * Build the `before`/`after` pair for one status transition.
 *
 * `provenance` is optional and its absence is load-bearing: a client that does
 * not name its surface — an API-key write, an MCP agent, a browser running a
 * build older than this one — gets back the BARE STRINGS this path has always
 * emitted, not an envelope with a fabricated or null surface. Omission is
 * preserved, so nothing about an unattributed write changes shape, and no reader
 * has to tell "written before receipts existed" apart from "written by a surface
 * we invented a name for".
 *
 * The surface and the commit group arrive as ONE value rather than two
 * independent optionals, so a grouped surface cannot reach a persisted receipt
 * without the `commitGroupId` its contract requires — see
 * {@link ArtifactStatusProvenance}.
 */
export function buildStatusChangeSnapshots(params: {
  before: string;
  after: string;
  provenance?: ArtifactStatusProvenance;
  undoOfCommitGroupId?: string;
}): {
  before: JsonValue;
  after: JsonValue;
} {
  const { provenance } = params;
  if (provenance === undefined) {
    return { before: params.before, after: params.after };
  }
  return buildArtifactFieldEditSnapshots({
    field: ArtifactFieldEditField.Status,
    before: params.before,
    after: params.after,
    context: {
      provenance,
      ...(params.undoOfCommitGroupId === undefined
        ? {}
        : { undoOfCommitGroupId: params.undoOfCommitGroupId }),
    },
  });
}

/**
 * The `after` payload of a `monitored_activity_retained` row — what a session's
 * run touched, kept when no branch-activity evidence could be written for it.
 *
 * Every fact is its own addressable field rather than a rendered sentence, so a
 * reader can link the repository and the pull request without parsing prose
 * back apart. No `field`/`value` envelope: nothing about the artifact changed,
 * so there is no changed field to name.
 *
 * The target half IS {@link MonitoredActivityTarget}, so the row discriminates
 * on `kind` the way every other reader of a monitored target already does: a
 * pull request carries `prNumber` and a branch carries `branchName`, neither
 * can carry the other's address, and neither can omit its own. The writer
 * spreads the resolved target straight in, so a reader reconstructs it without
 * re-deriving anything.
 *
 * `disposition` is the ingest classifier's own label. It is always present: a
 * candidate the classifier answered nothing for is retry-owned, and a
 * retry-owned candidate is held for a later delivery rather than retained.
 *
 * `url` is ABSENT, never null, for a `repositoryFullName` that cannot occupy a
 * URL path segment at all — one the URL parser erases (`.`, `..`) or one
 * `encodeURIComponent` cannot encode (a lone surrogate). Those names have no
 * address on the provider, so there is no link to give; `repositoryFullName`
 * still carries the name the producer claimed. Omission rather than null for the
 * reason `commitGroupId` above omits: it keeps the envelope additive.
 */
export type MonitoredActivityRetainedSnapshot = MonitoredActivityTarget & {
  url?: string;
  eventKind: MonitoredSessionActivityEventKind;
  occurredAt: string;
  completeness: BranchActivityEvidenceCompleteness;
  disposition: MonitoredTargetDisposition;
  /**
   * Only on a `HoldExpired` row; ABSENT reads as `OwnAge` (rows written before
   * the field existed). See {@link MonitoredHoldExpiryCause}.
   */
  holdExpiryCause?: MonitoredHoldExpiryCause;
};

/**
 * The envelope key a status snapshot is filed under. The same `field` the feed
 * reader keys its label vocabulary on, so the receipt cannot drift from the
 * chip that renders it.
 */
export const ARTIFACT_STATUS_SNAPSHOT_FIELD = ArtifactFieldEditField.Status;

/**
 * Field names used by Session metadata receipts and their later readers.
 * `AssigneeId` is the generic assignee envelope every artifact type records
 * under, Sessions included since ISS-12251 D-1. `OwnerUserId` is what session
 * owner receipts were filed under before that; stored rows keep it, so readers
 * still accept it, but no writer emits it.
 */
export const SessionMetadataActivityField = {
  Name: ArtifactFieldEditField.Name,
  Priority: ArtifactFieldEditField.Priority,
  ProjectId: ArtifactFieldEditField.ProjectId,
  AssigneeId: ArtifactFieldEditField.AssigneeId,
  OwnerUserId: "ownerUserId",
  Tag: ArtifactFieldEditField.Tag,
} as const;
export type SessionMetadataActivityField =
  (typeof SessionMetadataActivityField)[keyof typeof SessionMetadataActivityField];

/** Map legacy-aware Session receipt fields onto the canonical edit taxonomy. */
export function artifactFieldEditFieldForSessionMetadata(
  field: SessionMetadataActivityField
): ArtifactFieldEditField {
  return field === SessionMetadataActivityField.OwnerUserId
    ? ArtifactFieldEditField.AssigneeId
    : field;
}
