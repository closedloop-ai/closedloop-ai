import {
  type InsightsScope,
  InsightsScope as InsightsScopeValues,
} from "@closedloop-ai/loops-api/insights";

/**
 * Desktop implements local `me` reads and cloud-backed `org` reads only.
 * Explicit `team` scope is rejected until desktop has a teamId-capable path;
 * older unknown values keep the legacy fallback to personal scope.
 */
export function coerceDesktopInsightsScope(
  value: unknown
): InsightsScope | null {
  if (value === InsightsScopeValues.Team) {
    return null;
  }
  if (value === InsightsScopeValues.Org) {
    return InsightsScopeValues.Org;
  }
  return InsightsScopeValues.Me;
}
