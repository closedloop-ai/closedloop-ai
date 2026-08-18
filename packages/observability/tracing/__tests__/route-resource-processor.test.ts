import { SpanKind, trace } from "@opentelemetry/api";
import type { ReadableSpan, Span } from "@opentelemetry/sdk-trace-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteEnvForTest } from "../../__tests__/test-helpers";
import { initTracing, resetTracingForTest } from "../provider";
import { RouteResourceSpanProcessor } from "../route-resource-processor";

// ---------------------------------------------------------------------------
// tracing/route-resource-processor.ts (ISS-5856).
//
// Prod measurement behind these tests: 11,750 `cl-api` server spans in 6h fell
// into exactly four Datadog resources (`GET`, `POST`, `PUT`, `PATCH`), because
// the resource is derived from the HTTP method alone. On the spans that
// resolved a route the route was already there — `next.span_name` holds
// `"<METHOD> <route>"` exactly when `http.route` is set, 3,446 of the 11,750.
// These pin that it reaches `resource.name`, the attribute Datadog reads
// verbatim, and that the other ~8,000 are left as they are.
//
// Two properties are pinned deliberately, because losing either is silent:
//   - the write goes through `setAttribute` during `onEnding`, not through the
//     ended span's attribute bag, so an SDK that froze that bag on end would
//     fail here rather than quietly stop stamping in prod;
//   - only SERVER spans are stamped. `next.span_name` is not route-only — Next
//     puts full fetch URLs there on CLIENT spans — so an ungated version turns
//     dynamic URLs and their query strings into Datadog resources.
// ---------------------------------------------------------------------------

const ATTR_DATADOG_RESOURCE_NAME = "resource.name";
const ATTR_NEXT_SPAN_NAME = "next.span_name";
const BRANCHES_SPAN_NAME = "GET /branches/route";
const GITHUB_FETCH_SPAN_NAME =
  "fetch GET https://api.github.com/repos/closedloop-ai/symphony-alpha/pulls?state=open&per_page=100";
const BARE_METHOD_SPAN_NAME = "GET";
const RSC_BRANCHES_SPAN_NAME = "RSC GET /branches/route";

afterEach(async () => {
  await resetTracingForTest();
  vi.unstubAllEnvs();
});

/**
 * A span carrying only what this processor reads, plus a `setAttribute` that
 * records writes separately from the readable attribute bag.
 *
 * Keeping the two apart is the point: the readable bag stands in for what a
 * `ReadableSpan` exposes, and `written` records only what went through the
 * sanctioned API. A test asserting on `written` therefore fails if the
 * processor reverts to mutating the bag directly.
 */
function fakeSpan(
  kind: SpanKind,
  attributes: Record<string, unknown>
): Span & { written: Record<string, unknown> } {
  const written: Record<string, unknown> = {};
  const span = {
    kind,
    attributes,
    written,
    setAttribute(key: string, value: unknown) {
      written[key] = value;
      return span;
    },
  };
  return span as unknown as Span & { written: Record<string, unknown> };
}

function enableTracingEnv(): void {
  deleteEnvForTest(
    "DD_TRACING_DISABLED",
    "DD_TRACING_ENABLED",
    "DD_API_KEY",
    "DD_OTLP_TRACES_ENDPOINT",
    "DD_TRACE_SAMPLE_RATE",
    "VERCEL"
  );
  vi.stubEnv("DD_TRACING_ENABLED", "1");
  vi.stubEnv("DD_API_KEY", "dd-test-key");
  vi.stubEnv("DD_OTLP_TRACES_ENDPOINT", "https://otlp.example.test/v1/traces");
  // Pinned: the root sampler is trace-id-ratio based, so at the default rate
  // this span would be recorded or dropped depending on the id it happened to
  // mint — a coin flip, not a test.
  vi.stubEnv("DD_TRACE_SAMPLE_RATE", "1.0");
}

