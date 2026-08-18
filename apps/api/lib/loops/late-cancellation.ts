/**
 * When a runner-reported `cancelled` event arrives too late to mean anything.
 *
 * Extracted from `loop-orchestrator.ts` (ISS-5711) — the orchestrator is a
 * shrink-only file, and this is a self-contained decision about one event's
 * admissibility rather than part of the dispatch or event-handling flow.
 */

import type { LoopEventError } from "@repo/api/src/types/loop";
import { LoopStatus } from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";
import { loopsService } from "@/app/loops/service";
import { TERMINAL_LOOP_STATUSES } from "@/app/loops/validators";

/**
 * Whether a `cancelled` event must be dropped outright because the loop already
 * settled on a DIFFERENT terminal status.
 *
 * The launch-failure cleanup kills the runner, which can answer `cancelled`
 * after the loop is already FAILED. Letting that event through is worse than
 * the refused status transition it used to cause: `deriveDisplayStatus` gives
 * the LAST terminal event priority over the polled DB status
 * (`loop-progress-panel.tsx:71-81`), so a stored `cancelled` event makes the
 * panel report CANCELLED for a loop the database correctly records as FAILED.
 *
 * Which is why callers must consult this BEFORE `addEvent`, not merely let the
 * transition be refused afterwards.
 *
 * A loop already in CANCELLED is NOT dropped: that is ordinary re-delivery of a
 * genuine cancellation, and its existing idempotent handling is unchanged.
 */
export function shouldIgnoreLateCancellation(
  loopId: string,
  loop: { status: string } | null
): boolean {
  if (
    !loop ||
    loop.status === LoopStatus.Cancelled ||
    !TERMINAL_LOOP_STATUSES.has(loop.status)
  ) {
    return false;
  }
  log.info("loop.late_cancelled_ignored", {
    loopId,
    status: loop.status,
    detail:
      "Cancelled event arrived after the loop settled on another terminal status; ignoring",
  });
  return true;
}

/**
 * Persist a genuine cancellation: the `cancelled` event, then the CANCELLED
 * transition when the loop is not already there (ordinary re-delivery).
 *
 * Callers must have cleared {@link shouldIgnoreLateCancellation} first —
 * splitting the two keeps the drop decision ahead of the first write, which is
 * the whole point of ISS-5711.
 *
 * `statusExtras` carries the cost/metadata fields the orchestrator derives from
 * the event, passed in rather than recomputed here so the shared builders stay
 * in one place and this module does not import back into the orchestrator. It
 * is typed off `updateStatus` itself so the two cannot drift.
 */
export async function recordCancellation(
  loopId: string,
  organizationId: string,
  event: LoopEventError,
  runner: { tokenJti: string; nonce: string } | undefined,
  loop: { status: string } | null,
  statusExtras: Parameters<typeof loopsService.updateStatus>[3]
): Promise<void> {
  await loopsService.addEvent(
    loopId,
    organizationId,
    {
      type: "cancelled",
      data: { reason: event.message, timestamp: event.timestamp },
    },
    runner
  );

  if (loop && loop.status !== LoopStatus.Cancelled) {
    await loopsService.updateStatus(
      loopId,
      organizationId,
      LoopStatus.Cancelled,
      { completedAt: new Date(), ...statusExtras }
    );
  }

  log.info("loop.cancelled", { loopId, reason: event.message });
}
