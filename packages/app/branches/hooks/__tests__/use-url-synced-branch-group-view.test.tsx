import {
  EMPTY_TABLE_COLLAPSED_GROUPS,
  TABLE_COLLAPSED_GROUP_PARAM,
  type TableCollapsedGroups,
} from "@repo/app/shared/lib/table-collapsed-groups";
import { TABLE_GROUP_PARAM } from "@repo/app/shared/lib/table-group-view-params";
import { DEFAULT_TABLE_PAGE_SIZE } from "@repo/design-system/components/ui/table-page-size-select";
import {
  EMPTY_TABLE_GROUPING,
  type TableGroupingState,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { AuthAdapterProvider } from "../../../shared/auth/provider";
import { createStaticAuthAdapter } from "../../../shared/auth/static-auth-adapter";
import { FeatureFlagAdapterProvider } from "../../../shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../../shared/feature-flags/static-feature-flag-adapter";
import { TABLE_PAGE_SIZE_LADDER_FEATURE_FLAG_KEY } from "../../../shared/lib/feature-flags";
import {
  branchGrouping,
  GROUPED_BY_OWNER,
  GROUPED_BY_REPO,
  requiredAxisKey,
} from "../../lib/__tests__/support/branch-grouping-fixtures";
import {
  BRANCH_FILTER_PARAMS,
  BRANCH_PAGE_PARAM,
  BRANCH_PAGE_SIZE_PARAM,
} from "../../lib/branch-filter-params";
import {
  type BranchFilters,
  type BranchRow,
  BranchRowStatus,
  DEFAULT_BRANCH_FILTERS,
} from "../../lib/branch-row";
import {
  type BranchAppliedArrangement,
  DEFAULT_BRANCH_ARRANGEMENT,
} from "../../lib/branch-saved-views";
import { BranchSortDir, BranchSortKey } from "../../lib/branch-sort-group";
import {
  useUrlSyncedBranchFilterState,
  useUrlSyncedBranchServerState,
} from "../use-branch-filter-state";
import { useBranchViewState } from "../use-branch-view-state";

/**
 * ISS-9582 — the grouping axis and band collapse a Branches list shows, as the
 * URL and the saved view negotiate it.
 *
 * `useUrlSyncedBranchServerState` is driven with a REAL `useBranchViewState` as
 * its `groupView` source, composed in one hook the way both hosts compose them,
 * so every case crosses the actual restore from `localStorage` and the actual
 * URL writer rather than a stub that answers the same regardless of input.
 */

const PERSIST_KEY = "group-view-url";
const TEST_USER_ID = "user_test";
const LIVE_VIEW_STORAGE_KEY = `branches:saved-view:${PERSIST_KEY}:approved:u:${TEST_USER_ID}`;
const BRANCHES_PATH = "/acme/branches";

const GROUPED_BY_STATUS = branchGrouping("status", TableGroupOrder.Descending);
const OWNER_AXIS = requiredAxisKey(GROUPED_BY_OWNER);
const REPO_AXIS = requiredAxisKey(GROUPED_BY_REPO);
const STATUS_AXIS = requiredAxisKey(GROUPED_BY_STATUS);

afterEach(() => {
  globalThis.history.replaceState(null, "", "/");
  localStorage.clear();
});

describe("useUrlSyncedBranchServerState grouping precedence", () => {
  it("lets a linked grouping and collapse win over the stored view", async () => {
    seedStoredView(GROUPED_BY_OWNER, {
      [OWNER_AXIS]: ["Alex"],
      [REPO_AXIS]: ["acme/api"],
    });
    const { result } = renderComposedAt(
      linkedPath([
        [TABLE_GROUP_PARAM, `repo:${TableGroupOrder.Ascending}`],
        [TABLE_COLLAPSED_GROUP_PARAM, "acme/web"],
      ])
    );

    // The stored view restored under the link, so the link is outranking a
    // real view rather than the defaults.
    await waitFor(() =>
      expect(result.current.view.grouping).toEqual(GROUPED_BY_OWNER)
    );
    expect(result.current.server.grouping).toEqual(GROUPED_BY_REPO);
    expect(result.current.server.collapsedGroups).toEqual({
      [OWNER_AXIS]: ["Alex"],
      [REPO_AXIS]: ["acme/web"],
    });
  });

  it.each([
    ["an unknown field", "nope"],
    ["an inherited object key", "constructor"],
  ])(
    "falls back to the stored view for %s in the link",
    async (_case, field) => {
      const stored = { [OWNER_AXIS]: ["Alex"] };
      seedStoredView(GROUPED_BY_OWNER, stored);
      const { result } = renderComposedAt(
        linkedPath([
          [TABLE_GROUP_PARAM, field],
          [TABLE_COLLAPSED_GROUP_PARAM, "acme/web"],
        ])
      );

      await waitFor(() =>
        expect(result.current.server.grouping).toEqual(GROUPED_BY_OWNER)
      );
      expect(result.current.server.collapsedGroups).toEqual(stored);
    }
  );

  it("opens every band on the linked axis when the link names no collapsed band", async () => {
    seedStoredView(GROUPED_BY_OWNER, {
      [OWNER_AXIS]: ["Alex"],
      [REPO_AXIS]: ["a/b"],
    });
    const { result } = renderComposedAt(
      linkedPath([[TABLE_GROUP_PARAM, "repo"]])
    );

    await waitFor(() =>
      expect(result.current.view.collapsedGroups[REPO_AXIS]).toEqual(["a/b"])
    );
    expect(result.current.server.grouping).toEqual(
      branchGrouping("repo", TableGroupOrder.Custom)
    );
    // The stored repo axis is replaced by the link's "all open"; the axis the
    // link says nothing about keeps what the reader collapsed.
    expect(result.current.server.collapsedGroups).toEqual({
      [OWNER_AXIS]: ["Alex"],
    });
  });
});

describe("useUrlSyncedBranchServerState grouping URL writes", () => {
  it("writes a grouping restored after mount into the next page write", async () => {
    seedStoredView(GROUPED_BY_OWNER, { [OWNER_AXIS]: ["Alex", "Sam"] });
    const navigation = createMemoryNavigation({ initialPath: BRANCHES_PATH });
    const seenGroupings: TableGroupingState[] = [];
    const { result } = renderHook(
      () => {
        const composed = useComposedGroupView();
        seenGroupings.push(composed.server.grouping);
        return composed;
      },
      { wrapper: providers(navigation.adapter) }
    );

    await waitFor(() =>
      expect(result.current.server.grouping).toEqual(GROUPED_BY_OWNER)
    );
    // Restored AFTER mount: the first render still held the defaults.
    expect(seenGroupings[0]).toEqual(EMPTY_TABLE_GROUPING);

    act(() => result.current.server.setPage(1));

    const params = currentParams(navigation.getCurrentHref());
    expect(params.get(BRANCH_PAGE_PARAM)).toBe("2");
    expect(params.getAll(TABLE_GROUP_PARAM)).toEqual(["owner:asc"]);
    expect(params.getAll(TABLE_COLLAPSED_GROUP_PARAM)).toEqual(["Alex", "Sam"]);
  });

  it("persists a band change to the saved view and the URL, and drops the link's statement", async () => {
    seedStoredView(GROUPED_BY_OWNER, { [OWNER_AXIS]: ["Alex"] });
    const path = linkedPath([
      [TABLE_GROUP_PARAM, `repo:${TableGroupOrder.Ascending}`],
      [TABLE_COLLAPSED_GROUP_PARAM, "acme/web"],
    ]);
    const navigation = createMemoryNavigation({ initialPath: path });
    globalThis.history.replaceState(null, "", path);
    const { result } = renderHook(() => useComposedGroupView(), {
      wrapper: providers(navigation.adapter),
    });
    await waitFor(() =>
      expect(result.current.view.grouping).toEqual(GROUPED_BY_OWNER)
    );
    const next: TableCollapsedGroups = {
      [OWNER_AXIS]: ["Alex"],
      [REPO_AXIS]: ["acme/web", "acme/api"],
    };

    // The gesture as the page composes it: commit, then one replace from the
    // controls that own the facets.
    act(() => {
      result.current.server.commitCollapsedGroups(next);
      result.current.server.replaceViewParams();
    });

    const params = currentParams(navigation.getCurrentHref());
    expect(params.getAll(TABLE_GROUP_PARAM)).toEqual(["repo:asc"]);
    expect(params.getAll(TABLE_COLLAPSED_GROUP_PARAM)).toEqual([
      "acme/web",
      "acme/api",
    ]);
    // The gesture writes the whole view the reader is looking at — the linked
    // grouping included — to the saved view.
    await waitFor(() => {
      const persisted = JSON.parse(
        localStorage.getItem(LIVE_VIEW_STORAGE_KEY) ?? "{}"
      );
      expect(persisted.collapsedGroups).toEqual(next);
      expect(persisted.grouping).toEqual(GROUPED_BY_REPO);
    });

    // The link no longer outranks the saved view, so a later change to it shows.
    act(() => result.current.view.setGrouping(GROUPED_BY_STATUS));
    expect(result.current.server.grouping).toEqual(GROUPED_BY_STATUS);
  });

  it("keeps a just-applied owner facet when a band changes on a stale search snapshot", async () => {
    seedStoredView(GROUPED_BY_OWNER, EMPTY_TABLE_COLLAPSED_GROUPS);
    const navigation = createStaleSearchSnapshotNavigation(BRANCHES_PATH);
    const { result } = renderHook(() => useComposedGroupView(), {
      wrapper: providers(navigation.adapter),
    });
    await waitFor(() =>
      expect(result.current.server.grouping).toEqual(GROUPED_BY_OWNER)
    );

    act(() => result.current.server.handleFiltersChange(ownerFilter("Alex")));
    act(() => {
      result.current.server.commitCollapsedGroups({ [OWNER_AXIS]: ["Sam"] });
      result.current.server.replaceViewParams();
    });

    const params = currentParams(navigation.getCurrentHref());
    expect(params.getAll(BRANCH_FILTER_PARAMS.owners)).toEqual(["Alex"]);
    expect(params.getAll(TABLE_COLLAPSED_GROUP_PARAM)).toEqual(["Sam"]);
  });

  it("carries an applied arrangement's grouping into the filter apply that follows it", async () => {
    seedStoredView(GROUPED_BY_OWNER, { [OWNER_AXIS]: ["Alex"] });
    const path = linkedPath([
      [TABLE_GROUP_PARAM, `repo:${TableGroupOrder.Ascending}`],
      [TABLE_COLLAPSED_GROUP_PARAM, "acme/web"],
    ]);
    const navigation = createMemoryNavigation({ initialPath: path });
    globalThis.history.replaceState(null, "", path);
    const { result } = renderHook(() => useComposedGroupView(), {
      wrapper: providers(navigation.adapter),
    });
    await waitFor(() =>
      expect(result.current.view.grouping).toEqual(GROUPED_BY_OWNER)
    );
    const arrangement: BranchAppliedArrangement = {
      ...DEFAULT_BRANCH_ARRANGEMENT,
      collapsedGroups: { [STATUS_AXIS]: [BranchRowStatus.Merged] },
      grouping: GROUPED_BY_STATUS,
      sortDir: BranchSortDir.Asc,
      sortKey: BranchSortKey.Name,
    };

    // One act, no render between, which is how `useBranchSavedViews` calls them.
    act(() => {
      result.current.server.applyArrangement(arrangement);
      result.current.server.handleFiltersChange(
        DEFAULT_BRANCH_FILTERS,
        arrangement.pageSize
      );
    });

    const applied = currentParams(navigation.getCurrentHref());
    expect(applied.getAll(TABLE_GROUP_PARAM)).toEqual(["status:desc"]);
    expect(applied.getAll(TABLE_COLLAPSED_GROUP_PARAM)).toEqual([
      BranchRowStatus.Merged,
    ]);
    // The link's statement is gone: the stored view now decides what shows.
    expect(result.current.server.grouping).toEqual(GROUPED_BY_STATUS);
    act(() => result.current.view.setGrouping(GROUPED_BY_OWNER));
    expect(result.current.server.grouping).toEqual(GROUPED_BY_OWNER);

    act(() => {
      result.current.server.applyArrangement(DEFAULT_BRANCH_ARRANGEMENT);
      result.current.server.handleFiltersChange(
        DEFAULT_BRANCH_FILTERS,
        DEFAULT_TABLE_PAGE_SIZE
      );
    });

    const ungrouped = currentParams(navigation.getCurrentHref());
    expect(ungrouped.has(TABLE_GROUP_PARAM)).toBe(false);
    expect(ungrouped.has(TABLE_COLLAPSED_GROUP_PARAM)).toBe(false);
  });

  it("re-asserts the grouping params on the legacy filter hook's write", async () => {
    seedStoredView(GROUPED_BY_OWNER, { [OWNER_AXIS]: ["Sam"] });
    const navigation = createMemoryNavigation({ initialPath: BRANCHES_PATH });
    const { result } = renderHook(() => useComposedWithLegacy(), {
      wrapper: providers(navigation.adapter),
    });
    await waitFor(() =>
      expect(result.current.server.grouping).toEqual(GROUPED_BY_OWNER)
    );

    act(() => result.current.legacy.handleFiltersChange(ownerFilter("Alex")));

    const params = currentParams(navigation.getCurrentHref());
    expect(params.getAll(BRANCH_FILTER_PARAMS.owners)).toEqual(["Alex"]);
    expect(params.getAll(TABLE_GROUP_PARAM)).toEqual(["owner:asc"]);
    expect(params.getAll(TABLE_COLLAPSED_GROUP_PARAM)).toEqual(["Sam"]);
  });

  it("keeps the legacy hook's facet when a band change is written through its writer", async () => {
    seedStoredView(GROUPED_BY_OWNER, EMPTY_TABLE_COLLAPSED_GROUPS);
    // A snapshot that never sees a write, so only filters re-asserted from the
    // legacy hook's own state can keep the owner in the URL.
    const navigation = createStaleSearchSnapshotNavigation(BRANCHES_PATH);
    const { result } = renderHook(() => useComposedWithLegacy(), {
      wrapper: providers(navigation.adapter),
    });
    await waitFor(() =>
      expect(result.current.server.grouping).toEqual(GROUPED_BY_OWNER)
    );

    act(() => result.current.legacy.handleFiltersChange(ownerFilter("Alex")));
    act(() => {
      result.current.server.commitCollapsedGroups({ [OWNER_AXIS]: ["Sam"] });
      result.current.legacy.replaceViewParams();
    });

    const params = currentParams(navigation.getCurrentHref());
    expect(params.getAll(BRANCH_FILTER_PARAMS.owners)).toEqual(["Alex"]);
    expect(params.getAll(TABLE_GROUP_PARAM)).toEqual(["owner:asc"]);
    expect(params.getAll(TABLE_COLLAPSED_GROUP_PARAM)).toEqual(["Sam"]);
  });

  it("keeps the rows-per-page when a band change is written through the legacy writer", async () => {
    seedStoredView(GROUPED_BY_OWNER, EMPTY_TABLE_COLLAPSED_GROUPS);
    const navigation = createStaleSearchSnapshotNavigation(BRANCHES_PATH);
    const { result } = renderHook(() => useComposedWithLegacy(), {
      wrapper: providers(navigation.adapter),
    });
    await waitFor(() =>
      expect(result.current.server.grouping).toEqual(GROUPED_BY_OWNER)
    );

    act(() => result.current.server.setPageSize(50));
    act(() => {
      result.current.server.commitCollapsedGroups({ [OWNER_AXIS]: ["Sam"] });
      result.current.legacy.replaceViewParams();
    });

    const params = currentParams(navigation.getCurrentHref());
    expect(params.getAll(BRANCH_PAGE_SIZE_PARAM)).toEqual(["50"]);
    expect(params.getAll(TABLE_COLLAPSED_GROUP_PARAM)).toEqual(["Sam"]);
  });
});

const ROWS: BranchRow[] = [
  {
    id: "a",
    branchName: "agent/a",
    baseBranch: "main",
    repo: "acme/web",
    owner: "Alex",
    status: BranchRowStatus.Open,
    prNumber: null,
    prTitle: null,
    prUrl: null,
    prState: null,
    checksPassed: null,
    checksTotal: null,
    checksStatus: null,
    behind: 0,
    ahead: 1,
    additions: 1,
    deletions: 0,
    sessionCount: 0,
    commentCount: null,
    lastActivityLabel: "1h ago",
  },
];

function useComposedGroupView() {
  const view = useBranchViewState(PERSIST_KEY, true);
  const server = useUrlSyncedBranchServerState({
    groupView: view,
    isRestored: view.isViewReady,
  });
  return { server, view };
}

function useComposedWithLegacy() {
  const composed = useComposedGroupView();
  const legacy = useUrlSyncedBranchFilterState(
    ROWS,
    25,
    true,
    undefined,
    composed.server.writeViewParams
  );
  return { ...composed, legacy };
}

function renderComposedAt(path: string) {
  globalThis.history.replaceState(null, "", path);
  return renderHook(() => useComposedGroupView(), {
    wrapper: providers(createMemoryNavigation({ initialPath: path }).adapter),
  });
}

function seedStoredView(
  storedGrouping: TableGroupingState,
  collapsedGroups: TableCollapsedGroups
) {
  localStorage.setItem(
    LIVE_VIEW_STORAGE_KEY,
    JSON.stringify({
      collapsedGroups,
      columnOrder: [],
      columnWidths: {},
      dateRange: "30d",
      grouping: storedGrouping,
      hiddenColumns: [],
      sortDir: BranchSortDir.Desc,
      sortKey: BranchSortKey.LastActivity,
    })
  );
}

function linkedPath(entries: [string, string][]): string {
  return `${BRANCHES_PATH}?${new URLSearchParams(entries).toString()}`;
}

function currentParams(href: string): URLSearchParams {
  return new URL(href, "https://closedloop.local").searchParams;
}

function ownerFilter(owner: string): BranchFilters {
  return { ...DEFAULT_BRANCH_FILTERS, owners: [owner] };
}

function createStaleSearchSnapshotNavigation(initialPath: string) {
  const navigation = createMemoryNavigation({ initialPath });
  const staleParams = new URL(initialPath, "https://closedloop.local")
    .searchParams;
  return {
    ...navigation,
    adapter: {
      ...navigation.adapter,
      useSearchParamsSnapshot: () => staleParams,
    },
  };
}

function providers(
  adapter: ReturnType<typeof createMemoryNavigation>["adapter"]
) {
  return function Providers({ children }: { children: ReactNode }) {
    return (
      <AuthAdapterProvider
        adapter={createStaticAuthAdapter({
          orgId: "org_test",
          userId: TEST_USER_ID,
        })}
      >
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({
            enabledFlags: [TABLE_PAGE_SIZE_LADDER_FEATURE_FLAG_KEY],
          })}
        >
          <NavigationProvider adapter={adapter}>{children}</NavigationProvider>
        </FeatureFlagAdapterProvider>
      </AuthAdapterProvider>
    );
  };
}
