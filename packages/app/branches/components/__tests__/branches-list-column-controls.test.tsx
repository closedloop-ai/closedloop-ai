import { BRANCHES_LIST_COLUMN_CONTROLS_FLAG_KEY } from "@repo/api/src/types/branches-list-column-controls-flag";
import { LIST_TOOLBAR_FILTER_LABEL } from "@repo/app/shared/components/list-toolbar-copy";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { isGridChromeRowId } from "@repo/design-system/lib/grid-table-v2-chrome-rows";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubResponsiveNarrowViewport } from "../../../test/mocks/responsive-narrow-viewport";
import {
  BRANCH_NAME_COLUMN_ID,
  BRANCH_PRIORITY_COLUMN_ID,
  branchColumnLabel,
} from "../../lib/branch-column-view-model";
import { type BranchRow, BranchRowStatus } from "../../lib/branch-row";
import { BranchesListSurfaceV2 } from "../branches-list-surface-v2";
import { branchesListSurfaceV2SummaryPropsFixture } from "./branches-list-surface-v2-props.fixtures";
import { branchesToolbarPropsFixture } from "./branches-toolbar-props.fixtures";

/**
 * The Branches list's Sort, Group and Filter controls come from its column view
 * model. Sort remains available when the grouping flag is off because the
 * narrow list projects only the Name column header.
 *
 * Every assertion drives the production mount and reads the rendered
 * affordance. Asserting the view model's flags against themselves would be
 * circular; what these prove is that the SHARED components behave differently
 * because of them — a column declaring `isSortable: false` is absent from the
 * Sort menu, the three declared grouping dimensions are the whole Group
 * vocabulary, and picking one actually partitions the rows on screen.
 */

const ROWS: BranchRow[] = [
  branchFixture({
    id: "a",
    branchName: "feature/a",
    owner: "Alex Rivera",
    repo: "acme/web",
  }),
  branchFixture({
    id: "b",
    branchName: "feature/b",
    owner: "Blake Chen",
    repo: "acme/api",
    status: BranchRowStatus.Merged,
  }),
  branchFixture({
    id: "c",
    branchName: "feature/c",
    owner: "Alex Rivera",
    repo: "acme/api",
  }),
];

const RE_ACTIVE_LAST_ACTIVITY_SORT = /^1\.\s*Last active/;
const RE_SORTED_BY = /^Sorted by/;
const RE_REPOSITORY_HEADER = /^Repository/;
const RE_REPOSITORY_FACET = /repository/i;
const RE_COLLABORATORS_FACET = /collaborators/i;
const RE_LINKED_SESSIONS_FACET = /linked sessions/i;
// Built from the view model, not from the word "Name": the point of the entry
// is that the grid header and the Sort menu read ONE declaration, so a test
// spelling the literal would keep passing after they diverged.
const LEAD_COLUMN_LABEL = branchColumnLabel(BRANCH_NAME_COLUMN_ID);
const RE_LEAD_HEADER = new RegExp(`^${LEAD_COLUMN_LABEL}`);

const VISIBLE_COLUMNS = new Set([
  "owner",
  "status",
  "repo",
  "collaborators",
  "sessions",
  "tags",
]);

const PRIORITY_LABEL = branchColumnLabel(BRANCH_PRIORITY_COLUMN_ID);
const RE_PRIORITY_HEADER = new RegExp(`^${PRIORITY_LABEL}`);
const RE_PRIORITY_FACET = new RegExp(PRIORITY_LABEL, "i");
const COLLABORATORS_LABEL = branchColumnLabel("collaborators");
const RE_COLLABORATORS_HEADER = new RegExp(`^${COLLABORATORS_LABEL}`);
const GROUP_BUTTON_NAME = "Group";
// Visible in the view state, so only the host opt-in can withhold it.
const VISIBLE_COLUMNS_WITH_PRIORITY = new Set([
  ...VISIBLE_COLUMNS,
  BRANCH_PRIORITY_COLUMN_ID,
]);
let restoreViewport: (() => void) | undefined;

afterEach(() => {
  restoreViewport?.();
  restoreViewport = undefined;
});

describe("with the column controls flag off", () => {
  it("keeps sorting available for the narrow list without enabling grouping", () => {
    renderSurface({ compact: true, flagOn: false });

    expect(screen.getByRole("button", { name: "View" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: GROUP_BUTTON_NAME })
    ).toBeNull();
  });
});

