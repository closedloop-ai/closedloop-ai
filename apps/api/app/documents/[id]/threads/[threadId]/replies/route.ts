import {
  DOCUMENT_THREAD_REQUEST_MAX_BYTES,
  documentThreadReplyDraftSchema,
} from "@repo/api/src/types/comment";
import { commentsService } from "@/app/comments/service";
import { documentService } from "@/app/documents/document-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";

/**
 * POST /documents/[id]/threads/[threadId]/replies — reply to a document comment
 * thread (FEA-3950). Anyone with view access on the document may reply (per the
 * product decision, comment permission is NOT gated on edit access). The reply
 * is written to Liveblocks (source of truth) then projected locally. Threading
 * is flat: every reply attaches to the thread, mirroring the trace-comment
 * reply model rendered flat.
 */
export const POST = withAnyAuth<
  { threadId: string; commentId: string },
  "/documents/[id]/threads/[threadId]/replies"
>(async ({ user }, request, params) => {
  const { id, threadId } = await params;

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

  const { body, errorResponse: parseError } = await parseBody(
    request,
    documentThreadReplyDraftSchema,
    { maxBytes: DOCUMENT_THREAD_REQUEST_MAX_BYTES }
  );
  if (parseError) {
    return parseError;
  }

  try {
    const result = await commentsService.replyToDocumentThread(
      user.organizationId,
      resolvedId,
      threadId,
      user.id,
      body.body
    );
    if (!result.ok) {
      return notFoundResponse("Thread");
    }
    return successResponse(result.value);
  } catch (error) {
    return errorResponse("Failed to reply to thread", error);
  }
});
