import type { AgentDetail, AgentListResponse } from "@repo/api/src/types/agent";
import { isOrgAdmin } from "@/lib/auth/org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  forbiddenResponse,
  parseBody,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { agentsService } from "./service";
import { createAgentValidator, listAgentsQueryValidator } from "./validators";

export const GET = withAnyAuth<AgentListResponse, "/agents">(
  async ({ user }, request) => {
    try {
      const { params: query, errorResponse: queryError } = parseQueryParams(
        request,
        listAgentsQueryValidator
      );
      if (queryError) {
        return queryError;
      }

      const result = await agentsService.findAll(user.organizationId, query);

      return successResponse(result);
    } catch (error) {
      return errorResponse("Failed to fetch agents", error);
    }
  }
);

export const POST = withAnyAuth<AgentDetail, "/agents">(
  async ({ user, clerkOrgId, clerkUserId }, request) => {
    try {
      const adminCheck = await isOrgAdmin(clerkOrgId, clerkUserId);
      if (!adminCheck) {
        return forbiddenResponse();
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        createAgentValidator
      );
      if (parseError) {
        return parseError;
      }

      const agent = await agentsService.create(
        user.organizationId,
        user.id,
        body
      );

      return successResponse(agent);
    } catch (error) {
      return errorResponse("Failed to create agent", error);
    }
  }
);
