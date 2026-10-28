import { describe, expect, it } from "vitest";
import { CustomFieldType } from "../custom-field.js";
import {
  CUSTOM_FIELD_CARDINALITY,
  type CustomFieldCapabilities,
  CustomFieldCardinality,
  CustomFieldFilterFacet,
  CustomFieldFilterSupport,
  GROUP_EMPTY_VALUE,
  GroupEmptyBand,
  isCustomFieldSortAdmitted,
  isCustomFieldTypeGroupable,
  isCustomFieldTypeSortable,
  resolveCustomFieldCapabilities,
  resolveCustomFieldFilterSupport,
  resolveServedCustomFieldFilterOperators,
  SUPPORTED_CUSTOM_FIELD_FILTER_OPERATORS,
} from "../custom-field-capabilities.js";
import { CustomFieldFilterOperator } from "../custom-field-list-query.js";

/**
 * Coverage for the ISS-7213 capability table.
 *
 * The expected matrix below is written out BY HAND rather than derived from the
 * production table, and that duplication is the test: a matrix built by
 * iterating `CUSTOM_FIELD_CAPABILITIES` would stay green when a row is deleted,
 * flipped, or the whole table emptied.
 *
 * Typed `Record<CustomFieldType, …>` so a new field type fails `tsc` in this
 * file as well as in the production one — a type handled in the table alone
 * would otherwise ship with no case naming what it may do.
 */
const EXPECTED_CAPABILITIES: Record<CustomFieldType, CustomFieldCapabilities> =
  {
    [CustomFieldType.Text]: {
      sortable: true,
      groupable: false,
      emptyBand: GroupEmptyBand.Undetermined,
      filter: CustomFieldFilterFacet.None,
    },
    [CustomFieldType.Number]: {
      sortable: true,
      groupable: false,
      emptyBand: GroupEmptyBand.Undetermined,
      filter: CustomFieldFilterFacet.Range,
    },
    [CustomFieldType.Enum]: {
      sortable: true,
      groupable: true,
      emptyBand: GroupEmptyBand.Settable,
      filter: CustomFieldFilterFacet.Options,
    },
    [CustomFieldType.MultiEnum]: {
      sortable: true,
      groupable: false,
      emptyBand: GroupEmptyBand.Undetermined,
      filter: CustomFieldFilterFacet.Options,
    },
    [CustomFieldType.Date]: {
      sortable: true,
      groupable: false,
      emptyBand: GroupEmptyBand.Undetermined,
      filter: CustomFieldFilterFacet.Range,
    },
    [CustomFieldType.People]: {
      sortable: true,
      groupable: false,
      emptyBand: GroupEmptyBand.Undetermined,
      filter: CustomFieldFilterFacet.Options,
    },
    [CustomFieldType.Reference]: {
      sortable: false,
      groupable: true,
      emptyBand: GroupEmptyBand.Settable,
      filter: CustomFieldFilterFacet.Options,
    },
    [CustomFieldType.ReferenceMulti]: {
      sortable: false,
      groupable: false,
      emptyBand: GroupEmptyBand.Undetermined,
      filter: CustomFieldFilterFacet.Options,
    },
  };

const ALL_FIELD_TYPES = Object.values(CustomFieldType);

