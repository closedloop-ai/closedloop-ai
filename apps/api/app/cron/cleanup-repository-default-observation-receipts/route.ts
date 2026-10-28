import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { sweepExpiredRepositoryDefaultObservationReceipts } from "@/lib/github/repository-default-observation-receipt";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { scheduleLogFlush } from "@/lib/route-utils";

const LOG_PREFIX = "[cleanup-repository-default-observation-receipts]";

/**
 * ISS-12780: daily retention sweep for `repository_default_observation_receipts`,
 * which nothing else deletes from. Authenticated by the cron secret. A failed
 * sweep answers 500 so Vercel's cron failure alerting fires.
 */
export const GET = withRequestCompleted(
  async (request: Request): Promise<Response> => {
    const denied = validateCronSecret(request, LOG_PREFIX);
    if (denied) {
      return denied;
    }
    try {
      const result = await sweepExpiredRepositoryDefaultObservationReceipts();
      log.info(
        `${LOG_PREFIX} deleted ${result.deleted} receipt(s) created before ${result.cutoff}`,
        result
      );
      scheduleLogFlush();
      return new Response(
        `OK: deleted ${result.deleted} receipt(s) created before ${result.cutoff}`,
        { status: 200 }
      );
    } catch (error) {
      log.error(`${LOG_PREFIX} sweep failed`, { error: parseError(error) });
      scheduleLogFlush();
      return new Response("ERROR: receipt retention sweep failed", {
        status: 500,
      });
    }
  }
);
