import { randomUUID } from "node:crypto";
import {
  ThreadStatus,
  type TraceComment,
  type TraceCommentDraft,
  type TraceCommentReply,
  type TraceCommentReplyDraft,
  TraceCommentSurface,
  type TraceCommentTarget,
  type TraceCommentUpdate,
  type TraceTextAnchor,
} from "@repo/api/src/types/comment";
import type { DesktopPrisma } from "./database/prisma-client.js";

const DESKTOP_LOCAL_TRACE_COMMENT_AUTHOR_ID = "desktop-local";
const DESKTOP_LOCAL_TRACE_COMMENT_AUTHOR_NAME = "You";
const TRACE_COMMENT_SYNC_RETRY_MS = 10_000;
const TRACE_COMMENT_SYNC_BATCH_LIMIT = 20;
const TRACE_COMMENT_SYNC_TARGET_BATCH_LIMIT = 50;
const PENDING_TRACE_COMMENT_SYNC_STATUSES = [
  "local_pending",
  "sync_failed",
  "local_pending_update",
  "sync_failed_update",
  "local_pending_delete",
  "sync_failed_delete",
  "local_pending_reply",
  "sync_failed_reply",
] as const;
const HIDDEN_TRACE_COMMENT_SYNC_STATUSES = [
  "local_pending_delete",
  "sync_failed_delete",
] as const;
const PENDING_TRACE_COMMENT_REPLY_SYNC_STATUSES = [
  "local_pending_reply",
  "sync_failed_reply",
] as const;

export type UserIdentity = {
  profileId?: string | null;
  computeTargetId?: string | null;
  userId: string | null;
  organizationId: string | null;
} | null;

type RawWriteClient = {
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
};

type TraceCommentRow = {
  id: string;
  thread_id: string;
  target_type: string;
  target_id: string;
  artifact_id: string;
  surface: string;
  status: string;
  anchor: unknown;
  body: string;
  author_id: string;
  author_name: string | null;
  author_avatar_url: string | null;
  can_edit: boolean | number;
  can_delete: boolean | number;
  cloud_comment_id: string | null;
  cloud_thread_id: string | null;
  profile_id: string | null;
  sync_compute_target_id: string | null;
  sync_user_id: string | null;
  sync_organization_id: string | null;
  replies: unknown;
  sync_status: string;
  last_sync_attempt_at: string | null;
  sync_error: string | null;
  created_at: string;
  updated_at: string;
};

type TraceCommentTargetRow = {
  target_type: string;
  target_id: string;
};

type NormalizedTraceCommentScope = {
  profileId: string | null;
  computeTargetId: string | null;
  userId: string | null;
  organizationId: string | null;
};

type StoredTraceCommentReply = TraceCommentReply & {
  cloudReplyId: string | null;
  syncStatus: string;
  lastSyncAttemptAt: string | null;
  syncError: string | null;
};

export type PendingTraceCommentSyncOperation = {
  operation: "create" | "update" | "delete" | "reply";
  comment: TraceComment;
  cloudCommentId: string | null;
  reply?: TraceCommentReply;
  localReplyId?: string;
};

type PendingRootTraceCommentSyncOperation = Exclude<
  PendingTraceCommentSyncOperation["operation"],
  "reply"
>;

const TRACE_COMMENT_SELECT = `
  SELECT
    "id",
    "thread_id",
    "target_type",
    "target_id",
    "artifact_id",
    "surface",
    "status",
    "anchor",
    "body",
    "author_id",
    "author_name",
    "author_avatar_url",
    "can_edit",
    "can_delete",
    "cloud_comment_id",
    "cloud_thread_id",
    "profile_id",
    "sync_compute_target_id",
    "sync_user_id",
    "sync_organization_id",
    CAST("replies" AS TEXT) AS "replies",
    "sync_status",
    "last_sync_attempt_at",
    "sync_error",
    "created_at",
    "updated_at"
  FROM "trace_comments"
`;

/** List durable desktop-local trace comments for one session or branch target. */
export async function listLocalTraceComments(
  prisma: DesktopPrisma,
  target: TraceCommentTarget,
  identity: UserIdentity = null
): Promise<TraceComment[]> {
  const scope = normalizeTraceCommentScope(identity);
  const rows = await prisma.read((reader) =>
    reader.$queryRawUnsafe<TraceCommentRow[]>(
      `${TRACE_COMMENT_SELECT}
       WHERE "target_type" = ? AND "target_id" = ?
         ${traceCommentScopeSql()}
         AND "sync_status" NOT IN (${sqlPlaceholders(
           HIDDEN_TRACE_COMMENT_SYNC_STATUSES.length
         )})
       ORDER BY "created_at" ASC, "id" ASC`,
      target.type,
      target.id,
      ...traceCommentScopeParams(scope),
      ...HIDDEN_TRACE_COMMENT_SYNC_STATUSES
    )
  );
  return rows.map((row) => rowToTraceComment(row, identity));
}