describe("CUSTOM_FIELD_CAPABILITIES", () => {
  it.each(ALL_FIELD_TYPES)(
    "gives %s exactly its decided capabilities",
    (fieldType) => {
      // Compared as a WHOLE object per type, not key by key: a key-by-key
      // assertion passes when a row grows a fourth capability nobody decided,
      // and lets a single flipped flag hide behind its two correct siblings.
      expect(resolveCustomFieldCapabilities(fieldType)).toEqual(
        EXPECTED_CAPABILITIES[fieldType]
      );
    }
  );

  it("keeps grouping to the types whose values partition the rows", () => {
    // The decision this pins: a row holding several values belongs to several
    // groups, so per-group counts stop summing to the row total. All THREE
    // multi-valued types are therefore excluded, and DATE with them because
    // grouping raw timestamps yields one group per row.
    expect(ALL_FIELD_TYPES.filter(isCustomFieldTypeGroupable)).toEqual([
      CustomFieldType.Enum,
      CustomFieldType.Reference,
    ]);
  });

  // The list-valued field types, written out as literals from
  // `packages/database/prisma/schema.prisma` and NOT read from
  // `CUSTOM_FIELD_CARDINALITY`. Deriving it from that table would make this
  // assertion agree with the production table by construction and stay green
  // when the table itself is the thing that is wrong — which is exactly the
  // defect that shipped: PEOPLE was groupable because the exclusion had been
  // reasoned about by NAME ("MULTI") rather than by storage.
  //
  //   multi_enum_value_ids String[]  @@index(type: Gin)   MULTI_ENUM
  //   people_value_ids     String[]  @@index(type: Gin)   PEOPLE
  //   custom_field_value_references, many rows            REFERENCE_MULTI
  //
  // REFERENCE addresses that same child table and is deliberately absent:
  // `validateReferenceShape` rejects an array for it, so it cannot store two
  // targets.
  const MULTI_VALUED_FIELD_TYPES = [
    CustomFieldType.MultiEnum,
    CustomFieldType.People,
    CustomFieldType.ReferenceMulti,
  ];

  it.each(MULTI_VALUED_FIELD_TYPES)(
    "refuses to group %s, whose row can belong to two groups at once",
    (fieldType) => {
      // Asserted as the capability OUTCOME (`false`, a literal) rather than by
      // comparing the two production tables to each other, so this fails if
      // either the cardinality table or the capability table is wrong.
      expect(isCustomFieldTypeGroupable(fieldType)).toBe(false);
    }
  );

  it("states each type's cardinality from its storage, not its name", () => {
    // PEOPLE and REFERENCE are the two rows a name-based reading gets wrong in
    // opposite directions: PEOPLE is a list without "multi" in its name, and
    // REFERENCE_MULTI's sibling REFERENCE is single despite sharing its table.
    expect(CUSTOM_FIELD_CARDINALITY[CustomFieldType.People]).toBe(
      CustomFieldCardinality.Multi
    );
    expect(CUSTOM_FIELD_CARDINALITY[CustomFieldType.Reference]).toBe(
      CustomFieldCardinality.Single
    );
    expect(CUSTOM_FIELD_CARDINALITY[CustomFieldType.Enum]).toBe(
      CustomFieldCardinality.Single
    );
  });

  it("refuses ordering only for the types with no value to order by", () => {
    // Both halves matter. The negative alone is satisfied by a table that
    // refuses everything; the positive alone by one that admits everything.
    expect(ALL_FIELD_TYPES.filter(isCustomFieldTypeSortable)).toEqual([
      CustomFieldType.Text,
      CustomFieldType.Number,
      CustomFieldType.Enum,
      CustomFieldType.MultiEnum,
      CustomFieldType.Date,
      CustomFieldType.People,
    ]);
    expect(
      ALL_FIELD_TYPES.filter((t) => !isCustomFieldTypeSortable(t))
    ).toEqual([CustomFieldType.Reference, CustomFieldType.ReferenceMulti]);
  });
});

describe("the Range facet against the operators that can express it", () => {
  it("has no bounded operator yet, so no range control may be built", () => {
    // The gap this pins, and the reason it is a pin rather than a comment: the
    // table declares NUMBER and DATE as `range`, but every operator here
    // resolves to an exact-match IN set. A min/max control sending its two
    // bounds as `isAnyOf` asks for "equals min or max" and drops every row
    // between them — 200 OK, wrong page. When ISS-7211 adds a bounded operator
    // this case goes red, which is the prompt to wire the facet and delete it.
    expect(Object.values(CustomFieldFilterOperator)).toEqual([
      CustomFieldFilterOperator.IsAnyOf,
      CustomFieldFilterOperator.IsEmpty,
      CustomFieldFilterOperator.IsNotEmpty,
    ]);
  });
});

