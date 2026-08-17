import { describe, expect, it } from "vitest";
import {
  clampStorageTokenCount,
  InvalidTokenCountError,
  parseOptionalStorageTokenCount,
  readStorageTokenCount,
  readStorageTokenCountAlias,
} from "./token-counts";

const FIELD = "branch_usage.input_tokens";
const UNSAFE_INTEGER_STRING = "9007199254740992"; // 2^53, past MAX_SAFE_INTEGER

describe("clampStorageTokenCount (FEA-4280 lenient read)", () => {
  it("passes valid safe non-negative counts through unchanged, not clamped", () => {
    expect(clampStorageTokenCount(0, FIELD)).toEqual({
      value: 0,
      clamped: false,
    });
    expect(clampStorageTokenCount(42, FIELD)).toEqual({
      value: 42,
      clamped: false,
    });
    // decimal-string and bigint driver shapes are still valid inputs.
    expect(clampStorageTokenCount("123", FIELD)).toEqual({
      value: 123,
      clamped: false,
    });
    expect(clampStorageTokenCount(7n, FIELD)).toEqual({
      value: 7,
      clamped: false,
    });
    // null → 0 via readStorageTokenCount's missing-value contract, not a clamp.
    expect(clampStorageTokenCount(null, FIELD)).toEqual({
      value: 0,
      clamped: false,
    });
  });

  it("clamps an out-of-range / JS-unsafe count to 0 and flags it, instead of throwing", () => {
    expect(clampStorageTokenCount(UNSAFE_INTEGER_STRING, FIELD)).toEqual({
      value: 0,
      clamped: true,
    });
    expect(clampStorageTokenCount(-1, FIELD)).toEqual({
      value: 0,
      clamped: true,
    });
    expect(clampStorageTokenCount(1.5, FIELD)).toEqual({
      value: 0,
      clamped: true,
    });
  });
});

describe("write-path validators stay strict (must not be weakened)", () => {
  it("readStorageTokenCount still throws InvalidTokenCountError on an unsafe count", () => {
    expect(() => readStorageTokenCount(UNSAFE_INTEGER_STRING, FIELD)).toThrow(
      InvalidTokenCountError
    );
    expect(() => readStorageTokenCount(-1, FIELD)).toThrow(
      InvalidTokenCountError
    );
  });

  it("parseOptionalStorageTokenCount still throws on an unsafe count", () => {
    expect(() => parseOptionalStorageTokenCount(1.5, FIELD)).toThrow(
      InvalidTokenCountError
    );
  });
});

describe("readStorageTokenCountAlias", () => {
  it("returns 0 when none of the candidate keys is present in the record", () => {
    // Exercises the `return 0` fallback when every key is absent or null.
    expect(
      readStorageTokenCountAlias({ foo: null, bar: undefined }, FIELD, [
        "foo",
        "bar",
        "missing",
      ])
    ).toBe(0);
  });
});
