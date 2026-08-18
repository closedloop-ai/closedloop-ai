import { log } from "@repo/observability/log";
import { attachmentRowReconcileService } from "@/app/documents/attachment-row-reconcile-service";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { scheduleLogFlush, scheduleLogFlushAfter } from "@/lib/route-utils";
import { buildCorrelationId, notifySlack } from "@/lib/slack-notifier";

/**
 * Daily cron sweep reconciling the `fileAttachment` table against the
 * file-attachments bucket — the reciprocal of `/cron/reconcile-attachments`,
 * which sweeps the object side.
 *
 * Deletes rows whose S3 object does not exist (ORPHANED_ROW): the client
 * requested an upload, the row committed, and the presigned PUT never
 * completed. Rows still within the presigned-upload window are never
 * candidates, a row must be observed absent by two separate runs before it can
 * be deleted, and a row whose S3 state cannot be authoritatively determined is
 * skipped rather than deleted.
 *
 * DRY RUN BY DEFAULT. The sweep only reports what it would delete unless the
 * request carries `?apply=1`, so the blast radius is observable in the logs
 * before deletion is ever armed. Arming is a one-line change to the cron path
 * in `apps/api/vercel.json`.
 *
 * Protected by CRON_SECRET bearer token — must be set in environment and
 * passed via `Authorization: Bearer <secret>` header (e.g., Vercel Cron).
 *
 * Returns 500 on any sweep error to leverage Vercel's built-in cron failure
 * alerting, and posts to the ops Slack channel via `notifySlack`.
 */

// Matches the object-side sweep. The run is bounded by its own scan cap
// (MAX_ROWS_SCANNED_PER_RUN) well inside this budget; the explicit ceiling
// exists so a platform hard-timeout — which would kill the process outside
// runRowReconcileSweep's try/catch and silently skip the failure alert — is
// highly unlikely to fire.
export const maxDuration = 300;

export const GET = async (request: Request): Promise<Response> => {
  const denied = validateCronSecret(request, "[reconcile-attachment-rows]");
  if (denied) {
    return denied;
  }

  const apply = new URL(request.url).searchParams.get("apply") === "1";

  const result = await attachmentRowReconcileService.runRowReconcileSweep({
    apply,
  });

  log.info(`[reconcile-attachment-rows] ${result.summary}`, {
    scanned: result.scanned,
    newlyAbsent: result.newlyAbsent,
    orphansConfirmed: result.orphansConfirmed,
    orphansDeleted: result.orphansDeleted,
    recovered: result.recovered,
    ambiguous: result.ambiguous,
    truncated: result.truncated,
    dryRun: result.dryRun,
    exitCode: result.exitCode,
  });

  if (result.exitCode !== 0) {
    // Fire-and-forget the (potentially slow, retrying) Slack alert via
    // waitUntil so it never delays the 500 response, then flush logs once it
    // settles.
    scheduleLogFlushAfter(
      notifySlack({
        route: "reconcile-attachment-rows:daily",
        message: result.summary,
        correlationId: buildCorrelationId(),
        title: "Attachment row reconcile failure",
      }).catch(() => {
        // Notification failed, but don't block the cron handler.
      })
    );

    return new Response(`ERROR: ${result.summary}`, { status: 500 });
  }

  scheduleLogFlush();

  return new Response(`OK: ${result.summary}`, { status: 200 });
};
