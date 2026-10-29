import { ActiveFiltersBar } from "@closedloop-ai/design-system/components/ui/active-filters-bar";
import type {
  TableFiltersController,
  TableFiltersViewModel,
} from "@closedloop-ai/design-system/components/ui/table-filters";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const COST_PATTERN = /^Cost:/;
const NON_FINITE_PATTERN = /NaN|Infinity/;

/**
 * ISS-7051. The chip row must work for a surface that drives its filters
 * through `facetGroups`, because that is what every real consumer does.
 *
 * `facetGroups` REPLACES the built-in assignee/status/priority/date/tag
 * controls, so those surfaces pair it with a no-op controller and contribute no
 * `activeChips` — and the bar previously read only `activeChips` and
 * `additionalFacetGroups`. The result was a chip row that rendered nothing but
 * its own "Clear all" for the Sessions and Branches toolbars, which is why
 * Sessions carries a bespoke 8.6KB `SessionsActiveFiltersBar` and Branches
 * simply has no chip row at all.
 *
 * The controller below has an EMPTY `activeChips` on purpose: these tests fail
 * against any implementation that needs the host to mirror its facets into the
 * controller by hand.
 */

/** Any chip naming the Status facet, however its selections are joined. */
const STATUS_CHIP_PATTERN = /^Status:/;

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

function buildViewModel(
  onToggle: (value: string) => void,
  selectedValues: string[]
): TableFiltersViewModel {
  return {
    teamMembers: [],
    statusOptions: [],
    priorityOptions: [],
    hideQuickToggles: true,
    facetGroups: [
      {
        id: "status",
        label: "Status",
        options: [
          { id: "active", label: "Active" },
          { id: "blocked", label: "Blocked" },
          { id: "done", label: "Done" },
        ],
        selectedValues,
        onToggle,
      },
    ],
  };
}

describe("PRD-721 AC-2 / DT-FS-02 ActiveFiltersBar facet-group chips", () => {
  it("renders a chip for an active facetGroups selection", () => {
    render(
      <ActiveFiltersBar
        controller={NOOP_CONTROLLER}
        viewModel={buildViewModel(() => undefined, ["active"])}
      />
    );

    expect(screen.getByText("Status: Active")).toBeVisible();
  });

  it("names every selected option in one chip", () => {
    render(
      <ActiveFiltersBar
        controller={NOOP_CONTROLLER}
        viewModel={buildViewModel(() => undefined, ["active", "blocked"])}
      />
    );

    expect(screen.getByText("Status: Active, Blocked")).toBeVisible();
  });

  it("renders no facet chip while nothing is selected", () => {
    render(
      <ActiveFiltersBar
        controller={NOOP_CONTROLLER}
        viewModel={buildViewModel(() => undefined, [])}
      />
    );

    expect(screen.queryByText(STATUS_CHIP_PATTERN)).toBeNull();
  });

  // ISS-8909: the bar keeps offering "Clear all" with no chip of its own active,
  // and that is the contract rather than an oversight. Whether the row mounts at
  // all belongs to the host, which gates on `filtersActive` — a signal that
  // counts an explicit date window, a search term and an owner scope, none of
  // which reach this component. An earlier revision suppressed the row here on
  // "no chips and no host facets" and thereby removed the ONLY control that
  // clears a windowed Sessions list; `v2-custom-window-url-seam` caught it.
  it("still offers Clear all when the host mounts it with no chip active", () => {
    render(
      <ActiveFiltersBar
        controller={NOOP_CONTROLLER}
        viewModel={buildViewModel(() => undefined, [])}
      />
    );

    expect(
      screen.getByRole("button", { name: "Clear all" })
    ).toBeInTheDocument();
  });

  it("clears the whole facet when its chip is removed", () => {
    const onToggle = vi.fn();
    render(
      <ActiveFiltersBar
        controller={NOOP_CONTROLLER}
        viewModel={buildViewModel(onToggle, ["active", "blocked"])}
      />
    );

    screen
      .getByRole("button", { name: "Remove Status: Active, Blocked filter" })
      .click();

    // A facet has no single "clear" callback, so removing the chip toggles off
    // each selected value — both, not just the first.
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(onToggle).toHaveBeenCalledWith("active");
    expect(onToggle).toHaveBeenCalledWith("blocked");
  });

  it("clears facet selections from Clear all", () => {
    const onToggle = vi.fn();
    const clearAllFilters = vi.fn();
    render(
      <ActiveFiltersBar
        controller={{ ...NOOP_CONTROLLER, clearAllFilters }}
        viewModel={buildViewModel(onToggle, ["active"])}
      />
    );

    screen.getByRole("button", { name: "Clear all" }).click();

    // Both halves: the controller's own categories AND the host facets, which
    // the controller knows nothing about.
    expect(clearAllFilters).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith("active");
  });
});

