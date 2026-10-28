import { log } from "@repo/observability/log";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { sweepExpiredFeatureFlagDecisions } from "@/lib/feature-flag-decision-store";
import { scheduleLogFlush } from "@/lib/route-utils";

/**
 * Daily retention sweep for ISS-8126's cross-instance flag decisions.
 *
 * `feature_flag_decisions.viewer_key` is a request principal — the JSON pair of
 * a Clerk id and our own user id — and nothing else deletes these rows. A
 * publish only ever overwrites the row for a viewer it is currently evaluating,
 * so a RETIRED flag and a DELETED user both leave their identity records behind
 * permanently. This is the path that removes them.
 *
 * Deleting past `FEATURE_FLAG_DECISION_RETENTION_MS` cannot change any gate's
 * answer: every reader already discards a row older than its own
 * `sharedDecisionTtlMs`, and the retention window is required to exceed all of
 * them, so the rows this removes were unreadable before it ran.
 *
 * Protected by CRON_SECRET bearer token — must be set in environment and passed
 * via `Authorization: Bearer <secret>` header (e.g. Vercel Cron).
 *
 * Returns 500 on a sweep error to leverage Vercel's built-in cron failure
 * alerting. Unlike the request-path store methods, which swallow so a flag
 * lookup degrades instead of throwing, a failure here must be visible: silently
 * stopped retention looks identical to nothing needing deletion.
 */
export const GET = async (request: Request): Promise<Response> => {
  const denied = validateCronSecret(
    request,
    "[cleanup-feature-flag-decisions]"
  );
  if (denied) {
    return denied;
  }

  try {
    const result = await sweepExpiredFeatureFlagDecisions();

    log.info(
      `[cleanup-feature-flag-decisions] deleted ${result.deleted} decision(s) evaluated before ${result.cutoff}`,
      { deleted: result.deleted, cutoff: result.cutoff }
    );
    scheduleLogFlush();

    return new Response(
      `OK: deleted ${result.deleted} decision(s) evaluated before ${result.cutoff}`,
      { status: 200 }
    );
  } catch (error) {
    log.error("[cleanup-feature-flag-decisions] sweep failed", { error });
    scheduleLogFlush();

    return new Response("ERROR: feature-flag decision retention sweep failed", {
      status: 500,
    });
  }
};
