import { describe, expect, it } from "vitest";
import {
  parseTraceDurationMs,
  TRACE_DURATION_MAX_CHARS,
} from "./trace-duration";

const SECOND_MS = 1000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

describe("parseTraceDurationMs (ISS-4675)", () => {
  it("reads every shape formatTraceDuration emits", () => {
    // `apps/desktop/src/main/database/session-trace-duration.ts`.
    expect(parseTraceDurationMs("45s")).toBe(45 * SECOND_MS);
    expect(parseTraceDurationMs("30m")).toBe(30 * MINUTE_MS);
    expect(parseTraceDurationMs("4h")).toBe(4 * HOUR_MS);
    expect(parseTraceDurationMs("4h 54m")).toBe(4 * HOUR_MS + 54 * MINUTE_MS);
    expect(parseTraceDurationMs("3h 33m")).toBe(3 * HOUR_MS + 33 * MINUTE_MS);
  });

  it("also reads the calendar-fallback formatDuration shapes", () => {
    // `packages/app/shared/lib/format-utils.ts` emits "30m 12s" / "4h 54m" /
    // "12s" — a row whose Duration came from the fallback must still parse.
    expect(parseTraceDurationMs("30m 12s")).toBe(
      30 * MINUTE_MS + 12 * SECOND_MS
    );
    expect(parseTraceDurationMs("12s")).toBe(12 * SECOND_MS);
  });

  it("tolerates surrounding whitespace and mixed case", () => {
    expect(parseTraceDurationMs("  4H 54M  ")).toBe(
      4 * HOUR_MS + 54 * MINUTE_MS
    );
  });

  it("distinguishes a MEASURED zero from an unreadable value", () => {
    // "0s" is a real measurement (0 ms); an unreadable value is `null` so the
    // caller falls back to its own derivation instead of ordering/dividing by a
    // fabricated zero.
    expect(parseTraceDurationMs("0s")).toBe(0);
    expect(parseTraceDurationMs("unknown")).toBeNull();
    expect(parseTraceDurationMs("—")).toBeNull();
    expect(parseTraceDurationMs("")).toBeNull();
    expect(parseTraceDurationMs("   ")).toBeNull();
    expect(parseTraceDurationMs(null)).toBeNull();
    expect(parseTraceDurationMs(undefined)).toBeNull();
  });

  it("returns null (never NaN) for a unit token that names an Object.prototype member", () => {
    // The unit is a token lifted from a cross-repo payload string. On a plain
    // `{}` lookup table these resolve to inherited members rather than
    // `undefined`, sail past the unknown-unit guard, and yield NaN.
    expect(parseTraceDurationMs("5constructor")).toBeNull();
    expect(parseTraceDurationMs("5toString")).toBeNull();
    expect(parseTraceDurationMs("4h 5valueOf")).toBeNull();
  });

  it("degrades to null (not a partial) on an unknown unit from a newer producer", () => {
    // Cross-repo skew: a future Desktop build adding a `d` (days) token must not
    // crash — and must not silently drop the largest component, which would sort
    // a 2-day session as a 4-hour one.
    expect(parseTraceDurationMs("2d 4h")).toBeNull();
    expect(parseTraceDurationMs("3d")).toBeNull();
  });

  it("keeps a legacy baked-in label from breaking the parse", () => {
    // FEA-4275 legacy `waitingUser` values baked the label into the string.
    expect(parseTraceDurationMs("41s idle")).toBe(41 * SECOND_MS);
    expect(parseTraceDurationMs("4h 54m IDLE")).toBe(
      4 * HOUR_MS + 54 * MINUTE_MS
    );
    // The bare legacy label carries no measurement at all.
    expect(parseTraceDurationMs("idle")).toBeNull();
  });

  it("rejects a PARTIALLY matched payload instead of reading the fragment it recognizes", () => {
    // The field crosses the sync boundary as an arbitrary trimmed string, so a
    // corrupt or version-skewed value is reachable at runtime. A scanning parse
    // turned "-5m" into a POSITIVE five minutes while the Duration cell printed
    // "-5m", and read "garbage 5m" as five minutes — the sort and the event-rate
    // denominator then used that plausible-but-wrong number instead of taking
    // their safe calendar/null fallback.
    expect(parseTraceDurationMs("-5m")).toBeNull();
    expect(parseTraceDurationMs("garbage 5m")).toBeNull();
    expect(parseTraceDurationMs("5m garbage")).toBeNull();
    expect(parseTraceDurationMs("~4h 54m")).toBeNull();
    expect(parseTraceDurationMs("4h, 54m")).toBeNull();
    expect(parseTraceDurationMs("about 4h")).toBeNull();
    // A digit run with no unit is not a duration either.
    expect(parseTraceDurationMs("4h 54")).toBeNull();
  });

  it("rejects a value longer than the ingest bound", () => {
    // The bound exists because these strings are bulk-read into the 10,000-row
    // duration-sort candidate scan; the sync boundary caps them at the same
    // width, and this reader refuses anything longer even if a legacy row
    // predates the cap.
    const overLong = `${"9".repeat(TRACE_DURATION_MAX_CHARS)}h 54m`;
    expect(overLong.length).toBeGreaterThan(TRACE_DURATION_MAX_CHARS);
    expect(parseTraceDurationMs(overLong)).toBeNull();
    // ...and a legitimately wide value still fits inside the bound.
    expect("99999h 59m idle".length).toBeLessThanOrEqual(
      TRACE_DURATION_MAX_CHARS
    );
    expect(parseTraceDurationMs("99999h 59m idle")).toBe(
      99_999 * HOUR_MS + 59 * MINUTE_MS
    );
  });
});
