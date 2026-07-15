import { LoopStatus, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { deleteLoopState, getLoopPrefix } from "@/lib/loops/loop-state";
import { scheduleLogFlush } from "@/lib/route-utils";

/**
 * Daily retention sweep for loop-state S3 objects.
 *
 * The loop-state bucket stores each loop's full conversation history,
 * context-pack, event logs, and work-dir snapshot. It has no S3 lifecycle
 * policy, so without this sweep that state — which includes proprietary source
 * from the Claude Code transcript — would persist indefinitely after a loop
 * reaches a terminal status (NO_LOOP_STATE_RETENTION).
 *
 * Deletes the entire S3 prefix for any loop that reached a terminal status more
 * than LOOP_STATE_RETENTION_DAYS ago, then stamps `s3StateCleanedAt` so the loop
 * is never re-listed on later runs. The DB LoopEvent rows are left intact; only
 * the S3 footprint is purged. Resume and post-run artifact download depend on
 * this state during the active/recent window, so the horizon is generous.
 *
 * Protected by CRON_SECRET bearer token — must be set in environment and passed
 * via `Authorization: Bearer <secret>` header (e.g. Vercel Cron).
 */

// Generous headroom: the sweep is bounded by SWEEP_BATCH loops, each purged via
// batched list + DeleteObjects calls (≤1000 keys each). The explicit ceiling
// exists so a platform hard-timeout — which would kill the process outside the
// per-loop try/catch — is highly unlikely to fire.
export const maxDuration = 300;

/** Retain a terminal loop's S3 state for this long after completion. */
const LOOP_STATE_RETENTION_DAYS = 90;

/** Loops purged per run; bounds the cron budget, remainder handled next tick. */
const SWEEP_BATCH = 200;

const TERMINAL_STATUSES = [
  LoopStatus.COMPLETED,
  LoopStatus.FAILED,
  LoopStatus.CANCELLED,
  LoopStatus.TIMED_OUT,
];

export const GET = async (request: Request): Promise<Response> => {
  const denied = validateCronSecret(request, "[cleanup-loop-state]");
  if (denied) {
    return denied;
  }

  const cutoff = new Date(
    Date.now() - LOOP_STATE_RETENTION_DAYS * 24 * 60 * 60 * 1000
  );

  // Terminal loops past the retention horizon whose S3 state was written
  // (s3StateKey set) and not yet purged (s3StateCleanedAt null). Oldest first so
  // a persistently failing loop never starves newer ones out of the batch.
  const loops = await withDb((db) =>
    db.loop.findMany({
      where: {
        status: { in: TERMINAL_STATUSES },
        completedAt: { not: null, lt: cutoff },
        s3StateKey: { not: null },
        s3StateCleanedAt: null,
      },
      select: { id: true, organizationId: true },
      orderBy: { completedAt: "asc" },
      take: SWEEP_BATCH,
    })
  );

  if (loops.length === 0) {
    scheduleLogFlush();
    return new Response("OK: no loop state to purge", { status: 200 });
  }

  let purged = 0;
  let objectsDeleted = 0;
  for (const loop of loops) {
    try {
      objectsDeleted += await deleteLoopState(
        getLoopPrefix(loop.organizationId, loop.id)
      );
      // Stamp only after the delete succeeds; a partial failure throws and the
      // loop is retried (idempotently) on the next run.
      await withDb((db) =>
        db.loop.updateMany({
          where: { id: loop.id, organizationId: loop.organizationId },
          data: { s3StateCleanedAt: new Date() },
        })
      );
      purged++;
    } catch (err) {
      log.warn("[cleanup-loop-state] Failed to purge loop state", {
        loopId: loop.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info("[cleanup-loop-state] Purged loop state", {
    purged,
    objectsDeleted,
    candidates: loops.length,
  });

  scheduleLogFlush();
  return new Response(
    `OK: purged ${purged}/${loops.length} loops (${objectsDeleted} objects)`,
    { status: 200 }
  );
};
