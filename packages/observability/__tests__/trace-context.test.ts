import { afterEach, describe, expect, it } from "vitest";
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

afterEach(() => {
  resetTraceContextProvider();
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
