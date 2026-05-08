import type { GenerationStatus } from "@repo/api/src/types/document";
import { withAuth } from "@/lib/auth/with-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { documentGenerationStatusService } from "../../../generation-status-service";
import { dismissGenerationStatusValidator } from "./validators";

export const PUT = withAuth<
  GenerationStatus,
  "/documents/[id]/generation-status/dismiss"
>(async ({ user }, request, params) => {
  const { id } = await params;
  const resolvedId = await resolveDocumentId(id, user.organizationId);
  if (!resolvedId) {
    return notFoundResponse("Artifact");
  }

  const { body, errorResponse: parseError } = await parseBody(
    request,
    dismissGenerationStatusValidator
  );
  if (parseError) {
    return parseError;
  }

  try {
    const status =
      await documentGenerationStatusService.dismissGenerationStatus(
        resolvedId,
        user.organizationId,
        user.id,
        body.runKey ?? null
      );
    if (!status) {
      return notFoundResponse("Artifact");
    }
    return successResponse(status);
  } catch (error) {
    return errorResponse("Failed to dismiss generation status", error);
  }
});
