/**
 * FEA-3863 (parent FEA-3800, PLN-1456 Slice 2) — write-time indexing hooks that
 * keep the `search_document` full-text projection (FEA-3857) eventually
 * consistent with the Phase-1 corpus: Document/Feature Artifacts and Projects.
 *
 * FAIL-OPEN, POST-COMMIT, BEST-EFFORT (spec + AGENTS serverless-route rule): a
 * projection write must NEVER block or fail the authoritative primary write. The
 * write services call {@link searchIndexService.indexAfterCommit} /
 * {@link searchIndexService.removeAfterCommit} at the tail of their write
 * methods — AFTER the primary `withDb.tx` has committed — and those helpers hand
 * the work to `waitUntil` and swallow any error (logged, never rethrown). A
 * projection failure can therefore never roll back or 500 the user's write; the
 * one-shot backfill (`packages/database` `backfill:search-documents`) is the
 * reconcile safety net for any hook that silently lost.
 *
 * ONE COLUMN IS TRIGGER-OWNED (ISS-9938): `status` on document rows. Once such
 * a row exists, only the `artifacts_search_document_status_sync` trigger
 * changes its status, inside the status write's own transaction.
 * {@link searchIndexService.upsertMany} leaves it alone on conflict, because a re-index carries the status captured at its own
 * write and can land after a newer one. On insert it reads the status from the
 * source row in the same statement instead of trusting the captured value: a
 * status write that commits before the row exists finds nothing for its trigger
 * to update. The gap that remains is a status write whose transaction is still
 * open when that insert reads the source; closing it would mean locking the
 * source row from here, the reverse of the trigger's lock order. Everything else
 * on the row, and `status` on every other row type, stays best-effort.
 *
 * ORG-SCOPED: `organizationId` is part of every write and part of the
 * projection's unique key `(organization_id, entity_type, entity_id)`, so a
 * write for one org never touches another's rows.
 *
 * The searchable text is METADATA-FIRST (spec §"metadata first") and bounded:
 * `title` and `body` are trimmed to the same caps the backfill uses so a
 * pathological name/prompt cannot bloat the generated `tsv` on every write.
 */