/**
 * ISS-7349. The rest of the bar's rendering rules — the built-in `activeChips`
 * row, the two visibility gates over it, the range facet's label, and the
 * additional-facets list — none of which the ISS-7051 suite above needed to
 * touch because it exists to pin the `facetGroups` path specifically.
 *
 * The two gates are the ones worth having: `hideAssignee` and `showTags` decide
 * whether a chip a surface cannot act on is rendered at all, and a chip offering
 * to clear a filter the surface does not expose is a control that lies about
 * what it does.
 */

const BASE_VIEW_MODEL: TableFiltersViewModel = {
  hideQuickToggles: true,
  priorityOptions: [],
  statusOptions: [],
  teamMembers: [],
};

function withChips(
  chips: TableFiltersController["activeChips"],
  clearCategoryFilter = vi.fn()
): TableFiltersController {
  return { ...NOOP_CONTROLLER, activeChips: chips, clearCategoryFilter };
}

describe("ActiveFiltersBar built-in chips", () => {
  it("renders a chip per active controller category", () => {
    render(
      <ActiveFiltersBar
        controller={withChips([
          { category: "status", label: "Status: Open" },
          { category: "favorites", label: "Favorites" },
        ])}
        viewModel={BASE_VIEW_MODEL}
      />
    );

    expect(screen.getByText("Status: Open")).toBeVisible();
    expect(screen.getByText("Favorites")).toBeVisible();
  });

  it("clears just that category when a built-in chip is removed", () => {
    const clearCategoryFilter = vi.fn();
    render(
      <ActiveFiltersBar
        controller={withChips(
          [{ category: "status", label: "Status: Open" }],
          clearCategoryFilter
        )}
        viewModel={BASE_VIEW_MODEL}
      />
    );

    screen.getByRole("button", { name: "Remove Status: Open filter" }).click();

    expect(clearCategoryFilter).toHaveBeenCalledWith("status");
  });

  it("hides the assignee chip when the surface has no assignee filter", () => {
    // A chip offering to clear a filter the surface does not expose is a
    // control that lies about what it does.
    render(
      <ActiveFiltersBar
        controller={withChips([
          { category: "assignee", label: "Assignee: Ada" },
        ])}
        viewModel={{ ...BASE_VIEW_MODEL, hideAssignee: true }}
      />
    );

    expect(screen.queryByText("Assignee: Ada")).toBeNull();
  });

  it("keeps the assignee chip by default", () => {
    render(
      <ActiveFiltersBar
        controller={withChips([
          { category: "assignee", label: "Assignee: Ada" },
        ])}
        viewModel={BASE_VIEW_MODEL}
      />
    );

    expect(screen.getByText("Assignee: Ada")).toBeVisible();
  });

  it("hides the tags chip when the surface turns tags off", () => {
    render(
      <ActiveFiltersBar
        controller={withChips([{ category: "tags", label: "Tags: infra" }])}
        viewModel={{ ...BASE_VIEW_MODEL, showTags: false }}
      />
    );

    expect(screen.queryByText("Tags: infra")).toBeNull();
  });

  it("keeps the tags chip when the surface leaves the default in place", () => {
    // `showTags` defaults to true when the view model says nothing.
    render(
      <ActiveFiltersBar
        controller={withChips([{ category: "tags", label: "Tags: infra" }])}
        viewModel={BASE_VIEW_MODEL}
      />
    );

    expect(screen.getByText("Tags: infra")).toBeVisible();
  });
});

