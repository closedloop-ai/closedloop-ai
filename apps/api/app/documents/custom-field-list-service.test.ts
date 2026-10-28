import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindFirst = vi.fn();
const mockFindMany = vi.fn();
const mockQueryRaw = vi.fn();

type SqlFragment = {
  isSqlFragment: true;
  text: string;
  values: unknown[];
};

vi.mock("@repo/database", () => {
  const isFragment = (value: unknown): value is SqlFragment =>
    typeof value === "object" &&
    value !== null &&
    "isSqlFragment" in value &&
    value.isSqlFragment === true;

  // Mirrors Prisma.sql: a nested fragment is SPLICED into its parent (text and
  // bound values both), anything else becomes a bound parameter. The splicing
  // is the point — a mock that collapses fragments into opaque objects leaves
  // the emitted query unpinned, so deleting an org_id predicate from the source
  // stays green (marisolashgrove).
  const sql = (
    strings: readonly string[],
    ...values: unknown[]
  ): SqlFragment => {
    let text = "";
    const bound: unknown[] = [];
    strings.forEach((chunk, index) => {
      text += chunk;
      if (index >= values.length) {
        return;
      }
      const value = values[index];
      if (isFragment(value)) {
        text += value.text;
        bound.push(...value.values);
        return;
      }
      bound.push(value);
      text += "?";
    });
    return { isSqlFragment: true, text, values: bound };
  };

  return {
    Prisma: {
      sql,
      raw: (literal: string) => sql([literal]),
      empty: sql([""]),
    },
    withDb: (fn: (db: unknown) => unknown) =>
      fn({
        customField: { findFirst: mockFindFirst },
        customFieldValue: { findMany: mockFindMany },
        $queryRaw: mockQueryRaw,
      }),
  };
});

vi.mock("./custom-field-list-query", () => ({
  buildCustomFieldFacetPredicate: vi.fn(() => ({ ok: true, value: {} })),
  CUSTOM_FIELD_SORT_NULLS: "LAST",
  CustomFieldSortSource: {
    TextValue: "textValue",
    NumberValue: "numberValue",
    DateValue: "dateValue",
    EnumOptionSortOrder: "enumOptionSortOrder",
    DisplayValue: "displayValue",
  },
  isExcludingFacet: vi.fn(() => false),
  resolveCustomFieldSortSource: vi.fn(() => "textValue"),
  resolveSortKeyword: vi.fn(() => "ASC"),
  sortSourceCarriesEmptyString: vi.fn(() => false),
}));

