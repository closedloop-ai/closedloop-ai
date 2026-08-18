import {
  type CommentThreadWithComments,
  DOCUMENT_THREAD_REQUEST_MAX_BYTES,
  ThreadSource,
  ThreadStatus,
} from "@repo/api/src/types/comment";
import { success } from "@repo/api/src/types/common";
import { isAnchorValidationError } from "@repo/collaboration/server/yjs-anchor";
import { NextResponse } from "next/server";
import { z } from "zod";
import { documentService } from "@/app/documents/document-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import { errorResponse, notFoundResponse, parseBody } from "@/lib/route-utils";
import { commentsService } from "../../../comments/service";

const getThreadsValidator = z.object({
  source: z.enum(ThreadSource).optional(),
  status: z.enum(ThreadStatus).optional(),
});

// anchorText present -> Liveblocks-anchored thread; absent -> Liveblocks
// artifact-level thread. An explicit empty string is still rejected.
const createThreadValidator = z.object({
  body: z.string().min(1),
  anchorText: z.string().min(1).optional(),
});

export const POST = withAnyAuth<
  { commentId: string; threadId: string },
  "/documents/[id]/threads"
>(async ({ user }, request, params) => {
  let requestHadAnchorText = false;

  try {
    const { id } = await params;

    const resolvedId = await resolveDocumentId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Artifact");
    }

    const artifact = await documentService.findById(
      resolvedId,
      user.organizationId
    );
    if (!artifact) {
      return notFoundResponse("Artifact");
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      createThreadValidator,
      { maxBytes: DOCUMENT_THREAD_REQUEST_MAX_BYTES }
    );
    if (parseError) {
      return parseError;
    }
    requestHadAnchorText = body.anchorText !== undefined;

    const result =
      body.anchorText === undefined
        ? await commentsService.createArtifactLevelDocumentThread(
            user.organizationId,
            artifact.slug,
            user.id,
            body.body
          )
        : await commentsService.createDocumentThread(
            user.organizationId,
            artifact.slug,
            user.id,
            body.body,
            body.anchorText
          );

    return NextResponse.json(success(result));
  } catch (error) {
    const isStructured =
      error != null && typeof error === "object" && "status" in error;
    const status =
      isStructured && typeof error.status === "number" ? error.status : 500;
    // Surface the structured reason (e.g. "Anchor text not found in document")
    // ONLY for the known anchor-validation 400s, so callers can diagnose them.
    // Everything else — 403/404/5xx provider failures (Liveblocks outages, auth) —
    // stays on the generic contract so upstream messages don't leak.
    const isKnownAnchorValidationError =
      requestHadAnchorText && isAnchorValidationError(error);
    const message =
      isKnownAnchorValidationError &&
      isStructured &&
      "message" in error &&
      typeof error.message === "string" &&
      error.message.length > 0
        ? error.message
        : "Failed to create thread";

    return errorResponse(message, error, status);
  }
});

export const GET = withAnyAuth<
  CommentThreadWithComments[],
  "/documents/[id]/threads"
>(async ({ user }, request, params) => {
  const { id } = await params;

  const resolvedId = await resolveDocumentId(id, user.organizationId);
  if (!resolvedId) {
    return notFoundResponse("Artifact");
  }

  const artifact = await documentService.findByIdSimple(
    resolvedId,
    user.organizationId
  );
  if (!artifact) {
    return notFoundResponse("Artifact");
  }

  const result = getThreadsValidator.safeParse(
    Object.fromEntries(request.nextUrl.searchParams)
  );
  if (!result.success) {
    return errorResponse("Invalid query params", result.error, 400);
  }

  const threads = await commentsService.findThreadsByDocument(
    user.organizationId,
    resolvedId,
    { source: result.data.source, status: result.data.status }
  );

  return NextResponse.json(success(threads));
});
