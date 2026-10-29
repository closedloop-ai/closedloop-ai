import { log } from "@repo/observability/log";
import { drainBranchMaterializationRetries } from "@/app/agent-sessions/service/artifact-links/branch-materialization-retry-drain";
import { classifyBranchMaterializationRetryFailure } from "@/app/agent-sessions/service/artifact-links/branch-materialization-retry-monitor";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { scheduleLogFlush } from "@/lib/route-utils";

/** The drain reserves settlement and log-flush time inside this route limit. */
export const maxDuration = 300;

/** Drain one bounded durable Branch-materialization retry batch. */
export const GET = async (request: Request): Promise<Response> => {
  const denied = validateCronSecret(
    request,
    "[drain-branch-materialization-retries]"
  );
  if (denied) {
    return denied;
  }

  try {
    const summary = await drainBranchMaterializationRetries();
    log.info(
      "[drain-branch-materialization-retries] Drained materialization retries",
      summary
    );
    scheduleLogFlush();
    return Response.json({ ok: true, summary });
  } catch (error) {
    log.error("[drain-branch-materialization-retries] Drain failed", {
      failureCategory: classifyBranchMaterializationRetryFailure(error),
    });
    scheduleLogFlush();
    return Response.json({ ok: false }, { status: 500 });
  }
};