/** Persist a local comment before any cloud work, so desktop commenting works offline. */
export async function createLocalTraceComment(
  prisma: DesktopPrisma,
  target: TraceCommentTarget,
  draft: TraceCommentDraft,
  identity: UserIdentity
): Promise<TraceComment> {
  const scope = normalizeTraceCommentScope(identity);
  const createdAt = new Date().toISOString();
  const comment: TraceComment = {
    id: `local-${randomUUID()}`,
    threadId: `local-thread-${randomUUID()}`,
    target: { type: target.type, id: target.id },
    artifactId: target.id,
    surface: surfaceForTarget(target),
    status: ThreadStatus.Open,
    anchor: draft.anchor,
    body: draft.body,
    createdAt,
    updatedAt: createdAt,
    editedAt: null,
    authorId: identity?.userId ?? DESKTOP_LOCAL_TRACE_COMMENT_AUTHOR_ID,
    authorName: DESKTOP_LOCAL_TRACE_COMMENT_AUTHOR_NAME,
    authorAvatarUrl: null,
    canEdit: true,
    canDelete: true,
    replies: [],
  };

  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO "trace_comments" (
        "id",
        "thread_id",
        "target_type",
        "target_id",
        "artifact_id",
        "surface",
        "status",
        "anchor",
        "body",
        "author_id",
        "author_name",
        "author_avatar_url",
        "can_edit",
        "can_delete",
        "profile_id",
        "sync_compute_target_id",
        "sync_user_id",
        "sync_organization_id",
        "replies",
        "sync_status",
        "created_at",
        "updated_at"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local_pending', ?, ?)`,
      comment.id,
      comment.threadId,
      comment.target.type,
      comment.target.id,
      comment.artifactId,
      comment.surface,
      comment.status,
      stringifyAnchor(comment.anchor),
      comment.body,
      comment.authorId,
      comment.authorName,
      comment.authorAvatarUrl,
      true,
      true,
      scope.profileId,
      scope.computeTargetId,
      scope.userId,
      scope.organizationId,
      stringifyReplies(comment.replies ?? []),
      comment.createdAt,
      comment.updatedAt
    )
  );

  return comment;
}

/** Append a local reply without requiring cloud access. */
export async function createLocalTraceCommentReply(
  prisma: DesktopPrisma,
  target: TraceCommentTarget,
  commentId: string,
  draft: TraceCommentReplyDraft,
  identity: UserIdentity
): Promise<TraceComment> {
  const scope = normalizeTraceCommentScope(identity);
  const createdAt = new Date().toISOString();
  const updated = await prisma.write(async (client) => {
    const rows = await client.$queryRawUnsafe<TraceCommentRow[]>(
      `${TRACE_COMMENT_SELECT}
       WHERE "id" = ?
         AND "target_type" = ?
         AND "target_id" = ?
         ${traceCommentScopeSql()}
       LIMIT 1`,
      commentId,
      target.type,
      target.id,
      ...traceCommentScopeParams(scope)
    );
    const row = rows[0];
    if (
      !row ||
      HIDDEN_TRACE_COMMENT_SYNC_STATUSES.some(
        (status) => status === row.sync_status
      )
    ) {
      return null;
    }

    const reply: StoredTraceCommentReply = {
      id: `local-reply-${randomUUID()}`,
      threadId: row.thread_id,
      body: draft.body,
      createdAt,
      updatedAt: createdAt,
      editedAt: null,
      authorId: identity?.userId ?? DESKTOP_LOCAL_TRACE_COMMENT_AUTHOR_ID,
      authorName: DESKTOP_LOCAL_TRACE_COMMENT_AUTHOR_NAME,
      authorAvatarUrl: null,
      canEdit: true,
      canDelete: true,
      syncStatus: "local_pending_reply",
      cloudReplyId: null,
      lastSyncAttemptAt: null,
      syncError: null,
    };
    const replies = [...parseStoredReplies(row.replies), reply];

    await client.$executeRawUnsafe(
      `UPDATE "trace_comments"
       SET
         "replies" = ?,
         "last_sync_attempt_at" = NULL,
         "sync_error" = NULL
       WHERE "id" = ?`,
      stringifyReplies(replies),
      row.id
    );

    const afterUpdate = await client.$queryRawUnsafe<TraceCommentRow[]>(
      `${TRACE_COMMENT_SELECT}
       WHERE "id" = ?
         AND "target_type" = ?
         AND "target_id" = ?
         ${traceCommentScopeSql()}
       LIMIT 1`,
      commentId,
      target.type,
      target.id,
      ...traceCommentScopeParams(scope)
    );
    return afterUpdate[0] ?? null;
  });
  if (!updated) {
    throw new Error("Trace comment not found.");
  }
  return rowToTraceComment(updated, identity);
}

/** Update an owned local trace comment without requiring cloud access. */
export async function updateLocalTraceComment(
  prisma: DesktopPrisma,
  target: TraceCommentTarget,
  commentId: string,
  update: TraceCommentUpdate,
  identity: UserIdentity
): Promise<TraceComment> {
  const scope = normalizeTraceCommentScope(identity);
  const row = await findOwnedLocalTraceComment(
    prisma,
    target,
    commentId,
    identity,
    "edit"
  );
  if (!row) {
    throw new Error("Trace comment not found or not editable.");
  }

  const updatedAt = new Date().toISOString();
  const nextStatus = row.cloud_comment_id
    ? "local_pending_update"
    : "local_pending";
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `UPDATE "trace_comments"
       SET
         "body" = ?,
         "sync_status" = ?,
         "last_sync_attempt_at" = NULL,
         "sync_error" = NULL,
         "updated_at" = ?
       WHERE "id" = ?`,
      update.body,
      nextStatus,
      updatedAt,
      row.id
    )
  );

  const updated = await findLocalTraceComment(prisma, target, commentId, scope);
  if (!updated) {
    throw new Error("Trace comment update failed.");
  }
  return rowToTraceComment(updated, identity);
}