describe("isCustomFieldSortAdmitted", () => {
  // The composition rule, as a truth table. The stored flag NARROWS the type
  // ceiling and can never widen it, so exactly one of the four cells admits.
  it.each([
    { fieldType: CustomFieldType.Number, isSortable: true, admitted: true },
    { fieldType: CustomFieldType.Number, isSortable: false, admitted: false },
    // The cell a flag-only gate gets wrong: an admin CAN set `isSortable` on a
    // REFERENCE, and serving it would order by a column empty for every such
    // row — 200 OK, rows back, creation order under the chosen heading.
    { fieldType: CustomFieldType.Reference, isSortable: true, admitted: false },
    {
      fieldType: CustomFieldType.Reference,
      isSortable: false,
      admitted: false,
    },
  ])(
    "admits $fieldType with isSortable=$isSortable -> $admitted",
    ({ fieldType, isSortable, admitted }) => {
      expect(isCustomFieldSortAdmitted(fieldType, isSortable)).toBe(admitted);
    }
  );

  it("denies a field type this build does not know even when the flag is set", () => {
    expect(isCustomFieldSortAdmitted("QUANTUM_FLUX", true)).toBe(false);
  });
});

describe("resolveCustomFieldCapabilities", () => {
  it("denies everything for a field type this build does not know", () => {
    // A peer on a newer build can present a field type with no row here. The
    // regression: a bare `Record` lookup returns `undefined` and the first
    // property read throws, crashing the whole table render because someone
    // else shipped a field type first.
    expect(resolveCustomFieldCapabilities("QUANTUM_FLUX")).toEqual({
      sortable: false,
      groupable: false,
      emptyBand: GroupEmptyBand.Undetermined,
      filter: CustomFieldFilterFacet.None,
    });
  });

  it("does not answer for an inherited object key", () => {
    // `fieldType` arrives as request text. Off a plain object literal
    // `"constructor"` resolves to a truthy function, and `.sortable` on it is
    // `undefined` — a falsy read that looks like a decision but is an accident.
    expect(resolveCustomFieldCapabilities("constructor")).toEqual({
      sortable: false,
      groupable: false,
      emptyBand: GroupEmptyBand.Undetermined,
      filter: CustomFieldFilterFacet.None,
    });
    expect(isCustomFieldTypeSortable("__proto__")).toBe(false);
  });

  it("still admits a known type, so the guard is not a blanket denial", () => {
    expect(isCustomFieldTypeSortable(CustomFieldType.Number)).toBe(true);
    expect(isCustomFieldTypeGroupable(CustomFieldType.Enum)).toBe(true);
  });
});

/**
 * ISS-8296: what a band holding rows with no value for the field MEANS.
 *
 * The pairing with `groupable` is enforced by the type, so the cases below are
 * about the two rows where a human actually chose. The `it` names say which.
 */
describe("the empty-band meaning each field type declares", () => {
  it("lets a drop clear an ENUM, the one single-valued type that groups", () => {
    // A drop onto the empty band of an enum column means "no option selected",
    // which is a state an editor can genuinely submit.
    expect(resolveCustomFieldCapabilities(CustomFieldType.Enum).emptyBand).toBe(
      GroupEmptyBand.Settable
    );
  });

  it("lets a drop clear a REFERENCE", () => {
    expect(
      resolveCustomFieldCapabilities(CustomFieldType.Reference).emptyBand
    ).toBe(GroupEmptyBand.Settable);
  });

  it("refuses the empty band of every type that cannot be grouped", () => {
    // Not a restatement of the type: `CapabilitiesFor` pins the PAIRING, and
    // this pins that the set of groupable types is still the two above — so
    // admitting a third without deciding its band fails here as well as in tsc.
    const refused = ALL_FIELD_TYPES.filter(
      (fieldType) =>
        resolveCustomFieldCapabilities(fieldType).emptyBand ===
        GroupEmptyBand.Undetermined
    );

    expect(refused).toEqual([
      CustomFieldType.Text,
      CustomFieldType.Number,
      CustomFieldType.MultiEnum,
      CustomFieldType.Date,
      CustomFieldType.People,
      CustomFieldType.ReferenceMulti,
    ]);
  });

  it("refuses the empty band of a field type this build does not know", () => {
    // Same fail-closed posture the rest of the fallback already takes: a peer
    // shipping a field type first must not make its bands writable here.
    expect(resolveCustomFieldCapabilities("QUANTUM_FLUX").emptyBand).toBe(
      GroupEmptyBand.Undetermined
    );
  });

  it("carries a settable empty value that is PRESENT, not absent", () => {
    // The whole contract in one line: a consumer testing truthiness reads
    // "explicitly cleared" as "unmappable" and refuses a legal drop.
    expect(GROUP_EMPTY_VALUE).toBeDefined();
    expect(GROUP_EMPTY_VALUE).toBe("");
  });
});

