import { describe, expect, it, vi } from "vitest";
import { withAppSpan } from "../spans";

const otel = vi.hoisted(() => {
  const activeSpan = { isRecording: vi.fn(() => true) };
  const childSpan = {
    end: vi.fn(),
    isRecording: vi.fn(() => true),
    recordException: vi.fn(),
    setAttributes: vi.fn(),
    setStatus: vi.fn(),
  };
  return {
    activeSpan,
    childSpan,
    startActiveSpan: vi.fn((_name: string, body: (span: unknown) => unknown) =>
      body(childSpan)
    ),
  };
});

vi.mock("@opentelemetry/api", () => ({
  SpanStatusCode: { ERROR: 2 },
  context: { active: () => ({}) },
  trace: {
    getSpan: () => otel.activeSpan,
    getTracer: () => ({ startActiveSpan: otel.startActiveSpan }),
  },
}));

describe("withAppSpan", () => {
  it("marks synchronous failures as span errors", () => {
    const error = new Error("sync failure");

    expect(() =>
      withAppSpan("test.sync", () => {
        throw error;
      })
    ).toThrow(error);

    expect(otel.childSpan.recordException).toHaveBeenCalledWith(error);
    expect(otel.childSpan.setStatus).toHaveBeenCalledWith({ code: 2 });
    expect(otel.childSpan.end).toHaveBeenCalled();
  });

  it("marks asynchronous failures as span errors", async () => {
    const error = new Error("async failure");

    await expect(
      withAppSpan("test.async", () => Promise.reject(error))
    ).rejects.toThrow(error);

    expect(otel.childSpan.recordException).toHaveBeenCalledWith(error);
    expect(otel.childSpan.setStatus).toHaveBeenCalledWith({ code: 2 });
    expect(otel.childSpan.end).toHaveBeenCalled();
  });
});