/** Delete an owned local trace comment without requiring cloud access. */
export async function deleteLocalTraceComment(
  prisma: DesktopPrisma,
  target: TraceCommentTarget,
  commentId: string,
  identity: UserIdentity
): Promise<{ deleted: true }> {
  const row = await findOwnedLocalTraceComment(
    prisma,
    target,
    commentId,
    identity,
    "delete"
  );
  if (!row) {
    throw new Error("Trace comment not found or not editable.");
  }

  if (!row.cloud_comment_id) {
    await prisma.write((client) =>
      client.$executeRawUnsafe(
        `DELETE FROM "trace_comments" WHERE "id" = ?`,
        row.id
      )
    );
    return { deleted: true };
  }

  const updatedAt = new Date().toISOString();
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `UPDATE "trace_comments"
       SET
         "sync_status" = 'local_pending_delete',
         "last_sync_attempt_at" = NULL,
         "sync_error" = NULL,
         "updated_at" = ?
       WHERE "id" = ?`,
      updatedAt,
      row.id
    )
  );
  return { deleted: true };
}

/**
 * Reconcile cloud comments into the durable desktop store without duplicating
 * pending locals. A successful cloud list is authoritative for already-synced
 * cloud-backed rows, so comments deleted in web are pruned locally while
 * unsynced local creates/edits/deletes remain protected.
 */
export async function upsertCloudTraceComments(
  prisma: DesktopPrisma,
  target: TraceCommentTarget,
  comments: readonly TraceComment[],
  identity: UserIdentity = null
): Promise<void> {
  const scope = normalizeTraceCommentScope(identity);
  await prisma.write(async (client) => {
    for (const comment of comments) {
      await upsertCloudTraceComment(client, target, comment, scope);
    }
    await pruneMissingSyncedCloudTraceComments(
      client,
      target,
      comments.map((comment) => comment.id),
      scope
    );
  });
}

/** Pending local comments that should be retried for cloud upload. */
export async function listPendingLocalTraceComments(
  prisma: DesktopPrisma,
  target: TraceCommentTarget,
  identity: UserIdentity = null
): Promise<TraceComment[]> {
  const scope = normalizeTraceCommentScope(identity);
  const retryBefore = new Date(
    Date.now() - TRACE_COMMENT_SYNC_RETRY_MS
  ).toISOString();
  const rows = await prisma.read((reader) =>
    reader.$queryRawUnsafe<TraceCommentRow[]>(
      `${TRACE_COMMENT_SELECT}
       WHERE "target_type" = ?
         AND "target_id" = ?
         ${traceCommentScopeSql()}
         AND "cloud_comment_id" IS NULL
         AND "sync_status" IN ('local_pending', 'sync_failed')
         AND (
           "last_sync_attempt_at" IS NULL
           OR "last_sync_attempt_at" <= ?
         )
       ORDER BY "created_at" ASC, "id" ASC
       LIMIT ?`,
      target.type,
      target.id,
      ...traceCommentScopeParams(scope),
      retryBefore,
      TRACE_COMMENT_SYNC_BATCH_LIMIT
    )
  );
  return rows.map((row) => rowToTraceComment(row));
}

/** Pending local create/update/delete operations for one target. */
export async function listPendingLocalTraceCommentOperations(
  prisma: DesktopPrisma,
  target: TraceCommentTarget,
  identity: UserIdentity = null
): Promise<PendingTraceCommentSyncOperation[]> {
  const scope = normalizeTraceCommentScope(identity);
  const retryBefore = new Date(
    Date.now() - TRACE_COMMENT_SYNC_RETRY_MS
  ).toISOString();
  const rows = await prisma.read((reader) =>
    reader.$queryRawUnsafe<TraceCommentRow[]>(
      `${TRACE_COMMENT_SELECT}
       WHERE "target_type" = ?
         AND "target_id" = ?
         ${traceCommentScopeSql()}
         AND (
           "sync_status" IN (${sqlPlaceholders(
             PENDING_TRACE_COMMENT_SYNC_STATUSES.length
           )})
           OR CAST("replies" AS TEXT) LIKE ?
           OR CAST("replies" AS TEXT) LIKE ?
         )
         AND (
           "last_sync_attempt_at" IS NULL
           OR "last_sync_attempt_at" <= ?
         )
       ORDER BY "updated_at" ASC, "created_at" ASC, "id" ASC
       LIMIT ?`,
      target.type,
      target.id,
      ...traceCommentScopeParams(scope),
      ...PENDING_TRACE_COMMENT_SYNC_STATUSES,
      "%local_pending_reply%",
      "%sync_failed_reply%",
      retryBefore,
      TRACE_COMMENT_SYNC_BATCH_LIMIT
    )
  );
  return rows.flatMap(rowToPendingTraceCommentSyncOperation);
}

