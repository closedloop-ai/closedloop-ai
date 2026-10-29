/**
 * ISS-12211 AC4: prove the desktop's two keyless OTLP egress paths deliver the
 * same telemetry to Datadog, on stage.
 *
 *   send     Boots the desktop's REAL OTel runtime twice in plain Node, once per
 *            path, each with its own fresh `app.installation.id` (the run id):
 *              relay  createRelayTelemetryTransport -> relay.stage.example /telemetry
 *              route  createApiOtlpTelemetryTransport -> api.stage.example /desktop/otlp
 *            Each emits what a booting build emits through production code: the
 *            `app.lifecycle` start span, one heartbeat tick, and an `exception`
 *            span. The exception is there for the Collector's tail sampler: it
 *            keeps every trace with an ERROR span and 10% of the rest, so without
 *            it the trace would arrive on both paths 1% of the time.
 *   collect  Reads each path's copies back from Datadog (read-only `pup`) by run
 *            id and diffs their attributes (`otlp-egress-parity-diff.ts`).
 *
 * The route's relay fallback is replaced by one that refuses, so a route that
 * answers 404 fails the run instead of quietly proving the relay twice.
 *
 * Stage only: both origins are fixed below. Run from apps/desktop:
 *   pnpm exec tsx scripts/otlp-egress-parity-proof.ts send --out <dir>
 *   pnpm exec tsx scripts/otlp-egress-parity-proof.ts collect --out <dir>
 * `collect` waits until the Collector can have released the trace, and should
 * run inside Datadog's 15-minute live span window. After it, only the ERROR
 * span is sure to be searchable (the Error Default retention filter keeps every
 * error span); the other two are there only if Datadog's intelligent retention
 * happened to keep them, so a late `collect` can report them missing.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { AgentMonitorRuntimeStatusKind } from "@closedloop-ai/telemetry-contract/app";
import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import type { KeylessTelemetrySignal } from "@repo/shared-platform/keyless-telemetry";
import { z } from "zod";
import {
  createApiOtlpTelemetryTransport,
  REQUEST_TIMEOUT_MS as ROUTE_REQUEST_TIMEOUT_MS,
} from "../src/main/telemetry/api-otlp-telemetry-transport.js";
import {
  APP_EXCEPTION_EVENT_NAME,
  APP_LIFECYCLE_EVENT_NAME,
  createDesktopOtelRuntime,
  DESKTOP_ACTIVITY_ROOT_SPAN_NAME,
} from "../src/main/telemetry/app-otel-runtime.js";
import {
  createDesktopAppLifecycleTelemetry,
  DesktopAppLifecycleEvent,
  DesktopAppOperatingMode,
} from "../src/main/telemetry/app-otel-runtime-lifecycle.js";
import {
  createRelayTelemetryTransport,
  DEFAULT_ACK_TIMEOUT_MS as RELAY_ACK_TIMEOUT_MS,
  type RelayTelemetryTransportDiagnostics,
  type RelayTelemetryTransportHandle,
} from "../src/main/telemetry/relay-telemetry-transport.js";
import { BUILD_APP_VERSION } from "../src/shared/build-info.js";
import {
  diffEgressParity,
  EgressPath,
  ParityFindingKind,
  type ParityRecord,
  ParityRecordKind,
  type ParityReport,
  parityKey,
  toParityRecord,
} from "./otlp-egress-parity-diff.js";

const STAGE_RELAY_ORIGIN = "https://relay.stage.example";
const STAGE_API_ORIGIN = "https://api.stage.example";

/**
 * How long the relay path may take to deliver, built from the bounds the relay
 * transport itself runs under: socket.io-client's connect-attempt timeout
 * (20,000 ms, the `Manager` default in socket.io-client 4.8.3, which
 * `createRelayTelemetryTransport` does not override), then one handshake ack
 * and one export ack (`DEFAULT_ACK_TIMEOUT_MS` each). The transport's own
 * 1,500 ms quit drain is a bound for app exit, not for proving delivery.
 */
const RELAY_DELIVERY_BOUND_MS = 20_000 + RELAY_ACK_TIMEOUT_MS * 2;

const COLLECTOR_RELEASE_MS = (310 + 5) * 1000;

