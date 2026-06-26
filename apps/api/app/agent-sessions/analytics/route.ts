import type { AgentSessionAnalytics } from "@repo/api/src/types/agent-session";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  forbiddenResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { getAgentSessionViewerScope } from "../route-helpers";
import { agentSessionsService } from "../service";
import { baseAgentSessionQuerySchema } from "../validators";

export const GET = withAnyAuth<
  AgentSessionAnalytics,
  "/agent-sessions/analytics"
>(async ({ user, clerkUserId }, request) => {
  const viewerScope = await getAgentSessionViewerScope({
    userId: user.id,
    clerkUserId,
  });
  if (!viewerScope.monitoringEnabled) {
    return forbiddenResponse();
  }

  const { params, errorResponse } = parseQueryParams(
    request,
    baseAgentSessionQuerySchema
  );
  if (errorResponse) {
    return errorResponse;
  }

  const analytics = await agentSessionsService.getAnalytics({
    organizationId: user.organizationId,
    filters: params,
  });

  return successResponse(analytics);
});
