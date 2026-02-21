import type { Artifact } from "@repo/api/src/types/artifact";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { artifactsService } from "../service";
import { batchCreateArtifactsValidator } from "../validators";

/**
 * POST /artifacts/batch-create
 * Create multiple artifacts atomically in a single transaction.
 * Accepts API key authentication (sk_live_) or Clerk session authentication.
 * Maximum 50 artifacts per batch.
 */
export const POST = withAnyAuth<Artifact[], "/artifacts/batch-create">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        batchCreateArtifactsValidator
      );
      if (parseError) {
        return parseError;
      }

      const artifacts = await artifactsService.batchCreate(
        user.organizationId,
        user.id,
        body
      );

      return successResponse(artifacts);
    } catch (error) {
      return errorResponse("Failed to create artifacts", error);
    }
  },
  { requiredScopes: ["write"] }
);