/**
 * Datadog keeps every ingested span searchable in Live Search for 15 minutes;
 * after that only spans a retention filter kept are
 * (https://docs.datadoghq.com/tracing/trace_explorer/#live-search-for-15-minutes).
 */
const LIVE_SPAN_WINDOW_MS = 15 * 60 * 1000;

const ROOT_SPAN_KEY = parityKey(
  ParityRecordKind.Span,
  DESKTOP_ACTIVITY_ROOT_SPAN_NAME
);
const START_SPAN_KEY = parityKey(
  ParityRecordKind.Span,
  APP_LIFECYCLE_EVENT_NAME,
  DesktopAppLifecycleEvent.Start
);

/** The records one run must produce on each path; the diff keys them so. */
export const EXPECTED_RECORD_KEYS = [
  ROOT_SPAN_KEY,
  START_SPAN_KEY,
  parityKey(ParityRecordKind.Span, APP_EXCEPTION_EVENT_NAME),
  parityKey(
    ParityRecordKind.Log,
    undefined,
    DesktopAppLifecycleEvent.Heartbeat
  ),
];

/**
 * The spans a search after the live window finds only if Datadog's intelligent
 * retention kept them; the `exception` span is not one (see the header).
 */
const RETENTION_SAMPLED_KEYS: readonly string[] = [
  ROOT_SPAN_KEY,
  START_SPAN_KEY,
];

type ExportCalls = Record<KeylessTelemetrySignal, number>;

type PathSendResult = {
  path: EgressPath;
  origin: string;
  installationId: string;
  exportCalls: ExportCalls;
  diagnostics: RelayTelemetryTransportDiagnostics;
  /** Route path only: exports its transport handed to the relay fallback. */
  fallbackExports?: number;
  delivered: boolean;
};

type RunFile = {
  sentAt: string;
  /** When the last export finished: the Collector's hold counts from here. */
  finishedAt: string;
  serviceVersion: string;
  paths: Record<EgressPath, PathSendResult>;
};

const RUN_FILE = "run.json";
const HITS_FILE = "hits.json";
const REPORT_FILE = "report.json";

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { out: { type: "string" } },
  });
  const [command] = positionals;
  if (!(values.out && (command === "send" || command === "collect"))) {
    console.error(
      "usage: otlp-egress-parity-proof.ts <send|collect> --out <dir>"
    );
    process.exit(2);
  }
  const passed =
    command === "send" ? await send(values.out) : await collect(values.out);
  process.exit(passed ? 0 : 1);
}

async function send(outDir: string): Promise<boolean> {
  mkdirSync(outDir, { recursive: true });
  const sentAt = new Date().toISOString();
  // One error object for both paths, so message and stack are equal inputs.
  const probeError = new Error("ISS-12211 AC4 egress parity probe");

  const relay = await sendThroughPath(
    EgressPath.Relay,
    STAGE_RELAY_ORIGIN,
    probeError,
    () =>
      createRelayTelemetryTransport({
        getRelayOrigin: () => STAGE_RELAY_ORIGIN,
        shutdownDrainMs: RELAY_DELIVERY_BOUND_MS,
      })
  );
  const fallback = createRefusingFallback();
  const route = await sendThroughPath(
    EgressPath.Route,
    STAGE_API_ORIGIN,
    probeError,
    () =>
      createApiOtlpTelemetryTransport({
        getApiOrigin: () => STAGE_API_ORIGIN,
        fallback: fallback.handle,
        shutdownDrainMs: ROUTE_REQUEST_TIMEOUT_MS,
      })
  );
  route.fallbackExports = fallback.exports();
  route.delivered = route.delivered && route.fallbackExports === 0;

  const run: RunFile = {
    sentAt,
    finishedAt: new Date().toISOString(),
    serviceVersion: BUILD_APP_VERSION,
    paths: { relay, route },
  };
  writeFileSync(join(outDir, RUN_FILE), `${JSON.stringify(run, null, 2)}\n`);
  for (const result of [relay, route]) {
    console.log(
      `${result.path}: ${result.delivered ? "delivered" : "NOT delivered"} ` +
        `app.installation.id=${result.installationId} ` +
        `exports=${JSON.stringify(result.exportCalls)} ` +
        `sent=${result.diagnostics.sent}` +
        (result.fallbackExports === undefined
          ? ""
          : ` fallbackExports=${result.fallbackExports}`)
    );
  }
  console.log(
    `collect from ${new Date(Date.parse(run.finishedAt) + COLLECTOR_RELEASE_MS).toISOString()} ` +
      `until ${liveWindowEnd(sentAt)}`
  );
  return relay.delivered && route.delivered;
}