import {
  CustomFieldEntityType,
  type CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { isCustomFieldSortAdmitted } from "@repo/api/src/types/custom-field-capabilities";
import {
  CUSTOM_FIELD_FILTER_MAX_MATCHED_ENTITIES,
  CustomFieldQueryRejection,
  CustomFieldSortDirection,
} from "@repo/api/src/types/custom-field-list-query";
import {
  buildCustomFieldFacetPredicate,
  isExcludingFacet,
} from "./custom-field-list-query";
import { customFieldListService } from "./custom-field-list-service";

vi.mock("@repo/api/src/types/custom-field-capabilities", () => ({
  isCustomFieldSortAdmitted: vi.fn(() => true),
}));

describe("customFieldListService.describeField", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok for a valid field that includes the entity type", async () => {
    mockFindFirst.mockResolvedValue({
      id: "f1",
      fieldType: "TEXT",
      isSortable: true,
      isSearchable: true,
      entityTypes: [CustomFieldEntityType.Document],
    });

    const result = await customFieldListService.describeField(
      "f1",
      "org-1",
      CustomFieldEntityType.Document
    );

    // Org scoping lives in the lookup itself, so a field from another org is
    // indistinguishable from one that does not exist. Pin the predicate, not
    // just the returned value.
    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { id: "f1", organizationId: "org-1" },
      select: {
        id: true,
        fieldType: true,
        isSortable: true,
        isSearchable: true,
        entityTypes: true,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe("f1");
    }
  });

  it("returns UnknownField when field is not found", async () => {
    mockFindFirst.mockResolvedValue(null);

    const result = await customFieldListService.describeField("f1", "org-1");

    expect(result).toEqual({
      ok: false,
      error: CustomFieldQueryRejection.UnknownField,
    });
  });

  it("refuses a field whose stored type this build's client cannot read, rather than throwing", async () => {
    // Prisma 7's data mapper message and code, verbatim: it throws on the READ
    // of a DB enum value the generated client has no member for.
    mockFindFirst.mockRejectedValue(
      Object.assign(
        new Error("Value 'DURATION' not found in enum 'CustomFieldType'"),
        { code: "P2023" }
      )
    );

    const result = await customFieldListService.describeField("f1", "org-1");

    expect(result).toEqual({
      ok: false,
      error: CustomFieldQueryRejection.UnsupportedFieldType,
    });
  });

  it("rethrows a P2023 that is not an unknown enum value", async () => {
    const malformedUuid = Object.assign(
      new Error("Inconsistent column data: Malformed UUID"),
      { code: "P2023" }
    );
    mockFindFirst.mockRejectedValue(malformedUuid);

    await expect(
      customFieldListService.describeField("f1", "org-1")
    ).rejects.toBe(malformedUuid);
  });

  it("returns UnknownField when field does not include the entity type", async () => {
    mockFindFirst.mockResolvedValue({
      id: "f1",
      fieldType: "TEXT",
      isSortable: true,
      isSearchable: true,
      entityTypes: [CustomFieldEntityType.Project],
    });

    const result = await customFieldListService.describeField(
      "f1",
      "org-1",
      CustomFieldEntityType.Document
    );

    expect(result).toEqual({
      ok: false,
      error: CustomFieldQueryRejection.UnknownField,
    });
  });
});

describe("customFieldListService.resolveSort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isCustomFieldSortAdmitted).mockReturnValue(true);
  });

  it("returns the field descriptor when sort is admitted", async () => {
    mockFindFirst.mockResolvedValue({
      id: "f1",
      fieldType: "TEXT",
      isSortable: true,
      isSearchable: true,
      entityTypes: [CustomFieldEntityType.Document],
    });

    const result = await customFieldListService.resolveSort(
      { fieldId: "f1", direction: CustomFieldSortDirection.Asc },
      "org-1"
    );

    expect(result.ok).toBe(true);
  });

  it("returns UnknownField when field not found", async () => {
    mockFindFirst.mockResolvedValue(null);

    const result = await customFieldListService.resolveSort(
      { fieldId: "f1", direction: CustomFieldSortDirection.Asc },
      "org-1"
    );

    expect(result).toEqual({
      ok: false,
      error: CustomFieldQueryRejection.UnknownField,
    });
  });

  it("returns NotSortable when sort is not admitted", async () => {
    mockFindFirst.mockResolvedValue({
      id: "f1",
      fieldType: "REFERENCE",
      isSortable: true,
      isSearchable: true,
      entityTypes: [CustomFieldEntityType.Document],
    });
    vi.mocked(isCustomFieldSortAdmitted).mockReturnValue(false);

    const result = await customFieldListService.resolveSort(
      { fieldId: "f1", direction: CustomFieldSortDirection.Asc },
      "org-1"
    );

    expect(result).toEqual({
      ok: false,
      error: CustomFieldQueryRejection.NotSortable,
    });
  });
});

