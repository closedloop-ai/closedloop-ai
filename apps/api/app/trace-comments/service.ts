/**
 * ISS-11212 (PLN-2121 Step 6): the legacy trace-comment routes' adapter onto
 * the comment service. Each method maps a legacy target and surface to an
 * artifact, calls one command or read, and maps the result back to the shape
 * installed desktop builds already parse. No write happens here.
 */
import {
  CommentSurface,
  CommentTargetType,
  type TraceComment,
  type TraceCommentDraft,
  type TraceCommentListResponse,
  type TraceCommentReplyDraft,
  type TraceCommentUpdate,
} from "@repo/api/src/types/comment";
import { traceTextAnchorToCommentAnchor } from "@repo/api/src/types/comment-anchor";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import type { Result } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";
import { withBranchProductReadSnapshot } from "@/app/branches/branch-product-read-snapshot";
import { branchHasCloudEligibility } from "@/app/branches/cloud-branch-eligibility";
import { commentsService } from "@/app/comments/service";
import type { CommentViewer } from "@/app/comments/service/comment-capabilities";
import type { CommentWritten } from "@/app/comments/service/comment-command-pipeline";
import {
  type CommentTarget,
  commentArtifactTypeFor,
} from "@/app/comments/service/comment-target";
import type { AggregateTraceCommentFilters } from "@/app/comments/service/trace-comment-product-read";
import { resolveProductBranchArtifactId } from "@/app/comments/service/trace-comment-product-read";
import {
  presentTraceComment,
  presentTraceCommentPage,
  readTraceCommentPage,
} from "@/app/comments/service/trace-comment-read";
import {
  resolveSessionTraceCommentTarget,
  resolveTraceCommentTarget,
  type TraceCommentTargetInput,
  type TraceCommentTargetRecord,
} from "@/app/comments/service/trace-comment-target-lookup";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import type {
  TraceCommentFailureReason,
  TraceCommentMutationFailure,
  TraceCommentMutationResult,
} from "./trace-comment-mutation-result";

/**
 * PLN-2121 decision 3: each code maps to the status the legacy routes answer
 * today. `client_id_conflict` answered an unhandled 500 before the service
 * caught it, and is 409 now; `stale_revision` needs an `expectedRevision` the
 * legacy PATCH never sends; the anchor codes cannot pass the legacy body
 * schema; and the legacy resolvers only ever find a Session or a Branch.
 */
const LEGACY_FAILURE_BY_CODE = {
  [CommentErrorCode.NotFound]: "not_found",
  [CommentErrorCode.CapabilityDenied]: "forbidden",
  [CommentErrorCode.ClientIdConflict]: "conflict",
  [CommentErrorCode.StaleRevision]: "conflict",
  [CommentErrorCode.AnchorInvalid]: "bad_request",
  [CommentErrorCode.AnchorKindNotAllowed]: "bad_request",
  [CommentErrorCode.ArtifactTypeNotSupported]: "not_found",
} as const satisfies Record<CommentErrorCode, TraceCommentFailureReason>;

const notFound = { ok: false, reason: "not_found" } as const;

/** The route's in-transaction receipt for a comment write (ISS-12552). */
type RecordComment = RecordWriteInTransaction<CommentWritten>;

