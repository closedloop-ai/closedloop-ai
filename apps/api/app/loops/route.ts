import type {
  CreateLoopResponse,
  LoopWithUser,
} from "@repo/api/src/types/loop";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveArtifactId } from "@/lib/identifier-utils";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { loopsService } from "./service";
import { createLoopValidator, listLoopsQueryValidator } from "./validators";

export const GET = withAnyAuth<LoopWithUser[], "/loops">(
  async ({ user }, request) => {
    try {
      const searchParams = request.nextUrl.searchParams;
      const queryParams = Object.fromEntries(searchParams.entries());

      const parseResult = listLoopsQueryValidator.safeParse(queryParams);

      if (!parseResult.success) {
        return badRequestResponse(
          `Invalid query parameters: ${parseResult.error.message}`
        );
      }

      const { artifactId, ...restQuery } = parseResult.data;
      let resolvedArtifactId: string | undefined;
      if (artifactId) {
        const aId = await resolveArtifactId(artifactId, user.organizationId);
        if (!aId) {
          return notFoundResponse("Artifact");
        }
        resolvedArtifactId = aId;
      }

      const loops = await loopsService.findAll(user.organizationId, {
        artifactId: resolvedArtifactId,
        ...restQuery,
      });

      return successResponse(loops);
    } catch (error) {
      return errorResponse("Failed to fetch loops", error);
    }
  }
);

/**
 * POST /loops — Creates a loop DB record only (status: PENDING).
 * Does NOT launch the loop. To create AND launch, use POST /artifacts/[id]/run-loop.
 */
export const POST = withAnyAuth<CreateLoopResponse, "/loops">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        createLoopValidator
      );
      if (parseError) {
        return parseError;
      }

      const result = await loopsService.create(
        user.organizationId,
        user.id,
        body
      );

      return successResponse(result);
    } catch (error) {
      return errorResponse("Failed to create loop", error);
    }
  },
  { requiredScopes: ["write"] }
);
