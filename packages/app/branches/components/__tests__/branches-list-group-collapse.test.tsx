import { BRANCHES_LIST_COLUMN_CONTROLS_FLAG_KEY } from "@repo/api/src/types/branches-list-column-controls-flag";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import type { TableCollapsedGroups } from "@repo/app/shared/lib/table-collapsed-groups";
import type { TableGroupingState } from "@repo/design-system/components/ui/table-toolbar-model";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  GROUPED_BY_OWNER,
  GROUPED_BY_REPO,
  requiredAxisKey,
} from "../../lib/__tests__/support/branch-grouping-fixtures";
import { type BranchRow, BranchRowStatus } from "../../lib/branch-row";
import { BranchesListSurfaceV2 } from "../branches-list-surface-v2";
import { branchesListSurfaceV2SummaryPropsFixture } from "./branches-list-surface-v2-props.fixtures";
import { branchesToolbarPropsFixture } from "./branches-toolbar-props.fixtures";

/**
 * ISS-9582 — the Branches list's `groupCollapse` port: a host-owned
 * `collapsedGroups` record round-trips through `tableGroupCollapsePort`
 * into the grid's band collapse, and the port drops or carries an unknown
 * key depending on whether the page holds the whole population.
 *
 * Every assertion drives the production mount (real flag, real grouping,
 * real click) and reads rendered rows/bands — never the helper functions in
 * isolation, which `table-collapsed-groups.test.ts` already covers.
 */

const ROWS: BranchRow[] = [
  branchFixture({ id: "a", branchName: "feature/a", repo: "acme/web" }),
  branchFixture({ id: "b", branchName: "feature/b", repo: "acme/api" }),
  branchFixture({ id: "c", branchName: "feature/c", repo: "acme/web" }),
];

const VISIBLE_COLUMNS = new Set([
  "owner",
  "status",
  "repo",
  "collaborators",
  "sessions",
  "tags",
]);

const REPO_AXIS_KEY = requiredAxisKey(GROUPED_BY_REPO);
const OWNER_AXIS_KEY = requiredAxisKey(GROUPED_BY_OWNER);
const COLLAPSED_REPO_KEY = "acme/web";
const UNKNOWN_REPO_KEY = "ghost/repo";
/** A fourth row, deliberately excluded from `items` in the client-paged cases below. */
const OFF_PAGE_ROW = branchFixture({
  id: "d",
  branchName: "feature/d",
  repo: "acme/api",
});

function rowId(id: string): HTMLElement | null {
  return document.querySelector(`[data-grid-row-id="${id}"]`);
}

