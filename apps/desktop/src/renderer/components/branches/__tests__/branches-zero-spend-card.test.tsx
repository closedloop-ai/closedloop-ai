import {
  type BranchAnalytics,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import {
  BRANCH_METRIC_DICTIONARY,
  BranchMetricAvailability,
  BranchMetricId,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import { unavailableBranchTraceResult } from "@repo/api/src/types/branch-trace";
import {
  makeBranchAnalytics,
  makeBranchListMetrics,
} from "@repo/app/branches/components/branch-analytics-fixtures";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import { METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderView, wireRow } from "./test-helpers";

// ISS-4737 — the approved Electron surface renders the same canonical AI-spend
// result as web. A producer-classified NoData zero must never become a rendered
// $0, while a Complete positive value must remain visible. jsdom over the real
// `BranchesSummaryCards` is enough because the assertion is on the rendered
// canonical result rather than layout.
//
// ISS-9957 adds the other side of that gate to this same harness: with
// the gate retired, the Electron shell must render the
// canonical row — no spend card at all — and must keep the ratio card when its
// value is absent. Both shells are asserted through the surface a user mounts,
// not only through the shared component (davetho review).

const { openGitHubConnectMock, useDesktopAuthMock } = vi.hoisted(() => ({
  openGitHubConnectMock: vi.fn(),
  useDesktopAuthMock: vi.fn(),
}));

// Only the summary cards are under test, so the table-side siblings are stubbed
// to markers. `BranchesSummaryCards` is deliberately NOT mocked — it renders the
// value under assertion.
vi.mock("@repo/app/branches/components/branches-table", () => ({
  BranchesTable: () => null,
}));
vi.mock("@repo/app/branches/data-source/branches-live-bridge", () => ({
  BranchesLiveBridge: () => null,
}));
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: useDesktopAuthMock,
}));
// An all-time window keeps the fixture row visible regardless of wall clock.
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

/** The single fixture branch's linked session, priced by each test. */
const PRICED_SESSION_ID = "s1";

/** A wire row whose per-branch total matches the session's authoritative cost. */
function pricedWireRow(costUsd: number) {
  return {
    ...wireRow,
    estimatedCostUsd: costUsd,
    sessionIds: [PRICED_SESSION_ID],
  };
}

/**
 * A local data source whose canonical AI-spend result matches the authoritative
 * cost fixture: NoData for zero and Complete for a positive value.
 */
function sourceWithSessionCost(costUsd: number): BranchesDataSource {
  const items = [pricedWireRow(costUsd)];
  const list = {
    items,
    total: 1,
    viewerScope: BranchViewerScope.Self,
    sessionCostUsd: { [PRICED_SESSION_ID]: costUsd },
  };
  const aiSpendUsd =
    costUsd > 0
      ? {
          current: {
            state: BranchMetricAvailability.Complete,
            value: costUsd,
          },
        }
      : {
          current: {
            state: BranchMetricAvailability.NoData,
            value: null,
          },
        };
  return {
    scope: "local",
    list: () => Promise.resolve(list),
    detail: () => new Promise<never>(() => undefined),
    comments: () => new Promise<never>(() => undefined),
    trace: () => Promise.resolve(unavailableBranchTraceResult()),
    usage: () => new Promise<never>(() => undefined),
    analytics: () => new Promise<BranchAnalytics>(() => undefined),
    pageData: () =>
      Promise.resolve({
        list,
        analytics: makeBranchAnalytics({
          canonicalMetrics: makeBranchListMetrics({ aiSpendUsd }),
        }),
      }),
  };
}

/** The rendered value of the card whose label contains `label`, or null. */
function cardTitleFor(container: HTMLElement, label: string): string | null {
  const cards = container.querySelectorAll<HTMLElement>('[data-slot="card"]');
  for (const card of cards) {
    const description = card.querySelector('[data-slot="card-description"]');
    if (description?.textContent?.includes(label)) {
      return (
        card.querySelector('[data-slot="card-title"]')?.textContent?.trim() ??
        null
      );
    }
  }
  return null;
}

/** Every rendered summary-card label, in DOM order. */
function cardLabels(container: HTMLElement): string[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      '[data-slot="card-description"]'
    ),
  ].map((node) => node.textContent?.trim() ?? "");
}

/** ISS-9957's row, in its fixed order. Written out, not derived. */
const CANONICAL_ROW = [
  "Active branches",
  "Median PR size",
  "Total LOC pushed",
  "Merge rate",
  "LOC per $",
];

const COMPLETE_RATIO: BranchMetricResult<number> = {
  state: BranchMetricAvailability.Complete,
  value: 4,
};

const UNAVAILABLE_RATIO: BranchMetricResult<number> = {
  state: BranchMetricAvailability.Unavailable,
  value: null,
};

/**
 * A local source whose canonical bundle carries ISS-9957's two new fields.
 * `sparseSiblings` leaves the other four cards Unavailable, so the hide gate has
 * cards to take and the ratio's exemption is the only thing keeping it on
 * screen.
 */
function canonicalRowSource(
  ratio: BranchMetricResult<number>,
  sparseSiblings = false
): BranchesDataSource {
  const list = {
    items: [pricedWireRow(250)],
    total: 1,
    viewerScope: BranchViewerScope.Self,
    sessionCostUsd: { [PRICED_SESSION_ID]: 250 },
  };
  const complete = (
    value: number
  ): { current: BranchMetricResult<number> } => ({
    current: { state: BranchMetricAvailability.Complete, value },
  });
  const siblings = sparseSiblings
    ? {}
    : {
        activeBranches: complete(12),
        medianPrSize: complete(148),
        mergeRatePct: complete(85),
      };
  return {
    ...sourceWithSessionCost(250),
    list: () => Promise.resolve(list),
    pageData: () =>
      Promise.resolve({
        list,
        analytics: makeBranchAnalytics({
          canonicalMetrics: makeBranchListMetrics({
            ...siblings,
            totalLocPushed: complete(1000),
            pushedLocPerDollar: { current: ratio },
          }),
        }),
      }),
  };
}

describe("Branches canonical cost row on the Electron shell (ISS-9957)", () => {
  // ISS-10636 AC-5: no flag seeded. A signed-out desktop account resolves every
  // PostHog key `false` by construction, so this is the only state that was ever
  // reachable there — and the state the retired gate made unreachable.
  it("renders the canonical row, with no spend card, with no flag seeded", async () => {
    const { container } = renderView(
      canonicalRowSource(COMPLETE_RATIO),
      undefined,
      []
    );

    // Wait on the VALUE, not the labels: the pending row carries these same
    // five labels over a "—", so settling on labels alone would assert the
    // loading state and pass whatever the resolved bundle turned out to hold.
    await waitFor(() =>
      expect(cardTitleFor(container, "Total LOC pushed")).toContain("1,000")
    );
    expect(cardLabels(container)).toEqual(CANONICAL_ROW);
    expect(container.textContent).not.toContain(
      BRANCH_METRIC_DICTIONARY[BranchMetricId.AiSpend].label
    );
  });

  it("keeps the ratio card when the hide gate takes its unavailable siblings", async () => {
    const { container } = renderView(
      canonicalRowSource(UNAVAILABLE_RATIO, true),
      undefined,
      [METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY]
    );

    // ISS-9958: three siblings are Unavailable and the gate retires them; the
    // ratio is Unavailable too and stays, reporting its own absence.
    await waitFor(() =>
      expect(cardLabels(container)).toEqual(["Total LOC pushed", "LOC per $"])
    );
  });
});
