import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  type IdRouteParams,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { agentSessionsService } from "../service";

// FEA-4155: no `monitoringEnabled` flag gate (see the sibling list route). The
// Sessions surface is always-on now, so opening a session detail must not 403 as
// the winding-down `DESKTOP_AGENT_SESSION_SYNC` flag resolves false. The org
// boundary is the org-scoped `findSessionDetail` read (a session in another org
// still 404s).
export const GET = withAnyAuth<AgentSessionDetail, "/agent-sessions/[id]">(
  async ({ user }, _request, params) => {
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