describe("RouteResourceSpanProcessor", () => {
  it("copies the resolved route onto the Datadog resource name", () => {
    const span = fakeSpan(SpanKind.SERVER, {
      [ATTR_NEXT_SPAN_NAME]: BRANCHES_SPAN_NAME,
    });

    new RouteResourceSpanProcessor().onEnding(span);

    // Without this the span reaches Datadog as the bare resource `GET`,
    // indistinguishable from every other GET route in the service.
    expect(span.written[ATTR_DATADOG_RESOURCE_NAME]).toBe(BRANCHES_SPAN_NAME);
  });

  it("stamps through setAttribute rather than the readable attribute bag", () => {
    // The readable bag is frozen, standing in for an SDK that freezes or copies
    // attributes as the span ends. Writing through it is what OTel does not
    // sanction, and it fails silently: no throw, no failing export, just a
    // resource name that quietly stops being set. Here that failure is loud.
    const span = fakeSpan(
      SpanKind.SERVER,
      Object.freeze({ [ATTR_NEXT_SPAN_NAME]: BRANCHES_SPAN_NAME })
    );

    new RouteResourceSpanProcessor().onEnding(span);

    expect(span.written[ATTR_DATADOG_RESOURCE_NAME]).toBe(BRANCHES_SPAN_NAME);
  });

  it("does not make a CLIENT fetch URL the resource name", () => {
    // `next.span_name` is NOT route-only. Next stamps it on outbound fetch
    // spans too, where it holds the full URL — dynamic repository path and
    // query string included. Promoting that to a resource name would give
    // Datadog unbounded resource cardinality and push identifiers and query
    // parameters into a field nothing downstream expects to carry them.
    const span = fakeSpan(SpanKind.CLIENT, {
      [ATTR_NEXT_SPAN_NAME]: GITHUB_FETCH_SPAN_NAME,
    });

    new RouteResourceSpanProcessor().onEnding(span);

    expect(span.written[ATTR_DATADOG_RESOURCE_NAME]).toBeUndefined();
  });

  it("leaves a pg client span untouched", () => {
    // Shape taken from a real prod DB span: `instrumentation-pg` builds its
    // spans with DB semantic-convention attributes only and never sets
    // `next.span_name`, so inventing a resource here would relabel database
    // spans as routes.
    const span = fakeSpan(SpanKind.CLIENT, {
      "db.system.name": "postgresql",
      "db.namespace": "app",
      "db.statement.text": "SELECT 1",
    });

    new RouteResourceSpanProcessor().onEnding(span);

    expect(span.written[ATTR_DATADOG_RESOURCE_NAME]).toBeUndefined();
  });

  it("leaves an internal Next span untouched", () => {
    // Next stamps `next.span_name` on EVERY allowlisted span, not just the root
    // request span — `AppRouteRouteHandlers.runHandler` among them. Those are
    // INTERNAL, and Datadog does not derive their resource from an HTTP method,
    // so there is nothing here to correct.
    const span = fakeSpan(SpanKind.INTERNAL, {
      [ATTR_NEXT_SPAN_NAME]: "executing api route (app) /branches",
    });

    new RouteResourceSpanProcessor().onEnding(span);

    expect(span.written[ATTR_DATADOG_RESOURCE_NAME]).toBeUndefined();
  });

  it("does not overwrite a resource name that is already set", () => {
    const span = fakeSpan(SpanKind.SERVER, {
      [ATTR_DATADOG_RESOURCE_NAME]: "pg.query:SELECT app",
      [ATTR_NEXT_SPAN_NAME]: BRANCHES_SPAN_NAME,
    });

    new RouteResourceSpanProcessor().onEnding(span);

    expect(span.written[ATTR_DATADOG_RESOURCE_NAME]).toBeUndefined();
  });

  it("does not throw when the span rejects the write", () => {
    const span = fakeSpan(SpanKind.SERVER, {
      [ATTR_NEXT_SPAN_NAME]: BRANCHES_SPAN_NAME,
    });
    span.setAttribute = () => {
      throw new Error("attributes are immutable");
    };

    // A throw here would escape into the SDK's span-end path and break export
    // for every span behind it — strictly worse than one missing resource.
    expect(() => new RouteResourceSpanProcessor().onEnding(span)).not.toThrow();
  });

  it("writes the bare method through unchanged when no route resolved", () => {
    // The most common shape in prod by a distance. `next.span_name` is stamped
    // at span creation from the bare method and only rewritten if `next.route`
    // resolves, so on the majority of the 11,750 measured spans it is still
    // `"GET"`. Copying it writes back the resource Datadog already derives,
    // which is the whole point: the alternative is inventing a route name for a
    // request that never matched a route.
    const span = fakeSpan(SpanKind.SERVER, {
      [ATTR_NEXT_SPAN_NAME]: BARE_METHOD_SPAN_NAME,
    });

    new RouteResourceSpanProcessor().onEnding(span);

    expect(span.written[ATTR_DATADOG_RESOURCE_NAME]).toBe(
      BARE_METHOD_SPAN_NAME
    );
  });

  it("copies the RSC route shape verbatim", () => {
    // Next's third shape: an RSC request that resolved a route gets
    // `"RSC <METHOD> <route>"`. No `apps/api` route handler serves one, but
    // this processor ships in a shared package, and the shape is as bounded and
    // as resource-shaped as the other two — so it is copied, not filtered.
    const span = fakeSpan(SpanKind.SERVER, {
      [ATTR_NEXT_SPAN_NAME]: RSC_BRANCHES_SPAN_NAME,
    });

    new RouteResourceSpanProcessor().onEnding(span);

    expect(span.written[ATTR_DATADOG_RESOURCE_NAME]).toBe(
      RSC_BRANCHES_SPAN_NAME
    );
  });
});

describe("initTracing route-resource wiring", () => {
  it("stamps the resource name on a SERVER span produced by the live tracer", () => {
    enableTracingEnv();
    expect(initTracing().enabled).toBe(true);

    // Driven through the globally registered provider and a real `end()`, so
    // this fails if the processor is dropped from `createTracerProvider`'s
    // `spanProcessors`, and equally if `onEnding` stops being the hook the SDK
    // calls while the span is still mutable.
    const span = trace.getTracer("test").startSpan("GET", {
      kind: SpanKind.SERVER,
      attributes: { [ATTR_NEXT_SPAN_NAME]: BRANCHES_SPAN_NAME },
    });
    span.end();

    const ended = span as unknown as ReadableSpan;
    expect(ended.attributes[ATTR_DATADOG_RESOURCE_NAME]).toBe(
      BRANCHES_SPAN_NAME
    );
  });

  it("leaves a CLIENT fetch span produced by the live tracer untouched", () => {
    enableTracingEnv();
    expect(initTracing().enabled).toBe(true);

    const span = trace.getTracer("test").startSpan("fetch GET", {
      kind: SpanKind.CLIENT,
      attributes: { [ATTR_NEXT_SPAN_NAME]: GITHUB_FETCH_SPAN_NAME },
    });
    span.end();

    const ended = span as unknown as ReadableSpan;
    expect(ended.attributes[ATTR_DATADOG_RESOURCE_NAME]).toBeUndefined();
  });
});
