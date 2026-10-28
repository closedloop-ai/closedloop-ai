import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import {
  DOCUMENT_THREAD_REQUEST_MAX_BYTES,
  documentThreadReplyDraftSchema,
} from "@repo/api/src/types/comment";
import type { NextRequest } from "next/server";
import { commentsService } from "@/app/comments/service";
import { documentService } from "@/app/documents/document-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import type {
  AuthContext,
  AuthenticatedJsonResponse,
  RouteContext,
} from "@/lib/auth/with-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import {
  type OperationReceiptRecorder,
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
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
>(withOperationReceipts(OperationKind.Comment, replyToThreadResponse));

async function replyToThreadResponse(
  { user }: AuthContext,
  request: NextRequest,
  params: RouteContext<"/documents/[id]/threads/[threadId]/replies">["params"],
  receipts: OperationReceiptRecorder
): Promise<AuthenticatedJsonResponse<{ threadId: string; commentId: string }>> {
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
      body.body,
      receipts.whenRecording((tx, written) =>
        receipts.record(tx, {
          operationKind: OperationKind.Comment,
          outcome: OperationReceiptOutcome.Committed,
          targetArtifactId: resolvedId,
          commentId: written.commentRowId,
        })
      )
    );
    if (!result.ok) {
      return notFoundResponse("Thread");
    }
    return successResponse(withOperationReceipt(result.value, receipts));
  } catch (error) {
    return errorResponse("Failed to reply to thread", error);
  }
}
