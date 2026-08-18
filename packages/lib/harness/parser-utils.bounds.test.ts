/**
 * ISS-6733: `noteTimestamp` and `pushTurnDuration` — the two parser-utils
 * functions that mutate a caller-owned accumulator rather than returning a value.
 *
 * `noteTimestamp` had ZERO test files. It is what every harness parser uses to
 * derive a session's first/last timestamp, so a broken comparison here does not
 * crash anything — it reports a session that started or ended at the wrong time,
 * which is the quiet kind of wrong.
 *
 * `pushTurnDuration` is the guard that keeps a negative or non-finite duration
 * out of the turn-duration series. A negative duration is not merely odd: it
 * makes averages and totals smaller than reality, so the failure is an
 * understated number rather than a visible error.
 */
import { describe, expect, it } from "vitest";
import { noteTimestamp, pushTurnDuration, safeJson } from "./parser-utils";
import type { NormalizedTurnDuration } from "./types";

function emptyBounds(): {
  firstTimestamp: string | null;
  lastTimestamp: string | null;
} {
  return { firstTimestamp: null, lastTimestamp: null };
}

describe("noteTimestamp", () => {
  it("seeds both bounds from the first timestamp it sees", () => {
    const bounds = emptyBounds();
    expect(noteTimestamp(bounds, "2026-07-09T12:00:00.000Z")).toBe(
      "2026-07-09T12:00:00.000Z"
    );
    expect(bounds.firstTimestamp).toBe("2026-07-09T12:00:00.000Z");
    expect(bounds.lastTimestamp).toBe("2026-07-09T12:00:00.000Z");
  });

  it("widens the window in BOTH directions, independently", () => {
    const bounds = emptyBounds();
    noteTimestamp(bounds, "2026-07-09T12:00:00.000Z");
    noteTimestamp(bounds, "2026-07-09T14:00:00.000Z");
    noteTimestamp(bounds, "2026-07-09T10:00:00.000Z");
    expect(bounds.firstTimestamp).toBe("2026-07-09T10:00:00.000Z");
    expect(bounds.lastTimestamp).toBe("2026-07-09T14:00:00.000Z");
  });

  it("does not move a bound when the new stamp is inside the window", () => {
    // The comparison, not just the assignment: a mutant that always overwrites
    // reports the LAST record's time as the session's start.
    const bounds = emptyBounds();
    noteTimestamp(bounds, "2026-07-09T10:00:00.000Z");
    noteTimestamp(bounds, "2026-07-09T14:00:00.000Z");
    noteTimestamp(bounds, "2026-07-09T12:00:00.000Z");
    expect(bounds.firstTimestamp).toBe("2026-07-09T10:00:00.000Z");
    expect(bounds.lastTimestamp).toBe("2026-07-09T14:00:00.000Z");
  });

  it("returns null and leaves the bounds untouched for an unusable stamp", () => {
    const bounds = emptyBounds();
    noteTimestamp(bounds, "2026-07-09T12:00:00.000Z");
    expect(noteTimestamp(bounds, null)).toBeNull();
    expect(noteTimestamp(bounds, undefined)).toBeNull();
    expect(noteTimestamp(bounds, { at: 1 })).toBeNull();
    expect(bounds.firstTimestamp).toBe("2026-07-09T12:00:00.000Z");
    expect(bounds.lastTimestamp).toBe("2026-07-09T12:00:00.000Z");
  });

  it("normalizes an epoch number before comparing it", () => {
    // Bounds are compared as ISO STRINGS, so a raw epoch that skipped
    // normalization would sort against them lexically and corrupt the window.
    const bounds = emptyBounds();
    noteTimestamp(bounds, "2026-07-09T12:00:00.000Z");
    noteTimestamp(bounds, 1_000_000_000_000);
    expect(bounds.firstTimestamp).toBe("2001-09-09T01:46:40.000Z");
    expect(bounds.lastTimestamp).toBe("2026-07-09T12:00:00.000Z");
  });
});

describe("pushTurnDuration", () => {
  it("pushes a duration stamped at the END of the turn", () => {
    const out: NormalizedTurnDuration[] = [];
    pushTurnDuration(
      out,
      "2026-07-09T12:00:00.000Z",
      "2026-07-09T12:00:05.000Z"
    );
    expect(out).toEqual([
      { durationMs: 5000, timestamp: "2026-07-09T12:00:05.000Z" },
    ]);
  });

  it("requires BOTH timestamps, not either", () => {
    const out: NormalizedTurnDuration[] = [];
    pushTurnDuration(out, null, "2026-07-09T12:00:05.000Z");
    pushTurnDuration(out, "2026-07-09T12:00:00.000Z", null);
    pushTurnDuration(out, null, null);
    expect(out).toHaveLength(0);
  });

  it("rejects a negative duration instead of recording it", () => {
    // An out-of-order pair would otherwise book negative time, pulling every
    // average and total below the truth.
    const out: NormalizedTurnDuration[] = [];
    pushTurnDuration(
      out,
      "2026-07-09T12:00:05.000Z",
      "2026-07-09T12:00:00.000Z"
    );
    expect(out).toHaveLength(0);
  });

  it("keeps a zero-length turn, which is legitimate", () => {
    // The guard is `< 0`, not `<= 0`: a same-instant turn really happened.
    const out: NormalizedTurnDuration[] = [];
    pushTurnDuration(
      out,
      "2026-07-09T12:00:00.000Z",
      "2026-07-09T12:00:00.000Z"
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.durationMs).toBe(0);
  });

  it("rejects an unparseable stamp rather than pushing NaN", () => {
    const out: NormalizedTurnDuration[] = [];
    pushTurnDuration(out, "not-a-date", "2026-07-09T12:00:05.000Z");
    pushTurnDuration(out, "2026-07-09T12:00:00.000Z", "not-a-date");
    expect(out).toHaveLength(0);
  });
});

describe("safeJson — absent vs unreadable", () => {
  it("maps undefined to null rather than passing it through", () => {
    // `null` and `undefined` diverge here: without the null-guard, `undefined`
    // falls past the object and string branches and is returned verbatim, so a
    // caller checking `=== null` for absence silently stops matching.
    expect(safeJson(undefined)).toBeNull();
    expect(safeJson(null)).toBeNull();
  });

  it("returns a non-JSON string verbatim rather than dropping it", () => {
    // Distinct from parse-claude's `parseJsonValue`, which returns undefined on
    // failure. Here an unparseable string is still the best available value.
    expect(safeJson("{not json")).toBe("{not json");
    expect(safeJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns objects and non-string primitives as-is", () => {
    const obj = { a: 1 };
    expect(safeJson(obj)).toBe(obj);
    expect(safeJson(42)).toBe(42);
    expect(safeJson(true)).toBe(true);
  });
});
