/**
 * ISS-7210 — DURATION custom field parsing and formatting.
 *
 * The canonical storage unit is milliseconds; these tests are what pin it, so a
 * change to seconds fails here before it reaches a stored column.
 */
import { describe, expect, it } from "vitest";
import {
  formatCustomFieldDurationMs,
  isValidCustomFieldDurationMs,
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  MS_PER_SECOND,
  parseCustomFieldDurationMs,
} from "../custom-field-duration.js";

describe("formatCustomFieldDurationMs — a measured zero is not an absence", () => {
  it('renders a real measured zero as "0s"', () => {
    // The distinction is the whole point: "never measured" and "measured, and
    // it took no time" are different facts about a cycle-time column. Absence
    // is the CALLER\'s to render (computeDisplayValue returns "" before it ever
    // reaches here), so this function must never turn a 0 into an empty string.
    expect(formatCustomFieldDurationMs(0)).toBe("0s");
  });

  it("renders a sub-second span as a measured zero rather than empty", () => {
    expect(formatCustomFieldDurationMs(120)).toBe("0s");
  });
});

describe("formatCustomFieldDurationMs — unit ladder", () => {
  const cases: [number, string][] = [
    [18 * MS_PER_MINUTE, "18m"],
    [MS_PER_HOUR + 12 * MS_PER_MINUTE, "1h 12m"],
    [3 * MS_PER_DAY + 4 * MS_PER_HOUR, "3d 4h"],
    [45 * MS_PER_SECOND, "45s"],
    [2 * MS_PER_HOUR, "2h"],
  ];

  for (const [ms, expected] of cases) {
    it(`renders ${ms}ms as "${expected}"`, () => {
      expect(formatCustomFieldDurationMs(ms)).toBe(expected);
    });
  }

  it("shows at most the two most significant non-zero units", () => {
    expect(
      formatCustomFieldDurationMs(
        MS_PER_DAY + 2 * MS_PER_HOUR + 3 * MS_PER_MINUTE + 4 * MS_PER_SECOND
      )
    ).toBe("1d 2h");
  });

  it("refuses to render a value that is not a duration at all", () => {
    // Defensive only — the documented precondition is a valid duration, and
    // computeDisplayValue routes a corrupt row to plain number formatting so the
    // bad value stays visible AND stays distinct from an unset field. What this
    // pins is that no negative or non-finite input can ever emit a span string
    // that would read as a real measurement.
    expect(formatCustomFieldDurationMs(-1)).toBe("");
    expect(formatCustomFieldDurationMs(Number.POSITIVE_INFINITY)).toBe("");
    expect(formatCustomFieldDurationMs(Number.NaN)).toBe("");
  });
});

describe("parseCustomFieldDurationMs", () => {
  it("parses compound spans into milliseconds", () => {
    expect(parseCustomFieldDurationMs("1h 12m")).toBe(
      MS_PER_HOUR + 12 * MS_PER_MINUTE
    );
    expect(parseCustomFieldDurationMs("3d 4h")).toBe(
      3 * MS_PER_DAY + 4 * MS_PER_HOUR
    );
    expect(parseCustomFieldDurationMs("250ms")).toBe(250);
  });

  it("reads a bare number as seconds", () => {
    expect(parseCustomFieldDurationMs("90")).toBe(90 * MS_PER_SECOND);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(parseCustomFieldDurationMs("  1H  12M ")).toBe(
      MS_PER_HOUR + 12 * MS_PER_MINUTE
    );
  });

  it("returns null for input that is not a duration, distinctly from zero", () => {
    expect(parseCustomFieldDurationMs("soon")).toBeNull();
    expect(parseCustomFieldDurationMs("")).toBeNull();
    expect(parseCustomFieldDurationMs("1h banana")).toBeNull();
    expect(parseCustomFieldDurationMs("0")).toBe(0);
  });

  it("returns null rather than Infinity when the digits overflow a double", () => {
    // The regexes bound the SHAPE of the input, not its magnitude, so a long
    // enough run of digits reaches Number() as Infinity. Infinity is not null,
    // so an unguarded parse would report "this is a duration" and put a
    // non-finite span in a column that must hold a finite one.
    const overflowing = "9".repeat(320);

    expect(parseCustomFieldDurationMs(overflowing)).toBeNull();
    expect(parseCustomFieldDurationMs(`${overflowing}d`)).toBeNull();
  });
});

describe("duration round trip", () => {
  const inputs = ["1h 12m", "18m", "3d 4h", "45s"];

  for (const input of inputs) {
    it(`writes "${input}" and reads back the same rendered string`, () => {
      const stored = parseCustomFieldDurationMs(input);
      expect(stored).not.toBeNull();
      expect(formatCustomFieldDurationMs(stored as number)).toBe(input);
    });
  }
});

describe("isValidCustomFieldDurationMs", () => {
  it("accepts zero and positive finite spans", () => {
    expect(isValidCustomFieldDurationMs(0)).toBe(true);
    expect(isValidCustomFieldDurationMs(MS_PER_HOUR)).toBe(true);
  });

  it("rejects negative and non-finite spans", () => {
    expect(isValidCustomFieldDurationMs(-1)).toBe(false);
    expect(isValidCustomFieldDurationMs(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidCustomFieldDurationMs(Number.NaN)).toBe(false);
  });
});
