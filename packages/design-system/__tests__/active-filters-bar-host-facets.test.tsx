import {
  ActiveFiltersBar,
  hasVisibleActiveFilters,
} from "@closedloop-ai/design-system/components/ui/active-filters-bar";
import type {
  TableFiltersController,
  TableFiltersViewModel,
} from "@closedloop-ai/design-system/components/ui/table-filters";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

const COST_CHIP_PATTERN = /^Cost/;
const NON_FINITE_PATTERN = /NaN|Infinity/;
const STATUS_CHIP_PATTERN = /^Status:/;
const STAGE_CHIP_PATTERN = /^Stage:/;

/**
 * The champion bar's host-facet chips, settled by the shared filter model,
 * settled them (ISS-7051).
 *
 * `facetGroups` REPLACES the built-in assignee/status/priority/date/tag
 * controls, so a surface driving filters that way pairs it with a no-op
 * controller and contributes no `activeChips` at all. The controller below has
 * an EMPTY `activeChips` on purpose: reading only `additionalFacetGroups`
 * leaves that half unnamed and unclearable.
 *
 * `showFilterControls={false}` keeps these cases on the chip row itself: the
 * trailing add/clear menu renders the built-in facet controls, which need a
 * fuller view model than any of these facets have anything to say about.
 */
const NOOP_CONTROLLER: TableFiltersController = {
  filters: {
    assigneeIds: [],
    assignToMe: false,
    hideCompletedItems: false,
    favoritesOnly: false,
    statuses: [],
    priorities: [],
    date: null,
    tagIds: [],
  },
  toggleAssignee: () => undefined,
  toggleAssignToMe: () => undefined,
  toggleHideCompletedItems: () => undefined,
  toggleFavoritesOnly: () => undefined,
  toggleStatus: () => undefined,
  togglePriority: () => undefined,
  setDateFilter: () => undefined,
  toggleTag: () => undefined,
  clearCategoryFilter: () => undefined,
  clearAllFilters: () => undefined,
  activeChips: [],
};

/** The built-in controls this bar is not asked about in any case below. */
const BASE_VIEW_MODEL: TableFiltersViewModel = {
  teamMembers: [],
  statusOptions: [],
  priorityOptions: [],
};

describe("ActiveFiltersBar host facets", () => {
  it("names an active facet that arrives through facetGroups, not only additionalFacetGroups", () => {
    const viewModel: TableFiltersViewModel = {
      ...BASE_VIEW_MODEL,
      facetGroups: [
        {
          id: "status",
          kind: "options",
          label: "Status",
          options: [
            { id: "active", label: "Active" },
            { id: "blocked", label: "Blocked" },
          ],
          selectedValues: ["blocked"],
          onToggle: () => undefined,
        },
      ],
    };

    render(
      <ActiveFiltersBar
        controller={NOOP_CONTROLLER}
        showFilterControls={false}
        viewModel={viewModel}
      />
    );

    expect(screen.getByText(STATUS_CHIP_PATTERN).textContent).toContain(
      "Blocked"
    );
  });

  it("renders a host facet alongside a built-in chip of the same id", () => {
    // The built-in chip map keys on `chip.category` and the host-facet map keys
    // on `facet:${group.id}`; a host facet is free to use an id that matches a
    // built-in category name. The namespacing matches the champion's
    // and is defensive rather than observable — the two maps are separate child
    // arrays today, so React scopes their keys independently and does not warn.
    // This case pins only what IS reachable: both chips render and are told
    // apart by their labels.
    const controller: TableFiltersController = {
      ...NOOP_CONTROLLER,
      filters: { ...NOOP_CONTROLLER.filters, statuses: ["open"] },
      activeChips: [{ category: "status", label: "Status: Open" }],
    };
    const viewModel: TableFiltersViewModel = {
      ...BASE_VIEW_MODEL,
      statusOptions: [{ id: "open", label: "Open" }],
      additionalFacetGroups: [
        {
          id: "status",
          kind: "options",
          label: "Stage",
          options: [{ id: "b", label: "B" }],
          selectedValues: ["b"],
          onToggle: () => undefined,
        },
      ],
    };

    render(
      <ActiveFiltersBar
        controller={controller}
        showFilterControls={false}
        viewModel={viewModel}
      />
    );

    expect(screen.getByText(STATUS_CHIP_PATTERN).textContent).toBe(
      "Status: Open"
    );
    expect(screen.getByText(STAGE_CHIP_PATTERN).textContent).toBe("Stage: B");
  });

  it("never states a bound the user could not have set when a range bound is non-finite", () => {
    const viewModel: TableFiltersViewModel = {
      ...BASE_VIEW_MODEL,
      additionalFacetGroups: [
        {
          id: "cost",
          kind: "range",
          label: "Cost",
          min: Number.NaN,
          max: Number.POSITIVE_INFINITY,
          onChange: () => undefined,
        },
      ],
    };

    render(
      <ActiveFiltersBar
        controller={NOOP_CONTROLLER}
        showFilterControls={false}
        viewModel={viewModel}
      />
    );

    const chip = screen.getByText(COST_CHIP_PATTERN);
    expect(chip.textContent).not.toMatch(NON_FINITE_PATTERN);
    expect(chip.textContent).toBe("Cost");
  });
});

describe("hasVisibleActiveFilters", () => {
  const ACTIVE_FACET = {
    id: "stage",
    label: "Stage",
    onToggle: () => undefined,
    options: [{ id: "build", label: "Build" }],
    selectedValues: ["build"],
  };

  it("is false while no chip and no facet is active", () => {
    expect(hasVisibleActiveFilters(NOOP_CONTROLLER, BASE_VIEW_MODEL)).toBe(
      false
    );
  });

  it("is true for a facet that arrives through facetGroups or additionalFacetGroups", () => {
    expect(
      hasVisibleActiveFilters(NOOP_CONTROLLER, {
        ...BASE_VIEW_MODEL,
        facetGroups: [ACTIVE_FACET],
      })
    ).toBe(true);
    expect(
      hasVisibleActiveFilters(NOOP_CONTROLLER, {
        ...BASE_VIEW_MODEL,
        additionalFacetGroups: [ACTIVE_FACET],
      })
    ).toBe(true);
  });

  it("ignores an assignee chip the view model hides", () => {
    const controller = {
      ...NOOP_CONTROLLER,
      activeChips: [{ category: "assignee" as const, label: "Owner: Ada" }],
    };
    expect(
      hasVisibleActiveFilters(controller, {
        ...BASE_VIEW_MODEL,
        hideAssignee: true,
      })
    ).toBe(false);
    expect(hasVisibleActiveFilters(controller, BASE_VIEW_MODEL)).toBe(true);
  });
});
