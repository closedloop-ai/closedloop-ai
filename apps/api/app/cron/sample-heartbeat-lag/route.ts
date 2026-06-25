import { LoopStatus, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import {
  emitHeartbeatLag,
  emitZombieDetector,
} from "@/lib/observability/loop-runner-metrics";
import { scheduleLogFlush } from "@/lib/route-utils";

/**
 * Sampling cron for heartbeat lag and zombie detection metrics.
 *
 * Runs periodically (e.g. every minute via Vercel Cron). For each RUNNING loop:
 * - Emits loop.runner.heartbeat.lag (now - lastRunnerHeartbeatAt in ms) when
 *   lastRunnerHeartbeatAt is set.
 * - Counts loops with tokenExpiresAt < now() (potential zombies) and emits
 *   loop.runner.zombie_detector with the total count.
 *
 * Protected by CRON_SECRET bearer token — must be set in environment and
 * passed via `Authorization: Bearer <secret>` header (e.g., Vercel Cron).
 */
export const GET = async (request: Request): Promise<Response> => {
  const denied = validateCronSecret(request, "[sample-heartbeat-lag]");
  if (denied) {
    return denied;
  }

  const now = new Date();

  const runningLoops = await withDb((db) =>
    db.loop.findMany({
      where: {
        status: LoopStatus.RUNNING,
      },
      select: {
        id: true,
        organizationId: true,
        lastRunnerHeartbeatAt: true,
        tokenExpiresAt: true,
      },
    })
  );

  let lagSampleCount = 0;
  let zombieCount = 0;

  for (const loop of runningLoops) {
    if (loop.lastRunnerHeartbeatAt !== null) {
      const lagMs = now.getTime() - loop.lastRunnerHeartbeatAt.getTime();
      emitHeartbeatLag(loop.organizationId, loop.id, lagMs);
      lagSampleCount++;
    }

    if (loop.tokenExpiresAt !== null && loop.tokenExpiresAt < now) {
      zombieCount++;
    }
  }

  emitZombieDetector(zombieCount);

  log.info("[sample-heartbeat-lag] Sampling complete", {
    runningLoopCount: runningLoops.length,
    lagSampleCount,
    zombieCount,
  });

  scheduleLogFlush();
  return new Response(
    `OK: sampled ${lagSampleCount} heartbeat lags, ${zombieCount} zombies`,
    { status: 200 }
  );
};
