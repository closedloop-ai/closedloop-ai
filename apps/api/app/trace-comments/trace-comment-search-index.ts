/**
 * FEA-3930 — best-effort, fail-open write hooks that keep the `search_document`
 * projection eventually consistent with native trace comments. A trace comment
 * routes to the artifact it is anchored on (a session or a branch), so its
 * projection row carries the anchor artifact's id + TYPE (see
 * `commentProjection` / `searchHitRoute`).
 *
 * These wrap `searchIndexService.indexAfterCommit` / `removeAfterCommit`, which
 * are themselves post-commit + `waitUntil` + swallow-on-error, so a projection
 * failure can never roll back or 500 the authoritative comment write. The
 * one-shot backfill (`packages/database` `backfill:search-documents`) is the
 * reconcile net for any hook that silently lost (e.g. a cascaded reply delete).
 *
 * Kept in a sibling module so the (grandfathered, over-ceiling) trace-comments
 * service adds only the call sites, not this logic.
 */

import { TraceCommentTargetType } from "@repo/api/src/types/comment";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { ArtifactType } from "@repo/database";
import {
  commentProjection,
  searchIndexService,
} from "@/app/search/search-index-service";

/**
 * Map a trace-comment target discriminant to the anchor artifact's
 * {@link ArtifactType} value (the Prisma enum's string value, e.g. `"SESSION"`),
 * which the route helper compares against to pick session vs branch.
 */
function anchorArtifactType(targetType: TraceCommentTargetType): string {
  return targetType === TraceCommentTargetType.Session
    ? ArtifactType.SESSION
    : ArtifactType.BRANCH;
}

/**
 * Fail-open index a trace comment into the search projection after its write
 * committed. `commentId` is the specific comment row (root or reply); `body` is
 * its plain text; `anchorArtifactId` is the session/branch artifact it lives on.
 */
export function indexTraceCommentAfterCommit(input: {
  organizationId: string;
  commentId: string;
  body: string | null;
  authorId: string;
  anchorArtifactId: string;
  targetType: TraceCommentTargetType;
  updatedAt: Date;
}): void {
  searchIndexService.indexAfterCommit(
    commentProjection({
      id: input.commentId,
      organizationId: input.organizationId,
      title: "Comment",
      body: input.body,
      anchorEntityId: input.anchorArtifactId,
      anchorEntityType: anchorArtifactType(input.targetType),
      authorId: input.authorId,
      updatedAt: input.updatedAt,
    })
  );
}

/** Fail-open remove a trace comment's projection row after it was deleted. */
export function removeTraceCommentAfterCommit(input: {
  organizationId: string;
  commentId: string;
}): void {
  searchIndexService.removeAfterCommit({
    organizationId: input.organizationId,
    entityType: SearchEntityType.Comment,
    entityId: input.commentId,
  });
}
