import {
  type BranchAnalytics,
  BranchKpiState,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { unavailableBranchTraceResult } from "@repo/api/src/types/branch-trace";
import {
  kpi,
  makeBranchAnalytics,
  makeBranchListMetrics,
} from "@repo/app/branches/components/branch-analytics-fixtures";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import { branchesKeys } from "@repo/app/branches/hooks/use-branches";
import { QueryClient } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderView, wireRow } from "./test-helpers";

// FEA-2938 regression. On the desktop `/branches` page the ACTIVE BRANCHES KPI
// climbs as the importer ingests sessions (0 → 1 → 9). That live climb is the
// intended behaviour — the count reflects a genuinely growing corpus. What must
// NOT happen is a *regression*: navigating away mid-import and back must never
// drop the KPI below the value the user last read (nor flash a "—" loading
// read), because the analytics query is cached across the unmount/remount. This
// spec pins that non-regression invariant. A pixel-level import spec would need
// the full Electron app (test/e2e); the caching contract that guarantees
// non-regression is fully exercisable at the renderer level, matching the jsdom
// approach in branches-responsive-layout.test.tsx.

const { openGitHubConnectMock, useDesktopAuthMock } = vi.hoisted(() => ({
  openGitHubConnectMock: vi.fn(),
  useDesktopAuthMock: vi.fn(),
}));

// Only the summary-card KPIs are under test, so the table-side siblings are
// stubbed to markers (mirrors branches-responsive-layout.test.tsx).
// BranchesSummaryCards is deliberately NOT mocked — it is the component whose
// KPI stability we assert.
vi.mock("@repo/app/branches/components/branches-table", () => ({
  BranchesTable: () => null,
}));
vi.mock("@repo/app/branches/components/branches-toolbar", () => ({
  BranchesToolbar: () => null,
}));
vi.mock("@repo/app/branches/data-source/branches-live-bridge", () => ({
  BranchesLiveBridge: () => null,
}));
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: useDesktopAuthMock,
}));
// A fixed window keeps the analytics query key stable across the away+back
// remount, so the second mount hits the same cache entry.
vi.mock("@repo/app/shared/hooks/use-shared-date-range", () => ({
  useSharedDateRange: () => ({ dateRange: "all", setDateRange: vi.fn() }),
}));
vi.mock("@repo/app/branches/hooks/use-branch-view-state", () => ({
  useBranchViewState: () => ({
    sortKey: "updated",
    sortDir: "desc",
    dateRange: "all",
    visibleColumns: new Set<string>(["repo"]),
    setSort: vi.fn(),
    toggleSortDir: vi.fn(),
    setDateRange: vi.fn(),
    toggleColumn: vi.fn(),
  }),
}));

/** Analytics with a caller-chosen ACTIVE BRANCHES count; other cards are inert. */
function analyticsWithActive(activeBranchCount: number): BranchAnalytics {
  return makeBranchAnalytics({
    activeBranchCount: kpi(BranchKpiState.Available, activeBranchCount),
    canonicalMetrics: makeBranchListMetrics({
      cohortSize: activeBranchCount,
      activeBranches: {
        current: {
          state: BranchMetricAvailability.Complete,
          value: activeBranchCount,
        },
      },
    }),
  });
}

/** The rendered value of the ACTIVE BRANCHES card, or null before it paints. */
function activeBranchesValue(container: HTMLElement): string | null {
  const cards = container.querySelectorAll<HTMLElement>('[data-slot="card"]');
  for (const card of cards) {
    const label = card.querySelector('[data-slot="card-description"]');
    if (label?.textContent?.includes("Active branches")) {
      return (
        card.querySelector('[data-slot="card-title"]')?.textContent?.trim() ??
        null
      );
    }
  }
  return null;
}

beforeAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  openGitHubConnectMock.mockResolvedValue({
    ok: true,
    url: "http://localhost",
  });
  useDesktopAuthMock.mockReturnValue({
    state: {
      status: "authenticated",
      userId: "user-1",
      organizationId: "org-1",
    },
    beginSignIn: vi.fn(),
  });
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { openGitHubConnect: openGitHubConnectMock },
  });
});

/** `activeBranchCount` distinct open-PR rows matching the canonical count. */
function openRows(activeBranchCount: number) {
  return Array.from({ length: activeBranchCount }, (_, i) => ({
    ...wireRow,
    id: `owner%2Frepo::feature-${i}`,
    branchName: `feature/x-${i}`,
  }));
}

describe("Branches ACTIVE BRANCHES KPI stability mid-import (FEA-2938)", () => {
  it("does not regress across a nav-away+back while the import advances", async () => {
    // The importer ingests more branches between the two mounts, so the second
    // canonical page-data read advances the active count from 1 to 9.
    let activeBranchCount = 1;
    const list = () => {
      const items = openRows(activeBranchCount);
      return Promise.resolve({
        items,
        total: items.length,
        viewerScope: BranchViewerScope.Self,
      });
    };
    // The producer emits the same active count in the canonical bundle and the
    // compatibility KPI field; the approved renderer reads the canonical one.
    const analytics = vi.fn(() =>
      Promise.resolve(analyticsWithActive(activeBranchCount))
    );
    // The view fetches list + analytics together via `pageData` (FEA-3056
    // follow-up), so the cache-stability contract this spec pins now lives on
    // that combined query — `pageData` composes the same two reads.
    const dataSource: BranchesDataSource = {
      scope: "local",
      list,
      detail: () => new Promise<never>(() => undefined),
      comments: () => new Promise<never>(() => undefined),
      trace: () => Promise.resolve(unavailableBranchTraceResult()),
      usage: () => new Promise<never>(() => undefined),
      analytics,
      pageData: async () => ({
        list: await list(),
        analytics: await analytics(),
      }),
    };

    // The view sets an explicit staleTime on the combined page-data query
    // (matches production), so — as in production — the refresh driver here is
    // an explicit invalidation (the live bridge's `desktop:db:changed` push),
    // not staleness elapsing. desktop's real QueryClient runs `staleTime:
    // Infinity` as a pure push model for exactly this reason.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    // Mid-import the user reads "1".
    const first = renderView(dataSource, queryClient);
    await waitFor(() => expect(activeBranchesValue(first.container)).toBe("1"));

    // Nav away — the branches view unmounts, but the page-data query stays
    // cached.
    first.unmount();

    // The import advances further while the user is away, and the live bridge
    // invalidates the page-data query on the resulting DB-changed push.
    activeBranchCount = 9;
    await queryClient.invalidateQueries({
      queryKey: branchesKeys.pageDataRoot(),
    });

    // Nav back. The cached "1" must paint straight away — never a lower number
    // and never the "—" loading placeholder — before it reconciles up to "9".
    const second = renderView(dataSource, queryClient);
    // The cached value paints synchronously on remount — this is the
    // non-regression guard: a cache miss here would render "—" (or a stale 0)
    // and fail. Then it reconciles forward to the fresher import count.
    expect(activeBranchesValue(second.container)).toBe("1");
    await waitFor(() =>
      expect(activeBranchesValue(second.container)).toBe("9")
    );
  });
});
