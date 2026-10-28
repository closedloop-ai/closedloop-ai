/**
 * ISS-7229 / ISS-12435: the session-detail read serves the stored
 * `session_detail.authoritative_cost_usd` column, and only a figure the column
 * could hold honestly.
 */
import { Prisma } from "@repo/database";
import { describe, expect, it } from "vitest";
import { readStoredAuthoritativeCostUsd } from "./authoritative-cost";

describe("readStoredAuthoritativeCostUsd", () => {
  it("serves the stored figure", () => {
    expect(readStoredAuthoritativeCostUsd(new Prisma.Decimal("1.234567"))).toBe(
      1.234_567
    );
  });

  it("keeps a reported zero as zero", () => {
    expect(readStoredAuthoritativeCostUsd(new Prisma.Decimal(0))).toBe(0);
  });

  it("reads a missing column as no figure", () => {
    expect(readStoredAuthoritativeCostUsd(null)).toBeNull();
    expect(readStoredAuthoritativeCostUsd(undefined)).toBeNull();
  });

  it("reads a figure past the column's width as no figure", () => {
    expect(
      readStoredAuthoritativeCostUsd(new Prisma.Decimal("100000000"))
    ).toBeNull();
  });
});
