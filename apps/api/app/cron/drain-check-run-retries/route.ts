import { log } from "@repo/observability/log";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { drainDueCheckRunRetries } from "@/lib/branch-status-check-retry-drain";
import { scheduleLogFlush } from "@/lib/route-utils";

/** Cron endpoint that drains due GitHub check_run retry rows in bounded batches. */
export const GET = async (request: Request): Promise<Response> => {
  const denied = validateCronSecret(request, "[drain-check-run-retries]");
  if (denied) {
    return denied;
  }

  const summary = await drainDueCheckRunRetries();
  // A rescheduled claim warns but does not page: infrastructure's
  // check-run-retry-dead-lettered monitor counts only `@deadLettered:>0`.
  if (summary.failures.length > 0) {
    log.warn(
      "[drain-check-run-retries] Drained check_run retries with provider failures",
      summary
    );
  } else {
    log.info("[drain-check-run-retries] Drained check_run retries", summary);
  }
  scheduleLogFlush();

  return Response.json({ ok: true, summary });
};
