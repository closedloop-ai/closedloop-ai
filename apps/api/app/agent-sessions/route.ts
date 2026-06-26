import type { AgentSessionListResponse } from "@repo/api/src/types/agent-session";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  forbiddenResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { getAgentSessionViewerScope } from "./route-helpers";
import { agentSessionsService } from "./service";
import { agentSessionListQuerySchema } from "./validators";

export const GET = withAnyAuth<AgentSessionListResponse, "/agent-sessions">(
  async ({ user, clerkUserId }, request) => {
    const viewerScope = await getAgentSessionViewerScope({
      userId: user.id,
      clerkUserId,
    });
    if (!viewerScope.monitoringEnabled) {
      return forbiddenResponse();
    }

    const { params, errorResponse } = parseQueryParams(
      request,
      agentSessionListQuerySchema
    );
    if (errorResponse) {
      return errorResponse;
    }

    const response = await agentSessionsService.findSessions({
      organizationId: user.organizationId,
      filters: params,
    });

    return successResponse(response);
  }
);
