import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { scheduleLogFlush } from "@/lib/route-utils";
import {
  PullRequestCommentReconcileRunStatus,
  runPullRequestCommentReconcile,
} from "./service";

const LOG_PREFIX = "[reconcile-pr-comments]";

/**
 * PLN-2122 Step 5: GET /cron/reconcile-pr-comments — reconciles the stored
 * GitHub comments of due open pull requests against complete provider lists.
 * Authenticated by the cron secret, which also records the invocation. Each run
 * logs one structured summary, the record a heartbeat monitor reads.
 */
export function createReconcilePrCommentsCronHandler() {
  return async (request: Request): Promise<Response> => {
    const denied = validateCronSecret(request, LOG_PREFIX);
    if (denied) {
      return denied;
    }
    try {
      const summary = await runPullRequestCommentReconcile();
      const emit =
        summary.status === PullRequestCommentReconcileRunStatus.Ok
          ? log.info
          : log.warn;
      emit(`${LOG_PREFIX} run completed`, summary);
      scheduleLogFlush();
      return new Response(
        `OK: due ${summary.due}, reconciled ${summary.reconciled}, partial ${summary.partial}, provider errors ${summary.providerErrors}, failed ${summary.failed}`,
        { status: 200 }
      );
    } catch (error) {
      log.error(`${LOG_PREFIX} run failed`, { error: parseError(error) });
      scheduleLogFlush();
      return new Response("reconcile-pr-comments failed", { status: 500 });
    }
  };
}
