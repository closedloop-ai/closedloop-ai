import { isGridChromeRowId } from "@closedloop-ai/design-system/lib/grid-table-v2-chrome-rows";
import {
  type BranchAnalytics,
  type BranchListResponse,
  type BranchUsageSummary,
  BranchViewerScope,
  type BranchRow as WireBranchRow,
} from "@repo/api/src/types/branch";
import {
  BranchListCapability,
  BranchListFacetAvailability,
} from "@repo/api/src/types/branch-list-contract";
import { unavailableBranchTraceResult } from "@repo/api/src/types/branch-trace";
import { BRANCHES_LIST_COLUMN_CONTROLS_FLAG_KEY } from "@repo/api/src/types/branches-list-column-controls-flag";
import {
  makeBranchAnalytics,
  makeBranchListMetrics,
} from "@repo/app/branches/components/branch-analytics-fixtures";
import type {
  BranchesDataSource,
  BranchListOptions,
} from "@repo/app/branches/data-source/branches-data-source";
import {
  BRANCH_PRIORITY_COLUMN_ID,
  BRANCH_PROJECT_COLUMN_ID,
  BRANCH_TAGS_COLUMN_ID,
  branchColumnLabel,
} from "@repo/app/branches/lib/branch-column-view-model";
import { BRANCH_FILTER_PARAMS } from "@repo/app/branches/lib/branch-filter-params";
import { LIST_TOOLBAR_FILTER_LABEL } from "@repo/app/shared/components/list-toolbar-copy";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalBranchesDataSource } from "../../../shared-branches/local-branches-data-source";
import { renderView, wireRow } from "./test-helpers";

/**
 * ISS-9676 (whitlockk review) — the DESKTOP host's own flag path for the Branches
 * list's column controls.
 *
 * `packages/app/branches/components/__tests__/branches-list-column-controls.test.tsx`
 * mounts the shared surface directly. That cannot tell a host that reaches the
 * surface with real rows and real view state apart from one that never renders
 * it, so this drives `BranchesView` end to end: the key is turned on through the
 * renderer's own `FeatureFlagAdapterProvider`, and the grouping the menu picks
 * has to travel through the host's `useBranchViewState` before any band exists.
 * The web shell's mirror lives beside the `/branches` page.
 */

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
// Radix's Select scrolls its highlighted item into view on open.
Element.prototype.scrollIntoView ??= () => {};

const { beginSignInMock, openGitHubConnectMock, useDesktopAuthMock } =
  vi.hoisted(() => ({
    beginSignInMock: vi.fn(),
    openGitHubConnectMock: vi.fn(),
    useDesktopAuthMock: vi.fn(),
  }));
const { setSharedDateRangeMock } = vi.hoisted(() => ({
  setSharedDateRangeMock: vi.fn(),
}));
/** Every approved Branches column, shown — the shipped default this view resets to. */
const { DEFAULT_VISIBLE_COLUMN_IDS } = vi.hoisted(() => ({
  DEFAULT_VISIBLE_COLUMN_IDS: [
    "owner",
    "priority",
    "collaborators",
    "sessions",
    "changes",
    "status",
    "pr",
    "lastActivity",
    "repo",
    "tags",
    "project",
  ],
}));

