// @vitest-environment jsdom
import { SessionsListToolbarV2 } from "@repo/app/agents/components/sessions/sessions-list-toolbar-v2";
import { branchesToolbarPropsFixture } from "@repo/app/branches/components/__tests__/branches-toolbar-props.fixtures";
import { BranchesListToolbarV2 } from "@repo/app/branches/components/branches-list-toolbar-v2";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  buildFacetOnlyFiltersViewModel,
  NOOP_TABLE_FILTERS_CONTROLLER,
} from "@repo/app/shared/lib/facet-filter";
import { TABLE_DATE_RANGE_OPTIONS } from "@repo/app/shared/lib/table-date-range-options";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

/**
 * ISS-13035: with gridview-adoption off, Sessions and Branches render the
 * toolbar they rendered before the shared toolbar (#9202): a "Filter" button,
 * no search box, no Add field, and the chip row the host supplied.
 */
const ACTIVE_FACET = buildFacetOnlyFiltersViewModel([
  {
    id: "model",
    label: "Model",
    onToggle: () => undefined,
    options: [{ id: "gpt", label: "GPT" }],
    selectedValues: ["gpt"],
  },
]);

afterEach(cleanup);

function closed(ui: ReactElement) {
  return (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
    >
      {ui}
    </FeatureFlagAdapterProvider>
  );
}

function sessions(active: boolean) {
  return (
    <SessionsListToolbarV2
      activeFiltersViewModel={active ? ACTIVE_FACET : undefined}
      columns={[]}
      dateRange="7d"
      dateRangeOptions={TABLE_DATE_RANGE_OPTIONS}
      filterController={NOOP_TABLE_FILTERS_CONTROLLER}
      filterViewModel={ACTIVE_FACET}
      hiddenSummaryCardIds={new Set()}
      onAddField={() => undefined}
      onApplySavedView={() => undefined}
      onClearFilters={() => undefined}
      onDateRangeChange={() => undefined}
      onSaveView={() => undefined}
      onToggleColumn={() => undefined}
      onToggleSummaryCard={() => undefined}
      savedViews={{ activeViewId: null, onSave: () => undefined, views: [] }}
      search={{ onChange: () => undefined, value: "" }}
      sortGrouping={{
        grouping: EMPTY_TABLE_GROUPING,
        groupOptions: [{ id: "status", label: "Status" }],
        onClearSort: () => undefined,
        onGroupingChange: () => undefined,
        onSort: () => undefined,
        sortBy: null,
        sortOptions: [{ id: "name", label: "Name" }],
      }}
      visibleColumnIds={new Set()}
    />
  );
}

function branches() {
  return (
    <BranchesListToolbarV2
      {...branchesToolbarPropsFixture({
        rows: [],
        visibleColumns: new Set(["owner"]),
      })}
      columnControls={{
        grouping: EMPTY_TABLE_GROUPING,
        onGroupingChange: () => undefined,
        onResetSort: () => undefined,
        onSortChange: () => undefined,
        sortDir: "asc",
        sortKey: "lastActivity",
      }}
      customFieldColumns={{
        onAddField: () => undefined,
        toggleColumn: () => undefined,
        toggleOptions: [],
        visibleColumnIds: new Set(["owner"]),
      }}
    />
  );
}

function buttonLabels(container: HTMLElement) {
  return Array.from(container.querySelectorAll("button"))
    .filter((button) => !button.closest("[data-slot$='compact']"))
    .map((button) =>
      (button.getAttribute("aria-label") ?? button.textContent ?? "").trim()
    );
}

describe("ISS-13035 gridview-adoption off, Sessions toolbar", () => {
  it("FLAG-OFF-S1 shows a Filter button and no search box or Add field", () => {
    const { container } = render(closed(sessions(false)));
    expect(container.querySelector("input")).toBeNull();
    const labels = buttonLabels(container);
    expect(labels).toContain("Filter");
    expect(labels).not.toContain("Filters");
    expect(labels).not.toContain("Add field");
  });

  it("FLAG-OFF-S2 keeps saved views in the primary slot between Filter and Sort", () => {
    const { container } = render(closed(sessions(false)));
    const labels = buttonLabels(container);
    expect(labels.indexOf("Views")).toBeGreaterThan(labels.indexOf("Filter"));
    expect(labels.indexOf("Views")).toBeLessThan(labels.indexOf("Sort"));
  });

  it("FLAG-OFF-S3 renders the chip row the host supplied only through the host model", () => {
    const { queryByRole } = render(closed(sessions(true)));
    expect(queryByRole("button", { name: "Add filter" })).not.toBeNull();
  });
});

describe("ISS-13035 gridview-adoption off, Branches toolbar", () => {
  it("FLAG-OFF-B1 shows a Filter button, no search box, no Sort and no Add field", () => {
    const { container } = render(closed(branches()));
    expect(container.querySelector("input")).toBeNull();
    const labels = buttonLabels(container);
    expect(labels).toContain("Filter");
    expect(labels).not.toContain("Add field");
    expect(labels.some((label) => label.startsWith("Sort"))).toBe(false);
  });
});
