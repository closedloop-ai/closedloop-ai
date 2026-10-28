import {
  AgentSessionPatchField,
  ArtifactRowFieldMutationErrorCode,
} from "@repo/api/src/types/artifact-row-field-edit";
import { forbiddenResponse, notFoundResponse } from "@/lib/route-utils";

/** ISS-9485: `PATCH /agent-sessions/[id]`'s 404, carrying the shared code. */
export function sessionNotFoundResponse() {
  return notFoundResponse("Agent session", {
    code: ArtifactRowFieldMutationErrorCode.ArtifactsNotFound,
  });
}

/**
 * ISS-9485: a rename by a caller who is neither the owner nor an org admin.
 * The caller may write the session's other fields, so the refusal names the
 * one field it is refused.
 */
export function renameForbiddenResponse() {
  return forbiddenResponse({
    code: ArtifactRowFieldMutationErrorCode.FieldForbidden,
    details: { forbiddenFields: [AgentSessionPatchField.Name] },
  });
}
