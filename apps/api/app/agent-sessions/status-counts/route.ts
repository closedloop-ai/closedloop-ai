import type { AgentSessionStatusCountsResponse } from "@repo/api/src/types/agent-session-status-counts";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { parseQueryParams, successResponse } from "@/lib/route-utils";
import { teamScopeRefusalResponse } from "@/lib/team-scope-policy";
import { listQueryRefusalMetadata } from "../list-query-param";
import { authorizeAgentSessionTeamScope } from "../route-helpers";
// The ONE deliberate departure from `apps/api/AGENTS.md`'s "service.ts stays the
// only export consumed by routes": that barrel imports `projections.ts`, the row
// projection this endpoint exists to never pay for, so routing through it would
// put the cost back in the module graph. `status-counts.test.ts` asserts the
// absence structurally, which is what makes this a contract rather than a habit.
import { buildAgentSessionStatusCounts } from "../service/status-counts";
import { agentSessionStatusCountsQuerySchema } from "../validators";

/**
 * ISS-8858: `GET /agent-sessions/status-counts` — one count per DISPLAYED status
 * for a filter set, in one request, paying no row projection.
 *
 * ## A sibling route, not a `?view=counts` mode on the list
 *
 * AC8 forbids changing `GET /agent-sessions`'s response contract, and a mode
 * param would do exactly that: its handler is typed
 * `withAnyAuth<AgentSessionListResponse, "/agent-sessions">`, so a counts shape
 * would have to widen that into a union every existing caller — including
 * already-installed desktop builds — would then have to narrow. A separate path
 * leaves the list byte-identical and cannot regress it, and it is where this
 * endpoint family already puts a differently-shaped read of the same population
 * (`/usage`, `/analytics`, `/export`).
 *
 * Additive and optional in the cross-repo sense: nothing existing changes shape,
 * and a client that never calls this path sees today's behaviour exactly.
 *
 * Same guards as its siblings, in the same order, because it reads the same
 * population: org scope through the service's `organizationId`, team RBAC through
 * {@link authorizeAgentSessionTeamScope} before any query starts, `viewerScope=self`
 * pinned server-side to the authenticated viewer. The list, the usage summary,
 * the analytics fold, the CSV export and this count are ONE cohort because they
 * share one `where`.
 */
export const GET = withAnyAuth<
  AgentSessionStatusCountsResponse,
  "/agent-sessions/status-counts"
>(async ({ user, clerkOrgId, clerkUserId }, request) => {
  const { params, errorResponse } = parseQueryParams(
    request,
    agentSessionStatusCountsQuerySchema,
    {
      errorMetadata: listQueryRefusalMetadata,
    }
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
  const teamScopeRefusal = teamScopeRefusalResponse(teamScopeAllowed);
  if (teamScopeRefusal) {
    return teamScopeRefusal;
  }

  const counts = await buildAgentSessionStatusCounts({
    organizationId: user.organizationId,
    viewerId: user.id,
    filters: params,
  });

  return successResponse(counts);
});
