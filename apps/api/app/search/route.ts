import type { GlobalSearchResponse } from "@repo/api/src/types/search";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  successResponse,
} from "@/lib/route-utils";
import { searchService } from "./service";

/**
 * GET /search?q=<query> - Global search across artifacts, issues, workstreams, and projects
 * Accepts API key authentication (sk_live_) or Clerk session authentication.
 */
export const GET = withAnyAuth<GlobalSearchResponse, "/search">(
  async ({ user }, request) => {
    try {
      const { searchParams } = new URL(request.url);
      const query = searchParams.get("q")?.trim();

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
