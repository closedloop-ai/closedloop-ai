import {
  type BranchAnalytics,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import { screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderView, wireRow } from "./test-helpers";

// FEA-2935 regression: the five-card metric row orphaned its last card (Median
// PR size) at half width whenever it reflowed to a two-column grid at narrow
// desktop widths. The fix skips the two-column tier entirely. jsdom has no
// layout engine, so we can't measure pixel bounds at 1024/900/768px here;
// instead we assert (a) all five cards render, and (b) the grid carries the
// corrected responsive contract that never drops to two columns — the specific
// class regression that would reintroduce the orphan. A real-viewport pixel
// spec would require launching the full Electron app (test/e2e), which is out
// of proportion for a pure CSS-class fix.

const { openGitHubConnectMock, useDesktopAuthMock } = vi.hoisted(() => ({
  openGitHubConnectMock: vi.fn(),
  useDesktopAuthMock: vi.fn(),
}));

// Only the summary-card grid is under test, so the table-side siblings are
// stubbed to markers (mirrors branches-view.test.tsx). BranchesSummaryCards is
// deliberately NOT mocked — it is the component under test.
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

// The five KPI card labels, in render order. "Median PR size" is the fifth —
// the card the two-column tier orphaned.
const CARD_LABELS = [
  "AI spend",
  "Value per $",
  "Active branches",
  "Merge rate",
  "Median PR size",
];

// `analytics` stays pending so every card renders its labelled skeleton — the
// labels (and the grid) are present regardless of the resolved KPI values.
const dataSource: BranchesDataSource = {
  scope: "local",
  list: () =>
    Promise.resolve({
      items: [wireRow],
      total: 1,
      viewerScope: BranchViewerScope.Self,
    }),
  detail: () => new Promise<never>(() => undefined),
  comments: () => new Promise<never>(() => undefined),
  trace: () => Promise.resolve([]),
  usage: () => new Promise<never>(() => undefined),
  analytics: () => new Promise<BranchAnalytics>(() => undefined),
};

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

describe("BranchesView responsive metric row (FEA-2935)", () => {
  it("renders all five metric cards", () => {
    renderView(dataSource);
    for (const label of CARD_LABELS) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("lays the cards out on a grid that never drops to two columns", () => {
    const { container } = renderView(dataSource);
    // The card container is the sole element carrying the five-column tier.
    const grid = container.querySelector('[class~="xl:grid-cols-5"]');
    expect(grid).not.toBeNull();
    const className = grid?.className ?? "";
    // A two-column tier is what orphaned the fifth card at 2+2+1.
    expect(className).not.toContain("grid-cols-2");
    // Stacks in one column when narrow, then jumps straight to three, then five.
    // The three-column tier is gated at `lg` (not `md`) so it only kicks in once
    // there's room past the 16rem desktop sidebar (FEA-2935 follow-up).
    expect(className).toContain("grid-cols-1");
    expect(className).toContain("lg:grid-cols-3");
    expect(className).not.toContain("md:grid-cols-3");
    expect(className).toContain("xl:grid-cols-5");
    // All five cards live inside that one grid.
    expect(grid?.querySelectorAll('[data-slot="card"]').length).toBe(5);
  });

  it("keeps pagination inside a horizontal overflow owner", async () => {
    const manyRowsDataSource: BranchesDataSource = {
      ...dataSource,
      list: () =>
        Promise.resolve({
          items: Array.from({ length: 30 }, (_value, index) => ({
            ...wireRow,
            id: `owner%2Frepo::feature-${index}`,
            branchName: `feature/x-${index}`,
          })),
          total: 30,
          viewerScope: BranchViewerScope.Self,
        }),
    };
    renderView(manyRowsDataSource);

    const pagination = await screen.findByRole("navigation", {
      name: "pagination",
    });
    expect(pagination.classList.contains("min-w-max")).toBe(true);
    if (!pagination.parentElement) {
      throw new Error("Branches pagination overflow owner was missing");
    }
    expect(pagination.parentElement.classList.contains("overflow-x-auto")).toBe(
      true
    );
  });
});
