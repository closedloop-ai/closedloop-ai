import { describe, expect, it } from "vitest";
import {
  anyOf,
  capabilityRefusal,
  expressionOf,
} from "../list-query.test-helpers.ts";
import {
  type ListQueryCapability,
  resolveListQueryCapability,
} from "../list-query-capability.ts";
import {
  LIST_QUERY_EXPRESSION_VERSION,
  type ListFilterClause,
  ListFilterOperator,
  type ListQueryExpression,
  ListQueryRefusal,
} from "../list-query-expression.ts";
import { LIST_QUERY_CUSTOM_FIELD_PREFIX } from "../list-query-fields.ts";

const SYNTHETIC: ListQueryCapability = {
  version: LIST_QUERY_EXPRESSION_VERSION,
  fields: {
    tag: {
      operators: [ListFilterOperator.IsAnyOf],
      sortable: false,
      includeEmpty: { [ListFilterOperator.IsAnyOf]: [false] },
    },
    // A range whose host always KEEPS empty rows, like the Branches date
    // window (branch-list-filter-sql.ts:45-48).
    size: {
      operators: [ListFilterOperator.IsBetween],
      sortable: true,
      includeEmpty: { [ListFilterOperator.IsBetween]: [true] },
    },
    mode: {
      operators: [ListFilterOperator.IsAnyOf],
      sortable: true,
      maxValues: 1,
      values: ["v0", "fast"],
    },
  },
  maxClauses: 2,
  maxValuesPerClause: 3,
  maxSortRules: 1,
};

