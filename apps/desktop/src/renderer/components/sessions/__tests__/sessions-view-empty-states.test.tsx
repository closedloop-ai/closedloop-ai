import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../../shared/local-session-source-status";
import { drainedCutover } from "../../../shared-agent-sessions/__tests__/fixtures/cloud-read-cutover-fixtures";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import { SessionsView } from "../SessionsView";

/**
 * ISS-4494: reinforcement coverage for the desktop Sessions list's DISTINCT
 * zero-row surfaces and its stale-page repair. SessionsView folds its list read
 * + display state into `buildSessionsRenderModel`, `deriveSessionsAvailability`,
 * and the honest-empty signal set it passes down to the shared list content —
 * this suite captures the props SessionsView derives and passes to
 * `AgentSessionsListContent` so a regression that (a) marks a failed read as
 * available (a false "no sessions" all-clear), (b) drops the active-filters
 * signal on a filtered-away scope (so the user loses the Clear-filters fix), or
 * (c) flags a genuinely-empty ready read as unavailable/filtered, fails here. The
 * three-reason RENDER of these signals is already locked in the shared
 * `agent-sessions-list.test.tsx` / `sessions-empty-state` suites; here we lock
 * SessionsView's DERIVATION of them plus its Retry/Clear-filters wiring.
 *
 * It also locks the bookmarked-out-of-range page repair: a settled response with
 * a smaller total than the requested page must clamp the page (write the
 * corrected `?page=` param), never leave the user on a blank page.
 *
 * Cloud mode is used purely to collapse `displayState` to "ready" so the cloud
 * query's own isLoading/isError/data drive the table (matching the sibling
 * sessions-view-* suites); the local-monitor axis is covered elsewhere.
 */

type CapturedListProps = {
  isUnavailable: boolean;
  hasActiveFilters: boolean;
  isLoading: boolean;
  isSyncing: boolean;
  itemCount: number;
  onRetry: () => void;
  onClearFilters: () => void;
};

const captured: { props: CapturedListProps | null } = { props: null };

// Also capture the props SessionsView folds into the always-available summary
// bar, so the SessionsView-side fold that turns a resolved-but-usage-failed read
// (`pageData.usageError === true`, no `usage`) into the cards' `isError` is
// locked at the call site — not just in the `resolveSummaryCardsErrored` helper's
// isolated unit test (wongk, thread cid 3680316494). A regression that dropped
// this wiring would leave the helper test green while the bar renders false
// zeroes on a usage-only failure.
type CapturedSummaryProps = {
  isError: boolean;
  isLoading: boolean;
};

const capturedSummary: { props: CapturedSummaryProps | null } = {
  props: null,
};

const hooks = vi.hoisted(() => ({
  useAgentSessionAnalytics: vi.fn(),
  useAgentSessionsPageData: vi.fn(),
  useAgentSessionUsage: vi.fn(),
  useLocalAgentSessionUsage: vi.fn(),
  useIngestProgress: vi.fn(),
  useSessionsViewState: vi.fn(),
  useSharedDateRange: vi.fn(),
  useSearchParamsValue: vi.fn(),
}));

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));

// A single capturable date-window setter so the Clear-filters tests can assert
// the callback actually resets the window to DEFAULT_DATE_RANGE (not just that
// the filtered signal was derived). Shared across every useSharedDateRange
// return value below; cleared in beforeEach with the rest of the mocks.
const setDateRange = vi.hoisted(() => vi.fn());

let desktopApiDescriptor: PropertyDescriptor | undefined;

// Capture the props SessionsView derives and passes to the shared list content
// (through SessionsTableBody). Rendering the real content would pull in the
// row-level `Link` (needs a NavigationProvider) and the shared empty-state
// render is already covered by agent-sessions-list.test.tsx — here we assert the
// DERIVED signals SessionsView feeds it.
vi.mock("@repo/app/agents/components/sessions/agent-sessions-list", () => ({
  AgentSessionsListContent: (props: {
    emptySignals?: { isUnavailable: boolean; hasActiveFilters: boolean };
    isLoading: boolean;
    isSyncing?: boolean;
    items: { id: string }[];
    onRetry?: () => void;
    onClearFilters?: () => void;
  }) => {
    captured.props = {
      isUnavailable: props.emptySignals?.isUnavailable ?? false,
      hasActiveFilters: props.emptySignals?.hasActiveFilters ?? false,
      isLoading: props.isLoading,
      isSyncing: props.isSyncing ?? false,
      itemCount: props.items.length,
      onRetry: props.onRetry ?? (() => undefined),
      onClearFilters: props.onClearFilters ?? (() => undefined),
    };
    return <div data-testid="sessions-table-body" />;
  },
}));