describe("customFieldListService.resolveFilters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(buildCustomFieldFacetPredicate).mockReturnValue({
      ok: true,
      value: {},
    });
    vi.mocked(isExcludingFacet).mockReturnValue(false);
  });

  it("returns an empty constraint for an empty filter list", async () => {
    const result = await customFieldListService.resolveFilters([], "org-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exclude).toEqual([]);
    }
  });

  it("returns UnknownField when a filter references a missing field", async () => {
    mockFindFirst.mockResolvedValue(null);

    const result = await customFieldListService.resolveFilters(
      [{ fieldId: "bad", values: [] } as never],
      "org-1"
    );

    expect(result.ok).toBe(false);
  });

  it("returns NotFilterable when a field is not searchable", async () => {
    mockFindFirst.mockResolvedValue({
      id: "f1",
      fieldType: "TEXT",
      isSortable: true,
      isSearchable: false,
      entityTypes: [CustomFieldEntityType.Document],
    });

    const result = await customFieldListService.resolveFilters(
      [{ fieldId: "f1", values: [] } as never],
      "org-1"
    );

    expect(result).toEqual({
      ok: false,
      error: CustomFieldQueryRejection.NotFilterable,
    });
  });

  it("returns predicate build errors", async () => {
    mockFindFirst.mockResolvedValue({
      id: "f1",
      fieldType: "TEXT",
      isSortable: true,
      isSearchable: true,
      entityTypes: [CustomFieldEntityType.Document],
    });
    vi.mocked(buildCustomFieldFacetPredicate).mockReturnValue({
      ok: false,
      error: CustomFieldQueryRejection.InvalidFilterValue,
    } as never);

    const result = await customFieldListService.resolveFilters(
      [{ fieldId: "f1", values: [] } as never],
      "org-1"
    );

    expect(result.ok).toBe(false);
  });

  it("intersects include sets across multiple inclusive filters", async () => {
    mockFindFirst.mockResolvedValue({
      id: "f1",
      fieldType: "TEXT",
      isSortable: true,
      isSearchable: true,
      entityTypes: [CustomFieldEntityType.Document],
    });
    vi.mocked(isExcludingFacet).mockReturnValue(false);

    let callCount = 0;
    mockFindMany.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return [{ entityId: "e1" }, { entityId: "e2" }, { entityId: "e3" }];
      }
      return [{ entityId: "e2" }, { entityId: "e3" }, { entityId: "e4" }];
    });

    const result = await customFieldListService.resolveFilters(
      [
        { fieldId: "f1", values: ["a"] } as never,
        { fieldId: "f1", values: ["b"] } as never,
      ],
      "org-1"
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.include?.sort()).toEqual(["e2", "e3"]);
    }
  });

  it("unions exclude sets across excluding filters", async () => {
    mockFindFirst.mockResolvedValue({
      id: "f1",
      fieldType: "TEXT",
      isSortable: true,
      isSearchable: true,
      entityTypes: [CustomFieldEntityType.Document],
    });
    vi.mocked(isExcludingFacet).mockReturnValue(true);

    let callCount = 0;
    mockFindMany.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return [{ entityId: "e1" }];
      }
      return [{ entityId: "e2" }];
    });

    const result = await customFieldListService.resolveFilters(
      [
        { fieldId: "f1", isEmpty: true } as never,
        { fieldId: "f1", isEmpty: true } as never,
      ],
      "org-1"
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exclude.sort()).toEqual(["e1", "e2"]);
    }
  });
});

