import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTraceContext,
  resetTraceContextProvider,
  setTraceContextProvider,
  toLogCorrelationFields,
} from "../trace-context";

// ---------------------------------------------------------------------------
// trace-context.ts — the no-OTel indirection the logger reads the active trace
// through (ISS-4659).
//
// The contract that matters: with nothing registered this is inert, and a
// misbehaving provider can never break a log call. Both are what keep the
// logger safe to import from client components.
// ---------------------------------------------------------------------------

const SAMPLE_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SAMPLE_SPAN_ID = "00f067aa0ba902b7";

// The slot is process-wide since ISS-5857, so the unregistered state these
// cases assert against has to be established, not assumed from a fresh module.
beforeEach(() => {
  resetTraceContextProvider();
});

afterEach(() => {
  resetTraceContextProvider();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("getTraceContext", () => {
  it("returns undefined when no provider is registered", () => {
    expect(getTraceContext()).toBeUndefined();
  });

  it("returns the active context once a provider is registered", () => {
    setTraceContextProvider(() => ({
      traceId: SAMPLE_TRACE_ID,
      spanId: SAMPLE_SPAN_ID,
    }));

    expect(getTraceContext()).toEqual({
      traceId: SAMPLE_TRACE_ID,
      spanId: SAMPLE_SPAN_ID,
    });
  });

  it("returns undefined when the registered provider reports no active span", () => {
    setTraceContextProvider(() => undefined);

    expect(getTraceContext()).toBeUndefined();
  });

  it("swallows a throwing provider rather than failing the caller", () => {
    setTraceContextProvider(() => {
      throw new Error("tracer exploded");
    });

    expect(() => getTraceContext()).not.toThrow();
    expect(getTraceContext()).toBeUndefined();
  });

  it("restores the inert default after reset", () => {
    setTraceContextProvider(() => ({
      traceId: SAMPLE_TRACE_ID,
      spanId: SAMPLE_SPAN_ID,
    }));
    resetTraceContextProvider();

    expect(getTraceContext()).toBeUndefined();
  });
});

describe("browser runtimes (ISS-5857)", () => {
  /**
   * The registered-symbol key is discoverable by anything sharing the realm, so
   * this is the write a third-party script or an XSS payload can make. Spelling
   * it out literally is the point of the test: it is the attacker's view of the
   * key, not a second declaration of ours.
   */
  function plantProviderOnGlobalThis(): void {
    (globalThis as Record<symbol, unknown>)[
      Symbol.for("closedloop.observability.traceContextProvider")
    ] = () => ({ traceId: SAMPLE_TRACE_ID, spanId: SAMPLE_SPAN_ID });
  }

  it("ignores a provider planted on globalThis by browser-side code", async () => {
    vi.stubGlobal("window", {});
    vi.resetModules();
    const browserModule = await import("../trace-context");
    plantProviderOnGlobalThis();

    expect(browserModule.getTraceContext()).toBeUndefined();
  });

  it("still honors a planted provider on the server, so the gate is what differs", async () => {
    vi.resetModules();
    const serverModule = await import("../trace-context");
    plantProviderOnGlobalThis();

    expect(serverModule.getTraceContext()).toEqual({
      traceId: SAMPLE_TRACE_ID,
      spanId: SAMPLE_SPAN_ID,
    });
  });

  it("does not write the slot from a browser runtime", async () => {
    vi.stubGlobal("window", {});
    vi.resetModules();
    const browserModule = await import("../trace-context");
    browserModule.setTraceContextProvider(() => ({
      traceId: SAMPLE_TRACE_ID,
      spanId: SAMPLE_SPAN_ID,
    }));

    // Read back through the SERVER module: a browser write must not become
    // visible to the server copy sharing the same realm.
    expect(getTraceContext()).toBeUndefined();
  });

  // ISS-6817 (review davetho) found this gap on the `tracing/hooks` sibling,
  // where it was the same defect: a DELETE is a write too, and the reset was the
  // one slot-touching function with no gate. The two slots are cleared by the
  // same line of `resetTracingForTest`, so fixing only one would have re-opened
  // the drift between these siblings.
  it("does not clear the slot from a browser runtime", async () => {
    plantProviderOnGlobalThis();
    vi.stubGlobal("window", {});
    vi.resetModules();
    const browserModule = await import("../trace-context");

    browserModule.resetTraceContextProvider();

    // Read back through the SERVER module: the planted value has to have
    // survived the browser copy's reset.
    expect(getTraceContext()).toEqual({
      traceId: SAMPLE_TRACE_ID,
      spanId: SAMPLE_SPAN_ID,
    });
  });
});

describe("toLogCorrelationFields", () => {
  it("maps the span identifiers onto the attributes Datadog joins traces on", () => {
    expect(
      toLogCorrelationFields({
        traceId: SAMPLE_TRACE_ID,
        spanId: SAMPLE_SPAN_ID,
      })
    ).toEqual({
      "dd.trace_id": SAMPLE_TRACE_ID,
      "dd.span_id": SAMPLE_SPAN_ID,
    });
  });
});
