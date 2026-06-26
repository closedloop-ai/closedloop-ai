import type {
  CreateLoopRequest,
  CreateLoopResponse,
  LoopAlreadyActiveBody,
  LoopCommand,
  LoopListFilters,
  LoopStatus,
  LoopWithUser,
} from "@repo/api/src/types/loop";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { handleLoopServiceError } from "./loop-error-responses";
import { loopsService } from "./service";
import { createLoopValidator, listLoopsQueryValidator } from "./validators";

type CreateLoopRouteResponse = CreateLoopResponse | LoopAlreadyActiveBody;

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

      const filters: LoopListFilters = {
        documentId: resolvedArtifactId,
        status: restQuery.status as LoopStatus | undefined,
        command: restQuery.command as LoopCommand | undefined,
        projectId: restQuery.projectId,
        limit: restQuery.limit,
        offset: restQuery.offset,
      };

      const loops = await loopsService.findAll(user.organizationId, filters);

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
export const POST = withAnyAuth<CreateLoopRouteResponse, "/loops">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        createLoopValidator
      );
      if (parseError) {
        return parseError;
      }

      const resolved: CreateLoopRequest = {
        ...body,
        command: body.command as LoopCommand,
      };
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
      const result = await loopsService.create(
        user.organizationId,
        user.id,
        resolved
      );

      return successResponse(result);
    } catch (error) {
      return handleLoopServiceError(error, "Failed to create loop");
    }
  },
  { requiredScopes: ["write"] }
);