export async function sendThroughPath(
  path: EgressPath,
  origin: string,
  probeError: Error,
  createTransport: () => RelayTelemetryTransportHandle
): Promise<PathSendResult> {
  const installationId = randomUUID();
  const exportCalls: ExportCalls = { traces: 0, metrics: 0, logs: 0 };
  const transport = countExports(createTransport(), exportCalls);
  const runtime = createDesktopOtelRuntime({
    appVersion: BUILD_APP_VERSION,
    env: {},
    getAppInstallationId: () => installationId,
    getDeviceId: () => installationId,
    getOperatingMode: () => DesktopAppOperatingMode.SinglePlayer,
    isPackaged: true,
    telemetryTransport: transport,
  });
  const heartbeat: { tick?: () => void } = {};
  const lifecycle = createDesktopAppLifecycleTelemetry({
    runtime,
    getOperatingMode: () => DesktopAppOperatingMode.SinglePlayer,
    getAgentMonitorRuntimeStatus: () => AgentMonitorRuntimeStatusKind.Ready,
    getTelemetryExportCounts: () => transport.getDiagnostics(),
    setIntervalFn: (callback) => {
      heartbeat.tick = callback;
      return {};
    },
    clearIntervalFn: () => undefined,
    logWarning: (tag, message) => console.warn(`[${tag}] ${message}`),
  });

  await runtime.start();
  lifecycle.start();
  heartbeat.tick?.();
  runtime.emitAppExceptionEvent({
    error: probeError,
    origin: AppExceptionOrigin.Main,
  });
  lifecycle.stop();
  await runtime.flush();
  await runtime.shutdown();
  // NodeSDK registers process-global providers and never unregisters them, so
  // the second path's SDK would otherwise emit into the first path's, already
  // shut down. Releasing them makes each path a fresh process to the OTel API.
  for (const api of [trace, context, propagation, metrics, logs]) {
    api.disable();
  }

  const diagnostics = transport.getDiagnostics();
  const totalExports =
    exportCalls.traces + exportCalls.metrics + exportCalls.logs;
  return {
    path,
    origin,
    installationId,
    exportCalls,
    diagnostics,
    delivered: totalExports > 0 && diagnostics.sent === totalExports,
  };
}

/** Counts what the SDK exporters hand the transport; delivery is the transport's own `sent`. */
function countExports(
  inner: RelayTelemetryTransportHandle,
  calls: ExportCalls
): RelayTelemetryTransportHandle {
  return {
    start: (context) => inner.start(context),
    stop: () => inner.stop(),
    flush: () => inner.flush(),
    getDiagnostics: () => inner.getDiagnostics(),
    export: (signal, body) => {
      calls[signal] += 1;
      return inner.export(signal, body);
    },
  };
}

function createRefusingFallback(): {
  handle: RelayTelemetryTransportHandle;
  exports: () => number;
} {
  let exports = 0;
  const handle: RelayTelemetryTransportHandle = {
    start: () => undefined,
    stop: () => undefined,
    flush: () => Promise.resolve(),
    export: () => {
      exports += 1;
      return Promise.resolve(false);
    },
    getDiagnostics: () => ({
      connected: false,
      hasSession: false,
      inCooldown: false,
      warmUpQueueDepth: 0,
      sent: 0,
      droppedOversize: 0,
      droppedNoSession: 0,
      droppedRateLimited: 0,
      droppedCollectorUnavailable: 0,
      droppedInvalid: exports,
    }),
  };
  return { handle, exports: () => exports };
}

