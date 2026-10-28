import { CustomFieldType } from "@repo/api/src/types/custom-field";
import { isCustomFieldTypeSortable } from "@repo/api/src/types/custom-field-capabilities";
import {
  type CustomFieldFilter,
  CustomFieldFilterOperator,
  CustomFieldQueryRejection,
} from "@repo/api/src/types/custom-field-list-query";
import { describe, expect, it } from "vitest";
import {
  buildCustomFieldFacetPredicate,
  buildCustomFieldPresencePredicate,
  buildCustomFieldValuePredicate,
  CUSTOM_FIELD_SORT_NULLS,
  CustomFieldSortSource,
  isExcludingFacet,
  resolveCustomFieldSortSource,
  resolveSortKeyword,
  sortSourceCarriesEmptyString,
} from "./custom-field-list-query";

/**
 * Unit coverage for the type-pivot rules behind custom-field filter and sort
 * (ISS-7211). These are the decisions that are wrong in a way that still
 * returns rows, so each case names the wrong answer it exists to prevent.
 */

const ALL_FIELD_TYPES = Object.values(CustomFieldType);

/** The types whose values live in `custom_field_value_references`, not on a column. */
const REFERENCE_FIELD_TYPES: CustomFieldType[] = [
  CustomFieldType.Reference,
  CustomFieldType.ReferenceMulti,
];

/** A syntactically valid target id; the reference facet is UUID-validated. */
const TARGET_ARTIFACT_ID = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";

/**
 * Whether each type has a physical value to order by, declared here
 * INDEPENDENTLY of the production table so the assertion cannot be satisfied by
 * reading the same map it is checking.
 *
 * This is the compile-time half of the guard: typed `Record<CustomFieldType, …>`,
 * so a new `CustomFieldType` fails `tsc` in this file as well as in the
 * production map. That is what stops the next type being handled in the map
 * alone and shipping untested — the merge race that ISS-7208/7214 hit with
 * REFERENCE.
 */
const EXPECTED_SORTABILITY_BY_FIELD_TYPE: Record<CustomFieldType, boolean> = {
  [CustomFieldType.Text]: true,
  [CustomFieldType.Number]: true,
  [CustomFieldType.Date]: true,
  [CustomFieldType.Enum]: true,
  [CustomFieldType.MultiEnum]: true,
  [CustomFieldType.People]: true,
  // No scalar to order by: targets live in `custom_field_value_references` and
  // `display_value` is never written for these types.
  [CustomFieldType.Reference]: false,
  [CustomFieldType.ReferenceMulti]: false,
};

