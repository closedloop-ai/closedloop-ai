import { describe, expect, it } from "vitest";
import { pushTurnDuration, toIso } from "./parser-utils";
import type { NormalizedTurnDuration } from "./types";

// ---------------------------------------------------------------------------
// toIso — number branch (line 92 – 95)
// ---------------------------------------------------------------------------

describe("toIso — seconds-epoch input (<1e12)", () => {
  it("multiplies a seconds-epoch by 1000 before constructing the Date", () => {
    // 1_700_000_000 s × 1000 → 2023-11-14T22:13:20.000Z
    // If the multiply-by-1000 branch were folded away the result would be the
    // 1970 epoch for the raw value, not a 2023 date.
    const resultSec = toIso(1_700_000_000);
    const resultMs = toIso(1_700_000_000_000);
    expect(resultSec).toBe(resultMs); // same moment, different unit
    expect(resultSec).toBe(new Date(1_700_000_000_000).toISOString());
    expect(resultSec).not.toBe(new Date(1_700_000_000).toISOString()); // falsify
  });
});

describe("toIso — ms-epoch input (>=1e12)", () => {
  it("uses a ms-epoch (>=1e12) directly without multiplying by 1000", () => {
    // 1_700_000_000_000 >= 1e12, so no multiplication
    expect(toIso(1_700_000_000_000)).toBe(
      new Date(1_700_000_000_000).toISOString()
    );
  });

  it("boundary: 1e12 exactly is treated as ms-epoch", () => {
    // At exactly 1e12 the condition ts < 1e12 is false → no multiply
    expect(toIso(1e12)).toBe(new Date(1e12).toISOString());
  });
});

describe("toIso — invalid number", () => {
  it("returns null for NaN (unparseable numeric timestamp)", () => {
    expect(toIso(Number.NaN)).toBeNull();
  });

  it("returns null for Infinity (isNaN(new Date(Infinity).getTime()) is true)", () => {
    expect(toIso(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("toIso — non-null non-number non-string fallthrough (implicit else, line ~101)", () => {
  it("returns null for a plain object (not null, not number, not string)", () => {
    expect(toIso({})).toBeNull();
  });

  it("returns null for an array", () => {
    expect(toIso([])).toBeNull();
  });

  it("returns null for a boolean", () => {
    expect(toIso(true)).toBeNull();
    expect(toIso(false)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pushTurnDuration — lines 553-568
// ---------------------------------------------------------------------------

describe("pushTurnDuration", () => {
  it("does not push when startedAt is null (early return)", () => {
    const durations: NormalizedTurnDuration[] = [];
    pushTurnDuration(durations, null, "2024-01-01T00:00:01.000Z");
    expect(durations).toEqual([]);
  });

  it("does not push when endedAt is null (early return)", () => {
    const durations: NormalizedTurnDuration[] = [];
    pushTurnDuration(durations, "2024-01-01T00:00:00.000Z", null);
    expect(durations).toEqual([]);
  });

  it("does not push when both timestamps are null", () => {
    const durations: NormalizedTurnDuration[] = [];
    pushTurnDuration(durations, null, null);
    expect(durations).toEqual([]);
  });

  it("does not push when endedAt is before startedAt (negative durationMs)", () => {
    // durationMs = endedAt - startedAt < 0 → guard skips the push
    const durations: NormalizedTurnDuration[] = [];
    pushTurnDuration(
      durations,
      "2024-01-01T00:00:05.000Z",
      "2024-01-01T00:00:00.000Z"
    );
    expect(durations).toEqual([]);
  });

  it("pushes a valid entry with exact durationMs when endedAt > startedAt", () => {
    const durations: NormalizedTurnDuration[] = [];
    pushTurnDuration(
      durations,
      "2024-01-01T00:00:00.000Z",
      "2024-01-01T00:00:05.000Z"
    );
    expect(durations).toHaveLength(1);
    expect(durations[0].durationMs).toBe(5000);
    expect(durations[0].timestamp).toBe("2024-01-01T00:00:05.000Z");
  });

  it("pushes a zero-durationMs entry when both timestamps are identical", () => {
    const durations: NormalizedTurnDuration[] = [];
    pushTurnDuration(
      durations,
      "2024-06-01T10:00:00.000Z",
      "2024-06-01T10:00:00.000Z"
    );
    expect(durations).toHaveLength(1);
    expect(durations[0].durationMs).toBe(0);
  });

  it("accumulates multiple entries across repeated calls", () => {
    const durations: NormalizedTurnDuration[] = [];
    pushTurnDuration(
      durations,
      "2024-01-01T00:00:00.000Z",
      "2024-01-01T00:00:02.000Z"
    );
    pushTurnDuration(
      durations,
      "2024-01-01T00:00:03.000Z",
      "2024-01-01T00:00:04.000Z"
    );
    expect(durations).toHaveLength(2);
    expect(durations[0].durationMs).toBe(2000);
    expect(durations[1].durationMs).toBe(1000);
  });
});