/** Targets with pending local uploads that should be retried without UI activity. */
export async function listPendingLocalTraceCommentTargets(
  prisma: DesktopPrisma,
  identity: UserIdentity = null
): Promise<TraceCommentTarget[]> {
  const scope = normalizeTraceCommentScope(identity);
  const retryBefore = new Date(
    Date.now() - TRACE_COMMENT_SYNC_RETRY_MS
  ).toISOString();
  const rows = await prisma.read((reader) =>
    reader.$queryRawUnsafe<TraceCommentTargetRow[]>(
      `SELECT
         "target_type",
         "target_id",
         MIN("created_at") AS "first_created_at"
       FROM "trace_comments"
       WHERE (
           ${traceCommentScopeConditionSql()}
         )
         AND (
           "sync_status" IN (${sqlPlaceholders(
             PENDING_TRACE_COMMENT_SYNC_STATUSES.length
           )})
           OR CAST("replies" AS TEXT) LIKE ?
           OR CAST("replies" AS TEXT) LIKE ?
         )
         AND (
           "last_sync_attempt_at" IS NULL
           OR "last_sync_attempt_at" <= ?
         )
       GROUP BY "target_type", "target_id"
       ORDER BY "first_created_at" ASC, "target_type" ASC, "target_id" ASC
      LIMIT ?`,
      ...traceCommentScopeConditionParams(scope),
      ...PENDING_TRACE_COMMENT_SYNC_STATUSES,
      "%local_pending_reply%",
      "%sync_failed_reply%",
      retryBefore,
      TRACE_COMMENT_SYNC_TARGET_BATCH_LIMIT
    )
  );
  return rows.map(rowToTraceCommentTarget);
}

/** Attach cloud ids/details to a local row after upload succeeds. */
export async function markLocalTraceCommentUploaded(
  prisma: DesktopPrisma,
  localCommentId: string,
  cloudComment: TraceComment
): Promise<void> {
  const now = new Date().toISOString();
  const author = localAuthorForCloudComment(cloudComment);
  await prisma.write(async (client) => {
    const current = await client.$queryRawUnsafe<
      Pick<TraceCommentRow, "replies">[]
    >(
      `SELECT CAST("replies" AS TEXT) AS "replies" FROM "trace_comments" WHERE "id" = ? LIMIT 1`,
      localCommentId
    );
    const replies = mergeStoredReplies(
      parseStoredReplies(current[0]?.replies),
      cloudComment.replies ?? []
    );
    await client.$executeRawUnsafe(
      `UPDATE "trace_comments"
       SET
         "thread_id" = ?,
         "target_type" = ?,
         "target_id" = ?,
         "artifact_id" = ?,
         "surface" = ?,
         "status" = ?,
         "anchor" = ?,
         "body" = ?,
         "author_id" = ?,
         "author_name" = ?,
         "author_avatar_url" = ?,
         "can_edit" = ?,
         "can_delete" = ?,
         "cloud_comment_id" = ?,
         "cloud_thread_id" = ?,
         "replies" = ?,
         "sync_status" = 'synced',
         "last_sync_attempt_at" = ?,
         "sync_error" = NULL,
         "created_at" = ?,
         "updated_at" = ?
       WHERE "id" = ?`,
      cloudComment.threadId,
      cloudComment.target.type,
      cloudComment.target.id,
      cloudComment.artifactId,
      cloudComment.surface,
      cloudComment.status,
      stringifyAnchor(cloudComment.anchor),
      cloudComment.body,
      author.id,
      author.name,
      author.avatarUrl,
      cloudComment.canEdit,
      cloudComment.canDelete,
      cloudComment.id,
      cloudComment.threadId,
      stringifyReplies(replies),
      now,
      cloudComment.createdAt,
      cloudComment.updatedAt,
      localCommentId
    );
  });
}

/** Replace one pending local reply with its cloud-backed thread payload. */
export async function markLocalTraceCommentReplyUploaded(
  prisma: DesktopPrisma,
  localCommentId: string,
  localReplyId: string,
  cloudComment: TraceComment
): Promise<void> {
  const now = new Date().toISOString();
  const author = localAuthorForCloudComment(cloudComment);
  await prisma.write(async (client) => {
    const current = await client.$queryRawUnsafe<
      Pick<TraceCommentRow, "replies">[]
    >(
      `SELECT CAST("replies" AS TEXT) AS "replies" FROM "trace_comments" WHERE "id" = ? LIMIT 1`,
      localCommentId
    );
    const replies = mergeStoredReplies(
      parseStoredReplies(current[0]?.replies).filter(
        (reply) => reply.id !== localReplyId
      ),
      cloudComment.replies ?? []
    );
    await client.$executeRawUnsafe(
      `UPDATE "trace_comments"
       SET
         "thread_id" = ?,
         "target_type" = ?,
         "target_id" = ?,
         "artifact_id" = ?,
         "surface" = ?,
         "status" = ?,
         "anchor" = ?,
         "body" = ?,
         "author_id" = ?,
         "author_name" = ?,
         "author_avatar_url" = ?,
         "can_edit" = ?,
         "can_delete" = ?,
         "cloud_comment_id" = ?,
         "cloud_thread_id" = ?,
         "replies" = ?,
         "last_sync_attempt_at" = ?,
         "sync_error" = NULL,
         "created_at" = ?,
         "updated_at" = ?
       WHERE "id" = ?`,
      cloudComment.threadId,
      cloudComment.target.type,
      cloudComment.target.id,
      cloudComment.artifactId,
      cloudComment.surface,
      cloudComment.status,
      stringifyAnchor(cloudComment.anchor),
      cloudComment.body,
      author.id,
      author.name,
      author.avatarUrl,
      cloudComment.canEdit,
      cloudComment.canDelete,
      cloudComment.id,
      cloudComment.threadId,
      stringifyReplies(replies),
      now,
      cloudComment.createdAt,
      cloudComment.updatedAt,
      localCommentId
    );
  });
}