vi.mock("@repo/app/branches/components/branches-summary-cards", () => ({
  BranchesSummaryCards: () => null,
}));
vi.mock("@repo/app/branches/hooks/use-branch-saved-views", () => ({
  // The view now restores the collection one hook earlier so the read gate can
  // see it (ISS-9447 review).
  useBranchSavedViewsStore: () => ({ isArrangementSettled: true }),
  useBranchSavedViews: () => ({
    activeViewId: null,
    isArrangementSettled: true,
    modified: false,
    onCreateView: vi.fn(),
    onDeleteView: vi.fn(),
    onRenameView: vi.fn(),
    onSelectView: vi.fn(),
    onUpdateView: vi.fn(),
    views: [],
  }),
}));
vi.mock("@repo/app/branches/data-source/branches-live-bridge", () => ({
  BranchesLiveBridge: () => null,
}));
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: useDesktopAuthMock,
}));
vi.mock("@repo/app/shared/hooks/use-shared-date-range", () => ({
  useSharedDateRange: () => ({
    dateRange: "all",
    setDateRange: setSharedDateRangeMock,
  }),
}));
// Only the HOOK is stood in for; the rest of the module is spread back because
// the v2 toolbar reads the real toggleable-column tables from it. Grouping and
// column visibility are REAL state rather than spies — the whole point of this
// suite is that a menu pick lands in the host's view state and comes back out
// as bands, which a `vi.fn()` cannot show.
vi.mock("@repo/app/branches/hooks/use-branch-view-state", async (original) => {
  const { useCallback, useState } = await import("react");
  const { EMPTY_TABLE_GROUPING } = await import(
    "@closedloop-ai/design-system/components/ui/table-toolbar-model"
  );
  const { EMPTY_TABLE_COLLAPSED_GROUPS } = await import(
    "@repo/app/shared/lib/table-collapsed-groups"
  );
  return {
    ...(await original<
      typeof import("@repo/app/branches/hooks/use-branch-view-state")
    >()),
    useBranchViewState: () => {
      const [grouping, setGrouping] = useState(EMPTY_TABLE_GROUPING);
      const [collapsedGroups, setCollapsedGroups] = useState(
        EMPTY_TABLE_COLLAPSED_GROUPS
      );
      const [visibleColumns, setVisibleColumns] = useState(
        () => new Set(DEFAULT_VISIBLE_COLUMN_IDS)
      );
      const toggleColumn = useCallback((id: string) => {
        setVisibleColumns((previous) => {
          const next = new Set(previous);
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }
          return next;
        });
      }, []);
      const resetColumns = useCallback(() => {
        setVisibleColumns(new Set(DEFAULT_VISIBLE_COLUMN_IDS));
      }, []);
      return {
        applyArrangement: vi.fn(),
        collapsedGroups,
        columnOrder: [],
        dateRange: "all",
        grouping,
        isViewReady: true,
        resetColumns,
        resetView: resetColumns,
        setCollapsedGroups,
        setColumnOrder: vi.fn(),
        setDateRange: vi.fn(),
        setGrouping,
        setSort: vi.fn(),
        sortDir: "desc",
        sortKey: "lastActivity",
        toggleColumn,
        toggleSortDir: vi.fn(),
        visibleColumns,
      };
    },
  };
});

const GRID_ROW_SELECTOR = "[data-grid-row-id]";
const PRIORITY_LABEL = branchColumnLabel(BRANCH_PRIORITY_COLUMN_ID);
const PRIORITY_HEADER_SELECTOR = `[role="columnheader"][data-column-id="${BRANCH_PRIORITY_COLUMN_ID}"]`;
const RE_PRIORITY_FACET = new RegExp(PRIORITY_LABEL, "i");
const TAGS_LABEL = branchColumnLabel(BRANCH_TAGS_COLUMN_ID);
const TAGS_HEADER_SELECTOR = `[role="columnheader"][data-column-id="${BRANCH_TAGS_COLUMN_ID}"]`;
const RE_TAGS_FACET = new RegExp(TAGS_LABEL, "i");
const PROJECT_LABEL = branchColumnLabel(BRANCH_PROJECT_COLUMN_ID);
const PROJECT_HEADER_SELECTOR = `[role="columnheader"][data-column-id="${BRANCH_PROJECT_COLUMN_ID}"]`;
const RE_REPOSITORY_FACET = /repository/i;
/** ISS-12456: the tag a saved view or a link carries into a tagless host. */
const LINKED_TAG_ID = "tag-a";
const OPTIONS_TRIGGER = { name: "Options" } as const;
const FILTER_TRIGGER = { name: LIST_TOOLBAR_FILTER_LABEL } as const;
const REPOSITORY_ENTRY = { name: "Repository" } as const;
const GROUP_TRIGGER = { name: "Group" } as const;
const PRIMARY_GROUPING_FIELD = { name: "Primary grouping field" } as const;
const AUTHOR_DIMENSION = { name: "Author" } as const;
const ONE_GROUPING_LEVEL = { name: "Groups: 1" } as const;
const RE_SORTED_BY = /^Sorted by/;
const ALEX = "Alex Rivera";
const BLAKE = "Blake Chen";
// Two owners, so an Author grouping has two bands to cut rather than one that
// holds everything and would look identical to an ungrouped table.
const ROWS: WireBranchRow[] = [
  {
    ...wireRow,
    id: "owner%2Frepo::feature-a",
    branchName: "feature/a",
    owner: ALEX,
    prNumber: 41,
    sessionIds: ["s1"],
  },
  {
    ...wireRow,
    id: "owner%2Frepo::feature-b",
    branchName: "feature/b",
    owner: BLAKE,
    prNumber: 42,
    sessionIds: ["s2"],
  },
];

