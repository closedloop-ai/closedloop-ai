import type { AgentSessionListResponse } from "@repo/api/src/types/agent-session";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  forbiddenResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import {
  authorizeAgentSessionTeamScope,
  resolveDisplayedStatusParity,
} from "./route-helpers";
import { agentSessionsService } from "./service";
import { agentSessionListQuerySchema } from "./validators";

// FEA-4155: the Sessions surface is no longer gated behind the winding-down
// `DESKTOP_AGENT_SESSION_SYNC` flag on the client, so the matching server read
// gate (`getAgentSessionViewerScope().monitoringEnabled`, which resolved from
// that same PostHog key) is gone too — otherwise the page mounts but every read
// 403s as the flag winds down (wongk review #3789). Org/team RBAC still applies
// via `authorizeAgentSessionTeamScope` + org-scoped service reads.
export const GET = withAnyAuth<AgentSessionListResponse, "/agent-sessions">(
  async ({ user, clerkOrgId, clerkUserId }, request) => {
    const { params, errorResponse } = parseQueryParams(
      request,
      agentSessionListQuerySchema
    );
    if (errorResponse) {
      return errorResponse;
    }

    const teamScopeAllowed = await authorizeAgentSessionTeamScope({
      organizationId: user.organizationId,
      userId: user.id,
      clerkOrgId,
      clerkUserId,
      filters: params,
    });
    if (!teamScopeAllowed) {
      return forbiddenResponse();
    }

    const response = await agentSessionsService.findSessions({
      organizationId: user.organizationId,
      // FEA-3534: thread the authenticated viewer so `viewerScope=self` is
      // enforced server-side (Me scope pins the read to this user's sessions).
      viewerId: user.id,
      // ISS-4556 / ISS-4559: resolved here so the Status facet stays a synchronous
      // predicate. Off by default; see `resolveDisplayedStatusParity`.
      displayedStatusParity: await resolveDisplayedStatusParity({
        userId: user.id,
        clerkUserId,
      }),
      filters: params,
    });

    return successResponse(response);
  }
);
