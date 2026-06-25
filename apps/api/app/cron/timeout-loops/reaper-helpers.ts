import { LoopStatus, type Prisma } from "@repo/database";
import { z } from "zod";
import { ReapReason } from "@/lib/observability/loop-runner-metrics";

// Heartbeat-based staleness threshold for Desktop loops that advertise
// loopRunnerHeartbeatSupported. A loop is considered stale when its last
// heartbeat (or startedAt for NULL-heartbeat loops) is older than this.
// Architecture decision: module constant (not env var) per plan.json GAP-002.
export const HEARTBEAT_STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

// Validates the shape of loop.runnerCapabilities (Prisma.JsonValue) before
// reading capability flags. JsonValue admits primitives, so a bare `as` cast
// would silently treat `42` or `"x"` as a record and yield `undefined` for
// every flag read. safeParse failure routes the loop to the legacy branch.
const RunnerCapabilitiesSchema = z.record(z.string(), z.unknown()).nullable();

export type StuckLoop = {
  id: string;
  organizationId: string;
  status: string;
  containerId: string | null;
  s3StateKey: string | null;
  computeTargetId: string | null;
  lastRunnerHeartbeatAt: Date | null;
  runnerCapabilities: Prisma.JsonValue | null;
  tokenExpiresAt: Date | null;
  startedAt: Date | null;
};

/**
 * Optional reaper context for Desktop loops that are timed out via
 * heartbeat-staleness or legacy-24h detection. Carried on the LoopEvent
 * audit trail (data.reaper) and used to emit the reap.transition metric.
 */
export type ReaperContext = {
  reason: ReapReason;
  lastHeartbeatAt: Date | null;
  tokenExpiresAt: Date | null;
  eligibilityBranch: "desktop_heartbeat" | "desktop_legacy";
};

/**
 * Determine the reaper context for a Desktop RUNNING loop. Returns undefined
 * for non-Desktop loops (ECS, Manual, CLAIMED, PENDING) — those do not carry
 * reaper metadata.
 */
export function classifyDesktopReaperContext(
  loop: StuckLoop,
  heartbeatStaleCutoff: Date
): ReaperContext | undefined {
  if (loop.computeTargetId === null || loop.status !== LoopStatus.RUNNING) {
    return undefined;
  }

  const parsedCapabilities = RunnerCapabilitiesSchema.safeParse(
    loop.runnerCapabilities
  );
  const capabilities = parsedCapabilities.success
    ? parsedCapabilities.data
    : null;

  // Mirror the DB OR[2] clause: a capability-flagged loop is only
  // heartbeat-eligible at runtime if startedAt is set AND already older than
  // the stale cutoff. Otherwise the loop must fall through to the legacy
  // branch (OR[3]) so its reaper telemetry is attributed correctly.
  const heartbeatSupported =
    loop.lastRunnerHeartbeatAt !== null ||
    (capabilities?.loopRunnerHeartbeatSupported === true &&
      loop.startedAt !== null &&
      loop.startedAt < heartbeatStaleCutoff);

  if (heartbeatSupported) {
    const reason =
      loop.lastRunnerHeartbeatAt !== null &&
      loop.lastRunnerHeartbeatAt < heartbeatStaleCutoff
        ? ReapReason.DesktopHeartbeatStale
        : ReapReason.DesktopNoHeartbeat;

    return {
      reason,
      lastHeartbeatAt: loop.lastRunnerHeartbeatAt,
      tokenExpiresAt: loop.tokenExpiresAt,
      eligibilityBranch: "desktop_heartbeat",
    };
  }

  return {
    reason: ReapReason.DesktopLegacy24h,
    lastHeartbeatAt: null,
    tokenExpiresAt: loop.tokenExpiresAt,
    eligibilityBranch: "desktop_legacy",
  };
}

/**
 * Build the data payload for the timeout audit LoopEvent. When reaper context
 * is provided, includes a `reaper` sub-object with reason, timestamps, and
 * eligibility branch.
 */
export function buildTimeoutEventData(
  message: string,
  now: Date,
  reaper?: ReaperContext
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    code: "TIMED_OUT",
    message,
    timestamp: now.toISOString(),
  };
  if (reaper) {
    data.reaper = {
      reason: reaper.reason,
      lastHeartbeatAt: reaper.lastHeartbeatAt?.toISOString() ?? null,
      tokenExpiresAt: reaper.tokenExpiresAt?.toISOString() ?? null,
      eligibilityBranch: reaper.eligibilityBranch,
    };
  }
  return data;
}
