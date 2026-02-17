import { timingSafeEqual } from "node:crypto";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { loopsService } from "@/app/loops/service";
import { stopLoopTask } from "@/lib/loop-orchestrator";

type StuckLoop = {
  id: string;
  organizationId: string;
  status: string;
  containerId: string | null;
};

/**
 * Attempt to time out a single stuck loop:
 * 1. Best-effort stop the ECS task
 * 2. Atomic transition to TIMED_OUT
 * 3. Record an audit event
 *
 * Returns true if the loop was actually timed out.
 *
 * NOTE: If stopLoopTask fails, the loop is still marked TIMED_OUT in the DB
 * but the ECS task may continue running as an orphan. This is acceptable for
 * V1 — ECS tasks self-terminate via the harness 55-minute timeout, and orphaned
 * tasks are bounded by ECS task-level stopTimeout configuration.
 */
async function timeoutLoop(loop: StuckLoop, now: Date): Promise<boolean> {
  if (loop.containerId) {
    try {
      await stopLoopTask(loop.containerId, "Cron timeout safety net");
    } catch (err) {
      log.warn("[timeout-loops] Failed to stop ECS task", {
        loopId: loop.id,
        containerId: loop.containerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const timeoutMessage = `Loop timed out in ${loop.status} status (cron safety net)`;

  const result = await withDb((db) =>
    db.loop.updateMany({
      where: {
        id: loop.id,
        organizationId: loop.organizationId,
        status: { in: ["PENDING", "CLAIMED", "RUNNING"] },
      },
      data: {
        status: "TIMED_OUT",
        completedAt: now,
        error: { code: "TIMED_OUT", message: timeoutMessage },
      },
    })
  );

  if (result.count === 0) {
    return false;
  }

  // Record an audit event so the timeout appears in the loop's event timeline
  try {
    await loopsService.addEvent(loop.id, loop.organizationId, {
      type: "error",
      data: {
        code: "TIMED_OUT",
        message: timeoutMessage,
        timestamp: now.toISOString(),
      },
    });
  } catch (eventErr) {
    log.warn("[timeout-loops] Failed to record timeout event", {
      loopId: loop.id,
      error: eventErr instanceof Error ? eventErr.message : String(eventErr),
    });
  }

  log.info("[timeout-loops] Timed out stuck loop", {
    loopId: loop.id,
    previousStatus: loop.status,
  });

  return true;
}

/**
 * Cron safety net for stuck loops (Layer 2 of timeout enforcement).
 *
 * Runs every 5 minutes. Finds loops in non-terminal status that have exceeded
 * their maximum allowed age and transitions them to TIMED_OUT.
 *
 * Protected by CRON_SECRET bearer token — must be set in environment and
 * passed via `Authorization: Bearer <secret>` header (e.g., Vercel Cron).
 *
 * Thresholds:
 * - RUNNING + startedAt > 70 minutes ago (55m harness timeout + 15m buffer)
 * - CLAIMED + createdAt > 90 minutes ago
 * - PENDING + createdAt > 30 minutes ago
 */
export const GET = async (request: Request) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("[timeout-loops] CRON_SECRET is not configured");
    return new Response("Internal Server Error", { status: 500 });
  }

  const authHeader = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${cronSecret}`;
  const isValid =
    authHeader.length === expected.length &&
    timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected));
  if (!isValid) {
    return new Response("Unauthorized", { status: 401 });
  }

  const now = new Date();

  // 70 minutes for RUNNING loops (55m harness timeout + 15m cleanup buffer)
  const runningCutoff = new Date(now.getTime() - 70 * 60 * 1000);
  // 90 minutes for CLAIMED loops (container may have never reported started)
  const claimedCutoff = new Date(now.getTime() - 90 * 60 * 1000);
  // 30 minutes for PENDING loops (should have been claimed quickly)
  const pendingCutoff = new Date(now.getTime() - 30 * 60 * 1000);

  // Find stuck loops across all three categories
  const stuckLoops = await withDb((db) =>
    db.loop.findMany({
      where: {
        OR: [
          {
            status: "RUNNING",
            OR: [
              { startedAt: { lt: runningCutoff } },
              { startedAt: null, createdAt: { lt: runningCutoff } },
            ],
          },
          { status: "CLAIMED", createdAt: { lt: claimedCutoff } },
          { status: "PENDING", createdAt: { lt: pendingCutoff } },
        ],
      },
      select: {
        id: true,
        organizationId: true,
        status: true,
        containerId: true,
      },
    })
  );

  if (stuckLoops.length === 0) {
    return new Response("OK: no stuck loops", { status: 200 });
  }

  log.info("[timeout-loops] Found stuck loops", {
    count: stuckLoops.length,
    ids: stuckLoops.map((l) => l.id),
  });

  let timedOutCount = 0;
  for (const loop of stuckLoops) {
    const didTimeout = await timeoutLoop(loop, now);
    if (didTimeout) {
      timedOutCount++;
    }
  }

  return new Response(`OK: timed out ${timedOutCount} loops`, { status: 200 });
};
