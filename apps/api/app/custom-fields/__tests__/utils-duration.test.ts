/**
 * ISS-7210 — DURATION NUMBER fields through the API's own display and
 * validation paths.
 *
 * The unit-ladder maths is covered in
 * `packages/api/src/types/__tests__/custom-field-duration.test.ts`; what this
 * file pins is that `computeDisplayValue` reaches the duration formatter at all,
 * and that the write boundary rejects a value the column must never hold.
 */
import {
  CustomFieldType,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import {
  MS_PER_HOUR,
  MS_PER_MINUTE,
} from "@repo/api/src/types/custom-field-duration";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

import type { CustomFieldWithOptions } from "@repo/api/src/types/custom-field";
import {
  computeDisplayValue,
  InvalidFieldValueError,
  validateValueType,
} from "../utils";

const CYCLE_TIME_MS = MS_PER_HOUR + 12 * MS_PER_MINUTE;

/** Matches the DURATION-specific validation message. */
const DURATION_ERROR_RE = /DURATION/;

function buildDurationField(): CustomFieldWithOptions {
  return {
    id: "field-cycle-time",
    organizationId: "org-111",
    name: "Cycle time",
    description: null,
    fieldType: CustomFieldType.Number,
    createdById: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    precision: 2,
    numberFormat: NumberFormat.Duration,
    currencyCode: null,
    customLabel: null,
    customLabelPosition: null,
    isGlobalToOrg: false,
    entityTypes: [],
    referenceTargetSources: [],
    showInTable: true,
    isSearchable: false,
    isSortable: false,
    enumOptions: [],
  };
}

describe("computeDisplayValue — DURATION number format", () => {
  it("renders the stored milliseconds as an elapsed span", async () => {
    await expect(
      computeDisplayValue(buildDurationField(), CYCLE_TIME_MS)
    ).resolves.toBe("1h 12m");
  });

  it("ignores decimal precision, which does not apply to a unit ladder", async () => {
    // The field carries precision 2; a duration must not render "1h 12.00m".
    await expect(
      computeDisplayValue(buildDurationField(), CYCLE_TIME_MS)
    ).resolves.not.toContain(".");
  });

  it("keeps an unset value empty and a measured zero distinct from it", async () => {
    const field = buildDurationField();

    await expect(computeDisplayValue(field, null)).resolves.toBe("");
    await expect(computeDisplayValue(field, 0)).resolves.toBe("0s");
  });

  it("does not change how a non-duration NUMBER field renders", async () => {
    const plain = { ...buildDurationField(), numberFormat: NumberFormat.None };

    await expect(computeDisplayValue(plain, CYCLE_TIME_MS)).resolves.toBe(
      "4,320,000.00"
    );
  });
});

describe("validateValueType — DURATION number format", () => {
  it("accepts zero and a positive number of milliseconds", () => {
    expect(() =>
      validateValueType(CustomFieldType.Number, 0, NumberFormat.Duration)
    ).not.toThrow();
    expect(() =>
      validateValueType(
        CustomFieldType.Number,
        CYCLE_TIME_MS,
        NumberFormat.Duration
      )
    ).not.toThrow();
  });

  it("rejects a negative span", () => {
    // The CLASS is the contract, not just the message: the route maps
    // `InvalidFieldValueError` to a 400 and everything else to a 500, so a
    // bare `Error` here would report the caller's bad input as a server fault.
    expect(() =>
      validateValueType(CustomFieldType.Number, -1, NumberFormat.Duration)
    ).toThrow(InvalidFieldValueError);
    expect(() =>
      validateValueType(CustomFieldType.Number, -1, NumberFormat.Duration)
    ).toThrow(DURATION_ERROR_RE);
  });

  it("rejects a non-finite span", () => {
    expect(() =>
      validateValueType(
        CustomFieldType.Number,
        Number.POSITIVE_INFINITY,
        NumberFormat.Duration
      )
    ).toThrow(InvalidFieldValueError);
    expect(() =>
      validateValueType(
        CustomFieldType.Number,
        Number.POSITIVE_INFINITY,
        NumberFormat.Duration
      )
    ).toThrow(DURATION_ERROR_RE);
  });

  it("rejects a blank or whitespace-only span instead of storing a measured zero", () => {
    // `Number("")` and `Number("   ")` are both 0, so a guard written as
    // `Number.isNaN(Number(value))` admits a blank and persists it as a real
    // "0s" measurement — an absence rendered as a fact. DURATION validates
    // through the parser precisely so empty stays distinct from zero.
    expect(() =>
      validateValueType(CustomFieldType.Number, "", NumberFormat.Duration)
    ).toThrow(InvalidFieldValueError);
    expect(() =>
      validateValueType(CustomFieldType.Number, "", NumberFormat.Duration)
    ).toThrow(DURATION_ERROR_RE);
    expect(() =>
      validateValueType(CustomFieldType.Number, "   ", NumberFormat.Duration)
    ).toThrow(InvalidFieldValueError);
    expect(() =>
      validateValueType(CustomFieldType.Number, "   ", NumberFormat.Duration)
    ).toThrow(DURATION_ERROR_RE);
  });

  it("leaves a plain NUMBER field accepting the values a duration rejects", () => {
    // The narrowing is duration-specific, not a new rule for every NUMBER field.
    expect(() =>
      validateValueType(CustomFieldType.Number, -1, NumberFormat.None)
    ).not.toThrow();
    expect(() => validateValueType(CustomFieldType.Number, -1)).not.toThrow();
  });
});