/** Remove a locally hidden row after its cloud delete succeeds. */
export async function markLocalTraceCommentDeleted(
  prisma: DesktopPrisma,
  localCommentId: string
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `DELETE FROM "trace_comments" WHERE "id" = ?`,
      localCommentId
    )
  );
}

/** Record a failed best-effort upload without breaking the local comment. */
export async function markLocalTraceCommentSyncFailed(
  prisma: DesktopPrisma,
  localCommentId: string,
  error: unknown,
  operation: PendingRootTraceCommentSyncOperation = "create"
): Promise<void> {
  const now = new Date().toISOString();
  let syncStatus = "sync_failed";
  if (operation === "update") {
    syncStatus = "sync_failed_update";
  } else if (operation === "delete") {
    syncStatus = "sync_failed_delete";
  }
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `UPDATE "trace_comments"
       SET
         "sync_status" = ?,
         "last_sync_attempt_at" = ?,
         "sync_error" = ?,
         "updated_at" = ?
       WHERE "id" = ?`,
      syncStatus,
      now,
      typeof error === "string" ? error : syncErrorMessage(error),
      now,
      localCommentId
    )
  );
}

/** Record a failed reply upload while preserving the local reply for retry. */
export async function markLocalTraceCommentReplySyncFailed(
  prisma: DesktopPrisma,
  localCommentId: string,
  localReplyId: string,
  error: unknown
): Promise<void> {
  const now = new Date().toISOString();
  await prisma.write(async (client) => {
    const current = await client.$queryRawUnsafe<
      Pick<TraceCommentRow, "replies">[]
    >(
      `SELECT CAST("replies" AS TEXT) AS "replies" FROM "trace_comments" WHERE "id" = ? LIMIT 1`,
      localCommentId
    );
    const replies = parseStoredReplies(current[0]?.replies).map((reply) =>
      reply.id === localReplyId
        ? {
            ...reply,
            syncStatus: "sync_failed_reply",
            lastSyncAttemptAt: now,
            syncError: syncErrorMessage(error),
          }
        : reply
    );
    await client.$executeRawUnsafe(
      `UPDATE "trace_comments"
       SET
         "replies" = ?,
         "last_sync_attempt_at" = ?,
         "sync_error" = ?
       WHERE "id" = ?`,
      stringifyReplies(replies),
      now,
      syncErrorMessage(error),
      localCommentId
    );
  });
}

