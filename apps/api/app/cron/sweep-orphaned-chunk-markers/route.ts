import { log } from "@repo/observability/log";
import { pendingChunkSweepService } from "@/app/agent-sessions/pending-chunk-sweep-service";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { scheduleLogFlush, scheduleLogFlushAfter } from "@/lib/route-utils";
import { buildCorrelationId, notifySlack } from "@/lib/slack-notifier";

/**
 * ISS-8602 (PRD-699 §6): daily cron sweep that clears orphaned
 * chunked-apply markers — the `pendingChunkRevision` / `pendingChunkTotal` /
 * `pendingChunkReceived` / `pendingChunkAckContract` quadruple left staged on a
 * `SessionDetail` by a sequence that never completed.
 *
 * It clears only markers whose producer is confirmed to speak the row-level ack
 * and COUNTS the rest; see `pending-chunk-sweep-service.ts` for why clearing the
 * other band is a data-loss path.
 *
 * Scheduled AFTER `cleanup-phantom-sessions` (04:53), not before it, and the
 * order is load-bearing — it is the difference between un-marking a row and
 * deleting one. `phantomSessionWhere` spares a row carrying a marker, so this
 * sweep is what makes a row phantom-eligible; running it first would hand every
 * freed row to a purge that DELETES within minutes. That purge's idle predicate
 * counts `tool_use` events actually landed (`persist-session-children.ts`), so a
 * session holding only its early chunks can present as idle, and a tail still in
 * an outbox would find its session gone. Running after leaves ~23h before the
 * next phantom pass — a window in which any arriving chunk re-stages the marker
 * and restores that immunity. See `pending-chunk-sweep-service.ts` for the rest
 * of the safety argument.
 *
 * Protected by CRON_SECRET bearer token — must be set in environment and passed
 * via `Authorization: Bearer <secret>` header (e.g., Vercel Cron).
 *
 * Returns 500 on any sweep error to leverage Vercel's built-in cron failure
 * alerting.
 */
/**
 * The drain reserves settlement and log-flush time inside this route limit. A
 * platform timeout is not a catchable exception, so without this bound a large
 * backlog is truncated SILENTLY — past the `try`, past the 500, past the alert.
 */
export const maxDuration = 300;
export const GET = async (request: Request): Promise<Response> => {
  const denied = validateCronSecret(request, "[sweep-orphaned-chunk-markers]");
  if (denied) {
    return denied;
  }

  const result = await pendingChunkSweepService.runPendingChunkSweep();

  log.info(`[sweep-orphaned-chunk-markers] ${result.summary}`, {
    cleared: result.cleared,
    // ISS-8602: the markers this run DECLINED to clear, because their producer is
    // not confirmed to speak the row-level ack. Carried beside `cleared` so an
    // operator reading this one daily line can tell "there was nothing to repair"
    // from "there was, and none of it was safe to touch" — the sibling metric is a
    // differently-named log line nobody would know to cross-reference.
    //
    // `null` means NOT MEASURED, never zero: the count runs inside a reserve, so
    // an errored or budget-bound run reports the repair it managed and no reading
    // for this.
    skippedUnconfirmedAck: result.skippedUnconfirmedAck,
    ttlHours: result.ttlHours,
    cutoff: result.cutoff,
    exitCode: result.exitCode,
  });

  if (result.exitCode !== 0) {
    // Fire-and-forget the (potentially slow, retrying) Slack alert via waitUntil
    // so it never delays the 500 response, then flush logs once it settles.
    scheduleLogFlushAfter(
      notifySlack({
        route: "sweep-orphaned-chunk-markers:daily",
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
