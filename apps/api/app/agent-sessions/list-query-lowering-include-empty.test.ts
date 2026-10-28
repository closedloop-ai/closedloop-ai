/**
 * ISS-9477 — `includeEmpty: true` on a field with no legacy empty spelling.
 * The cloud capability refuses it before lowering today, so the resolver is
 * stubbed to pass: this pins the lowering's own refusal for when the
 * capability and the registry drift, instead of a plain set that drops the
 * "keep empty rows" half.
 */
import {
  LIST_QUERY_EXPRESSION_VERSION,
  type ListFilterClause,
  ListFilterOperator,
  ListQueryRefusal,
} from "@repo/api/src/types/list-query-expression";
import { SessionListField } from "@repo/api/src/types/list-query-fields";
import { CLOUD_SESSION_LIST_QUERY_CAPABILITY } from "@repo/api/src/types/session-list-query-capabilities";
import { lowerSessionListQueryExpression } from "@repo/api/src/types/session-list-query-lowering";
import { SESSION_LIST_QUERY_FIELDS } from "@repo/api/src/types/session-list-query-registry";
import { describe, expect, it, vi } from "vitest";

vi.mock(
  import("@repo/api/src/types/list-query-capability"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    resolveListQueryCapability: () => ({ ok: true }),
  })
);

const WINDOW_START = "2026-09-01T00:00:00.000Z";

const TARGET = {
  acceptedParams: new Set(["harnesses", "startDate", "endDate"]),
  repeatableParams: new Set(["harnesses"]),
};

describe("includeEmpty with no legacy empty spelling", () => {
  it("has no empty token on the harness field", () => {
    expect(
      SESSION_LIST_QUERY_FIELDS[SessionListField.Harness].anyOf?.emptyToken
    ).toBe(undefined);
  });

  it("refuses isAnyOf with includeEmpty true as isEmpty", () => {
    const result = lower({
      field: SessionListField.Harness,
      operator: ListFilterOperator.IsAnyOf,
      values: ["claude"],
      includeEmpty: true,
    });

    expect(result).toStrictEqual({
      ok: false,
      refused: {
        code: ListQueryRefusal.UnsupportedOperator,
        details: {
          field: SessionListField.Harness,
          operator: ListFilterOperator.IsEmpty,
        },
      },
    });
  });

  it("serves isAnyOf with includeEmpty false as the plain set", () => {
    const result = lower({
      field: SessionListField.Harness,
      operator: ListFilterOperator.IsAnyOf,
      values: ["claude"],
      includeEmpty: false,
    });

    expect(result).toStrictEqual({
      ok: true,
      params: { harnesses: ["claude"] },
    });
  });

  it("refuses isBetween with includeEmpty true as isEmpty", () => {
    const result = lower({
      field: SessionListField.LastActivity,
      operator: ListFilterOperator.IsBetween,
      min: WINDOW_START,
      includeEmpty: true,
    });

    expect(result).toStrictEqual({
      ok: false,
      refused: {
        code: ListQueryRefusal.UnsupportedOperator,
        details: {
          field: SessionListField.LastActivity,
          operator: ListFilterOperator.IsEmpty,
        },
      },
    });
  });

  it("serves isBetween with includeEmpty false as the window", () => {
    const result = lower({
      field: SessionListField.LastActivity,
      operator: ListFilterOperator.IsBetween,
      min: WINDOW_START,
      includeEmpty: false,
    });

    expect(result).toStrictEqual({
      ok: true,
      params: { startDate: WINDOW_START },
    });
  });
});

function lower(clause: ListFilterClause) {
  return lowerSessionListQueryExpression(
    { version: LIST_QUERY_EXPRESSION_VERSION, filters: [clause] },
    CLOUD_SESSION_LIST_QUERY_CAPABILITY,
    TARGET
  );
}
