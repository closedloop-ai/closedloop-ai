// ---------------------------------------------------------------------------
// Route identity for the APM resource name (ISS-5856).
//
// Measured against prod on 2026-08-11: every `cl-api` server span reaches
// Datadog with its resource set to the bare HTTP method. 11,750 request spans
// over 6h collapsed into exactly four resources — `GET`, `POST`, `PUT`,
// `PATCH`. Every route therefore shares one resource, so APM cannot break
// latency, throughput, or DB attribution down per route: a slow endpoint is
// averaged into the traffic beside it and disappears.
//
// The route is not missing from the spans that resolved one. Next stamps
// `next.span_name` at span creation from the initial span name, and for the
// root request span that name is the bare method (`spanName: `${method}`` in
// `dist/server/base-server.js`). It is rewritten to `"<METHOD> <route>"` only
// in the same `setAttributes` call that writes `http.route`, once `next.route`
// resolved. A route therefore sits in `next.span_name` exactly when
// `http.route` does — 3,446 of the 11,750, not the 99.8% that counting the
// attribute's bare presence suggests, because on the rest it still holds the
// method. Datadog keeps deriving the resource from the method regardless.
//
// `resource.name` is the documented OTLP override: Datadog reads it verbatim as
// the APM resource instead of inferring one from HTTP semantics. Since
// `next.span_name` is already in precisely that shape, this copies it across
// rather than re-deriving a route from its parts and inventing a second
// spelling of the same thing.
//
// So this recovers the route on the spans that have one and changes nothing on
// the rest, which at that 3,446/11,750 rate is the majority: there
// `next.span_name` is still the bare method, exactly what the resource already
// says today, so those spans keep the resource they have rather than being
// mislabelled as a real route.
//
// Scope note: this makes route attribution possible; it does not itself create
// DB child spans, and it did not show that those are healthy. What it settled
// is narrower: ISS-5856 re-measured 18 prod traces and found `/branches` and
// `/desktop/agent-sessions/sync` BOTH carrying zero DB child spans, which
// disproves the per-ROUTE explanation, not the absence. ISS-4659 then measured
// the real split, which is per-PROCESS: of 4,356 sampled cold starts, 89 had
// `pg` already resident before the tracer started, never got patched, and
// emitted no DB spans for the life of the process. See
// `apps/api/instrumentation.node.ts` for the ordering that decides it.
// ---------------------------------------------------------------------------

import type { Context } from "@opentelemetry/api";
import { SpanKind } from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-node";

/**
 * Datadog reads this OTLP span attribute verbatim as the APM resource name,
 * ahead of anything it would otherwise infer from the HTTP semantics.
 */
const ATTR_DATADOG_RESOURCE_NAME = "resource.name";

/**
 * Next.js stamps this at span creation and rewrites it once the matched route
 * is known, so a root request span carries one of three shapes: `"<METHOD>
 * <route>"`, `"RSC <METHOD> <route>"` when the request is an RSC one, or the
 * bare method when no route resolved — bare even for an RSC request, since that
 * branch calls `updateName` alone and leaves this attribute at its creation
 * value. All three are bounded and already resource-shaped, so all three are
 * copied verbatim. RSC requests never reach the `apps/api` route handlers this
 * was written for, but this is a shared package and the shape is not excluded.
 */
const ATTR_NEXT_SPAN_NAME = "next.span_name";

/**
 * Copies Next's resolved route onto the Datadog resource-name attribute of each
 * SERVER span, while that span is still ending.
 *
 * The write happens in `onEnding`, which is the only point OTel sanctions for
 * mutating a span: `SpanImpl.end()` calls it before setting `_ended`, so
 * `setAttribute` is still live, and `MultiSpanProcessor` runs every processor's
 * `onEnding` before any processor's `onEnd`. That makes the stamp land ahead of
 * the exporting processor no matter where this sits in `spanProcessors` —
 * including the case that would otherwise lose a span, where `BatchSpanProcessor`
 * hits `maxExportBatchSize` (512) and flushes inline rather than scheduling.
 *
 * Writing through `ReadableSpan.attributes` in `onEnd` instead would appear to
 * work on today's JS SDK only because it happens to expose a mutable attribute
 * bag after end. That is not part of the contract, and an SDK that froze or
 * copied attributes on end would turn this processor into a silent no-op.
 */
export class RouteResourceSpanProcessor implements SpanProcessor {
  onStart(_span: Span, _parentContext: Context): void {
    // Next resolves the matched route while handling the request, so at start
    // there is nothing to copy yet. The work belongs in `onEnding`.
  }

  onEnding(span: Span): void {
    stampResourceName(span);
  }

  onEnd(_span: ReadableSpan): void {
    // Required by `SpanProcessor`, deliberately empty: by `onEnd` the span is
    // already ended and mutating it is outside the OTel contract.
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Stamp the resource name from Next's span name, leaving anything already set
 * alone.
 *
 * Gated to SERVER spans, and that gate is load-bearing rather than tidiness.
 * `next.span_name` is not route-only: Next stamps it on its CLIENT fetch spans
 * too, where it holds the full request URL including the query string. Ungated,
 * this would promote every dynamic repository URL we fetch into a distinct
 * Datadog resource — unbounded resource cardinality, and identifiers and query
 * parameters pushed into a name field nothing downstream expects to carry them.
 * The spans this exists to fix — the request spans whose resource collapsed to
 * the bare HTTP method — are SERVER spans, so the gate costs nothing.
 *
 * Never throws. A rejected write costs one missing resource name; letting it
 * escape would break export for every span behind it, which is strictly worse
 * than the gap this exists to close.
 */
function stampResourceName(span: Span): void {
  if (span.kind !== SpanKind.SERVER) {
    return;
  }
  const nextSpanName = span.attributes[ATTR_NEXT_SPAN_NAME];
  if (typeof nextSpanName !== "string" || nextSpanName.length === 0) {
    return;
  }
  if (span.attributes[ATTR_DATADOG_RESOURCE_NAME] !== undefined) {
    return;
  }
  try {
    span.setAttribute(ATTR_DATADOG_RESOURCE_NAME, nextSpanName);
  } catch {
    // Best-effort by contract — see the docstring above.
  }
}