describe("a collapsed key under the grouped axis", () => {
  it("hides only that band's rows and leaves the other band open", () => {
    renderSurface({
      collapsedGroups: { [REPO_AXIS_KEY]: [COLLAPSED_REPO_KEY] },
      onCollapsedGroupsChange: () => undefined,
    });

    expect(
      screen.getByRole("button", { expanded: false, name: "web" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { expanded: true, name: "api" })
    ).toBeInTheDocument();
    expect(rowId("a")).toBeNull();
    expect(rowId("c")).toBeNull();
    expect(rowId("b")).not.toBeNull();
  });
});

describe("the same key stored under a different axis", () => {
  it("collapses nothing", () => {
    renderSurface({
      collapsedGroups: { [OWNER_AXIS_KEY]: [COLLAPSED_REPO_KEY] },
      onCollapsedGroupsChange: () => undefined,
    });

    expect(
      screen.getByRole("button", { expanded: true, name: "web" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { expanded: true, name: "api" })
    ).toBeInTheDocument();
    for (const id of ["a", "b", "c"]) {
      expect(rowId(id)).not.toBeNull();
    }
  });
});

describe("a stored key that names no band", () => {
  it("collapses nothing and renders without throwing", () => {
    renderSurface({
      collapsedGroups: { [REPO_AXIS_KEY]: [UNKNOWN_REPO_KEY] },
      onCollapsedGroupsChange: () => undefined,
    });

    expect(
      screen.getByRole("button", { expanded: true, name: "web" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { expanded: true, name: "api" })
    ).toBeInTheDocument();
    for (const id of ["a", "b", "c"]) {
      expect(rowId(id)).not.toBeNull();
    }
  });
});

describe("collapsing a band through the UI", () => {
  // ISS-9582: a stored unknown key is provably stale — and so droppable — only
  // when the rendered rows ARE the whole corpus: a complete server population,
  // unfiltered, unwindowed, and not a client-paged subset of `allRows`. Each
  // case below flips exactly one of those four conditions off the "drop" case
  // and pins that the key survives instead.
  it("drops a stored unknown key when the rendered rows are the whole, unfiltered, unwindowed corpus", async () => {
    const user = userEvent.setup();
    const onCollapsedGroupsChange = vi.fn();
    renderSurface({
      collapsedGroups: { [REPO_AXIS_KEY]: [UNKNOWN_REPO_KEY] },
      hasCompletePopulation: true,
      onCollapsedGroupsChange,
    });

    await user.click(screen.getByRole("button", { name: "web" }));

    expect(onCollapsedGroupsChange).toHaveBeenCalledWith({
      [REPO_AXIS_KEY]: [COLLAPSED_REPO_KEY],
    });
  });

  it("carries the stored unknown key forward when the served population is incomplete", async () => {
    const user = userEvent.setup();
    const onCollapsedGroupsChange = vi.fn();
    renderSurface({
      collapsedGroups: { [REPO_AXIS_KEY]: [UNKNOWN_REPO_KEY] },
      hasCompletePopulation: false,
      onCollapsedGroupsChange,
    });

    await user.click(screen.getByRole("button", { name: "web" }));

    expect(onCollapsedGroupsChange).toHaveBeenCalledWith({
      [REPO_AXIS_KEY]: [UNKNOWN_REPO_KEY, COLLAPSED_REPO_KEY],
    });
  });

  it("carries the stored unknown key forward when a facet filter is narrowing the corpus", async () => {
    const user = userEvent.setup();
    const onCollapsedGroupsChange = vi.fn();
    renderSurface({
      collapsedGroups: { [REPO_AXIS_KEY]: [UNKNOWN_REPO_KEY] },
      hasActiveFilters: true,
      hasCompletePopulation: true,
      onCollapsedGroupsChange,
    });

    await user.click(screen.getByRole("button", { name: "web" }));

    expect(onCollapsedGroupsChange).toHaveBeenCalledWith({
      [REPO_AXIS_KEY]: [UNKNOWN_REPO_KEY, COLLAPSED_REPO_KEY],
    });
  });

  it("carries the stored unknown key forward when the rendered rows are only a client-paged slice of allRows", async () => {
    const user = userEvent.setup();
    const onCollapsedGroupsChange = vi.fn();
    renderSurface({
      allRows: [...ROWS, OFF_PAGE_ROW],
      collapsedGroups: { [REPO_AXIS_KEY]: [UNKNOWN_REPO_KEY] },
      hasCompletePopulation: true,
      onCollapsedGroupsChange,
    });

    await user.click(screen.getByRole("button", { name: "web" }));

    expect(onCollapsedGroupsChange).toHaveBeenCalledWith({
      [REPO_AXIS_KEY]: [UNKNOWN_REPO_KEY, COLLAPSED_REPO_KEY],
    });
  });
});

describe("with the column controls flag off", () => {
  it("renders no bands at all and never calls the collapse callback", () => {
    const onCollapsedGroupsChange = vi.fn();
    renderSurface({
      collapsedGroups: { [REPO_AXIS_KEY]: [COLLAPSED_REPO_KEY] },
      flagOn: false,
      onCollapsedGroupsChange,
    });

    expect(screen.queryByRole("button", { name: "web" })).toBeNull();
    expect(screen.queryByRole("button", { name: "api" })).toBeNull();
    for (const id of ["a", "b", "c"]) {
      expect(rowId(id)).not.toBeNull();
    }
    expect(onCollapsedGroupsChange).not.toHaveBeenCalled();
  });
});

describe("with no host-owned collapse port", () => {
  it("still collapses a band locally, the way the grid always has", async () => {
    const user = userEvent.setup();
    renderSurface({});

    await user.click(screen.getByRole("button", { name: "web" }));

    expect(
      screen.getByRole("button", { expanded: false, name: "web" })
    ).toBeInTheDocument();
    expect(rowId("a")).toBeNull();
    expect(rowId("c")).toBeNull();
    expect(rowId("b")).not.toBeNull();
  });
});

function renderSurface({
  allRows,
  collapsedGroups,
  flagOn = true,
  grouping = GROUPED_BY_REPO,
  hasActiveFilters = false,
  hasCompletePopulation = false,
  items = ROWS,
  onCollapsedGroupsChange,
}: {
  allRows?: BranchRow[];
  collapsedGroups?: TableCollapsedGroups;
  flagOn?: boolean;
  grouping?: TableGroupingState;
  hasActiveFilters?: boolean;
  hasCompletePopulation?: boolean;
  items?: BranchRow[];
  onCollapsedGroupsChange?: (next: TableCollapsedGroups) => void;
}) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: flagOn ? [BRANCHES_LIST_COLUMN_CONTROLS_FLAG_KEY] : [],
      })}
    >
      <BranchesListSurfaceV2
        allRows={allRows ?? items}
        collapsedGroups={collapsedGroups}
        {...branchesListSurfaceV2SummaryPropsFixture()}
        grouping={grouping}
        hasActiveFilters={hasActiveFilters}
        hasCompletePopulation={hasCompletePopulation}
        hasWindow={false}
        isError={false}
        isPending={false}
        isPlaceholderData={false}
        items={items}
        onCollapsedGroupsChange={onCollapsedGroupsChange}
        onPageChange={() => undefined}
        onPageSizeChange={() => undefined}
        onRetry={() => undefined}
        onShowAllTime={() => undefined}
        onSort={() => undefined}
        page={0}
        pageSize={25}
        sortBy="lastActivity"
        sortDir="desc"
        toolbar={branchesToolbarPropsFixture({
          rows: items,
          visibleColumns: VISIBLE_COLUMNS,
        })}
        total={(allRows ?? items).length}
        totalPages={1}
        visibleColumns={VISIBLE_COLUMNS}
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
