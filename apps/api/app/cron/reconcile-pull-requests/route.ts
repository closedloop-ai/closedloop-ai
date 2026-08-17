import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { scheduleLogFlush } from "@/lib/route-utils";
import { githubPullRequestReconcilerService } from "./service";

const LOG_PREFIX = "[reconcile-pull-requests]";

// A fan-out sweep of up to RECONCILE_REPO_BATCH repos; give it room inside
// Vercel's bounded runtime (matches the other reconcile crons).
export const maxDuration = 300;

/**
 * PLN-1535 M2: GET /cron/reconcile-pull-requests — the server-side PR-projection
 * reconciler. Cron-triggered (see apps/api/vercel.json); one bounded batch per
 * tick, credential drawn per repo from the tiered sync-read pool. Idempotent and
 * durable: each repo's failure is a persisted state transition, not a 500.
 */
export const GET = async (request: Request): Promise<Response> => {
  const denied = validateCronSecret(request, LOG_PREFIX);
  if (denied) {
    return denied;
  }
  try {
    const summary = await githubPullRequestReconcilerService.run();
    log.info(`${LOG_PREFIX} sweep completed`, summary);
    scheduleLogFlush();
    return new Response(
      `OK: swept ${summary.reposSwept}, deferred ${summary.reposDeferredBudget}, reclassified ${summary.reposReclassified}, failed ${summary.reposFailed}, wrote ${summary.pullRequestsWritten}`,
      { status: 200 }
    );
  } catch (error) {
    log.error(`${LOG_PREFIX} sweep failed`, { error: parseError(error) });
    scheduleLogFlush();
    return new Response("reconcile-pull-requests failed", { status: 500 });
  }
};