async function upsertCloudTraceComment(
  client: RawWriteClient,
  target: TraceCommentTarget,
  comment: TraceComment,
  scope: NormalizedTraceCommentScope
): Promise<void> {
  const anchorJson = stringifyAnchor(comment.anchor);
  const author = localAuthorForCloudComment(comment);
  const existing = await client.$queryRawUnsafe<
    { id: string; sync_status: string }[]
  >(
    `SELECT "id", "sync_status"
     FROM "trace_comments"
     WHERE ("cloud_comment_id" = ? OR "id" = ?)
       ${traceCommentScopeSql()}
     LIMIT 1`,
    comment.id,
    comment.id,
    ...traceCommentScopeParams(scope)
  );
  let rowId = existing[0]?.id ?? null;

  if (!rowId) {
    const pending = await client.$queryRawUnsafe<
      { id: string; sync_status: string }[]
    >(
      `SELECT "id", "sync_status"
       FROM "trace_comments"
       WHERE "target_type" = ?
         AND "target_id" = ?
         AND "cloud_comment_id" IS NULL
         AND "body" = ?
         AND "anchor" = ?
         ${traceCommentScopeSql()}
       ORDER BY "created_at" ASC, "id" ASC
       LIMIT 1`,
      target.type,
      target.id,
      comment.body,
      anchorJson,
      ...traceCommentScopeParams(scope)
    );
    rowId = pending[0]?.id ?? null;
  }

  if (rowId) {
    const current = await client.$queryRawUnsafe<
      { replies: unknown; sync_status: string }[]
    >(
      `SELECT CAST("replies" AS TEXT) AS "replies", "sync_status" FROM "trace_comments" WHERE "id" = ? LIMIT 1`,
      rowId
    );
    const syncStatus =
      existing.find((row) => row.id === rowId)?.sync_status ??
      current[0]?.sync_status ??
      "";
    if (
      syncStatus === "local_pending_update" ||
      syncStatus === "sync_failed_update" ||
      syncStatus === "local_pending_delete" ||
      syncStatus === "sync_failed_delete"
    ) {
      return;
    }
    const replies = mergeStoredReplies(
      parseStoredReplies(current[0]?.replies),
      comment.replies ?? []
    );
    await client.$executeRawUnsafe(
      `UPDATE "trace_comments"
       SET
         "thread_id" = ?,
         "target_type" = ?,
         "target_id" = ?,
         "artifact_id" = ?,
         "surface" = ?,
         "status" = ?,
         "anchor" = ?,
         "body" = ?,
         "author_id" = ?,
         "author_name" = ?,
         "author_avatar_url" = ?,
         "can_edit" = ?,
         "can_delete" = ?,
         "profile_id" = ?,
         "sync_compute_target_id" = ?,
         "sync_user_id" = ?,
         "sync_organization_id" = ?,
         "cloud_comment_id" = ?,
         "cloud_thread_id" = ?,
         "replies" = ?,
         "sync_status" = 'synced',
         "last_sync_attempt_at" = ?,
         "sync_error" = NULL,
         "created_at" = ?,
         "updated_at" = ?
       WHERE "id" = ?`,
      comment.threadId,
      target.type,
      target.id,
      comment.artifactId,
      comment.surface,
      comment.status,
      anchorJson,
      comment.body,
      author.id,
      author.name,
      author.avatarUrl,
      comment.canEdit,
      comment.canDelete,
      scope.profileId,
      scope.computeTargetId,
      scope.userId,
      scope.organizationId,
      comment.id,
      comment.threadId,
      stringifyReplies(replies),
      new Date().toISOString(),
      comment.createdAt,
      comment.updatedAt,
      rowId
    );
    return;
  }

  await client.$executeRawUnsafe(
    `INSERT INTO "trace_comments" (
      "id",
      "thread_id",
      "target_type",
      "target_id",
      "artifact_id",
      "surface",
      "status",
      "anchor",
      "body",
      "author_id",
      "author_name",
      "author_avatar_url",
      "can_edit",
      "can_delete",
      "profile_id",
      "sync_compute_target_id",
      "sync_user_id",
      "sync_organization_id",
      "cloud_comment_id",
      "cloud_thread_id",
      "replies",
      "sync_status",
      "last_sync_attempt_at",
      "created_at",
      "updated_at"
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?, ?)`,
    comment.id,
    comment.threadId,
    target.type,
    target.id,
    comment.artifactId,
    comment.surface,
    comment.status,
    anchorJson,
    comment.body,
    author.id,
    author.name,
    author.avatarUrl,
    comment.canEdit,
    comment.canDelete,
    scope.profileId,
    scope.computeTargetId,
    scope.userId,
    scope.organizationId,
    comment.id,
    comment.threadId,
    stringifyReplies((comment.replies ?? []).map(storedReplyFromCloudReply)),
    new Date().toISOString(),
    comment.createdAt,
    comment.updatedAt
  );
}

function localAuthorForCloudComment(comment: TraceComment): {
  id: string;
  name: string | null;
  avatarUrl: string | null;
} {
  return {
    id: comment.authorId,
    name: comment.authorName,
    avatarUrl: comment.authorAvatarUrl,
  };
}

function storedReplyFromCloudReply(
  reply: TraceCommentReply
): StoredTraceCommentReply {
  const author = localAuthorForCloudReply(reply);
  return {
    ...reply,
    authorId: author.id,
    authorName: author.name,
    authorAvatarUrl: author.avatarUrl,
    canEdit: reply.canEdit,
    canDelete: reply.canDelete,
    cloudReplyId: reply.id,
    syncStatus: "synced",
    lastSyncAttemptAt: new Date().toISOString(),
    syncError: null,
  };
}

function localAuthorForCloudReply(reply: TraceCommentReply): {
  id: string;
  name: string | null;
  avatarUrl: string | null;
} {
  return {
    id: reply.authorId,
    name: reply.authorName,
    avatarUrl: reply.authorAvatarUrl,
  };
}

function mergeStoredReplies(
  current: readonly StoredTraceCommentReply[],
  cloudReplies: readonly TraceCommentReply[] = []
): StoredTraceCommentReply[] {
  const cloud = cloudReplies.map(storedReplyFromCloudReply);
  const cloudIds = new Set(cloud.map((reply) => reply.cloudReplyId));
  const pendingLocal = current.filter(
    (reply) =>
      !reply.cloudReplyId ||
      PENDING_TRACE_COMMENT_REPLY_SYNC_STATUSES.some(
        (status) => status === reply.syncStatus
      )
  );
  const preservedPending = pendingLocal.filter(
    (reply) => !(reply.cloudReplyId && cloudIds.has(reply.cloudReplyId))
  );
  return [...cloud, ...preservedPending].sort((a, b) =>
    a.createdAt === b.createdAt
      ? a.id.localeCompare(b.id)
      : a.createdAt.localeCompare(b.createdAt)
  );
}

