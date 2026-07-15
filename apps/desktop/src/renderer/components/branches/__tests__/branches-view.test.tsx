import {
  type BranchAnalytics,
  BranchCloudHydrationStatus,
  type BranchUsageSummary,
  BranchViewerScope,
  type BranchRow as WireBranchRow,
} from "@repo/api/src/types/branch";
import { ChecksStatus } from "@repo/api/src/types/branch-checks";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderView, wireRow } from "./test-helpers";

const {
  beginSignInMock,
  openGitHubConnectMock,
  useDesktopAuthMock,
  summaryCardsPropsMock,
} = vi.hoisted(() => ({
  beginSignInMock: vi.fn(),
  openGitHubConnectMock: vi.fn(),
  useDesktopAuthMock: vi.fn(),
  summaryCardsPropsMock: vi.fn(),
}));

// Only the table is under test here, so the data-fetching siblings (summary
// cards) and the controlled toolbar are stubbed to markers — their internal
// usage/analytics hooks never run, so the injected source only needs `list`.
// Mirrors the marker-mock style in app-shell.test.tsx. The summary-cards marker
// records its props so we can assert the view wires the GitHub-connect handler
// into the gated KPI cards (FEA-3273).
vi.mock("@repo/app/branches/components/branches-summary-cards", () => ({
  BranchesSummaryCards: (props: {
    onConnectGitHub?: () => void | Promise<void>;
  }) => {
    summaryCardsPropsMock(props);
    return null;
  },
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

// The shared date-range hook reads localStorage (unavailable in jsdom) and
// defaults to "90d". Mock to "all" so the fixed-date fixture row isn't filtered
// by the client-side time window (this test asserts row → detail links, not
// windowing).
vi.mock("@repo/app/shared/hooks/use-shared-date-range", () => ({
  useSharedDateRange: () => ({
    dateRange: "all",
    setDateRange: vi.fn(),
  }),
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
const CONNECT_GITHUB_BUTTON_NAME_PATTERN = /connect github/i;
const CONNECT_OPENED_MESSAGE_PATTERN = /continue in the browser/i;
const CONNECT_FAILED_MESSAGE_PATTERN = /local branch data remains available/i;
const CLOUD_REFRESH_FAILED_MESSAGE_PATTERN = /github cloud refresh failed/i;

const disconnectedWireRow: WireBranchRow = {
  ...wireRow,
  id: "unknown::feature",
  repoFullName: null,
  prNumber: null,
  prTitle: null,
  prState: null,
  prUrl: null,
};

let listItems: WireBranchRow[] = [wireRow];
const listMock = vi.fn();

// `usage`/`analytics` are never reached (their consumers are mocked out), so
// they stay pending rather than carrying throwaway fixtures.
const dataSource: BranchesDataSource = {
  scope: "local",
  list: listMock,
  detail: () => new Promise<never>(() => undefined),
  comments: () => new Promise<never>(() => undefined),
  trace: () => Promise.resolve([]),
  usage: () => new Promise<BranchUsageSummary>(() => undefined),
  analytics: () => new Promise<BranchAnalytics>(() => undefined),
};

beforeAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

type BranchQueryFreshnessOptions = {
  refetchOnWindowFocus?: unknown;
  staleTime?: unknown;
};

beforeEach(() => {
  vi.clearAllMocks();
  listItems = [wireRow];
  listMock.mockImplementation(() =>
    Promise.resolve({
      items: listItems,
      total: listItems.length,
      viewerScope: BranchViewerScope.Self,
    })
  );
  beginSignInMock.mockResolvedValue({ ok: true });
  openGitHubConnectMock.mockResolvedValue({
    ok: true,
    url: "http://localhost:3000/api/integrations/github?returnTo=%2Fbranches",
  });
  useDesktopAuthMock.mockReturnValue({
    state: {
      status: "authenticated",
      userId: "user-1",
      organizationId: "org-1",
    },
    beginSignIn: beginSignInMock,
  });
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { openGitHubConnect: openGitHubConnectMock },
  });
});

describe("BranchesView row → detail links", () => {
  it("links rows into the detail route", async () => {
    const { container } = renderView(dataSource);

    expect(await screen.findByText("feature/x")).toBeDefined();
    await waitFor(() =>
      expect(
        container.querySelector(BRANCH_DETAIL_LINK_SELECTOR)
      ).not.toBeNull()
    );
  });

  it("overrides desktop ambient staleTime so focus can recheck cloud hydration", async () => {
    const { queryClient } = renderView(dataSource);

    expect(await screen.findByText("feature/x")).toBeDefined();

    const query = queryClient
      .getQueryCache()
      .findAll({ queryKey: ["branches", "list"] })
      .find((candidate) => candidate.queryKey.length > 2);
    const options = query?.options as BranchQueryFreshnessOptions | undefined;
    expect(options?.staleTime).toBe(90_000);
    expect(options?.refetchOnWindowFocus).toBe(true);
  });

  it("renders cloud-hydrated checks in the visible branches list", async () => {
    listItems = [
      {
        ...wireRow,
        checksPassed: 2,
        checksTotal: 3,
        checksStatus: ChecksStatus.Failing,
      },
    ];

    renderView(dataSource);

    expect(await screen.findByText("2/3 passing")).toBeDefined();
  });

  it("surfaces failed desktop cloud hydration while keeping local rows visible", async () => {
    listItems = [
      {
        ...wireRow,
        cloudHydrationStatus: BranchCloudHydrationStatus.Failed,
        cloudHydrationFailure: "cloud_pull_failed",
      },
    ];

    renderView(dataSource);

    expect(
      await screen.findByText(CLOUD_REFRESH_FAILED_MESSAGE_PATTERN)
    ).toBeDefined();
    expect(await screen.findByText("feature/x")).toBeDefined();
  });

  it("opens GitHub connect from the disconnected branches state", async () => {
    listItems = [disconnectedWireRow];
    renderView(dataSource);

    fireEvent.click(
      await screen.findByRole("button", {
        name: CONNECT_GITHUB_BUTTON_NAME_PATTERN,
      })
    );

    await waitFor(() =>
      expect(openGitHubConnectMock).toHaveBeenCalledWith({
        returnTo: "/branches",
      })
    );
    expect(screen.getByText(CONNECT_OPENED_MESSAGE_PATTERN)).toBeDefined();
  });

  it("wires the summary-card gated connect CTA to the same desktop GitHub connect flow (FEA-3273)", async () => {
    renderView(dataSource);
    await screen.findByText("feature/x");

    // The view threads its shared connect handler into the KPI summary cards, so
    // a gated card's "Connect GitHub" CTA runs the same sign-in → openGitHubConnect
    // flow as the standalone banner rather than doing nothing.
    const props = summaryCardsPropsMock.mock.calls.at(-1)?.[0] as
      | { onConnectGitHub?: () => void | Promise<void> }
      | undefined;
    expect(props?.onConnectGitHub).toBeTypeOf("function");

    await props?.onConnectGitHub?.();
    await waitFor(() =>
      expect(openGitHubConnectMock).toHaveBeenCalledWith({
        returnTo: "/branches",
      })
    );
  });

  it("routes signed-out users through desktop sign-in before connect", async () => {
    listItems = [disconnectedWireRow];
    useDesktopAuthMock.mockReturnValue({
      state: { status: "signed_out", userId: null, organizationId: null },
      beginSignIn: beginSignInMock,
    });
    renderView(dataSource);

    fireEvent.click(
      await screen.findByRole("button", {
        name: CONNECT_GITHUB_BUTTON_NAME_PATTERN,
      })
    );

    await waitFor(() => expect(beginSignInMock).toHaveBeenCalledTimes(1));
    expect(openGitHubConnectMock).toHaveBeenCalledWith({
      returnTo: "/branches",
    });
  });

  it("shows local fallback when GitHub connect cannot open", async () => {
    listItems = [disconnectedWireRow];
    openGitHubConnectMock.mockResolvedValue({
      ok: false,
      reason: "open_failed",
    });
    renderView(dataSource);

    fireEvent.click(
      await screen.findByRole("button", {
        name: CONNECT_GITHUB_BUTTON_NAME_PATTERN,
      })
    );

    expect(
      await screen.findByText(CONNECT_FAILED_MESSAGE_PATTERN)
    ).toBeDefined();
  });

  it("shows local fallback when GitHub connect IPC rejects (FEA-2782)", async () => {
    // A rejected (not resolved-false) IPC call must still flip to the Failed
    // banner instead of leaking an unhandled rejection and pinning Pending.
    listItems = [disconnectedWireRow];
    openGitHubConnectMock.mockRejectedValue(new Error("ipc channel closed"));
    renderView(dataSource);

    fireEvent.click(
      await screen.findByRole("button", {
        name: CONNECT_GITHUB_BUTTON_NAME_PATTERN,
      })
    );

    expect(
      await screen.findByText(CONNECT_FAILED_MESSAGE_PATTERN)
    ).toBeDefined();
  });
});
