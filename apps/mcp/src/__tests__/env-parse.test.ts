/**
 * ISS-8264. `parsePositiveIntegerEnv` is the single admission point for every
 * numeric MCP tunable, including the two retention bounds, so a value it
 * mis-reads becomes a silently wrong policy rather than a startup failure.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { parsePositiveIntegerEnv } from "../env-parse.js";

const VAR_NAME = "MCP_ENV_PARSE_TEST_VALUE";
const DEFAULT_VALUE = 30_000;

afterEach(() => {
  // Originally unset, so it must be removed rather than assigned `undefined`,
  // which would leave the string "undefined" behind for the next case.
  Reflect.deleteProperty(process.env, VAR_NAME);
});

function parse(rawValue: string, maximumValue?: number): number {
  process.env[VAR_NAME] = rawValue;
  return maximumValue === undefined
    ? parsePositiveIntegerEnv(VAR_NAME, DEFAULT_VALUE)
    : parsePositiveIntegerEnv(VAR_NAME, DEFAULT_VALUE, 1, maximumValue);
}

describe("parsePositiveIntegerEnv reads the whole value", () => {
  it("reads exponent notation as the number it denotes, not its first digit", () => {
    // The reported defect: a prefix parse turned this into 1, so a cap meant to
    // be 1000 became 1 and a sweep meant to run every second ran every 1ms.
    expect(parse("1e3")).toBe(1000);
  });

  it("rejects a value with a trailing suffix instead of taking its prefix", () => {
    expect(parse("200abc")).toBe(DEFAULT_VALUE);
    expect(parse("30s")).toBe(DEFAULT_VALUE);
  });

  it("rejects a fractional value", () => {
    expect(parse("1.5")).toBe(DEFAULT_VALUE);
    expect(parse("0.9")).toBe(DEFAULT_VALUE);
  });

  it("rejects a magnitude past the exactly-representable integer range", () => {
    expect(parse("9007199254740993")).toBe(DEFAULT_VALUE);
    expect(parse("1e400")).toBe(DEFAULT_VALUE);
  });

  it("rejects a value above an explicit maximum", () => {
    // How the sweep interval is held inside Node's 32-bit timer delay; a larger
    // value overflows and fires every 1ms.
    expect(parse("2147483648", 2_147_483_647)).toBe(DEFAULT_VALUE);
    expect(parse("2147483647", 2_147_483_647)).toBe(2_147_483_647);
  });

  it("rejects zero, a negative, and whitespace", () => {
    expect(parse("0")).toBe(DEFAULT_VALUE);
    expect(parse("-5")).toBe(DEFAULT_VALUE);
    expect(parse(" ")).toBe(DEFAULT_VALUE);
  });

  it("returns the default when the variable is absent", () => {
    Reflect.deleteProperty(process.env, VAR_NAME);
    expect(parsePositiveIntegerEnv(VAR_NAME, DEFAULT_VALUE)).toBe(
      DEFAULT_VALUE
    );
  });

  it("treats an empty value as unset rather than as zero", () => {
    // The repo-wide `emptyStringAsUndefined` convention, and the one case a
    // bare `Number(...)` read gets exactly backwards: `Number("")` is 0, so a
    // blank MCP_SERVER_CACHE_TTL_MS would expire every session on the next
    // sweep instead of falling back to the default.
    expect(parse("")).toBe(DEFAULT_VALUE);

    // The minimum is what usually rejects a stray 0, so it also has to hold
    // where 0 is a legal value — the shape MCP_OAUTH_REFRESH_REUSE_GRACE_
    // PERIOD_SECONDS already uses. Blank must still mean unset there, not "0".
    process.env[VAR_NAME] = "";
    expect(parsePositiveIntegerEnv(VAR_NAME, DEFAULT_VALUE, 0)).toBe(
      DEFAULT_VALUE
    );
  });

  it("returns a plain in-range integer unchanged", () => {
    expect(parse("200")).toBe(200);
  });
});

describe("mcp-session-store reads its tunables through the helper", () => {
  it("falls back to the default TTL instead of carrying NaN forward", async () => {
    // The store's own read, not the helper's behavior: a bare `Number()` here
    // yields NaN, `nowMs - lastActivityMs > NaN` is always false, and the time
    // bound silently disappears while the setting looks honored.
    vi.resetModules();
    process.env.MCP_SERVER_CACHE_TTL_MS = "10m";
    try {
      const store = await import("../mcp-session-store.js");
      expect(store.MCP_SERVER_CACHE_TTL_MS).toBe(60_000);
    } finally {
      Reflect.deleteProperty(process.env, "MCP_SERVER_CACHE_TTL_MS");
      vi.resetModules();
    }
  });
});
