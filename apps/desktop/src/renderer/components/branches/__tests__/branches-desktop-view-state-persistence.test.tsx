import {
  type BranchAnalytics,
  type BranchUsageSummary,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import {
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { unavailableBranchTraceResult } from "@repo/api/src/types/branch-trace";
import { makeBranchAnalytics } from "@repo/app/branches/components/branch-analytics-fixtures";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import { useBranchViewState } from "@repo/app/branches/hooks/use-branch-view-state";
import { branchColumnLabel } from "@repo/app/branches/lib/branch-column-view-model";
import {
  DEFAULT_BRANCH_SORT_DIR,
  DEFAULT_BRANCH_SORT_KEY,
} from "@repo/app/branches/lib/branch-sort-group";
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { renderHookWithAuth } from "@repo/app/shared/hooks/__tests__/persisted-table-view-state.test-support";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthProvider } from "../../../shared-agent-sessions/desktop-auth-provider";
import { BranchesView } from "../branches-view";
import { inertApiAdapter, wireRow } from "./test-helpers";

/**
 * ISS-9449 — persistence contract for `useBranchViewState("desktop", true)`
 * (the approved Branches surface), exercised only through the hook's public
 * return value and, for the component-wiring case, `BranchesView`'s rendered
 * output. Storage keys per the hook's own composition (`approved` appends
 * `:approved` to the persistKey before the shared hook namespaces it by user):
 * legacy `branches:saved-view:desktop:approved`, per-user
 * `branches:saved-view:desktop:approved:u:<userId>`.
 *
 * Branches stamps no version markers (`resetColumnVersions` is not passed to
 * the shared hook), so the reset case below asserts only the shipped defaults
 * plus dropped carried ids — there is no stamp to assert.
 */

const LEGACY_KEY = "branches:saved-view:desktop:approved";
const PER_USER_KEY = "branches:saved-view:desktop:approved:u:user-1";

function validRecord(overrides: Record<string, unknown> = {}) {
  return {
    sortKey: BranchListSortKey.LastActivity,
    sortDir: BranchListSortDirection.Desc,
    dateRange: "7d",
    hiddenColumns: [] as string[],
    columnOrder: [] as string[],
    columnWidths: {} as Record<string, number>,
    ...overrides,
  };
}

function readJson(key: string): Record<string, unknown> | null {
  const raw = localStorage.getItem(key);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

// === Case A: component wiring under the real DesktopAuthProvider ===========

function makeCaseADataSource(): BranchesDataSource {
  const listMock = vi.fn().mockResolvedValue({
    items: [wireRow],
    total: 1,
    viewerScope: BranchViewerScope.Self,
  });
  return {
    scope: "local",
    list: listMock,
    detail: () => new Promise<never>(() => undefined),
    comments: () => new Promise<never>(() => undefined),
    trace: () => Promise.resolve(unavailableBranchTraceResult()),
    usage: () => new Promise<BranchUsageSummary>(() => undefined),
    analytics: () => new Promise<BranchAnalytics>(() => undefined),
    cohortAnalytics: () => new Promise<never>(() => undefined),
    pageData: async (filters) => ({
      list: await listMock(filters),
      analytics: makeBranchAnalytics(),
    }),
  };
}

describe("BranchesView view-state persistence (real DesktopAuthProvider)", () => {
  let desktopApiDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    localStorage.clear();
    desktopApiDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "desktopApi"
    );
  });

  afterEach(() => {
    cleanup();
    if (desktopApiDescriptor) {
      Object.defineProperty(window, "desktopApi", desktopApiDescriptor);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
    desktopApiDescriptor = undefined;
    localStorage.clear();
  });

  it("migrates a legacy hidden column on first authenticated restore and re-persists it under the per-user key", async () => {
    const legacyBytes = JSON.stringify(
      validRecord({ hiddenColumns: ["owner"] })
    );
    localStorage.setItem(LEGACY_KEY, legacyBytes);
    // The client-side date-window filter reads a SEPARATE store; without
    // this, `wireRow`'s fixed `lastActivityAt` falls outside the default 7d
    // window and the table renders its empty state instead of the row.
    localStorage.setItem("shared:date-range:desktop", JSON.stringify("all"));

    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        getDesktopAuthState: vi.fn().mockResolvedValue({
          status: "authenticated",
          userId: "user-1",
          organizationId: "org-1",
        }),
        onDesktopAuthStateChanged: vi.fn(() => () => undefined),
      },
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <DesktopAuthProvider>
          <ApiAdapterProvider adapter={inertApiAdapter}>
            <FeatureFlagAdapterProvider
              adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
            >
              <NavigationProvider
                adapter={
                  createMemoryNavigation({ initialPath: "/branches" }).adapter
                }
              >
                <BranchesView dataSource={makeCaseADataSource()} />
              </NavigationProvider>
            </FeatureFlagAdapterProvider>
          </ApiAdapterProvider>
        </DesktopAuthProvider>
      </QueryClientProvider>
    );

    await screen.findByText("feature/x");

    await waitFor(() => {
      expect(
        screen.queryByRole("columnheader", {
          name: branchColumnLabel("owner"),
        })
      ).toBeNull();
    });
    expect(
      screen.getByRole("columnheader", { name: "Repository" })
    ).toBeTruthy();

    await waitFor(() => {
      const parsed = readJson(PER_USER_KEY);
      expect(parsed).not.toBeNull();
      expect(parsed?.hiddenColumns).toEqual(expect.arrayContaining(["owner"]));
    });

    expect(localStorage.getItem(LEGACY_KEY)).toBe(legacyBytes);
  });
});

