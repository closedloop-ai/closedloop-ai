import type { Server as HttpServer } from "node:http";
import type { Revocations } from "@repo/realtime-contract/revocations";
import { deliveryClassRuntimes } from "./classes/registry";
import type { ConnectionAdmitter } from "./edge/admission";
import { attachEdge } from "./edge/connection";
import {
  createRealtimeSocketServer,
  type RealtimeServer,
} from "./edge/socket-server";
import type { RealtimeEnv } from "./env";
import { withDeadline } from "./lifecycle/deadline";
import { createDrain, type Drain, type DrainOptions } from "./lifecycle/drain";
import type { SignalListener } from "./signal/listener";

export type RealtimeServiceConfig = Pick<
  RealtimeEnv,
  "tokenPublicKeys" | "pingTimeoutMs" | "allowedOrigins" | "drainWindowMs"
>;

export type RealtimeServiceDeps = Pick<
  DrainOptions,
  "random" | "flushTelemetry" | "exit"
> & {
  admitter?: ConnectionAdmitter;
  /** The revokes the edge checks a join and a refresh against; the bus records them. */
  revocations: Revocations;
  /** Started once the edge is attached; the listener it returns is stopped on the way out. */
  startSignals?: (io: RealtimeServer) => SignalListener | undefined;
  /** Started beside the listener, and stopped with it (PLN-2105 step 5). */
  startBus?: (io: RealtimeServer) => { stop(): Promise<void> };
};

export type RealtimeService = {
  io: RealtimeServer;
  drain: Drain;
  /**
   * Ends the LISTEN connection and the bus subscription, then flushes
   * telemetry. The drain runs it before exiting; any other exit path runs it
   * itself.
   */
  shutdown: () => Promise<void>;
};

/**
 * The socket server, its drain and the edge, composed as production runs
 * them: the handshake middleware reads the drain the stop triggers start.
 */
export function composeRealtimeService(
  httpServer: HttpServer,
  config: RealtimeServiceConfig,
  deps: RealtimeServiceDeps
): RealtimeService {
  const io = createRealtimeSocketServer(httpServer, {
    pingTimeoutMs: config.pingTimeoutMs,
    allowedOrigins: config.allowedOrigins,
  });
  const {
    admitter,
    revocations,
    startSignals,
    startBus,
    flushTelemetry,
    ...drainDeps
  } = deps;
  let listener: SignalListener | undefined;
  let bus: { stop(): Promise<void> } | undefined;
  const shutdown = async (): Promise<void> => {
    await withDeadline(
      Promise.all([listener?.stop(), bus?.stop()]),
      LISTENER_STOP_TIMEOUT_MS
    ).catch(() => undefined);
    await flushTelemetry();
  };
  const drain = createDrain({
    io,
    windowMs: config.drainWindowMs,
    ...drainDeps,
    flushTelemetry: shutdown,
  });
  attachEdge(io, {
    tokenKeys: { publicKeys: config.tokenPublicKeys },
    isDraining: drain.isDraining,
    admitter,
    revocations,
  });
  for (const runtime of deliveryClassRuntimes()) {
    runtime.start(io);
  }
  listener = startSignals?.(io);
  bus = startBus?.(io);
  return { io, drain, shutdown };
}

/** Within the drain's share of ECS's 30 s stop timeout; see `DEFAULT_DRAIN_WINDOW_MS`. */
export const LISTENER_STOP_TIMEOUT_MS = 2000;
