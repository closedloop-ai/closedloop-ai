import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { waitUntil } from "@vercel/functions";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { penseroDeliveryWindow } from "@/lib/delivery-points/delivery-point-window";
import { parseQueryParams, successResponse } from "@/lib/route-utils";
import { teamScopeRefusalResponse } from "@/lib/team-scope-policy";
import { listQueryRefusalMetadata } from "../list-query-param";
import {
  authorizeAgentSessionTeamScope,
  resolveUsageTypedSqlShadow,
} from "../route-helpers";
import { agentSessionsService } from "../service";
import { sessionsPenseroPointsReader } from "../service/pensero-points-per-dollar";
import { penseroSessionPopulationIsWhole } from "../service/pensero-population-alignment";
import { shadowUsageSummary } from "../service/usage-summary-shadow";
import { agentSessionUsageQuerySchema } from "../validators";

// FEA-4155: no `monitoringEnabled` flag gate — see the sibling list route. The
// Sessions surface is always-on now, so this usage read must not 403 as the
// winding-down `DESKTOP_AGENT_SESSION_SYNC` flag resolves false. Org/team RBAC
// stays via `authorizeAgentSessionTeamScope`.
export const GET = withAnyAuth<
  AgentSessionUsageSummary,
  "/agent-sessions/usage"
>(async ({ user, clerkOrgId, clerkUserId }, request) => {
  const { params, errorResponse } = parseQueryParams(
    request,
    agentSessionUsageQuerySchema,
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

  // ISS-11117: the Pensero display gate is evaluated inside the reader's
  // factory, so the service never learns which principal is asking. The shadow
  // read below deliberately gets no reader — see `buildUsageSummary`.
  //
  // The two terms must describe ONE population, and the two axes that can
  // part them get different answers.
  //
  // DATE — carried, not withheld. The delivery fold sums only the shares the
  // provider dated inside this request's range, so the numerator covers the
  // same period `costUsd` does (`penseroDeliveryWindow`).
  //
  // EVERY OTHER FACET — withheld. Pick one owner, model or repository and the
  // divisor loses that branch's other spend while the branch keeps its whole
  // points total, and no window can reconcile that because the numerator is
  // branch-keyed and the divisor is session-keyed
  // (`pensero-population-alignment.ts`). The card renders LOC/$ instead.
  const [typedSqlShadow, readPenseroPointsPerDollar] = await Promise.all([
    resolveUsageTypedSqlShadow({
      userId: user.id,
      clerkUserId,
    }),
    penseroSessionPopulationIsWhole(params)
      ? sessionsPenseroPointsReader(
          { userId: user.id, clerkUserId },
          user.organizationId,
          penseroDeliveryWindow(params)
        )
      : undefined,
  ]);

  const usageInput = {
    organizationId: user.organizationId,
    // FEA-3534: enforce `viewerScope=self` for Me-scoped usage reads.
    viewerId: user.id,
    filters: params,
  };
  const summary = await agentSessionsService.getUsageSummary(
    usageInput,
    readPenseroPointsPerDollar
  );

  if (typedSqlShadow) {
    // ISS-8554 / PLN-1853 D6. Runs the TypedSQL candidate beside the response
    // just built and logs the diff. Handed to `waitUntil` rather than floated:
    // the reader still does not wait, but the instance survives long enough for
    // the comparison to finish. Floating it dropped whichever comparisons were
    // still running when the instance froze -- the SLOW ones, which is what a
    // misbehaving candidate looks like -- so the surviving diffs were a biased
    // sample to open the flag on. `summary` is handed in rather than re-read,
    // so the diff describes exactly the response this request returned.
    waitUntil(shadowUsageSummary(usageInput, summary));
  }

  return successResponse({
    ...summary,
    ...(params.componentSlug ? { componentScope: params.componentSlug } : {}),
  });
});