export const traceCommentsService = {
  async list(
    input: TraceCommentTargetInput & {
      clientId?: string;
      includeThreadId?: string;
    }
  ): Promise<TraceComment[] | null> {
    if (input.target.type === CommentTargetType.Branch) {
      return withBranchProductReadSnapshot(input.organizationId, async (db) => {
        const artifactId = await resolveProductBranchArtifactId(db, {
          organizationId: input.organizationId,
          targetId: input.target.id,
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
        const comments = await readTraceCommentPage(
          db,
          pageInput(input, {
            artifactId,
            target: input.target,
            surface: input.surface ?? CommentSurface.BranchDetail,
          })
        );
        if (
          !(await branchHasCloudEligibility(
            db,
            input.organizationId,
            artifactId
          ))
        ) {
          return null;
        }
        return comments;
      });
    }
    const record = await resolveSessionTraceCommentTarget(input);
    if (!record) {
      return null;
    }
    return withDb((db) => readTraceCommentPage(db, pageInput(input, record)));
  },

  listAll(input: {
    organizationId: string;
    userId: string;
    filters: AggregateTraceCommentFilters & {
      limit?: number;
      offset?: number;
      cursor?: number;
    };
  }): Promise<TraceCommentListResponse> {
    return commentsService.listAllTraceComments(input);
  },

  async create(
    input: TraceCommentTargetInput & { draft: TraceCommentDraft },
    recordWrite?: RecordComment
  ): Promise<TraceComment | TraceCommentMutationFailure | null> {
    const record = await resolveTraceCommentTarget(input);
    if (!record) {
      return null;
    }
    const result = await commentsService.createThread(
      {
        viewer: viewerOf(input),
        target: commentTargetOf(input.organizationId, record),
        surface: record.surface,
        anchor: traceTextAnchorToCommentAnchor(input.draft.anchor),
        body: input.draft.body,
        mentions: input.draft.mentions,
        kind: input.draft.kind,
        clientId: input.draft.clientId ?? null,
        present: presentTraceComment(presenterInput(input, record)),
      },
      recordWrite
    );
    if (result.ok) {
      return result.value;
    }
    return result.error === CommentErrorCode.NotFound
      ? null
      : legacyFailure(result.error);
  },

  async reply(
    input: TraceCommentTargetInput & {
      commentId: string;
      draft: TraceCommentReplyDraft;
    },
    recordWrite?: RecordComment
  ): Promise<TraceCommentMutationResult<TraceComment>> {
    const record = await resolveTraceCommentTarget(input);
    if (!record) {
      return notFound;
    }
    return toLegacyResult(
      await commentsService.reply(
        {
          viewer: viewerOf(input),
          target: commentTargetOf(input.organizationId, record),
          thread: { rootCommentId: input.commentId },
          body: input.draft.body,
          mentions: input.draft.mentions,
          clientId: input.draft.clientId ?? null,
          present: presentTraceComment(presenterInput(input, record)),
        },
        recordWrite
      )
    );
  },

  async update(
    input: TraceCommentTargetInput & {
      commentId: string;
      update: TraceCommentUpdate;
    },
    recordWrite?: RecordComment
  ): Promise<TraceCommentMutationResult<TraceComment>> {
    const record = await resolveTraceCommentTarget(input);
    if (!record) {
      return notFound;
    }
    return toLegacyResult(
      await commentsService.editComment(
        {
          viewer: viewerOf(input),
          target: commentTargetOf(input.organizationId, record),
          commentId: input.commentId,
          body: input.update.body,
          mentions: input.update.mentions,
          present: presentTraceComment(presenterInput(input, record)),
        },
        recordWrite
      )
    );
  },

  async delete(
    input: TraceCommentTargetInput & { commentId: string },
    recordWrite?: RecordComment
  ): Promise<TraceCommentMutationResult<{ deleted: true }>> {
    const record = await resolveTraceCommentTarget(input);
    if (!record) {
      return notFound;
    }
    return toLegacyResult(
      await commentsService.deleteComment(
        {
          viewer: viewerOf(input),
          target: commentTargetOf(input.organizationId, record),
          commentId: input.commentId,
        },
        recordWrite
      )
    );
  },

  /**
   * ISS-10382: report that this comment's delivery has spent its terminal ITEM
   * budget, so the cloud can represent the dead letter a desktop queue reached.
   *
   * The PRODUCER half of the contract. The budget itself is not moved here and
   * deliberately so: it is charged on the delivering client's own ladder (only a
   * 413 is item-attributable, five attempts), and a server that re-derived it
   * would be a second opinion on a verdict it cannot see. This records the
   * verdict, nothing more.
   */
  async markSyncAbandoned(
    input: TraceCommentTargetInput & { commentId: string },
    recordWrite?: RecordComment
  ): Promise<TraceCommentMutationResult<TraceComment[]>> {
    const record = await resolveTraceCommentTarget(input);
    if (!record) {
      return notFound;
    }
    return toLegacyResult(
      await commentsService.markSyncAbandoned(
        {
          viewer: viewerOf(input),
          target: commentTargetOf(input.organizationId, record),
          comment: { commentId: input.commentId },
          present: presentTraceCommentPage(presenterInput(input, record)),
        },
        recordWrite
      )
    );
  },

  /**
   * ISS-10382: the author's recovery door, on any shell.
   *
   * Clears the dead letter and answers with the target's REFRESHED list rather
   * than the one comment, matching the port's `retrySync` shape — re-pending
   * changes a row's delivery state and nothing else, so there is no
   * single-comment payload to merge and the list is what the badge reads.
   */
  async retrySync(
    input: TraceCommentTargetInput & { commentId: string },
    recordWrite?: RecordComment
  ): Promise<TraceCommentMutationResult<TraceComment[]>> {
    const record = await resolveTraceCommentTarget(input);
    if (!record) {
      return notFound;
    }
    return toLegacyResult(
      await commentsService.retrySync(
        {
          viewer: viewerOf(input),
          target: commentTargetOf(input.organizationId, record),
          comment: { commentId: input.commentId },
          present: presentTraceCommentPage(presenterInput(input, record)),
        },
        recordWrite
      )
    );
  },
};

function viewerOf(input: TraceCommentTargetInput): CommentViewer {
  return { organizationId: input.organizationId, userId: input.userId };
}

function commentTargetOf(
  organizationId: string,
  record: TraceCommentTargetRecord
): CommentTarget {
  return {
    organizationId,
    artifactId: record.artifactId,
    artifactType: commentArtifactTypeFor(record.target.type),
    surface: record.surface,
  };
}

function presenterInput(
  input: TraceCommentTargetInput,
  record: TraceCommentTargetRecord
) {
  return {
    organizationId: input.organizationId,
    viewerUserId: input.userId,
    record,
  };
}

function pageInput(
  input: TraceCommentTargetInput & {
    clientId?: string;
    includeThreadId?: string;
  },
  record: TraceCommentTargetRecord
) {
  return {
    ...presenterInput(input, record),
    ...(input.clientId ? { clientId: input.clientId } : {}),
    ...(input.includeThreadId
      ? { includeThreadId: input.includeThreadId }
      : {}),
  };
}

function toLegacyResult<T>(
  result: Result<T, CommentErrorCode>
): TraceCommentMutationResult<T> {
  return result.ok
    ? { ok: true, value: result.value }
    : legacyFailure(result.error);
}

function legacyFailure(code: CommentErrorCode): TraceCommentMutationFailure {
  const reason: TraceCommentFailureReason = LEGACY_FAILURE_BY_CODE[code];
  if (reason === "conflict" || reason === "bad_request") {
    return { ok: false, reason, code };
  }
  return { ok: false, reason };
}
