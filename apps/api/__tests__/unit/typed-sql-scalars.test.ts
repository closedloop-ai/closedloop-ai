import { describe, expect, it } from "vitest";
import {
  countToNumber,
  sumToNumber,
  sumToOptionalNumber,
  timestampToIso,
} from "@/app/agent-sessions/service/typed-sql-scalars";

/** Stands in for the runtime Decimal these statements return. */
const decimal = (text: string) => ({ toString: () => text });

describe("countToNumber", () => {
  it("narrows a bigint to a number", () => {
    expect(countToNumber(64n)).toBe(64);
  });

  it("reports an empty population as 0", () => {
    expect(countToNumber(0n)).toBe(0);
  });

  it("maps the unreachable null to 0 rather than throwing", () => {
    expect(countToNumber(null)).toBe(0);
  });
});

describe("sumToNumber", () => {
  it("parses a Decimal through its string form, not a float field", () => {
    expect(sumToNumber(decimal("1234567890"))).toBe(1_234_567_890);
  });

  it("keeps fractional cost intact", () => {
    expect(sumToNumber(decimal("12.345678"))).toBeCloseTo(12.345_678, 6);
  });

  it("collapses null to 0 — recoverable from session_count / an empty ledger", () => {
    expect(sumToNumber(null)).toBe(0);
  });

  it("distinguishes a genuine zero from null only via the caller's other signal", () => {
    // Both arrive as 0 here BY DESIGN. PLN-1853 D10 keeps the difference in SQL;
    // this asserts the boundary is the deliberate place it stops mattering.
    expect(sumToNumber(decimal("0"))).toBe(sumToNumber(null));
  });
});

describe("sumToOptionalNumber", () => {
  it("preserves null for callers with no recovery signal", () => {
    expect(sumToOptionalNumber(null)).toBeNull();
  });

  it("separates a genuine zero from an absent sum", () => {
    expect(sumToOptionalNumber(decimal("0"))).toBe(0);
    expect(sumToOptionalNumber(null)).toBeNull();
  });
});

describe("timestampToIso", () => {
  it("renders a Date as an ISO string", () => {
    expect(timestampToIso(new Date("2026-01-01T10:00:00.000Z"))).toBe(
      "2026-01-01T10:00:00.000Z"
    );
  });

  it("keeps null, which the contract already models", () => {
    expect(timestampToIso(null)).toBeNull();
  });
});
