import type { GlobalSearchResponse } from "@repo/api/src/types/search";
import { uuidValidator } from "@/app/compute-targets/validators";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  successResponse,
} from "@/lib/route-utils";
import { searchService } from "./service";

/**
 * GET /search?q=<query> - Global search across artifacts and projects
 * GET /search?tagId=<tagId> - Search artifacts by tag
 * Accepts API key authentication (sk_live_) or Clerk session authentication.
 */
export const GET = withAnyAuth<GlobalSearchResponse, "/search">(
  async ({ user }, request) => {
    try {
      const { searchParams } = new URL(request.url);
      const query = searchParams.get("q")?.trim();
      const tagId = searchParams.get("tagId")?.trim();

      if (tagId) {
        const parseResult = uuidValidator.safeParse(tagId);
        if (!parseResult.success) {
          return badRequestResponse("tagId must be a valid UUID");
        }

        const results = await searchService.searchByTag(
          user.organizationId,
          tagId
        );
        return successResponse(results);
      }

      if (!query) {
        return badRequestResponse("q is required");
      }

      if (query.length < 2) {
        return badRequestResponse("q must be at least 2 characters");
      }

      if (query.length > 200) {
        return badRequestResponse("q must be 200 characters or fewer");
      }

      const results = await searchService.search(user.organizationId, query);

      return successResponse(results);
    } catch (error) {
      return errorResponse("Failed to search", error);
    }
  }
);
