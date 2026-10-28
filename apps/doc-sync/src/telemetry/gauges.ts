import { DocSyncGauge, emitDocSyncMetric } from "./metrics";

export type GaugeSources = {
  openDocuments: () => number;
  connections: () => number;
  memory?: () => NodeJS.MemoryUsage;
};

/**
 * Reports the open-document, connection and memory gauges at once, then every
 * `intervalMs` on an unref'd timer, as realtime's reporter does. Returns the
 * stop function.
 */
export function startGaugeReporter(
  {
    openDocuments,
    connections,
    memory = () => process.memoryUsage(),
  }: GaugeSources,
  intervalMs = GAUGE_INTERVAL_MS
): () => void {
  const report = () => {
    const { rss, heapUsed } = memory();
    emitDocSyncMetric({
      metric: DocSyncGauge.OpenDocuments,
      value: openDocuments(),
    });
    emitDocSyncMetric({
      metric: DocSyncGauge.Connections,
      value: connections(),
    });
    emitDocSyncMetric({ metric: DocSyncGauge.MemoryRssBytes, value: rss });
    emitDocSyncMetric({
      metric: DocSyncGauge.MemoryHeapUsedBytes,
      value: heapUsed,
    });
  };
  report();
  const timer = setInterval(report, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export const GAUGE_INTERVAL_MS = 10_000;
