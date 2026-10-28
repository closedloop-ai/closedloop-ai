/**
 * ISS-11274: the Branches list carries no standalone connect-GitHub affordance.
 * The summary strip's per-card ask came later (ISS-12638) and is pinned by
 * approved-branches-summary-cards-github-ask.test.tsx.
 * The approved design places none on this screen — connecting GitHub is owned by
 * the dashboard card, Settings → Integrations, and the onboarding checklist. The
 * click-through, sign-in-first ordering and failure copy that used to be pinned
 * here belonged to that retired control; the HOOK behind it is still covered by
 * use-desktop-github-connect.test.tsx and the rendered connect flow by
 * dashboard-connect-cta.test.tsx.
 *
 * Split out of branches-view.test.tsx to keep that file under the repo's
 * 1000-line ceiling. The scaffold below — mocks, `dataSource`, and
 * `beforeEach` — is a deliberate duplicate of the parent file's, not a
 * trimmed-down guess, so these assertions keep running under the exact
 * render environment they already passed under.
 */

import {
  type BranchAnalytics,
  type BranchUsageSummary,
  BranchViewerScope,
  type BranchRow as WireBranchRow,
} from "@repo/api/src/types/branch";
import { unavailableBranchTraceResult } from "@repo/api/src/types/branch-trace";
import {
  makeBranchAnalytics,
  makeBranchListMetrics,
} from "@repo/app/branches/components/branch-analytics-fixtures";
import { ConnectGitHubIndicator } from "@repo/app/branches/components/connect-github-indicator";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import { GitHubConnectAction } from "@repo/app/github/lib/github-connect-action";
import { GITHUB_CONNECT_COPY } from "@repo/app/github/lib/github-connect-copy";
import { GatedMetricIndicatorVariant } from "@repo/app/shared/components/gated-metric-indicator";
import { render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { renderView, wireRow } from "./test-helpers";

const {
  beginSignInMock,
  openGitHubConnectMock,
  useDesktopAuthMock,
  summaryCardsPropsMock,
  applyArrangementMock,
  setSharedDateRangeMock,
  savedViewsApplyMock,
  savedViewsPropMock,
  cohortAnalyticsMock,
  useSharedDateRangeMock,
} = vi.hoisted(() => ({
  beginSignInMock: vi.fn(),
  openGitHubConnectMock: vi.fn(),
  useDesktopAuthMock: vi.fn(),
  summaryCardsPropsMock: vi.fn(),
  applyArrangementMock: vi.fn(),
  setSharedDateRangeMock: vi.fn(),
  savedViewsApplyMock: vi.fn(),
  savedViewsPropMock: vi.fn(),
  cohortAnalyticsMock: vi.fn(),
  useSharedDateRangeMock: vi.fn(),
}));

// The connect flow is the only thing under test here, so every other
// data-fetching sibling is stubbed to a marker (mirrors branches-view.test.tsx).
vi.mock("@repo/app/branches/components/branches-summary-cards", () => ({
  BranchesSummaryCards: (props: { approved?: boolean }) => {
    summaryCardsPropsMock(props);
    return null;
  },
}));

// ISS-8909: the v2 list surface is the only Branches arm, and it spreads this
// host's one toolbar prop set into `BranchesListToolbarV2`. The capture moved
// here from the retired v1 `BranchesToolbar`, which no longer renders.
vi.mock(
  "@repo/app/branches/components/branches-list-toolbar-v2",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@repo/app/branches/components/branches-list-toolbar-v2")
    >()),
    BranchesListToolbarV2: (props: { savedViews?: unknown }) => {
      savedViewsPropMock(props.savedViews);
      return null;
    },
  })
);

// Not under test here, but the real hook needs localStorage (unavailable in
// jsdom), so it is mocked to a deterministic, already-settled state.
vi.mock("@repo/app/branches/hooks/use-branch-saved-views", () => ({
  // The view now restores the collection one hook earlier so the read gate can
  // see it (ISS-9447 review).
  useBranchSavedViewsStore: () => ({ isArrangementSettled: true }),
  useBranchSavedViews: (
    _store: unknown,
    _snapshot: unknown,
    apply: {
      applyArrangement: (a: {
        sortKey: string;
        sortDir: string;
        dateRange: string;
        hiddenColumns: string[];
        columnOrder: string[];
      }) => void;
      applyFilters: (f: unknown) => void;
    }
  ) => {
    savedViewsApplyMock(apply);
    return {
      views: [],
      activeViewId: null,
      modified: false,
      isArrangementSettled: true,
      onSelectView: vi.fn(),
      onCreateView: vi.fn(),
      onUpdateView: vi.fn(),
      onRenameView: vi.fn(),
      onDeleteView: vi.fn(),
    };
  },
}));
vi.mock("@repo/app/branches/data-source/branches-live-bridge", () => ({
  BranchesLiveBridge: () => null,
}));
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: useDesktopAuthMock,
}));

// The shared date-range hook reads localStorage (unavailable in jsdom) and
// defaults to DEFAULT_DATE_RANGE ("7d"). Mock to "all" so the fixed-date
// fixture row isn't filtered out of the disconnected-row connect flow this
// suite exercises.
vi.mock("@repo/app/shared/hooks/use-shared-date-range", () => ({
  useSharedDateRange: useSharedDateRangeMock,
}));

