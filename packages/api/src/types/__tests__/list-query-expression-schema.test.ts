import { describe, expect, it } from "vitest";
import { Priority } from "../common.ts";
import { CustomFieldFilterOperator } from "../custom-field-list-query.ts";
import {
  anyOf,
  parseRefusal,
  withFilters,
} from "../list-query.test-helpers.ts";
import {
  LIST_QUERY_EXPRESSION_MAX_LENGTH,
  LIST_QUERY_EXPRESSION_PARAM,
  LIST_QUERY_EXPRESSION_VERSION,
  LIST_QUERY_MAX_CLAUSES,
  LIST_QUERY_MAX_SORT_RULES,
  LIST_QUERY_MAX_VALUES_PER_CLAUSE,
  ListFilterOperator,
  type ListQueryExpression,
  ListQueryRefusal,
  ListSortDirection,
  serializeListQueryExpression,
} from "../list-query-expression.ts";
import {
  listQueryExpressionSchema,
  parseListQueryExpression,
} from "../list-query-expression-schema.ts";
import { BranchListField, SessionListField } from "../list-query-fields.ts";
import { SESSION_STATUS } from "../session-status.ts";

const FULL_EXPRESSION: ListQueryExpression = {
  version: LIST_QUERY_EXPRESSION_VERSION,
  filters: [
    {
      field: SessionListField.Status,
      operator: ListFilterOperator.IsAnyOf,
      values: [SESSION_STATUS.ACTIVE, SESSION_STATUS.ERROR],
    },
    {
      field: SessionListField.Priority,
      operator: ListFilterOperator.IsAnyOf,
      values: [Priority.High],
      includeEmpty: true,
    },
    {
      field: SessionListField.LastActivity,
      operator: ListFilterOperator.IsBetween,
      min: "2026-09-01T00:00:00.000Z",
      max: "2026-09-24T00:00:00.000Z",
      includeEmpty: false,
    },
    {
      field: BranchListField.Changes,
      operator: ListFilterOperator.IsBetween,
      min: 10,
    },
    { field: SessionListField.Cost, operator: ListFilterOperator.IsEmpty },
    { field: SessionListField.Repo, operator: ListFilterOperator.IsNotEmpty },
  ],
  sorts: [
    { field: SessionListField.Priority, direction: ListSortDirection.Desc },
    { field: SessionListField.Started, direction: ListSortDirection.Asc },
  ],
};

function withSorts(count: number): string {
  return JSON.stringify({
    version: LIST_QUERY_EXPRESSION_VERSION,
    sorts: Array.from({ length: count }, (_, index) => ({
      field: `f${index}`,
      direction: ListSortDirection.Asc,
    })),
  });
}

describe("PRD-721 AC-5 / DT-FS-10 list query expression round trip", () => {
  it("parses what it serializes, unchanged", () => {
    const parsed = parseListQueryExpression(
      serializeListQueryExpression(FULL_EXPRESSION)
    );
    expect(parsed).toEqual({ ok: true, expression: FULL_EXPRESSION });
  });

  it("survives URL-encoding in the one param", () => {
    const params = new URLSearchParams();
    params.set(
      LIST_QUERY_EXPRESSION_PARAM,
      serializeListQueryExpression(FULL_EXPRESSION)
    );
    const decoded = new URLSearchParams(params.toString()).get(
      LIST_QUERY_EXPRESSION_PARAM
    );
    expect(parseListQueryExpression(decoded ?? "")).toEqual({
      ok: true,
      expression: FULL_EXPRESSION,
    });
  });

  it("serializes one expression to one string regardless of key order", () => {
    const reordered = {
      sorts: [{ direction: ListSortDirection.Asc, field: "started" }],
      filters: [
        { values: ["a"], operator: ListFilterOperator.IsAnyOf, field: "repo" },
      ],
      version: LIST_QUERY_EXPRESSION_VERSION,
    } as ListQueryExpression;
    expect(serializeListQueryExpression(reordered)).toBe(
      '{"filters":[{"field":"repo","operator":"isAnyOf","values":["a"]}],"sorts":[{"direction":"asc","field":"started"}],"version":1}'
    );
  });

  it("omits empty filter and sort lists", () => {
    expect(
      serializeListQueryExpression({
        version: LIST_QUERY_EXPRESSION_VERSION,
        filters: [],
        sorts: [],
      })
    ).toBe('{"version":1}');
  });

  it("omits an absent optional key instead of writing null", () => {
    expect(
      serializeListQueryExpression({
        version: LIST_QUERY_EXPRESSION_VERSION,
        filters: [
          {
            field: "changes",
            operator: ListFilterOperator.IsBetween,
            min: 1,
            max: undefined,
            includeEmpty: undefined,
          },
        ],
      })
    ).toBe(
      '{"filters":[{"field":"changes","min":1,"operator":"isBetween"}],"version":1}'
    );
  });

  it("accepts the bare envelope", () => {
    expect(parseListQueryExpression('{"version":1}')).toEqual({
      ok: true,
      expression: { version: LIST_QUERY_EXPRESSION_VERSION },
    });
  });
});

