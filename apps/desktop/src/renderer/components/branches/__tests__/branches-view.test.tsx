import {
  type BranchAnalytics,
  BranchStatus,
  type BranchUsageSummary,
  BranchViewerScope,
  type BranchRow as WireBranchRow,
} from "@repo/api/src/types/branch";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import type { ApiAdapter } from "@repo/app/shared/api/api-adapter";
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { BranchesView } from "../branches-view";

// Only the table is under test here, so the data-fetching siblings (summary
// cards) and the controlled toolbar are stubbed to markers — their internal
// usage/analytics hooks never run, so the injected source only needs `list`.
// Mirrors the marker-mock style in app-shell.test.tsx.
vi.mock("@repo/app/branches/components/branches-summary-cards", () => ({
  BranchesSummaryCards: () => null,
}));
vi.mock("@repo/app/branches/components/branches-toolbar", () => ({
  BranchesToolbar: () => null,
}));
vi.mock("@repo/app/branches/components/connect-github-indicator", () => ({
  ConnectGitHubIndicator: () => null,
}));
vi.mock("@repo/app/branches/data-source/branches-live-bridge", () => ({
  BranchesLiveBridge: () => null,
}));

// The renderer jsdom env has no localStorage, so the real hook's saved-view
// seeding is a no-op — mock the hook to a deterministic view state.
vi.mock("@repo/app/branches/hooks/use-branch-view-state", () => ({
  useBranchViewState: () => ({
    sortKey: "updated",
    sortDir: "desc",
    // "all" so the fixed-date fixture row isn't filtered by the client-side time
    // window (this test asserts row → detail links, not windowing).
    dateRange: "all",
    visibleColumns: new Set([
      "repo",
      "owner",
      "status",
      "updated",
      "sessions",
      "changes",
      "behindAhead",
      "pr",
      "checks",
    ]),
    setSort: vi.fn(),
    toggleSortDir: vi.fn(),
    setDateRange: vi.fn(),
    toggleColumn: vi.fn(),
  }),
}));

// A link wrapping the Name lead resolves to #/branches/:id; the prefix is
// enough to assert "this row routes into the detail page" regardless of how the
// composite id is encoded.
const BRANCH_DETAIL_LINK_SELECTOR = 'a[href^="#/branches/"]';

const inertApiAdapter: ApiAdapter = {
  resolveApiOrigin: () => "http://test.local",
  fetch: () => Promise.reject(new Error("no remote REST API in tests")),
};

const wireRow: WireBranchRow = {
  id: "owner%2Frepo::feature",
  branchName: "feature/x",
  baseBranch: "main",
  repoFullName: "owner/repo",
  owner: "alice",
  status: BranchStatus.Open,
  prNumber: 42,
  prTitle: "Add x",
  prState: "OPEN",
  prUrl: "https://github.com/owner/repo/pull/42",
  multiPrWarning: false,
  checksStatus: null,
  checksPassed: null,
  checksTotal: null,
  reviewDecision: null,
  ahead: null,
  behind: null,
  additions: null,
  deletions: null,
  filesChanged: null,
  estimatedCostUsd: null,
  lastActivityAt: "2026-06-17T12:00:00.000Z",
  sessionIds: ["s1"],
};

// `usage`/`analytics` are never reached (their consumers are mocked out), so
// they stay pending rather than carrying throwaway fixtures.
const dataSource: BranchesDataSource = {
  scope: "local",
  list: () =>
    Promise.resolve({
      items: [wireRow],
      total: 1,
      viewerScope: BranchViewerScope.Self,
    }),
  detail: () => new Promise<never>(() => undefined),
  usage: () => new Promise<BranchUsageSummary>(() => undefined),
  analytics: () => new Promise<BranchAnalytics>(() => undefined),
};

function renderView() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const flagAdapter = createStaticFeatureFlagAdapter({ enabledFlags: [] });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
        <ApiAdapterProvider adapter={inertApiAdapter}>
          <FeatureFlagAdapterProvider adapter={flagAdapter}>
            <BranchesView dataSource={dataSource} />
          </FeatureFlagAdapterProvider>
        </ApiAdapterProvider>
      </AuthAdapterProvider>
    </QueryClientProvider>
  );
}

beforeAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

describe("BranchesView row → detail links", () => {
  it("links rows into the detail route", async () => {
    const { container } = renderView();

    expect(await screen.findByText("feature/x")).toBeDefined();
    await waitFor(() =>
      expect(
        container.querySelector(BRANCH_DETAIL_LINK_SELECTOR)
      ).not.toBeNull()
    );
  });
});
