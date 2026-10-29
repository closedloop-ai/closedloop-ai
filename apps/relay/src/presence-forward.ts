import { isReportableActiveCommands } from "@repo/api/src/types/relay-heartbeat";
import { log } from "@repo/observability/log";
import { redactGatewaySessionId } from "@repo/observability/redact-correlation";
import type { Socket } from "socket.io";
import { forwardSocketEvent } from "./vercel-client.js";
import type { WorkerContext } from "./worker-heartbeat.js";
import {
  pushPendingBuffer,
  socketToTarget,
  workersByTargetId,
} from "./worker-registry.js";

/** The only presence field the cloud reads (`executor_saturation`, ISS-8453). */
const ACTIVE_COMMANDS_FIELD = "activeCommands";

type PresenceAuth = {
  organizationId: string;
  userId: string;
  clerkUserId?: string;
};

/**
 * Caches the desktop's reported occupancy so the relay's own heartbeat can
 * carry it. Only a value the cloud's classifier would ACCEPT is cached: a
 * malformed one is not an occupancy, and replaying it on every heartbeat would
 * turn one bad frame into a standing misreport. `typeof === "number"` alone was
 * not that predicate — it admits negative, fractional, unsafe-magnitude and
 * non-finite values, each of which the classifier then rejects per sample, so
 * `executor_saturation` went absent for that target until the desktop happened
 * to send a valid number or reconnect (ISS-8531 §2).
 *
 * A rejected frame LEAVES the cached value in place rather than clearing it.
 * Occupancy is a level, so the last value the desktop actually reported is
 * still the best evidence the relay holds; clearing would make the heartbeat
 * omit the field, which is the wire shape an older desktop that reports no
 * occupancy at all produces, and the relay has no grounds to claim that.
 */
function rememberReportedOccupancy(
  worker: WorkerContext | undefined,
  payload: unknown
): void {
  if (!worker) {
    return;
  }
  const reported =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)[ACTIVE_COMMANDS_FIELD]
      : undefined;
  if (isReportableActiveCommands(reported)) {
    worker.lastActiveCommands = reported;
  }
}

/**
 * The occupancy the relay's 30s heartbeat reports on the desktop's behalf.
 *
 * Occupancy is a level, not an event: the desktop emits presence per queue
 * mutation, so between mutations the last reported value IS the current one.
 * Omitted rather than defaulted when nothing has been reported — a fabricated
 * `0` would read as a confirmed-idle executor.
 */
export function heartbeatPresencePayload(
  worker: WorkerContext | undefined
): Record<string, unknown> {
  const cached = worker?.lastActiveCommands;
  return cached === undefined ? {} : { [ACTIVE_COMMANDS_FIELD]: cached };
}

/**
 * The presence the relay forwards to the cloud: `activeCommands` alone, never
 * the caller-controlled payload it arrived in. Forwarding the whole Socket.IO
 * frame would make presence a relay-to-API JSON proxy for a field set the API
 * does not read.
 *
 * The picked value is NOT validated here. A malformed one has to reach the
 * API's classifier, which is the only place that can tell a corrupt payload
 * apart from the omission an older desktop sends; screening it out here would
 * silence that signal instead of raising it.
 *
 * A frame that carries NO `activeCommands` falls back to the cache — which is
 * why this takes `worker` at all. A live desktop sends such frames routinely
 * (the hello-ack presence is `{state:"online"}` with no occupancy), and level
 * semantics make the cached value still true: nothing has reported a change.
 * Falling back is also what keeps this path and the heartbeat AGREEING — the
 * heartbeat restates the same cache, so dropping the fallback would make a real
 * presence frame report less than the synthetic probe that follows it.
 */
export function presenceForwardPayload(
  worker: WorkerContext | undefined,
  payload: unknown
): Record<string, unknown> {
  if (
    typeof payload === "object" &&
    payload !== null &&
    ACTIVE_COMMANDS_FIELD in payload
  ) {
    return {
      [ACTIVE_COMMANDS_FIELD]: (payload as Record<string, unknown>)[
        ACTIVE_COMMANDS_FIELD
      ],
    };
  }
  return heartbeatPresencePayload(worker);
}

/** Wires `desktop.presence` for one socket: buffer before hello, else forward. */
export function registerPresenceHandler(
  socket: Socket,
  auth: PresenceAuth
): void {
  socket.on("desktop.presence", async (payload: unknown) => {
    const targetId = socketToTarget.get(socket.id);
    if (!targetId) {
      pushPendingBuffer(socket, "desktop.presence", payload);
      return;
    }

    const worker = workersByTargetId.get(targetId);
    const gatewaySessionId = worker?.gatewaySessionId;
    rememberReportedOccupancy(worker, payload);

    try {
      await forwardSocketEvent(
        "desktop.presence",
        presenceForwardPayload(worker, payload),
        auth,
        targetId,
        gatewaySessionId
      );
    } catch (error) {
      log.error("Failed forwarding presence", {
        socketId: socket.id,
        targetId,
        gatewaySessionIdHash: redactGatewaySessionId(gatewaySessionId),
        error,
      });
    }
  });
}