describe("ActiveFiltersBar range facet chips", () => {
  const rangeFacet = (min?: number, max?: number, onChange = vi.fn()) => ({
    id: "cost",
    kind: "range" as const,
    label: "Cost",
    max,
    min,
    onChange,
  });

  it("names both bounds in the chip", () => {
    render(
      <ActiveFiltersBar
        controller={NOOP_CONTROLLER}
        viewModel={{ ...BASE_VIEW_MODEL, facetGroups: [rangeFacet(0, 9)] }}
      />
    );

    expect(screen.getByText("Cost: 0 – 9")).toBeVisible();
  });

  it("formats a min-only bound as open-ended", () => {
    render(
      <ActiveFiltersBar
        controller={NOOP_CONTROLLER}
        viewModel={{ ...BASE_VIEW_MODEL, facetGroups: [rangeFacet(5)] }}
      />
    );

    expect(screen.getByText("Cost: 5+")).toBeVisible();
  });

  it("formats a max-only bound as at-most", () => {
    render(
      <ActiveFiltersBar
        controller={NOOP_CONTROLLER}
        viewModel={{
          ...BASE_VIEW_MODEL,
          facetGroups: [rangeFacet(undefined, 50)],
        }}
      />
    );

    expect(screen.getByText("Cost: ≤ 50")).toBeVisible();
  });

  it("never labels a non-finite bound, and keeps the chip clearable", () => {
    // The facet reads as active (a bound is set), so hiding the chip would
    // strand the user with a filter they cannot clear.
    const onChange = vi.fn();
    render(
      <ActiveFiltersBar
        controller={NOOP_CONTROLLER}
        viewModel={{
          ...BASE_VIEW_MODEL,
          facetGroups: [
            rangeFacet(Number.NaN, Number.POSITIVE_INFINITY, onChange),
          ],
        }}
      />
    );

    expect(screen.queryByText(NON_FINITE_PATTERN)).toBeNull();
    screen.getByRole("button", { name: "Remove Cost filter" }).click();

    expect(onChange).toHaveBeenCalledWith({});
  });

  it("names the finite half when only one bound is non-finite", () => {
    render(
      <ActiveFiltersBar
        controller={NOOP_CONTROLLER}
        viewModel={{
          ...BASE_VIEW_MODEL,
          facetGroups: [rangeFacet(5, Number.NaN)],
        }}
      />
    );

    expect(screen.getByText("Cost: 5+")).toBeVisible();
  });

  it("renders no chip for an unbounded range facet", () => {
    render(
      <ActiveFiltersBar
        controller={NOOP_CONTROLLER}
        viewModel={{ ...BASE_VIEW_MODEL, facetGroups: [rangeFacet()] }}
      />
    );

    expect(screen.queryByText(COST_PATTERN)).toBeNull();
  });

  it("clears both bounds when the range chip is removed", () => {
    const onChange = vi.fn();
    render(
      <ActiveFiltersBar
        controller={NOOP_CONTROLLER}
        viewModel={{
          ...BASE_VIEW_MODEL,
          facetGroups: [rangeFacet(0, 9, onChange)],
        }}
      />
    );

    screen.getByRole("button", { name: "Remove Cost: 0 – 9 filter" }).click();

    expect(onChange).toHaveBeenCalledWith({});
  });
});

describe("ActiveFiltersBar additional facets", () => {
  it("renders chips from additionalFacetGroups alongside the built-ins", () => {
    render(
      <ActiveFiltersBar
        controller={withChips([{ category: "status", label: "Status: Open" }])}
        viewModel={{
          ...BASE_VIEW_MODEL,
          additionalFacetGroups: [
            {
              id: "repo",
              label: "Repo",
              onToggle: vi.fn(),
              options: [{ id: "alpha", label: "Alpha" }],
              selectedValues: ["alpha"],
            },
          ],
        }}
      />
    );

    expect(screen.getByText("Status: Open")).toBeVisible();
    expect(screen.getByText("Repo: Alpha")).toBeVisible();
  });

  // One active facet, because the bar renders nothing at all when there is
  // nothing to name and nothing to clear. These two cases pin LABEL RESOLUTION,
  // which is unchanged; they previously relied on the bar rendering its controls
  // over an empty filter set, which is the defect the guard removed.
  it("uses a caller-supplied Clear all label", () => {
    render(
      <ActiveFiltersBar
        controller={NOOP_CONTROLLER}
        viewModel={{
          ...buildViewModel(() => undefined, ["active"]),
          labels: { addFilter: "New filter", clearAll: "Reset" },
        }}
      />
    );

    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "New filter" })
    ).toBeInTheDocument();
  });

  it("falls back to the default action labels", () => {
    render(
      <ActiveFiltersBar
        controller={NOOP_CONTROLLER}
        viewModel={buildViewModel(() => undefined, ["active"])}
      />
    );

    expect(
      screen.getByRole("button", { name: "Clear all" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add filter" })
    ).toBeInTheDocument();
  });
});