import {
  resolveVersionFingerprint,
  routableComponentHashKey,
  routableComponentSlug,
} from "@repo/api/src/types/agent-component-analytics";
import {
  boundSearchText,
  MAX_SEARCH_TITLE_CHARS,
} from "@repo/api/src/types/search";
import {
  SearchEntityType,
  STATUS_TRIGGER_OWNED_ENTITY_TYPES,
} from "@repo/api/src/types/search-entity-kind";
import { Prisma, withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { projectionValuesRow } from "./search-document-values";

/**
 * A projection row to upsert. Mirrors the writable columns of `search_document`;
 * the generated `tsv` column is Postgres-owned and never set here.
 */
export type SearchProjectionInput = {
  organizationId: string;
  entityType: SearchEntityType;
  entityId: string;
  title: string;
  body: string | null;
  projectId: string | null;
  assigneeId: string | null;
  /**
   * The source entity's lifecycle status as its raw string (FEA-3930) — powers
   * the `:status` query-language filter. Null where the source has no status
   * (comment/PR/branch/session in the projection). On document rows it
   * is only a fallback: the insert reads the source row's status in the same
   * statement, and database triggers own it after that (ISS-9938).
   */
  status: string | null;
  /**
   * The source entity's priority as its raw string (LOW/MEDIUM/HIGH/URGENT) —
   * powers the ordinal-compared `:priority` filter (FEA-3930). Null where the
   * source has none (a comment, PR, or component has no priority) and
   * where a priority-bearing source (document, project, branch, session) holds
   * none; `PRIORITY_BEARING_ENTITY_TYPES` is what tells the two apart.
   */
  priority: string | null;
  updatedAt: Date;
  // Phase-2 route fields. Nullable — the type that does not carry a given field
  // leaves it null (documents: slug + entitySubtype; projects: slug + teamId).
  slug: string | null;
  entitySubtype: string | null;
  teamId: string | null;
  // Route anchor (FEA-3930 comment/PR/branch slice). The id of a DIFFERENT entity
  // this row routes to (PR → owning branch; comment → anchored artifact). Null
  // for the types that route off their own `entityId`.
  anchorEntityId: string | null;
};

/** Identity of a projection row to remove on entity delete/hard-remove. */
export type SearchProjectionKey = {
  organizationId: string;
  entityType: SearchEntityType;
  entityId: string;
};

export const searchIndexService = {
  /**
   * Atomically upsert a single projection row keyed on
   * `(organization_id, entity_type, entity_id)`. Throws on failure — callers on
   * the request hot path must use {@link searchIndexService.indexAfterCommit}
   * instead. Exposed directly for tests and for any future synchronous
   * reconcile path.
   */
  async upsert(input: SearchProjectionInput): Promise<void> {
    await searchIndexService.upsertMany([input]);
  },

  /**
   * Atomically upsert MANY projection rows in a SINGLE multi-row
   * `INSERT ... ON CONFLICT` — one pooled connection regardless of batch size.
   * This is the pool-safe path for a write that projects a variable-length set
   * (a component sync or a pack import can hand hundreds of rows): a per-row
   * fan-out would borrow one connection each and re-open the 2026-07-15
   * pool-exhaustion outage (FEA-3299), so callers MUST use this instead of
   * looping {@link searchIndexService.upsert}. A no-op for an empty batch.
   * Throws on failure; hot-path callers use
   * {@link searchIndexService.indexManyAfterCommit}.
   */
  async upsertMany(inputs: readonly SearchProjectionInput[]): Promise<void> {
    if (inputs.length === 0) {
      return;
    }
    const rows = Prisma.join(inputs.map(projectionValuesRow));
    await withDb(
      (db) =>
        db.$executeRaw`
        INSERT INTO "search_document" (
          "id", "organization_id", "entity_type", "entity_id",
          "title", "body", "project_id", "assignee_id", "status", "priority",
          "updated_at", "slug", "entity_subtype", "team_id", "anchor_entity_id"
        )
        VALUES ${rows}
        ON CONFLICT ("organization_id", "entity_type", "entity_id")
        DO UPDATE SET
          "title" = EXCLUDED."title",
          "body" = EXCLUDED."body",
          "project_id" = EXCLUDED."project_id",
          "assignee_id" = EXCLUDED."assignee_id",
          "status" = CASE
            WHEN "search_document"."entity_type" IN (${Prisma.join(STATUS_TRIGGER_OWNED_ENTITY_TYPES)})
              THEN "search_document"."status"
            ELSE EXCLUDED."status"
          END,
          "priority" = EXCLUDED."priority",
          "updated_at" = EXCLUDED."updated_at",
          "slug" = EXCLUDED."slug",
          "entity_subtype" = EXCLUDED."entity_subtype",
          "team_id" = EXCLUDED."team_id",
          "anchor_entity_id" = EXCLUDED."anchor_entity_id"
      `
    );
  },

  /**
   * Remove a projection row by its unique key. Idempotent — a no-op when the row
   * was never projected. Throws on failure; hot-path callers use
   * {@link searchIndexService.removeAfterCommit}.
   */
  async remove(key: SearchProjectionKey): Promise<void> {
    await searchIndexService.removeMany([key]);
  },

  /**
   * Remove MANY projection rows in one statement per `(org, entityType)` group —
   * `entity_id IN (...)` — instead of one `DELETE` (and one pooled connection)
   * per key. The pool-safe removal counterpart to
   * {@link searchIndexService.upsertMany}: an uninstall pass over a large
   * inventory removes its rows without re-opening the FEA-3299 pool-exhaustion
   * shape. Grouped by org+type so the org scope stays in every `WHERE`. A no-op
   * for an empty batch. Throws on failure; hot-path callers use
   * {@link searchIndexService.removeManyAfterCommit}.
   */
  async removeMany(keys: readonly SearchProjectionKey[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    const groups = groupRemovalKeys(keys);
    await withDb(async (db) => {
      for (const group of groups.values()) {
        const ids = Prisma.join(
          group.entityIds.map((id) => Prisma.sql`${id}::uuid`)
        );
        await db.$executeRaw`
          DELETE FROM "search_document"
          WHERE "organization_id" = ${group.organizationId}::uuid
            AND "entity_type" = ${group.entityType}
            AND "entity_id" IN (${ids})
        `;
      }
    });
  },

  /**
   * Fail-open, non-blocking upsert for the write hot path. Schedules the
   * projection write via `waitUntil` and swallows any error (logged). Returns
   * immediately; the caller's primary write is already committed and is never
   * affected by a projection failure.
   */
  indexAfterCommit(input: SearchProjectionInput): void {
    runBestEffort(
      () => searchIndexService.upsert(input),
      "search_index_upsert_failed",
      {
        organizationId: input.organizationId,
        entityType: input.entityType,
        entityId: input.entityId,
      }
    );
  },

  /**
   * Fail-open, non-blocking removal for the write hot path (entity delete).
   * Schedules the projection delete via `waitUntil` and swallows any error.
   */
  removeAfterCommit(key: SearchProjectionKey): void {
    runBestEffort(
      () => searchIndexService.remove(key),
      "search_index_remove_failed",
      {
        organizationId: key.organizationId,
        entityType: key.entityType,
        entityId: key.entityId,
      }
    );
  },

  /**
   * Fail-open, non-blocking BATCH upsert for the write hot path. Schedules ONE
   * multi-row upsert (via {@link searchIndexService.upsertMany}) through
   * `waitUntil` and swallows any error. Callers projecting a variable-length
   * set (component sync, pack import) MUST use this instead of looping
   * {@link searchIndexService.indexAfterCommit}, which would fan out one pooled
   * connection per row (FEA-3299). A no-op for an empty batch.
   */
  indexManyAfterCommit(inputs: readonly SearchProjectionInput[]): void {
    if (inputs.length === 0) {
      return;
    }
    runBestEffort(
      () => searchIndexService.upsertMany(inputs),
      "search_index_upsert_many_failed",
      { count: String(inputs.length) }
    );
  },

  /**
   * Fail-open, non-blocking BATCH removal for the write hot path. Schedules the
   * grouped `DELETE ... IN (...)` (via {@link searchIndexService.removeMany})
   * through `waitUntil` and swallows any error. The pool-safe removal
   * counterpart to {@link searchIndexService.indexManyAfterCommit}. A no-op for
   * an empty batch.
   */
  removeManyAfterCommit(keys: readonly SearchProjectionKey[]): void {
    if (keys.length === 0) {
      return;
    }
    runBestEffort(
      () => searchIndexService.removeMany(keys),
      "search_index_remove_many_failed",
      { count: String(keys.length) }
    );
  },

  /**
   * Retitle an ALREADY-PROJECTED row in place, leaving every other column —
   * `body` above all — untouched (ISS-8717, review: whitlockk + codex).
   *
   * UPDATE, never upsert, and that is the point rather than an optimization.
   * The two callers that could want this both rename an entity whose searchable
   * BODY they do not hold: an agent session's body is transcript text that only
   * `transcriptSearchIndexService` can read (a bounded S3 GET), so an upsert
   * from a rename would either have to re-read S3 on the request path or write
   * an empty body over a good one. It must also not CREATE a row: a session is
   * projected only for an org that opted into transcript search
   * (`Organization.searchIncludeTranscripts`), so inserting here would index a
   * session for an org that never opted in. No row therefore means "nothing to
   * keep consistent", and the next index/backfill picks the new title up from
   * the source, which already prefers the override.
   *
   * Org-scoped like every other write here: `organization_id` is in the `WHERE`,
   * so one org's rename can never retitle another's row. Throws on failure —
   * hot-path callers use {@link searchIndexService.updateTitleAfterCommit}.
   */
  async updateTitle(key: SearchProjectionKey, title: string): Promise<void> {
    // Bounded by the same cap the upsert path applies, so a pathological name
    // cannot bloat the generated `tsv` on this route either. An all-whitespace
    // title bounds to null; the projection's column is NOT NULL, so coalesce to
    // the empty string exactly as `projectionValuesRow` does.
    const bounded = boundSearchText(title, MAX_SEARCH_TITLE_CHARS) ?? "";
    await withDb(
      (db) =>
        db.$executeRaw`
        UPDATE "search_document"
        SET "title" = ${bounded}
        WHERE "organization_id" = ${key.organizationId}::uuid
          AND "entity_type" = ${key.entityType}
          AND "entity_id" = ${key.entityId}::uuid
      `
    );
  },

  /**
   * Fail-open, non-blocking retitle for the write hot path. Schedules
   * {@link searchIndexService.updateTitle} through `waitUntil` and swallows any
   * error (logged), so a projection failure can never roll back or 500 the
   * rename that is already committed.
   */
  updateTitleAfterCommit(key: SearchProjectionKey, title: string): void {
    runBestEffort(
      () => searchIndexService.updateTitle(key, title),
      "search_index_update_title_failed",
      {
        organizationId: key.organizationId,
        entityType: key.entityType,
        entityId: key.entityId,
      }
    );
  },

  /**
   * Re-project an ALREADY-PROJECTED row's priority in place (ISS-10332 /
   * PLN-2086 Milestone 2), the sibling of {@link searchIndexService.updateTitle}
   * and UPDATE-only for the same reasons: the single session and branch
   * priority writers hold neither the row's body (a session's is transcript
   * text only the transcript indexer can read) nor the right to CREATE a row
   * (a session is projected only for an org that opted into transcript search).
   * No row means nothing to keep consistent; the next index or backfill reads
   * the value from the source.
   *
   * Org-scoped in the `WHERE` like every other write here. Throws on failure —
   * hot-path callers use {@link searchIndexService.updatePriorityAfterCommit}.
   */
  async updatePriority(
    key: SearchProjectionKey,
    priority: string | null
  ): Promise<void> {
    await withDb(
      (db) =>
        db.$executeRaw`
        UPDATE "search_document"
        SET "priority" = ${priority}
        WHERE "organization_id" = ${key.organizationId}::uuid
          AND "entity_type" = ${key.entityType}
          AND "entity_id" = ${key.entityId}::uuid
      `
    );
  },

  /**
   * Fail-open, non-blocking priority re-projection for the write hot path.
   * Schedules {@link searchIndexService.updatePriority} through `waitUntil` and
   * swallows any error (logged), so a projection failure can never roll back
   * or 500 the priority write that is already committed.
   */
  updatePriorityAfterCommit(
    key: SearchProjectionKey,
    priority: string | null
  ): void {
    runBestEffort(
      () => searchIndexService.updatePriority(key, priority),
      "search_index_update_priority_failed",
      {
        organizationId: key.organizationId,
        entityType: key.entityType,
        entityId: key.entityId,
      }
    );
  },

  /**
   * Re-project an ALREADY-PROJECTED row's assignee in place (ISS-12251), the
   * `assignee_id` sibling of {@link searchIndexService.updatePriority} and
   * UPDATE-only for the same reasons. Throws on failure — hot-path callers use
   * {@link searchIndexService.updateAssigneeAfterCommit}.
   */
  async updateAssignee(
    key: SearchProjectionKey,
    assigneeId: string | null
  ): Promise<void> {
    await searchIndexService.updateAssigneeMany(
      { organizationId: key.organizationId, entityType: key.entityType },
      [key.entityId],
      assigneeId
    );
  },

  /**
   * {@link searchIndexService.updateAssignee} for a set of one org's rows of one
   * type, in ONE statement, so a bulk assign pays one pooled connection rather
   * than one per row (FEA-3299). A no-op for an empty set.
   */
  async updateAssigneeMany(
    scope: SearchProjectionScope,
    entityIds: readonly string[],
    assigneeId: string | null
  ): Promise<void> {
    if (entityIds.length === 0) {
      return;
    }
    const ids = Prisma.join(entityIds.map((id) => Prisma.sql`${id}::uuid`));
    await withDb(
      (db) =>
        db.$executeRaw`
        UPDATE "search_document"
        SET "assignee_id" = ${assigneeId}::uuid
        WHERE "organization_id" = ${scope.organizationId}::uuid
          AND "entity_type" = ${scope.entityType}
          AND "entity_id" IN (${ids})
      `
    );
  },

  /** Fail-open, post-commit {@link searchIndexService.updateAssignee}. */
  updateAssigneeAfterCommit(
    key: SearchProjectionKey,
    assigneeId: string | null
  ): void {
    runBestEffort(
      () => searchIndexService.updateAssignee(key, assigneeId),
      "search_index_update_assignee_failed",
      {
        organizationId: key.organizationId,
        entityType: key.entityType,
        entityId: key.entityId,
      }
    );
  },

  /** Fail-open, post-commit {@link searchIndexService.updateAssigneeMany}. */
  updateAssigneeManyAfterCommit(
    scope: SearchProjectionScope,
    entityIds: readonly string[],
    assigneeId: string | null
  ): void {
    if (entityIds.length === 0) {
      return;
    }
    runBestEffort(
      () => searchIndexService.updateAssigneeMany(scope, entityIds, assigneeId),
      "search_index_update_assignee_many_failed",
      {
        organizationId: scope.organizationId,
        entityType: scope.entityType,
        count: String(entityIds.length),
      }
    );
  },
};

/**
 * Schedule best-effort background work: run `task`, log-and-swallow any
 * rejection under `errorEvent`, and register the settling promise with
 * `waitUntil` so the serverless function does not terminate before it finishes.
 * `waitUntil` is a no-op-safe primitive outside a request context.
 */
function runBestEffort(
  task: () => Promise<void>,
  errorEvent: string,
  context: Record<string, string>
): void {
  const work = task().catch((error) => {
    log.error(errorEvent, { ...context, error: parseError(error) });
  });
  waitUntil(work);
}

type RemovalGroup = {
  organizationId: string;
  entityType: SearchEntityType;
  entityIds: string[];
};

/**
 * Group removal keys by `(organizationId, entityType)` so each emitted `DELETE`
 * keeps the org scope in its `WHERE` and a single batch that happens to span
 * orgs/types can never leak a delete across the org boundary. Keyed with
 * `Object.create(null)`-style Map to avoid prototype-key collisions.
 */
function groupRemovalKeys(
  keys: readonly SearchProjectionKey[]
): Map<string, RemovalGroup> {
  const groups = new Map<string, RemovalGroup>();
  for (const key of keys) {
    const groupKey = `${key.organizationId}::${key.entityType}`;
    const existing = groups.get(groupKey);
    if (existing) {
      existing.entityIds.push(key.entityId);
    } else {
      groups.set(groupKey, {
        organizationId: key.organizationId,
        entityType: key.entityType,
        entityIds: [key.entityId],
      });
    }
  }
  return groups;
}

/**
 * The minimal document/feature Artifact shape the projection needs. Both
 * `document-service.ts#create` and `#update` pass a `Document` that satisfies
 * this. `entitySubtype` is the document `type` (used to build the type+slug web
 * route); `slug` is its URL handle; `body` is the document's content text
 * (Phase-2 full-text: documents are no longer title-only), left null when the
 * caller has no fresh content on hand — the backfill reconciles it.
 */
export type DocumentProjectionSource = {
  id: string;
  organizationId: string;
  title: string;
  slug: string;
  entitySubtype: string;
  body: string | null;
  projectId: string | null;
  assigneeId: string | null;
  /** The artifact's freeform status (IssueStatus/DocumentStatus) as a string. */
  status: string | null;
  /** The artifact's priority (LOW/MEDIUM/HIGH/URGENT) as a string, or null. */
  priority: string | null;
  updatedAt: Date;
};

/** Map a created/updated Document artifact to its projection row. */
export function documentProjection(
  doc: DocumentProjectionSource
): SearchProjectionInput {
  return {
    organizationId: doc.organizationId,
    entityType: SearchEntityType.Document,
    entityId: doc.id,
    title: doc.title,
    body: doc.body,
    projectId: doc.projectId,
    assigneeId: doc.assigneeId,
    status: doc.status,
    priority: doc.priority,
    updatedAt: doc.updatedAt,
    slug: doc.slug,
    entitySubtype: doc.entitySubtype,
    teamId: null,
    anchorEntityId: null,
  };
}

/**
 * The minimal Project shape the projection needs. `slug` is the project's URL
 * handle; `teamId` is its owning team (the web app routes a project team-scoped
 * as `/teams/<teamId>/projects/<id>`), null when the project has no team yet.
 */
export type ProjectProjectionSource = {
  id: string;
  organizationId: string;
  name: string;
  slug: string | null;
  teamId: string | null;
  description: string | null;
  assigneeId: string | null;
  /** The project's status (ProjectStatus) as a string. */
  status: string | null;
  /** The project's priority (LOW/MEDIUM/HIGH/URGENT) as a string. */
  priority: string | null;
  updatedAt: Date;
};

/**
 * Map a created/updated Project to its projection row. A project's own id is
 * its `projectId` visibility key (matching the Slice-1 backfill).
 */
export function projectProjection(
  project: ProjectProjectionSource
): SearchProjectionInput {
  return {
    organizationId: project.organizationId,
    entityType: SearchEntityType.Project,
    entityId: project.id,
    title: project.name,
    body: project.description,
    projectId: project.id,
    assigneeId: project.assigneeId,
    status: project.status,
    priority: project.priority,
    updatedAt: project.updatedAt,
    slug: project.slug,
    entitySubtype: null,
    teamId: project.teamId,
    anchorEntityId: null,
  };
}

/**
 * The minimal AgentSession shape the projection needs (FEA-3930). `entityId` is
 * the session's `artifactId` (the id the `/sessions/<id>` route is keyed on and
 * the id the FTS re-authorization checks against `SessionDetail`). `title` is
 * the session's display name; `body` is the extracted transcript text. The
 * caller (`transcript-search-indexer`) supplies the already-extracted, bounded
 * body — this mapper does no I/O.
 */
export type AgentSessionProjectionSource = {
  artifactId: string;
  organizationId: string;
  title: string;
  body: string | null;
  userId: string | null;
  /** The session artifact's `Priority` member (ISS-10332); null when unset. */
  priority: string | null;
  updatedAt: Date;
};

/**
 * Map an AI session to its projection row. Sessions route by id
 * (`/sessions/<id>`) and carry no slug/subtype/team. Visibility follows the
 * session's owner via `assigneeId`; projectId is null (a session is not
 * directly project-scoped in the projection).
 */
export function agentSessionProjection(
  session: AgentSessionProjectionSource
): SearchProjectionInput {
  return {
    organizationId: session.organizationId,
    entityType: SearchEntityType.AgentSession,
    entityId: session.artifactId,
    title: session.title,
    body: session.body,
    projectId: null,
    assigneeId: session.userId,
    // A session carries no status in the projection; its priority is the
    // artifact's (ISS-10332), so `:priority=NONE` can find an unprioritized one.
    status: null,
    priority: session.priority,
    updatedAt: session.updatedAt,
    slug: null,
    entitySubtype: null,
    teamId: null,
    anchorEntityId: null,
  };
}

/**
 * The minimal Comment shape the projection needs (FEA-3930). `entityId` is the
 * comment's id; `title` is a short author/context label; `body` is the comment's
 * plain text. `anchorEntityId` is the id of the artifact the comment's thread is
 * anchored on, and `anchorEntityType` is that artifact's TYPE (an
 * {@link ArtifactType} value) — together they let the route helper deep-link to
 * the session, branch or document the comment lives on. Visibility follows the
 * comment's author via `assigneeId`.
 */
export type CommentProjectionSource = {
  id: string;
  organizationId: string;
  title: string;
  body: string | null;
  anchorEntityId: string | null;
  anchorEntityType: string | null;
  authorId: string;
  updatedAt: Date;
};

/**
 * Map a created/updated Comment to its projection row. A comment routes to the
 * artifact it is anchored on, not to itself — the anchor id lands in
 * `anchorEntityId` and the anchor artifact's TYPE in `entitySubtype` (reusing
 * the subtype column, which comments do not otherwise need). `projectId` is null
 * (a comment is not directly project-scoped in the projection).
 */
export function commentProjection(
  comment: CommentProjectionSource
): SearchProjectionInput {
  return {
    organizationId: comment.organizationId,
    entityType: SearchEntityType.Comment,
    entityId: comment.id,
    title: comment.title,
    body: comment.body,
    projectId: null,
    assigneeId: comment.authorId,
    // A comment carries no status/priority in the projection.
    status: null,
    priority: null,
    updatedAt: comment.updatedAt,
    slug: null,
    // The anchor artifact's TYPE picks the session, branch or document route.
    entitySubtype: comment.anchorEntityType,
    teamId: null,
    anchorEntityId: comment.anchorEntityId,
  };
}

/**
 * The minimal PullRequest shape the projection needs (FEA-3930). `entityId` is
 * the `PullRequestDetail` id; `title` is the PR title; `body` is the PR
 * description. `branchArtifactId` is the owning branch's artifact id — a PR is
 * nested state on a branch, so the hit routes to the branch detail. Visibility
 * follows the PR's denormalized `organizationId`; `projectId`/`assigneeId` are
 * null (a PR carries neither in the projection).
 */
export type PullRequestProjectionSource = {
  id: string;
  organizationId: string;
  title: string | null;
  body: string | null;
  branchArtifactId: string;
  updatedAt: Date;
};

/**
 * Map a created/updated PullRequest to its projection row. Title falls back to
 * `PR #<n>`-less empty string handling via the bound title in the index service
 * (`boundSearchText` yields "" for a null/blank title). Routes to the owning
 * branch via `anchorEntityId`.
 */
export function pullRequestProjection(
  pr: PullRequestProjectionSource
): SearchProjectionInput {
  return {
    organizationId: pr.organizationId,
    entityType: SearchEntityType.PullRequest,
    entityId: pr.id,
    title: pr.title ?? "",
    body: pr.body,
    projectId: null,
    assigneeId: null,
    // A PR carries no status/priority in the projection.
    status: null,
    priority: null,
    updatedAt: pr.updatedAt,
    slug: null,
    entitySubtype: null,
    teamId: null,
    // A PR routes to its owning branch's detail page.
    anchorEntityId: pr.branchArtifactId,
  };
}

/**
 * The minimal Branch shape the projection needs (FEA-3930). `artifactId` is the
 * branch's artifact id (the id `/branches/<id>` routes on and the id the FTS
 * re-authorization checks). `title` is the branch name; `body` is any additional
 * branch context (base branch / repo). Visibility follows the branch's
 * denormalized `organizationId`; `projectId`/`assigneeId` are null.
 */
export type BranchProjectionSource = {
  artifactId: string;
  organizationId: string;
  title: string;
  body: string | null;
  /** The branch artifact's `Priority` member (ISS-10332); null when unset. */
  priority: string | null;
  updatedAt: Date;
};

/**
 * Map a created/updated Branch to its projection row. Branches route by id
 * (`/branches/<artifactId>`) and carry no slug/subtype/team/anchor.
 */
export function branchProjection(
  branch: BranchProjectionSource
): SearchProjectionInput {
  return {
    organizationId: branch.organizationId,
    entityType: SearchEntityType.Branch,
    entityId: branch.artifactId,
    title: branch.title,
    body: branch.body,
    projectId: null,
    assigneeId: null,
    // A branch carries no status in the projection; its priority is the
    // artifact's (ISS-10332), so `:priority=NONE` can find an unprioritized one.
    status: null,
    priority: branch.priority,
    updatedAt: branch.updatedAt,
    slug: null,
    entitySubtype: null,
    teamId: null,
    anchorEntityId: null,
  };
}

/**
 * The minimal AgentComponent shape the projection needs (FEA-4011 Slice A).
 * `id` is the component row's UUID (the projection `entity_id`); the web
 * `/agents/<slug>` route is keyed on the org-identity slug, which rides in the
 * projection's `slug` column instead. `name` is often null on the source row, so
 * the title falls back through `componentKey` → `externalComponentId`.
 * `description` is the searchable body (bounded by the index service); the
 * 256 KiB definition `content` is deliberately NOT indexed. `componentKind` is
 * the entity subtype and one of the two inputs to the slug codec.
 */
export type AgentComponentProjectionSource = {
  id: string;
  organizationId: string;
  componentKind: string;
  name: string | null;
  componentKey: string | null;
  externalComponentId: string;
  description: string | null;
  updatedAt: Date;
  // FEA-4335: the coarse content hash so the search hit routes to the
  // content-hash detail URI (`${kind}::${contentHash}`), not the name-level slug
  // that collides two same-named different-content components onto one detail.
  // Optional/nullable: a legacy or event-minted row with no captured hash falls
  // back to the name-level slug (skew-safe, still routable, collapses as before).
  contentHash?: string | null;
};

/**
 * Map a created/updated AgentComponent to its projection row (FEA-4011 Slice A).
 * Title prefers the display `name`, falling back to `componentKey` then the
 * always-present `externalComponentId` (a component's `name` is frequently
 * null). Body is the `description` only — the full definition `content` is left
 * out so a large definition never bloats the generated `tsv`. The `/agents`
 * route slug is the org-identity `${kind}::${normalizedKey}` handle, built via
 * the shared {@link encodeComponentSlug} codec (SSOT — never re-derived here) so
 * desktop and cloud agree on the identity. When the normalized identity is empty
 * (both `componentKey` and `name` null/blank), the slug is stored NULL — an
 * empty `${kind}::` handle cannot resolve back to a detail row, so the hit
 * degrades to a non-link instead of a clickable `/agents/tool::` 404.
 * Status/priority/project/team/anchor do not apply to a component and are null;
 * visibility is the component's own `organizationId` (no assignee).
 */
export function agentComponentProjection(
  component: AgentComponentProjectionSource
): SearchProjectionInput {
  const title =
    component.name ?? component.componentKey ?? component.externalComponentId;
  return {
    organizationId: component.organizationId,
    entityType: SearchEntityType.AgentComponent,
    entityId: component.id,
    title,
    body: component.description,
    projectId: null,
    assigneeId: null,
    status: null,
    priority: null,
    updatedAt: component.updatedAt,
    // FEA-4335: prefer the content-hash routable slug (`${kind}::${contentHash}`)
    // so two same-named different-content components route to DISTINCT detail
    // URIs instead of colliding on the name-level slug; fall back to the
    // name-level slug (null-safe) for a hash-less legacy/event-minted row. Null
    // when the identity is empty (`${kind}::` cannot route) so the hit degrades to
    // a non-link instead of a `/agents/tool::` 404. SSOT codec.
    slug: agentComponentSearchSlug(component),
    entitySubtype: component.componentKind,
    teamId: null,
    anchorEntityId: null,
  };
}

/**
 * FEA-4335: the routable `/agents/<slug>` slug for a search hit. When the row
 * carries a content hash, route to the content-hash detail key
 * (`${kind}::${fingerprint}`) so same-named different-content components resolve
 * to DISTINCT detail pages — matching the list emit's `routableComponentHashKey`.
 * A hash-less legacy/event-minted row falls back to the name-level
 * `routableComponentSlug` (which returns null on an empty identity so the hit
 * degrades to a non-link, never a `/agents/tool::` 404).
 */
function agentComponentSearchSlug(
  component: AgentComponentProjectionSource
): string | null {
  const fingerprint = resolveVersionFingerprint(component.contentHash);
  if (fingerprint) {
    return routableComponentHashKey(
      component.componentKind,
      fingerprint,
      component.componentKey,
      component.name
    );
  }
  return routableComponentSlug(
    component.componentKind,
    component.componentKey,
    component.name
  );
}

/** One org's rows of one type — the scope a batched in-place update keeps. */
export type SearchProjectionScope = Omit<SearchProjectionKey, "entityId">;