describe("customFieldListService.findMatchingEntityIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns entity ids within the cap", async () => {
    mockFindMany.mockResolvedValue([{ entityId: "e1" }, { entityId: "e2" }]);

    const result = await customFieldListService.findMatchingEntityIds(
      "f1",
      "org-1",
      CustomFieldEntityType.Document,
      { textValue: "x" }
    );

    // The facet read is org- AND entity-type-scoped before the caller predicate
    // is spread in; dropping either scope must fail here.
    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        entityType: CustomFieldEntityType.Document,
        customFieldId: "f1",
        textValue: "x",
      },
      select: { entityId: true },
      take: CUSTOM_FIELD_FILTER_MAX_MATCHED_ENTITIES + 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(["e1", "e2"]);
    }
  });

  it("returns FilterTooBroad when over the cap with no scoped population", async () => {
    const overCap = Array.from(
      { length: CUSTOM_FIELD_FILTER_MAX_MATCHED_ENTITIES + 1 },
      (_, i) => ({ entityId: `e${i}` })
    );
    mockFindMany.mockResolvedValue(overCap);

    const result = await customFieldListService.findMatchingEntityIds(
      "f1",
      "org-1",
      CustomFieldEntityType.Document,
      {}
    );

    expect(result).toEqual({
      ok: false,
      error: CustomFieldQueryRejection.FilterTooBroad,
    });
  });

  it("falls back to scoped population when over the cap", async () => {
    const overCap = Array.from(
      { length: CUSTOM_FIELD_FILTER_MAX_MATCHED_ENTITIES + 1 },
      (_, i) => ({ entityId: `e${i}` })
    );
    mockFindMany
      .mockResolvedValueOnce(overCap)
      .mockResolvedValueOnce([{ entityId: "e1" }]);

    const scopedPopulation = {
      ids: vi.fn().mockResolvedValue({ ok: true, value: ["e1", "e2"] }),
      ensureWithinBound: vi.fn().mockResolvedValue({ ok: true, value: 2 }),
    };

    const result = await customFieldListService.findMatchingEntityIds(
      "f1",
      "org-1",
      CustomFieldEntityType.Document,
      {},
      scopedPopulation
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(["e1"]);
    }
  });

  it("returns empty array when scoped population is empty", async () => {
    const overCap = Array.from(
      { length: CUSTOM_FIELD_FILTER_MAX_MATCHED_ENTITIES + 1 },
      (_, i) => ({ entityId: `e${i}` })
    );
    mockFindMany.mockResolvedValueOnce(overCap);

    const scopedPopulation = {
      ids: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      ensureWithinBound: vi.fn().mockResolvedValue({ ok: true, value: 0 }),
    };

    const result = await customFieldListService.findMatchingEntityIds(
      "f1",
      "org-1",
      CustomFieldEntityType.Document,
      {},
      scopedPopulation
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  it("propagates scoped population error", async () => {
    const overCap = Array.from(
      { length: CUSTOM_FIELD_FILTER_MAX_MATCHED_ENTITIES + 1 },
      (_, i) => ({ entityId: `e${i}` })
    );
    mockFindMany.mockResolvedValueOnce(overCap);

    const scopedPopulation = {
      ids: vi.fn().mockResolvedValue({
        ok: false,
        error: CustomFieldQueryRejection.FilterTooBroad,
      }),
      ensureWithinBound: vi.fn().mockResolvedValue({ ok: true, value: 0 }),
    };

    const result = await customFieldListService.findMatchingEntityIds(
      "f1",
      "org-1",
      CustomFieldEntityType.Document,
      {},
      scopedPopulation
    );

    expect(result.ok).toBe(false);
  });
});

describe("customFieldListService.orderIdsByCustomField", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array for empty candidate list", async () => {
    const result = await customFieldListService.orderIdsByCustomField(
      [],
      {
        id: "f1",
        fieldType: "TEXT" as CustomFieldType,
        isSortable: true,
        isSearchable: true,
      },
      { fieldId: "f1", direction: CustomFieldSortDirection.Asc },
      CustomFieldEntityType.Document,
      "org-1",
      10,
      0
    );

    expect(result).toEqual([]);
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it("executes raw SQL and returns ordered ids", async () => {
    mockQueryRaw.mockResolvedValue([{ id: "e2" }, { id: "e1" }]);

    const result = await customFieldListService.orderIdsByCustomField(
      ["e1", "e2"],
      {
        id: "f1",
        fieldType: "TEXT" as CustomFieldType,
        isSortable: true,
        isSearchable: true,
      },
      { fieldId: "f1", direction: CustomFieldSortDirection.Asc },
      CustomFieldEntityType.Document,
      "org-1",
      10,
      0
    );

    expect(result).toEqual(["e2", "e1"]);

    // Raw SQL is exactly where an inherited-only org guarantee stops being
    // checkable, which is why the source states BOTH predicates. Deleting
    // either one must turn this red.
    const statement = mockQueryRaw.mock.calls[0][0] as SqlFragment;
    expect(statement.text).toContain("v.organization_id = ?");
    expect(statement.text).toContain("a.organization_id = ?");
    expect(statement.values.filter((value) => value === "org-1")).toHaveLength(
      2
    );
    expect(statement.values).toContain(CustomFieldEntityType.Document);
    expect(statement.values).toContain("f1");
    expect(statement.values).toContainEqual(["e1", "e2"]);
  });
});
