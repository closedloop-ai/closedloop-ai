import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { agentComponentsService } from "../service";

export const GET = withAnyAuth<
  AgentComponentDetail,
  "/agent-components/[slug]"
>(
  async ({ user }, _, params) => {
    try {
      const { slug } = await params;
      const detail = await agentComponentsService.getDetailForOrg(
        user.organizationId,
        decodeURIComponent(slug)
      );
      if (!detail) {
        return notFoundResponse("AgentComponent");
      }
      return successResponse(detail);
    } catch (error) {
      return errorResponse("Failed to fetch agent component", error);
    }
  },
  { requiredScopes: ["read"] }
);
