import "server-only";

import type { RankingResponse } from "@repo/api/src/types/analytics";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { rankingQuerySchema } from "../analytics-validators";
import { rankingService } from "./service";

/**
 * GET /agent-components/ranking
 *
 * Returns org-wide stack-ranked components grouped by kind.
 * Visible to all org members (withAnyAuth, no admin gate).
 *
 * Query params:
 *   kind  — optional; filter to a specific AgentComponentKind value.
 *   limit — optional; max items returned (default 50).
 */
export const GET = withAnyAuth<RankingResponse, "/agent-components/ranking">(
  async ({ user }, request) => {
    const { params: query, errorResponse: parseError } = parseQueryParams(
      request,
      rankingQuerySchema
    );
    if (parseError) {
      return parseError;
    }
    const { kind, limit } = query;

    try {
      const response = await rankingService.getRanking({
        organizationId: user.organizationId,
        kind,
        limit,
      });
      return successResponse(response);
    } catch (error) {
      return errorResponse("Failed to fetch component ranking", error);
    }
  },
  { requiredScopes: ["read"] }
);
