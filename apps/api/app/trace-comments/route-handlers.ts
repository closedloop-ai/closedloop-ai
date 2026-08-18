import {
  branchTraceCommentCollectionQuerySchema,
  TRACE_COMMENT_REQUEST_MAX_BYTES,
  type TraceComment,
  type TraceCommentDeleteResult,
  type TraceCommentListResponse,
  type TraceCommentTarget,
  TraceCommentTargetType,
  traceCommentDraftSchema,
  traceCommentReplyDraftSchema,
  traceCommentUpdateSchema,
} from "@repo/api/src/types/comment";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getAgentSessionViewerScope } from "@/app/agent-sessions/route-helpers";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { isOrgSessionSyncPolicyEnabled } from "@/lib/org-session-sync-policy";
import {
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  parseBody,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { traceCommentsService } from "./service";
import { traceCommentListQuerySchema } from "./validators";

type TraceCommentRoute =
  | "/trace-comments"
  | "/agent-sessions/[id]/trace-comments"
  | "/branches/[id]/trace-comments"
  | "/agent-sessions/[id]/trace-comments/[commentId]"
  | "/branches/[id]/trace-comments/[commentId]"
  | "/agent-sessions/[id]/trace-comments/[commentId]/replies"
  | "/branches/[id]/trace-comments/[commentId]/replies";

/**
 * Org-scoped aggregate list of trace comments across all sessions/branches
 * (`GET /trace-comments`, FEA-3550). Mirrors the per-session read's
 * session-monitoring gate: the gate applies only when the result set can surface
 * Session-type comments (no `targetType` filter, or `targetType=Session`), and is
 * bypassed for a branch-only query (`targetType=Branch`) exactly as
 * `traceCommentAccessError` bypasses it for the per-branch read. Org-scoping is
 * additionally enforced at the DB layer, so a caller only ever sees comments in
 * their organization.
 */
export function createTraceCommentsAggregateGetHandler() {
  return withAnyAuth<TraceCommentListResponse, TraceCommentRoute>(
    async ({ user, clerkUserId }, request) => {
      const { params, errorResponse: parseError } = parseQueryParams(
        request,
        traceCommentListQuerySchema
      );
      if (parseError) {
        return parseError;
      }

      // Only gate on session-monitoring when the query can return Session
      // comments. A branch-only query (`targetType=Branch`) stays ungated,
      // matching `traceCommentAccessError`'s per-branch bypass; without this a
      // branch inbox would 403 for viewers who lack the agent-session flag.
      if (params.targetType !== TraceCommentTargetType.Branch) {
        const viewerScope = await getAgentSessionViewerScope({
          userId: user.id,
          clerkUserId,
        });
        if (!viewerScope.monitoringEnabled) {
          return forbiddenResponse();
        }
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
      const surfaceResult = branchTraceCommentSurfaceFromRequest(
        request,
        targetType
      );
      if (surfaceResult.errorResponse) {
        return surfaceResult.errorResponse;
      }
      const comments = await traceCommentsService.list({
        organizationId: user.organizationId,
        userId: user.id,
        clerkUserId,
        target,
        surface: surfaceResult.surface,
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

      const policyError = await traceCommentSyncPolicyError(
        targetType,
        user.organizationId
      );
      if (policyError) {
        return policyError;
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
      const surfaceResult = branchTraceCommentSurfaceFromRequest(
        request,
        targetType
      );
      if (surfaceResult.errorResponse) {
        return surfaceResult.errorResponse;
      }
      try {
        const comment = await traceCommentsService.create({
          organizationId: user.organizationId,
          userId: user.id,
          clerkUserId,
          target,
          surface: surfaceResult.surface,
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

function branchTraceCommentSurfaceFromRequest(
  request: NextRequest,
  targetType: TraceCommentTargetType
) {
  if (targetType !== TraceCommentTargetType.Branch) {
    return {};
  }
  const { params, errorResponse } = parseQueryParams(
    request,
    branchTraceCommentRouteQuerySchema
  );
  return errorResponse ? { errorResponse } : { surface: params.surface };
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

      const policyError = await traceCommentSyncPolicyError(
        targetType,
        user.organizationId
      );
      if (policyError) {
        return policyError;
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
      const surfaceResult = branchTraceCommentSurfaceFromRequest(
        request,
        targetType
      );
      if (surfaceResult.errorResponse) {
        return surfaceResult.errorResponse;
      }
      try {
        const result = await traceCommentsService.update({
          organizationId: user.organizationId,
          userId: user.id,
          clerkUserId,
          target,
          surface: surfaceResult.surface,
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

      const policyError = await traceCommentSyncPolicyError(
        targetType,
        user.organizationId
      );
      if (policyError) {
        return policyError;
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
      const surfaceResult = branchTraceCommentSurfaceFromRequest(
        request,
        targetType
      );
      if (surfaceResult.errorResponse) {
        return surfaceResult.errorResponse;
      }
      try {
        const result = await traceCommentsService.reply({
          organizationId: user.organizationId,
          userId: user.id,
          clerkUserId,
          target,
          surface: surfaceResult.surface,
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
      const surfaceResult = branchTraceCommentSurfaceFromRequest(
        request,
        targetType
      );
      if (surfaceResult.errorResponse) {
        return surfaceResult.errorResponse;
      }
      try {
        const result = await traceCommentsService.delete({
          organizationId: user.organizationId,
          userId: user.id,
          clerkUserId,
          target,
          surface: surfaceResult.surface,
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

/**
 * Session-targeted trace comments are session-derived data that reaches the
 * ClosedLoop cloud, so FEA-4169's server-owned org session-sync policy must gate
 * these egress mutations too (create/update/reply) — not just the desktop batch,
 * transcript, and component-invocation sync boundaries. A member (or an
 * older/compromised Desktop that ignores the local gate) must not be able to
 * upload comment bodies while the org policy is OFF. Fail-closed and independent
 * of any client-sent field, mirroring `isOrgSessionSyncPolicyEnabled`'s other
 * callers. Branch-targeted comments are not session-sync data and stay ungated,
 * matching `traceCommentAccessError`'s per-branch bypass. Deletes are a removal,
 * not an egress of new content, so they remain reachable even after an admin
 * turns the policy off (so already-synced comments can still be cleaned up).
 */
async function traceCommentSyncPolicyError(
  targetType: TraceCommentTargetType,
  organizationId: string
) {
  if (targetType === TraceCommentTargetType.Branch) {
    return null;
  }

  const allowed = await isOrgSessionSyncPolicyEnabled(organizationId);
  return allowed ? null : forbiddenResponse();
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

const branchTraceCommentRouteQuerySchema =
  branchTraceCommentCollectionQuerySchema.extend({
    computeTargetId: z.string().optional(),
  });
