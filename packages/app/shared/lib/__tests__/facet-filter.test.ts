import { describe, expect, it } from "vitest";
import {
  buildFacetOnlyFiltersViewModel,
  EMPTY_TABLE_FILTERS_STATE,
  NOOP_TABLE_FILTERS_CONTROLLER,
  toggleFacetValue,
} from "../facet-filter";

describe("toggleFacetValue", () => {
  it("adds a value not already present", () => {
    expect(toggleFacetValue(["a"], "b")).toEqual(["a", "b"]);
  });

  it("removes a value that is already present", () => {
    expect(toggleFacetValue(["a", "b"], "a")).toEqual(["b"]);
  });

  it("adds to an empty array", () => {
    expect(toggleFacetValue([], "a")).toEqual(["a"]);
  });

  it("toggling the same value twice returns to the original set", () => {
    const start = ["a"];
    const added = toggleFacetValue(start, "b");
    const removed = toggleFacetValue(added, "b");

    expect(added).toEqual(["a", "b"]);
    expect(removed).toEqual(["a"]);
  });

  it("does not mutate the input array", () => {
    const input = ["a"];
    toggleFacetValue(input, "b");
    expect(input).toEqual(["a"]);
  });
});

describe("EMPTY_TABLE_FILTERS_STATE", () => {
  it("carries no active filter selections", () => {
    expect(EMPTY_TABLE_FILTERS_STATE).toEqual({
      assigneeIds: [],
      assignToMe: false,
      hideCompletedItems: false,
      favoritesOnly: false,
      statuses: [],
      priorities: [],
      date: null,
      tagIds: [],
    });
  });
});

describe("NOOP_TABLE_FILTERS_CONTROLLER", () => {
  it("exposes the empty filters state and no active chips", () => {
    expect(NOOP_TABLE_FILTERS_CONTROLLER.filters).toBe(
      EMPTY_TABLE_FILTERS_STATE
    );
    expect(NOOP_TABLE_FILTERS_CONTROLLER.activeChips).toEqual([]);
  });

  it("every toggle/clear handler is a callable no-op that returns undefined", () => {
    expect(NOOP_TABLE_FILTERS_CONTROLLER.toggleAssignee("id")).toBeUndefined();
    expect(NOOP_TABLE_FILTERS_CONTROLLER.toggleAssignToMe()).toBeUndefined();
    expect(
      NOOP_TABLE_FILTERS_CONTROLLER.toggleHideCompletedItems()
    ).toBeUndefined();
    expect(NOOP_TABLE_FILTERS_CONTROLLER.toggleFavoritesOnly()).toBeUndefined();
    expect(NOOP_TABLE_FILTERS_CONTROLLER.toggleStatus("s")).toBeUndefined();
    expect(NOOP_TABLE_FILTERS_CONTROLLER.togglePriority("p")).toBeUndefined();
    expect(NOOP_TABLE_FILTERS_CONTROLLER.setDateFilter(null)).toBeUndefined();
    expect(NOOP_TABLE_FILTERS_CONTROLLER.toggleTag("t")).toBeUndefined();
    expect(
      NOOP_TABLE_FILTERS_CONTROLLER.clearCategoryFilter("status")
    ).toBeUndefined();
    expect(NOOP_TABLE_FILTERS_CONTROLLER.clearAllFilters()).toBeUndefined();
  });
});

describe("buildFacetOnlyFiltersViewModel", () => {
  it("keeps built-in filter categories empty", () => {
    expect(buildFacetOnlyFiltersViewModel([])).toMatchObject({
      teamMembers: [],
      statusOptions: [],
      priorityOptions: [],
    });
  });

  it("hides quick toggles while preserving supplied facet groups", () => {
    const facetGroups = [
      {
        id: "status",
        label: "Status",
        options: [{ id: "active", label: "Active" }],
        selectedValues: ["active"],
        onToggle: () => undefined,
      },
    ];

    expect(buildFacetOnlyFiltersViewModel(facetGroups)).toEqual({
      teamMembers: [],
      statusOptions: [],
      priorityOptions: [],
      hideQuickToggles: true,
      facetGroups,
    });
  });
});
