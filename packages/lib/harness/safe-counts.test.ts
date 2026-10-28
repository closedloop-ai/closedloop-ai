/**
 * @file safe-counts.test.ts
 * @description ISS-9047 — the shared count validator refuses the WHOLE
 * impossible set, not the two members everyone remembers.
 *
 * Each rejected case is a value a bare `z.number()` admits, and each would read
 * downstream as a measurement rather than as the corrupt parse it is. The
 * fractional and the past-safe-integer cases are the ones `.int().nonnegative()`
 * alone would still let through (`Number.isInteger(1e300)` is `true`), so they
 * are what this file exists to pin.
 */
import { describe, expect, it } from "vitest";
import {
  safeStorageCountSchema,
  safeStorageOrdinalSchema,
} from "./safe-counts";

describe("safeStorageCountSchema", () => {
  it.each([
    ["a measured zero", 0],
    ["a plain count", 42],
    ["the largest exact integer", Number.MAX_SAFE_INTEGER],
  ])("admits %s", (_label, value) => {
    expect(safeStorageCountSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ["a negative count", -1],
    ["a fractional count", 1.5],
    ["an infinite count", Number.POSITIVE_INFINITY],
    ["a NaN count", Number.NaN],
    ["a magnitude past the safe-integer range", 1e300],
    ["one past the largest exact integer", Number.MAX_SAFE_INTEGER + 2],
  ])("refuses %s", (_label, value) => {
    expect(safeStorageCountSchema.safeParse(value).success).toBe(false);
  });
});

describe("safeStorageOrdinalSchema", () => {
  it("admits the first position", () => {
    expect(safeStorageOrdinalSchema.safeParse(1).success).toBe(true);
  });

  it.each([
    ["a zeroth position", 0],
    ["a negative position", -1],
    ["a fractional position", 1.5],
    ["an infinite position", Number.POSITIVE_INFINITY],
    ["a magnitude past the safe-integer range", 1e300],
  ])("refuses %s", (_label, value) => {
    expect(safeStorageOrdinalSchema.safeParse(value).success).toBe(false);
  });
});
