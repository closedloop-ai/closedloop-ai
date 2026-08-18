import { Status } from "@repo/api/src/types/result";
import { commentsService } from "@/app/comments/service";
import { documentService } from "@/app/documents/document-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import {
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";

/**
 * POST /documents/[id]/threads/[threadId]/unresolve — reopen a resolved document
 * comment thread (FEA-3950, unchanged by FEA-4092). AUTHOR ONLY: only the thread
 * creator may reopen, enforced server-side (a non-author, including a non-author
 * participant, gets 403). Reopen stays author-only even though resolve is now
 * participant-scoped. The action is applied in Liveblocks (source of truth) then
 * projected locally.
 */
export const POST = withAnyAuth<
  { status: string },
  "/documents/[id]/threads/[threadId]/unresolve"
>(async ({ user }, _request, params) => {
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

  try {
    const result = await commentsService.reopenDocumentThreadAsAuthor(
      user.organizationId,
      resolvedId,
      threadId,
      user.id
    );
    if (!result.ok) {
      return result.error === Status.Forbidden
        ? forbiddenResponse()
        : notFoundResponse("Thread");
    }
    return successResponse(result.value);
  } catch (error) {
    return errorResponse("Failed to unresolve thread", error);
  }
});
