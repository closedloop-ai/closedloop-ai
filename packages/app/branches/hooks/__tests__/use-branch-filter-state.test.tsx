import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
  TABLE_PAGE_SIZE_LADDER_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test } from "vitest";
import {
  BRANCH_FILTER_PARAMS,
  BRANCH_PAGE_SIZE,
} from "../../lib/branch-filter-params";
import {
  type BranchFilters,
  BranchLastActiveRange,
  type BranchRow,
  BranchRowStatus,
  DEFAULT_BRANCH_FILTERS,
} from "../../lib/branch-row";
import {
  BRANCH_GRID_TABLE_V2_PAGE_SIZE,
  useBranchFilterState,
  useUrlSyncedBranchFilterState,
  useUrlSyncedBranchServerState,
} from "../use-branch-filter-state";

/**
 * Behavior coverage for the shared filter+pagination hook consumed by both the
 * web `/branches` page and the desktop Branches view (PRD-454). Guards the
 * page-reset-on-filter-change invariant the two surfaces would otherwise each
 * have to re-implement.
 */
function makeRow(
  id: string,
  owner: string,
  status: BranchRowStatus
): BranchRow {
  return {
    id,
    branchName: `agent/${id}`,
    baseBranch: "main",
    repo: `acme/${id}`,
    owner,
    status,
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
  };
}

const ROWS: BranchRow[] = [
  makeRow("a", "Alex", BranchRowStatus.Open),
  makeRow("b", "Alex", BranchRowStatus.Open),
  makeRow("c", "Sam", BranchRowStatus.Merged),
  makeRow("d", "Sam", BranchRowStatus.Open),
  makeRow("e", "Jordan", BranchRowStatus.Open),
  makeRow("f", "Jordan", BranchRowStatus.Open),
];

const ownerFilter = (owner: string): BranchFilters => ({
  ...DEFAULT_BRANCH_FILTERS,
  statuses: [],
  owners: [owner],
  repos: [],
  sessionPresence: [],
});