async function pruneMissingSyncedCloudTraceComments(
  client: RawWriteClient,
  target: TraceCommentTarget,
  cloudCommentIds: readonly string[],
  scope: NormalizedTraceCommentScope
): Promise<void> {
  const keepClause =
    cloudCommentIds.length > 0
      ? `AND "cloud_comment_id" NOT IN (${sqlPlaceholders(cloudCommentIds.length)})`
      : "";
  await client.$executeRawUnsafe(
    `DELETE FROM "trace_comments"
     WHERE "target_type" = ?
       AND "target_id" = ?
       ${traceCommentScopeSql()}
       AND "cloud_comment_id" IS NOT NULL
       AND "sync_status" = 'synced'
       AND CAST("replies" AS TEXT) NOT LIKE ?
       AND CAST("replies" AS TEXT) NOT LIKE ?
       ${keepClause}`,
    target.type,
    target.id,
    ...traceCommentScopeParams(scope),
    "%local_pending_reply%",
    "%sync_failed_reply%",
    ...cloudCommentIds
  );
}

function rowToTraceComment(
  row: TraceCommentRow,
  identity: UserIdentity = null
): TraceComment {
  const target: TraceCommentTarget = {
    type: row.target_type === "branch" ? "branch" : "session",
    id: row.target_id,
  };
  const isLocalAuthor = row.author_id === DESKTOP_LOCAL_TRACE_COMMENT_AUTHOR_ID;
  const isCurrentCloudAuthor =
    Boolean(identity?.userId) && row.author_id === identity?.userId;
  const canEdit =
    dbBoolean(row.can_edit) || isLocalAuthor || isCurrentCloudAuthor;
  const canDelete =
    dbBoolean(row.can_delete) || isLocalAuthor || isCurrentCloudAuthor;
  return {
    id: row.id,
    threadId: row.thread_id,
    target,
    artifactId: row.artifact_id,
    surface:
      row.surface === TraceCommentSurface.BranchDetail
        ? TraceCommentSurface.BranchDetail
        : TraceCommentSurface.SessionDetail,
    status:
      row.status === ThreadStatus.Resolved
        ? ThreadStatus.Resolved
        : ThreadStatus.Open,
    anchor: parseAnchor(row.anchor),
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    editedAt: row.created_at === row.updated_at ? null : row.updated_at,
    authorId: row.author_id,
    authorName: row.author_name,
    authorAvatarUrl: row.author_avatar_url,
    canEdit,
    canDelete,
    replies: parseStoredReplies(row.replies)
      .filter(
        (reply) =>
          reply.syncStatus !== "local_pending_reply_delete" &&
          reply.syncStatus !== "sync_failed_reply_delete"
      )
      .map((reply) => storedReplyToTraceCommentReply(reply, identity)),
  };
}

function rowToPendingTraceCommentSyncOperation(
  row: TraceCommentRow
): PendingTraceCommentSyncOperation[] {
  const replyOperations = row.cloud_comment_id
    ? parseStoredReplies(row.replies)
        .filter((reply) =>
          PENDING_TRACE_COMMENT_REPLY_SYNC_STATUSES.some(
            (status) => status === reply.syncStatus
          )
        )
        .map<PendingTraceCommentSyncOperation>((reply) => ({
          operation: "reply",
          comment: rowToTraceComment(row),
          cloudCommentId: row.cloud_comment_id,
          reply: storedReplyToTraceCommentReply(reply),
          localReplyId: reply.id,
        }))
    : [];
  if (
    row.sync_status === "local_pending_delete" ||
    row.sync_status === "sync_failed_delete"
  ) {
    return row.cloud_comment_id
      ? [
          {
            operation: "delete",
            comment: rowToTraceComment(row),
            cloudCommentId: row.cloud_comment_id,
          },
        ]
      : [];
  }
  if (
    row.sync_status === "local_pending_update" ||
    row.sync_status === "sync_failed_update"
  ) {
    return row.cloud_comment_id
      ? [
          {
            operation: "update",
            comment: rowToTraceComment(row),
            cloudCommentId: row.cloud_comment_id,
          },
          ...replyOperations,
        ]
      : [];
  }
  if (
    row.sync_status === "local_pending" ||
    row.sync_status === "sync_failed"
  ) {
    return [
      {
        operation: "create",
        comment: rowToTraceComment(row),
        cloudCommentId: row.cloud_comment_id,
      },
    ];
  }
  return replyOperations;
}

function rowToTraceCommentTarget(
  row: TraceCommentTargetRow
): TraceCommentTarget {
  return {
    type: row.target_type === "branch" ? "branch" : "session",
    id: row.target_id,
  };
}

async function findLocalTraceComment(
  prisma: DesktopPrisma,
  target: TraceCommentTarget,
  commentId: string,
  scope: NormalizedTraceCommentScope
): Promise<TraceCommentRow | null> {
  const rows = await prisma.read((reader) =>
    reader.$queryRawUnsafe<TraceCommentRow[]>(
      `${TRACE_COMMENT_SELECT}
       WHERE "id" = ?
         AND "target_type" = ?
         AND "target_id" = ?
         ${traceCommentScopeSql()}
       LIMIT 1`,
      commentId,
      target.type,
      target.id,
      ...traceCommentScopeParams(scope)
    )
  );
  return rows[0] ?? null;
}

