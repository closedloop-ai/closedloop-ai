/**
 * ISS-5355 — the Sessions listing's `?range=` window param.
 *
 * `null` is a load-bearing return, not a nicety: it means "the viewer's saved
 * range decides". A garbage or hand-edited value must therefore never narrow or
 * widen the listing on its own, and an absent param must leave existing links
 * and bookmarks behaving exactly as they did before the param existed.
 */
import { describe, expect, it } from "vitest";
import { DATE_RANGES } from "../../../shared/lib/format-utils";
import { parseSessionDateRangeParam } from "../session-date-range-param";

describe("parseSessionDateRangeParam", () => {
  it("accepts every canonical range", () => {
    for (const range of DATE_RANGES) {
      expect(parseSessionDateRangeParam(range)).toBe(range);
    }
  });

  it("defers to the saved range when the param is absent", () => {
    expect(parseSessionDateRangeParam(null)).toBeNull();
    expect(parseSessionDateRangeParam(undefined)).toBeNull();
  });

  it("defers to the saved range for a value outside the contract", () => {
    expect(parseSessionDateRangeParam("14d")).toBeNull();
    expect(parseSessionDateRangeParam("")).toBeNull();
    expect(parseSessionDateRangeParam("ALL")).toBeNull();
  });
});