describe("list filter operators", () => {
  it("keeps every custom-field operator's wire string", () => {
    for (const [key, value] of Object.entries(CustomFieldFilterOperator)) {
      expect(ListFilterOperator[key as keyof typeof ListFilterOperator]).toBe(
        value
      );
    }
  });

  it("has exactly four operators", () => {
    expect(Object.values(ListFilterOperator).sort()).toEqual(
      ["isAnyOf", "isBetween", "isEmpty", "isNotEmpty"].sort()
    );
  });
});

describe("PRD-721 AC-5 / DT-FS-12 list query refusals", () => {
  it.each([
    ["not JSON", "{"],
    ["a JSON array", "[]"],
    ["a JSON string", '"x"'],
    ["null", "null"],
    ["no version", '{"filters":[]}'],
    ["a string version", '{"version":"1"}'],
    ["an unknown top-level key", '{"version":1,"groups":[]}'],
    [
      "a nested values array (unbounded depth)",
      withFilters([
        { field: "a", operator: ListFilterOperator.IsAnyOf, values: [["x"]] },
      ]),
    ],
    [
      "an object value",
      withFilters([
        {
          field: "a",
          operator: ListFilterOperator.IsAnyOf,
          values: [{ v: 1 }],
        },
      ]),
    ],
    [
      "a nested group in place of a clause",
      withFilters([{ and: [anyOf("a")] }]),
    ],
    [
      "isAnyOf with no values",
      withFilters([
        { field: "a", operator: ListFilterOperator.IsAnyOf, values: [] },
      ]),
    ],
    [
      "an empty-string value",
      withFilters([
        { field: "a", operator: ListFilterOperator.IsAnyOf, values: [""] },
      ]),
    ],
    [
      "isBetween with neither bound",
      withFilters([{ field: "a", operator: ListFilterOperator.IsBetween }]),
    ],
    [
      "isBetween bounds of different types",
      withFilters([
        {
          field: "a",
          operator: ListFilterOperator.IsBetween,
          min: 1,
          max: "2",
        },
      ]),
    ],
    [
      "isBetween min above max",
      withFilters([
        { field: "a", operator: ListFilterOperator.IsBetween, min: 5, max: 4 },
      ]),
    ],
    [
      "includeEmpty on an emptiness clause",
      withFilters([
        {
          field: "a",
          operator: ListFilterOperator.IsEmpty,
          includeEmpty: true,
        },
      ]),
    ],
    [
      "a second clause on one field",
      withFilters([anyOf("repo"), anyOf("repo")]),
    ],
    [
      "a second sort rule on one field",
      JSON.stringify({
        version: LIST_QUERY_EXPRESSION_VERSION,
        sorts: [
          { field: "repo", direction: "asc" },
          { field: "repo", direction: "desc" },
        ],
      }),
    ],
    ["filters that are not a list", '{"version":1,"filters":{"field":"a"}}'],
    ["a filters string", `{"version":1,"filters":"${"x".repeat(40)}"}`],
    ["sorts that are not a list", '{"version":1,"sorts":"status"}'],
    ["a clause that is not an object", withFilters(["status"])],
    [
      "an unknown sort direction",
      JSON.stringify({
        version: LIST_QUERY_EXPRESSION_VERSION,
        sorts: [{ field: "repo", direction: "up" }],
      }),
    ],
  ])("refuses %s as Malformed", (_label, raw) => {
    expect(parseRefusal(raw)?.code).toBe(ListQueryRefusal.Malformed);
  });

  it("refuses a param past the length cap as Malformed, and reads one at it", () => {
    const padded = (length: number) => {
      const body = '{"version":1}';
      return body + " ".repeat(length - body.length);
    };
    expect(
      parseListQueryExpression(padded(LIST_QUERY_EXPRESSION_MAX_LENGTH))
    ).toEqual({
      ok: true,
      expression: { version: LIST_QUERY_EXPRESSION_VERSION },
    });
    expect(parseRefusal(padded(LIST_QUERY_EXPRESSION_MAX_LENGTH + 1))).toEqual({
      code: ListQueryRefusal.Malformed,
      details: {},
    });
  });

  it("names the clause's field on a malformed clause", () => {
    expect(
      parseRefusal(
        withFilters([
          anyOf("ok"),
          { field: "bad", operator: ListFilterOperator.IsAnyOf, values: [[1]] },
        ])
      )
    ).toEqual({
      code: ListQueryRefusal.Malformed,
      details: { field: "bad", operator: ListFilterOperator.IsAnyOf },
    });
  });

  it("refuses an unknown version as UnsupportedVersion", () => {
    expect(parseRefusal('{"version":2,"filters":[{"any":"shape"}]}')).toEqual({
      code: ListQueryRefusal.UnsupportedVersion,
      details: {},
    });
  });

  it.each(["contains", "isNoneOf", "isNot"])(
    "refuses operator %s as UnsupportedOperator, naming it",
    (operator) => {
      expect(
        parseRefusal(withFilters([{ field: "repo", operator, values: ["x"] }]))
      ).toEqual({
        code: ListQueryRefusal.UnsupportedOperator,
        details: { field: "repo", operator },
      });
    }
  );

  it("refuses one clause past the cap as TooManyClauses, and reads the cap", () => {
    const clauses = (count: number) =>
      Array.from({ length: count }, (_, index) => anyOf(`f${index}`));
    expect(
      parseListQueryExpression(withFilters(clauses(LIST_QUERY_MAX_CLAUSES))).ok
    ).toBe(true);
    expect(
      parseRefusal(withFilters(clauses(LIST_QUERY_MAX_CLAUSES + 1)))?.code
    ).toBe(ListQueryRefusal.TooManyClauses);
  });

  it("refuses one value past the cap as TooManyValues, and reads the cap", () => {
    expect(
      parseListQueryExpression(
        withFilters([anyOf("repo", LIST_QUERY_MAX_VALUES_PER_CLAUSE)])
      ).ok
    ).toBe(true);
    expect(
      parseRefusal(
        withFilters([anyOf("repo", LIST_QUERY_MAX_VALUES_PER_CLAUSE + 1)])
      )
    ).toEqual({
      code: ListQueryRefusal.TooManyValues,
      details: { field: "repo", operator: ListFilterOperator.IsAnyOf },
    });
  });

  it("refuses one sort rule past the cap as TooManySortRules, and reads the cap", () => {
    expect(
      parseListQueryExpression(withSorts(LIST_QUERY_MAX_SORT_RULES)).ok
    ).toBe(true);
    expect(parseRefusal(withSorts(LIST_QUERY_MAX_SORT_RULES + 1))?.code).toBe(
      ListQueryRefusal.TooManySortRules
    );
  });
});

