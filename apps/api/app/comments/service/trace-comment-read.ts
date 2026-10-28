import type { TraceComment } from "@repo/api/src/types/comment";
import type { TransactionClient } from "@repo/database";
import type { CommentPresenter } from "./comment-command-lookup";
import {
  findArtifactThreadRow,
  findArtifactThreadRows,
  loadCommentAuthors,
} from "./comment-thread-rows";
import { parseTraceCommentMetadata } from "./trace-comment-metadata";
import { mapTraceCommentRow } from "./trace-comment-reply-mapper";
import type { TraceCommentTargetRecord } from "./trace-comment-target-lookup";
import { TRACE_COMMENT_TARGET_THREAD_LIMIT } from "./trace-comment-thread-limit";

type TraceReadClient = Pick<TransactionClient, "commentThread" | "user">;

/**
 * The legacy trace-comment GET: one page of the oldest
 * {@link TRACE_COMMENT_TARGET_THREAD_LIMIT} threads on one surface, read
 * through the same row query the unified list pages with (PLN-2121
 * decision 10). Installed desktop builds read and prune against this cap.
 */
export async function readTraceCommentPage(
  db: TraceReadClient,
  input: {
    organizationId: string;
    viewerUserId: string;
    record: TraceCommentTargetRecord;
    clientId?: string;
    includeThreadId?: string;
  }
): Promise<TraceComment[]> {
  const rows = await findArtifactThreadRows(db, {
    organizationId: input.organizationId,
    artifactId: input.record.artifactId,
    surface: input.record.surface,
    ...(input.clientId ? { clientId: input.clientId } : {}),
    take: TRACE_COMMENT_TARGET_THREAD_LIMIT,
  });
  if (
    input.includeThreadId &&
    !rows.some((row) => row.id === input.includeThreadId)
  ) {
    const addressed = await findArtifactThreadRow(db, {
      organizationId: input.organizationId,
      artifactId: input.record.artifactId,
      threadId: input.includeThreadId,
    });
    if (addressed) {
      rows.push(addressed);
    }
  }
  const traceRows = rows.filter(
    (row) =>
      parseTraceCommentMetadata(row.metadata)?.surface === input.record.surface
  );
  const authorById = await loadCommentAuthors(
    db,
    input.organizationId,
    traceRows
  );
  return traceRows.flatMap((row) =>
    mapTraceCommentRow(row, authorById, input.record, input.viewerUserId)
  );
}

/** A command's result as the legacy single `TraceComment` it has always answered. */
export function presentTraceComment(input: {
  organizationId: string;
  viewerUserId: string;
  record: TraceCommentTargetRecord;
}): CommentPresenter<TraceComment> {
  return async (tx, written) => {
    const row =
      written.row ??
      (await findArtifactThreadRow(tx, {
        organizationId: input.organizationId,
        artifactId: input.record.artifactId,
        threadId: written.threadId,
      }));
    if (
      !row ||
      (written.row === undefined &&
        parseTraceCommentMetadata(row.metadata)?.surface !==
          input.record.surface)
    ) {
      return null;
    }
    const authorById = await loadCommentAuthors(tx, input.organizationId, [
      row,
    ]);
    const [comment] = mapTraceCommentRow(
      row,
      authorById,
      input.record,
      input.viewerUserId
    );
    return comment ?? null;
  };
}

/** A sync-state command's result as the legacy refreshed collection. */
export function presentTraceCommentPage(input: {
  organizationId: string;
  viewerUserId: string;
  record: TraceCommentTargetRecord;
}): CommentPresenter<TraceComment[]> {
  return (tx) => readTraceCommentPage(tx, input);
}
