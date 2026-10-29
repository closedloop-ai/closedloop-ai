/**
 * ISS-11212 (PLN-2121 Step 5): the unified comment routes. Each parses its
 * input, hands it to the comment service, and answers a refused command with
 * its code through {@link commentErrorResponse}.
 */

import type { AttachmentDownloadResponse } from "@repo/api/src/types/attachment";
import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import { TRACE_COMMENT_REQUEST_MAX_BYTES } from "@repo/api/src/types/comment";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import {
  type ArtifactCommentsResponse,
  type CommentReactionEmoji,
  type CommentThreadDto,
  commentReactionEmojiSchema,
  createCommentThreadRequestSchema,
  editCommentRequestSchema,
  listArtifactCommentsQuerySchema,
  replyToCommentThreadRequestSchema,
} from "@repo/api/src/types/comment-thread-dto";
import type { Result } from "@repo/api/src/types/result";
import { z } from "zod";
import { commentsService } from "@/app/comments/service";
import type { CommentAttachmentUpload } from "@/app/comments/service/comment-attachment-commands";
import type { CommentViewer } from "@/app/comments/service/comment-capabilities";
import type { CommentWritten } from "@/app/comments/service/comment-command-pipeline";
import { decodeCommentListCursor } from "@/app/comments/service/comment-read";
import { attachmentUploadRateLimitResponse } from "@/app/documents/attachment-route-responses";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { isUuid } from "@/lib/is-uuid";
import {
  type OperationReceiptRecorder,
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import {
  badRequestResponse,
  formatZodErrors,
  parseBody,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { createCommentAttachmentRequestSchema } from "./comment-attachment-request";
import { commentErrorResponse } from "./comment-error-response";
import { recordCommentReceipt } from "./comment-receipt";

type UnifiedCommentRoute =
  | "/artifacts/[id]/comments"
  | "/artifacts/[id]/comments/threads"
  | "/comments/threads/[threadId]"
  | "/comments/threads/[threadId]/replies"
  | "/comments/threads/[threadId]/resolve"
  | "/comments/threads/[threadId]/reopen"
  | "/comments/threads/[threadId]/retry-sync"
  | "/comments/[commentId]"
  | "/comments/[commentId]/reactions/[emoji]"
  | "/comments/[commentId]/attachments"
  | "/comments/attachments/[attachmentId]"
  | "/comments/attachments/[attachmentId]/complete";

type AuthUser = { id: string; organizationId: string };

const listQuerySchema = listArtifactCommentsQuerySchema.transform(
  (query, context) => {
    if (query.cursor === undefined) {
      return { ...query, after: undefined };
    }
    const after = decodeCommentListCursor(query.cursor);
    if (!after) {
      context.addIssue({ code: "custom", path: ["cursor"], input: query });
      return z.NEVER;
    }
    return { ...query, after };
  }
);

export function createArtifactCommentsGetHandler() {
  return withAnyAuth<ArtifactCommentsResponse, UnifiedCommentRoute>(
    async ({ user, clerkUserId }, request, params) => {
      const { params: query, errorResponse } = parseQueryParams(
        request,
        listQuerySchema
      );
      if (errorResponse) {
        return errorResponse;
      }
      const { id } = await params;
      return answer(
        await commentsService.listArtifactComments({
          viewer: viewerOf(user),
          artifactId: id,
          clerkUserId,
          computeTargetId: query.computeTargetId,
          surface: query.surface,
          status: query.status,
          after: query.after,
          limit: query.limit,
        })
      );
    }
  );
}

export function createArtifactCommentThreadsPostHandler() {
  return withAnyAuth<CommentThreadDto, UnifiedCommentRoute>(
    withOperationReceipts(
      OperationKind.Comment,
      async ({ user }, request, params, receipts) => {
        const { body, errorResponse } = await parseBody(
          request,
          createCommentThreadRequestSchema,
          { maxBytes: TRACE_COMMENT_REQUEST_MAX_BYTES }
        );
        if (errorResponse) {
          return errorResponse;
        }
        const artifactId = await routeUuid(params, "id");
        if (!artifactId) {
          return notFound();
        }
        return answer(
          await commentsService.createArtifactCommentThread(
            { viewer: viewerOf(user), artifactId, request: body },
            recordCommentReceipt(receipts, OperationKind.Comment)
          ),
          receipts
        );
      }
    )
  );
}

export function createCommentThreadGetHandler() {
  return withAnyAuth<CommentThreadDto, UnifiedCommentRoute>(
    async ({ user }, _request, params) => {
      const threadId = await routeUuid(params, "threadId");
      if (!threadId) {
        return notFound();
      }
      return answer(
        await commentsService.getThread({ viewer: viewerOf(user), threadId })
      );
    }
  );
}

export function createCommentThreadRepliesPostHandler() {
  return withAnyAuth<CommentThreadDto, UnifiedCommentRoute>(
    withOperationReceipts(
      OperationKind.Comment,
      async ({ user }, request, params, receipts) => {
        const { body, errorResponse } = await parseBody(
          request,
          replyToCommentThreadRequestSchema,
          { maxBytes: TRACE_COMMENT_REQUEST_MAX_BYTES }
        );
        if (errorResponse) {
          return errorResponse;
        }
        const threadId = await routeUuid(params, "threadId");
        if (!threadId) {
          return notFound();
        }
        return answer(
          await commentsService.replyToCommentThread(
            { viewer: viewerOf(user), threadId, request: body },
            recordCommentReceipt(receipts, OperationKind.Comment)
          ),
          receipts
        );
      }
    )
  );
}

export function createCommentThreadResolvePostHandler() {
  return createThreadCommandHandler(OperationKind.Comment, (input, record) =>
    commentsService.resolveCommentThreadById(input, record)
  );
}

export function createCommentThreadReopenPostHandler() {
  return createThreadCommandHandler(OperationKind.Comment, (input, record) =>
    commentsService.reopenCommentThreadById(input, record)
  );
}

/**
 * ISS-12552: re-pending a dead letter moves the thread's delivery state and
 * nothing a reader sees, so its receipt is a Desktop sync write.
 */
export function createCommentThreadRetrySyncPostHandler() {
  return createThreadCommandHandler(
    OperationKind.DesktopSync,
    (input, record) => commentsService.retryCommentThreadSync(input, record)
  );
}

export function createCommentPatchHandler() {
  return withAnyAuth<CommentThreadDto, UnifiedCommentRoute>(
    withOperationReceipts(
      OperationKind.Comment,
      async ({ user }, request, params, receipts) => {
        const { body, errorResponse } = await parseBody(
          request,
          editCommentRequestSchema,
          { maxBytes: TRACE_COMMENT_REQUEST_MAX_BYTES }
        );
        if (errorResponse) {
          return errorResponse;
        }
        const commentId = await routeUuid(params, "commentId");
        if (!commentId) {
          return notFound();
        }
        return answer(
          await commentsService.editCommentById(
            { viewer: viewerOf(user), commentId, request: body },
            recordCommentReceipt(receipts, OperationKind.Comment)
          ),
          receipts
        );
      }
    )
  );
}

export function createCommentDeleteHandler() {
  return withAnyAuth<{ deleted: true }, UnifiedCommentRoute>(
    withOperationReceipts(
      OperationKind.Comment,
      async ({ user }, _request, params, receipts) => {
        const commentId = await routeUuid(params, "commentId");
        if (!commentId) {
          return notFound();
        }
        return answer(
          await commentsService.deleteCommentById(
            { viewer: viewerOf(user), commentId },
            recordCommentReceipt(receipts, OperationKind.Comment)
          ),
          receipts
        );
      }
    )
  );
}

export function createCommentReactionPutHandler() {
  return createReactionHandler((input, record) =>
    commentsService.addReactionByCommentId(input, record)
  );
}

export function createCommentReactionDeleteHandler() {
  return createReactionHandler((input, record) =>
    commentsService.removeReactionByCommentId(input, record)
  );
}

/**
 * PLN-2187 T-2.3: an upload past the artifact's budget answers the document
 * attachment routes' rate-limit response.
 */
export function createCommentAttachmentsPostHandler() {
  return withAnyAuth<CommentAttachmentUpload, UnifiedCommentRoute>(
    withOperationReceipts(
      OperationKind.Attach,
      async ({ user }, request, params, receipts) => {
        const { body, errorResponse } = await parseBody(
          request,
          createCommentAttachmentRequestSchema,
          { maxBytes: TRACE_COMMENT_REQUEST_MAX_BYTES }
        );
        if (errorResponse) {
          return errorResponse;
        }
        const commentId = await routeUuid(params, "commentId");
        if (!commentId) {
          return notFound();
        }
        const upload = await commentsService.createCommentAttachmentUploadById(
          { viewer: viewerOf(user), commentId, request: body },
          recordCommentReceipt(receipts, OperationKind.Attach)
        );
        if (upload.ok) {
          return successResponse(withOperationReceipt(upload.value, receipts));
        }
        return typeof upload.error === "string"
          ? commentErrorResponse(upload.error)
          : attachmentUploadRateLimitResponse(upload.error.retryAfterSeconds);
      }
    )
  );
}

export function createCommentAttachmentCompletePostHandler() {
  return withAnyAuth<CommentThreadDto, UnifiedCommentRoute>(
    withOperationReceipts(
      OperationKind.Attach,
      async ({ user }, _request, params, receipts) => {
        const attachmentId = await routeUuid(params, "attachmentId");
        if (!attachmentId) {
          return notFound();
        }
        return answer(
          await commentsService.completeCommentAttachmentUploadById(
            { viewer: viewerOf(user), attachmentId },
            recordCommentReceipt(receipts, OperationKind.Attach)
          ),
          receipts
        );
      }
    )
  );
}

/**
 * The file's URL in the document attachment route's JSON shape, which the
 * token-authenticated web and desktop clients read (operator, PR #8854).
 */
export function createCommentAttachmentGetHandler() {
  return withAnyAuth<AttachmentDownloadResponse, UnifiedCommentRoute>(
    async ({ user }, _request, params) => {
      const attachmentId = await routeUuid(params, "attachmentId");
      if (!attachmentId) {
        return notFound();
      }
      const located = await commentsService.getCommentAttachmentDownloadUrl({
        viewer: viewerOf(user),
        attachmentId,
      });
      return located.ok
        ? successResponse({ downloadUrl: located.value })
        : commentErrorResponse(located.error);
    }
  );
}

function createThreadCommandHandler(
  operationKind: OperationKind,
  command: (
    input: { viewer: CommentViewer; threadId: string },
    recordWrite: RecordWriteInTransaction<CommentWritten> | undefined
  ) => Promise<Result<CommentThreadDto, CommentErrorCode>>
) {
  return withAnyAuth<CommentThreadDto, UnifiedCommentRoute>(
    withOperationReceipts(
      operationKind,
      async ({ user }, _request, params, receipts) => {
        const threadId = await routeUuid(params, "threadId");
        if (!threadId) {
          return notFound();
        }
        return answer(
          await command(
            { viewer: viewerOf(user), threadId },
            recordCommentReceipt(receipts, operationKind)
          ),
          receipts
        );
      }
    )
  );
}

/** PLN-2187 T-2.2: the `:emoji` segment arrives decoded and is validated here. */
function createReactionHandler(
  command: (
    input: {
      viewer: CommentViewer;
      commentId: string;
      emoji: CommentReactionEmoji;
    },
    recordWrite: RecordWriteInTransaction<CommentWritten> | undefined
  ) => Promise<Result<CommentThreadDto, CommentErrorCode>>
) {
  return withAnyAuth<CommentThreadDto, UnifiedCommentRoute>(
    withOperationReceipts(
      OperationKind.Comment,
      async ({ user }, _request, params, receipts) => {
        const emoji = commentReactionEmojiSchema.safeParse(
          (await params).emoji
        );
        if (!emoji.success) {
          return badRequestResponse(formatZodErrors(emoji.error.issues));
        }
        const commentId = await routeUuid(params, "commentId");
        if (!commentId) {
          return notFound();
        }
        return answer(
          await command(
            { viewer: viewerOf(user), commentId, emoji: emoji.data },
            recordCommentReceipt(receipts, OperationKind.Comment)
          ),
          receipts
        );
      }
    )
  );
}

/** A write's answer carries its receipt when the request recorded one. */
function answer<T extends object>(
  result: Result<T, CommentErrorCode>,
  receipts?: OperationReceiptRecorder
) {
  if (!result.ok) {
    return commentErrorResponse(result.error);
  }
  return successResponse(
    receipts ? withOperationReceipt(result.value, receipts) : result.value
  );
}

function notFound() {
  return commentErrorResponse(CommentErrorCode.NotFound);
}

function viewerOf(user: AuthUser): CommentViewer {
  return { organizationId: user.organizationId, userId: user.id };
}

/**
 * A path id the comment tables key on. They are `@db.Uuid`, and Postgres
 * raises on a non-UUID, so any other segment is `not_found` here.
 */
async function routeUuid(
  params: Promise<Record<string, string>>,
  name: string
): Promise<string | null> {
  const value = (await params)[name];
  return value !== undefined && isUuid(value) ? value : null;
}
