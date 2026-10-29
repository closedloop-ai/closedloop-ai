import {
  CommentTargetType,
  TRACE_COMMENT_LIST_DEFAULT_LIMIT,
  TRACE_COMMENT_LIST_MAX_LIMIT,
  TRACE_COMMENT_LIST_MAX_OFFSET,
  type TraceComment,
  type TraceCommentListResponse,
} from "@repo/api/src/types/comment";
import type { TransactionClient } from "@repo/database";
import {
  BranchProductReadWorkload,
  withBranchProductReadSnapshot,
} from "@/app/branches/branch-product-read-snapshot";
import { nextOffsetCursor } from "@/lib/offset-cursor";
import { loadCommentAuthors } from "./comment-thread-rows";
import { parseTraceCommentMetadata } from "./trace-comment-metadata";
import {
  type AggregateTraceCommentFilters,
  buildAggregateTraceCommentWhere,
  getAggregateTraceCommentCandidatePage,
  getEligibleProductBranchIds,
} from "./trace-comment-product-read";
import {
  mapTraceCommentRow,
  type TraceCommentRow,
  traceCommentThreadSelect,
} from "./trace-comment-reply-mapper";
import type { TraceCommentTargetRecord } from "./trace-comment-target-lookup";

/**
 * Org-scoped aggregate list of trace comments across every session/branch
 * (FEA-3550), so a caller (e.g. the babysit open-comment sweep, a future
 * comment inbox) can page "all open comments" with a single request instead of
 * fanning out one call per session. Org-scoping is enforced at the DB layer via
 * `organizationId`, matching the per-session read, so a caller never sees a
 * thread outside their org. Each row is a full `TraceComment` carrying its
 * parent `target`/`artifactId` for deep-linking.
 */
export function listAllTraceComments(input: {
  organizationId: string;
  userId: string;
  filters: AggregateTraceCommentFilters & {
    limit?: number;
    offset?: number;
    cursor?: number;
  };
}): Promise<TraceCommentListResponse> {
  const limit = Math.min(
    input.filters.limit ?? TRACE_COMMENT_LIST_DEFAULT_LIMIT,
    TRACE_COMMENT_LIST_MAX_LIMIT
  );
  // A `cursor` (opaque next-offset token from a prior page) wins over a raw
  // `offset` when both are supplied.
  const offset = input.filters.cursor ?? input.filters.offset ?? 0;
  const where = buildAggregateTraceCommentWhere(
    input.organizationId,
    input.filters
  );

  return withBranchProductReadSnapshot(
    input.organizationId,
    async (db) => {
      const page = await getAggregateTraceCommentCandidatePage(
        db,
        input.organizationId,
        input.filters,
        limit,
        offset
      );
      const hydrated =
        page.ids.length === 0
          ? []
          : await db.commentThread.findMany({
              where: { AND: [where, { id: { in: page.ids } }] },
              select: traceCommentThreadSelect,
            });
      const rowsById = new Map(hydrated.map((row) => [row.id, row]));
      const rows = page.ids.flatMap((id) => {
        const row = rowsById.get(id);
        return row ? [row] : [];
      });
      const items = await mapAggregateTraceCommentRows(
        db,
        input.organizationId,
        input.userId,
        rows
      );
      const eligibleBranchIds = await getEligibleProductBranchIds(
        db,
        input.organizationId,
        items.flatMap((item) =>
          item.target.type === CommentTargetType.Branch ? [item.artifactId] : []
        )
      );
      const gatedItems = items.filter(
        (item) =>
          item.target.type !== CommentTargetType.Branch ||
          eligibleBranchIds.has(item.artifactId)
      );
      const nextCursor = nextOffsetCursor(
        offset + page.ids.length,
        page.total,
        TRACE_COMMENT_LIST_MAX_OFFSET
      );
      return { items: gatedItems, total: page.total, nextCursor };
    },
    BranchProductReadWorkload.FullCorpus
  );
}

/**
 * Maps aggregate `CommentThread` rows into `TraceComment`s (FEA-3550). Unlike the
 * per-session read, each row carries a different parent artifact, so the target
 * record is reconstructed per row from the thread's metadata (target type +
 * surface) and artifact id. Authors are fetched org-scoped in one batched query.
 */
async function mapAggregateTraceCommentRows(
  db: Pick<TransactionClient, "user">,
  organizationId: string,
  viewerUserId: string,
  rows: TraceCommentRow[]
): Promise<TraceComment[]> {
  const traceRows = rows.filter((row) =>
    parseTraceCommentMetadata(row.metadata)
  );
  const authorById = await loadCommentAuthors(db, organizationId, traceRows);
  return traceRows.flatMap((row) => {
    const metadata = parseTraceCommentMetadata(row.metadata);
    if (!metadata) {
      return [];
    }
    const resolved: TraceCommentTargetRecord = {
      artifactId: row.artifactId,
      target: { type: metadata.targetType, id: row.artifactId },
      surface: metadata.surface,
    };
    return mapTraceCommentRow(row, authorById, resolved, viewerUserId);
  });
}