describe("resolveCustomFieldSortSource", () => {
  it("sorts ENUM by the option's declared order, never by the option id", () => {
    // The regression: `enumValueId` is a uuid(7), so ordering by it orders by
    // INSERTION TIME. That looks plausible on a fixture whose options were
    // created in display order and is meaningless the moment they are not.
    expect(resolveCustomFieldSortSource(CustomFieldType.Enum)).toBe(
      CustomFieldSortSource.EnumOptionSortOrder
    );
  });

  it("sorts NUMBER numerically rather than as text", () => {
    // Lexicographic ordering of numbers puts 10 before 9.
    expect(resolveCustomFieldSortSource(CustomFieldType.Number)).toBe(
      CustomFieldSortSource.NumberValue
    );
  });

  it("maps every field type to its exact sort source", () => {
    // Pins the WHOLE map, not just that each entry is defined: a definedness
    // check stays green when TEXT starts sorting on `display_value` or DATE on
    // `text_value`, which are precisely the swaps that still return rows.
    expect(
      Object.fromEntries(
        ALL_FIELD_TYPES.map((fieldType) => [
          fieldType,
          resolveCustomFieldSortSource(fieldType),
        ])
      )
    ).toEqual({
      [CustomFieldType.Text]: CustomFieldSortSource.TextValue,
      [CustomFieldType.Number]: CustomFieldSortSource.NumberValue,
      [CustomFieldType.Date]: CustomFieldSortSource.DateValue,
      [CustomFieldType.Enum]: CustomFieldSortSource.EnumOptionSortOrder,
      [CustomFieldType.MultiEnum]: CustomFieldSortSource.DisplayValue,
      [CustomFieldType.People]: CustomFieldSortSource.DisplayValue,
      [CustomFieldType.Reference]: null,
      [CustomFieldType.ReferenceMulti]: null,
    });
  });

  it("refuses to sort the reference types on display_value", () => {
    // The regression: DisplayValue is the precedent for the other two
    // multi-valued types, so it is the entry a hurried hand reaches for. But
    // REFERENCE is ResolvedOnRead (ISS-7214) — `computeDisplayValue` returns ""
    // for it by design — so `v.display_value` is empty for EVERY reference row.
    // Sorting on it would collapse them all into one NULLS LAST bucket and
    // serve creation order under the user's chosen column heading: rows back,
    // no error, wrong answer.
    for (const fieldType of REFERENCE_FIELD_TYPES) {
      expect(resolveCustomFieldSortSource(fieldType)).not.toBe(
        CustomFieldSortSource.DisplayValue
      );
      expect(resolveCustomFieldSortSource(fieldType)).toBeNull();
      expect(isCustomFieldTypeSortable(fieldType)).toBe(false);
    }
  });

  it("matches the independently-declared sortability of every type", () => {
    // Guards the opposite drift too: a blanket `null` would keep the production
    // map exhaustive while silently disabling sort for the whole feature.
    for (const fieldType of ALL_FIELD_TYPES) {
      expect(isCustomFieldTypeSortable(fieldType)).toBe(
        EXPECTED_SORTABILITY_BY_FIELD_TYPE[fieldType]
      );
    }
  });

  it("gives every type the shared table admits a column to actually order by", () => {
    // The cross-table invariant between the ADMISSION table in `@repo/api`
    // (ISS-7213) and this module's MECHANISM table. Breaking it in either
    // direction is a wrong answer that still returns 200:
    //  - admitted with no source => `buildSortExpression` emits no ORDER BY
    //    term and the reader gets creation order under their chosen column;
    //  - refused with a source => a working ordering the toolbar hides and the
    //    route refuses.
    for (const fieldType of ALL_FIELD_TYPES) {
      expect({
        fieldType,
        admitted: isCustomFieldTypeSortable(fieldType),
      }).toEqual({
        fieldType,
        admitted: resolveCustomFieldSortSource(fieldType) !== null,
      });
    }
  });
});

describe("CUSTOM_FIELD_SORT_NULLS", () => {
  it("pins null placement so it cannot differ by direction", () => {
    // Postgres defaults to NULLS LAST for ASC and NULLS FIRST for DESC. Without
    // an explicit placement, flipping the direction toggle would also flip
    // whether unset values lead the list — for a sparse custom field that is a
    // screen of blanks. The DB-backed both-directions proof is in
    // `custom-field-list.integration.test.ts`.
    expect(CUSTOM_FIELD_SORT_NULLS).toBe("LAST");
  });
});

describe("resolveSortKeyword", () => {
  it("emits only closed-set SQL keywords", () => {
    expect(resolveSortKeyword("asc")).toBe("ASC");
    expect(resolveSortKeyword("desc")).toBe("DESC");
  });
});

describe("buildCustomFieldPresencePredicate", () => {
  it("treats an empty string as empty for TEXT", () => {
    // A cleared text box round-trips as "", not NULL. A NULL-only test would
    // report a blank cell as "has a value" and drop it from an `isEmpty` facet.
    expect(buildCustomFieldPresencePredicate(CustomFieldType.Text)).toEqual({
      AND: [{ textValue: { not: null } }, { textValue: { not: "" } }],
    });
  });

  it("tests array emptiness, not NULL, for the set-valued types", () => {
    // `multiEnumValueIds`/`peopleValueIds` are non-nullable String[]: they are
    // `{}` when unset, never NULL, so a `not: null` test matches every row and
    // an `isEmpty` facet would return nothing.
    expect(
      buildCustomFieldPresencePredicate(CustomFieldType.MultiEnum)
    ).toEqual({ multiEnumValueIds: { isEmpty: false } });
    expect(buildCustomFieldPresencePredicate(CustomFieldType.People)).toEqual({
      peopleValueIds: { isEmpty: false },
    });
  });

  it("pivots to the exact column for every field type", () => {
    // Pins the column, not the key count: counting keys stays green when NUMBER
    // starts testing `dateValue`, so an entity with a date but no number would
    // be reported as having a value.
    expect(
      Object.fromEntries(
        ALL_FIELD_TYPES.map((fieldType) => [
          fieldType,
          buildCustomFieldPresencePredicate(fieldType),
        ])
      )
    ).toEqual({
      [CustomFieldType.Text]: {
        AND: [{ textValue: { not: null } }, { textValue: { not: "" } }],
      },
      [CustomFieldType.Number]: { numberValue: { not: null } },
      [CustomFieldType.Date]: { dateValue: { not: null } },
      [CustomFieldType.Enum]: { enumValueId: { not: null } },
      [CustomFieldType.MultiEnum]: { multiEnumValueIds: { isEmpty: false } },
      [CustomFieldType.People]: { peopleValueIds: { isEmpty: false } },
      [CustomFieldType.Reference]: { references: { some: {} } },
      [CustomFieldType.ReferenceMulti]: { references: { some: {} } },
    });
  });

  it("asks the reference relation, never a value column", () => {
    // The regression: every value column on `custom_field_values` is unset for a
    // reference row — its targets are rows in `custom_field_value_references` —
    // and `display_value` is "" by design (ISS-7214). Any column-shaped
    // predicate would therefore report EVERY reference value as absent, which
    // hands `isNotEmpty` an empty page and `isEmpty` the entire org.
    for (const fieldType of REFERENCE_FIELD_TYPES) {
      const predicate = buildCustomFieldPresencePredicate(fieldType);
      expect(predicate).toEqual({ references: { some: {} } });
      expect(predicate).not.toHaveProperty("displayValue");
    }
  });
});

