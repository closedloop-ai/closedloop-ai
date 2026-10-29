import type {
  InsightsPeriod,
  InsightsSection,
} from "@repo/api/src/types/insights";
import { InsightsScope } from "@repo/api/src/types/insights";
import type { SessionAnalyticsSection } from "@repo/api/src/types/session-analytics";
import type { User } from "@repo/api/src/types/user";
import { log } from "@repo/observability/log";
import type { NextRequest } from "next/server";
import {
  emitInsightsSectionLatency,
  emitInsightsSectionLatencySuppressed,
} from "@/lib/observability/insights-metrics";
import { insightsSectionLatencyThrottle } from "@/lib/observability/insights-section-latency-throttle";
import {
  errorResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import {
  authorizeTeamScopeRead,
  teamScopeRefusalResponse,
} from "@/lib/team-scope-policy";
import type { InsightsScopeContext } from "../service/scope";
import { insightsQueryValidator } from "../validators";

/**
 * Shared handler for the Insights section routes. ISS-8022 removed the API-level
 * flag gate (Kerensa Whitlock's call, 2026-08-25). The routes admitted either `insights`
 * OR the now-retired `desktop-agent-session-sync`; narrowing that disjunction to
 * `insights` alone would have 403'd the metric fetches of the org Dashboard,
 * which is itself ungated — the FEA-4155 blank-surface class. So these routes are
 * open to any authenticated identity in the org, `sk_live_*` keys included, and
 * what still bounds a read is org scoping plus `authorizeTeamScopeRead` on a
 * team-scoped request. The standalone Insights PAGE stays dark-launched behind
 * `insights` via its `FeatureFlagRouteGate`, which gates that page shell only,
 * not this data. Parses the
 * `period` and `scope` query params, resolves the scope context from the
 * authenticated user, delegates to the section service, and maps the result to a
 * response.
 *
 * A section failure is logged under `insights.<section>_failed` with the
 * org/user/scope correlation the handler holds (FEA-3031) — `errorResponse`
 * logs only the prose message and the raw error, which leaves a Datadog
 * operator with no way to pivot to the org, user, or team that hit it.
 *
 * A section SUCCESS emits `insights.dashboard.section_latency` (ISS-7512) so
 * "which section is slow" is answerable from Datadog without reading code. The
 * two are complements, not alternatives: the metric carries only bounded tags
 * and the failure log carries the tenant correlation.
 */
export function createInsightsHandler<TResponse>(config: {
  fetch: (
    ctx: InsightsScopeContext,
    period: InsightsPeriod
  ) => Promise<TResponse>;
  // Also accepts the standalone session-analytics routes, which are not
  // dashboard sections. Used only to
  // name the failure log event.
  section: InsightsSection | SessionAnalyticsSection;
  errorMessage: string;
}) {
  return async (
    {
      user,
      clerkOrgId,
      clerkUserId,
    }: { user: User; clerkOrgId: string; clerkUserId: string },
    request: NextRequest
  ) => {
    const { params, errorResponse: paramsError } = parseQueryParams(
      request,
      insightsQueryValidator
    );
    if (paramsError) {
      return paramsError;
    }

    // Hoisted out of the `try` so the catch can correlate a failure raised by
    // the team-scope authorization as well as one raised by the service.
    const correlation = {
      organizationId: user.organizationId,
      userId: user.id,
      scope: params.scope,
      teamId: params.scope === InsightsScope.Team ? params.teamId : undefined,
    };

    try {
      if (params.scope === InsightsScope.Team) {
        const teamScopeAllowed = await authorizeTeamScopeRead({
          organizationId: user.organizationId,
          userId: user.id,
          clerkOrgId,
          clerkUserId,
          teamId: params.teamId,
          requiresTeamScope: true,
        });
        const teamScopeRefusal = teamScopeRefusalResponse(teamScopeAllowed);
        if (teamScopeRefusal) {
          return teamScopeRefusal;
        }
      }
      const ctx: InsightsScopeContext = {
        ...correlation,
        clerkUserId,
        timeZone: params.timeZone,
      };
      // ISS-7512: the clock starts HERE, not at handler entry, so the sample
      // measures the section read itself. A request rejected by param parsing or
      // by the team-scope check returned above and never reaches this line —
      // neither ran a section, so neither has a section latency to report.
      const startedAtMs = Date.now();
      const result = await config.fetch(ctx, params.period);
      recordSectionLatency({
        organizationId: user.organizationId,
        section: config.section,
        period: params.period,
        scope: params.scope,
        durationMs: Date.now() - startedAtMs,
      });
      return successResponse(result);
    } catch (error) {
      log.error(`insights.${config.section}_failed`, { error, ...correlation });
      return errorResponse(config.errorMessage, error);
    }
  };
}

/**
 * Sample one successful section read through the per-(org, tag tuple) emission
 * throttle (ISS-7512, #5818 review).
 *
 * The read has already completed before this runs and nothing here touches the
 * response, so the throttle can only change what Datadog sees, never what the
 * reader gets. See `insights-section-latency-throttle.ts` for why the bound is
 * needed at all — `/insights/*` has no limiter in front of it, so an
 * authenticated caller could otherwise replay a section route into an unbounded
 * emit stream.
 *
 * The window-rollover rollup is flushed here rather than inside the throttle
 * because `record` returns it to its caller; the eviction and expiry rollups
 * come out of the shared instance's own `onFlush`. `drainExpired` runs on this
 * same path — O(1) when nothing has expired — so a burst followed by quiet
 * still reaches the rollup instead of waiting for the same key to be touched
 * again, which on a serverless instance that then freezes would be never.
 */
function recordSectionLatency(sample: {
  organizationId: string;
  section: InsightsSection | SessionAnalyticsSection;
  period: InsightsPeriod;
  scope: InsightsScope;
  durationMs: number;
}): void {
  const { organizationId, durationMs, ...parts } = sample;
  const now = Date.now();
  const decision = insightsSectionLatencyThrottle.record(
    organizationId,
    parts,
    now
  );
  if (decision.flushedSuppressedCount > 0) {
    emitInsightsSectionLatencySuppressed({
      ...parts,
      suppressedCount: decision.flushedSuppressedCount,
    });
  }
  if (decision.emit) {
    emitInsightsSectionLatency({
      ...parts,
      teamScoped: parts.scope === InsightsScope.Team,
      durationMs,
    });
  }
  insightsSectionLatencyThrottle.drainExpired(now);
}
