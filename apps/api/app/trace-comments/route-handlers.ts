import {
  TRACE_COMMENT_REQUEST_MAX_BYTES,
  type TraceComment,
  type TraceCommentDeleteResult,
  type TraceCommentTarget,
  TraceCommentTargetType,
  traceCommentDraftSchema,
  traceCommentReplyDraftSchema,
  traceCommentUpdateSchema,
} from "@repo/api/src/types/comment";
import { z } from "zod";
import { getAgentSessionViewerScope } from "@/app/agent-sessions/route-helpers";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { traceCommentsService } from "./service";

type TraceCommentRoute =
  | "/agent-sessions/[id]/trace-comments"
  | "/branches/[id]/trace-comments"
  | "/agent-sessions/[id]/trace-comments/[commentId]"
  | "/branches/[id]/trace-comments/[commentId]"
  | "/agent-sessions/[id]/trace-comments/[commentId]/replies"
  | "/branches/[id]/trace-comments/[commentId]/replies";

export function createTraceCommentsGetHandler(
  targetType: TraceCommentTargetType
) {
  return withAnyAuth<TraceComment[], TraceCommentRoute>(
    async ({ user, clerkUserId }, request, params) => {
      const accessError = await traceCommentAccessError(targetType, {
        userId: user.id,
        clerkUserId,
      });
      if (accessError) {
        return accessError;
      }

      const target = await getRouteTarget(params, targetType);
      const comments = await traceCommentsService.list({
        organizationId: user.organizationId,
        userId: user.id,
        clerkUserId,
        target,
        computeTargetId: getComputeTargetId(request),
      });
      if (!comments) {
        return notFoundResponse(getTargetLabel(targetType));
      }
      return successResponse(comments);
    }
  );
}

export function createTraceCommentsPostHandler(
  targetType: TraceCommentTargetType
) {
  return withAnyAuth<TraceComment, TraceCommentRoute>(
    async ({ user, clerkUserId }, request, params) => {
      const accessError = await traceCommentAccessError(targetType, {
        userId: user.id,
        clerkUserId,
      });
      if (accessError) {
        return accessError;
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        traceCommentDraftSchema,
        { maxBytes: TRACE_COMMENT_REQUEST_MAX_BYTES }
      );
      if (parseError) {
        return parseError;
      }

      const target = await getRouteTarget(params, targetType);
      try {
        const comment = await traceCommentsService.create({
          organizationId: user.organizationId,
          userId: user.id,
          clerkUserId,
          target,
          computeTargetId: getComputeTargetId(request),
          draft: body,
        });
        if (!comment) {
          return notFoundResponse(getTargetLabel(targetType));
        }
        return successResponse(comment);
      } catch (error) {
        return errorResponse("Failed to create trace comment", error);
      }
    }
  );
}

export function createTraceCommentsPatchHandler(
  targetType: TraceCommentTargetType
) {
  return withAnyAuth<TraceComment, TraceCommentRoute>(
    async ({ user, clerkUserId }, request, params) => {
      const accessError = await traceCommentAccessError(targetType, {
        userId: user.id,
        clerkUserId,
      });
      if (accessError) {
        return accessError;
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        traceCommentUpdateSchema,
        { maxBytes: TRACE_COMMENT_REQUEST_MAX_BYTES }
      );
      if (parseError) {
        return parseError;
      }

      const target = await getRouteTarget(params, targetType);
      const commentId = await getRouteCommentId(params);
      try {
        const result = await traceCommentsService.update({
          organizationId: user.organizationId,
          userId: user.id,
          clerkUserId,
          target,
          computeTargetId: getComputeTargetId(request),
          commentId,
          update: body,
        });
        if (!result.ok) {
          return result.reason === "forbidden"
            ? forbiddenResponse()
            : notFoundResponse(getTargetLabel(targetType));
        }
        return successResponse(result.value);
      } catch (error) {
        return errorResponse("Failed to update trace comment", error);
      }
    }
  );
}

export function createTraceCommentsReplyPostHandler(
  targetType: TraceCommentTargetType
) {
  return withAnyAuth<TraceComment, TraceCommentRoute>(
    async ({ user, clerkUserId }, request, params) => {
      const accessError = await traceCommentAccessError(targetType, {
        userId: user.id,
        clerkUserId,
      });
      if (accessError) {
        return accessError;
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        traceCommentReplyDraftSchema,
        { maxBytes: TRACE_COMMENT_REQUEST_MAX_BYTES }
      );
      if (parseError) {
        return parseError;
      }

      const target = await getRouteTarget(params, targetType);
      const commentId = await getRouteCommentId(params);
      try {
        const result = await traceCommentsService.reply({
          organizationId: user.organizationId,
          userId: user.id,
          clerkUserId,
          target,
          computeTargetId: getComputeTargetId(request),
          commentId,
          draft: body,
        });
        if (!result.ok) {
          return result.reason === "forbidden"
            ? forbiddenResponse()
            : notFoundResponse(getTargetLabel(targetType));
        }
        return successResponse(result.value);
      } catch (error) {
        return errorResponse("Failed to reply to trace comment", error);
      }
    }
  );
}

export function createTraceCommentsDeleteHandler(
  targetType: TraceCommentTargetType
) {
  return withAnyAuth<TraceCommentDeleteResult, TraceCommentRoute>(
    async ({ user, clerkUserId }, request, params) => {
      const accessError = await traceCommentAccessError(targetType, {
        userId: user.id,
        clerkUserId,
      });
      if (accessError) {
        return accessError;
      }

      const target = await getRouteTarget(params, targetType);
      const commentId = await getRouteCommentId(params);
      try {
        const result = await traceCommentsService.delete({
          organizationId: user.organizationId,
          userId: user.id,
          clerkUserId,
          target,
          computeTargetId: getComputeTargetId(request),
          commentId,
        });
        if (!result.ok) {
          return result.reason === "forbidden"
            ? forbiddenResponse()
            : notFoundResponse(getTargetLabel(targetType));
        }
        return successResponse(result.value);
      } catch (error) {
        return errorResponse("Failed to delete trace comment", error);
      }
    }
  );
}

async function traceCommentAccessError(
  targetType: TraceCommentTargetType,
  input: { userId: string; clerkUserId: string }
) {
  if (targetType === TraceCommentTargetType.Branch) {
    return null;
  }

  const viewerScope = await getAgentSessionViewerScope(input);
  return viewerScope.monitoringEnabled ? null : forbiddenResponse();
}

async function getRouteTarget(
  params: Promise<Record<string, string>>,
  type: TraceCommentTargetType
): Promise<TraceCommentTarget> {
  const { id } = await params;
  return { type, id };
}

async function getRouteCommentId(
  params: Promise<Record<string, string>>
): Promise<string> {
  const { commentId } = await params;
  return commentId;
}

function getTargetLabel(type: TraceCommentTargetType): string {
  return type === TraceCommentTargetType.Session ? "Agent session" : "Branch";
}

export function getComputeTargetId(request: Request): string | null {
  const raw = new URL(request.url).searchParams.get("computeTargetId");
  const parsed = raw ? z.string().trim().min(1).safeParse(raw) : null;
  return parsed?.success ? parsed.data : null;
}
