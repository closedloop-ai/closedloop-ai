import { beforeEach, describe, expect, it, vi } from "vitest";

const mockResolveFilters = vi.fn();
const mockResolveSort = vi.fn();

vi.mock("./custom-field-list-service", () => ({
  customFieldListService: {
    resolveFilters: (...args: unknown[]) => mockResolveFilters(...args),
    resolveSort: (...args: unknown[]) => mockResolveSort(...args),
    describeField: vi.fn(),
    findMatchingEntityIds: vi.fn(),
    orderIdsByCustomField: vi.fn(),
  },
}));

import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import {
  CustomFieldFilterOperator,
  CustomFieldSortDirection,
} from "@repo/api/src/types/custom-field-list-query";
import { resolveCustomFieldQueryContext } from "./custom-field-route-helpers";

function filter(fieldId: string, values: string[] = []) {
  return { fieldId, operator: CustomFieldFilterOperator.IsAnyOf, values };
}

describe("resolveCustomFieldQueryContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok with empty context when no filters or sort", async () => {
    const result = await resolveCustomFieldQueryContext({}, "org-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({});
    }
  });

  it("resolves filters and sets customFieldEntityIds", async () => {
    const filters = [filter("f1", ["v1"])];
    mockResolveFilters.mockResolvedValue({
      ok: true,
      value: { include: ["e1", "e2"], exclude: [] },
    });

    const result = await resolveCustomFieldQueryContext(
      { customFieldFilters: filters },
      "org-1"
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.customFieldEntityIds).toEqual({
        include: ["e1", "e2"],
        exclude: [],
      });
    }
    expect(mockResolveFilters).toHaveBeenCalledWith(
      filters,
      "org-1",
      CustomFieldEntityType.Document,
      undefined
    );
  });

  it("returns filter error when resolveFilters fails", async () => {
    mockResolveFilters.mockResolvedValue({
      ok: false,
      error: "UNKNOWN_FIELD",
    });

    const result = await resolveCustomFieldQueryContext(
      { customFieldFilters: [filter("bad")] },
      "org-1"
    );

    expect(result.ok).toBe(false);
  });

  it("skips filters when the array is empty", async () => {
    const result = await resolveCustomFieldQueryContext(
      { customFieldFilters: [] },
      "org-1"
    );

    expect(result.ok).toBe(true);
    expect(mockResolveFilters).not.toHaveBeenCalled();
  });

  it("resolves sort and sets customFieldSort", async () => {
    const fieldDescriptor = {
      id: "f1",
      fieldType: "TEXT",
      isSortable: true,
      isSearchable: true,
    };
    mockResolveSort.mockResolvedValue({ ok: true, value: fieldDescriptor });

    const result = await resolveCustomFieldQueryContext(
      {
        customFieldSortId: "f1",
        customFieldSortDir: CustomFieldSortDirection.Desc,
      },
      "org-1"
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.customFieldSort).toEqual({
        field: fieldDescriptor,
        sort: {
          fieldId: "f1",
          direction: CustomFieldSortDirection.Desc,
        },
        entityType: CustomFieldEntityType.Document,
      });
    }
  });

  it("defaults sort direction to Asc when not specified", async () => {
    mockResolveSort.mockResolvedValue({
      ok: true,
      value: {
        id: "f1",
        fieldType: "TEXT",
        isSortable: true,
        isSearchable: true,
      },
    });

    const result = await resolveCustomFieldQueryContext(
      { customFieldSortId: "f1" },
      "org-1"
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.customFieldSort?.sort.direction).toBe(
        CustomFieldSortDirection.Asc
      );
    }
  });

  it("returns sort error when resolveSort fails", async () => {
    mockResolveSort.mockResolvedValue({
      ok: false,
      error: "NOT_SORTABLE",
    });

    const result = await resolveCustomFieldQueryContext(
      { customFieldSortId: "f1" },
      "org-1"
    );

    expect(result.ok).toBe(false);
  });

  it("checks scoped population bound when scopedPopulationFor is provided", async () => {
    const fieldDescriptor = {
      id: "f1",
      fieldType: "TEXT",
      isSortable: true,
      isSearchable: true,
    };
    mockResolveSort.mockResolvedValue({ ok: true, value: fieldDescriptor });
    const mockEnsureWithinBound = vi.fn().mockResolvedValue({ ok: true });
    const scopedPopulationFor = vi.fn().mockReturnValue({
      ensureWithinBound: mockEnsureWithinBound,
    });

    const result = await resolveCustomFieldQueryContext(
      { customFieldSortId: "f1" },
      "org-1",
      scopedPopulationFor
    );

    expect(result.ok).toBe(true);
    expect(scopedPopulationFor).toHaveBeenCalled();
    expect(mockEnsureWithinBound).toHaveBeenCalled();
  });

  it("returns error when population exceeds bound", async () => {
    mockResolveSort.mockResolvedValue({
      ok: true,
      value: {
        id: "f1",
        fieldType: "TEXT",
        isSortable: true,
        isSearchable: true,
      },
    });
    const scopedPopulationFor = vi.fn().mockReturnValue({
      ensureWithinBound: vi.fn().mockResolvedValue({
        ok: false,
        error: "FILTER_TOO_BROAD",
      }),
    });

    const result = await resolveCustomFieldQueryContext(
      { customFieldSortId: "f1" },
      "org-1",
      scopedPopulationFor
    );

    expect(result.ok).toBe(false);
  });

  it("accepts a custom entityType parameter", async () => {
    mockResolveFilters.mockResolvedValue({
      ok: true,
      value: { include: ["e1"], exclude: [] },
    });

    await resolveCustomFieldQueryContext(
      { customFieldFilters: [filter("f1", ["v"])] },
      "org-1",
      undefined,
      CustomFieldEntityType.Project
    );

    expect(mockResolveFilters).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      CustomFieldEntityType.Project,
      undefined
    );
  });

  it("passes filter entity ids to scoped population for sort bound check", async () => {
    const filterIds = { include: ["e1", "e2"], exclude: [] };
    mockResolveFilters.mockResolvedValue({ ok: true, value: filterIds });
    mockResolveSort.mockResolvedValue({
      ok: true,
      value: {
        id: "f1",
        fieldType: "TEXT",
        isSortable: true,
        isSearchable: true,
      },
    });
    const scopedPopulationFor = vi.fn().mockReturnValue({
      ensureWithinBound: vi.fn().mockResolvedValue({ ok: true }),
    });

    await resolveCustomFieldQueryContext(
      {
        customFieldFilters: [filter("f1", ["v"])],
        customFieldSortId: "f1",
      },
      "org-1",
      scopedPopulationFor
    );

    expect(scopedPopulationFor).toHaveBeenCalledWith(filterIds);
  });
});
