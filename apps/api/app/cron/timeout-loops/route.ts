import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { stopLoopTask } from "@/lib/loop-orchestrator";

/**
 * Cron safety net for stuck loops (Layer 2 of timeout enforcement).
 *
 * Runs every 5 minutes. Finds loops in non-terminal status that have exceeded
 * their maximum allowed age and transitions them to TIMED_OUT.
 *
 * Thresholds:
 * - RUNNING + startedAt > 70 minutes ago (55m harness timeout + 15m buffer)
 * - CLAIMED + createdAt > 90 minutes ago
 * - PENDING + createdAt > 30 minutes ago
 */
export const GET = async () => {
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
          { status: "RUNNING", startedAt: { lt: runningCutoff } },
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
    // Best-effort: stop the ECS task if it has a container ID
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

    // Atomic transition to TIMED_OUT (only from non-terminal statuses)
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
          error: {
            code: "TIMED_OUT",
            message: `Loop timed out in ${loop.status} status (cron safety net)`,
          },
        },
      })
    );

    if (result.count > 0) {
      timedOutCount++;
      log.info("[timeout-loops] Timed out stuck loop", {
        loopId: loop.id,
        previousStatus: loop.status,
      });
    }
  }

  return new Response(`OK: timed out ${timedOutCount} loops`, { status: 200 });
};
