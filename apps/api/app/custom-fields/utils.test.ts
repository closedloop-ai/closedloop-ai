/**
 * Coverage for the custom-field display and validation helpers.
 *
 * `computeDisplayValue` accepts pre-loaded `options` and `people`, so every
 * formatting branch is reachable without a database — the only DB path is the
 * PEOPLE fallback that resolves names itself, which is deliberately not
 * exercised here (it belongs to a DB-backed suite).
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

describe("computeDisplayValue — PEOPLE name formatting", () => {
  const peopleField = field({ fieldType: CustomFieldType.People });

  it("formats as 'First L.' and joins multiple people", async () => {
    expect(
      await computeDisplayValue(peopleField, ["u1", "u2"], undefined, [
        { firstName: "Ada", lastName: "Lovelace" },
        { firstName: "Alan", lastName: "Turing" },
      ])
    ).toBe("Ada L., Alan T.");
  });

  it("uses the first name alone when there is no last name", async () => {
    expect(
      await computeDisplayValue(peopleField, ["u1"], undefined, [
        { firstName: "Ada", lastName: null },
      ])
    ).toBe("Ada");
  });

  it("falls back to a last initial when there is no first name", async () => {
    expect(
      await computeDisplayValue(peopleField, ["u1"], undefined, [
        { firstName: null, lastName: "Lovelace" },
      ])
    ).toBe("L.");
  });

  it("drops a person with neither name rather than rendering a stray comma", async () => {
    expect(
      await computeDisplayValue(peopleField, ["u1", "u2"], undefined, [
        { firstName: null, lastName: null },
        { firstName: "Ada", lastName: "Lovelace" },
      ])
    ).toBe("Ada L.");
  });

  it("treats a whitespace-only first name as absent", async () => {
    expect(
      await computeDisplayValue(peopleField, ["u1"], undefined, [
        { firstName: "   ", lastName: "Lovelace" },
      ])
    ).toBe("L.");
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

  it("rejects a non-string TEXT value", () => {
    expect(() => validateValueType(CustomFieldType.Text, 5)).toThrow(
      TEXT_ERROR
    );
  });

  it("rejects a TEXT value over the length cap", () => {
    expect(() =>
      validateValueType(
        CustomFieldType.Text,
        "x".repeat(MAX_TEXT_VALUE_LENGTH + 1)
      )
    ).toThrow(MAX_LENGTH_ERROR);
  });

  it("accepts a TEXT value exactly at the cap", () => {
    expect(() =>
      validateValueType(CustomFieldType.Text, "x".repeat(MAX_TEXT_VALUE_LENGTH))
    ).not.toThrow();
  });

  it("rejects a NUMBER value that is an array or not numeric", () => {
    expect(() => validateValueType(CustomFieldType.Number, ["1"])).toThrow(
      NUMBER_ERROR
    );
    expect(() => validateValueType(CustomFieldType.Number, "abc")).toThrow(
      NOT_A_NUMBER_ERROR
    );
  });

  it("rejects a non-array MULTI_ENUM or PEOPLE value", () => {
    expect(() => validateValueType(CustomFieldType.MultiEnum, "a")).toThrow(
      MULTI_ENUM_ERROR
    );
    expect(() => validateValueType(CustomFieldType.People, "u1")).toThrow(
      PEOPLE_ERROR
    );
  });

  it("rejects a non-string ENUM value", () => {
    expect(() => validateValueType(CustomFieldType.Enum, 1)).toThrow();
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
