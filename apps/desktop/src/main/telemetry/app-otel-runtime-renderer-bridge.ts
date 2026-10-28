/**
 * @file app-otel-runtime-renderer-bridge.ts
 * @description ISS-7249: renderer-bridge trace identity and record rebasing,
 * split out of `app-otel-runtime.ts` exactly as its `-dead-end`, `-update`,
 * `-onboarding`, `-lifecycle`, and `-import-health` siblings are. These three
 * were already module-private with no consumer outside that file, so this moves
 * a self-contained concern rather than widening any surface.
 */
import { context, type SpanContext, trace } from "@opentelemetry/api";
import type { RendererOtelBridgeRecord } from "../../shared/renderer-otel-bridge-constants.js";
import { hasSpanIdentity } from "../../shared/renderer-otel-bridge-utils.js";

/**
 * Resolves the one span context every record in this batch should hang off, and
 * memoizes it per trace id.
 *
 * `rendererTraceContexts` is bounded by `contextLimit` with oldest-first
 * eviction: the map is keyed by renderer-supplied trace ids, so without a cap it
 * would grow with external input for the life of the process.
 */
export function resolveRendererIdentityContext(
  records: RendererOtelBridgeRecord[],
  rendererTraceContexts: Map<string, SpanContext>,
  contextLimit: number
): SpanContext | null {
  const traceIds = records
    .filter(hasSpanIdentity)
    .map((record) => record.traceId);
  if (traceIds.length === 0) {
    return null;
  }
  const existingContext = traceIds
    .map((traceId) => rendererTraceContexts.get(traceId))
    .find(
      (spanContext): spanContext is SpanContext => spanContext !== undefined
    );
  const activeSpanContext = trace.getSpan(context.active())?.spanContext();
  const identityContext =
    activeSpanContext ?? existingContext ?? createRendererIngestSpanContext();
  for (const traceId of traceIds) {
    const hasCachedContext = rendererTraceContexts.has(traceId);
    if (!hasCachedContext) {
      while (rendererTraceContexts.size >= contextLimit) {
        const oldestTraceId = rendererTraceContexts.keys().next().value;
        if (oldestTraceId === undefined) {
          break;
        }
        rendererTraceContexts.delete(oldestTraceId);
      }
    }
    if (
      !hasCachedContext ||
      rendererTraceContexts.get(traceId) !== identityContext
    ) {
      rendererTraceContexts.set(traceId, identityContext);
    }
  }
  return identityContext;
}

/** Re-parents records onto the resolved identity, leaving identity-less ones untouched. */
export function rebaseRendererRecords(
  records: RendererOtelBridgeRecord[],
  identityContext: SpanContext | null
): RendererOtelBridgeRecord[] {
  if (!identityContext) {
    return records;
  }

  return records.map((record) => {
    if (!hasSpanIdentity(record)) {
      return record;
    }
    return {
      ...record,
      traceId: identityContext.traceId,
      parentSpanId: record.parentSpanId ?? identityContext.spanId,
    };
  });
}

/** Only reached from `resolveRendererIdentityContext`, so it stays private here. */
function createRendererIngestSpanContext(): SpanContext {
  const span = trace
    .getTracer("closedloop-desktop-renderer-ingest")
    .startSpan("desktop.renderer.otel.ingest", undefined, context.active());
  span.end();
  return span.spanContext();
}