vi.mock("@repo/app/agents/components/sessions/sessions-summary-cards", () => ({
  SessionsSummaryCards: (props: { isError: boolean; isLoading: boolean }) => {
    capturedSummary.props = {
      isError: props.isError,
      isLoading: props.isLoading,
    };
    return <div data-testid="sessions-summary-cards" />;
  },
}));

vi.mock("@repo/app/agents/components/sessions/sessions-toolbar", () => ({
  SessionsToolbar: () => <div data-testid="sessions-toolbar" />,
}));

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessionAnalytics: hooks.useAgentSessionAnalytics,
  useAgentSessionsPageData: hooks.useAgentSessionsPageData,
  useAgentSessionUsage: hooks.useAgentSessionUsage,
}));

vi.mock("../use-local-agent-session-usage", () => ({
  useLocalAgentSessionUsage: hooks.useLocalAgentSessionUsage,
}));

vi.mock("../../../hooks/use-ingest-progress", () => ({
  useIngestProgress: hooks.useIngestProgress,
  useFileAccessBlocks: () => [],
}));

vi.mock("@repo/app/agents/hooks/use-has-connected-agent", () => ({
  useHasConnectedAgent: () => ({ data: undefined }),
}));

vi.mock("@repo/app/agents/hooks/use-sessions-view-state", () => ({
  useSessionsViewState: hooks.useSessionsViewState,
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => false,
  // ISS-4890/4906/4901 + ISS-4887: the shared table and summary strip read
  // their gates OPTIONALLY, so this module mock must expose both hooks or the
  // whole subtree throws on the missing export. Both resolve OFF here, which
  // is the flag default and the behavior these tests assert.
  useFeatureFlagEnabledOptional: () => false,
}));

vi.mock("@repo/app/shared/hooks/use-shared-date-range", () => ({
  useSharedDateRange: hooks.useSharedDateRange,
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => navigation,
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => "/sessions",
}));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: hooks.useSearchParamsValue,
}));

vi.mock("../agent-coaching-tips", () => ({
  AgentCoachingTips: () => <div data-testid="agent-coaching-tips" />,
}));

vi.mock("../../../shared-agent-sessions/desktop-app-core-provider", () => ({
  useDesktopAppCoreMode: () => DesktopAppCoreMode.Cloud,
  // ISS-5477: SessionsView derives the read-source badge detail from the
  // same provider, so this factory has to answer for it too.
  useDesktopCloudReadCutover: () => drainedCutover(),
}));

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: { status: DesktopAuthStatus.Authenticated },
    beginSignIn: vi.fn().mockResolvedValue({ ok: true }),
    cancelSignIn: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
  }),
}));

const EMPTY_USAGE = {
  totalSessions: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  earliestSessionAt: null,
  latestSessionAt: null,
  byRepository: [],
};

/** A settled combined page read that resolved to zero rows for `total` rows. */
function emptyListPageData(total: number) {
  return {
    data: {
      list: { items: [], total, readSource: undefined },
      usage: EMPTY_USAGE,
    },
    isFetching: false,
    isPlaceholderData: false,
    isLoading: false,
    isError: false,
    refetch: vi.fn().mockResolvedValue(undefined),
  };
}

