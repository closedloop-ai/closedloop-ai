import { log } from "@repo/observability/log";
import { transcriptBackfillService } from "@/app/desktop/transcripts/backfill-service";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { scheduleLogFlush, scheduleLogFlushAfter } from "@/lib/route-utils";
import { buildCorrelationId, notifySlack } from "@/lib/slack-notifier";

/**
 * FEA-3789 (PRD-536 G3): daily cron that re-links orphaned session transcripts.
 *
 * `SessionTranscript.sessionDetailId` is resolved lazily on the transcript
 * sync/complete/skip path, but a transcript that finishes uploading BEFORE its
 * `SessionDetail` metadata arrives never re-plans and stays orphaned forever.
 * The transcript service links on the next plan/complete; the retention/phantom
 * sweeps reap transcript rows by identity on session deletion; this sweep is the
 * missing piece — it retroactively links transcripts that are ALREADY orphaned,
 * by the same session identity `(computeTargetId, externalSessionId)`.
 *
 * Protected by CRON_SECRET bearer token — must be set in environment and passed
 * via `Authorization: Bearer <secret>` header (e.g., Vercel Cron).
 *
 * Returns 500 on any sweep error to leverage Vercel's built-in cron failure
 * alerting.
 */
export const GET = async (request: Request): Promise<Response> => {
  const denied = validateCronSecret(request, "[backfill-orphan-transcripts]");
  if (denied) {
    return denied;
  }

  const result = await transcriptBackfillService.runBackfill();

  log.info(`[backfill-orphan-transcripts] ${result.summary}`, {
    linked: result.linked,
    unresolved: result.unresolved,
    exitCode: result.exitCode,
  });

  if (result.exitCode !== 0) {
    // Fire-and-forget the (potentially slow, retrying) Slack alert via waitUntil
    // so it never delays the 500 response, then flush logs once it settles.
    scheduleLogFlushAfter(
      notifySlack({
        route: "backfill-orphan-transcripts:daily",
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