describe("useBranchFilterState", () => {
  // ISS-10301: this pinned the retired `APPROVED_BRANCH_PAGE_SIZE` (20), the v1
  // shell's fixed size. The CONTRACT is unchanged — the hook pages at the size it
  // is handed — so it is retargeted at the live operand rather than deleted, with
  // the row count raised past it so a page boundary is still crossed.
  test("pages at the size it is handed", () => {
    const rows = Array.from({ length: BRANCH_PAGE_SIZE + 1 }, (_, index) =>
      makeRow(`row-${index}`, "Alex", BranchRowStatus.Open)
    );
    const { result } = renderHook(() =>
      useBranchFilterState(rows, BRANCH_PAGE_SIZE, DEFAULT_BRANCH_FILTERS, true)
    );

    expect(result.current.pagedRows).toHaveLength(BRANCH_PAGE_SIZE);
    expect(result.current.totalPages).toBe(2);
  });

  test("uses the caller's captured clock for Last-active membership", () => {
    const now = Date.parse("2026-08-18T12:00:00.000Z");
    const recent = {
      ...makeRow("recent", "Alex", BranchRowStatus.Open),
      lastActivityAt: "2026-08-18T11:30:00.000Z",
    };
    const future = {
      ...makeRow("future", "Alex", BranchRowStatus.Open),
      lastActivityAt: "2026-08-18T12:30:00.000Z",
    };
    const { result } = renderHook(() =>
      useBranchFilterState(
        [future, recent],
        20,
        {
          ...DEFAULT_BRANCH_FILTERS,
          lastActiveRanges: [BranchLastActiveRange.WithinLastHour],
        },
        true,
        now
      )
    );

    expect(result.current.filteredRows.map((item) => item.id)).toEqual([
      "recent",
    ]);
  });

  test("paginates the rows by the given page size and reports the visible range", () => {
    const { result } = renderHook(() => useBranchFilterState(ROWS, 4));

    expect(result.current.total).toBe(6);
    expect(result.current.totalPages).toBe(2);
    expect(result.current.pagedRows.map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(result.current.from).toBe(1);
    expect(result.current.to).toBe(4);
  });

  test("advances to the next page and slices the tail", () => {
    const { result } = renderHook(() => useBranchFilterState(ROWS, 4));

    act(() => {
      result.current.setPage(1);
    });

    expect(result.current.pagedRows.map((r) => r.id)).toEqual(["e", "f"]);
    expect(result.current.from).toBe(5);
    expect(result.current.to).toBe(6);
  });

  test("filtering narrows the rows and recomputes totals", () => {
    const { result } = renderHook(() => useBranchFilterState(ROWS, 4));

    act(() => {
      result.current.handleFiltersChange(ownerFilter("Alex"));
    });

    expect(result.current.total).toBe(2);
    expect(result.current.totalPages).toBe(1);
    expect(result.current.pagedRows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("changing filters resets back to the first page", () => {
    const { result } = renderHook(() => useBranchFilterState(ROWS, 4));

    act(() => {
      result.current.setPage(1);
    });
    expect(result.current.page).toBe(1);

    act(() => {
      result.current.handleFiltersChange(ownerFilter("Jordan"));
    });

    expect(result.current.page).toBe(0);
    expect(result.current.pagedRows.map((r) => r.id)).toEqual(["e", "f"]);
  });

  test("clamps the page when the row set shrinks beneath the current page without a filter change", () => {
    const { result, rerender } = renderHook(
      ({ rows }) => useBranchFilterState(rows, 4),
      { initialProps: { rows: ROWS } }
    );

    act(() => {
      result.current.setPage(1);
    });
    expect(result.current.page).toBe(1);
    expect(result.current.pagedRows.map((r) => r.id)).toEqual(["e", "f"]);

    // A live data push / refetch drops rows down to a single page. The viewer
    // must fall back to a page that still has rows rather than an empty table.
    rerender({ rows: ROWS.slice(0, 2) });

    expect(result.current.totalPages).toBe(1);
    expect(result.current.page).toBe(0);
    expect(result.current.pagedRows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(result.current.from).toBe(1);
    expect(result.current.to).toBe(2);
  });

  test("does not resurrect a stale page index after the corpus shrinks then regrows", () => {
    const { result, rerender } = renderHook(
      ({ rows }) => useBranchFilterState(rows, 4),
      { initialProps: { rows: ROWS } }
    );

    // Viewer navigates to page 1 (rows e, f).
    act(() => {
      result.current.setPage(1);
    });
    expect(result.current.page).toBe(1);

    // A push shrinks the corpus to a single page — the clamp must persist to
    // page 0, not just be derived for this render.
    rerender({ rows: ROWS.slice(0, 2) });
    expect(result.current.page).toBe(0);

    // A later push regrows the corpus. The viewer stays on the page they were
    // shown (0) instead of jumping back to the stale page-1 index.
    rerender({ rows: ROWS });
    expect(result.current.page).toBe(0);
    expect(result.current.pagedRows.map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  // Regression for the reported web bug: on a LATER page, applying a facet filter
  // whose result set is smaller than the current page offset must reset to a
  // populated FIRST page — never strand the viewer on a blank, out-of-range page,
  // and never merely clamp them onto the filtered set's last page. Exercises the
  // branches consumer end to end (real BranchRow + BranchFilters). The filtered
  // set is deliberately multi-page so a reset (page 0) is distinguishable from a
  // clamp (last valid page).
  test("filtering below the current page resets to page 0 of the filtered rows (not blank, not clamped)", () => {
    // 14 rows: 8 owned by "Alex" (multi-page under pageSize 2). Full set = 7
    // pages, Alex-filtered = 4 pages. Start on page 6 (index) — beyond both.
    const many: BranchRow[] = [
      ...Array.from({ length: 8 }, (_, i) =>
        makeRow(`x${i}`, "Alex", BranchRowStatus.Open)
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        makeRow(`y${i}`, "Sam", BranchRowStatus.Open)
      ),
    ];

    const { result } = renderHook(() => useBranchFilterState(many, 2));

    act(() => {
      result.current.setPage(6);
    });
    expect(result.current.page).toBe(6);

    // Filter to Alex — 8 rows → 4 pages (indices 0-3). Page 6 is out of range.
    act(() => {
      result.current.handleFiltersChange(ownerFilter("Alex"));
    });

    expect(result.current.totalPages).toBe(4);
    // Reset lands on page 0 (first filtered slice), NOT clamped to page 3.
    expect(result.current.page).toBe(0);
    expect(result.current.pagedRows.map((r) => r.id)).toEqual(["x0", "x1"]);
    expect(result.current.pagedRows.length).toBeGreaterThan(0);
    expect(result.current.from).toBe(1);
    expect(result.current.to).toBe(2);
  });

  test("keeps at least one page and a zeroed range when nothing matches", () => {
    const { result } = renderHook(() => useBranchFilterState(ROWS, 4));

    act(() => {
      result.current.handleFiltersChange(ownerFilter("Nobody"));
    });

    expect(result.current.total).toBe(0);
    expect(result.current.totalPages).toBe(1);
    expect(result.current.pagedRows).toEqual([]);
    expect(result.current.from).toBe(0);
    expect(result.current.to).toBe(0);
  });
});

/**
 * ISS-8187, at the production seam rather than the codec: the hook the web
 * `/branches` page and the desktop Branches view both mount is what decides
 * whether a filter selected on ANOTHER list becomes an active Branches filter.
 */
describe("useUrlSyncedBranchFilterState cross-surface seeding", () => {
  afterEach(() => {
    globalThis.history.replaceState(null, "", "/");
  });

  test("does not adopt the Sessions owner filter after navigating to Branches", () => {
    // The address bar still carries Sessions' selection while the App Router
    // transition renders Branches. `owner` names both facets over different
    // identity vocabularies, so adopting it left Branches filtered by a value
    // no branch can carry — one active filter, zero rows.
    globalThis.history.replaceState(
      null,
      "",
      `/acme/sessions?owner=${SESSIONS_OWNER_USER_ID}`
    );

    const { result } = renderBranchesAt("/acme/branches");

    expect(result.current.filters).toEqual(DEFAULT_BRANCH_FILTERS);
    expect(result.current.total).toBe(ROWS.length);
  });

  test("still restores the Branches owner filter from a Branches deep link", () => {
    // The capability the guard must not cost: the same empty App Router
    // snapshot on Branches' OWN url is the reload/deep-link gap the browser-URL
    // fallback exists for.
    globalThis.history.replaceState(null, "", "/acme/branches?owner=Alex");

    const { result } = renderBranchesAt("/acme/branches");

    expect(result.current.filters.owners).toEqual(["Alex"]);
    expect(result.current.pagedRows.map((row) => row.id)).toEqual(["a", "b"]);
  });
});

/** A bare ClosedLoop user id — the value space the Sessions owner facet emits. */
const SESSIONS_OWNER_USER_ID = "019c24ff-4a67-74ae-bd2a-6f990ee13cca";

function renderBranchesAt(path: string) {
  return renderHook(() => useUrlSyncedBranchFilterState(ROWS), {
    wrapper: ({ children }) => (
      <NavigationProvider
        adapter={createMemoryNavigation({ initialPath: path }).adapter}
      >
        {children}
      </NavigationProvider>
    ),
  });
}

/**
 * The desktop half of the same contract. `BranchesView` mounts these hooks
 * through the routerless href store (`createHrefStore`, shared by the desktop
 * renderer adapter and this memory adapter), where the web App Router's
 * reconciling-snapshot gap does not exist. Desktop must therefore be clean for
 * a SECOND reason, and this asserts it rather than assuming it: the store is
 * driven through a real Sessions→Branches navigation before the view mounts,
 * with the address bar ALSO left on Sessions, so both leak vectors are armed at
 * once.
 */
describe("useUrlSyncedBranchFilterState on the routerless desktop store", () => {
  afterEach(() => {
    globalThis.history.replaceState(null, "", "/");
  });

  test("mounts clean after navigating from a filtered Sessions view", () => {
    globalThis.history.replaceState(
      null,
      "",
      `/acme/sessions?owner=${SESSIONS_OWNER_USER_ID}`
    );
    const navigation = createMemoryNavigation({
      initialPath: `/acme/sessions?owner=${SESSIONS_OWNER_USER_ID}`,
    });
    navigation.navigate("/acme/branches");

    const { result } = renderHook(() => useUrlSyncedBranchFilterState(ROWS), {
      wrapper: ({ children }) => (
        <NavigationProvider adapter={navigation.adapter}>
          {children}
        </NavigationProvider>
      ),
    });

    expect(result.current.filters).toEqual(DEFAULT_BRANCH_FILTERS);
    expect(result.current.total).toBe(ROWS.length);
  });
});

/**
 * The same contract at the hook the PRODUCTION query is built from (whitlockk
 * review). `useUrlSyncedBranchFilterState` above pages client-side; the web
 * `/branches` page and desktop `BranchesView` each ALSO mount
 * {@link useUrlSyncedBranchServerState}, and its `filters` and `page` are what
 * the producer-paged branch-list request actually sends. Two reasons the
 * sibling's coverage does not carry over: it seeds in APPROVED mode, where
 * `normalizeBranchFiltersForMode` keeps owner values the legacy mode drops, and
 * it reads a param the sibling never touches — `page`, a name Sessions spells
 * the same way (`SESSIONS_PAGE_PARAM` / `BRANCH_PAGE_PARAM`).
 */
describe("useUrlSyncedBranchServerState cross-surface seeding", () => {
  afterEach(() => {
    globalThis.history.replaceState(null, "", "/");
  });

  test("seeds neither owners nor the page index from a Sessions URL", () => {
    globalThis.history.replaceState(
      null,
      "",
      `/acme/sessions?owner=${SESSIONS_OWNER_USER_ID}&page=5`
    );

    const { result } = renderBranchServerStateAt("/acme/branches");

    // `page` first, deliberately: it is the half no sibling test reaches, and
    // asserting it after `filters` would leave it unexecuted whenever the owner
    // leak fails the render — a page-only regression could then land green.
    expect(result.current.page).toBe(0);
    expect(result.current.filters).toEqual(DEFAULT_BRANCH_FILTERS);
  });

  test("still restores owners and the page index from a Branches deep link", () => {
    globalThis.history.replaceState(
      null,
      "",
      "/acme/branches?owner=Alex&page=5"
    );

    const { result } = renderBranchServerStateAt("/acme/branches");

    expect(result.current.filters.owners).toEqual(["Alex"]);
    expect(result.current.page).toBe(4);
  });

  test("restores only Grid Table v2 page sizes from a Branches deep link", () => {
    globalThis.history.replaceState(null, "", "/acme/branches?pageSize=100");
    const valid = renderBranchServerStateAt("/acme/branches");

    expect(valid.result.current.pageSize).toBe(100);
    valid.unmount();

    globalThis.history.replaceState(null, "", "/acme/branches?pageSize=20");
    const invalid = renderBranchServerStateAt("/acme/branches");

    expect(invalid.result.current.pageSize).toBe(
      BRANCH_GRID_TABLE_V2_PAGE_SIZE
    );
  });

  test("persists v2 page-size changes and resets to the first page", () => {
    const navigation = createMemoryNavigation({
      initialPath: "/acme/branches?page=4",
    });
    const { result } = renderHook(() => useUrlSyncedBranchServerState(), {
      wrapper: navigationWrapper(navigation.adapter),
    });

    expect(result.current.page).toBe(3);

    act(() => {
      result.current.setPageSize(100);
    });

    expect(result.current.page).toBe(0);
    expect(result.current.pageSize).toBe(100);
    expect(navigation.getCurrentHref()).toBe("/acme/branches?pageSize=100");
  });

  test("keeps v2 page size on page and filter writes from a stale web search snapshot", () => {
    const navigation = createStaleSearchSnapshotNavigation("/acme/branches");
    const { result } = renderHook(() => useUrlSyncedBranchServerState(), {
      wrapper: navigationWrapper(navigation.adapter),
    });

    act(() => {
      result.current.setPageSize(100);
    });
    expect(navigation.getCurrentHref()).toBe("/acme/branches?pageSize=100");

    act(() => {
      result.current.setPage(1);
    });
    expect(navigation.getCurrentHref()).toBe(
      "/acme/branches?page=2&pageSize=100"
    );

    act(() => {
      result.current.handleFiltersChange(ownerFilter("Alex"));
    });
    expect(navigation.getCurrentHref()).toBe(
      "/acme/branches?owner=Alex&pageSize=100"
    );
  });

  test("mounts clean on the routerless desktop store after a filtered Sessions view", () => {
    globalThis.history.replaceState(
      null,
      "",
      `/acme/sessions?owner=${SESSIONS_OWNER_USER_ID}&page=5`
    );
    const navigation = createMemoryNavigation({
      initialPath: `/acme/sessions?owner=${SESSIONS_OWNER_USER_ID}&page=5`,
    });
    navigation.navigate("/acme/branches");

    const { result } = renderHook(() => useUrlSyncedBranchServerState(), {
      wrapper: navigationWrapper(navigation.adapter),
    });

    expect(result.current.page).toBe(0);
    expect(result.current.filters).toEqual(DEFAULT_BRANCH_FILTERS);
  });
});

/**
 * ISS-9692 — the saved rows-per-page reaches the REQUEST, on the first read.
 *
 * Two defects lived here, and neither was visible to a test that only checked
 * the hook's final state.
 *
 * The ORDER (whitlockk review): the host opens its branch-list query on the same
 * `isViewReady` this hook is handed as `isRestored`. Adoption ran in an effect,
 * so the render that opened the query still reported the default and the saved
 * 500 arrived one render later — a 25-row page, then a 500-row page, on the one
 * visit "remember my selection" exists for. The sequence is asserted, not the
 * settled value, because the settled value was already correct.
 *
 * The ACCEPTANCE: `BRANCH_GRID_TABLE_V2_PAGE_SIZE_OPTIONS` was the base ladder,
 * so `normalizeBranchPageSize` returned the CURRENT size for a 250 or a 500 and
 * both the adoption and the reader's own selection were silent no-ops on this
 * surface. The footer offered a rung the surface then refused.
 */
describe("useUrlSyncedBranchServerState saved page size", () => {
  afterEach(() => {
    globalThis.history.replaceState(null, "", "/");
  });

  function renderAdoption(persistedPageSize: number, path = "/acme/branches") {
    const seen: number[] = [];
    const wrapper = ladderNavigationWrapper(
      createMemoryNavigation({ initialPath: path }).adapter,
      true
    );
    const rendered = renderHook(
      ({ isRestored }: { isRestored: boolean }) => {
        const state = useUrlSyncedBranchServerState({
          isRestored,
          persistedPageSize,
        });
        seen.push(state.pageSize);
        return state;
      },
      { initialProps: { isRestored: false }, wrapper }
    );
    return { ...rendered, seen };
  }

  test("carries the saved page size on the very first restored render", () => {
    const { rerender, seen, result } = renderAdoption(500);

    // Everything before the saved view lands is the host's problem, not this
    // one's — the query is gated shut over that window. Clear it so the
    // assertion below is about the restored renders alone.
    seen.length = 0;
    rerender({ isRestored: true });

    expect(seen[0]).toBe(500);
    expect(seen).not.toContain(BRANCH_GRID_TABLE_V2_PAGE_SIZE);
    expect(result.current.pageSize).toBe(500);
  });

  test("lets an explicit ?pageSize= outrank the saved view", () => {
    globalThis.history.replaceState(null, "", "/acme/branches?pageSize=50");
    const { rerender, result } = renderAdoption(
      500,
      "/acme/branches?pageSize=50"
    );

    rerender({ isRestored: true });

    // A shared link has to page the way it says it does, whoever opens it.
    expect(result.current.pageSize).toBe(50);
  });

  test("never reverts a choice the reader made after the view restored", () => {
    const { rerender, result } = renderAdoption(500);

    rerender({ isRestored: true });
    act(() => {
      result.current.setPageSize(50);
    });
    rerender({ isRestored: true });

    expect(result.current.pageSize).toBe(50);
  });

  test("lets an applied saved view restate the size the link stated", () => {
    // ISS-9447 M5. Selecting a named view is a choice the reader makes NOW, so
    // it replaces the one the opening link made — the rule every other axis of
    // an applied view already follows. Before this, the applied size reached the
    // saved view and the switcher's modified-marker but never the table.
    const path = "/acme/branches?pageSize=50";
    globalThis.history.replaceState(null, "", path);
    const navigation = createMemoryNavigation({ initialPath: path });
    const { rerender, result } = renderHook(
      ({ isRestored }: { isRestored: boolean }) =>
        useUrlSyncedBranchServerState({ isRestored, persistedPageSize: 25 }),
      {
        initialProps: { isRestored: false },
        wrapper: ladderNavigationWrapper(navigation.adapter, true),
      }
    );

    rerender({ isRestored: true });
    expect(result.current.pageSize).toBe(50);

    act(() => {
      result.current.handleFiltersChange(DEFAULT_BRANCH_FILTERS, 100);
    });

    expect(result.current.pageSize).toBe(100);
    // And durably: a reload re-seeds the statement from `?pageSize=`, so leaving
    // the superseded 50 in the URL would revert the switch on the next visit.
    expect(navigation.getCurrentHref()).toContain("pageSize=100");
  });

  test("leaves the stated size alone on a plain facet change", () => {
    // The other half of the same branch: only an APPLIED view carries a size,
    // and a facet change must not quietly restate one.
    const path = "/acme/branches?pageSize=50";
    globalThis.history.replaceState(null, "", path);
    const navigation = createMemoryNavigation({ initialPath: path });
    const { result } = renderHook(
      () => useUrlSyncedBranchServerState({ isRestored: true }),
      { wrapper: ladderNavigationWrapper(navigation.adapter, true) }
    );

    act(() => {
      result.current.handleFiltersChange({
        ...DEFAULT_BRANCH_FILTERS,
        statuses: [BranchRowStatus.Open],
      });
    });

    expect(result.current.pageSize).toBe(50);
    expect(navigation.getCurrentHref()).toContain("pageSize=50");
  });

  test("applies a large rung the reader selects", () => {
    // The no-op the acceptance set caused: with the base ladder here,
    // `setPageSize(250)` returned the current size and the select snapped back.
    const { result } = renderAdoption(BRANCH_GRID_TABLE_V2_PAGE_SIZE);

    act(() => {
      result.current.setPageSize(250);
    });

    expect(result.current.pageSize).toBe(250);
  });

  test("restores a large rung from a deep link, and degrades it once the gate closes", () => {
    const path = "/acme/branches?pageSize=500";
    globalThis.history.replaceState(null, "", path);
    const open = renderHook(() => useUrlSyncedBranchServerState(), {
      wrapper: ladderNavigationWrapper(
        createMemoryNavigation({ initialPath: path }).adapter,
        true
      ),
    });

    expect(open.result.current.pageSize).toBe(500);
    open.unmount();

    // Same link, gate closed: the URL still ACCEPTS 500 — it has to, or the
    // value could never come back — but the size that reaches the request is
    // the largest rung still offered. Never a 500 the endpoint would have to
    // serve for a reader whose control cannot name it.
    const closed = renderHook(() => useUrlSyncedBranchServerState(), {
      wrapper: ladderNavigationWrapper(
        createMemoryNavigation({ initialPath: path }).adapter,
        false
      ),
    });

    expect(closed.result.current.pageSize).toBe(100);
  });

  test("holds the read gate closed until the named view's arrangement has landed", () => {
    // ISS-9447 (review). `isReadReady` folded the LIVE view's restore together
    // with the ladder flag (ISS-9692) and knew nothing about a NAMED view, whose
    // arrangement reaches the live hooks a commit later. So an active 100-row
    // saved view over a live 25-row state opened the first server read at 25 and
    // replaced it at 100 — the ISS-9692 double read, arriving through the
    // rows-per-page axis M5 added to named views.
    const path = "/acme/branches";
    globalThis.history.replaceState(null, "", path);
    const wrapper = ladderNavigationWrapper(
      createMemoryNavigation({ initialPath: path }).adapter,
      true
    );
    const { rerender, result } = renderHook(
      ({ isArrangementSettled }: { isArrangementSettled: boolean }) =>
        useUrlSyncedBranchServerState({
          isArrangementSettled,
          isRestored: true,
        }),
      { initialProps: { isArrangementSettled: false }, wrapper }
    );

    expect(result.current.isReadReady).toBe(false);

    rerender({ isArrangementSettled: true });
    expect(result.current.isReadReady).toBe(true);
  });

  test("treats an omitted arrangement signal as nothing to wait for", () => {
    // A surface with no named views passes no flag, and must not be gated on one
    // it can never satisfy.
    const path = "/acme/branches";
    globalThis.history.replaceState(null, "", path);
    const { result } = renderHook(
      () => useUrlSyncedBranchServerState({ isRestored: true }),
      {
        wrapper: ladderNavigationWrapper(
          createMemoryNavigation({ initialPath: path }).adapter,
          true
        ),
      }
    );

    expect(result.current.isReadReady).toBe(true);
  });
});

function ladderNavigationWrapper(
  adapter: ReturnType<typeof createMemoryNavigation>["adapter"],
  extendedLadderEnabled: boolean
) {
  return function LadderNavigationWrapper({
    children,
  }: {
    children: ReactNode;
  }) {
    return (
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: extendedLadderEnabled
            ? [TABLE_PAGE_SIZE_LADDER_FEATURE_FLAG_KEY]
            : [],
        })}
      >
        <NavigationProvider adapter={adapter}>{children}</NavigationProvider>
      </FeatureFlagAdapterProvider>
    );
  };
}

/**
 * ISS-12456 (Cosimo Corrigan, 2026-10-14): "In single-user mode, rows should not
 * be filtered by tags." Desktop local mode's source cannot serve `tags`, so
 * that host offers no Tags facet — and a selection reaching it anyway, from a
 * saved view (FEA-4180) or a link, matched no row and left nothing on screen to
 * clear it with. The drop is in the filter STATE rather than the row predicate,
 * so `branchFiltersAreActive`, the URL and the producer request agree with the
 * rows. `ROWS` carry no tags, which is what every local row looks like.
 */
describe("Branches tag filtering on a host whose source serves no tags", () => {
  const TAG_ID = "tag-a";
  const TAG_LINK = `/acme/branches?${BRANCH_FILTER_PARAMS.tags}=${TAG_ID}`;
  const tagSelection = (): BranchFilters => ({
    ...DEFAULT_BRANCH_FILTERS,
    tags: [TAG_ID],
  });

  test.each([
    [false, 0, ROWS.length],
    [true, 1, 0],
  ] as const)(
    "applies an applied selection only when tagsSupported is %s",
    (tagsSupported, expectedSelected, expectedTotal) => {
      const navigation = createMemoryNavigation({
        initialPath: "/acme/branches",
      });
      const { result } = renderHook(
        () =>
          useUrlSyncedBranchFilterState(
            ROWS,
            BRANCH_PAGE_SIZE,
            true,
            undefined,
            undefined,
            tagsSupported
          ),
        { wrapper: navigationWrapper(navigation.adapter) }
      );

      act(() => {
        result.current.handleFiltersChange(tagSelection());
      });

      expect(result.current.filters.tags).toHaveLength(expectedSelected);
      expect(result.current.total).toBe(expectedTotal);
      expect(
        navigation.getCurrentHref().includes(`${BRANCH_FILTER_PARAMS.tags}=`)
      ).toBe(tagsSupported);
    }
  );

  test.each([
    [false, 0, ROWS.length],
    [true, 1, 0],
  ] as const)(
    "seeds a link's selection only when tagsSupported is %s",
    (tagsSupported, expectedSelected, expectedTotal) => {
      const { result } = renderHook(
        () =>
          useUrlSyncedBranchFilterState(
            ROWS,
            BRANCH_PAGE_SIZE,
            true,
            undefined,
            undefined,
            tagsSupported
          ),
        {
          wrapper: navigationWrapper(
            createMemoryNavigation({ initialPath: TAG_LINK }).adapter
          ),
        }
      );

      expect(result.current.filters.tags).toHaveLength(expectedSelected);
      expect(result.current.total).toBe(expectedTotal);
    }
  );

  // The producer-paged half: this hook's `filters` are what the branch-list
  // request sends, so an undroppable selection would reach the local store too.
  test.each([
    [false, 0],
    [true, 1],
  ] as const)(
    "keeps the producer request's tag selection only when tagsSupported is %s",
    (tagsSupported, expectedSelected) => {
      const { result } = renderHook(
        () => useUrlSyncedBranchServerState(undefined, tagsSupported),
        {
          wrapper: navigationWrapper(
            createMemoryNavigation({ initialPath: TAG_LINK }).adapter
          ),
        }
      );

      expect(result.current.filters.tags).toHaveLength(expectedSelected);

      act(() => {
        result.current.handleFiltersChange(tagSelection());
      });

      expect(result.current.filters.tags).toHaveLength(expectedSelected);
    }
  );
});

function renderBranchServerStateAt(path: string) {
  return renderHook(() => useUrlSyncedBranchServerState(), {
    wrapper: navigationWrapper(
      createMemoryNavigation({ initialPath: path }).adapter
    ),
  });
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

function navigationWrapper(
  adapter: ReturnType<typeof createMemoryNavigation>["adapter"]
) {
  return function NavigationWrapper({ children }: { children: ReactNode }) {
    return (
      <NavigationProvider adapter={adapter}>{children}</NavigationProvider>
    );
  };
}

describe("ISS-13035 Branches search is gated by gridview-adoption", () => {
  const SEARCH_URL = "/acme/branches?owner=Alex&search=feature";

  function mountBoth(enabledFlags: readonly string[]) {
    const navigation = createMemoryNavigation({ initialPath: SEARCH_URL });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
      >
        <NavigationProvider adapter={navigation.adapter}>
          {children}
        </NavigationProvider>
      </FeatureFlagAdapterProvider>
    );
    return {
      legacy: renderHook(() => useUrlSyncedBranchFilterState(ROWS), {
        wrapper,
      }),
      navigation,
      server: renderHook(() => useUrlSyncedBranchServerState(), { wrapper }),
    };
  }

  test("GV-SEARCH-1 off: a ?search= link seeds no search term, on either hook", () => {
    const { legacy, server } = mountBoth([]);
    expect(legacy.result.current.filters.owners).toEqual(["Alex"]);
    expect(legacy.result.current.filters.search).toBeUndefined();
    expect(server.result.current.filters.owners).toEqual(["Alex"]);
    expect(server.result.current.filters.search).toBeUndefined();
  });

  test("GV-SEARCH-2 off: a filter write leaves the ?search= param alone", () => {
    const { legacy, navigation } = mountBoth([]);
    act(() => legacy.result.current.handleFiltersChange(ownerFilter("Sam")));
    const href = new URL(navigation.getCurrentHref(), "https://example.test");
    expect(href.searchParams.get("owner")).toBe("Sam");
    expect(href.searchParams.get("search")).toBe("feature");
  });

  test("GV-SEARCH-3 on: a ?search= link seeds the term, on either hook", () => {
    const { legacy, server } = mountBoth([GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY]);
    expect(legacy.result.current.filters.search).toBe("feature");
    expect(server.result.current.filters.search).toBe("feature");
  });

  test("GV-SEARCH-4 on: resetting the filters removes the ?search= param", () => {
    const { legacy, navigation } = mountBoth([
      GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
    ]);
    act(() =>
      legacy.result.current.handleFiltersChange(DEFAULT_BRANCH_FILTERS)
    );
    const href = new URL(navigation.getCurrentHref(), "https://example.test");
    expect(href.searchParams.has("search")).toBe(false);
    expect(href.searchParams.has("owner")).toBe(false);
  });

  describe("while gridview-adoption is unresolved", () => {
    function mountUnresolved() {
      const flag = { enabled: false, resolved: false };
      const adapter = {
        useFeatureFlagEnabled: () => flag.enabled,
        useFeatureFlagResolved: () => flag.resolved,
      };
      const navigation = createMemoryNavigation({ initialPath: SEARCH_URL });
      const wrapper = ({ children }: { children: ReactNode }) => (
        <FeatureFlagAdapterProvider adapter={adapter}>
          <NavigationProvider adapter={navigation.adapter}>
            {children}
          </NavigationProvider>
        </FeatureFlagAdapterProvider>
      );
      return {
        flag,
        legacy: renderHook(() => useUrlSyncedBranchFilterState(ROWS), {
          wrapper,
        }),
        server: renderHook(() => useUrlSyncedBranchServerState(), { wrapper }),
      };
    }

    test("GV-SEARCH-5 keeps the seeded term, then keeps it once the flag resolves open", () => {
      const { flag, legacy, server } = mountUnresolved();
      expect(legacy.result.current.filters.search).toBe("feature");
      expect(server.result.current.filters.search).toBe("feature");

      flag.enabled = true;
      flag.resolved = true;
      legacy.rerender();
      server.rerender();

      expect(legacy.result.current.filters.search).toBe("feature");
      expect(legacy.result.current.pagedRows).toHaveLength(0);
      expect(server.result.current.filters.search).toBe("feature");
    });

    test("GV-SEARCH-6 drops the seeded term once the flag resolves closed, keeping the other facets", () => {
      const { flag, legacy, server } = mountUnresolved();
      expect(legacy.result.current.filters.search).toBe("feature");

      flag.resolved = true;
      act(() => {
        legacy.rerender();
        server.rerender();
      });

      expect(legacy.result.current.filters.search).toBeUndefined();
      expect(legacy.result.current.filters.owners).toEqual(["Alex"]);
      expect(server.result.current.filters.search).toBeUndefined();
      expect(server.result.current.filters.owners).toEqual(["Alex"]);
    });
  });
});