describe.each([false, true])(
  "measured toolbar placement with flag %s",
  (flagOn) => {
    it("offers Sort in the wide toolbar beside the sortable headers (ISS-13007)", () => {
      renderSurface({ flagOn });

      expect(
        screen.getByRole("button", { name: "Options" })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: RE_REPOSITORY_HEADER })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: RE_SORTED_BY })
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: GROUP_BUTTON_NAME }) !== null
      ).toBe(flagOn);
    });

    it("keeps narrow-list Sort and gates only Group", async () => {
      const user = userEvent.setup();
      renderSurface({ compact: true, flagOn });

      expect(screen.getByRole("grid")).toHaveAttribute("aria-colcount", "1");
      expect(screen.getByRole("button", { name: "View" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "View" }));
      expect(screen.getByText("Sorting", { exact: true })).toBeInTheDocument();
      expect(screen.queryByText("Grouping", { exact: true }) !== null).toBe(
        flagOn
      );
    });
  }
);

describe("the Sort menu", () => {
  it("offers the declared sortable columns and withholds the rest", async () => {
    const user = userEvent.setup();
    renderSurface({ compact: true, flagOn: true });

    await openCompactSortOptions(user);

    // Present: declared `isSortable: true`.
    expect(
      await withinSortSubmenu().findByRole("menuitem", { name: "Repository" })
    ).toBeInTheDocument();
    expect(
      withinSortSubmenu().getByRole("menuitem", { name: "Linked sessions" })
    ).toBeInTheDocument();
    // Absent: declared `isSortable: false`. Both are real columns the table
    // renders and both carry a filter facet, so their absence here can only
    // come from the sort flag.
    expect(
      withinSortSubmenu().queryByRole("menuitem", { name: COLLABORATORS_LABEL })
    ).toBeNull();
    expect(
      withinSortSubmenu().queryByRole("menuitem", {
        name: branchColumnLabel("tags"),
      })
    ).toBeNull();
  });

  it("asks the host for the wire sort key behind the column picked", async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    renderSurface({ compact: true, flagOn: true, onSort });

    await openCompactSortOptions(user);
    await user.click(
      await withinSortSubmenu().findByRole("menuitem", { name: "Status" })
    );

    // Ascending because the shared menu is at its one-rule cap, so a pick
    // REPLACES the ordering rather than adding a clause to it.
    expect(onSort).toHaveBeenCalledWith("status", "asc");
  });

  it("restores the default ordering when the sort is cleared", async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    renderSurface({ compact: true, flagOn: true, onSort });

    await user.click(screen.getByRole("button", { name: "View" }));
    await user.hover(
      screen.getByRole("menuitem", { name: RE_ACTIVE_LAST_ACTIVITY_SORT })
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Remove sort" })
    );

    // Not "unsorted": the list is always ordered by something, so clearing
    // returns to the default a fresh mount has.
    expect(onSort).toHaveBeenCalledWith("lastActivity", "desc");
  });
});

describe("the Group menu", () => {
  it("offers exactly the operator's three grouping dimensions", async () => {
    const user = userEvent.setup();
    renderSurface({ flagOn: true });

    await user.click(screen.getByRole("button", { name: GROUP_BUTTON_NAME }));
    await user.click(
      screen.getByRole("combobox", { name: "Primary grouping field" })
    );

    expect(
      await screen.findByRole("option", { name: "Author" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Repository" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "PR / review state" })
    ).toBeInTheDocument();
    // A column the view model does not declare groupable, and one that is
    // sortable-and-filterable, so its absence is the group flag alone.
    expect(screen.queryByRole("option", { name: "Changes" })).toBeNull();
  });

  it.each([
    ["Author", ["Alex Rivera", "Blake Chen"]],
    ["Repository", ["web", "api"]],
    ["PR / review state", ["Open", "Merged"]],
  ])("partitions the rows when grouped by %s", async (dimension, bands) => {
    renderSurface({ flagOn: true });

    await selectPrimaryGrouping(dimension);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Groups: 1" })).toBeTruthy()
    );
    // The band's collapse toggle, which only a rendered band emits — the owner
    // and status CELLS carry the same words, so a text query would pass over an
    // ungrouped table.
    for (const band of bands) {
      expect(
        screen.getByRole("button", { expanded: true, name: band })
      ).toBeInTheDocument();
    }
    // Every row still renders: a band is an arrangement, never a filter.
    // DATA rows only — ISS-10245 made `navigableHeaderCells` unconditional, so
    // the chrome header and each band's header row carry `data-grid-row-id` too.
    expect(dataRowCount()).toBe(ROWS.length);
  });
});

describe("the repository bands", () => {
  // The repository CELL disambiguates its short name against the whole filtered
  // corpus (`allRows`), so a band naming itself against the current page alone
  // says "web" over rows whose own cells read "acme/web" (whitlockk review). The
  // colliding repository is deliberately OFF this page: on it, the page and the
  // corpus agree and the bug is invisible.
  it("names a band from the corpus the cells read, not the page in hand", async () => {
    const page = [branchFixture({ id: "a", repo: "acme/web" })];
    const corpus = [...page, branchFixture({ id: "z", repo: "other/web" })];
    renderSurface({ allRows: corpus, flagOn: true, items: page });

    await selectPrimaryGrouping("Repository");

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Groups: 1" })).toBeTruthy()
    );
    expect(
      screen.getByRole("button", { expanded: true, name: "acme/web" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { expanded: true, name: "web" })).toBe(
      null
    );
  });
});

describe("the group level's options", () => {
  // Every Branches grouping dimension is cut FROM the rows being banded, so no
  // band exists outside them for "Show empty groups" to reveal and
  // `groupBranchRows` has nothing to materialize. Offering the action would
  // flip a checked state the table can never answer (whitlockk review).
  it("withholds the empty-group action the resolver cannot honour", async () => {
    renderSurface({ flagOn: true });

    await selectPrimaryGrouping("Author");

    // The level editor IS rendered — so the absence below is the opt-out and
    // not a group menu that never opened.
    expect(
      await screen.findByRole("combobox", { name: "Primary group order" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Primary group options" })
    ).toBe(null);
  });
});

describe("the column headers", () => {
  // The grid's own header contract reads the SAME declaration the toolbar does,
  // so a column cannot be clickable in one place and absent from the other.
  it("makes a declared-sortable header clickable and leaves the rest inert", () => {
    renderSurface({ flagOn: false });

    expect(
      screen.getByRole("button", { name: RE_REPOSITORY_HEADER })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: RE_COLLABORATORS_HEADER })
    ).toBeNull();
    expect(screen.getByText("Collaborators")).toBeInTheDocument();
  });

  // The LEAD column is in the view model like any other (davetho review), so
  // its header wording and its ordering come from the same entry the Sort menu
  // reads rather than from a literal beside the grid's geometry.
  it("orders the lead header by the key its view-model entry declares", async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    renderSurface({ flagOn: false, onSort });

    await user.click(screen.getByRole("button", { name: RE_LEAD_HEADER }));

    // The KEY is the contract here; the direction is the grid's own toggle rule,
    // which this entry does not own.
    expect(onSort.mock.calls[0]?.[0]).toBe(BRANCH_NAME_COLUMN_ID);
  });
});