async function findOwnedLocalTraceComment(
  prisma: DesktopPrisma,
  target: TraceCommentTarget,
  commentId: string,
  identity: UserIdentity,
  permission: "edit" | "delete"
): Promise<TraceCommentRow | null> {
  const row = await findLocalTraceComment(
    prisma,
    target,
    commentId,
    normalizeTraceCommentScope(identity)
  );
  if (
    !row ||
    HIDDEN_TRACE_COMMENT_SYNC_STATUSES.some(
      (status) => status === row.sync_status
    )
  ) {
    return null;
  }
  if (row.author_id === DESKTOP_LOCAL_TRACE_COMMENT_AUTHOR_ID) {
    return row;
  }
  const hasStoredPermission =
    permission === "edit" ? dbBoolean(row.can_edit) : dbBoolean(row.can_delete);
  if (hasStoredPermission) {
    return row;
  }
  if (identity?.userId && row.author_id === identity.userId) {
    return row;
  }
  return null;
}

function sqlPlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function normalizeTraceCommentScope(
  identity: UserIdentity
): NormalizedTraceCommentScope {
  return {
    profileId: identity?.profileId ?? null,
    computeTargetId: identity?.computeTargetId ?? null,
    userId: identity?.userId ?? null,
    organizationId: identity?.organizationId ?? null,
  };
}

function traceCommentScopeSql(): string {
  return `AND (${traceCommentScopeConditionSql()})`;
}

function traceCommentScopeConditionSql(): string {
  return `(
    (
      "profile_id" IS ?
      AND "sync_compute_target_id" IS ?
      AND "sync_user_id" IS ?
      AND "sync_organization_id" IS ?
    )
    OR (
      "profile_id" IS NULL
      AND "sync_compute_target_id" IS NULL
      AND "sync_user_id" IS NULL
      AND "sync_organization_id" IS NULL
    )
  )`;
}

function traceCommentScopeParams(
  scope: NormalizedTraceCommentScope
): [string | null, string | null, string | null, string | null] {
  return [
    scope.profileId,
    scope.computeTargetId,
    scope.userId,
    scope.organizationId,
  ];
}

function traceCommentScopeConditionParams(
  scope: NormalizedTraceCommentScope
): [string | null, string | null, string | null, string | null] {
  return traceCommentScopeParams(scope);
}

function dbBoolean(value: boolean | number | null | undefined): boolean {
  return value === true || value === 1;
}

function surfaceForTarget(target: TraceCommentTarget): TraceCommentSurface {
  return target.type === "branch"
    ? TraceCommentSurface.BranchDetail
    : TraceCommentSurface.SessionDetail;
}

function stringifyAnchor(anchor: TraceTextAnchor): string {
  return JSON.stringify(anchor);
}

function parseAnchor(value: unknown): TraceTextAnchor {
  if (typeof value === "string") {
    return JSON.parse(value) as TraceTextAnchor;
  }
  return value as TraceTextAnchor;
}

function stringifyReplies(
  replies: readonly StoredTraceCommentReply[] | readonly TraceCommentReply[]
): string {
  return JSON.stringify(replies);
}

function parseStoredReplies(value: unknown): StoredTraceCommentReply[] {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .filter((reply): reply is Partial<StoredTraceCommentReply> =>
      Boolean(
        reply &&
          typeof reply === "object" &&
          typeof reply.id === "string" &&
          typeof reply.body === "string"
      )
    )
    .map((reply) => ({
      id: reply.id ?? `local-reply-${randomUUID()}`,
      threadId: reply.threadId ?? "",
      body: reply.body ?? "",
      createdAt: reply.createdAt ?? new Date().toISOString(),
      updatedAt: reply.updatedAt ?? reply.createdAt ?? new Date().toISOString(),
      editedAt: reply.editedAt ?? null,
      authorId: reply.authorId ?? DESKTOP_LOCAL_TRACE_COMMENT_AUTHOR_ID,
      authorName: reply.authorName ?? DESKTOP_LOCAL_TRACE_COMMENT_AUTHOR_NAME,
      authorAvatarUrl: reply.authorAvatarUrl ?? null,
      canEdit: reply.canEdit ?? false,
      canDelete: reply.canDelete ?? false,
      cloudReplyId: reply.cloudReplyId ?? null,
      syncStatus: reply.syncStatus ?? "synced",
      lastSyncAttemptAt: reply.lastSyncAttemptAt ?? null,
      syncError: reply.syncError ?? null,
    }));
}

function storedReplyToTraceCommentReply(
  reply: StoredTraceCommentReply,
  _identity: UserIdentity = null
): TraceCommentReply {
  return {
    id: reply.cloudReplyId ?? reply.id,
    threadId: reply.threadId,
    body: reply.body,
    createdAt: reply.createdAt,
    updatedAt: reply.updatedAt,
    editedAt: reply.editedAt,
    authorId: reply.authorId,
    authorName: reply.authorName,
    authorAvatarUrl: reply.authorAvatarUrl,
    canEdit: false,
    canDelete: false,
  };
}

function syncErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1000);
}
