import { describe, expect, it } from "vitest";
import { dateValueAsDate } from "./date-value";

const EXTENDED_YEAR_WIRE_STRING = "+010000-01-01T00:00:00.000Z";
const ISO_SHAPED_JUNK = "2026-99-99T00:00:00.000Z";

describe("dateValueAsDate", () => {
  it("returns the Date for an in-range Date", () => {
    const stored = new Date("2026-08-07T00:00:00.000Z");
    expect(dateValueAsDate({ dateValue: stored })?.toISOString()).toBe(
      "2026-08-07T00:00:00.000Z"
    );
  });

  it("parses an in-range string the reviver left alone", () => {
    // The wire type says Date; a string is what an unrevived value looks like.
    expect(
      dateValueAsDate(wireValue("2026-08-07T00:00:00.000Z"))?.toISOString()
    ).toBe("2026-08-07T00:00:00.000Z");
  });

  it("returns null for an extended-year wire string", () => {
    expect(dateValueAsDate(wireValue(EXTENDED_YEAR_WIRE_STRING))).toBeNull();
  });

  it("returns null for an Invalid Date", () => {
    expect(
      dateValueAsDate({ dateValue: new Date(ISO_SHAPED_JUNK) })
    ).toBeNull();
  });

  it.each([
    ["a null dateValue", { dateValue: null }],
    ["an omitted value", undefined],
    ["a null value", null],
    ["a numeric wire value", wireValue(0)],
    ["a boolean wire value", wireValue(false)],
  ])("returns null, never 1970, for %s", (_label, value) => {
    expect(dateValueAsDate(value)).toBeNull();
  });
});

/** A value as it arrives on the wire, before the reviver has typed it. */
function wireValue(dateValue: unknown): { dateValue: Date } {
  return { dateValue } as unknown as { dateValue: Date };
}
