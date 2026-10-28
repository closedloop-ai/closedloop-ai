import { context, SpanKind, trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSpanFlushHook } from "../hooks";
import { initTracing, resetTracingForTest } from "../provider";
import { stubEnabledTracingEnv } from "./tracing-env";

// The retention filter in example-infrastructure matches this literal, so it is
// spelled out rather than imported.
const ATTR_SESSION_MESH = "cl.session_mesh";
const ATTR_DATADOG_RESOURCE_NAME = "resource.name";
const ATTR_NEXT_SPAN_NAME = "next.span_name";

beforeEach(() => {
  resetSpanFlushHook();
  stubEnabledTracingEnv();
  vi.stubEnv("DD_TRACE_SAMPLE_RATE", "1.0");
  // Otherwise shutdown retries the unreachable endpoint for ~8.5s, close to
  // the 10s hook timeout.
  vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_TIMEOUT", "50");
  initTracing();
});

afterEach(async () => {
  await resetTracingForTest();
  vi.unstubAllEnvs();
});

/** Next's root request span, then a pg child and its grandchild under it. */
function traceRequest(target: string): ReadableSpan[] {
  const tracer = trace.getTracer("test");
  const root = tracer.startSpan("POST", {
    kind: SpanKind.SERVER,
    attributes: { "http.method": "POST", "http.target": target },
  });
  const child = tracer.startSpan(
    "pg.query:SELECT",
    { kind: SpanKind.CLIENT, attributes: { "db.system.name": "postgresql" } },
    trace.setSpan(context.active(), root)
  );
  const grandchild = tracer.startSpan(
    "pg.query:INSERT",
    { kind: SpanKind.CLIENT },
    trace.setSpan(context.active(), child)
  );
  grandchild.end();
  child.end();
  // Next writes the route as the request ends, after its children ended.
  root.setAttribute(ATTR_NEXT_SPAN_NAME, `POST ${target.split("?")[0]}`);
  root.end();
  return [root, child, grandchild] as unknown as ReadableSpan[];
}

describe("SessionMeshSpanProcessor", () => {
  it("marks a Session Mesh request's root and every descendant span", () => {
    const [root, child, grandchild] = traceRequest(
      "/session-mesh/presence?agentId=a1"
    );

    expect(root.attributes[ATTR_SESSION_MESH]).toBe(true);
    expect(child.attributes[ATTR_SESSION_MESH]).toBe(true);
    expect(grandchild.attributes[ATTR_SESSION_MESH]).toBe(true);
    expect(root.attributes["http.target"]).toBe(
      "/session-mesh/presence?agentId=a1"
    );
    expect(root.attributes[ATTR_DATADOG_RESOURCE_NAME]).toBe(
      "POST /session-mesh/presence"
    );
  });

  it("leaves a route that only contains the words unmarked", () => {
    // A real cl-api cron route; it stays at the full cl-api retention rate.
    const spans = traceRequest("/cron/cleanup-session-mesh");

    expect(spans[0].attributes["http.target"]).toBe(
      "/cron/cleanup-session-mesh"
    );
    expect(spans.map((span) => span.attributes[ATTR_SESSION_MESH])).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});