describe("SessionsView zero-row surfaces + stale-page repair (ISS-4494)", () => {
  let refetch: ReturnType<typeof vi.fn>;
  let getAgentMonitorUrl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    desktopApiDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "desktopApi"
    );
    vi.clearAllMocks();
    captured.props = null;
    capturedSummary.props = null;
    refetch = vi.fn().mockResolvedValue(undefined);
    // Default: the desktop default window (DEFAULT_DATE_RANGE), no search, no
    // facets → NO active filters. Desktop's honest-empty split measures against
    // DEFAULT_DATE_RANGE, so referencing it here keeps the "no filters" baseline
    // correct if the default ever changes.
    hooks.useSharedDateRange.mockReturnValue({
      dateRange: DEFAULT_DATE_RANGE,
      setDateRange,
    });
    hooks.useSearchParamsValue.mockReturnValue(new URLSearchParams());
    hooks.useSessionsViewState.mockReturnValue({
      sortKey: null,
      sortDir: "desc",
      visibleColumns: new Set<string>(["name"]),
      columnOrder: undefined,
      setColumnOrder: vi.fn(),
      setSort: vi.fn(),
      toggleColumn: vi.fn(),
      resetView: vi.fn(),
    });
    hooks.useAgentSessionsPageData.mockReturnValue({
      ...emptyListPageData(0),
      refetch,
    });
    hooks.useAgentSessionUsage.mockReturnValue({
      data: EMPTY_USAGE,
      isFetching: false,
      isPlaceholderData: false,
      isError: false,
    });
    hooks.useAgentSessionAnalytics.mockReturnValue({
      data: { byRepository: [] },
    });
    hooks.useLocalAgentSessionUsage.mockReturnValue({
      data: EMPTY_USAGE,
      isError: false,
    });
    hooks.useIngestProgress.mockReturnValue(null);
    getAgentMonitorUrl = vi.fn().mockResolvedValue({
      localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.ready,
    });
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        getAgentMonitorUrl,
        onDbChanged: vi.fn(() => undefined),
      },
    });
  });

  afterEach(() => {
    cleanup();
    if (desktopApiDescriptor) {
      Object.defineProperty(window, "desktopApi", desktopApiDescriptor);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
    desktopApiDescriptor = undefined;
  });

  it("derives a genuinely-empty signal set (available, no active filters) for a ready zero-row read", async () => {
    render(<SessionsView />);

    await waitFor(() =>
      expect(screen.getByTestId("sessions-table-body")).toBeTruthy()
    );
    // Neither unavailable (a real read succeeded) nor filtered (no filter is
    // narrowing) → the honest empty state resolves to the genuine onboarding
    // "nothing yet", never a false error or a filtered message.
    expect(captured.props?.isUnavailable).toBe(false);
    expect(captured.props?.hasActiveFilters).toBe(false);
    expect(captured.props?.isLoading).toBe(false);
    expect(captured.props?.itemCount).toBe(0);
  });

  it("derives an active-filters signal when a non-default window narrows the scope to zero rows", async () => {
    // A non-default date window is an active filter, so a zero-row result is
    // Filtered (Clear-filters offered), not genuinely Empty.
    hooks.useSharedDateRange.mockReturnValue({
      dateRange: "30d",
      setDateRange,
    });
    render(<SessionsView />);

    await waitFor(() =>
      expect(screen.getByTestId("sessions-table-body")).toBeTruthy()
    );
    expect(captured.props?.hasActiveFilters).toBe(true);
    expect(captured.props?.isUnavailable).toBe(false);

    // Lock the Clear-filters wiring itself, not just the derived signal: invoking
    // the captured callback must reset the date window back to DEFAULT_DATE_RANGE.
    // Without this the suite would still pass if SessionsView dropped
    // `onClearFilters`, because the capture mock substitutes a no-op for a missing
    // callback.
    captured.props?.onClearFilters();
    expect(setDateRange).toHaveBeenCalledWith(DEFAULT_DATE_RANGE);
  });

  it("derives an active-filters signal when a search term narrows the scope to zero rows", async () => {
    // The URL-owned `?search=` term is one of the three narrowers (window /
    // facet / search) that flip the empty reason from genuine to filtered.
    hooks.useSearchParamsValue.mockReturnValue(
      new URLSearchParams("search=widget")
    );
    render(<SessionsView />);

    await waitFor(() =>
      expect(screen.getByTestId("sessions-table-body")).toBeTruthy()
    );
    expect(captured.props?.hasActiveFilters).toBe(true);

    // Invoking Clear-filters must strip the URL-owned `?search=` narrower (the
    // facet writer doesn't manage it, so a regression that dropped it would leave
    // the empty search re-running). Assert the URL SessionsView replaces to no
    // longer carries the search term — proving the callback runs and resets the
    // scope, not just that the filtered signal was derived.
    captured.props?.onClearFilters();
    await waitFor(() => expect(navigation.replace).toHaveBeenCalled());
    const replacedUrl = navigation.replace.mock.calls.at(-1)?.[0] as string;
    expect(replacedUrl).not.toContain("search");
    expect(setDateRange).toHaveBeenCalledWith(DEFAULT_DATE_RANGE);
  });

  it("marks the list unavailable (not a false all-clear) when the read errors with no rows, and Retry re-runs it", async () => {
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: undefined,
      isFetching: false,
      isPlaceholderData: false,
      isLoading: false,
      isError: true,
      refetch,
    });
    render(<SessionsView />);

    await waitFor(() =>
      expect(screen.getByTestId("sessions-table-body")).toBeTruthy()
    );
    // An errored read is the highest-precedence reason: unavailable, and NOT
    // syncing (a real error wins over the still-coming-up holding message).
    expect(captured.props?.isUnavailable).toBe(true);
    expect(captured.props?.isSyncing).toBe(false);

    // Retry re-runs the read — `refetch()` already replaces a wedged in-flight
    // attempt (query-core defaults `cancelRefetch` to true), so no explicit option.
    //
    // It must ALSO re-poll the local source via recheckLocalSource() — an
    // unavailable/wedged local monitor stops polling, so re-running only the query
    // half would leave the source stuck (wongk, thread cid 3680316496). Capture
    // the initial getAgentMonitorUrl count (the mount poll), fire Retry, and
    // assert another call landed. Asserting the delta (not an absolute count)
    // keeps the test robust to the mount effect's own poll cadence.
    const callsBeforeRetry = getAgentMonitorUrl.mock.calls.length;
    captured.props?.onRetry();
    expect(refetch).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(getAgentMonitorUrl.mock.calls.length).toBeGreaterThan(
        callsBeforeRetry
      )
    );
  });

  it("folds a resolved-but-usage-failed read into the summary bar's error state (no false zeroes)", async () => {
    // The list half resolved (rows present, no whole-query error) but the usage
    // half failed — pageData carries usageError:true and no `usage`. SessionsView
    // must fold that into the always-available cards' isError so they dash rather
    // than render false zeroes (wongk, thread cid 3680316494). This locks the
    // SessionsView-side wiring the resolveSummaryCardsErrored helper unit test
    // cannot see; dropping it would leave the helper test green.
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: {
        list: { items: [{ id: "session-1" }], total: 1, readSource: undefined },
        usage: undefined,
        usageError: true,
      },
      isFetching: false,
      isPlaceholderData: false,
      isLoading: false,
      isError: false,
      refetch,
    });
    render(<SessionsView />);

    await waitFor(() =>
      expect(screen.getByTestId("sessions-summary-cards")).toBeTruthy()
    );
    expect(capturedSummary.props?.isError).toBe(true);
    expect(capturedSummary.props?.isLoading).toBe(false);
  });

  it("repairs a bookmarked page on an empty corpus (zero total) back to /sessions", async () => {
    // The empty-corpus branch clampSessionsPage takes when total is zero: a
    // bookmarked ?page=5 with no sessions at all must clamp to page 0 and rewrite
    // the URL to /sessions, never strand the user on a permanently blank page
    // (wongk, thread cid 3680316500). This is the total===0 branch the total===30
    // clamp test above does not exercise.
    hooks.useSearchParamsValue.mockReturnValue(new URLSearchParams("page=5"));
    hooks.useAgentSessionsPageData.mockReturnValue({
      ...emptyListPageData(0),
      refetch,
    });
    render(<SessionsView />);

    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith(
        "/sessions",
        expect.objectContaining({ scroll: false })
      )
    );
  });

  it("repairs a bookmarked out-of-range page by clamping to the last valid page", async () => {
    // Bookmarked page 5 (?page=5 → zero-based index 4) but only 30 rows exist.
    // With PAGE_SIZE 25 that is 2 pages (last index 1 → one-based `?page=2`), so
    // the clamp effect must rewrite the URL to the last valid page.
    hooks.useSearchParamsValue.mockReturnValue(new URLSearchParams("page=5"));
    hooks.useAgentSessionsPageData.mockReturnValue({
      ...emptyListPageData(30),
      refetch,
    });
    render(<SessionsView />);

    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith(
        "/sessions?page=2",
        expect.objectContaining({ scroll: false })
      )
    );
  });

  it("does NOT rewrite the page URL when the requested page is already in range", async () => {
    // Page 2 (index 1) with 60 rows → 3 pages; the requested page is valid, so
    // the repair effect must be a no-op (no navigation.replace churn).
    hooks.useSearchParamsValue.mockReturnValue(new URLSearchParams("page=2"));
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: {
        list: {
          items: [{ id: "session-1" }],
          total: 60,
          readSource: undefined,
        },
        usage: { ...EMPTY_USAGE, totalSessions: 60 },
      },
      isFetching: false,
      isPlaceholderData: false,
      isLoading: false,
      isError: false,
      refetch,
    });
    render(<SessionsView />);

    // Let the local-monitor status effect settle so any errant clamp would fire.
    await waitFor(() =>
      expect(window.desktopApi.getAgentMonitorUrl).toHaveBeenCalled()
    );
    expect(navigation.replace).not.toHaveBeenCalled();
  });
});
