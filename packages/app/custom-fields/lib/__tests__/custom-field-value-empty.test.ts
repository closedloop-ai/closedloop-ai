import {
  CustomFieldType,
  type CustomFieldValueDetail,
} from "@repo/api/src/types/custom-field";
import { describe, expect, it } from "vitest";
import { isCustomFieldValueEmpty } from "../custom-field-value-empty";
import {
  makeField,
  makeOption,
  makeTarget,
  makeUser,
  makeValue,
} from "./custom-field-details-fixtures";

const T = CustomFieldType;

/** Per type: a stored row with no value, and one with a value. */
const CASES: readonly [
  CustomFieldType,
  Partial<CustomFieldValueDetail>,
  Partial<CustomFieldValueDetail>,
][] = [
  [T.Text, {}, { textValue: "a" }],
  [T.Number, {}, { numberValue: 0 }],
  [T.Date, {}, { dateValue: new Date("2026-10-08T00:00:00Z") }],
  [T.Enum, {}, { enumValue: makeOption("f", "o1", "One") }],
  [T.MultiEnum, {}, { multiEnumValues: [makeOption("f", "o1", "One")] }],
  [T.People, {}, { peopleValues: [makeUser("u1", "Ada")] }],
  [T.Reference, {}, { referenceValues: [makeTarget("t1", "Target")] }],
  [T.ReferenceMulti, {}, { referenceValues: [makeTarget("t1", "Target")] }],
];

describe("isCustomFieldValueEmpty", () => {
  it("treats an absent row as empty", () => {
    expect(isCustomFieldValueEmpty(undefined)).toBe(true);
  });

  it("covers every field type", () => {
    expect(new Set(CASES.map(([type]) => type))).toEqual(
      new Set(Object.values(CustomFieldType))
    );
  });

  it("treats a stored row of a type this build does not know as set", () => {
    const field = makeField("f", "FUTURE" as CustomFieldType);
    expect(isCustomFieldValueEmpty(makeValue(field, {}))).toBe(false);
  });

  it.each(CASES)(
    "%s: empty without a value, set with one",
    (type, unset, set) => {
      const field = makeField("f", type);
      expect(isCustomFieldValueEmpty(makeValue(field, unset))).toBe(true);
      expect(isCustomFieldValueEmpty(makeValue(field, set))).toBe(false);
    }
  );
});