describe("the filter popover", () => {
  it("offers the facets the columns declare and none they do not", async () => {
    const user = userEvent.setup();
    renderSurface({ flagOn: true });

    await user.click(
      screen.getByRole("button", { name: LIST_TOOLBAR_FILTER_LABEL })
    );

    expect(
      await screen.findByRole("menuitem", { name: RE_REPOSITORY_FACET })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: RE_COLLABORATORS_FACET })
    ).toBeInTheDocument();
    // `sessions` is the counterfactual for the DECLARATION: the Sort menu
    // offers it above and the popover must not, because the column declares
    // `isFilterable: false`. The admission RULE that reads that flag is
    // exercised causally in `branch-column-view-model.test.ts`, which feeds it
    // a facet no column declares.
    expect(
      screen.queryByRole("menuitem", { name: RE_LINKED_SESSIONS_FACET })
    ).toBe(null);
  });
});

// ISS-10332 (#7762 review): a source that cannot write a `priority` (an older
// Desktop build's local store) does not opt in, and must offer the column nowhere.
describe("the Priority column", () => {
  // Both flag states: with the column controls off, the Filter popover is not
  // narrowed by the view model, so the facet's own withholding is what counts.
  it.each([false, true])(
    "is offered nowhere on a mount that does not opt in (column controls %s)",
    async (flagOn) => {
      const user = userEvent.setup();
      renderSurface({ flagOn, visibleColumns: VISIBLE_COLUMNS_WITH_PRIORITY });

      expect(screen.queryByText(PRIORITY_LABEL)).toBeNull();
      expect(await priorityMenuEntries(user)).toEqual({
        columnsPickerRow: false,
        filterFacet: false,
      });
      cleanup();
      renderSurface({
        compact: true,
        flagOn,
        visibleColumns: VISIBLE_COLUMNS_WITH_PRIORITY,
      });
      await openCompactSortOptions(user);
      expect(
        withinSortSubmenu().queryByRole("menuitem", { name: PRIORITY_LABEL })
      ).toBeNull();
    }
  );

  it("is offered everywhere once the host opts in", async () => {
    const user = userEvent.setup();
    renderSurface({
      flagOn: true,
      includePriorityColumn: true,
      visibleColumns: VISIBLE_COLUMNS_WITH_PRIORITY,
    });

    expect(
      screen.getByRole("button", { name: RE_PRIORITY_HEADER })
    ).toBeInTheDocument();
    expect(await priorityMenuEntries(user)).toEqual({
      columnsPickerRow: true,
      filterFacet: true,
    });
    cleanup();
    renderSurface({
      compact: true,
      flagOn: true,
      includePriorityColumn: true,
      visibleColumns: VISIBLE_COLUMNS_WITH_PRIORITY,
    });
    await openCompactSortOptions(user);
    expect(
      withinSortSubmenu().getByRole("menuitem", { name: PRIORITY_LABEL })
    ).toBeInTheDocument();
  });
});

