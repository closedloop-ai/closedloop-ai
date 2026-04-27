import type { BatchMoveArtifactsResult } from "@repo/api/src/types/artifact";
import { Status } from "@repo/api/src/types/result";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { artifactLinksService } from "../service";
import { batchMoveArtifactsValidator } from "../validators";

/**
 * POST /artifact-links/batch-move
 * Move an artifact and optionally all its downstream artifacts to a target project.
 */
export const POST = withAnyAuth<
  BatchMoveArtifactsResult,
  "/artifact-links/batch-move"
>(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        batchMoveArtifactsValidator
      );
      if (parseError) {
        return parseError;
      }

      const result = await artifactLinksService.batchMoveArtifacts(
        user.organizationId,
        body
      );

      if (result.ok) {
        return successResponse(result.value);
      }

      // The service distinguishes between "source artifact missing"
      // (NotFound) and "target project missing" (BadRequest). Mirror that
      // in the HTTP response instead of flattening both to 400.
      if (result.error === Status.NotFound) {
        return notFoundResponse("Artifact");
      }
      if (result.error === Status.BadRequest) {
        return badRequestResponse("Target project not found");
      }
      return badRequestResponse("Failed to move items");
    } catch (error) {
      return errorResponse("Failed to move artifacts", error);
    }
  },
  { requiredScopes: ["write"] }
);
