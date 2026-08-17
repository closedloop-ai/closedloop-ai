import type { TableFiltersReturn } from "@repo/app/documents/hooks/use-table-filters";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "./render-with-nav";

// The real filter-UI hook reaches for the auth/API ports through `useTags`; the
// branch under test is which chips and controls the BAR renders, so the
// controller/viewModel are stubbed and everything below stays real.
vi.mock("../use-document-table-filter-ui", () => ({
  useDocumentTableFilterUi: () => ({
    controller: {
      activeChips: [],
      clearAllFilters: vi.fn(),
      clearCategoryFilter: vi.fn(),
      filters: {
        assigneeIds: [],
        priorities: [],
        projectIds: [],
        statuses: [],
        tagIds: [],
      },
    },
    viewModel: {
      hideAssignee: true,
      priorityOptions: [],
      statusOptions: [],
      tagOptions: [],
      teamMembers: [],
    },
  }),
}));

const { DocumentTableToolbar } = await import("../document-table-toolbar");

/**
 * FEA-1626 — a surface-owned chip has to survive to the screen.
 *
 * The toolbar has always mounted its filters bar only when a FACET filter is
 * active. My Tasks' recency window is a server request parameter, not a facet,
 * so under that rule the bar stayed hidden and the board silently returned fewer
 * rows with nothing on screen saying why (closedloop-ai-stage). The bar now also
 * renders for surface-owned chips — and suppresses the facet add/clear controls
 * when that is the only reason it is up, so no "Clear all" sits there with
 * nothing to clear.
 */

const CHIP_LABEL = "Last 90 days";
const CLEAR_ALL_LABEL = "Clear all";
const ADD_FILTER_LABEL = "Add filter";

function filtersReturn(isAnyFilterActive: boolean): TableFiltersReturn {
  return {
    isAnyFilterActive,
    filters: {
      statuses: [],
      priorities: [],
      projectIds: [],
      assigneeIds: [],
      tagIds: [],
      favoritesOnly: false,
      hideCompleted: false,
      dateRange: undefined,
    },
    setFilters: vi.fn(),
    clearAllFilters: vi.fn(),
    clearPersistedFilters: vi.fn(),
    applyFilters: (items: unknown[]) => items,
    rootItems: [],
  } as unknown as TableFiltersReturn;
}

function renderToolbar(options: {
  isAnyFilterActive: boolean;
  extraChips?: React.ReactNode;
}) {
  return render(
    <DocumentTableToolbar
      activeFiltersBarProps={{
        extraChips: options.extraChips,
        filtersReturn: filtersReturn(options.isAnyFilterActive),
        hideAssignee: true,
        showFilterControls: options.isAnyFilterActive,
        teamMembers: [],
        teamMembersError: null,
        teamMembersLoading: false,
      }}
      filterText=""
      onFilterTextChange={vi.fn()}
      tableViewMenuProps={{ view: "list", onChangeView: vi.fn() }}
    />
  );
}

afterEach(cleanup);

describe("DocumentTableToolbar surface-owned chips (FEA-1626)", () => {
  it("renders a surface chip with no facet filter active", () => {
    const onRemove = vi.fn();
    renderToolbar({
      extraChips: (
        <button
          aria-label={`Remove ${CHIP_LABEL} filter`}
          onClick={onRemove}
          type="button"
        >
          {CHIP_LABEL}
        </button>
      ),
      isAnyFilterActive: false,
    });

    expect(screen.getByText(CHIP_LABEL)).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: `Remove ${CHIP_LABEL} filter` })
    );
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("hides the facet add/clear controls when the chip is the only reason the bar is up", () => {
    renderToolbar({
      extraChips: <span>{CHIP_LABEL}</span>,
      isAnyFilterActive: false,
    });

    expect(screen.queryByText(CLEAR_ALL_LABEL)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: ADD_FILTER_LABEL })
    ).not.toBeInTheDocument();
  });

  it("keeps the bar hidden entirely when there is no chip and no active facet", () => {
    // Every other surface that mounts this toolbar depends on this: the bar must
    // not start appearing on screens that never opted into a surface chip.
    renderToolbar({ isAnyFilterActive: false });

    expect(screen.queryByText(CLEAR_ALL_LABEL)).not.toBeInTheDocument();
  });

  it("still shows the facet controls when a facet filter IS active", () => {
    renderToolbar({ isAnyFilterActive: true });

    expect(screen.getByText(CLEAR_ALL_LABEL)).toBeInTheDocument();
  });
});