// === Case B: hook-level cases via useBranchViewState("desktop", true) ======

const SIGNED_IN = { isLoaded: true, userId: "user-1" };
const SIGNED_OUT = { isLoaded: true, userId: null };

function mountBranchesView(auth: { isLoaded: boolean; userId: string | null }) {
  return renderHookWithAuth(() => useBranchViewState("desktop", true), auth);
}

describe('useBranchViewState("desktop", true) persistence', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("holds defaults and touches no storage while auth is hydrating, then restores the per-user (not legacy) record and re-persists edits without touching the legacy bytes", async () => {
    const legacyBytes = JSON.stringify(
      validRecord({
        sortKey: BranchListSortKey.Owner,
        sortDir: BranchListSortDirection.Asc,
      })
    );
    localStorage.setItem(LEGACY_KEY, legacyBytes);
    localStorage.setItem(
      PER_USER_KEY,
      JSON.stringify(
        validRecord({
          sortKey: BranchListSortKey.Repo,
          sortDir: BranchListSortDirection.Desc,
          hiddenColumns: ["tags"],
        })
      )
    );

    const { result, setAuth } = mountBranchesView({
      isLoaded: false,
      userId: null,
    });

    expect(result.current.sortKey).toBe(DEFAULT_BRANCH_SORT_KEY);
    expect(result.current.sortDir).toBe(DEFAULT_BRANCH_SORT_DIR);
    expect(localStorage.getItem(LEGACY_KEY)).toBe(legacyBytes);
    expect(readJson(PER_USER_KEY)?.sortKey).toBe(BranchListSortKey.Repo);

    setAuth(SIGNED_IN);

    await waitFor(() => {
      expect(result.current.sortKey).toBe(BranchListSortKey.Repo);
    });
    expect(result.current.hiddenColumns).toEqual(
      expect.arrayContaining(["tags"])
    );

    act(() => {
      result.current.toggleColumn("owner");
    });

    await waitFor(() => {
      const perUser = readJson(PER_USER_KEY);
      expect(perUser?.hiddenColumns).toEqual(
        expect.arrayContaining(["tags", "owner"])
      );
    });
    expect(localStorage.getItem(LEGACY_KEY)).toBe(legacyBytes);
  });

  it("degrades to defaults on corrupt non-JSON bytes", () => {
    localStorage.setItem(PER_USER_KEY, "{not json");
    const { result } = mountBranchesView(SIGNED_IN);

    expect(result.current.sortKey).toBe(DEFAULT_BRANCH_SORT_KEY);
    expect(result.current.sortDir).toBe(DEFAULT_BRANCH_SORT_DIR);
  });

  it("degrades to defaults on a rejected shape (invalid sortDir)", () => {
    localStorage.setItem(
      PER_USER_KEY,
      JSON.stringify(validRecord({ sortDir: "sideways" }))
    );
    const { result } = mountBranchesView(SIGNED_IN);

    expect(result.current.sortKey).toBe(DEFAULT_BRANCH_SORT_KEY);
    expect(result.current.sortDir).toBe(DEFAULT_BRANCH_SORT_DIR);
  });

  it("cleans per-axis corruption while a valid sort survives", () => {
    localStorage.setItem(
      PER_USER_KEY,
      JSON.stringify(
        validRecord({
          sortKey: BranchListSortKey.Repo,
          sortDir: BranchListSortDirection.Desc,
          hiddenColumns: 42,
          columnOrder: [7, null, "repo"],
          columnWidths: { repo: -5, owner: "wide" },
        })
      )
    );
    const { result } = mountBranchesView(SIGNED_IN);

    expect(result.current.sortKey).toBe(BranchListSortKey.Repo);
    expect(result.current.sortDir).toBe(BranchListSortDirection.Desc);
    expect(result.current.hiddenColumns).toEqual([]);
    expect(result.current.columnOrder).toEqual(["repo"]);
    expect(result.current.columnWidths).toEqual({});
  });

  it("resetColumns restores the shipped defaults and drops carried unknown-column ids", async () => {
    localStorage.setItem(
      PER_USER_KEY,
      JSON.stringify(
        validRecord({
          hiddenColumns: ["owner", "future-column"],
          columnOrder: ["repo", "owner", "future-column"],
          columnWidths: { owner: 120, "future-column": 80 },
        })
      )
    );
    const { result } = mountBranchesView(SIGNED_IN);

    await waitFor(() => {
      expect(result.current.hiddenColumns).toEqual(
        expect.arrayContaining(["owner"])
      );
    });

    act(() => {
      result.current.resetColumns();
    });

    await waitFor(() => {
      const perUser = readJson(PER_USER_KEY);
      expect(perUser?.hiddenColumns).toEqual([]);
      expect(perUser?.columnOrder).toEqual([]);
      expect(perUser?.columnWidths).toEqual({});
      expect(JSON.stringify(perUser)).not.toContain("future-column");
    });
  });

  it("persists an offline edit and restores it on remount, never touching the network", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("offline"));

    const first = mountBranchesView(SIGNED_IN);

    await waitFor(() => expect(first.result.current.isViewReady).toBe(true));

    act(() => {
      first.result.current.toggleColumn("owner");
      first.result.current.setSort(
        BranchListSortKey.Repo,
        BranchListSortDirection.Asc
      );
    });

    await waitFor(() => {
      const perUser = readJson(PER_USER_KEY);
      expect(perUser?.sortKey).toBe(BranchListSortKey.Repo);
      expect(perUser?.hiddenColumns).toEqual(expect.arrayContaining(["owner"]));
    });

    first.unmount();

    const second = mountBranchesView(SIGNED_IN);

    await waitFor(() => {
      expect(second.result.current.sortKey).toBe(BranchListSortKey.Repo);
    });
    expect(second.result.current.sortDir).toBe(BranchListSortDirection.Asc);
    expect(second.result.current.hiddenColumns).toEqual(
      expect.arrayContaining(["owner"])
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("signed out uses the legacy key only, and writes only that key", async () => {
    const { result } = mountBranchesView(SIGNED_OUT);

    await waitFor(() => expect(result.current.isViewReady).toBe(true));

    act(() => {
      result.current.toggleColumn("owner");
      result.current.setSort(
        BranchListSortKey.Repo,
        BranchListSortDirection.Asc
      );
    });

    await waitFor(() => {
      const legacy = readJson(LEGACY_KEY);
      expect(legacy?.sortKey).toBe(BranchListSortKey.Repo);
      expect(legacy?.hiddenColumns).toEqual(expect.arrayContaining(["owner"]));
    });
    expect(localStorage.getItem(PER_USER_KEY)).toBeNull();
  });
});
