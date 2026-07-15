import type { AgentComponentListResponse } from "@repo/api/src/types/agent-component";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { agentComponentsService } from "./service";
import {
  type AgentComponentListQuery,
  agentComponentListQuerySchema,
} from "./validators";

export const GET = withAnyAuth<AgentComponentListResponse, "/agent-components">(
  async ({ user }, request) => {
    const { params, errorResponse: parseErrorResponse } = parseQueryParams(
      request,
      agentComponentListQuerySchema
    );
    if (parseErrorResponse) {
      return parseErrorResponse;
    }
    try {
      const response = await agentComponentsService.listForOrg(
        user.organizationId,
        params as AgentComponentListQuery
      );
      return successResponse(response);
    } catch (error) {
      return errorResponse("Failed to fetch agent components", error);
    }
  },
  { requiredScopes: ["read"] }
);
