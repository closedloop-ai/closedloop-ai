import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { docSyncSweepService } from "@/app/doc-sync/internal/sweep-service";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { scheduleLogFlush } from "@/lib/route-utils";

const LOG_PREFIX = "[sweep-doc-sync-state]";

/**
 * PLN-2200 T-6.2: GET /cron/sweep-doc-sync-state — deletes the doc-sync state
 * of documents that no longer exist. Authenticated by the cron secret. A run
 * with a failed delete or list, or one the deadline cut short, answers 500 so
 * Vercel's cron failure alerting fires; an unconfigured doc-sync answers 200.
 */
export function createSweepDocSyncStateCronHandler() {
  return async (request: Request): Promise<Response> => {
    const denied = validateCronSecret(request, LOG_PREFIX);
    if (denied) {
      return denied;
    }
    try {
      const summary = await docSyncSweepService.run({
        deadlineMs: SWEEP_DEADLINE_MS,
      });
      log.info(`${LOG_PREFIX} run completed`, {
        event: DOC_SYNC_SWEEP_COMPLETED_EVENT,
        ...summary,
      });
      scheduleLogFlush();
      const incomplete = summary.failed > 0 || summary.truncated;
      return new Response(
        `${incomplete ? "INCOMPLETE" : "OK"}: scanned ${summary.scanned}, deleted ${summary.deleted}, kept ${summary.kept}, unparseable ${summary.unparseable}, failed ${summary.failed}, truncated ${summary.truncated}`,
        { status: incomplete ? HTTP_INTERNAL_ERROR : HTTP_OK }
      );
    } catch (error) {
      log.error(`${LOG_PREFIX} run failed`, { error: parseError(error) });
      scheduleLogFlush();
      return new Response("sweep-doc-sync-state failed", {
        status: HTTP_INTERNAL_ERROR,
      });
    }
  };
}

/** Inside the route's 300 s `maxDuration`, leaving room for an in-flight delete's 8 s timeout. */
export const SWEEP_DEADLINE_MS = 240_000;
export const DOC_SYNC_SWEEP_COMPLETED_EVENT = "doc_sync.sweep_completed";

const HTTP_OK = 200;
const HTTP_INTERNAL_ERROR = 500;
