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
 * POST /documents/[id]/threads/[threadId]/resolve — resolve a document comment
 * thread (FEA-3950, FEA-4092). PARTICIPANT-resolve: the thread author OR anyone
 * who replied to the thread may resolve, enforced server-side in the service (a
 * non-participant gets 403). The resolution is applied in Liveblocks (source of
 * truth) then projected locally.
 */
export const POST = withAnyAuth<
  { status: string },
  "/documents/[id]/threads/[threadId]/resolve"
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
    const result = await commentsService.resolveDocumentThread(
      user.organizationId,
      resolvedId,
      threadId,
      user.id,
      new Date()
    );
    if (!result.ok) {
      return result.error === Status.Forbidden
        ? forbiddenResponse()
        : notFoundResponse("Thread");
    }
    return successResponse(result.value);
  } catch (error) {
    return errorResponse("Failed to resolve thread", error);
  }
});
