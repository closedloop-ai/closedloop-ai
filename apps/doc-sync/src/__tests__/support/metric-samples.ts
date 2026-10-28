import type { MockInstance } from "vitest";

/** The `emitTelemetryMetric` samples among the calls a `log.info` spy saw, parsed. */
export function metricSamples(
  info: MockInstance<(message: string, ...rest: unknown[]) => void>
): Record<string, unknown>[] {
  return info.mock.calls.flatMap(([message]) => {
    if (!message.startsWith("{")) {
      return [];
    }
    const parsed: Record<string, unknown> = JSON.parse(message);
    return parsed._telemetryMetric === true ? [parsed] : [];
  });
}
