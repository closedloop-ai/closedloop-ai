// @vitest-environment jsdom

import { renderSessionsHeaderFilterContent } from "@repo/app/agents/components/sessions/sessions-list-surface-filter-content";
import { ListSurfaceToolbarV2 } from "@repo/app/shared/components/list-surface-toolbar-v2";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  buildFacetOnlyFiltersViewModel,
  NOOP_TABLE_FILTERS_CONTROLLER,
} from "@repo/app/shared/lib/facet-filter";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type {
  FilterFacetGroup,
  FilterRangeGroup,
} from "@repo/design-system/components/ui/table-filters";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-12641 / PRD-721 AC-5: with `gridview-adoption` closed, every
 * swapped consumer renders the `-v2` fork `main` rendered before the merge;
 * open, it renders the unsuffixed champion. Each module is replaced by a
 * sentinel naming its family, so a consumer that stops reading the flag, or
 * reads it inverted, fails here.
 */
vi.mock("@repo/design-system/components/ui/filter-popover", () => ({
  FilterPopover: () => <div data-testid="champion-filter-popover" />,
  OptionsFilterContent: () => <div data-testid="champion-options-content" />,
}));
vi.mock("@repo/design-system/components/ui/filter-popover-v2", () => ({
  FilterPopover: () => <div data-testid="fork-filter-popover" />,
  OptionsFilterContent: () => <div data-testid="fork-options-content" />,
}));
vi.mock(
  "@repo/design-system/components/ui/active-filters-bar",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@repo/design-system/components/ui/active-filters-bar")
    >()),
    ActiveFiltersBar: () => <div data-testid="champion-active-filters-bar" />,
  })
);
vi.mock("@repo/design-system/components/ui/active-filters-bar-v2", () => ({
  ActiveFiltersBar: () => <div data-testid="fork-active-filters-bar" />,
}));
vi.mock(
  "@repo/design-system/components/ui/filter-range-submenu",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@repo/design-system/components/ui/filter-range-submenu")
    >()),
    RangeFilterContent: () => <div data-testid="champion-range-content" />,
  })
);
vi.mock("@repo/design-system/components/ui/filter-range-submenu-v2", () => ({
  RangeFilterContent: () => <div data-testid="fork-range-content" />,
}));

const RANGE_GROUP: FilterRangeGroup = {
  kind: "range",
  id: "cost",
  label: "Cost",
  onChange: () => undefined,
};

const OPTIONS_GROUP: FilterFacetGroup = {
  id: "model",
  label: "Model",
  options: [],
  selectedValues: [],
  onToggle: () => undefined,
};

const VIEW_MODEL = buildFacetOnlyFiltersViewModel([RANGE_GROUP, OPTIONS_GROUP]);

afterEach(cleanup);

function renderWithFlag(ui: ReactElement, enabled: boolean | "no-provider") {
  if (enabled === "no-provider") {
    return render(ui);
  }
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: enabled ? [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY] : [],
      })}
    >
      {ui}
    </FeatureFlagAdapterProvider>
  );
}

const toolbar = (
  <ListSurfaceToolbarV2
    columns={[]}
    dateRange=""
    dateRangeOptions={[]}
    filterController={NOOP_TABLE_FILTERS_CONTROLLER}
    filterViewModel={VIEW_MODEL}
    onDateRangeChange={() => undefined}
    onToggleColumn={() => undefined}
    visibleColumnIds={new Set()}
  />
);

const ACTIVE_VIEW_MODEL = buildFacetOnlyFiltersViewModel([
  { ...OPTIONS_GROUP, selectedValues: ["gpt"] },
]);

const chipRow = (
  <ListSurfaceToolbarV2
    activeFiltersViewModel={ACTIVE_VIEW_MODEL}
    columns={[]}
    filterController={NOOP_TABLE_FILTERS_CONTROLLER}
    filterViewModel={ACTIVE_VIEW_MODEL}
    onToggleColumn={() => undefined}
    visibleColumnIds={new Set()}
  />
);

const sessionsHeader = (
  <>
    {renderSessionsHeaderFilterContent(VIEW_MODEL, RANGE_GROUP.id)}
    {renderSessionsHeaderFilterContent(VIEW_MODEL, OPTIONS_GROUP.id)}
  </>
);

describe.each([
  ["closed", false, "fork"],
  ["without a flag provider", "no-provider", "fork"],
  ["open", true, "champion"],
] as const)("gridview-adoption %s", (_name, enabled, family) => {
  const other = family === "fork" ? "champion" : "fork";

  it(`renders the ${family} filter menu in the shared list toolbar`, () => {
    renderWithFlag(toolbar, enabled);
    expect(screen.getByTestId(`${family}-filter-popover`)).toBeInTheDocument();
    expect(screen.queryByTestId(`${other}-filter-popover`)).toBeNull();
  });

  it(`renders the ${family} chip row`, () => {
    renderWithFlag(chipRow, enabled);
    expect(
      screen.getByTestId(`${family}-active-filters-bar`)
    ).toBeInTheDocument();
    expect(screen.queryByTestId(`${other}-active-filters-bar`)).toBeNull();
  });

  it(`renders the ${family} Sessions header filter content`, () => {
    renderWithFlag(sessionsHeader, enabled);
    expect(screen.getByTestId(`${family}-range-content`)).toBeInTheDocument();
    expect(screen.getByTestId(`${family}-options-content`)).toBeInTheDocument();
    expect(screen.queryByTestId(`${other}-range-content`)).toBeNull();
    expect(screen.queryByTestId(`${other}-options-content`)).toBeNull();
  });
});