describe("resolveListQueryCapability", () => {
  it("serves an expression inside the declaration", () => {
    expect(
      resolveListQueryCapability(
        expressionOf(
          [
            anyOf("tag", 3),
            {
              field: "size",
              operator: ListFilterOperator.IsBetween,
              min: 1,
              includeEmpty: true,
            },
          ],
          ["size"]
        ),
        SYNTHETIC
      )
    ).toEqual({ ok: true });
  });

  it("refuses clauses past the host cap as TooManyClauses", () => {
    expect(refusalOf(expressionOf([anyOf("tag"), anyOf("mode")]))).toBeNull();
    expect(
      refusalOf(expressionOf([anyOf("tag"), anyOf("mode"), anyOf("size")]))
    ).toEqual({ code: ListQueryRefusal.TooManyClauses, details: {} });
  });

  it("refuses sort rules past the host cap as TooManySortRules", () => {
    expect(refusalOf(expressionOf([], ["size"]))).toBeNull();
    expect(refusalOf(expressionOf([], ["size", "mode"]))).toEqual({
      code: ListQueryRefusal.TooManySortRules,
      details: {},
    });
  });

  it.each([
    "unknown",
    `${LIST_QUERY_CUSTOM_FIELD_PREFIX}0190a0a0-0000-7000-8000-000000000000`,
    "__proto__",
    "constructor",
    "toString",
  ])("refuses a filter on %s as UnsupportedField", (field) => {
    expect(refusalOf(expressionOf([anyOf(field)]))).toEqual({
      code: ListQueryRefusal.UnsupportedField,
      details: { field },
    });
  });

  it("refuses a sort on a field it cannot sort as UnsupportedField", () => {
    expect(refusalOf(expressionOf([], ["tag"]))).toEqual({
      code: ListQueryRefusal.UnsupportedField,
      details: { field: "tag" },
    });
    expect(refusalOf(expressionOf([], ["__proto__"]))).toEqual({
      code: ListQueryRefusal.UnsupportedField,
      details: { field: "__proto__" },
    });
  });

  it("refuses an operator the field does not serve as UnsupportedOperator", () => {
    expect(
      refusalOf(
        expressionOf([{ field: "tag", operator: ListFilterOperator.IsEmpty }])
      )
    ).toEqual({
      code: ListQueryRefusal.UnsupportedOperator,
      details: { field: "tag", operator: ListFilterOperator.IsEmpty },
    });
  });

  it("serves an expression with no filters and no sorts", () => {
    expect(
      resolveListQueryCapability(
        { version: LIST_QUERY_EXPRESSION_VERSION },
        SYNTHETIC
      )
    ).toEqual({ ok: true });
  });

  it("refuses any explicit includeEmpty on a field that declares none", () => {
    expect(
      refusalOf(
        expressionOf([
          {
            field: "mode",
            operator: ListFilterOperator.IsAnyOf,
            values: ["a"],
            includeEmpty: false,
          },
        ])
      )
    ).toEqual({
      code: ListQueryRefusal.UnsupportedOperator,
      details: { field: "mode", operator: ListFilterOperator.IsNotEmpty },
    });
  });

  it("reads an includeEmpty key holding undefined as omitted", () => {
    expect(
      refusalOf(
        expressionOf([
          {
            field: "size",
            operator: ListFilterOperator.IsBetween,
            min: 1,
            includeEmpty: undefined,
          },
        ])
      )
    ).toBeNull();
  });

  it("serves an omitted includeEmpty as the field's default", () => {
    expect(
      refusalOf(
        expressionOf([
          { field: "size", operator: ListFilterOperator.IsBetween, min: 1 },
        ])
      )
    ).toBeNull();
  });

  it("refuses keeping empty rows where the host drops them, naming isEmpty", () => {
    const tagClause = (includeEmpty: boolean): ListFilterClause => ({
      field: "tag",
      operator: ListFilterOperator.IsAnyOf,
      values: ["a"],
      includeEmpty,
    });
    expect(refusalOf(expressionOf([tagClause(false)]))).toBeNull();
    expect(refusalOf(expressionOf([tagClause(true)]))).toEqual({
      code: ListQueryRefusal.UnsupportedOperator,
      details: { field: "tag", operator: ListFilterOperator.IsEmpty },
    });
  });

  it("refuses dropping empty rows where the host keeps them, naming isNotEmpty", () => {
    const sizeClause = (includeEmpty: boolean): ListFilterClause => ({
      field: "size",
      operator: ListFilterOperator.IsBetween,
      max: 9,
      includeEmpty,
    });
    expect(refusalOf(expressionOf([sizeClause(true)]))).toBeNull();
    expect(refusalOf(expressionOf([sizeClause(false)]))).toEqual({
      code: ListQueryRefusal.UnsupportedOperator,
      details: { field: "size", operator: ListFilterOperator.IsNotEmpty },
    });
  });

  it("checks the field before the operator, and the operator before the values", () => {
    expect(
      refusalOf(
        expressionOf([{ field: "nope", operator: ListFilterOperator.IsEmpty }])
      )?.code
    ).toBe(ListQueryRefusal.UnsupportedField);
    expect(
      refusalOf(
        expressionOf([
          {
            field: "size",
            operator: ListFilterOperator.IsAnyOf,
            values: ["a", "b", "c", "d"],
          },
        ])
      )?.code
    ).toBe(ListQueryRefusal.UnsupportedOperator);
  });

  it("refuses values past the host cap as TooManyValues", () => {
    expect(refusalOf(expressionOf([anyOf("tag", 4)]))).toEqual({
      code: ListQueryRefusal.TooManyValues,
      details: { field: "tag", operator: ListFilterOperator.IsAnyOf },
    });
  });

  it("refuses a value outside a field's closed set as Malformed", () => {
    expect(refusalOf(expressionOf([anyOf("mode", 1)]))).toBeNull();
    expect(
      refusalOf(
        expressionOf([
          {
            field: "mode",
            operator: ListFilterOperator.IsAnyOf,
            values: ["slow"],
          },
        ])
      )
    ).toEqual({
      code: ListQueryRefusal.Malformed,
      details: { field: "mode", operator: ListFilterOperator.IsAnyOf },
    });
  });

  it("refuses values past a field's own cap as TooManyValues", () => {
    expect(refusalOf(expressionOf([anyOf("mode", 1)]))).toBeNull();
    expect(refusalOf(expressionOf([anyOf("mode", 2)]))).toEqual({
      code: ListQueryRefusal.TooManyValues,
      details: { field: "mode", operator: ListFilterOperator.IsAnyOf },
    });
  });
});

function refusalOf(expression: ListQueryExpression) {
  return capabilityRefusal(expression, SYNTHETIC);
}