/**
 * Opens the Columns picker, the Filter popover and (when the column controls
 * render one) the Sort menu in turn, reporting whether each offers Priority.
 */
async function priorityMenuEntries(
  user: ReturnType<typeof userEvent.setup>
): Promise<Record<string, boolean>> {
  const entries: Record<string, boolean> = {};
  await user.click(screen.getAllByRole("button", { name: "Options" })[0]!);
  await screen.findByRole("menuitem", { name: RE_REPOSITORY_HEADER });
  entries.columnsPickerRow =
    screen.queryByRole("menuitem", { name: PRIORITY_LABEL }) !== null;
  await user.keyboard("{Escape}");

  await user.click(
    screen.getByRole("button", { name: LIST_TOOLBAR_FILTER_LABEL })
  );
  await screen.findByRole("menuitem", { name: RE_REPOSITORY_FACET });
  entries.filterFacet =
    screen.queryByRole("menuitem", { name: RE_PRIORITY_FACET }) !== null;
  await user.keyboard("{Escape}");

  return entries;
}

async function selectPrimaryGrouping(dimension: string): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: GROUP_BUTTON_NAME }));
  fireEvent.click(
    screen.getByRole("combobox", { name: "Primary grouping field" })
  );
  fireEvent.click(await screen.findByRole("option", { name: dimension }));
}

/**
 * The wide cluster's Sort trigger, named for the ordering the list already has
 * — Branches is never unsorted, so the trigger never reads a bare "Sort".
 */
async function openCompactSortOptions(
  user: ReturnType<typeof userEvent.setup>
): Promise<void> {
  await user.click(screen.getByRole("button", { name: "View" }));
  await user.click(await screen.findByRole("menuitem", { name: "Sort by" }));
}

function withinSortSubmenu() {
  const content = document.querySelector(
    '[data-slot="dropdown-menu-sub-content"]'
  );
  if (!content) {
    throw new Error("The compact Sort submenu did not open");
  }
  return within(content as HTMLElement);
}

function renderSurface({
  allRows = ROWS,
  compact = false,
  flagOn,
  includePriorityColumn,
  items = ROWS,
  onSort = () => undefined,
  visibleColumns = VISIBLE_COLUMNS,
}: {
  allRows?: BranchRow[];
  compact?: boolean;
  flagOn: boolean;
  includePriorityColumn?: boolean;
  items?: BranchRow[];
  onSort?: (column: string, direction: "asc" | "desc") => void;
  visibleColumns?: Set<string>;
}) {
  if (compact) {
    restoreViewport?.();
    restoreViewport = stubResponsiveNarrowViewport(true).restore;
  }
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: flagOn
          ? [
              BRANCHES_LIST_COLUMN_CONTROLS_FLAG_KEY,
              GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
            ]
          : [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
      })}
    >
      <BranchesListSurfaceV2
        allRows={allRows}
        hasActiveFilters={false}
        hasWindow={false}
        includePriorityColumn={includePriorityColumn}
        isError={false}
        isPending={false}
        isPlaceholderData={false}
        items={items}
        onPageChange={() => undefined}
        onPageSizeChange={() => undefined}
        onRetry={() => undefined}
        onShowAllTime={() => undefined}
        onSort={onSort}
        page={0}
        pageSize={25}
        sortBy="lastActivity"
        sortDir="desc"
        {...branchesListSurfaceV2SummaryPropsFixture()}
        toolbar={branchesToolbarPropsFixture({
          rows: allRows,
          visibleColumns,
        })}
        total={allRows.length}
        totalPages={1}
        visibleColumns={visibleColumns}
      />
    </FeatureFlagAdapterProvider>
  );
}

function branchFixture(over: Partial<BranchRow>): BranchRow {
  return {
    id: "id",
    branchName: "feature/x",
    baseBranch: "main",
    repo: "acme/web",
    owner: "Alex Rivera",
    status: BranchRowStatus.Open,
    prNumber: null,
    prTitle: null,
    prUrl: null,
    prState: null,
    checksPassed: null,
    checksTotal: null,
    checksStatus: null,
    behind: null,
    ahead: null,
    additions: null,
    deletions: null,
    sessionCount: 0,
    commentCount: null,
    lastActivityLabel: "2h ago",
    lastActivityAt: "2026-08-20T00:00:00.000Z",
    ...over,
  };
}

/** The DATA rows, excluding the grid's chrome header and band header rows. */
function dataRowCount(): number {
  return [
    ...document.querySelectorAll<HTMLElement>("[data-grid-row-id]"),
  ].filter((row) => !isGridChromeRowId(row.dataset.gridRowId ?? "")).length;
}