/**
 * ISS-9481 — capability negotiation for version-skewed surfaces.
 *
 * The operator set is written out BY HAND here for the same reason the
 * capability matrix above is: a list derived from
 * `SUPPORTED_CUSTOM_FIELD_FILTER_OPERATORS` would agree with the production
 * table however wrong that table became, including emptied.
 */
const EXPECTED_SUPPORTED_OPERATORS = ["isAnyOf", "isEmpty", "isNotEmpty"];

describe("resolveCustomFieldFilterSupport", () => {
  it("declares exactly the operators this build serves", () => {
    expect([...SUPPORTED_CUSTOM_FIELD_FILTER_OPERATORS].sort()).toEqual(
      [...EXPECTED_SUPPORTED_OPERATORS].sort()
    );
  });

  it("serves every declared operator, on a facet-bearing type and on one with no facet", () => {
    // Two field types, deliberately: ENUM carries an `options` facet and TEXT
    // carries `none`, and a single-type fixture could not tell a per-type
    // answer from a global one. TEXT is the case that matters — `none` means
    // "no popover control", NOT "unfilterable", and the server serves all three
    // operators on it.
    for (const fieldType of [CustomFieldType.Enum, CustomFieldType.Text]) {
      for (const operator of EXPECTED_SUPPORTED_OPERATORS) {
        expect(resolveCustomFieldFilterSupport(fieldType, operator)).toBe(
          CustomFieldFilterSupport.Supported
        );
      }
    }
  });

  it("names an operator a newer client sent that this build cannot serve", () => {
    // `isBetween` is the concrete one waiting on ISS-7211: the `range` facet is
    // declared for NUMBER and DATE while no bounded operator exists, so a newer
    // client shipping the control must be able to learn that and disable it.
    expect(
      resolveCustomFieldFilterSupport(CustomFieldType.Number, "isBetween")
    ).toBe(CustomFieldFilterSupport.UnsupportedOperator);
  });

  it("refuses a prototype key rather than reading it as a supported operator", () => {
    // The operator arrives as request text, and `"constructor"` off a plain
    // object literal is a truthy non-boolean.
    for (const key of ["constructor", "__proto__", "toString"]) {
      expect(resolveCustomFieldFilterSupport(CustomFieldType.Enum, key)).toBe(
        CustomFieldFilterSupport.UnsupportedOperator
      );
    }
  });

  it("names the field type when a rolling deploy stored one this build has no row for", () => {
    expect(resolveCustomFieldFilterSupport("DURATION", "isAnyOf")).toBe(
      CustomFieldFilterSupport.UnsupportedFieldType
    );
  });

  it("reports the unknown field type ahead of the unknown operator", () => {
    // A build that cannot serve the type cannot serve any operator on it, so
    // reporting the operator would send a client off disabling controls that
    // are not what is actually skewed.
    expect(resolveCustomFieldFilterSupport("DURATION", "isBetween")).toBe(
      CustomFieldFilterSupport.UnsupportedFieldType
    );
  });
});

describe("resolveServedCustomFieldFilterOperators", () => {
  it("publishes every served operator for a known type, and none for a type this build has no row for", () => {
    for (const fieldType of [CustomFieldType.Enum, CustomFieldType.Text]) {
      expect(
        [...resolveServedCustomFieldFilterOperators(fieldType)].sort()
      ).toEqual([...EXPECTED_SUPPORTED_OPERATORS].sort());
    }
    expect(resolveServedCustomFieldFilterOperators("DURATION")).toEqual([]);
  });
});
