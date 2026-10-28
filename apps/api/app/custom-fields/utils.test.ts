/**
 * Coverage for the custom-field display and validation helpers.
 *
 * `computeDisplayValue` accepts pre-loaded `options`, so every ENUM/MULTI_ENUM
 * formatting branch is reachable without a database.
 *
 * PEOPLE name formatting is NOT here: ISS-7215 moved the derivation to
 * `formatPeopleDisplayValue` in `display-value.ts` and replaced this function's
 * ordered `people` array with a keyed `peopleById` map, so those cases moved to
 * `__tests__/display-value.test.ts` with the function they describe. What
 * remains PEOPLE-shaped in this file is `validateValueType`, which is unrelated
 * to formatting.
 */

import type {
  CustomFieldEnumOption,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
  LabelPosition,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import { describe, expect, it } from "vitest";
import {
  computeDisplayValue,
  InvalidFieldValueError,
  MAX_TEXT_VALUE_LENGTH,
  ReservedNameError,
  validateFieldNameNotReserved,
  validateValueType,
} from "./utils";

const TEXT_ERROR = /TEXT/;
const MAX_LENGTH_ERROR = /maximum length/;
const NUMBER_ERROR = /NUMBER/;
const NOT_A_NUMBER_ERROR = /not a valid number/;
const MULTI_ENUM_ERROR = /MULTI_ENUM/;
const PEOPLE_ERROR = /PEOPLE/;
const ENUM_ERROR = /ENUM field: expected a string option ID/;
const RESERVED_PRIORITY_ERROR = /"priority" is a built-in property of Project/;

function field(
  overrides: Partial<CustomFieldWithOptions> & {
    fieldType: CustomFieldWithOptions["fieldType"];
  }
): CustomFieldWithOptions {
  return {
    id: "cf-1",
    organizationId: "org-1",
    enumOptions: [],
    precision: null,
    numberFormat: null,
    currencyCode: null,
    customLabel: null,
    customLabelPosition: null,
    ...overrides,
  } as unknown as CustomFieldWithOptions;
}

const option = (id: string, name: string): CustomFieldEnumOption =>
  ({ id, name }) as CustomFieldEnumOption;

describe("computeDisplayValue — absent values", () => {
  it("renders an empty string for null, never the word 'null'", async () => {
    expect(
      await computeDisplayValue(
        field({ fieldType: CustomFieldType.Text }),
        null
      )
    ).toBe("");
  });
});

describe("computeDisplayValue — TEXT and DATE", () => {
  it("returns TEXT as-is", async () => {
    expect(
      await computeDisplayValue(
        field({ fieldType: CustomFieldType.Text }),
        "hello"
      )
    ).toBe("hello");
  });

  it("formats a valid DATE in en-US medium form", async () => {
    expect(
      await computeDisplayValue(
        field({ fieldType: CustomFieldType.Date }),
        "2026-08-07T00:00:00.000Z"
      )
    ).toContain("2026");
  });

  it("falls back to the raw string for an unparseable DATE", async () => {
    // A corrupt stored value must render as itself, not "Invalid Date".
    expect(
      await computeDisplayValue(
        field({ fieldType: CustomFieldType.Date }),
        "not-a-date"
      )
    ).toBe("not-a-date");
  });
});

describe("computeDisplayValue — NUMBER formatting", () => {
  it("falls back to the raw string when the value is not numeric", async () => {
    expect(
      await computeDisplayValue(
        field({ fieldType: CustomFieldType.Number }),
        "abc"
      )
    ).toBe("abc");
  });

  it("formats with no format and the field's precision", async () => {
    expect(
      await computeDisplayValue(
        field({
          fieldType: CustomFieldType.Number,
          numberFormat: NumberFormat.None,
          precision: 2,
        }),
        1234.5
      )
    ).toBe("1,234.50");
  });

  it("defaults precision to 0 when the field declares none", async () => {
    expect(
      await computeDisplayValue(
        field({ fieldType: CustomFieldType.Number }),
        1234.56
      )
    ).toBe("1,235");
  });

  it("formats CURRENCY, defaulting the code to USD", async () => {
    expect(
      await computeDisplayValue(
        field({
          fieldType: CustomFieldType.Number,
          numberFormat: NumberFormat.Currency,
          precision: 2,
        }),
        12.5
      )
    ).toBe("$12.50");
  });

  it("honors an explicit currency code", async () => {
    const out = await computeDisplayValue(
      field({
        fieldType: CustomFieldType.Number,
        numberFormat: NumberFormat.Currency,
        currencyCode: "EUR",
        precision: 0,
      }),
      12
    );

    expect(out).toContain("12");
    expect(out).not.toContain("$");
  });

  it("divides by 100 for PERCENTAGE, so 12.5 reads as 12.5%", async () => {
    expect(
      await computeDisplayValue(
        field({
          fieldType: CustomFieldType.Number,
          numberFormat: NumberFormat.Percentage,
          precision: 1,
        }),
        12.5
      )
    ).toBe("12.5%");
  });

  it("appends a CUSTOM label as a suffix by default", async () => {
    expect(
      await computeDisplayValue(
        field({
          fieldType: CustomFieldType.Number,
          numberFormat: NumberFormat.Custom,
          customLabel: " pts",
          precision: 0,
        }),
        42
      )
    ).toBe("42 pts");
  });

  it("prepends a CUSTOM label when the position is PREFIX", async () => {
    expect(
      await computeDisplayValue(
        field({
          fieldType: CustomFieldType.Number,
          numberFormat: NumberFormat.Custom,
          customLabel: "~",
          customLabelPosition: LabelPosition.Prefix,
          precision: 0,
        }),
        42
      )
    ).toBe("~42");
  });

  it("treats an absent CUSTOM label as empty rather than 'null'", async () => {
    expect(
      await computeDisplayValue(
        field({
          fieldType: CustomFieldType.Number,
          numberFormat: NumberFormat.Custom,
          precision: 0,
        }),
        42
      )
    ).toBe("42");
  });
});

describe("computeDisplayValue — ENUM and MULTI_ENUM", () => {
  const options = [option("o1", "High"), option("o2", "Low")];

  it("resolves an ENUM id to its option name", async () => {
    expect(
      await computeDisplayValue(
        field({ fieldType: CustomFieldType.Enum }),
        "o1",
        options
      )
    ).toBe("High");
  });

  it("renders an unmatched ENUM id as empty, not as the raw id", async () => {
    // Showing a raw uuid to a user would be worse than showing nothing.
    expect(
      await computeDisplayValue(
        field({ fieldType: CustomFieldType.Enum }),
        "missing",
        options
      )
    ).toBe("");
  });

  it("falls back to the field's own options when none are passed", async () => {
    expect(
      await computeDisplayValue(
        field({ fieldType: CustomFieldType.Enum, enumOptions: options }),
        "o2"
      )
    ).toBe("Low");
  });

  it("joins MULTI_ENUM names in the stored order", async () => {
    expect(
      await computeDisplayValue(
        field({ fieldType: CustomFieldType.MultiEnum }),
        ["o2", "o1"],
        options
      )
    ).toBe("Low, High");
  });

  it("drops unresolvable MULTI_ENUM ids instead of rendering a gap", async () => {
    expect(
      await computeDisplayValue(
        field({ fieldType: CustomFieldType.MultiEnum }),
        ["o1", "ghost"],
        options
      )
    ).toBe("High");
  });

  it("coerces a scalar MULTI_ENUM value to a single-element list", async () => {
    expect(
      await computeDisplayValue(
        field({ fieldType: CustomFieldType.MultiEnum }),
        "o1",
        options
      )
    ).toBe("High");
  });
});

describe("computeDisplayValue — DATE read path (ISS-8884)", () => {
  it("still renders a stored year-10000 date; the ceiling is write-only", async () => {
    // Local-zone rendering may land on Dec 31, 9999 or Jan 1, 10000; what
    // matters is that the read path still produces a display string.
    const rendered = await computeDisplayValue(
      field({ fieldType: CustomFieldType.Date }),
      "+010000-01-01T00:00:00.000Z"
    );
    expect(rendered).not.toBe("");
    expect(rendered).not.toBe("+010000-01-01T00:00:00.000Z");
  });
});

describe("validateValueType", () => {
  it("accepts null for every field type without inspecting it", () => {
    for (const fieldType of Object.values(CustomFieldType)) {
      expect(() => validateValueType(fieldType, null)).not.toThrow();
    }
  });

  it("accepts a well-typed value for each field type", () => {
    expect(() => validateValueType(CustomFieldType.Text, "x")).not.toThrow();
    expect(() => validateValueType(CustomFieldType.Number, 1)).not.toThrow();
    // A numeric string is accepted for NUMBER — the stored column is numeric
    // but the wire form may be a string.
    expect(() =>
      validateValueType(CustomFieldType.Number, "1.5")
    ).not.toThrow();
    expect(() => validateValueType(CustomFieldType.Enum, "id")).not.toThrow();
    expect(() =>
      validateValueType(CustomFieldType.MultiEnum, ["a"])
    ).not.toThrow();
    expect(() =>
      validateValueType(CustomFieldType.Date, "2026-08-07")
    ).not.toThrow();
    expect(() =>
      validateValueType(CustomFieldType.People, ["u1"])
    ).not.toThrow();
  });

  it.each([
    ["a date-only string", "2026-08-07"],
    ["the first day of year 1", "0001-01-01"],
    ["the last day of year 9999", "9999-12-31"],
    ["a timestamp with an offset", "2026-08-07T12:00:00-05:00"],
  ])("accepts a DATE value that is %s", (_label, value) => {
    expect(() => validateValueType(CustomFieldType.Date, value)).not.toThrow();
  });

  it.each([
    ["year 10000", "10000-01-01"],
    ["year 0", "0000-12-31"],
    ["an offset that lands in UTC year 10000", "9999-12-31T23:00:00-05:00"],
    ["an offset that lands in UTC year 0", "0001-01-01T00:00:00+05:00"],
  ])("rejects a DATE value in %s (ISS-8884)", (_label, value) => {
    expect(() => validateValueType(CustomFieldType.Date, value)).toThrow(
      InvalidFieldValueError
    );
    expect(() => validateValueType(CustomFieldType.Date, value)).toThrow(
      "UTC years 0001 to 9999"
    );
  });

  it("still rejects a DATE value that is not a date at all", () => {
    expect(() => validateValueType(CustomFieldType.Date, "not-a-date")).toThrow(
      InvalidFieldValueError
    );
  });

  it("rejects a non-string TEXT value", () => {
    expect(() => validateValueType(CustomFieldType.Text, 5)).toThrow(
      InvalidFieldValueError
    );
    expect(() => validateValueType(CustomFieldType.Text, 5)).toThrow(
      TEXT_ERROR
    );
  });

  it("rejects a TEXT value over the length cap", () => {
    const overCap = "x".repeat(MAX_TEXT_VALUE_LENGTH + 1);
    expect(() => validateValueType(CustomFieldType.Text, overCap)).toThrow(
      InvalidFieldValueError
    );
    expect(() => validateValueType(CustomFieldType.Text, overCap)).toThrow(
      MAX_LENGTH_ERROR
    );
  });

  it("accepts a TEXT value exactly at the cap", () => {
    expect(() =>
      validateValueType(CustomFieldType.Text, "x".repeat(MAX_TEXT_VALUE_LENGTH))
    ).not.toThrow();
  });

  it("rejects a NUMBER value that is an array or not numeric", () => {
    expect(() => validateValueType(CustomFieldType.Number, ["1"])).toThrow(
      InvalidFieldValueError
    );
    expect(() => validateValueType(CustomFieldType.Number, ["1"])).toThrow(
      NUMBER_ERROR
    );
    expect(() => validateValueType(CustomFieldType.Number, "abc")).toThrow(
      InvalidFieldValueError
    );
    expect(() => validateValueType(CustomFieldType.Number, "abc")).toThrow(
      NOT_A_NUMBER_ERROR
    );
  });

  it.each([
    ["1e400"],
    ["-1e400"],
    ["Infinity"],
    ["-Infinity"],
    [""],
    ["  "],
    [Number.POSITIVE_INFINITY],
  ] as [string | number][])(
    "rejects a NUMBER value that is not finite: %p",
    (value) => {
      expect(() => validateValueType(CustomFieldType.Number, value)).toThrow(
        NOT_A_NUMBER_ERROR
      );
    }
  );

  it.each([["1.5"], ["0"], ["-3"], [42.5]] as [string | number][])(
    "accepts a finite NUMBER value: %p",
    (value) => {
      expect(() =>
        validateValueType(CustomFieldType.Number, value)
      ).not.toThrow();
    }
  );

  it("rejects a non-array MULTI_ENUM or PEOPLE value", () => {
    expect(() => validateValueType(CustomFieldType.MultiEnum, "a")).toThrow(
      InvalidFieldValueError
    );
    expect(() => validateValueType(CustomFieldType.MultiEnum, "a")).toThrow(
      MULTI_ENUM_ERROR
    );
    expect(() => validateValueType(CustomFieldType.People, "u1")).toThrow(
      InvalidFieldValueError
    );
    expect(() => validateValueType(CustomFieldType.People, "u1")).toThrow(
      PEOPLE_ERROR
    );
  });

  it("rejects a non-string ENUM value", () => {
    expect(() => validateValueType(CustomFieldType.Enum, 1)).toThrow(
      InvalidFieldValueError
    );
    expect(() => validateValueType(CustomFieldType.Enum, 1)).toThrow(
      ENUM_ERROR
    );
  });

  it("rejects an unparseable DATE value", () => {
    expect(() =>
      validateValueType(CustomFieldType.Date, "not-a-date")
    ).toThrow();
  });
});

describe("validateFieldNameNotReserved", () => {
  it("allows a name that collides with nothing", () => {
    expect(() =>
      validateFieldNameNotReserved("Sprint Points", [
        CustomFieldEntityType.Project,
      ])
    ).not.toThrow();
  });

  it("rejects a reserved name case- and whitespace-insensitively", () => {
    expect(() =>
      validateFieldNameNotReserved("  StAtUs  ", [
        CustomFieldEntityType.Project,
      ])
    ).toThrow(ReservedNameError);
  });

  it("names the offending field and entity in the error", () => {
    expect(() =>
      validateFieldNameNotReserved("priority", [CustomFieldEntityType.Project])
    ).toThrow(RESERVED_PRIORITY_ERROR);
  });

  it("rejects when ANY of the target entity types reserves the name", () => {
    expect(() =>
      validateFieldNameNotReserved("status", [
        CustomFieldEntityType.Document,
        CustomFieldEntityType.Project,
      ])
    ).toThrow(ReservedNameError);
  });

  it("allows a name when no target entity type reserves it", () => {
    expect(() =>
      validateFieldNameNotReserved("codebase summary", [
        CustomFieldEntityType.Document,
      ])
    ).not.toThrow();
  });

  it("carries the ReservedNameError name for callers that branch on it", () => {
    try {
      validateFieldNameNotReserved("name", [CustomFieldEntityType.Project]);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).name).toBe("ReservedNameError");
    }
  });
});
