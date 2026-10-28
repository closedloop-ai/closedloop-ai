import type { FatalExitDeps } from "@repo/observability/boot-env";
import {
  isLogExportDisabled,
  isLogExportOpen,
  log,
} from "@repo/observability/log";
import {
  flushLogsWithDeadline,
  waitForDeadline,
} from "@repo/observability/shutdown";
import {
  type TracingConfig,
  TracingDisabledReason,
} from "@repo/observability/tracing/config";
import { flushSpans } from "@repo/observability/tracing/hooks";
import { initTracing } from "@repo/observability/tracing/provider";
import type { RealtimeEnv } from "../env";

/**
 * Boots the tracer; `DD_TRACING_ENABLED=1` opts the service in. Every span is
 * recorded (ISS-11210 requirement 15): the collector sidecar computes metrics
 * from all of them and tail-samples what it exports, so an unset
 * `DD_TRACE_SAMPLE_RATE` means 1 here rather than the shared 0.1 default.
 */
export function initRealtimeTracing(): TracingConfig {
  // The shared tracer reads the rate from process.env, blank counting as unset.
  if (!process.env.DD_TRACE_SAMPLE_RATE) {
    process.env.DD_TRACE_SAMPLE_RATE = RECORD_EVERY_SPAN;
  }
  const config = initTracing();
  if (config.enabled) {
    log.info("Realtime tracing enabled", {
      event: TRACING_STATE_EVENT,
      sampleRate: config.sampleRate,
    });
  } else {
    log.info("Realtime tracing disabled", {
      event: TRACING_STATE_EVENT,
      reason: config.reason,
    });
  }
  return config;
}

const RECORD_EVERY_SPAN = "1";

export const TRACING_STATE_EVENT = "realtime.tracing_state";

/**
 * Run before every exit: spans are batched, and `process.exit` discards what
 * the batch still holds. Each flush is bounded, so a stuck exporter cannot
 * hold the exit.
 */
export async function flushTelemetry(): Promise<void> {
  await Promise.all([
    flushLogsWithDeadline(),
    Promise.race([flushSpans(), waitForDeadline(SPAN_FLUSH_DEADLINE_MS)]),
  ]);
}

export const SPAN_FLUSH_DEADLINE_MS = 5000;

export const REALTIME_TELEMETRY_UNEXPORTED_EVENT =
  "realtime.telemetry_unexported";

export const TelemetrySignal = {
  Logs: "logs",
  Traces: "traces",
} as const;
export type TelemetrySignal =
  (typeof TelemetrySignal)[keyof typeof TelemetrySignal];

export type TelemetryExportDeps = FatalExitDeps & {
  logExportOpen: boolean;
  logExportDisabled: boolean;
};

/**
 * On ECS, a signal with no key and no sidecar to export through reaches only
 * CloudWatch, which nothing forwards to Datadog, so the task refuses to boot
 * (ISS-11827). A signal switched off on purpose is not that mistake:
 * `DD_LOGS_DISABLED` keeps the console output CloudWatch captures and boots
 * (ISS-12799), as `DD_TRACING_DISABLED` does. Off ECS the console is the
 * intended sink.
 */
export async function requireTelemetryExportOrExit(
  env: Pick<RealtimeEnv, "ecsMetadataUri">,
  tracing: TracingConfig,
  deps: TelemetryExportDeps = {
    exit: (code) => process.exit(code),
    flushLogs: flushLogsWithDeadline,
    logExportOpen: isLogExportOpen(),
    logExportDisabled: isLogExportDisabled(),
  }
): Promise<boolean> {
  if (!env.ecsMetadataUri) {
    return true;
  }
  const unexported: TelemetrySignal[] = [];
  if (!(deps.logExportOpen || deps.logExportDisabled)) {
    unexported.push(TelemetrySignal.Logs);
  }
  if (!tracing.enabled && TRACES_UNEXPORTED[tracing.reason]) {
    unexported.push(TelemetrySignal.Traces);
  }
  if (unexported.length === 0) {
    return true;
  }
  log.error("Realtime service refused to boot: telemetry has no export path", {
    event: REALTIME_TELEMETRY_UNEXPORTED_EVENT,
    fatal: true,
    signals: unexported,
  });
  await deps.flushLogs();
  deps.exit(1);
  return false;
}

/** Which disabled-tracing reasons leave traces with nowhere to go by mistake. */
const TRACES_UNEXPORTED: Record<TracingDisabledReason, boolean> = {
  [TracingDisabledReason.ExplicitlyDisabled]: false,
  [TracingDisabledReason.MissingApiKey]: true,
  [TracingDisabledReason.MissingEndpoint]: true,
  [TracingDisabledReason.NotDeployed]: true,
  // Tracing fails open (tracing/provider.ts): a tracer bug must not stop the service.
  [TracingDisabledReason.InitFailed]: false,
};
