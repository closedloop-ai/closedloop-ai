import { log } from "@repo/observability/log";
import { refreshDueBranchAnalyticsRollups } from "@/app/branches/branch-analytics-rollup";
import { classifyBranchAnalyticsRollupFailure } from "@/app/branches/branch-analytics-rollup-failure";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { scheduleLogFlush } from "@/lib/route-utils";

const ROUTE_TAG = "[refresh-branch-analytics-rollups]";

/** The rollup refresh reserves transaction and log-flush time inside this route limit. */
export const maxDuration = 300;

/** Refresh bounded Branch analytics aggregate batches for due organizations. */
export const GET = async (request: Request): Promise<Response> => {
  const denied = validateCronSecret(request, ROUTE_TAG);
  if (denied) {
    return denied;
  }

  try {
    const summary = await refreshDueBranchAnalyticsRollups();
    // `@failedOrganizations:>0` on this tag is what infrastructure's
    // branch-analytics-rollup-refresh-failed monitor counts.
    if (summary.failedOrganizations > 0) {
      log.warn(
        `${ROUTE_TAG} refresh finished with failed organizations`,
        summary
      );
    } else {
      log.info(`${ROUTE_TAG} refresh complete`, summary);
    }
    scheduleLogFlush();
    return Response.json({ ok: true, summary });
  } catch (error) {
    log.error(`${ROUTE_TAG} refresh failed`, {
      failureCategory: classifyBranchAnalyticsRollupFailure(error),
    });
    scheduleLogFlush();
    return Response.json({ ok: false }, { status: 500 });
  }
};
