import { errorResponse } from "@/lib/route-utils";
import {
  type ContextDocumentError,
  ContextDocumentErrorCode,
} from "./context-document-service";

/**
 * The 500 a context-attachment route answers when a context PRD was not
 * stored, with the message it answered that failure with before ISS-12552
 * moved the PRD, its attachment and its link into one transaction.
 */
export function contextDocumentFailureResponse(error: ContextDocumentError) {
  return errorResponse(
    CONTEXT_DOCUMENT_FAILURE_MESSAGES[error.code],
    error.cause ?? null
  );
}

const CONTEXT_DOCUMENT_FAILURE_MESSAGES: Record<
  ContextDocumentErrorCode,
  string
> = {
  [ContextDocumentErrorCode.SigningFailed]: "Failed to request upload",
  [ContextDocumentErrorCode.CreateFailed]:
    "Failed to create artifact for context attachment",
  [ContextDocumentErrorCode.LinkRejected]:
    "Failed to link artifact to document",
};
