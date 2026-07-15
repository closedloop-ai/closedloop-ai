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
  log.info("[drain-check-run-retries] Drained check_run retries", summary);
  scheduleLogFlush();

  return Response.json({ ok: true, summary });
};
