import type { AgentComponentPageDataResult } from "@repo/api/src/utils/agent-component-page-data";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { agentComponentPageDataService } from "./service";
import {
  type AgentComponentPageDataQueryParams,
  agentComponentPageDataQuerySchema,
} from "./validators";

/**
 * ISS-6822 — `GET /agent-components/page-data`.
 *
 * The bounded read behind the Agents workspace: one request returning the
 * current page, the matched total, both summary-window aggregates, and the facet
 * option universe with counts, in place of three up-to-5,000-row inventory
 * fetches the browser then reduced itself.
 *
 * Additive: `GET /agent-components` is untouched and remains the read path for
 * every installed desktop build and any client that has not adopted this
 * endpoint.
 */
export const GET = withAnyAuth<
  AgentComponentPageDataResult,
  "/agent-components/page-data"
>(
  async ({ user }, request) => {
    const { params, errorResponse: parseErrorResponse } = parseQueryParams(
      request,
      agentComponentPageDataQuerySchema
    );
    if (parseErrorResponse) {
      return parseErrorResponse;
    }
    try {
      const response = await agentComponentPageDataService.getPageDataForOrg(
        user.organizationId,
        params as AgentComponentPageDataQueryParams
      );
      return successResponse(response);
    } catch (error) {
      return errorResponse("Failed to fetch agent component page data", error);
    }
  },
  { requiredScopes: ["read"] }
);
