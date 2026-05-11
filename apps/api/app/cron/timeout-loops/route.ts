import { timingSafeEqual } from "node:crypto";
import { LoopCommand } from "@repo/api/src/types/loop";
import { LoopStatus, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { loopsService } from "@/app/loops/service";
import { stopLoopTask } from "@/lib/loops/loop-ecs";
import { scrubContextPackSecrets } from "@/lib/loops/loop-state";
import { scheduleLogFlush } from "@/lib/route-utils";

type StuckLoop = {
  id: string;
  organizationId: string;
  status: string;
  containerId: string | null;
  s3StateKey: string | null;
  computeTargetId: string | null;
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
 * but the ECS task may continue running as an orphan. This is acceptable —
 * ECS tasks self-terminate via the harness timeout (24h) and are bounded by
 * ECS task-level stopTimeout configuration.
 */
async function timeoutLoop(loop: StuckLoop, now: Date): Promise<boolean> {
  // Only stop ECS tasks. Desktop loops store a command ID in containerId
  // which must NOT be passed to the ECS stop API. Desktop loops are only
  // marked TIMED_OUT; the desktop client handles its own process cleanup.
  if (loop.containerId && loop.computeTargetId === null) {
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
        status: {
          in: [LoopStatus.PENDING, LoopStatus.CLAIMED, LoopStatus.RUNNING],
        },
      },
      data: {
        status: LoopStatus.TIMED_OUT,
        completedAt: now,
        error: { code: "TIMED_OUT", message: timeoutMessage },
      },
    })
  );

  if (result.count === 0) {
    log.warn(
      "[timeout-loops] timeoutLoop: updateMany returned count 0 -- loop may have already transitioned",
      { loopId: loop.id }
    );
    return false;
  }

  // Best-effort secret cleanup for loops that never emitted "started".
  if (loop.s3StateKey) {
    try {
      await scrubContextPackSecrets(loop.s3StateKey);
    } catch (scrubErr) {
      log.warn("[timeout-loops] Failed to scrub context-pack secrets", {
        loopId: loop.id,
        s3StateKey: loop.s3StateKey,
        error: scrubErr instanceof Error ? scrubErr.message : String(scrubErr),
      });
    }
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
 * Detects and warns about EXECUTE loops that have been running for more than
 * 5 minutes with zero token consumption — a sign that the AI provider
 * accepted the connection but never streamed a response (ghost loop).
 *
 * Applies defense-in-depth guards matching the DB WHERE clause so that test
 * mocks returning out-of-filter records don't produce spurious warnings.
 */
async function warnGhostLoopAnomalies(now: Date): Promise<void> {
  const anomalyCutoff = new Date(now.getTime() - 5 * 60 * 1000);

  const ghostLoops = await withDb((db) =>
    db.loop.findMany({
      where: {
        status: LoopStatus.RUNNING,
        command: LoopCommand.Execute,
        tokensInput: 0,
        tokensOutput: 0,
        startedAt: {
          not: null,
          lt: anomalyCutoff,
        },
      },
      select: {
        id: true,
        organizationId: true,
        computeTargetId: true,
        artifactId: true,
        startedAt: true,
        command: true,
        tokensInput: true,
        tokensOutput: true,
      },
    })
  );

  for (const loop of ghostLoops) {
    if (!loop.startedAt || loop.startedAt >= anomalyCutoff) {
      continue;
    }
    if (loop.command !== LoopCommand.Execute) {
      continue;
    }
    if (loop.tokensInput !== 0 || loop.tokensOutput !== 0) {
      continue;
    }
    log.warn(
      "[timeout-loops] Ghost loop anomaly: EXECUTE loop running >5 min with zero tokens",
      {
        loopId: loop.id,
        computeTargetId: loop.computeTargetId,
        durationMs: now.getTime() - loop.startedAt.getTime(),
        documentId: loop.artifactId,
      }
    );
  }
}

/**
 * Cron safety net for stuck loops.
 *
 * Runs every 5 minutes. Finds loops in non-terminal status that appear stuck
 * and transitions them to TIMED_OUT.
 *
 * Protected by CRON_SECRET bearer token — must be set in environment and
 * passed via `Authorization: Bearer <secret>` header (e.g., Vercel Cron).
 *
 * Detection strategy:
 * - ECS RUNNING: Activity-based — only reap if the loop has had NO events in
 *   the last 75 minutes. The harness reports output events every ~5s, so 75
 *   minutes of silence means the container is dead. Active loops are never
 *   reaped regardless of how long they've been running (6+ hours is normal).
 *   A single recent event = alive, don't touch it.
 * - Desktop RUNNING: Age-based — created > 24h ago.
 * - Manual RUNNING: 7-day inactivity — created > 7 days ago AND no events in
 *   7 days. Manual loops are long-lived user-initiated loops with no automated
 *   heartbeat; they stay alive as long as events keep flowing.
 * - CLAIMED: createdAt > 90 minutes ago (container never reported "started")
 * - PENDING: createdAt > 30 minutes ago (never picked up by a container)
 */
export const GET = async (request: Request): Promise<Response> => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("[timeout-loops] CRON_SECRET is not configured");
    scheduleLogFlush();
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

  // RUNNING ECS loops: activity-based detection.
  // The harness reports output events every ~5s. If a RUNNING loop has had
  // zero events in the last 75 minutes, the container is dead. One single
  // recent event = alive, don't touch it. No age cutoff needed -- a loop
  // running for 6+ hours with active events is healthy and should never
  // be reaped.
  const activityCutoff = new Date(now.getTime() - 75 * 60 * 1000);

  // RUNNING desktop loops: use createdAt-based detection (24h).
  // Desktop loops don't write to the LoopEvent table -- their progress
  // events flow through the desktop command channel -- so the activity-based
  // "events.none" check would always match. Use a generous 24h age cutoff.
  const desktopRunningCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // RUNNING manual loops: 7-day inactivity window.
  // Manual loops are long-lived user-initiated loops (via MCP/Claude Code)
  // with no automated heartbeat. They stay alive as long as events flow.
  const manualRunningCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // 90 minutes for CLAIMED loops (container may have never reported started)
  const claimedCutoff = new Date(now.getTime() - 90 * 60 * 1000);
  // 30 minutes for PENDING loops (should have been claimed quickly)
  const pendingCutoff = new Date(now.getTime() - 30 * 60 * 1000);

  // Find stuck loops across all categories.
  // ECS RUNNING: activity-based (no events in 75 min = dead container).
  // Manual RUNNING: inactivity-based (no events in 7 days).
  // Desktop RUNNING: age-based (created > 24h ago).
  // CLAIMED/PENDING: both ECS and desktop are reaped at standard thresholds.
  const stuckLoops = await withDb((db) =>
    db.loop.findMany({
      where: {
        OR: [
          // ECS RUNNING: no events in 75 min (excludes manual loops)
          {
            status: LoopStatus.RUNNING,
            computeTargetId: null,
            command: { not: LoopCommand.Manual },
            events: {
              none: {
                createdAt: { gte: activityCutoff },
              },
            },
          },
          // Manual RUNNING: no events in 7 days
          {
            status: LoopStatus.RUNNING,
            command: LoopCommand.Manual,
            createdAt: { lt: manualRunningCutoff },
            events: {
              none: {
                createdAt: { gte: manualRunningCutoff },
              },
            },
          },
          // Desktop RUNNING: created > 24h ago
          {
            status: LoopStatus.RUNNING,
            computeTargetId: { not: null },
            createdAt: { lt: desktopRunningCutoff },
          },
          // CLAIMED: both ECS and desktop
          {
            status: LoopStatus.CLAIMED,
            createdAt: { lt: claimedCutoff },
          },
          // PENDING: both ECS and desktop
          {
            status: LoopStatus.PENDING,
            createdAt: { lt: pendingCutoff },
          },
        ],
      },
      select: {
        id: true,
        organizationId: true,
        status: true,
        containerId: true,
        s3StateKey: true,
        computeTargetId: true,
      },
    })
  );

  if (process.env.ENABLE_GHOST_LOOP_ANOMALY_WARNING === "true") {
    try {
      await warnGhostLoopAnomalies(now);
    } catch (e) {
      log.error("[timeout-loops] Ghost loop anomaly check failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (stuckLoops.length === 0) {
    scheduleLogFlush();
    return new Response("OK: no stuck loops", { status: 200 });
  }

  log.info("[timeout-loops] Found stuck loops", {
    count: stuckLoops.length,
    ids: stuckLoops.map((l) => l.id),
    statuses: stuckLoops.map((l) => l.status),
  });

  let timedOutCount = 0;
  for (const loop of stuckLoops) {
    if (await timeoutLoop(loop, now)) {
      timedOutCount++;
    }
  }

  scheduleLogFlush();
  return new Response(`OK: timed out ${timedOutCount} loops`, { status: 200 });
};
