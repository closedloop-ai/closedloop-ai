import { log } from "@repo/observability/log";
import { phantomRetentionService } from "@/app/agent-sessions/phantom-retention-service";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { scheduleLogFlush, scheduleLogFlushAfter } from "@/lib/route-utils";
import { buildCorrelationId, notifySlack } from "@/lib/slack-notifier";

/**
 * FEA-3286: daily cron sweep that reclaims idle ("phantom") synced desktop
 * agent sessions — 0-turn / 0-token / no-tool-use / abandoned rows the desktop
 * live-hook minted on `SessionStart` before any real activity.
 *
 * Generalizes the old one-off `apps/api/scripts/purge-phantom-sessions.ts`
 * (which only matched a narrow Codex re-serialization burst and never ran on a
 * schedule) using the FEA-3284 `SESSION_IDLE_WHERE` SSOT, gated by an age window
 * (the late-chunk safety guard) and a no-PR guard so no real work is ever lost.
 * FEA-3287 stops NEW phantoms at the desktop source; this sweep drains the
 * existing backlog. Complements `cleanup-expired-sessions` (governance-window
 * retention) — that sweep deletes OLD sessions regardless of substance; this one
 * deletes EMPTY sessions once aged.
 *
 * Protected by CRON_SECRET bearer token — must be set in environment and passed
 * via `Authorization: Bearer <secret>` header (e.g., Vercel Cron).
 *
 * Returns 500 on any sweep error to leverage Vercel's built-in cron failure
 * alerting.
 */
export const GET = async (request: Request): Promise<Response> => {
  const denied = validateCronSecret(request, "[cleanup-phantom-sessions]");
  if (denied) {
    return denied;
  }

  const result = await phantomRetentionService.runPhantomSweep();

  log.info(`[cleanup-phantom-sessions] ${result.summary}`, {
    deleted: result.deleted,
    cutoff: result.cutoff,
    exitCode: result.exitCode,
  });

  if (result.exitCode !== 0) {
    // Fire-and-forget the (potentially slow, retrying) Slack alert via waitUntil
    // so it never delays the 500 response, then flush logs once it settles.
    scheduleLogFlushAfter(
      notifySlack({
        route: "cleanup-phantom-sessions:daily",
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
