import { describe, expect, it } from "vitest";
import { msToIso, pushTurnDuration, toIso } from "./parser-utils";
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

describe("one normalizer (ISS-6738)", () => {
  // `isoTs` and `toIso` were separate implementations that disagreed on the same
  // input. There is one function and one name now, so the properties below are
  // true by construction rather than by two suites happening to agree.

  it("agrees on the sub-1e12 epoch that used to differ by 31 years", () => {
    // Was: toIso -> 1970-01-12 (raw ms), toIso -> 2001-09-09 (seconds).
    expect(toIso(1_000_000_000)).toBe(toIso(1_000_000_000));
    expect(toIso(1_000_000_000)).toBe("2001-09-09T01:46:40.000Z");
  });

  it("keeps a NEGATIVE epoch in milliseconds, not seconds", () => {
    // The magnitude heuristic reads a POSITIVE sub-1e12 value as seconds. Applied
    // to negatives it silently rescaled every pre-1970 millisecond epoch.
    expect(toIso(-1)).toBe("1969-12-31T23:59:59.999Z");
  });

  it("normalizes a zone-less string as UTC, so output cannot vary by machine", () => {
    // `new Date("July 9, 2026")` is LOCAL midnight, so the old branch made the
    // parser's output depend on the timezone of the machine that ran it. Naming
    // the zone keeps the value and makes it deterministic.
    expect(toIso("July 9, 2026")).toBe("2026-07-09T00:00:00.000Z");
    expect(toIso("2026-07-09T12:00:00")).toBe("2026-07-09T12:00:00.000Z");
  });

  it("returns null for text that is not a datetime at all", () => {
    // It used to be echoed back, so `"not-a-date"` reached `startedAt`/`endedAt`
    // and sorted lexically against real ISO stamps.
    expect(toIso("not-a-date")).toBeNull();
    expect(toIso("")).toBeNull();
  });

  it("is idempotent, which is what makes the chained sidecar lane safe", () => {
    // The scanner normalizes, then claude-parser normalizes the result again.
    // With two implementations that second pass re-parsed the first's output.
    const once = toIso("2026-07-09T12:00:00.000Z");
    expect(toIso(once)).toBe(once);
  });
});

// ---------------------------------------------------------------------------
// msToIso — the epoch-MILLISECONDS reading, for callers that already know the unit
// ---------------------------------------------------------------------------

describe("msToIso — no seconds heuristic", () => {
  it("reads a sub-1e12 value as milliseconds rather than scaling it", () => {
    // The whole reason this exists next to `toIso`. Every stamp before
    // 2001-09-09 is under 1e12, so `toIso` would multiply it by 1000.
    expect(msToIso(1_000_000_000)).toBe(new Date(1_000_000_000).toISOString());
    expect(msToIso(1_000_000_000)).not.toBe(toIso(1_000_000_000));
  });

  it("agrees with toIso once the value is unambiguously milliseconds", () => {
    expect(msToIso(1_700_000_000_000)).toBe(toIso(1_700_000_000_000));
  });

  it("keeps the ISS-6417 guard: an epoch no Date can hold is null, not a throw", () => {
    // Guards the CONSTRUCTED Date, not `Number.isFinite` — 9e15 is finite and
    // still exceeds the ±8.64e15 a Date can hold.
    expect(msToIso(9_000_000_000_000_000)).toBeNull();
    expect(msToIso(Number.NaN)).toBeNull();
  });

  it("keeps a corrupt 1970 span from swallowing a later event under lexical containment", () => {
    // The activity-metrics failure this fix exists for. `segmentIndexAt` compares
    // ISO strings lexically, and `session_activity_segments.start_ms` is a
    // persisted bigint — a trust boundary, so a corrupt sub-1e12 span is
    // reachable. Scaled by 1000 a 1970 span becomes 2001→2033, which then
    // CONTAINS a real 2026 token event that never belonged to it, and its spend
    // is attributed to the wrong segment (whitlockk, ISS-6738 review).
    const startMs = 1_000_000_000; // 1970-01-12
    const endMs = 2_000_000_000; // 1970-01-24
    const eventIso = new Date(1_772_000_000_000).toISOString(); // 2026

    const scaledStart = toIso(startMs) as string;
    const scaledEnd = toIso(endMs) as string;
    expect(eventIso >= scaledStart && eventIso < scaledEnd).toBe(true); // the bug

    const start = msToIso(startMs) as string;
    const end = msToIso(endMs) as string;
    expect(eventIso >= start && eventIso < end).toBe(false); // the fix
  });
});
