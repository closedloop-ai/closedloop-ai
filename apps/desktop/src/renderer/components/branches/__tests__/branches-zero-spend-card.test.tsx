import {
  type BranchAnalytics,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { unavailableBranchTraceResult } from "@repo/api/src/types/branch-trace";
import {
  makeBranchAnalytics,
  makeBranchListMetrics,
} from "@repo/app/branches/components/branch-analytics-fixtures";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import { waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderView, wireRow } from "./test-helpers";

// ISS-4737 — the approved Electron surface renders the same canonical AI-spend
// result as web. A producer-classified NoData zero must never become a rendered
// $0, while a Complete positive value must remain visible. jsdom over the real
// `BranchesSummaryCards` is enough because the assertion is on the rendered
// canonical result rather than layout.

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
vi.mock("@repo/app/branches/components/branches-toolbar", () => ({
  BranchesToolbar: () => null,
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

describe("Branches AI-spend card on a zero-sum priced subset (ISS-4737)", () => {
  it("renders the no-data state, never $0, when the visible subset prices to zero", async () => {
    const { container } = renderView(sourceWithSessionCost(0));

    await waitFor(() => expect(spendCardText(container)).toBe("No data"));
    expect(spendCardText(container)).not.toContain("$0");
  });

  it("renders the real total once the same subset prices above zero", async () => {
    const { container } = renderView(sourceWithSessionCost(12));

    await waitFor(() => expect(spendCardText(container)).toBe("$12.00"));
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

/** The rendered value of the AI SPEND card, or null before it paints. */
function spendCardText(container: HTMLElement): string | null {
  const cards = container.querySelectorAll<HTMLElement>('[data-slot="card"]');
  for (const card of cards) {
    const label = card.querySelector('[data-slot="card-description"]');
    if (label?.textContent?.includes("AI spend")) {
      return (
        card.querySelector('[data-slot="card-title"]')?.textContent?.trim() ??
        null
      );
    }
  }
  return null;
}
