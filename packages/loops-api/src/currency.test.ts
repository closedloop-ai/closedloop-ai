import { describe, expect, it } from "vitest";
import { formatCurrency } from "./currency";

describe("formatCurrency (FEA-3441 shared USD formatter)", () => {
  it("formats a positive amount as USD currency", () => {
    expect(formatCurrency(12.5)).toBe("$12.50");
  });

  it("returns null for zero so callers render 'no cost' not '$0.00'", () => {
    expect(formatCurrency(0)).toBeNull();
  });

  it("returns null for negative values", () => {
    expect(formatCurrency(-1)).toBeNull();
  });

  it("groups thousands and keeps two fraction digits", () => {
    expect(formatCurrency(1234.5)).toBe("$1,234.50");
  });
});
