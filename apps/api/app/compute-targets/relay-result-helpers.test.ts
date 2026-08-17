/**
 * Coverage for the relay-result helpers (3% → covered).
 *
 * These decide what a Desktop relay result becomes on the wire: which event
 * type it is, and what data rides with it. `resolveEventType` in particular
 * encodes a PRECEDENCE (error beats done beats the payload's own type) that
 * nothing pinned before.
 */

import { describe, expect, it } from "vitest";
import {
  isOneShotRelayResult,
  resolveEventType,
  toCommandEventData,
  toTerminalResultData,
} from "./relay-result-helpers";

type StreamingResult = Parameters<typeof toCommandEventData>[2];

const streaming = (
  overrides: Partial<{ event: unknown; error: string; done: boolean }> = {}
): StreamingResult => ({ event: {}, ...overrides }) as StreamingResult;

describe("isOneShotRelayResult", () => {
  it("discriminates on the presence of `result`", () => {
    expect(
      isOneShotRelayResult({ result: "done" } as Parameters<
        typeof isOneShotRelayResult
      >[0])
    ).toBe(true);
    expect(
      isOneShotRelayResult({ event: {} } as Parameters<
        typeof isOneShotRelayResult
      >[0])
    ).toBe(false);
  });

  it("treats an explicitly null result as one-shot", () => {
    // `in` tests presence, not truthiness — a null result is still a result.
    expect(
      isOneShotRelayResult({ result: null } as Parameters<
        typeof isOneShotRelayResult
      >[0])
    ).toBe(true);
  });
});

describe("toTerminalResultData", () => {
  it("stamps terminal onto an object result, preserving its fields", () => {
    expect(toTerminalResultData({ ok: true, count: 2 })).toEqual({
      ok: true,
      count: 2,
      terminal: true,
    });
  });

  it("wraps a non-object result under `value` rather than losing it", () => {
    expect(toTerminalResultData("finished")).toEqual({
      value: "finished",
      terminal: true,
    });
    expect(toTerminalResultData(42)).toEqual({ value: 42, terminal: true });
    expect(toTerminalResultData(null)).toEqual({ value: null, terminal: true });
  });

  it("lets an existing terminal field be overwritten to true", () => {
    expect(toTerminalResultData({ terminal: false })).toEqual({
      terminal: true,
    });
  });

  it("wraps an array rather than spreading it into an object", () => {
    // An array is not a record, so it must go under `value` — spreading would
    // turn [1,2] into {0:1,1:2} and lose the shape.
    expect(toTerminalResultData([1, 2])).toEqual({
      value: [1, 2],
      terminal: true,
    });
  });
});

describe("resolveEventType", () => {
  it("passes through each recognized payload type", () => {
    for (const t of ["status", "chunk", "result", "error", "done"] as const) {
      expect(resolveEventType({ type: t })).toBe(t);
    }
  });

  it("maps `text` onto chunk", () => {
    expect(resolveEventType({ type: "text" })).toBe("chunk");
  });

  it("defaults an unknown or absent type to chunk", () => {
    expect(resolveEventType({ type: "something_new" })).toBe("chunk");
    expect(resolveEventType({})).toBe("chunk");
    expect(resolveEventType({ type: 42 })).toBe("chunk");
  });

  it("lets an error argument OVERRIDE the payload's own type", () => {
    // Precedence matters: a failing command must not report as a status/chunk
    // just because the payload said so.
    expect(resolveEventType({ type: "status" }, "boom")).toBe("error");
    expect(resolveEventType({ type: "done" }, "boom")).toBe("error");
  });

  it("ranks error ABOVE done when both are supplied", () => {
    expect(resolveEventType({ type: "chunk" }, "boom", true)).toBe("error");
  });

  it("lets done override the payload type when there is no error", () => {
    expect(resolveEventType({ type: "chunk" }, undefined, true)).toBe("done");
  });

  it("treats done=false as not-done rather than truthy-checking it", () => {
    expect(resolveEventType({ type: "chunk" }, undefined, false)).toBe("chunk");
  });

  it("treats an empty-string error as no error", () => {
    // `if (error)` is a truthiness test, so "" must not become an error event.
    expect(resolveEventType({ type: "status" }, "")).toBe("status");
  });
});

describe("toCommandEventData — error events", () => {
  it("prefers the result's error over the payload's", () => {
    expect(
      toCommandEventData(
        { error: "from-payload" },
        "error",
        streaming({ error: "from-result" })
      )
    ).toMatchObject({ error: "from-result" });
  });

  it("falls back to the payload error when the result carries none", () => {
    expect(
      toCommandEventData({ error: "from-payload" }, "error", streaming())
    ).toMatchObject({ error: "from-payload" });
  });

  it("supplies a default message when neither side names the failure", () => {
    // Never emit an error event with no error text — the client has nothing
    // to show.
    expect(toCommandEventData({}, "error", streaming())).toMatchObject({
      error: "Command failed",
    });
  });

  it("ignores a non-string payload error and uses the default", () => {
    expect(
      toCommandEventData({ error: 500 }, "error", streaming())
    ).toMatchObject({ error: "Command failed" });
  });

  it("defaults terminal to true, and honors an explicit done", () => {
    expect(toCommandEventData({}, "error", streaming())).toMatchObject({
      terminal: true,
    });
    expect(
      toCommandEventData({}, "error", streaming({ done: false }))
    ).toMatchObject({ terminal: false });
  });

  it("preserves the rest of the payload alongside the error", () => {
    expect(
      toCommandEventData({ requestId: "r1" }, "error", streaming())
    ).toMatchObject({ requestId: "r1" });
  });
});

describe("toCommandEventData — done and chunk events", () => {
  it("returns the result event for a done event when it is an object", () => {
    expect(
      toCommandEventData({}, "done", streaming({ event: { exitCode: 0 } }))
    ).toEqual({ exitCode: 0 });
  });

  it("substitutes an explicit not-cancelled marker for a non-object done event", () => {
    expect(
      toCommandEventData({}, "done", streaming({ event: "finished" }))
    ).toEqual({ cancelled: false });
  });

  it("passes the event straight through for a chunk", () => {
    expect(
      toCommandEventData({}, "chunk", streaming({ event: { text: "hi" } }))
    ).toEqual({ text: "hi" });
  });

  it("falls back to an empty object when a non-terminal event is absent", () => {
    expect(
      toCommandEventData({}, "chunk", streaming({ event: undefined }))
    ).toEqual({});
  });
});
