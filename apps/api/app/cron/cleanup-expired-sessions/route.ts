import { log } from "@repo/observability/log";
import { sessionRetentionService } from "@/app/agent-sessions/retention-service";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { scheduleLogFlush, scheduleLogFlushAfter } from "@/lib/route-utils";
import { buildCorrelationId, notifySlack } from "@/lib/slack-notifier";

/**
 * Daily cron sweep enforcing the data-governance retention window for synced
 * desktop agent sessions.
 *
 * Deletes `SessionDetail` rows (and their cascade children) whose last genuine
 * activity predates `SESSION_RETENTION_DAYS` (default 365). Without this sweep,
 * synced session metadata — cwd, repository, branch, pull requests, issues —
 * would persist indefinitely (NO_RETENTION_CLOUD).
 *
 * Protected by CRON_SECRET bearer token — must be set in environment and
 * passed via `Authorization: Bearer <secret>` header (e.g., Vercel Cron).
 *
 * Returns 500 on any sweep error to leverage Vercel's built-in cron failure
 * alerting.
 */
export const GET = async (request: Request): Promise<Response> => {
  const denied = validateCronSecret(request, "[cleanup-expired-sessions]");
  if (denied) {
    return denied;
  }

  const result = await sessionRetentionService.runRetentionSweep();

  log.info(`[cleanup-expired-sessions] ${result.summary}`, {
    deleted: result.deleted,
    retentionDays: result.retentionDays,
    cutoff: result.cutoff,
    exitCode: result.exitCode,
  });

  if (result.exitCode !== 0) {
    // Fire-and-forget the (potentially slow, retrying) Slack alert via
    // waitUntil so it never delays the 500 response, then flush logs once it
    // settles.
    scheduleLogFlushAfter(
      notifySlack({
        route: "cleanup-expired-sessions:daily",
        message: result.summary,
        correlationId: buildCorrelationId(),
      }).catch(() => {
        // Notification failed, but don't block the cron handler.
      })
    );

    return new Response(`ERROR: ${result.summary}`, { status: 500 });
  }

  scheduleLogFlush();

  return new Response(`OK: ${result.summary}`, { status: 200 });
};
