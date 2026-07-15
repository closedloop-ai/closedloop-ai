import { log } from "@repo/observability/log";
import { attachmentReconcileService } from "@/app/documents/attachment-reconcile-service";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { scheduleLogFlush, scheduleLogFlushAfter } from "@/lib/route-utils";
import { buildCorrelationId, notifySlack } from "@/lib/slack-notifier";

/**
 * Daily cron sweep reconciling the file-attachments bucket against the
 * `fileAttachment` table.
 *
 * Deletes S3 objects that have no backing row (ORPHANED_OBJECT) — these leak
 * when `deleteAttachment` commits the row delete but the best-effort S3 delete
 * throws, stranding the object in the bucket forever. Objects still within the
 * presigned-upload window are skipped so in-flight uploads are never disturbed.
 *
 * Protected by CRON_SECRET bearer token — must be set in environment and
 * passed via `Authorization: Bearer <secret>` header (e.g., Vercel Cron).
 *
 * Returns 500 on any sweep error to leverage Vercel's built-in cron failure
 * alerting.
 */

// Give the full-bucket sweep generous headroom. The sweep is bounded by batched
// list + DeleteObjects calls (≤1000 keys each) and an indexed per-page lookup,
// so it stays well within this budget; the explicit ceiling exists so a
// platform hard-timeout — which would kill the process outside runReconcileSweep's
// try/catch and silently skip the failure alert — is highly unlikely to fire.
export const maxDuration = 300;

export const GET = async (request: Request): Promise<Response> => {
  const denied = validateCronSecret(request, "[reconcile-attachments]");
  if (denied) {
    return denied;
  }

  const result = await attachmentReconcileService.runReconcileSweep();

  log.info(`[reconcile-attachments] ${result.summary}`, {
    scanned: result.scanned,
    orphansDeleted: result.orphansDeleted,
    exitCode: result.exitCode,
  });

  if (result.exitCode !== 0) {
    // Fire-and-forget the (potentially slow, retrying) Slack alert via
    // waitUntil so it never delays the 500 response, then flush logs once it
    // settles.
    scheduleLogFlushAfter(
      notifySlack({
        route: "reconcile-attachments:daily",
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
