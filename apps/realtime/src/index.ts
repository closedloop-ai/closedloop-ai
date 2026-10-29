import { randomUUID } from "node:crypto";
import { log } from "@repo/observability/log";
import { loadRealtimeEnvOrExit } from "./env";
import { createRealtimeInstance } from "./instance";
import { DrainTrigger } from "./lifecycle/drain";
import { watchTaskStopping } from "./lifecycle/task-metadata";
import { startGaugeReporter } from "./telemetry/gauges";
import {
  flushTelemetry,
  initRealtimeTracing,
  requireTelemetryExportOrExit,
} from "./telemetry/tracing";

const env = await loadRealtimeEnvOrExit(process.env);

if (env && (await requireTelemetryExportOrExit(env, initRealtimeTracing()))) {
  const { httpServer, io, drain, shutdown, readiness } = createRealtimeInstance(
    env,
    {
      instanceId: randomUUID(),
      random: Math.random,
      flushTelemetry,
      exit: (code) => process.exit(code),
    }
  );
  const exitAfterShutdown = (code: number): void => {
    shutdown().finally(() => process.exit(code));
  };
  startGaugeReporter({
    liveConnections: () => io.of("/").sockets.size,
    degraded: readiness.isDegraded,
  });
  if (env.ecsMetadataUri) {
    watchTaskStopping({
      metadataUri: env.ecsMetadataUri,
      onStopping: () => drain.start(DrainTrigger.TaskStopping),
    });
  }

  httpServer.on("error", (error) => {
    log.error("Realtime HTTP server error", {
      event: "realtime.http_server_error",
      error,
    });
    exitAfterShutdown(1);
  });
  httpServer.listen(env.port, () => {
    log.info("Realtime service listening", {
      event: "realtime.listening",
      port: env.port,
    });
  });

  // SIGTERM starts the drain when the ECS API did not report the stop first,
  // and is what lets a finished drain exit. SIGINT is a local stop and closes
  // at once.
  process.once("SIGTERM", () => drain.start(DrainTrigger.Sigterm));
  process.once("SIGINT", () => {
    io.close(() => exitAfterShutdown(0));
  });
}
