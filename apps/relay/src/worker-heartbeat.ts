import { log } from "@repo/observability/log";
import { redactGatewaySessionId } from "@repo/observability/redact-correlation";
import {
  ConnectionState,
  emitProtocolMetric,
} from "@repo/observability/telemetry/metrics";
import { ORIGIN } from "@repo/observability/telemetry/origin";
import { TelemetryCategory } from "@repo/observability/telemetry/schema";
import type { Socket } from "socket.io";
import { healMissingRegistryEntry } from "./registry-ownership.js";
import type { TargetMetadata, TargetRegistry } from "./target-registry.js";

/** Everything this relay instance tracks about one live desktop worker. */
type WorkerContext = {
  socket: Socket;
  targetId: string;
  organizationId: string;
  userId: string;
  clerkUserId?: string;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  degradedTimer: ReturnType<typeof setTimeout> | null;
  wasDegraded: boolean;
  gatewaySessionId?: string;
  pluginVersion?: string;
  ownerToken?: string;
  /** What hello registered, kept so the heartbeat can re-create a lost entry. */
  registryMetadata?: TargetMetadata;
};

type StartWorkerHeartbeatOptions = {
  workerContext: WorkerContext;
  targetId: string;
  gatewaySessionId?: string;
  registry: TargetRegistry;
  /** Timestamp of the most recent successful ack, per target. */
  lastHeartbeatAckAt: Map<string, number>;
  intervalMs: number;
  degradedThresholdMs: number;
  /** Sends the `desktop.presence` probe for this worker. */
  sendPresence: () => Promise<unknown>;
  /**
   * Synchronous check that this worker is still the live, connected owner of
   * `targetId` on this instance. Guards the registry self-heal against a
   * disconnect or takeover that lands mid-flight.
   */
  isStillCurrentWorker: () => boolean;
  emitConnectionState: (
    state: ConnectionState,
    targetId: string,
    gatewaySessionId: string | null | undefined
  ) => void;
};

function onHeartbeatAck(
  options: StartWorkerHeartbeatOptions,
  now: number
): void {
  const {
    workerContext,
    targetId,
    gatewaySessionId,
    registry,
    lastHeartbeatAckAt,
    isStillCurrentWorker,
    emitConnectionState,
  } = options;

  const prev = lastHeartbeatAckAt.get(targetId);
  lastHeartbeatAckAt.set(targetId, now);

  if (workerContext.ownerToken) {
    const meta = workerContext.registryMetadata;
    registry
      .refreshTtl(targetId, workerContext.ownerToken)
      .then((refreshed) => {
        if (refreshed || !meta) {
          return;
        }
        return healMissingRegistryEntry({
          registry,
          targetId,
          metadata: meta,
          gatewaySessionId,
          isStillCurrentWorker,
        });
      })
      .catch(() => {});
  }

  // heartbeat_freshness = elapsed ms since previous successful ack.
  // Only emit once we have a previous ack to compare against.
  if (prev !== undefined) {
    emitProtocolMetric({
      metric: "heartbeat_freshness",
      origin: ORIGIN,
      value: now - prev,
      computeTargetId: targetId,
      gatewaySessionId: gatewaySessionId ?? undefined,
      timestamp: new Date(now).toISOString(),
    });
  }

  // Cancel any pending degraded timer on success
  if (workerContext.degradedTimer !== null) {
    clearTimeout(workerContext.degradedTimer);
    workerContext.degradedTimer = null;
  }

  // Emit recovery if connection was previously degraded
  if (workerContext.wasDegraded) {
    emitConnectionState(ConnectionState.Online, targetId, gatewaySessionId);
    workerContext.wasDegraded = false;
  }
}

function onHeartbeatFailure(
  options: StartWorkerHeartbeatOptions,
  error: unknown,
  heartbeatFreshness: number,
  readFreshness: () => number
): void {
  const {
    workerContext,
    targetId,
    gatewaySessionId,
    degradedThresholdMs,
    emitConnectionState,
  } = options;

  log.error("Heartbeat failed", {
    targetId,
    gatewaySessionIdHash: redactGatewaySessionId(gatewaySessionId),
    error,
  });
  log.warn("Connection stale heartbeat", {
    category: TelemetryCategory.ConnectionStaleHeartbeat,
    computeTargetId: targetId,
    gatewaySessionIdHash: redactGatewaySessionId(gatewaySessionId),
    heartbeatFreshness,
  });

  // Schedule a degraded event if not already pending
  workerContext.degradedTimer ??= setTimeout(() => {
    workerContext.degradedTimer = null;
    log.warn("Connection degraded", {
      category: TelemetryCategory.ConnectionDegraded,
      computeTargetId: targetId,
      gatewaySessionIdHash: redactGatewaySessionId(gatewaySessionId),
      heartbeatFreshness: readFreshness(),
    });
    emitConnectionState(ConnectionState.Degraded, targetId, gatewaySessionId);
    workerContext.wasDegraded = true;
  }, degradedThresholdMs);
}

/**
 * Drive connection liveness for one worker: probe the desktop on an interval,
 * keep its registry entry alive (healing a lost one), publish freshness
 * metrics, and run the degraded/recovery state machine.
 *
 * Returns the interval handle; the caller owns clearing it on disposal.
 */
export function startWorkerHeartbeat(
  options: StartWorkerHeartbeatOptions
): ReturnType<typeof setInterval> {
  let lastHeartbeatSuccess = Date.now();

  return setInterval(() => {
    const heartbeatSentAt = Date.now();
    options
      .sendPresence()
      .then(() => {
        const now = Date.now();
        lastHeartbeatSuccess = now;
        onHeartbeatAck(options, now);
      })
      .catch((error) => {
        onHeartbeatFailure(
          options,
          error,
          heartbeatSentAt - lastHeartbeatSuccess,
          () => Date.now() - lastHeartbeatSuccess
        );
      });
  }, options.intervalMs);
}

export type { WorkerContext };
