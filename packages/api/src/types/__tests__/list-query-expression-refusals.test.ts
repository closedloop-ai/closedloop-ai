import { describe, expect, it } from "vitest";
import {
  anyOf,
  parseRefusal,
  valueRefusal,
  withFilters,
} from "../list-query.test-helpers.ts";
import {
  LIST_QUERY_EXPRESSION_VERSION,
  LIST_QUERY_MAX_CLAUSES,
  LIST_QUERY_MAX_VALUES_PER_CLAUSE,
  ListFilterOperator,
  ListQueryRefusal,
} from "../list-query-expression.ts";

describe("malformed refusal details", () => {
  it("names the field of a malformed sort rule", () => {
    expect(
      parseRefusal(
        JSON.stringify({
          version: LIST_QUERY_EXPRESSION_VERSION,
          sorts: [{ field: "repo", direction: "up" }],
        })
      )
    ).toEqual({ code: ListQueryRefusal.Malformed, details: { field: "repo" } });
  });

  it("names the repeated field of a duplicate clause", () => {
    expect(parseRefusal(withFilters([anyOf("repo"), anyOf("repo")]))).toEqual({
      code: ListQueryRefusal.Malformed,
      details: { field: "repo", operator: ListFilterOperator.IsAnyOf },
    });
  });

  it("names the repeated field of a duplicate sort rule", () => {
    expect(
      parseRefusal(
        JSON.stringify({
          version: LIST_QUERY_EXPRESSION_VERSION,
          sorts: [
            { field: "repo", direction: "asc" },
            { field: "repo", direction: "desc" },
          ],
        })
      )
    ).toEqual({ code: ListQueryRefusal.Malformed, details: { field: "repo" } });
  });

  it("names nothing for an envelope fault", () => {
    expect(parseRefusal('{"version":1,"groups":[]}')).toEqual({
      code: ListQueryRefusal.Malformed,
      details: {},
    });
  });

  it("refuses a null clause without throwing", () => {
    expect(parseRefusal(withFilters([null]))).toEqual({
      code: ListQueryRefusal.Malformed,
      details: {},
    });
  });

  it("leaves out a field or operator that is not a string", () => {
    expect(
      parseRefusal(withFilters([{ field: 5, operator: "contains" }]))
    ).toStrictEqual({
      code: ListQueryRefusal.UnsupportedOperator,
      details: { operator: "contains" },
    });
    expect(
      parseRefusal(
        withFilters([
          {
            field: "repo",
            operator: 7,
            values: Array.from(
              { length: LIST_QUERY_MAX_VALUES_PER_CLAUSE + 1 },
              (_, index) => index
            ),
          },
        ])
      )
    ).toStrictEqual({
      code: ListQueryRefusal.Malformed,
      details: { field: "repo" },
    });
  });
});

describe("parseListQueryExpression refusal precedence", () => {
  const unknownOperator = {
    field: "repo",
    operator: "contains",
    values: ["x"],
  };
  const tooManyClauses = Array.from(
    { length: LIST_QUERY_MAX_CLAUSES + 1 },
    (_, index) => anyOf(`f${index}`)
  );

  it.each([
    [
      "version over caps and operators",
      JSON.stringify({
        version: 2,
        filters: [...tooManyClauses, unknownOperator],
      }),
      ListQueryRefusal.UnsupportedVersion,
    ],
    [
      "clause count over an unknown operator",
      withFilters([...tooManyClauses.slice(1), unknownOperator]),
      ListQueryRefusal.TooManyClauses,
    ],
    [
      "an unknown operator over a malformed sibling clause",
      withFilters([
        { field: "bad", operator: ListFilterOperator.IsAnyOf, values: [[1]] },
        unknownOperator,
      ]),
      ListQueryRefusal.UnsupportedOperator,
    ],
    [
      "an unknown operator on a later clause over too many values on an earlier one",
      withFilters([
        anyOf("repo", LIST_QUERY_MAX_VALUES_PER_CLAUSE + 1),
        unknownOperator,
      ]),
      ListQueryRefusal.UnsupportedOperator,
    ],
    [
      "a values list on a range clause as a shape fault, not a count",
      withFilters([
        {
          field: "changes",
          operator: ListFilterOperator.IsBetween,
          min: 1,
          values: Array.from(
            { length: LIST_QUERY_MAX_VALUES_PER_CLAUSE + 1 },
            (_, index) => index
          ),
        },
      ]),
      ListQueryRefusal.Malformed,
    ],
    [
      "too many values over a malformed sibling clause",
      withFilters([
        { field: "bad", operator: ListFilterOperator.IsBetween },
        anyOf("repo", LIST_QUERY_MAX_VALUES_PER_CLAUSE + 1),
      ]),
      ListQueryRefusal.TooManyValues,
    ],
  ])("reports %s", (_label, raw, code) => {
    expect(parseRefusal(raw)?.code).toBe(code);
    expect(valueRefusal(JSON.parse(raw))?.code).toBe(code);
  });

  it("reads a structured value, never param text", () => {
    const expression = { version: LIST_QUERY_EXPRESSION_VERSION, filters: [] };
    expect(valueRefusal(expression)).toBeNull();
    expect(valueRefusal(JSON.stringify(expression))?.code).toBe(
      ListQueryRefusal.Malformed
    );
  });

  // The parser knows no host, so a wire fault on a field no host has is still
  // reported as the wire fault; UnsupportedField is the resolver's answer.
  it("reports an unknown operator before any host sees the field", () => {
    expect(
      parseRefusal(
        withFilters([
          { field: "noSuchField", operator: "contains", values: ["x"] },
        ])
      )?.code
    ).toBe(ListQueryRefusal.UnsupportedOperator);
  });
});
