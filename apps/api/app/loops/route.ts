import type {
  CreateLoopResponse,
  LoopWithUser,
} from "@repo/api/src/types/loop";
import { withAuth } from "@/lib/auth/with-auth";
import {
  badRequestResponse,
  errorResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { loopsService } from "./service";
import { createLoopValidator, listLoopsQueryValidator } from "./validators";

export const GET = withAuth<LoopWithUser[], "/loops">(
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

      const loops = await loopsService.findAll(
        user.organizationId,
        parseResult.data
      );

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
export const POST = withAuth<CreateLoopResponse, "/loops">(
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
  }
);
