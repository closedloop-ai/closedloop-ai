import type { AgentSessionFieldMutationError } from "@repo/api/src/types/agent-session-field-mutation";
import type { ArtifactPriorityMutationError } from "@repo/api/src/types/artifact-priority-mutation";
import type { ArtifactRowFieldMutationError } from "@repo/api/src/types/artifact-row-field-edit";
import type { DocumentFieldMutationError } from "@repo/api/src/types/document-field-mutation";
import type { DocumentStatusMutationError } from "@repo/api/src/types/document-status-mutation";
import type { ProjectFieldMutationError } from "@repo/api/src/types/project-field-mutation";
import {
  badRequestResponse,
  conflictResponse,
  errorResponse,
  notFoundResponse,
} from "@/lib/route-utils";

/**
 * The HTTP rendering shared by every mutation that reports a structured `code`
 * plus `details` (ISS-9440). Documents, branches, sessions and projects all
 * use it, so it lives beside `optimistic-write-guard.ts` rather than under one
 * of them. Closed unions rather than a widened `code: string`, so a new error
 * family has to be admitted here deliberately instead of arriving by
 * inference. ISS-9485 admitted the row-field refusal, which is only ever a
 * 400; ISS-9486 admitted the session field guards, and ISS-11198 the document
 * and project field guards, all of which are only ever a 409.
 */
export function statusMutationErrorResponse(
  error:
    | DocumentStatusMutationError
    | ArtifactPriorityMutationError
    | ArtifactRowFieldMutationError
    | AgentSessionFieldMutationError
    | DocumentFieldMutationError
    | ProjectFieldMutationError
) {
  const metadata = {
    code: error.code,
    ...(error.details ? { details: error.details } : {}),
  };
  switch (error.status) {
    case 400:
      return badRequestResponse(error.message, metadata);
    case 404:
      return notFoundResponse("Artifact", metadata);
    case 409:
      return conflictResponse(error.message, metadata);
    default:
      return errorResponse(error.message, error, error.status, metadata);
  }
}
