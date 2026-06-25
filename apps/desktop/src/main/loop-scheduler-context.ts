import { gatewayLog } from "./gateway-logger.js";
import {
  getHeartbeatIntervalMs,
  type HeartbeatDeps,
  runHeartbeatTick,
} from "./loop-heartbeat.js";
import type { LoopSchedulerDeps } from "./loop-lifecycle.js";
import { getRefreshSkewMs, runRefreshTick } from "./loop-refresh-scheduler.js";
import * as loopSleepRecovery from "./loop-sleep-recovery.js";

// ---------------------------------------------------------------------------
// LoopSchedulerContext
//
// An instance-scoped container that owns all per-loop timer handles (heartbeat
// intervals, refresh timeouts) and sleep-recovery registrations. Because state
// lives in instance Maps rather than module-level Maps, every service that
// constructs a LoopSchedulerContext gets a fully isolated timer namespace.
//
// Implements Symbol.dispose so a `using ctx = new LoopSchedulerContext()`
// declaration guarantees cleanup at scope exit — even on exceptions — without
// any explicit teardown call at the test or call-site level.
// ---------------------------------------------------------------------------

export class LoopSchedulerContext {
  private readonly heartbeats = new Map<string, NodeJS.Timeout>();
  private readonly refreshes = new Map<string, NodeJS.Timeout>();
  private readonly sleepLoopIds = new Set<string>();

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  startHeartbeat(loopId: string, deps: HeartbeatDeps): void {
    this.stopHeartbeat(loopId);
    const interval = getHeartbeatIntervalMs();
    gatewayLog.info(
      "loop-scheduler-context",
      `Starting heartbeat for loopId=${loopId} (interval=${interval}ms)`
    );
    const handle = setInterval(() => {
      void runHeartbeatTick(loopId, deps, () => this.stopHeartbeat(loopId));
    }, interval);
    // Belt-and-suspenders: explicit disposal via Symbol.dispose remains the
    // contract, but unref ensures a forgotten dispose never pins Node's event
    // loop past the work that was actually scheduled.
    handle.unref?.();
    this.heartbeats.set(loopId, handle);
  }

  stopHeartbeat(loopId: string): void {
    const handle = this.heartbeats.get(loopId);
    if (handle === undefined) {
      return;
    }
    clearInterval(handle);
    this.heartbeats.delete(loopId);
    gatewayLog.info(
      "loop-scheduler-context",
      `Stopped heartbeat for loopId=${loopId}`
    );
  }

  // -------------------------------------------------------------------------
  // Refresh scheduler
  // -------------------------------------------------------------------------

  startRefresh(
    loopId: string,
    expiresAt: number | undefined,
    deps: LoopSchedulerDeps
  ): void {
    if (expiresAt === undefined) {
      gatewayLog.info(
        "loop-scheduler-context",
        `Skipping proactive refresh for loopId=${loopId}: expiresAt unknown`
      );
      return;
    }
    this.stopRefresh(loopId);
    this.scheduleRefreshTick(loopId, expiresAt, deps);
  }

  private scheduleRefreshTick(
    loopId: string,
    expiresAt: number,
    deps: LoopSchedulerDeps
  ): void {
    const delay = Math.max(expiresAt - getRefreshSkewMs() - Date.now(), 0);
    gatewayLog.info(
      "loop-scheduler-context",
      `Scheduling proactive refresh for loopId=${loopId} in ${delay}ms`
    );
    const handle = setTimeout(() => {
      void runRefreshTick(loopId, deps, (newExpiresAt) => {
        if (this.refreshes.has(loopId)) {
          this.scheduleRefreshTick(loopId, newExpiresAt, deps);
        }
      }).finally(() => {
        this.refreshes.delete(loopId);
      });
    }, delay);
    // See note in startHeartbeat: unref so a pending refresh timer never pins
    // the event loop past explicit disposal.
    handle.unref?.();
    this.refreshes.set(loopId, handle);
  }

  stopRefresh(loopId: string): void {
    const handle = this.refreshes.get(loopId);
    if (handle === undefined) {
      return;
    }
    clearTimeout(handle);
    this.refreshes.delete(loopId);
    gatewayLog.info(
      "loop-scheduler-context",
      `Stopped refresh scheduler for loopId=${loopId}`
    );
  }

  // -------------------------------------------------------------------------
  // Sleep/wake recovery
  // -------------------------------------------------------------------------

  registerSleep(loopId: string, deps: LoopSchedulerDeps): void {
    loopSleepRecovery.registerLoop(loopId, deps);
    this.sleepLoopIds.add(loopId);
  }

  unregisterSleep(loopId: string): void {
    loopSleepRecovery.unregisterLoop(loopId);
    this.sleepLoopIds.delete(loopId);
  }

  // -------------------------------------------------------------------------
  // Coordinated teardown for a single loop
  // -------------------------------------------------------------------------

  teardownLoop(loopId: string): void {
    this.stopHeartbeat(loopId);
    this.stopRefresh(loopId);
    this.unregisterSleep(loopId);
  }

  // -------------------------------------------------------------------------
  // Full disposal — clears every timer and registration owned by this context.
  // Called automatically when declared with `using ctx = new LoopSchedulerContext()`.
  // -------------------------------------------------------------------------

  [Symbol.dispose](): void {
    for (const handle of this.heartbeats.values()) {
      clearInterval(handle);
    }
    this.heartbeats.clear();

    for (const handle of this.refreshes.values()) {
      clearTimeout(handle);
    }
    this.refreshes.clear();

    for (const loopId of this.sleepLoopIds) {
      loopSleepRecovery.unregisterLoop(loopId);
    }
    this.sleepLoopIds.clear();

    gatewayLog.info(
      "loop-scheduler-context",
      "LoopSchedulerContext disposed — all timers and sleep registrations cleared"
    );
  }
}
