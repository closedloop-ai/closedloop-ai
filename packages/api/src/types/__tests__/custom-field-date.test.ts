import { describe, expect, it } from "vitest";
import {
  CUSTOM_FIELD_DATE_MAX,
  isCustomFieldDateYearInRange,
} from "../custom-field-date";

describe("isCustomFieldDateYearInRange", () => {
  it.each([
    ["a current date", "2026-08-07T00:00:00.000Z"],
    ["the first day of year 1", "0001-01-01T00:00:00.000Z"],
    ["the last instant of year 9999", "9999-12-31T23:59:59.999Z"],
  ])("accepts %s", (_label, iso) => {
    expect(isCustomFieldDateYearInRange(new Date(iso))).toBe(true);
  });

  it.each([
    ["an extended-year date", "+010000-01-01T00:00:00.000Z"],
    ["year 0", "0000-12-31T00:00:00.000Z"],
    ["an offset that lands in UTC year 10000", "9999-12-31T23:00:00-05:00"],
    ["an offset that lands in UTC year 0", "0001-01-01T00:00:00+05:00"],
    ["an ISO-shaped junk string", "2026-99-99T00:00:00.000Z"],
  ])("rejects %s", (_label, iso) => {
    expect(isCustomFieldDateYearInRange(new Date(iso))).toBe(false);
  });

  it("rejects an Invalid Date built from NaN", () => {
    expect(isCustomFieldDateYearInRange(new Date(Number.NaN))).toBe(false);
  });

  it("caps the date input at the last day the predicate accepts", () => {
    const max = new Date(`${CUSTOM_FIELD_DATE_MAX}T00:00:00.000Z`);
    expect(isCustomFieldDateYearInRange(max)).toBe(true);
    expect(max.getUTCFullYear()).toBe(9999);
  });
});