export async function collect(outDir: string): Promise<boolean> {
  const run = runFileSchema.parse(
    JSON.parse(readFileSync(join(outDir, RUN_FILE), "utf8"))
  );
  const sentAtMs = Date.parse(run.sentAt);
  const waitMs = Date.parse(run.finishedAt) + COLLECTOR_RELEASE_MS - Date.now();
  if (waitMs > 0) {
    console.log(`waiting ${Math.ceil(waitMs / 1000)} s for the Collector`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  const live = Date.now() - sentAtMs < LIVE_SPAN_WINDOW_MS;

  const queries: Record<EgressPath, string> = {
    relay: runQuery(run.paths.relay.installationId),
    route: runQuery(run.paths.route.installationId),
  };
  const hits = {
    relay: searchPath(queries.relay, run.sentAt, live),
    route: searchPath(queries.route, run.sentAt, live),
  };
  const report: ParityReport = diffEgressParity({
    relay: toRecords(hits.relay),
    route: toRecords(hits.route),
    runIds: {
      relay: run.paths.relay.installationId,
      route: run.paths.route.installationId,
    },
    expectedKeys: EXPECTED_RECORD_KEYS,
  });

  writeFileSync(join(outDir, HITS_FILE), `${JSON.stringify(hits, null, 2)}\n`);
  writeFileSync(
    join(outDir, REPORT_FILE),
    `${JSON.stringify({ queries, spanSearch: live ? "live" : "indexed", report }, null, 2)}\n`
  );
  printReport(queries, live, report);
  const missingKeys = report.findings.flatMap((finding) =>
    finding.kind === ParityFindingKind.Missing ? [finding.key] : []
  );
  if (live && missingKeys.length > 0) {
    console.log(
      `records may still be in Datadog's ingest; re-run collect before ${liveWindowEnd(run.sentAt)}`
    );
  }
  const unretained = RETENTION_SAMPLED_KEYS.filter((key) =>
    missingKeys.includes(key)
  );
  if (!live && unretained.length > 0) {
    console.log(
      `not a verdict: span search ran after the live window ended at ${liveWindowEnd(run.sentAt)}, ` +
        `so a missing ${unretained.join(", ")} can be Datadog retention, not the egress path; ` +
        "run send and collect again inside the window"
    );
  }
  return report.pass;
}

function runQuery(installationId: string): string {
  return `@${TelemetryAttribute.AppInstallationId}:${installationId}`;
}

function liveWindowEnd(sentAt: string): string {
  return new Date(Date.parse(sentAt) + LIVE_SPAN_WINDOW_MS).toISOString();
}

type SearchHit = z.infer<typeof searchHitSchema>;
type PathHits = { spans: SearchHit[]; logs: SearchHit[] };

function searchPath(query: string, from: string, live: boolean): PathHits {
  return {
    spans: pupSearch([
      "traces",
      "search",
      `--query=${query}`,
      `--from=${from}`,
      ...(live ? ["--live"] : []),
    ]),
    logs: pupSearch([
      "logs",
      "search",
      `--query=${query}`,
      `--from=${from}`,
      "--storage=indexes",
    ]),
  };
}

/**
 * Read-only Datadog search through `pup`. A response it cannot read throws: an
 * unreadable answer must not count as "no copy arrived".
 */
function pupSearch(args: string[]): SearchHit[] {
  const stdout = execFileSync("pup", ["--no-agent", ...args], {
    encoding: "utf8",
  });
  return searchResponseSchema.parse(JSON.parse(stdout)).data;
}

function toRecords(hits: PathHits): ParityRecord[] {
  return [
    ...hits.spans.map((hit) => toParityRecord(ParityRecordKind.Span, hit)),
    ...hits.logs.map((hit) => toParityRecord(ParityRecordKind.Log, hit)),
  ];
}

function printReport(
  queries: Record<EgressPath, string>,
  live: boolean,
  report: ParityReport
): void {
  console.log(`relay query: ${queries.relay}`);
  console.log(`route query: ${queries.route}`);
  console.log(`span search: ${live ? "live" : "indexed"}`);
  for (const pair of report.pairs) {
    console.log(
      `${pair.key}: ${Object.keys(pair.identical).length} attributes identical`
    );
  }
  for (const finding of report.findings) {
    console.log(`FINDING ${JSON.stringify(finding)}`);
  }
  console.log(report.pass ? "PARITY" : "NOT PARITY");
}

/** The fields `collect` reads back from the file `send` wrote. */
const runFileSchema = z.object({
  sentAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  paths: z.object({
    relay: z.object({ installationId: z.uuid() }),
    route: z.object({ installationId: z.uuid() }),
  }),
});

const searchHitSchema = z.object({
  attributes: z.record(z.string(), z.unknown()),
});

const searchResponseSchema = z.object({ data: z.array(searchHitSchema) });

// Runs only when invoked as the CLI, so a test can import the functions above.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
