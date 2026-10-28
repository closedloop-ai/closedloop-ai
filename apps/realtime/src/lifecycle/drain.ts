import { log } from "@repo/observability/log";
import {
  type DrainPayload,
  RealtimeEvent,
} from "@repo/realtime-contract/protocol";
import type { RealtimeServer, RealtimeSocket } from "../edge/socket-server";

export const DrainTrigger = {
  /** The ECS API reports the task's `desiredStatus` as STOPPED. */
  TaskStopping: "task_stopping",
  Sigterm: "sigterm",
} as const;
export type DrainTrigger = (typeof DrainTrigger)[keyof typeof DrainTrigger];

export type DrainOptions = {
  io: RealtimeServer;
  /** `DRAIN_WINDOW_MS`: shorter than the load balancer's deregistration delay. */
  windowMs: number;
  /** Uniform in [0, 1). */
  random: () => number;
  flushTelemetry: () => Promise<void>;
  exit: (code: number) => void;
};

export type Drain = {
  isDraining(): boolean;
  /**
   * Idempotent: a second trigger joins the drain already running. SIGTERM
   * also lets the process exit, once the drain has finished.
   */
  start(trigger: DrainTrigger): void;
};

/**
 * PLN-2104 step 9. Once started, the handshake middleware refuses new
 * connections (it reads `isDraining`), every connected socket gets
 * `rt:drain { afterMs }` spread uniformly over the window past a floor, so
 * reconnects do not land at once, and whatever is still connected when the
 * window closes is disconnected. The drain ends early when the last socket
 * leaves.
 *
 * The process exits, after telemetry flushes, only once the drain has finished
 * and SIGTERM has arrived. A `task_stopping` drain starts before ECS
 * deregisters the target, and ECS sends SIGTERM only after deregistration
 * (ISS-12194), so until then the server stays up and refuses handshakes rather
 * than leave the load balancer routing them to a closed port.
 */
export function createDrain(options: DrainOptions): Drain {
  const { io, windowMs } = options;
  let draining = false;
  let finished = false;
  let sigterm = false;
  let windowTimer: ReturnType<typeof setTimeout> | undefined;

  const exit = () => {
    // `close()` drops each straggler's transport, which its client reads as
    // a transport close and reconnects from. `disconnectSockets` would send
    // a server disconnect, after which a socket.io client never reconnects.
    io.close();
    options.flushTelemetry().finally(() => options.exit(0));
  };

  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    clearTimeout(windowTimer);
    const stragglers = [...liveSockets(io).values()];
    log.info("Realtime drain finished", {
      event: DRAIN_FINISHED_EVENT,
      stragglers: stragglers.length,
    });
    if (sigterm) {
      exit();
      return;
    }
    // The same transport close `close()` gives each client, without closing
    // the server.
    for (const socket of stragglers) {
      socket.conn.close(true);
    }
  };

  const hint = (socket: RealtimeSocket) => {
    const payload: DrainPayload = {
      afterMs: drainDelayMs(options.random, windowMs),
    };
    socket.emit(RealtimeEvent.Drain, payload);
    socket.once("disconnect", () => {
      if (liveSockets(io).size === 0) {
        finish();
      }
    });
  };

  return {
    isDraining: () => draining,
    start(trigger) {
      if (trigger === DrainTrigger.Sigterm && !sigterm) {
        sigterm = true;
        if (finished) {
          exit();
          return;
        }
      }
      if (draining) {
        return;
      }
      draining = true;
      const sockets = [...liveSockets(io).values()];
      log.info("Realtime drain started", {
        event: DRAIN_STARTED_EVENT,
        trigger,
        windowMs,
        connections: sockets.length,
      });
      // A handshake that passed the middleware's draining check before this
      // call is still verifying its token, and connects after the snapshot.
      // Once the drain has finished it gets no window, so it is dropped like
      // a straggler.
      io.on("connection", (socket) => {
        if (finished) {
          socket.conn.close(true);
          return;
        }
        hint(socket);
      });
      for (const socket of sockets) {
        hint(socket);
      }
      if (sockets.length === 0) {
        finish();
        return;
      }
      windowTimer = setTimeout(finish, windowMs);
    },
  };
}

/**
 * Uniform over [floor, window). The floor is {@link MIN_DRAIN_AFTER_MS}, or
 * half the window when the window is not longer than that.
 */
function drainDelayMs(random: () => number, windowMs: number): number {
  const floorMs =
    MIN_DRAIN_AFTER_MS < windowMs ? MIN_DRAIN_AFTER_MS : windowMs / 2;
  return Math.floor(floorMs + random() * (windowMs - floorMs));
}

/**
 * Operator decision 2026-09-30 (PR #8191): no client is told to reconnect
 * while the load balancer still routes to this task, or it may land back here
 * and be refused. A `task_stopping` drain starts no earlier than ECS marks the
 * task STOPPED, and on stage ECS deregistered the target 9-11 s after that
 * (ISS-12194), so the floor is 11 s.
 */
export const MIN_DRAIN_AFTER_MS = 11_000;

function liveSockets(io: RealtimeServer) {
  return io.of("/").sockets;
}

export const DRAIN_STARTED_EVENT = "realtime.drain_started";
export const DRAIN_FINISHED_EVENT = "realtime.drain_finished";
