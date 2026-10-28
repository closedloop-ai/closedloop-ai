import type { HookName } from "@hocuspocus/server";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import { Origin } from "@repo/observability/telemetry/origin";
import type { InternalCommandLabel } from "../http/command-outcome";

/** Sampled every `GAUGE_INTERVAL_MS` (`./gauges.ts`). */
export const DocSyncGauge = {
  OpenDocuments: "doc_sync_open_documents",
  Connections: "doc_sync_connections",
  MemoryRssBytes: "doc_sync_memory_rss_bytes",
  MemoryHeapUsedBytes: "doc_sync_memory_heap_used_bytes",
} as const;
export type DocSyncGauge = (typeof DocSyncGauge)[keyof typeof DocSyncGauge];

export const DocSyncHistogram = {
  StoreDurationMs: "doc_sync_store_duration_ms",
} as const;
export type DocSyncHistogram =
  (typeof DocSyncHistogram)[keyof typeof DocSyncHistogram];

export const DocSyncCount = {
  StoreFailures: "doc_sync_store_failures",
  HookErrors: "doc_sync_hook_errors",
  InternalCommandFailures: "doc_sync_internal_command_failures",
} as const;

/**
 * Every tag is a closed set: a hook name, a command label, an HTTP status.
 * Never a document name or a user id. The HTTP status is `httpStatus`:
 * the pipeline parses the sample's keys into attributes, and `status` is
 * Datadog's reserved severity attribute.
 */
export type DocSyncMetricSample =
  | { metric: DocSyncGauge | DocSyncHistogram; value: number }
  | { metric: typeof DocSyncCount.StoreFailures; count: 1 }
  | { metric: typeof DocSyncCount.HookErrors; count: 1; hook: HookName }
  | {
      metric: typeof DocSyncCount.InternalCommandFailures;
      count: 1;
      command: InternalCommandLabel;
      httpStatus: number;
    };

export function emitDocSyncMetric(sample: DocSyncMetricSample): void {
  emitTelemetryMetric({ ...sample, origin: Origin.DocSync });
}
