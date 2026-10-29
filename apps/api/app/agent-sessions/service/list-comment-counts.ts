import { withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { directCommentCountService } from "@/app/artifacts/collaborators/direct-comment-count-service";

/** Comment threads directly on each Session; replies do not increment. */
export async function loadListCommentCounts(
  organizationId: string,
  sessionArtifactIds: readonly string[]
): Promise<Map<string, number>> {
  const ids = [...new Set(sessionArtifactIds)];
  if (!ids.length) {
    return new Map();
  }
  try {
    return await withDb((db) =>
      directCommentCountService.read(db, organizationId, ids)
    );
  } catch (error) {
    // Optional enrichment retains the existing monitored failure path and omits counts.
    log.error(SESSIONS_LIST_COMMENT_COUNT_READ_FAILED_EVENT, {
      organizationId,
      sessionCount: ids.length,
      error: parseError(error),
    });
    return new Map();
  }
}

export const SESSIONS_LIST_COMMENT_COUNT_READ_FAILED_EVENT =
  "sessions_list_comment_count_read_failed";
