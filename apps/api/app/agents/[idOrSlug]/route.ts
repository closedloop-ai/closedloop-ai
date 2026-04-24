import type { AgentDetail } from "@repo/api/src/types/agent";
import { isOrgAdmin } from "@/lib/auth/org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  deleteResponse,
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { agentsService } from "../service";
import { updateAgentValidator } from "../validators";

export const GET = withAnyAuth<AgentDetail, "/agents/[idOrSlug]">(
  async ({ user }, _request, params) => {
    try {
      const { idOrSlug } = await params;
      const agent = await agentsService.findByIdOrSlug(
        idOrSlug,
        user.organizationId
      );

      if (!agent) {
        return notFoundResponse("Agent");
      }

      return successResponse(agent);
    } catch (error) {
      return errorResponse("Failed to fetch agent", error);
    }
  }
);

export const PATCH = withAnyAuth<AgentDetail, "/agents/[idOrSlug]">(
  async ({ user, clerkOrgId, clerkUserId }, request, params) => {
    try {
      const adminCheck = await isOrgAdmin(clerkOrgId, clerkUserId);
      if (!adminCheck) {
        return forbiddenResponse();
      }

      const { idOrSlug } = await params;
      const { body, errorResponse: parseError } = await parseBody(
        request,
        updateAgentValidator
      );
      if (parseError) {
        return parseError;
      }

      const agent = await agentsService.update(
        idOrSlug,
        user.organizationId,
        user.id,
        body
      );

      if (!agent) {
        return notFoundResponse("Agent");
      }

      return successResponse(agent);
    } catch (error) {
      return errorResponse("Failed to update agent", error);
    }
  }
);

export const DELETE = withAnyAuth<{ deleted: true }, "/agents/[idOrSlug]">(
  async ({ user, clerkOrgId, clerkUserId }, _request, params) => {
    try {
      const adminCheck = await isOrgAdmin(clerkOrgId, clerkUserId);
      if (!adminCheck) {
        return forbiddenResponse();
      }

      const { idOrSlug } = await params;
      const deleted = await agentsService.delete(idOrSlug, user.organizationId);

      if (!deleted) {
        return notFoundResponse("Agent");
      }

      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete agent", error);
    }
  }
);
