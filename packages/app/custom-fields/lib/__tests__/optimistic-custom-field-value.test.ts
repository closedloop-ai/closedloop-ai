import { CustomFieldType } from "@repo/api/src/types/custom-field";
import { describe, expect, it } from "vitest";
import { applyOptimisticCustomFieldValue } from "../optimistic-custom-field-value";
import {
  ENTITY_ID,
  makeField,
  makeOption,
  makeTarget,
  makeUser,
  makeValue,
} from "./custom-field-details-fixtures";

const RED = makeOption("multi", "red", "Red");
const BLUE = makeOption("multi", "blue", "Blue");
const MULTI = makeField("multi", CustomFieldType.MultiEnum, {
  enumOptions: [RED, BLUE],
});
const ENUM = makeField("enum", CustomFieldType.Enum, {
  enumOptions: [RED, BLUE],
});
const PEOPLE = makeField("people", CustomFieldType.People);
const REF_MULTI = makeField("ref-multi", CustomFieldType.ReferenceMulti);
const ADA = makeUser("ada", "Ada");
const BOB = makeUser("bob", "Bob");
const SPEC = makeTarget("spec", "Spec");
const PLAN = makeTarget("plan", "Plan");
const OTHER = makeValue(makeField("other", CustomFieldType.Text), {
  textValue: "kept",
});
const LOOKUPS = {
  entityId: ENTITY_ID,
  people: [ADA, BOB],
  referenceTargets: [SPEC, PLAN],
};

function entryFor(
  values: ReturnType<typeof applyOptimisticCustomFieldValue>,
  fieldId: string
) {
  return values?.find((value) => value.customFieldId === fieldId);
}

describe("applyOptimisticCustomFieldValue", () => {
  it("adds and removes MULTI_ENUM options, keeping other fields' values", () => {
    const start = [OTHER, makeValue(MULTI, { multiEnumValues: [RED] })];

    const added = applyOptimisticCustomFieldValue(
      start,
      MULTI,
      ["red", "blue"],
      LOOKUPS
    );
    expect(entryFor(added, MULTI.id)?.multiEnumValues).toEqual([RED, BLUE]);
    expect(entryFor(added, OTHER.customFieldId)).toEqual(OTHER);

    const removed = applyOptimisticCustomFieldValue(start, MULTI, [], LOOKUPS);
    expect(entryFor(removed, MULTI.id)?.multiEnumValues).toEqual([]);
  });

  it("adds and removes PEOPLE from the org users", () => {
    const added = applyOptimisticCustomFieldValue(
      [makeValue(PEOPLE, { peopleValues: [ADA] })],
      PEOPLE,
      ["ada", "bob"],
      LOOKUPS
    );
    expect(entryFor(added, PEOPLE.id)?.peopleValues).toEqual([ADA, BOB]);

    const removed = applyOptimisticCustomFieldValue(
      [makeValue(PEOPLE, { peopleValues: [ADA, BOB] })],
      PEOPLE,
      ["bob"],
      LOOKUPS
    );
    expect(entryFor(removed, PEOPLE.id)?.peopleValues).toEqual([BOB]);
  });

  it("adds REFERENCE_MULTI targets from the loaded page and keeps selected ones", () => {
    const kept = makeTarget("kept", "Already selected");
    const added = applyOptimisticCustomFieldValue(
      [makeValue(REF_MULTI, { referenceValues: [kept] })],
      REF_MULTI,
      ["kept", "plan"],
      LOOKUPS
    );
    expect(entryFor(added, REF_MULTI.id)?.referenceValues).toEqual([
      kept,
      PLAN,
    ]);

    const removed = applyOptimisticCustomFieldValue(
      [makeValue(REF_MULTI, { referenceValues: [kept, PLAN] })],
      REF_MULTI,
      ["plan"],
      LOOKUPS
    );
    expect(entryFor(removed, REF_MULTI.id)?.referenceValues).toEqual([PLAN]);
  });

  it("sets an ENUM on an entity with no row yet, and clears it", () => {
    const set = applyOptimisticCustomFieldValue([], ENUM, "blue", LOOKUPS);
    expect(entryFor(set, ENUM.id)).toMatchObject({
      customFieldId: ENUM.id,
      entityId: ENTITY_ID,
      enumValue: BLUE,
      fieldType: CustomFieldType.Enum,
    });

    const cleared = applyOptimisticCustomFieldValue(
      [OTHER, makeValue(ENUM, { enumValue: BLUE })],
      ENUM,
      null,
      LOOKUPS
    );
    expect(cleared).toEqual([OTHER]);
  });

  it("leaves out an id the lookups cannot resolve", () => {
    const result = applyOptimisticCustomFieldValue(
      [],
      PEOPLE,
      ["ada", "ghost"],
      LOOKUPS
    );
    expect(entryFor(result, PEOPLE.id)?.peopleValues).toEqual([ADA]);
  });

  it("has no optimistic shape for a scalar type", () => {
    expect(
      applyOptimisticCustomFieldValue(
        [OTHER],
        makeField("text", CustomFieldType.Text),
        "typed",
        LOOKUPS
      )
    ).toBeNull();
  });
});
