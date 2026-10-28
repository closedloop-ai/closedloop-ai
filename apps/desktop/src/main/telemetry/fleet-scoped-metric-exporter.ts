/**
 * @file fleet-scoped-metric-exporter.ts
 * @description ISS-7497 — keep stable install identifiers out of the metrics
 * label space.
 *
 * `startDesktopOtelSdk` builds ONE `Resource` and `NodeSDK` stamps it onto every
 * signal, so the resource that makes a span forensically useful —
 * `app.installation.id`, and `device.id` when the install has one — would ride
 * the metric export as well. On a span that is the point: a retained trace is
 * read one install at a time. On a metric it is a defect twice over. It makes a
 * stable per-device identifier part of the metrics label space, and it shards
 * `sync.batch.count` into one time series per install, so the fleet rate the
 * counter exists to answer has to be re-aggregated back across identifiers that
 * should never have been there.
 *
 * The narrowing is applied at the export boundary rather than by giving metrics
 * their own `MeterProvider`, so `NodeSDK` keeps sole ownership of provider
 * lifecycle (start, shutdown, and the crash-path drain) and this stays a
 * statement about what leaves the process.
 */
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import type { Attributes } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type {
  PushMetricExporter,
  ResourceMetrics,
} from "@opentelemetry/sdk-metrics";

/**
 * The only resource keys a metric export may carry.
 *
 * An ALLOW-list, not a deny-list of the two identifiers known today: a resource
 * attribute added later is per-install until someone proves otherwise, and the
 * failure mode of guessing wrong is a stable identifier shipped to the metrics
 * backend, which cannot be un-shipped. These three are what a fleet aggregation
 * legitimately slices by.
 */
export const FleetMetricResourceAttributeKeys = [
  TelemetryAttribute.ServiceName,
  TelemetryAttribute.ServiceVersion,
  TelemetryAttribute.DeploymentEnvironmentName,
] as const;

/**
 * Wrap a metric exporter so every batch it receives is re-stamped with the
 * fleet-scoped resource.
 *
 * Delegates `forceFlush` and `shutdown` untouched — the crash-path drain runs
 * through this wrapper, so swallowing either would trade the identifier leak
 * for lost increments.
 */
export function withFleetScopedResource(
  exporter: PushMetricExporter
): PushMetricExporter {
  const wrapped: PushMetricExporter = {
    export(
      metrics: ResourceMetrics,
      resultCallback: Parameters<PushMetricExporter["export"]>[1]
    ): void {
      exporter.export(
        {
          ...metrics,
          resource: fleetScopedResource(metrics.resource.attributes),
        },
        resultCallback
      );
    },
    forceFlush: () => exporter.forceFlush(),
    shutdown: () => exporter.shutdown(),
  };
  const selectAggregation = exporter.selectAggregation?.bind(exporter);
  if (selectAggregation) {
    wrapped.selectAggregation = selectAggregation;
  }
  const selectAggregationTemporality =
    exporter.selectAggregationTemporality?.bind(exporter);
  if (selectAggregationTemporality) {
    wrapped.selectAggregationTemporality = selectAggregationTemporality;
  }
  return wrapped;
}

/** Project a full desktop resource down to the fleet-safe keys. */
function fleetScopedResource(attributes: Attributes) {
  const fleetAttributes: Attributes = {};
  for (const key of FleetMetricResourceAttributeKeys) {
    const value = attributes[key];
    if (value !== undefined) {
      fleetAttributes[key] = value;
    }
  }
  return resourceFromAttributes(fleetAttributes);
}