// The renderer jsdom env has no localStorage, so the real hook's saved-view
// seeding is a no-op — mock the hook to a deterministic view state.
vi.mock(
  "@repo/app/branches/hooks/use-branch-view-state",
  async (importOriginal) => ({
    // ISS-8909: the v2 list surface is the only Branches arm now, and its
    // toolbar reads more of this module than the v1 one did. Stand down only
    // the hook these cases pin; a bare factory drops the rest.
    ...(await importOriginal<
      typeof import("@repo/app/branches/hooks/use-branch-view-state")
    >()),
    useBranchViewState: (_persistKey: string, approved = false) => ({
      isViewReady: true,
      sortKey: "updated",
      sortDir: "desc",
      dateRange: "all",
      visibleColumns: new Set(
        approved
          ? [
              "owner",
              "collaborators",
              "sessions",
              "changes",
              "status",
              "pr",
              "lastActivity",
              "repo",
              "tags",
            ]
          : [
              "repo",
              "owner",
              "status",
              "updated",
              "sessions",
              "changes",
              "behindAhead",
              "pr",
              "checks",
            ]
      ),
      columnOrder: approved
        ? ["status", "owner", "sessions"]
        : ["repo", "owner", "status", "lastActivity", "sessions", "changes"],
      setColumnOrder: vi.fn(),
      setSort: vi.fn(),
      toggleSortDir: vi.fn(),
      setDateRange: vi.fn(),
      toggleColumn: vi.fn(),
      resetColumns: vi.fn(),
      resetView: vi.fn(),
      applyArrangement: applyArrangementMock,
    }),
  })
);

// The real control's accessible name. The first case below renders
// `ConnectGitHubIndicator` on its own through this exact pattern, so the absence
// assertion in the second cannot pass on a locator that matches nothing.
const CONNECT_GITHUB_BUTTON_NAME_PATTERN = /connect (?:to )?github/i;
/**
 * The sentence the retired Branches connect ask carried (`variant: Notice`,
 * metric scope). Asserted ALONGSIDE the control's accessible name because the
 * control renders as a button on desktop (`onConnect`), a link on web
 * (`actionHref`), and as neither when the host resolves no target — so a
 * button-only absence check would pass on a rendered informational ask.
 */
const CONNECT_EXPLANATION =
  GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].gatedMetricExplanation;

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
let sessionCostUsd: Record<string, number> | undefined;
const listMock = vi.fn();

const dataSource: BranchesDataSource = {
  scope: "local",
  list: listMock,
  detail: () => new Promise<never>(() => undefined),
  comments: () => new Promise<never>(() => undefined),
  trace: () => Promise.resolve(unavailableBranchTraceResult()),
  usage: () => new Promise<BranchUsageSummary>(() => undefined),
  analytics: () => new Promise<BranchAnalytics>(() => undefined),
  cohortAnalytics: cohortAnalyticsMock,
  pageData: async (filters) => ({
    list: await listMock(filters),
    analytics: makeBranchAnalytics(),
  }),
};

beforeAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

let desktopApiDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  useSharedDateRangeMock.mockReturnValue({
    dateRange: "all",
    setDateRange: setSharedDateRangeMock,
  });
  listItems = [wireRow];
  sessionCostUsd = undefined;
  listMock.mockImplementation(() =>
    Promise.resolve({
      items: listItems,
      total: listItems.length,
      viewerScope: BranchViewerScope.Self,
      ...(sessionCostUsd ? { sessionCostUsd } : {}),
    })
  );
  cohortAnalyticsMock.mockImplementation(async (request) => ({
    matchedBranchIds: request.branchIds,
    canonicalMetrics: makeBranchListMetrics({
      cohortSize: request.branchIds.length,
    }),
  }));
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
  desktopApiDescriptor = Object.getOwnPropertyDescriptor(window, "desktopApi");
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { openGitHubConnect: openGitHubConnectMock },
  });
});

afterEach(() => {
  if (desktopApiDescriptor) {
    Object.defineProperty(window, "desktopApi", desktopApiDescriptor);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("BranchesView GitHub connect affordance (ISS-11274)", () => {
  it("resolves the shipped connect control through these locators", () => {
    render(
      <ConnectGitHubIndicator
        connect={{
          action: GitHubConnectAction.Connect,
          onConnect: () => undefined,
        }}
        variant={GatedMetricIndicatorVariant.Centered}
      />
    );

    expect(screen.getByText(CONNECT_EXPLANATION)).toBeDefined();
    expect(
      screen.getByRole("button", { name: CONNECT_GITHUB_BUTTON_NAME_PATTERN })
    ).toBeDefined();
  });

  it("offers no connect-GitHub control for a corpus with no repo identity", async () => {
    // The exact corpus that used to raise the banner: no row names a repository,
    // so the retired resolver answered "connect-github". The approved Branches
    // design places no connect control on this screen, so the list renders
    // without one and never opens the desktop connect handoff.
    listItems = [disconnectedWireRow];
    renderView(dataSource);

    // The surface itself rendered — without this the absence checks below could
    // pass on a list that never painted.
    expect(
      await screen.findByRole("region", { name: "Branches" })
    ).toBeDefined();

    expect(screen.queryByText(CONNECT_EXPLANATION)).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: CONNECT_GITHUB_BUTTON_NAME_PATTERN,
      })
    ).toBeNull();
    expect(
      screen.queryByRole("link", { name: CONNECT_GITHUB_BUTTON_NAME_PATTERN })
    ).toBeNull();
    expect(openGitHubConnectMock).not.toHaveBeenCalled();
  });
});
