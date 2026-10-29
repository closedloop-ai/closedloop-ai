import type { AgentComponentInvocationReadPage } from "@repo/api/src/types/agent-component-invocation";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { invocationsPageQuerySchema } from "../../detail-page-validators";
import { agentComponentsService } from "../../service";

export const GET = withAnyAuth<
  AgentComponentInvocationReadPage,
  "/agent-components/[slug]/invocations"
>(
  async ({ user }, request, params) => {
    const { params: query, errorResponse: parseError } = parseQueryParams(
      request,
      invocationsPageQuerySchema
    );
    if (parseError) {
      return parseError;
    }
    try {
      const { slug } = await params;
      const detail = await agentComponentsService.getDetailForOrg(
        user.organizationId,
        slug,
        { userId: user.id, clerkUserId: user.clerkId },
        { invocationCursor: query.cursor }
      );
      if (!detail) {
        return notFoundResponse("AgentComponent");
      }
      const page = detail.invocationRows;
      if (!page) {
        return notFoundResponse("AgentComponent");
      }
      return successResponse(page);
    } catch (error) {
      return errorResponse("Failed to fetch agent component", error);
    }
  },
  { requiredScopes: ["read"] }
);
