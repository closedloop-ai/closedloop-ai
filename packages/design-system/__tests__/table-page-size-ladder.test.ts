import { describe, expect, it } from "vitest";
import {
  resolveLegalTablePageSize,
  TABLE_PAGE_SIZE_OPTIONS,
  TABLE_PAGE_SIZE_OPTIONS_EXTENDED,
} from "../components/ui/table-page-size-select";

/**
 * ISS-9692 — a persisted page size that is no longer offered must degrade to one
 * that is, never be handed on as a `limit` the endpoint refuses and never be
 * quietly reset to the default (which throws away what the reader asked for).
 */
describe("resolveLegalTablePageSize", () => {
  it("keeps a size the ladder still offers", () => {
    expect(
      resolveLegalTablePageSize(500, TABLE_PAGE_SIZE_OPTIONS_EXTENDED)
    ).toBe(500);
  });

  it("degrades a size the ladder no longer offers to the nearest rung", () => {
    // The flag going back off is the real case: a reader who chose 500 lands on
    // the largest page this surface can still serve, not on 25.
    expect(resolveLegalTablePageSize(500, TABLE_PAGE_SIZE_OPTIONS)).toBe(100);
    expect(resolveLegalTablePageSize(250, TABLE_PAGE_SIZE_OPTIONS)).toBe(100);
  });

  it("chooses the nearest rung in both directions, not merely the largest", () => {
    expect(resolveLegalTablePageSize(30, TABLE_PAGE_SIZE_OPTIONS)).toBe(25);
    expect(resolveLegalTablePageSize(60, TABLE_PAGE_SIZE_OPTIONS)).toBe(50);
    expect(resolveLegalTablePageSize(1000, TABLE_PAGE_SIZE_OPTIONS)).toBe(100);
  });

  it("breaks an exact tie downward", () => {
    // 37.5 is the midpoint of 25 and 50; the lighter page wins so a degrade can
    // never hand back a page heavier than the reader last saw honored.
    expect(resolveLegalTablePageSize(37, TABLE_PAGE_SIZE_OPTIONS)).toBe(25);
    expect(resolveLegalTablePageSize(75, TABLE_PAGE_SIZE_OPTIONS)).toBe(50);
  });

  it("falls back to the first rung for a value no arithmetic can rank", () => {
    // Corrupt storage, not a reader choice — `Number.NaN` compares false against
    // everything, so without the guard it would return whatever rung came first
    // by accident rather than by decision.
    const firstRung = TABLE_PAGE_SIZE_OPTIONS[0];
    expect(resolveLegalTablePageSize(Number.NaN, TABLE_PAGE_SIZE_OPTIONS)).toBe(
      firstRung
    );
    expect(resolveLegalTablePageSize(0, TABLE_PAGE_SIZE_OPTIONS)).toBe(
      firstRung
    );
    expect(
      resolveLegalTablePageSize(
        Number.POSITIVE_INFINITY,
        TABLE_PAGE_SIZE_OPTIONS
      )
    ).toBe(firstRung);
  });
});
