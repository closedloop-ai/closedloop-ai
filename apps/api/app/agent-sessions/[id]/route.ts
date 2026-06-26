import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  forbiddenResponse,
  type IdRouteParams,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { getAgentSessionViewerScope } from "../route-helpers";
import { agentSessionsService } from "../service";

export const GET = withAnyAuth<AgentSessionDetail, "/agent-sessions/[id]">(
  async ({ user, clerkUserId }, _request, params) => {
    const viewerScope = await getAgentSessionViewerScope({
      userId: user.id,
      clerkUserId,
    });
    if (!viewerScope.monitoringEnabled) {
      return forbiddenResponse();
    }

    const { id } = (await params) as Awaited<IdRouteParams["params"]>;
    const session = await agentSessionsService.findSessionDetail({
      id,
      organizationId: user.organizationId,
    });

    if (!session) {
      return notFoundResponse("Agent session");
    }

    return successResponse(session);
  }
);
