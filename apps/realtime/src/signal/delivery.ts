import { log } from "@repo/observability/log";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import { Origin } from "@repo/observability/telemetry/origin";
import type { RealtimeServer } from "../edge/socket-server";
import { Dependency, type Readiness } from "../lifecycle/readiness";
import { RealtimeCount } from "../telemetry/gauges";
import { ResyncCause, recordResync } from "../telemetry/spans";
import { createSignalFanOut } from "./fanout";
import type { ListenOnlyClient } from "./listen-only-client";
import { type SignalListener, startSignalListener } from "./listener";
import type { ListenerConnectionConfig } from "./listener-config";
import { listenerClientFactory } from "./pg-connection";
import { resyncAll } from "./runtime";

/**
 * Joins the listener to the socket server: notifications fan out, the
 * listener is a readiness dependency (PLN-2104 step 8), and a listener that
 * comes back after a loss resyncs every served channel (PLN-2105 step 1).
 */
export function startSignalDelivery(
  io: RealtimeServer,
  readiness: Readiness,
  openClient: () => ListenOnlyClient,
  random?: () => number
): SignalListener {
  return startSignalListener({
    openClient,
    onSignal: createSignalFanOut(io),
    onListening: (resumed) => {
      readiness.markUp(Dependency.Listener);
      if (resumed) {
        const sockets = resyncAll(io);
        recordResync(ResyncCause.ListenResumed, sockets);
        emitTelemetryMetric({
          metric: RealtimeCount.Resyncs,
          origin: Origin.Realtime,
          value: sockets,
          cause: ResyncCause.ListenResumed,
        });
      }
    },
    onLost: (cause) => readiness.markDown(Dependency.Listener, cause),
    random,
  });
}

/**
 * Starts delivery on the configured LISTEN connection. With none configured
 * the instance serves but never becomes ready, and logs that it will not.
 */
export function startConfiguredSignalDelivery(
  io: RealtimeServer,
  readiness: Readiness,
  config: ListenerConnectionConfig | undefined
): SignalListener | undefined {
  if (config) {
    return startSignalDelivery(io, readiness, listenerClientFactory(config));
  }
  log.error("Realtime LISTEN connection is not configured; never ready", {
    event: LISTENER_UNCONFIGURED_EVENT,
  });
  return undefined;
}

/** No REALTIME_PG_* key is set: the instance serves but never becomes ready. */
export const LISTENER_UNCONFIGURED_EVENT = "realtime.listener_unconfigured";
