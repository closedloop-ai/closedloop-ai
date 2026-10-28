import { BranchParticipationKind } from "@repo/api/src/types/branch";
import {
  CommentSurface,
  CommentTargetType,
  ThreadSource,
  type TraceComment,
} from "@repo/api/src/types/comment";
import { ArtifactType } from "@repo/database";
import {
  findArtifactThreadRows,
  loadCommentAuthors,
} from "@/app/comments/service/comment-thread-rows";
import { resolveProductBranchArtifactId } from "@/app/comments/service/trace-comment-product-read";
import {
  mapTraceCommentRow,
  traceCommentThreadSelect,
} from "@/app/comments/service/trace-comment-reply-mapper";
import { TRACE_COMMENT_TARGET_THREAD_LIMIT } from "@/app/comments/service/trace-comment-thread-limit";
import { withBranchProductReadSnapshot } from "./branch-product-read-snapshot";
import { sessionLinkWhere } from "./branch-read-service/session-usage-link-read";
import { branchParticipationForLink } from "./branch-read-service/session-usage-window";
import { branchHasCloudEligibility } from "./cloud-branch-eligibility";

/** ISS-12282: one batch read for the Branch timeline and its Session comments. */
export const branchTraceCommentsService = {
  list(input: {
    organizationId: string;
    userId: string;
    branchId: string;
  }): Promise<TraceComment[] | null> {
    return withBranchProductReadSnapshot(input.organizationId, async (db) => {
      const artifactId = await resolveProductBranchArtifactId(db, {
        organizationId: input.organizationId,
        targetId: input.branchId,
      });
      if (
        !(
          artifactId &&
          (await branchHasCloudEligibility(
            db,
            input.organizationId,
            artifactId
          ))
        )
      ) {
        return null;
      }
      const membership = sessionLinkWhere(input.organizationId, [artifactId]);
      const branchThreads = await findArtifactThreadRows(db, {
        organizationId: input.organizationId,
        artifactId,
        surface: CommentSurface.BranchTimeline,
        take: TRACE_COMMENT_TARGET_THREAD_LIMIT,
      });
      // A nested take retains the legacy PER-SESSION limit, never a shared cap.
      const rows = await db.artifact.findMany({
        where: {
          organizationId: input.organizationId,
          type: ArtifactType.SESSION,
          sourceLinks: { some: membership },
        },
        select: {
          id: true,
          sourceLinks: {
            where: membership,
            select: { branchParticipation: true, metadata: true },
          },
          commentThreads: {
            where: {
              organizationId: input.organizationId,
              source: ThreadSource.Native,
              metadata: {
                path: ["surface"],
                equals: CommentSurface.SessionDetail,
              },
            },
            select: traceCommentThreadSelect,
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: TRACE_COMMENT_TARGET_THREAD_LIMIT,
          },
        },
      });
      const participatingRows = rows.filter((row) =>
        row.sourceLinks.some(
          (link) =>
            branchParticipationForLink(link) !==
            BranchParticipationKind.Reviewed
        )
      );
      const authors = await loadCommentAuthors(db, input.organizationId, [
        ...branchThreads,
        ...participatingRows.flatMap((row) => row.commentThreads),
      ]);
      const comments = participatingRows.flatMap((row) =>
        row.commentThreads.flatMap((thread) =>
          mapTraceCommentRow(
            thread,
            authors,
            {
              artifactId: row.id,
              target: { type: CommentTargetType.Session, id: row.id },
              surface: CommentSurface.SessionDetail,
            },
            input.userId
          )
        )
      );
      if (
        !(await branchHasCloudEligibility(db, input.organizationId, artifactId))
      ) {
        return null;
      }
      const branchComments = branchThreads.flatMap((thread) =>
        mapTraceCommentRow(
          thread,
          authors,
          {
            artifactId,
            target: { type: CommentTargetType.Branch, id: input.branchId },
            surface: CommentSurface.BranchTimeline,
          },
          input.userId
        )
      );
      return [...branchComments, ...comments];
    });
  },
};
