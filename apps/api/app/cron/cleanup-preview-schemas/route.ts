import { log } from "@repo/observability/log";
import { previewSchemaCleanupService } from "@/app/preview-schemas/service";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { scheduleLogFlush, scheduleLogFlushAfter } from "@/lib/route-utils";
import { buildCorrelationId, notifySlack } from "@/lib/slack-notifier";

/**
 * Daily cron sweep for preview schema cleanup.
 *
 * Drops stale (TTL-expired) and orphaned preview schemas. Active schemas are
 * preserved. Schedule: 17 6 * * * (06:17 UTC daily).
 *
 * Protected by CRON_SECRET bearer token — must be set in environment and
 * passed via `Authorization: Bearer <secret>` header (e.g., Vercel Cron).
 *
 * Returns 500 on any sweep error to leverage Vercel's built-in cron failure
 * alerting (GAP-001).
 */
export const GET = async (request: Request): Promise<Response> => {
  const denied = validateCronSecret(request, "[cleanup-preview-schemas]");
  if (denied) {
    return denied;
  }

  const result = await previewSchemaCleanupService.runDailySweep();

  log.info(`[cleanup-preview-schemas] ${result.summary}`, {
    counters: result.counters,
    exitCode: result.exitCode,
  });

  // `exitCode` is the single source of truth for failure: runDailySweep derives
  // it via computeExitCode(), which is already 1 whenever any category errored
  // or a registry read errored. Re-checking the per-category counters here would
  // be dead code that restates that definition.
  if (result.exitCode !== 0) {
    // Fire-and-forget: run the (potentially slow, retrying) Slack alert in the
    // background via waitUntil so it never delays the HTTP response, then flush
    // logs once it settles. The handler returns 500 immediately below.
    scheduleLogFlushAfter(
      notifySlack({
        route: "cleanup-preview-schemas:daily",
        message: result.summary,
        counters: result.counters,
        correlationId: buildCorrelationId(),
      }).catch(() => {
        // Notification failed, but don't block the cron handler
      })
    );

    return new Response(`ERROR: ${result.summary}`, { status: 500 });
  }

  scheduleLogFlush();

  return new Response(`OK: ${result.summary}`, { status: 200 });
};
