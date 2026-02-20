import type {
  Artifact,
  ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { artifactsService } from "./service";
import {
  createArtifactValidator,
  findArtifactsQueryValidator,
} from "./validators";

/**
 * GET /artifacts - List artifacts
 * Accepts API key authentication (sk_live_) or Clerk session authentication.
 */
export const GET = withAnyAuth<ArtifactWithWorkstream[], "/artifacts">(
  async ({ user }, request) => {
    try {
      const searchParams = request.nextUrl.searchParams;

      // Convert searchParams to plain object for validation
      const queryParams = Object.fromEntries(searchParams.entries());

      // Validate query parameters
      const parseResult = findArtifactsQueryValidator.safeParse(queryParams);

      if (!parseResult.success) {
        return badRequestResponse(
          `Invalid query parameters: ${parseResult.error.message}`
        );
      }

      const artifacts = await artifactsService.findAll({
        organizationId: user.organizationId,
        ...parseResult.data,
      });

      return successResponse(artifacts);
    } catch (error) {
      return errorResponse("Failed to fetch artifacts", error);
    }
  }
);

export const POST = withAnyAuth<Artifact, "/artifacts">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        createArtifactValidator
      );
      if (parseError) {
        return parseError;
      }

      const artifact = await artifactsService.create(
        user.organizationId,
        user.id,
        body
      );
      if (!artifact) {
        return badRequestResponse("Failed to create artifact");
      }

      return successResponse(artifact);
    } catch (error) {
      return errorResponse("Failed to create artifact", error);
    }
  },
  { requiredScopes: ["write"] }
);
