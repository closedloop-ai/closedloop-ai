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
// measure pixel bounds at 1024/900/768px here; instead we assert (a) all four
// cards render, and (b) the grid carries the derived-track contract, with the
// floor it reads published on the same element. The shared-only Electron
// baseline duplicate was removed in ISS-10527; this suite does not prove pixels.

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
vi.mock("@repo/app/branches/data-source/branches-live-bridge", () => ({
  BranchesLiveBridge: () => null,
}));
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: useDesktopAuthMock,
}));
vi.mock("@repo/app/shared/hooks/use-shared-date-range", () => ({
  useSharedDateRange: () => ({ dateRange: "all", setDateRange: vi.fn() }),
}));
vi.mock(
  "@repo/app/branches/hooks/use-branch-view-state",
  async (importOriginal) => ({
    // ISS-8909: the v2 list surface is the only Branches arm now, and its
    // toolbar reads more of this module than the v1 one did. Stand down only
    // the hook these cases pin; a bare factory drops the rest.
    ...(await importOriginal<
      typeof import("@repo/app/branches/hooks/use-branch-view-state")
    >()),
    useBranchViewState: () => ({
      // ISS-8127: the view gates presentation on this, so a stub omitting it
      // reads as "never restored" and withholds every row. These suites are
      // not about the restore, so the view is already settled.
      isViewReady: true,
      sortKey: "updated",
      sortDir: "desc",
      dateRange: "all",
      visibleColumns: new Set<string>(["repo"]),
      setSort: vi.fn(),
      toggleSortDir: vi.fn(),
      setDateRange: vi.fn(),
      toggleColumn: vi.fn(),
    }),
  })
);

// The approved KPI card labels, in their fixed PRD-601 render order. ISS-9970
// retired the AI spend card; ISS-10636 then made ISS-9957's five-card row
// unconditional, putting Total LOC pushed in that slot and moving LOC per $ last.
const CARD_LABELS = [
  "Active branches",
  "Median PR size",
  "Total LOC pushed",
  "Merge rate",
  "LOC per $",
];

// Card LABELS render in every metric state (pending/error/available/
// unavailable). ISS-9961 retired the `gated` state along with the legacy row
// that had one, so the canonical five-card bundle this view mounts never
// renders it. A neutral resolved analytics fixture
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
// each pinned cell clears the comfortable floor rather than whether all the
// cards close one rank). Declared rather than inherited. (The Branches strip
// pins Compact since ISS-10540, so its floor no longer depends on the tier;
// the column derivation below still does.)
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

  it("lays the cards out on one rank against the shared per-card minimum", () => {
    const { container } = renderView(dataSource);
    // The strip's LAYOUT MODE, which #7544 settled as a fixed rank that
    // stretches. ISS-8909 recorded the auto-fit tracks as the contract here and
    // then recorded them leaving it; neither is the rule any more. The row is a
    // flex line inside the band's own `overflow-x-auto`, because the band is a
    // NON-SHRINKING flex item beside the table's `min-h-0 flex-1` scroll region
    // (`GridTableListSurface`) — so a wrapping grid buys its extra rank out of
    // the table, and at 768x800 on the launched shell it bought all of it (band
    // 188.57px -> 549px, scroll region 0px, rows visible and unclickable). The
    // gutter the tracks were meant to close is closed by the CARD instead, with
    // `grow` (`SUMMARY_CARD_STRETCH_CLASS`).
    //
    // whitlockk (#7544): jsdom observes the class list and nothing else — it lays
    // out no boxes, so this file CANNOT and does not claim the cards absorb the
    // remaining width. That geometry is proved on the launched app, at the width
    // the shell boots at, by `expectMetricsCardsToSpanBandAtDesktopWidth` in
    // `apps/desktop/test/e2e/branches-responsive-grid-v2.spec.ts`, and the one-rank half by
    // `expectMetricsRowToOwnHorizontalOverflow` in the same file.
    //
    // The row publishes `data-density` on itself, so that is the handle onto the
    // strip — not a layout class, which is the thing under test.
    const strip = container.querySelector<HTMLElement>("[data-density]");
    expect(strip).not.toBeNull();
    const className = strip?.className ?? "";
    // ISS-4787 follow-up, unchanged: no pinned column count at any breakpoint. A
    // fixed tier is both what orphaned the fifth card at 2+2+1 (FEA-2935) and
    // what later squeezed the Sessions strip's cards under the width its
    // two-line label reservation assumes.
    expect(className).not.toMatch(FIXED_COLUMN_TIER_PATTERN);
    // …and no grid tracks either, because a rank this row cannot gain is a rank
    // it cannot spend the table on. The scroller that replaces them is the
    // row's own, so it is asserted here rather than implied.
    expect(className).not.toContain(DERIVED_TRACKS_CLASS);
    expect(className).toContain("overflow-x-auto");
    // Stage review: the desktop strip no longer carries a host-local layout class
    // that overrode the row's display, so its gutter is the row's `gap-4`.
    //
    // ISS-5070: read through `classList`, not as a substring of the whole
    // attribute. The row also carries the `Card` density variant, whose compact
    // rule is spelled `[&[data-density=compact]_[data-slot=card]]:gap-3` — a
    // rule about the card INTERIOR, applied to descendants, that never sets this
    // box's own gutter. A substring scan reads that variant's suffix as a 12px
    // strip gutter and fails on a class the strip does not apply to itself.
    expect(strip?.classList.contains("gap-4")).toBe(true);
    expect(strip?.classList.contains("gap-3")).toBe(false);
    // The floor each card is sized against is published on that same element, so
    // the `var()` the card width reads always resolves.
    // ISS-5366: the COMPACT floor, not the 260px comfortable one. This asserted
    // 260 while `summary-strip-density` was a Labs toggle that resolved OFF in
    // the renderer suites; retiring the gate makes the track-width tier
    // unconditional, and at this pane's measured track five comfortable cards
    // cannot close one rank while five compact ones can — which is exactly the
    // rank ISS-5068 bought. Since ISS-10540 the strip pins Compact outright, so
    // 192 is the floor at every track and pinning 260 would be pinning a
    // layout no listing strip ships.
    expect(strip?.style.getPropertyValue("--summary-card-min")).toBe("192px");
    // All five cards live inside that one rank.
    const cards = [...(strip?.querySelectorAll('[data-slot="card"]') ?? [])];
    expect(cards.length).toBe(CARD_LABELS.length);
    // #7544: and each one GROWS into the band's spare width rather than pinning
    // to the floor above and stranding the remainder as a dead gutter. The
    // three classes go together — `grow` without `shrink-0` would let a card
    // fall under the published floor, and either without the floor as its
    // `basis` would stretch from a `0%` base and ignore the floor entirely.
    // jsdom lays out no boxes, so this is the emitted class list and not the
    // resulting geometry; that is
    // `expectMetricsCardsToSpanBandAtDesktopWidth` on the launched shell.
    for (const card of cards) {
      expect(card.classList.contains("grow")).toBe(true);
      expect(card.classList.contains("shrink-0")).toBe(true);
      expect(card.classList.contains("basis-[var(--summary-card-min)]")).toBe(
        true
      );
    }
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
