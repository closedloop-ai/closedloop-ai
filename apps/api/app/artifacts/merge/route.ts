import type { Artifact } from "@repo/api/src/types/artifact";
import { withAuth } from "@/lib/auth/with-auth";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { ArtifactNotFoundError } from "../artifact-utils";
import { artifactsService } from "../service";
import { mergeArtifactsValidator } from "../validators";

const SAME_PROJECT_ERROR_RE = /same project/i;
const TEMPLATE_ERROR_RE = /TEMPLATE/i;

/**
 * POST /artifacts/merge
 * Merge two artifacts into one: combines content via LLM, saves to primary,
 * and deletes the secondary artifact.
 *
 * Why withAuth (not withAnyAuth): merge combines a write operation (new version on
 * primary) with a delete operation (secondary artifact). API key access would require
 * both write and delete scopes simultaneously, which is not supported. Restrict to
 * session-based auth only.
 */
export const POST = withAuth<Artifact, "/artifacts/merge">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        mergeArtifactsValidator
      );
      if (parseError) {
        return parseError;
      }

      const updatedArtifact = await artifactsService.merge(
        body.primaryArtifactId,
        body.secondaryArtifactId,
        user.organizationId,
        user.id
      );

      return successResponse(updatedArtifact);
    } catch (error) {
      if (error instanceof ArtifactNotFoundError) {
        return notFoundResponse("Artifact");
      }
      if (
        error instanceof Error &&
        (SAME_PROJECT_ERROR_RE.test(error.message) ||
          TEMPLATE_ERROR_RE.test(error.message))
      ) {
        return badRequestResponse(error.message);
      }
      return errorResponse("Failed to merge artifacts", error);
    }
  }
);
