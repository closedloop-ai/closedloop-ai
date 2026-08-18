import {
  type BranchAnalytics,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import { unavailableBranchTraceResult } from "@repo/api/src/types/branch-trace";
import { makeBranchAnalytics } from "@repo/app/branches/components/branch-analytics-fixtures";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import { screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderView, wireRow } from "./test-helpers";

// FEA-2935 regression: the five-card metric row orphaned its last card (Median
// PR size) at half width whenever it reflowed to a two-column grid at narrow
// desktop widths. ISS-4787 follow-up: the pinned tiers that replaced it are gone
// too — the strip now derives its column count from the shared
// `--summary-card-min` floor, so no width can squeeze a card under the size the
// two-line label reservation assumes. jsdom has no layout engine, so we can't
// measure pixel bounds at 1024/900/768px here; instead we assert (a) all five
// cards render, and (b) the grid carries the derived-track contract, with the
// floor it reads published on the same element. The pixel geometry is covered on
// the launched app by `test/e2e/sessions-summary-strip-baseline.spec.ts`.

/**
 * Any responsive tier that pins a COUNT of columns (`lg:grid-cols-3`,
 * `xl:grid-cols-5`, …). The unprefixed `grid-cols-1` stacked tier is fine — it can
 * never squeeze a card — so the pattern requires a breakpoint prefix.
 */
const FIXED_COLUMN_TIER_PATTERN = /(?:^|\s)\w+:grid-cols-\d/;
/**
 * The shared row's `md+` auto-fit track template. Written out here rather than
 * read off the component so a change to the template has to be made deliberately
 * rather than silently agreeing with itself (same convention as `@repo/app`'s own
 * summary-card-row tests).
 */
const DERIVED_TRACKS_CLASS =
  "md:grid-cols-[repeat(auto-fit,minmax(var(--summary-card-min),1fr))]";

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

// The five approved KPI card labels, in their fixed PRD-601 render order.
const CARD_LABELS = [
  "Active branches",
  "LOC per $",
  "Median PR size",
  "AI spend",
  "Merge rate",
];

// Card LABELS render in every KPI state (pending/error/available/gated/
// unavailable — see `BranchKpiCard`), so a neutral resolved analytics fixture
// is enough for these layout assertions; only the pagination test cares about
// list contents. `pageData` is now the sole read the view fetches from
// (FEA-3056 follow-up), so `list`/`analytics` below are unused by the
// component but kept to satisfy the port's full interface.
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
  trace: () => Promise.resolve(unavailableBranchTraceResult()),
  usage: () => new Promise<never>(() => undefined),
  analytics: () => new Promise<BranchAnalytics>(() => undefined),
  pageData: () =>
    Promise.resolve({
      list: { items: [wireRow], total: 1, viewerScope: BranchViewerScope.Self },
      analytics: makeBranchAnalytics(),
    }),
};

// ISS-5366: these assertions describe the DESKTOP strip, so the renderer has to
// report the `md+` tier. jsdom's `matchMedia` answers `matches: false` to every
// query, which since ISS-5366 puts `useSummaryCardDensity` in its below-`md`
// fixed-rank regime (the row pins `grid-cols-2` there, so the tier asks whether
// each pinned cell clears the comfortable floor rather than whether all five
// cards close one rank) and resolves COMPACT — publishing a 192px floor for a
// pane that is nothing like a phone. Declared rather than inherited.
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: true,
      media: query,
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
});

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

  it("lays the cards out on tracks derived from the shared per-card minimum", () => {
    const { container } = renderView(dataSource);
    // The card container is the sole element carrying the shared grid tracks.
    const grid = container.querySelector<HTMLElement>(
      `[class~="${DERIVED_TRACKS_CLASS}"]`
    );
    expect(grid).not.toBeNull();
    const className = grid?.className ?? "";
    // ISS-4787 follow-up: no pinned column count at any breakpoint. A fixed tier
    // is both what orphaned the fifth card at 2+2+1 (FEA-2935) and what later
    // squeezed the Sessions strip's cards under the width its two-line label
    // reservation assumes — `auto-fit` over the published floor can do neither.
    expect(className).not.toMatch(FIXED_COLUMN_TIER_PATTERN);
    // Below `md` the strip pairs two-up through the row's own `wrapBelow`, and
    // FEA-2935's orphan is prevented by the odd-last-child span rather than by
    // banning a two-column tier outright: with five cards the fifth is
    // `:last-child:nth-child(odd)`, so it spans both columns and the row closes
    // flush instead of leaving it at half width beside an empty cell.
    expect(className).toContain("grid-cols-2");
    expect(className).toContain(
      "max-md:[&>*:last-child:nth-child(odd)]:col-span-2"
    );
    // Stage review: the desktop strip no longer carries a host-local layout class
    // that overrode the row's display, so its gutter is the row's `gap-4` and its
    // narrow treatment matches every other grid caller.
    //
    // ISS-5070: read through `classList`, not as a substring of the whole
    // attribute. The row also carries the `Card` density variant, whose compact
    // rule is spelled `[&[data-density=compact]_[data-slot=card]]:gap-3` — a
    // rule about the card INTERIOR, applied to descendants, that never sets this
    // box's own gutter. A substring scan reads that variant's suffix as a 12px
    // strip gutter and fails on a class the strip does not apply to itself.
    // `classList` is the same token view the `[class~="…"]` selector above uses,
    // so this keeps meaning "the strip does not carry a bare `gap-3` utility".
    // It would NOT catch a future row-scoped `[&[data-density=compact]]:gap-3`;
    // every rule in `CARD_DENSITY_VARIANT_CLASS` is descendant-scoped today.
    expect(grid?.classList.contains("gap-4")).toBe(true);
    expect(grid?.classList.contains("gap-3")).toBe(false);
    // The floor the tracks read is published on that same element, so the
    // `var()` always resolves.
    // ISS-5366: the COMPACT floor, not the 260px comfortable one. This asserted
    // 260 while `summary-strip-density` was a Labs toggle that resolved OFF in
    // the renderer suites; retiring the gate makes the track-width tier
    // unconditional, and at this pane's measured track five comfortable cards
    // cannot close one rank while five compact ones can — which is exactly the
    // rank ISS-5068 bought. So the published floor legitimately steps down, and
    // pinning 260 would now be pinning the pre-retirement layout.
    expect(grid?.style.getPropertyValue("--summary-card-min")).toBe("192px");
    // All five cards live inside that one grid.
    expect(grid?.querySelectorAll('[data-slot="card"]').length).toBe(5);
  });

  it("keeps pagination inside a horizontal overflow owner", async () => {
    const manyRows = Array.from({ length: 30 }, (_value, index) => ({
      ...wireRow,
      id: `owner%2Frepo::feature-${index}`,
      branchName: `feature/x-${index}`,
    }));
    const manyRowsDataSource: BranchesDataSource = {
      ...dataSource,
      list: () =>
        Promise.resolve({
          items: manyRows,
          total: 30,
          viewerScope: BranchViewerScope.Self,
        }),
      pageData: () =>
        Promise.resolve({
          list: {
            items: manyRows,
            total: 30,
            viewerScope: BranchViewerScope.Self,
          },
          analytics: makeBranchAnalytics(),
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
