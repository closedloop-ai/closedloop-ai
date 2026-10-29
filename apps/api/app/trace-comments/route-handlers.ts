import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import {
  type BranchTraceCommentCollectionQuery,
  branchTraceCommentCollectionQuerySchema,
  CommentSurface,
  CommentTargetType,
  TRACE_COMMENT_INCLUDE_THREAD_PARAM,
  TRACE_COMMENT_REQUEST_MAX_BYTES,
  type TraceComment,
  type TraceCommentDeleteResult,
  type TraceCommentListResponse,
  type TraceCommentTarget,
  traceCommentClientIdSchema,
  traceCommentDraftSchema,
  traceCommentIncludeThreadIdSchema,
  traceCommentReplyDraftSchema,
  traceCommentUpdateSchema,
} from "@repo/api/src/types/comment";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { branchTraceCommentsService } from "@/app/branches/branch-trace-comments-service";
import { recordCommentReceipt } from "@/app/comments/comment-receipt";
import type { CommentWritten } from "@/app/comments/service/comment-command-pipeline";
import type { TraceCommentTargetInput } from "@/app/comments/service/trace-comment-target-lookup";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { isUuid } from "@/lib/is-uuid";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import {
  badRequestResponse,
  errorResponse,
  formatZodErrors,
  notFoundResponse,
  parseBody,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { traceCommentsService } from "./service";
import {
  getTargetLabel,
  isTraceCommentMutationFailure,
  type TraceCommentMutationResult,
  traceCommentFailureResponse,
} from "./trace-comment-mutation-result";
import { traceCommentListQuerySchema } from "./validators";

type TraceCommentRoute =
  | "/trace-comments"
  | "/agent-sessions/[id]/trace-comments"
  | "/branches/[id]/trace-comments"
  | "/agent-sessions/[id]/trace-comments/by-client-id/[clientId]"
  | "/branches/[id]/trace-comments/by-client-id/[clientId]"
  | "/agent-sessions/[id]/trace-comments/[commentId]"
  | "/branches/[id]/trace-comments/[commentId]"
  | "/agent-sessions/[id]/trace-comments/[commentId]/replies"
  | "/branches/[id]/trace-comments/[commentId]/replies"
  | "/agent-sessions/[id]/trace-comments/[commentId]/retry-sync"
  | "/branches/[id]/trace-comments/[commentId]/retry-sync"
  | "/agent-sessions/[id]/trace-comments/[commentId]/sync-abandoned"
  | "/branches/[id]/trace-comments/[commentId]/sync-abandoned";

/**
 * Org-scoped aggregate list of trace comments across all sessions/branches
 * (`GET /trace-comments`, FEA-3550). ISS-8022 retired the session-monitoring
 * gate this read used to carry, along with the `desktop-agent-session-sync`
 * PostHog flag behind it. Org-scoping is enforced at the DB layer, so a caller
 * only ever sees comments in their organization.
 */
export function createTraceCommentsAggregateGetHandler() {
  return withAnyAuth<TraceCommentListResponse, TraceCommentRoute>(
    async ({ user }, request) => {
      const { params, errorResponse: parseError } = parseQueryParams(
        request,
        traceCommentListQuerySchema
      );
      if (parseError) {
        return parseError;
      }

      const response = await traceCommentsService.listAll({
        organizationId: user.organizationId,
        userId: user.id,
        filters: params,
      });
      return successResponse(response);
    }
  );
}

export function createTraceCommentsGetHandler(
  targetType: CommentTargetType,
  options: { allowBranchSessions?: boolean } = {}
) {
  return withAnyAuth<TraceComment[], TraceCommentRoute>(
    async ({ user, clerkUserId }, request, params) => {
      const target = await getRouteTarget(params, targetType);
      const surfaceResult = branchCommentSurfaceFromRequest(
        request,
        targetType,
        branchReadQuerySchema(request, options.allowBranchSessions)
      );
      if (surfaceResult.errorResponse) {
        return surfaceResult.errorResponse;
      }
      const clientId = await getRouteClientId(params);
      if (clientId?.success === false) {
        return badRequestResponse(formatZodErrors(clientId.error.issues));
      }
      const includeThreadId = traceCommentIncludeThreadIdSchema
        .optional()
        .safeParse(
          request.nextUrl.searchParams.get(
            TRACE_COMMENT_INCLUDE_THREAD_PARAM
          ) ?? undefined
        );
      if (!includeThreadId.success) {
        return badRequestResponse(
          formatZodErrors(includeThreadId.error.issues)
        );
      }
      if (isBranchSessionBatchRead(request, options.allowBranchSessions)) {
        const comments = await branchTraceCommentsService.list({
          organizationId: user.organizationId,
          userId: user.id,
          branchId: target.id,
        });
        return comments
          ? successResponse(comments)
          : notFoundResponse(getTargetLabel(targetType));
      }
      const comments = await traceCommentsService.list({
        organizationId: user.organizationId,
        userId: user.id,
        clerkUserId,
        target,
        surface: surfaceResult.surface,
        computeTargetId: getComputeTargetId(request),
        ...(clientId ? { clientId: clientId.data } : {}),
        ...(includeThreadId.data
          ? { includeThreadId: includeThreadId.data }
          : {}),
      });
      if (!comments) {
        return notFoundResponse(getTargetLabel(targetType));
      }
      return successResponse(comments);
    }
  );
}

export function createTraceCommentsPostHandler(targetType: CommentTargetType) {
  return withAnyAuth<TraceComment, TraceCommentRoute>(
    withOperationReceipts(
      OperationKind.Comment,
      async ({ user, clerkUserId }, request, params, receipts) => {
        const { body, errorResponse: parseError } = await parseBody(
          request,
          traceCommentDraftSchema,
          { maxBytes: TRACE_COMMENT_REQUEST_MAX_BYTES }
        );
        if (parseError) {
          return parseError;
        }

        const target = await getRouteTarget(params, targetType);
        const surfaceResult = branchCommentSurfaceFromRequest(
          request,
          targetType
        );
        if (surfaceResult.errorResponse) {
          return surfaceResult.errorResponse;
        }
        try {
          const comment = await traceCommentsService.create(
            {
              organizationId: user.organizationId,
              userId: user.id,
              clerkUserId,
              target,
              surface: surfaceResult.surface,
              computeTargetId: getComputeTargetId(request),
              draft: body,
            },
            recordCommentReceipt(receipts, OperationKind.Comment)
          );
          if (!comment) {
            return notFoundResponse(getTargetLabel(targetType));
          }
          if (isTraceCommentMutationFailure(comment)) {
            return traceCommentFailureResponse(comment, targetType);
          }
          return successResponse(withOperationReceipt(comment, receipts));
        } catch (error) {
          return errorResponse("Failed to create trace comment", error);
        }
      }
    )
  );
}

function branchCommentSurfaceFromRequest(
  request: NextRequest,
  targetType: CommentTargetType,
  schema: z.ZodType<{
    surface?: BranchTraceCommentCollectionQuery["surface"];
  }> = branchTraceCommentRouteQuerySchema
) {
  if (targetType !== CommentTargetType.Branch) {
    return {};
  }
  const { params, errorResponse } = parseQueryParams(request, schema);
  return errorResponse ? { errorResponse } : { surface: params.surface };
}

export function createTraceCommentsPatchHandler(targetType: CommentTargetType) {
  return withAnyAuth<TraceComment, TraceCommentRoute>(
    withOperationReceipts(
      OperationKind.Comment,
      async ({ user, clerkUserId }, request, params, receipts) => {
        const { body, errorResponse: parseError } = await parseBody(
          request,
          traceCommentUpdateSchema,
          { maxBytes: TRACE_COMMENT_REQUEST_MAX_BYTES }
        );
        if (parseError) {
          return parseError;
        }

        const target = await getRouteTarget(params, targetType);
        const surfaceResult = branchCommentSurfaceFromRequest(
          request,
          targetType
        );
        if (surfaceResult.errorResponse) {
          return surfaceResult.errorResponse;
        }
        const commentId = await getRouteCommentId(params);
        if (!commentId) {
          return notFoundResponse(getTargetLabel(targetType));
        }
        try {
          const result = await traceCommentsService.update(
            {
              organizationId: user.organizationId,
              userId: user.id,
              clerkUserId,
              target,
              surface: surfaceResult.surface,
              computeTargetId: getComputeTargetId(request),
              commentId,
              update: body,
            },
            recordCommentReceipt(receipts, OperationKind.Comment)
          );
          if (!result.ok) {
            return traceCommentFailureResponse(result, targetType);
          }
          return successResponse(withOperationReceipt(result.value, receipts));
        } catch (error) {
          return errorResponse("Failed to update trace comment", error);
        }
      }
    )
  );
}

export function createTraceCommentsReplyPostHandler(
  targetType: CommentTargetType
) {
  return withAnyAuth<TraceComment, TraceCommentRoute>(
    withOperationReceipts(
      OperationKind.Comment,
      async ({ user, clerkUserId }, request, params, receipts) => {
        const { body, errorResponse: parseError } = await parseBody(
          request,
          traceCommentReplyDraftSchema,
          { maxBytes: TRACE_COMMENT_REQUEST_MAX_BYTES }
        );
        if (parseError) {
          return parseError;
        }

        const target = await getRouteTarget(params, targetType);
        const surfaceResult = branchCommentSurfaceFromRequest(
          request,
          targetType
        );
        if (surfaceResult.errorResponse) {
          return surfaceResult.errorResponse;
        }
        const commentId = await getRouteCommentId(params);
        if (!commentId) {
          return notFoundResponse(getTargetLabel(targetType));
        }
        try {
          const result = await traceCommentsService.reply(
            {
              organizationId: user.organizationId,
              userId: user.id,
              clerkUserId,
              target,
              surface: surfaceResult.surface,
              computeTargetId: getComputeTargetId(request),
              commentId,
              draft: body,
            },
            recordCommentReceipt(receipts, OperationKind.Comment)
          );
          if (!result.ok) {
            return traceCommentFailureResponse(result, targetType);
          }
          return successResponse(withOperationReceipt(result.value, receipts));
        } catch (error) {
          return errorResponse("Failed to reply to trace comment", error);
        }
      }
    )
  );
}

export function createTraceCommentsDeleteHandler(
  targetType: CommentTargetType
) {
  return withAnyAuth<TraceCommentDeleteResult, TraceCommentRoute>(
    withOperationReceipts(
      OperationKind.Comment,
      async ({ user, clerkUserId }, request, params, receipts) => {
        const target = await getRouteTarget(params, targetType);
        const surfaceResult = branchCommentSurfaceFromRequest(
          request,
          targetType
        );
        if (surfaceResult.errorResponse) {
          return surfaceResult.errorResponse;
        }
        const commentId = await getRouteCommentId(params);
        if (!commentId) {
          return notFoundResponse(getTargetLabel(targetType));
        }
        try {
          const result = await traceCommentsService.delete(
            {
              organizationId: user.organizationId,
              userId: user.id,
              clerkUserId,
              target,
              surface: surfaceResult.surface,
              computeTargetId: getComputeTargetId(request),
              commentId,
            },
            recordCommentReceipt(receipts, OperationKind.Comment)
          );
          if (!result.ok) {
            return traceCommentFailureResponse(result, targetType);
          }
          return successResponse(withOperationReceipt(result.value, receipts));
        } catch (error) {
          return errorResponse("Failed to delete trace comment", error);
        }
      }
    )
  );
}

/**
 * ISS-10382: the two sides of a trace comment's dead-letter lifecycle.
 *
 * `POST .../sync-abandoned` is the producer half: a client that owns a delivery
 * queue reports that this comment spent its terminal ITEM budget. Its only
 * caller is the desktop.
 *
 * `POST .../retry-sync` is the author's recovery door — the web half of the
 * ISS-8597 door desktop already had. It REMOVES the marker rather than adding
 * anything.
 *
 * Both answer with the target's refreshed list, so one round trip both settles
 * the state and re-renders the rail.
 */
export function createTraceCommentsRetrySyncPostHandler(
  targetType: CommentTargetType
) {
  return createTraceCommentSyncStateHandler(targetType, "retry");
}

export function createTraceCommentsSyncAbandonedPostHandler(
  targetType: CommentTargetType
) {
  return createTraceCommentSyncStateHandler(targetType, "abandon");
}

function createTraceCommentSyncStateHandler(
  targetType: CommentTargetType,
  transition: TraceCommentSyncTransition
) {
  return withAnyAuth<TraceComment[], TraceCommentRoute>(
    withOperationReceipts(
      OperationKind.DesktopSync,
      async ({ user, clerkUserId }, request, params, receipts) => {
        const target = await getRouteTarget(params, targetType);
        const surfaceResult = branchCommentSurfaceFromRequest(
          request,
          targetType
        );
        if (surfaceResult.errorResponse) {
          return surfaceResult.errorResponse;
        }
        const commentId = await getRouteCommentId(params);
        if (!commentId) {
          return notFoundResponse(getTargetLabel(targetType));
        }
        const serviceInput = {
          organizationId: user.organizationId,
          userId: user.id,
          clerkUserId,
          target,
          surface: surfaceResult.surface,
          computeTargetId: getComputeTargetId(request),
          commentId,
        };
        try {
          // The answer is the target's whole list, so the receipt is recorded
          // but not attached (ISS-12552).
          const result = await runTraceCommentSyncTransition(
            transition,
            serviceInput,
            recordCommentReceipt(receipts, OperationKind.DesktopSync)
          );
          if (!result.ok) {
            return traceCommentFailureResponse(result, targetType);
          }
          return successResponse(result.value);
        } catch (error) {
          return errorResponse(
            transition === "retry"
              ? "Failed to retry trace comment sync"
              : "Failed to record trace comment sync abandonment",
            error
          );
        }
      }
    )
  );
}

async function getRouteTarget(
  params: Promise<Record<string, string>>,
  type: CommentTargetType
): Promise<TraceCommentTarget> {
  const { id } = await params;
  return { type, id };
}

/**
 * ISS-11190: `comment.id` is `@db.Uuid` and Postgres raises on a non-UUID, so a
 * malformed segment is `null` here and the caller answers not-found.
 */
async function getRouteCommentId(
  params: Promise<Record<string, string>>
): Promise<string | null> {
  const { commentId } = await params;
  return isUuid(commentId) ? commentId : null;
}

export function getComputeTargetId(request: Request): string | null {
  const raw = new URL(request.url).searchParams.get("computeTargetId");
  const parsed = raw ? z.string().trim().min(1).safeParse(raw) : null;
  return parsed?.success ? parsed.data : null;
}

const branchTraceCommentRouteQuerySchema =
  branchTraceCommentCollectionQuerySchema.extend({
    computeTargetId: z.string().optional(),
  });

/** The collection GET alone also takes the addressed-thread param (ISS-11004). */
const branchTraceCommentReadQuerySchema =
  branchTraceCommentRouteQuerySchema.extend({
    [TRACE_COMMENT_INCLUDE_THREAD_PARAM]:
      traceCommentIncludeThreadIdSchema.optional(),
  });

type TraceCommentSyncTransition = "retry" | "abandon";

function runTraceCommentSyncTransition(
  transition: TraceCommentSyncTransition,
  input: TraceCommentTargetInput & { commentId: string },
  recordWrite: RecordWriteInTransaction<CommentWritten> | undefined
): Promise<TraceCommentMutationResult<TraceComment[]>> {
  return transition === "retry"
    ? traceCommentsService.retrySync(input, recordWrite)
    : traceCommentsService.markSyncAbandoned(input, recordWrite);
}

/**
 * ISS-11113: the `by-client-id` segment, parsed by the schema the create
 * accepted it under. `undefined` on the collection route, which has none.
 */
async function getRouteClientId(params: Promise<Record<string, string>>) {
  const { clientId } = await params;
  return clientId === undefined
    ? undefined
    : traceCommentClientIdSchema.safeParse(clientId);
}

/** ISS-12282: opt-in batch selector is only accepted on the Branch collection GET. */
const branchTraceCommentBatchReadQuerySchema =
  branchTraceCommentRouteQuerySchema.extend({
    surface: z.literal(CommentSurface.BranchTimeline),
    includeSessions: z.literal("true"),
  });

function branchReadQuerySchema(
  request: NextRequest,
  allowBranchSessions?: boolean
) {
  return allowBranchSessions &&
    request.nextUrl.searchParams.has("includeSessions")
    ? branchTraceCommentBatchReadQuerySchema
    : branchTraceCommentReadQuerySchema;
}

function isBranchSessionBatchRead(
  request: NextRequest,
  allowBranchSessions?: boolean
) {
  return (
    allowBranchSessions === true &&
    request.nextUrl.searchParams.get("includeSessions") === "true"
  );
}