const BRANCH_LIST_METRICS = makeBranchListMetrics();
const listMock =
  vi.fn<(filters: BranchListOptions) => Promise<BranchListResponse>>();
const dataSource: BranchesDataSource = {
  analytics: () => new Promise<BranchAnalytics>(() => undefined),
  cohortAnalytics: async (request) => ({
    canonicalMetrics: BRANCH_LIST_METRICS,
    matchedBranchIds: request.branchIds,
  }),
  comments: () => new Promise<never>(() => undefined),
  detail: () => new Promise<never>(() => undefined),
  list: listMock,
  pageData: async (filters) => ({
    analytics: makeBranchAnalytics(),
    list: await listMock(filters),
  }),
  scope: "http",
  supportsSplitPageData: true,
  trace: () => Promise.resolve(unavailableBranchTraceResult()),
  usage: () => new Promise<BranchUsageSummary>(() => undefined),
};

beforeEach(() => {
  vi.clearAllMocks();
  beginSignInMock.mockResolvedValue({ ok: true });
  openGitHubConnectMock.mockResolvedValue({
    ok: true,
    url: "http://localhost:3000/api/integrations/github?returnTo=%2Fbranches",
  });
  useDesktopAuthMock.mockReturnValue({
    beginSignIn: beginSignInMock,
    state: {
      organizationId: "org-1",
      status: "authenticated",
      userId: "user-1",
    },
  });
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { openGitHubConnect: openGitHubConnectMock },
  });
  listMock.mockResolvedValue(makeServerListResult(ROWS));
});

