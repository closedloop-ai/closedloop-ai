import { log } from "@repo/observability/log";
import type { Socket } from "socket.io";
import type { WorkerContext } from "./worker-heartbeat.js";

const MAX_PENDING_BUFFER_SIZE = 100;

export const workersByTargetId = new Map<string, WorkerContext>();
export const socketToTarget = new Map<string, string>();

// Clean up if this socket was previously registered for a different target
export function cleanupOldWorker(
  socket: Socket,
  newTargetId: string,
  lastHeartbeatAckAt: Map<string, number>
): void {
  const oldTargetId = socketToTarget.get(socket.id);
  if (!oldTargetId || oldTargetId === newTargetId) {
    return;
  }

  const oldWorker = workersByTargetId.get(oldTargetId);
  if (oldWorker?.socket.id !== socket.id) {
    return;
  }

  disposeWorkerTimers(oldWorker);
  workersByTargetId.delete(oldTargetId);
  lastHeartbeatAckAt.delete(oldTargetId);
}

export function pushPendingBuffer(
  socket: Socket,
  event: string,
  ...args: unknown[]
): void {
  if (socket.data.pendingBuffer.length >= MAX_PENDING_BUFFER_SIZE) {
    log.warn("Pending buffer full, dropping event", {
      socketId: socket.id,
      event,
    });
    return;
  }
  socket.data.pendingBuffer.push({ event, args });
}

/** Discards events buffered by a socket whose hello never registered it. */
export function drainPendingBuffer(socket: Socket): void {
  socket.data.pendingBuffer = [];
}

/**
 * Releases the timers a `WorkerContext` owns. `startWorkerHeartbeat` states that
 * the caller owns clearing its interval, and there are four places a context
 * stops being the live one — the two takeover cleanups, the same-socket
 * re-registration `registerWorker` performs (ISS-8531), and disconnect. Spelled
 * once so a fifth cannot be added with only half the disposal, which is the
 * shape the leak had: the interval keeps issuing real presence forwards long
 * after its socket is gone, and only the ack handling is suppressed.
 *
 * Timers ONLY — deliberately no metric and no map write. `cleanupExistingWorker`
 * emits `Disconnected` and `reconnect_frequency` for the different-socket
 * takeover; emitting from here would make a same-target re-hello report a
 * spurious disconnect/reconnect pair that operators read as churn.
 */
export function disposeWorkerTimers(worker: WorkerContext | undefined): void {
  if (!worker) {
    return;
  }
  if (worker.heartbeatTimer !== null) {
    clearInterval(worker.heartbeatTimer);
  }
  if (worker.degradedTimer !== null) {
    clearTimeout(worker.degradedTimer);
  }
}