describe("isBetween bounds", () => {
  it.each([
    ["equal numeric bounds", { min: 3, max: 3 }],
    ["ascending numeric bounds", { min: 1, max: 5 }],
    // Strings are not ordered here: only the field's compiler knows whether a
    // string bound is a date, so it owns that check.
    ["descending string bounds", { min: "2026-09-24", max: "2026-09-01" }],
  ])("accepts %s", (_label, bounds) => {
    expect(
      parseListQueryExpression(
        withFilters([
          { field: "a", operator: ListFilterOperator.IsBetween, ...bounds },
        ])
      ).ok
    ).toBe(true);
  });
});

describe("a __proto__ key in the param", () => {
  it.each([
    ["an empty one", '{"version":1,"__proto__":{"x":1}}'],
    [
      "one hiding clauses",
      '{"version":1,"__proto__":{"filters":[{"field":"repo","operator":"isEmpty"}]}}',
    ],
  ])(
    "refuses %s at the top level as Malformed, never drops it",
    (_label, raw) => {
      expect(parseRefusal(raw)?.code).toBe(ListQueryRefusal.Malformed);
    }
  );

  it("refuses one on a clause as Malformed", () => {
    expect(
      parseRefusal(
        '{"version":1,"filters":[{"field":"repo","operator":"isEmpty","__proto__":{"x":1}}]}'
      )?.code
    ).toBe(ListQueryRefusal.Malformed);
  });
});

describe("listQueryExpressionSchema on its own", () => {
  it("still bounds counts when used without the parser", () => {
    const tooMany = {
      version: LIST_QUERY_EXPRESSION_VERSION,
      filters: Array.from({ length: LIST_QUERY_MAX_CLAUSES + 1 }, (_, index) =>
        anyOf(`f${index}`)
      ),
    };
    expect(listQueryExpressionSchema.safeParse(tooMany).success).toBe(false);
  });

  it("accepts an isBetween with one bound", () => {
    expect(
      listQueryExpressionSchema.safeParse({
        version: LIST_QUERY_EXPRESSION_VERSION,
        filters: [
          { field: "changes", operator: ListFilterOperator.IsBetween, max: 3 },
        ],
      }).success
    ).toBe(true);
  });
});