describe("buildCustomFieldValuePredicate", () => {
  it("refuses a NUMBER operand that is not a number", () => {
    // Dropping it instead would evaluate a narrower facet than the caller asked
    // for and report the resulting total as the answer.
    const result = buildCustomFieldValuePredicate(CustomFieldType.Number, [
      "12",
      "not-a-number",
    ]);
    expect(result).toEqual({
      ok: false,
      error: CustomFieldQueryRejection.InvalidFilterValue,
    });
  });

  it.each(["", "   "])(
    "refuses a blank NUMBER operand (%j) instead of coercing it to 0",
    (blank) => {
      // `Number("")` and `Number(" ")` are 0, not NaN, so a finiteness check
      // alone lets a blank operand through as a filter for zero — a confident,
      // wrong page rather than a rejected request.
      expect(
        buildCustomFieldValuePredicate(CustomFieldType.Number, [blank])
      ).toEqual({
        ok: false,
        error: CustomFieldQueryRejection.InvalidFilterValue,
      });
    }
  );

  it("refuses a DATE operand that is not a date", () => {
    const result = buildCustomFieldValuePredicate(CustomFieldType.Date, [
      "nonsense",
    ]);
    expect(result).toEqual({
      ok: false,
      error: CustomFieldQueryRejection.InvalidFilterValue,
    });
  });

  it("parses NUMBER operands off the query string into numbers", () => {
    const result = buildCustomFieldValuePredicate(CustomFieldType.Number, [
      "3",
      "4.5",
    ]);
    expect(result).toEqual({
      ok: true,
      value: { numberValue: { in: [3, 4.5] } },
    });
  });

  it("refuses an ENUM operand that is not a UUID", () => {
    // `enum_value_id` is `@db.Uuid`. A non-UUID operand is not a filter that
    // matches nothing — it is a Postgres cast error thrown mid-query, i.e. a 500
    // on what is really a malformed request.
    expect(
      buildCustomFieldValuePredicate(CustomFieldType.Enum, ["not-a-uuid"])
    ).toEqual({
      ok: false,
      error: CustomFieldQueryRejection.InvalidFilterValue,
    });
  });

  it("accepts a well-formed ENUM operand", () => {
    // The counterpart the rejection test needs: a validator that refused
    // everything would satisfy the case above while breaking ENUM filtering.
    expect(
      buildCustomFieldValuePredicate(CustomFieldType.Enum, [
        "01a01f65-03da-76c8-bdd7-68dfcba44b51",
      ])
    ).toEqual({
      ok: true,
      value: { enumValueId: { in: ["01a01f65-03da-76c8-bdd7-68dfcba44b51"] } },
    });
  });

  it("matches set-valued fields on overlap so any selected option counts", () => {
    const result = buildCustomFieldValuePredicate(CustomFieldType.MultiEnum, [
      "a",
      "b",
    ]);
    expect(result).toEqual({
      ok: true,
      value: { multiEnumValueIds: { hasSome: ["a", "b"] } },
    });
  });

  it("matches the reference types on their target artifact ids", () => {
    for (const fieldType of REFERENCE_FIELD_TYPES) {
      expect(
        buildCustomFieldValuePredicate(fieldType, [TARGET_ARTIFACT_ID])
      ).toEqual({
        ok: true,
        value: {
          references: {
            some: { targetArtifactId: { in: [TARGET_ARTIFACT_ID] } },
          },
        },
      });
    }
  });

  it("refuses a reference operand that is not a UUID", () => {
    // `custom_field_value_references.target_artifact_id` is @db.Uuid, so a
    // non-UUID operand is not a filter matching nothing — it is a Postgres cast
    // error thrown mid-query, surfacing as a 500 on a malformed request. Same
    // reason the ENUM arm validates, and the reason this must be a rejection
    // rather than a silently dropped facet.
    for (const fieldType of REFERENCE_FIELD_TYPES) {
      expect(
        buildCustomFieldValuePredicate(fieldType, ["not-an-artifact-id"])
      ).toEqual({
        ok: false,
        error: CustomFieldQueryRejection.InvalidFilterValue,
      });
    }
  });
});

