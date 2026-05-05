import type {
  CreateLoopResponse,
  LoopWithUser,
} from "@repo/api/src/types/loop";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId, resolveWorkstreamId } from "@/lib/identifier-utils";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import {
  isBranchNotFoundError,
  isConcurrentLoopLimitError,
  isNestedManualLoopError,
  isUnauthorizedRepoError,
  loopsService,
} from "./service";
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

      const { documentId, ...restQuery } = parseResult.data;
      let resolvedArtifactId: string | undefined;
      if (documentId) {
        const aId = await resolveDocumentId(documentId, user.organizationId);
        if (!aId) {
          return notFoundResponse("Artifact");
        }
        resolvedArtifactId = aId;
      }

      const loops = await loopsService.findAll(user.organizationId, {
        documentId: resolvedArtifactId,
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

      const resolved = { ...body };
      if (body.documentId) {
        const docId = await resolveDocumentId(
          body.documentId,
          user.organizationId
        );
        if (!docId) {
          return notFoundResponse("Document");
        }
        resolved.documentId = docId;
      }
      if (body.workstreamId) {
        const wsId = await resolveWorkstreamId(
          body.workstreamId,
          user.organizationId
        );
        if (!wsId) {
          return notFoundResponse("Workstream");
        }
        resolved.workstreamId = wsId;
      }

      const result = await loopsService.create(
        user.organizationId,
        user.id,
        resolved
      );

      return successResponse(result);
    } catch (error) {
      if (isConcurrentLoopLimitError(error)) {
        return errorResponse(error.message, error, 429);
      }
      if (isNestedManualLoopError(error)) {
        return errorResponse(error.message, error, 409);
      }
      if (isUnauthorizedRepoError(error)) {
        return errorResponse(error.message, error, 403);
      }
      if (isBranchNotFoundError(error)) {
        return errorResponse(error.message, error, 400);
      }
      return errorResponse("Failed to create loop", error);
    }
  },
  { requiredScopes: ["write"] }
);