describe("BranchesView column controls", () => {
  it("bands the desktop list by author when the flag is on", async () => {
    renderView(dataSource, undefined, [BRANCHES_LIST_COLUMN_CONTROLS_FLAG_KEY]);

    await waitFor(() => expect(renderedRowCount()).toBe(ROWS.length));

    fireEvent.click(screen.getByRole("button", GROUP_TRIGGER));
    fireEvent.click(screen.getByRole("combobox", PRIMARY_GROUPING_FIELD));
    fireEvent.click(await screen.findByRole("option", AUTHOR_DIMENSION));

    await waitFor(() =>
      expect(screen.getByRole("button", ONE_GROUPING_LEVEL)).toBeTruthy()
    );
    // The band's collapse toggle, which only a rendered band emits — the owner
    // CELLS carry the same words, so a text query would pass over a flat table.
    for (const band of [ALEX, BLAKE]) {
      expect(
        screen.getByRole("button", { expanded: true, name: band })
      ).toBeTruthy();
    }
    // A band is an arrangement, never a filter.
    expect(renderedRowCount()).toBe(ROWS.length);
  });

  // ISS-10332 (#7762 review): this host opts the surface in only when its
  // source can write priority. Since PLN-2086 Milestone 3 the LOCAL source can,
  // whenever its preload carries the write — the two local cases take the
  // method from the real local source, so they pin its probe, not a hand-set key.
  it.each([
    ["a source without updatePriority", dataSource, false],
    [
      "a source with updatePriority",
      { ...dataSource, updatePriority: vi.fn() },
      true,
    ],
    [
      "the local source over a preload that carries the write",
      { ...dataSource, updatePriority: localSourceUpdatePriority(true) },
      true,
    ],
    [
      "the local source over an older preload without it",
      { ...dataSource, updatePriority: localSourceUpdatePriority(false) },
      false,
    ],
  ] as const)(
    "offers the Priority column only for %s",
    async (_label, source, offered) => {
      renderView(source, undefined, [BRANCHES_LIST_COLUMN_CONTROLS_FLAG_KEY]);

      await waitFor(() => expect(renderedRowCount()).toBe(ROWS.length));
      expect(document.querySelector(PRIORITY_HEADER_SELECTOR) !== null).toBe(
        offered
      );

      const [optionsTrigger] = screen.getAllByRole("button", OPTIONS_TRIGGER);
      openMenu(optionsTrigger!);
      await screen.findByRole("menuitem", REPOSITORY_ENTRY);
      expect(
        screen.queryByRole("menuitem", { name: PRIORITY_LABEL }) !== null
      ).toBe(offered);
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: "Escape",
      });

      openMenu(screen.getByRole("button", FILTER_TRIGGER));
      await screen.findByRole("menuitem", { name: RE_REPOSITORY_FACET });
      expect(
        screen.queryByRole("menuitem", { name: RE_PRIORITY_FACET }) !== null
      ).toBe(offered);
    }
  );

  // ISS-12456: Tags is a cloud-Artifact concept the local store's rows never
  // carry, so (unlike Priority) there is no preload probe — only the HTTP
  // source ever sets `supportsTags`. The default `visibleColumns` fixture
  // above already includes "tags" (a saved view predating this opt-in), so
  // every case here also proves that stale membership renders no empty
  // column rather than erroring.
  it.each([
    ["a source without supportsTags", dataSource, false],
    ["a source with supportsTags", { ...dataSource, supportsTags: true }, true],
  ] as const)(
    "offers the Tags column only for %s",
    async (_label, source, offered) => {
      renderView(source, undefined, [BRANCHES_LIST_COLUMN_CONTROLS_FLAG_KEY]);

      await waitFor(() => expect(renderedRowCount()).toBe(ROWS.length));
      expect(document.querySelector(TAGS_HEADER_SELECTOR) !== null).toBe(
        offered
      );

      const [optionsTrigger] = screen.getAllByRole("button", OPTIONS_TRIGGER);
      openMenu(optionsTrigger!);
      await screen.findByRole("menuitem", REPOSITORY_ENTRY);
      expect(
        screen.queryByRole("menuitem", { name: TAGS_LABEL }) !== null
      ).toBe(offered);
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: "Escape",
      });

      // ISS-12456: a Tags facet selection on a source whose rows never carry
      // a tag would match no row, same reasoning as Priority's facet.
      openMenu(screen.getByRole("button", FILTER_TRIGGER));
      await screen.findByRole("menuitem", { name: RE_REPOSITORY_FACET });
      expect(
        screen.queryByRole("menuitem", { name: RE_TAGS_FACET }) !== null
      ).toBe(offered);
    }
  );

  // ISS-12456: Project is the same cloud-Artifact-identity gap as Tags, but
  // has no sort key or filter facet (`branch-column-view-model.ts`), so only
  // the header and the Columns-picker entry are checked here.
  it.each([
    ["a source without supportsProject", dataSource, false],
    [
      "a source with supportsProject",
      { ...dataSource, supportsProject: true },
      true,
    ],
  ] as const)(
    "offers the Project column only for %s",
    async (_label, source, offered) => {
      renderView(source, undefined, [BRANCHES_LIST_COLUMN_CONTROLS_FLAG_KEY]);

      await waitFor(() => expect(renderedRowCount()).toBe(ROWS.length));
      expect(document.querySelector(PROJECT_HEADER_SELECTOR) !== null).toBe(
        offered
      );

      const [optionsTrigger] = screen.getAllByRole("button", OPTIONS_TRIGGER);
      openMenu(optionsTrigger!);
      await screen.findByRole("menuitem", REPOSITORY_ENTRY);
      expect(
        screen.queryByRole("menuitem", { name: PROJECT_LABEL }) !== null
      ).toBe(offered);
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: "Escape",
      });
    }
  );

  // Neither Tags nor Project has a preload probe (unlike `updatePriority`):
  // the local store's rows carry no cloud Artifact identity for either, so
  // the factory never sets either capability, regardless of what the
  // preload offers.
  it("never offers supportsTags or supportsProject from the local source", () => {
    const localSource = createLocalBranchesDataSource({
      branchesApi: {},
    } as Parameters<typeof createLocalBranchesDataSource>[0]);
    expect(localSource.supportsTags).toBeUndefined();
    expect(localSource.supportsProject).toBeUndefined();
  });

  // ISS-12456 (Cosimo Corrigan, 2026-10-14): "In single-user mode, rows should
  // not be filtered by tags." A saved view (FEA-4180) or a link can still
  // carry a selection into a host that offers no Tags facet, and this host's
  // `filters` are what the branch-list request sends — so the drop has to
  // reach the request, not only the client predicate.
  it.each([
    ["a source without supportsTags", dataSource, false],
    ["a source with supportsTags", { ...dataSource, supportsTags: true }, true],
  ] as const)(
    "asks the producer to filter by tag only for %s",
    async (_label, source, applied) => {
      renderView(
        source,
        undefined,
        [BRANCHES_LIST_COLUMN_CONTROLS_FLAG_KEY],
        `/branches?${BRANCH_FILTER_PARAMS.tags}=${LINKED_TAG_ID}`
      );

      await waitFor(() => expect(renderedRowCount()).toBe(ROWS.length));
      const requestedTags = listMock.mock.calls.flatMap(
        ([options]) => options.tags ?? []
      );

      expect(requestedTags.includes(LINKED_TAG_ID)).toBe(applied);
    }
  );

  it("keeps sorting but not grouping at the flag's closed default", async () => {
    renderView(dataSource);

    await waitFor(() => expect(renderedRowCount()).toBe(ROWS.length));

    expect(screen.queryByRole("button", GROUP_TRIGGER)).toBeNull();
    expect(screen.getByRole("button", { name: RE_SORTED_BY })).toBeTruthy();
    expect(
      document.body.querySelector(
        '[role="columnheader"][data-column-id="repo"] button'
      )
    ).not.toBeNull();
  });

  it("GV-OFF-BRANCHES keeps the Filter label, no toolbar Sort and header-owned sorting while gridview-adoption is off (ISS-13035)", async () => {
    renderView(
      dataSource,
      undefined,
      [],
      "/branches",
      true,
      createStaticFeatureFlagAdapter({ enabledFlags: [] })
    );

    await waitFor(() => expect(renderedRowCount()).toBe(ROWS.length));

    expect(screen.getByRole("button", { name: "Filter" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Filters" })).toBeNull();
    expect(screen.queryByRole("button", { name: RE_SORTED_BY })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Filter items" })).toBeNull();
    expect(
      document.body.querySelector(
        '[role="columnheader"][data-column-id="repo"] button'
      )
    ).not.toBeNull();
  });
});

/** Radix menu triggers open on a primary-button pointer-down, not a click. */
function openMenu(trigger: HTMLElement): void {
  fireEvent.pointerDown(trigger, {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

function renderedRowCount(): number {
  // DATA rows only. ISS-10245 made `navigableHeaderCells` unconditional, so the
  // grid's chrome header row carries `data-grid-row-id` too.
  return [...document.querySelectorAll<HTMLElement>(GRID_ROW_SELECTOR)].filter(
    (row) => !isGridChromeRowId(row.dataset.gridRowId ?? "")
  ).length;
}

function makeServerListResult(items: WireBranchRow[]): BranchListResponse {
  const emptyFacet = {
    availability: BranchListFacetAvailability.Complete,
    options: [],
  };
  return {
    facets: {
      collaborators: emptyFacet,
      lastActiveRanges: emptyFacet,
      names: emptyFacet,
      owners: emptyFacet,
      pullRequests: emptyFacet,
      repositories: emptyFacet,
      statuses: emptyFacet,
      tags: emptyFacet,
    },
    items,
    pageInfo: {
      capability: BranchListCapability.ServerPaginationV1,
      limit: 25,
      now: "2026-08-18T18:00:00.000Z",
      offset: 0,
      requestedOffset: 0,
    },
    total: items.length,
    viewerScope: BranchViewerScope.Self,
  };
}

/** The `updatePriority` the real local source offers over a minimal preload. */
function localSourceUpdatePriority(preloadCarriesWrite: boolean) {
  return createLocalBranchesDataSource({
    branchesApi: {
      ...(preloadCarriesWrite ? { updatePriority: vi.fn() } : {}),
    },
  } as Parameters<typeof createLocalBranchesDataSource>[0]).updatePriority;
}