describe("buildCustomFieldFacetPredicate", () => {
  it("refuses isAnyOf with no operands rather than matching everything", () => {
    const filter: CustomFieldFilter = {
      fieldId: "f",
      operator: CustomFieldFilterOperator.IsAnyOf,
      values: [],
    };
    expect(
      buildCustomFieldFacetPredicate(CustomFieldType.Text, filter)
    ).toEqual({
      ok: false,
      error: CustomFieldQueryRejection.MissingFilterValues,
    });
  });

  it("resolves isEmpty through the PRESENCE predicate, not its negation", () => {
    // Negating inside the value table would only find entities that have a row
    // and left it blank — missing every entity that never had a row, which for a
    // sparse custom field is nearly all of them. The caller inverts the
    // resulting id set instead; `isExcludingFacet` is what tells it to.
    const filter: CustomFieldFilter = {
      fieldId: "f",
      operator: CustomFieldFilterOperator.IsEmpty,
    };
    expect(
      buildCustomFieldFacetPredicate(CustomFieldType.Enum, filter)
    ).toEqual({ ok: true, value: { enumValueId: { not: null } } });
    expect(isExcludingFacet(filter)).toBe(true);
  });

  it("does not invert isNotEmpty", () => {
    const filter: CustomFieldFilter = {
      fieldId: "f",
      operator: CustomFieldFilterOperator.IsNotEmpty,
    };
    expect(isExcludingFacet(filter)).toBe(false);
  });
});

describe("sortSourceCarriesEmptyString", () => {
  it("claims exactly the string-valued sources", () => {
    // `NULLS LAST` orders NULLs, not `""`, and the write path stores `""` for a
    // cleared text box, an empty MULTI_ENUM/PEOPLE array, and a deleted ENUM
    // option. Only the string columns can hold that second spelling of "unset",
    // so only they are normalized in the ORDER BY (whitlockk review).
    expect(sortSourceCarriesEmptyString(CustomFieldSortSource.TextValue)).toBe(
      true
    );
    expect(
      sortSourceCarriesEmptyString(CustomFieldSortSource.DisplayValue)
    ).toBe(true);
  });

  it("leaves the non-string sources alone", () => {
    // `number_value` is Float?, `date_value` is DateTime?, and `sort_order` is
    // reached through a join — none can be `""`, so normalizing them would be
    // noise that also defeats the index.
    expect(
      sortSourceCarriesEmptyString(CustomFieldSortSource.NumberValue)
    ).toBe(false);
    expect(sortSourceCarriesEmptyString(CustomFieldSortSource.DateValue)).toBe(
      false
    );
    expect(
      sortSourceCarriesEmptyString(CustomFieldSortSource.EnumOptionSortOrder)
    ).toBe(false);
  });

  it("covers every field type's source, so a new type cannot slip through", () => {
    // The MULTI_ENUM and PEOPLE types both resolve to DisplayValue, which is the
    // pair the original `NULLS LAST` missed. A type with no sort source at all
    // is asserted to have one rather than being skipped, so "unsortable" cannot
    // become the silent default a new type falls into.
    for (const fieldType of ALL_FIELD_TYPES) {
      const source = resolveCustomFieldSortSource(fieldType);
      if (source === null) {
        expect(isCustomFieldTypeSortable(fieldType)).toBe(false);
        continue;
      }
      expect(typeof sortSourceCarriesEmptyString(source)).toBe("boolean");
    }
    // Both resolve to `display_value`, the string column that carries the write
    // path's `""` spelling of "unset".
    expect(
      sortSourceCarriesEmptyString(CustomFieldSortSource.DisplayValue)
    ).toBe(true);
    expect(resolveCustomFieldSortSource(CustomFieldType.MultiEnum)).toBe(
      CustomFieldSortSource.DisplayValue
    );
    expect(resolveCustomFieldSortSource(CustomFieldType.People)).toBe(
      CustomFieldSortSource.DisplayValue
    );
  });
});

