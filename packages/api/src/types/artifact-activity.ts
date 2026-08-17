/**
 * Artifact activity event types (FEA-3859 / FEA-3535 Slice 1).
 *
 * Canonical shared contract for the append-only artifact activity log that
 * backs the artifact activity feed (delivered in later slices). Used by the
 * `apps/api` write/list services today, and by the read endpoint + feed source
 * in later slices — so it lives here, in `@repo/api`, rather than co-located in
 * `apps/api`.
 *
 * SHIPS DARK: this slice defines the store + write/list services only. Nothing
 * emits events on the write path yet (Slice 2), and there is no read endpoint
 * (Slice 3) or UI (Slice 4+).
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
import type { JsonValue } from "./common.js";

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
 *              `actorId` is the api-key id (or agent identity) when known.
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
 *
 * Additive by design: new actions can be appended here without a schema
 * migration, because the DB column is a freeform string.
 */
export const ArtifactActivityAction = {
  StatusChange: "status_change",
  FieldChange: "field_change",
  Assignment: "assignment",
  Creation: "creation",
} as const;
export type ArtifactActivityAction =
  (typeof ArtifactActivityAction)[keyof typeof ArtifactActivityAction];

/**
 * A single persisted activity event, as returned by `listActivityEvents`.
 *
 * `before` / `after` carry the field-scoped snapshot of the change. Both are
 * nullable: a `creation` event has no `before`, and clearing a field yields a
 * null `after`.
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
]);

/**
 * Validation schema for `recordActivityEvent` input. `before` / `after` accept
 * any JSON value (or are omitted). `actorId` is optional — omit or pass null
 * for `system` actors.
 */
export const recordActivityEventInputSchema = z.object({
  organizationId: z.string().min(1),
  artifactId: z.string().min(1),
  actorType: actorTypeSchema,
  actorId: z.string().min(1).nullish(),
  action: actionSchema,
  before: jsonValueSchema.optional(),
  after: jsonValueSchema.optional(),
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
 * batch is tenant-scoped by a single `organizationId`; only the artifacts that
 * actually belong to it are inserted (the rest are skipped, not rejected), so a
 * best-effort capture over a large batch cannot fail the caller's write.
 */
export const recordActivityEventsInputSchema = z.object({
  organizationId: z.string().min(1),
  events: z.array(recordActivityEventBatchRowSchema),
});
export type RecordActivityEventsInput = z.infer<
  typeof recordActivityEventsInputSchema
>;
