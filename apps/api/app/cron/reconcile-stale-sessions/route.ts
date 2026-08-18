import { log } from "@repo/observability/log";
import { staleSessionReaperService } from "@/app/agent-sessions/stale-session-reaper-service";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { scheduleLogFlush, scheduleLogFlushAfter } from "@/lib/route-utils";
import { buildCorrelationId, notifySlack } from "@/lib/slack-notifier";

export const maxDuration = 300;

export const GET = async (request: Request): Promise<Response> => {
  const denied = validateCronSecret(request, "[reconcile-stale-sessions]");
  if (denied) {
    return denied;
  }

  try {
    const result = await staleSessionReaperService.runStaleSessionSweep();

    log.info("[reconcile-stale-sessions] sweep completed", result);

    if (result.failed > 0) {
      scheduleLogFlushAfter(
        notifySlack({
          route: "reconcile-stale-sessions:hourly",
          message: `Stale session reaper: ${result.failed} row(s) failed to reap`,
          correlationId: buildCorrelationId(),
        }).catch(() => {})
      );
    } else {
      scheduleLogFlush();
    }

    return new Response(
      `OK: scanned=${result.scanned} reaped=${result.reaped} skippedByRecheck=${result.skippedByRecheck} skippedByContention=${result.skippedByContention} failed=${result.failed} deferred=${result.deferred} hasMore=${result.hasMore}`,
      { status: 200 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("[reconcile-stale-sessions] sweep failed", { error: message });
    scheduleLogFlushAfter(
      notifySlack({
        route: "reconcile-stale-sessions:hourly",
        message: `Stale session reconciliation failed: ${message}`,
        correlationId: buildCorrelationId(),
      }).catch(() => {
        // Notification failed, but does not block the cron response.
      })
    );

    return new Response("reconcile-stale-sessions failed", {
      status: 500,
    });
  }
};