/**
 * ISS-9481 — the version-skew tails of the facet predicate.
 *
 * `fieldType` is the reachable half: it is read off a stored row in
 * `custom-field-list-service.ts`, which no validator constrains, so a rolling
 * deploy can present a `CustomFieldType` this build has no table row for. Those
 * two cases name the wrong answer that WAS served before the guard.
 *
 * The operator half is defense in depth and its case says so: every production
 * request passes `customFieldFilterSchema` first, whose `operator` is a
 * `z.enum` of the three known members, so an unknown one is a 400 and never
 * reached the predicate. It is covered because the function is exported and the
 * refusal is the named reason a client gets once a bounded operator exists.
 */
describe("buildCustomFieldFacetPredicate — version-skewed input", () => {
  /** A field type a newer migration shipped ahead of this build's tables. */
  const UNKNOWN_FIELD_TYPE = "DURATION" as CustomFieldType;

  it("refuses an emptiness facet on an unknown field type instead of matching every row", () => {
    // The wrong answer: `PRESENCE_PREDICATE_BY_FIELD_TYPE` has no row, so the
    // lookup is `undefined` — which is not an error to Prisma, it is an
    // UNCONSTRAINED `where`. Every entity holding any value for the field comes
    // back, the facet narrows nothing, and the page is reported as filtered.
    const result = buildCustomFieldFacetPredicate(UNKNOWN_FIELD_TYPE, {
      fieldId: "f",
      operator: CustomFieldFilterOperator.IsNotEmpty,
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error).toBe(
      CustomFieldQueryRejection.UnsupportedFieldType
    );
  });

  it("refuses a value facet on an unknown field type instead of throwing", () => {
    // The other tail of the same hole: `VALUE_PREDICATE_BY_FIELD_TYPE` has no
    // row either, so the unguarded code called `undefined(values)` and the list
    // request became a 500 on what is really a skewed deploy.
    const result = buildCustomFieldFacetPredicate(UNKNOWN_FIELD_TYPE, {
      fieldId: "f",
      operator: CustomFieldFilterOperator.IsAnyOf,
      values: ["90"],
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error).toBe(
      CustomFieldQueryRejection.UnsupportedFieldType
    );
  });

  it("refuses an operator this build does not serve instead of reading it as isNotEmpty", () => {
    // Defense in depth, not a defect that shipped: the route validator's
    // `z.enum` 400s an unknown operator before this function runs. What it
    // pins is the SHAPE of the refusal — every non-`isAnyOf` operator used to
    // fall through to the presence predicate, so an `isBetween` arriving by any
    // other route would be answered "has any value" under its own name, and
    // `isExcludingFacet` tests only for `isEmpty` so it would land as an
    // INCLUDE set too.
    const result = buildCustomFieldFacetPredicate(CustomFieldType.Number, {
      fieldId: "f",
      operator: "isBetween" as CustomFieldFilter["operator"],
      values: ["1", "10"],
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error).toBe(
      CustomFieldQueryRejection.UnsupportedOperator
    );
  });

  it("still serves every operator this build declares, on two field types", () => {
    // The guard must refuse the skewed tails WITHOUT withdrawing a shipped
    // capability — notably exact-match on a `range`-facet type, which the range
    // CONTROL must not use but which is a working filter in its own right. Two
    // types because a one-type fixture cannot tell a per-type admission from a
    // blanket one.
    for (const fieldType of [CustomFieldType.Number, CustomFieldType.Text]) {
      for (const operator of Object.values(CustomFieldFilterOperator)) {
        const result = buildCustomFieldFacetPredicate(fieldType, {
          fieldId: "f",
          operator,
          values:
            operator === CustomFieldFilterOperator.IsAnyOf ? ["7"] : undefined,
        });

        expect(result.ok).toBe(true);
      }
    }
  });
});
