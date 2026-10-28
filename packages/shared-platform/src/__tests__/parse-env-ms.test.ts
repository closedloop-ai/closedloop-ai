/**
 * Unit coverage for the shared timer-delay clamp.
 *
 * The value `parsePositiveEnvMs` RETURNS is the contract — it feeds
 * `setTimeout`/`setInterval` directly — so every case asserts the returned
 * number, not merely that a warning happened. The injected-sink cases exist
 * because the sink is the seam a caller uses to route the warning to its own
 * structured logger; a regression to console-only is otherwise invisible.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clampTimerDelayMs,
  type EnvWarnSink,
  MAX_TIMER_DELAY_MS,
  MIN_TIMER_DELAY_MS,
  parsePositiveEnvMs,
} from "../parse-env-ms.js";

const ENV_NAME = "SHARED_PLATFORM_TEST_THRESHOLD_MS";
const DEFAULT_MS = 60_000;

const INVALID_VALUES: ReadonlyArray<readonly [string, string]> = [
  ["empty string (Number('') === 0, which `??` cannot catch)", ""],
  ["whitespace only", "   "],
  ["non-numeric", "abc"],
  ["trailing garbage", "60000ms"],
  ["explicit zero", "0"],
  ["negative", "-1"],
  ["sub-millisecond, which a Node timer rounds up to 1ms", "0.5"],
  ["Infinity", "Infinity"],
  ["past the 32-bit timer ceiling, which fires immediately", "2147483648"],
];

describe("parsePositiveEnvMs", () => {
  let previous: string | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    previous = process.env[ENV_NAME];
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      // Silence the real stderr write; the spy is the assertion surface.
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, ENV_NAME);
    } else {
      process.env[ENV_NAME] = previous;
    }
  });

  it("returns the default and stays quiet when the variable is unset", () => {
    Reflect.deleteProperty(process.env, ENV_NAME);

    expect(parsePositiveEnvMs(ENV_NAME, DEFAULT_MS)).toBe(DEFAULT_MS);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns a valid positive override", () => {
    process.env[ENV_NAME] = "1500";

    expect(parsePositiveEnvMs(ENV_NAME, DEFAULT_MS)).toBe(1500);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["smallest", "1", 1],
    ["largest", "2147483647", 2_147_483_647],
  ])("accepts the %s delay a Node timer can hold", (_label, raw, expected) => {
    process.env[ENV_NAME] = raw;

    expect(parsePositiveEnvMs(ENV_NAME, DEFAULT_MS)).toBe(expected);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each(INVALID_VALUES)(
    "warns through the default console sink and falls back for %s",
    (_label, raw) => {
      process.env[ENV_NAME] = raw;

      expect(parsePositiveEnvMs(ENV_NAME, DEFAULT_MS)).toBe(DEFAULT_MS);
      expect(warnSpy).toHaveBeenCalledWith(
        `Invalid ${ENV_NAME}, defaulting to ${DEFAULT_MS}`,
        { value: raw }
      );
    }
  );

  it("routes the warning to an injected sink instead of the console", () => {
    const sink = vi.fn<EnvWarnSink>();
    process.env[ENV_NAME] = "-1";

    expect(parsePositiveEnvMs(ENV_NAME, DEFAULT_MS, sink)).toBe(DEFAULT_MS);
    expect(sink).toHaveBeenCalledWith(
      `Invalid ${ENV_NAME}, defaulting to ${DEFAULT_MS}`,
      { value: "-1" }
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("leaves an injected sink untouched when the value is valid", () => {
    const sink = vi.fn<EnvWarnSink>();
    process.env[ENV_NAME] = "1500";

    expect(parsePositiveEnvMs(ENV_NAME, DEFAULT_MS, sink)).toBe(1500);
    expect(sink).not.toHaveBeenCalled();
  });
});

describe("clampTimerDelayMs", () => {
  it("passes an in-range delay through untouched", () => {
    expect(clampTimerDelayMs(30_000)).toBe(30_000);
    expect(clampTimerDelayMs(MIN_TIMER_DELAY_MS)).toBe(MIN_TIMER_DELAY_MS);
    expect(clampTimerDelayMs(MAX_TIMER_DELAY_MS)).toBe(MAX_TIMER_DELAY_MS);
  });

  it("floors a sub-millisecond delay to 1 instead of dropping it", () => {
    // Truncating to 0 is the dangerous half: a downstream `> 0` guard reads it
    // as "no timeout", which is an unbounded wait, not a short one.
    expect(clampTimerDelayMs(0.5)).toBe(MIN_TIMER_DELAY_MS);
    expect(clampTimerDelayMs(0.001)).toBe(MIN_TIMER_DELAY_MS);
  });

  it("drops a nonpositive delay rather than flooring it to 1", () => {
    // The floor is only correct where there is a short-timeout intent to keep.
    // `0` and negatives carry none, and flooring them would abort an otherwise
    // valid command ~1ms after dispatch, so a version-skewed peer with junk in
    // this one optional field would lose every command it sends. Omitting it
    // is the absent-timeout path those values already take today.
    expect(clampTimerDelayMs(0)).toBeUndefined();
    expect(clampTimerDelayMs(-0)).toBeUndefined();
    expect(clampTimerDelayMs(-0.5)).toBeUndefined();
    expect(clampTimerDelayMs(-5)).toBeUndefined();
  });

  it("caps a delay past the 32-bit timer ceiling", () => {
    expect(clampTimerDelayMs(MAX_TIMER_DELAY_MS + 1)).toBe(MAX_TIMER_DELAY_MS);
    expect(clampTimerDelayMs(1e308)).toBe(MAX_TIMER_DELAY_MS);
  });

  it("truncates a fractional in-range delay toward zero", () => {
    expect(clampTimerDelayMs(30_000.9)).toBe(30_000);
  });

  it("yields undefined for anything that is not a finite number", () => {
    expect(clampTimerDelayMs(Number.NaN)).toBeUndefined();
    expect(clampTimerDelayMs(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(clampTimerDelayMs(Number.NEGATIVE_INFINITY)).toBeUndefined();
    expect(clampTimerDelayMs("30000")).toBeUndefined();
    expect(clampTimerDelayMs(null)).toBeUndefined();
    expect(clampTimerDelayMs(undefined)).toBeUndefined();
  });

  it("reports a present-but-rejected value to the injected sink", () => {
    // Server callers route this to a monitored channel; a bad cross-repo value
    // must not be coerced away in silence.
    const sink = vi.fn();
    clampTimerDelayMs(MAX_TIMER_DELAY_MS + 1, sink);
    expect(sink).toHaveBeenCalledWith({
      value: MAX_TIMER_DELAY_MS + 1,
      clampedTo: MAX_TIMER_DELAY_MS,
    });

    sink.mockClear();
    clampTimerDelayMs(-5, sink);
    expect(sink).toHaveBeenCalledWith({ value: -5, clampedTo: undefined });

    sink.mockClear();
    clampTimerDelayMs("30000", sink);
    expect(sink).toHaveBeenCalledWith({
      value: "30000",
      clampedTo: undefined,
    });
  });

  it("stays silent for an in-range value and for an absent one", () => {
    // An omitted timeout is the ordinary case, not a malformed payload.
    const sink = vi.fn();
    clampTimerDelayMs(30_000, sink);
    clampTimerDelayMs(undefined, sink);
    expect(sink).not.toHaveBeenCalled();
  });

  it("never throws on a value it rejects", () => {
    // It reads a version-skewed cross-repo payload, so raising would take down
    // the whole command mapping over one bad field.
    expect(() => clampTimerDelayMs({ nope: true })).not.toThrow();
  });
});
