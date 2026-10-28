import { ReadInitiator } from "@repo/api/src/types/read-initiator";
import { ReadSource } from "@repo/api/src/types/read-source";
import { SESSIONS_LIST_LOADING_LABEL } from "@repo/app/agents/components/sessions/sessions-list-loading-labels";
import { SESSIONS_HISTORY_LIST_TEST_ID } from "@repo/app/agents/components/sessions/sessions-list-surface-v2";
import { queryReadInitiator } from "@repo/app/agents/hooks/read-initiator";
import { SESSION_URL_OWNED_WINDOW_PARAMS } from "@repo/app/agents/lib/session-custom-date-window";
import { SessionGroupBy } from "@repo/app/agents/lib/session-grouping";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { QueryClient } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import {
  DeadEndFlowPhase,
  DeadEndFlowReason,
  DeadEndFlowState,
  DeadEndFlowTreatment,
} from "../../../../shared/dead-end-telemetry-contract";
import { DESKTOP_SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY } from "../../../../shared/feature-flags-labs-detail";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../../shared/local-session-source-status";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import { SessionsView } from "../SessionsView";
import { SessionsViewTestProviders } from "./fixtures/sessions-view-render-fixture";

/**
 * ISS-4494: reinforcement coverage for the desktop Sessions list's DISTINCT
 * zero-row surfaces and its stale-page repair. SessionsView folds its list read
 * + display state into `buildSessionsRenderModel`, `deriveSessionsAvailability`,
 * and the honest-empty signal set it hands the shared listing — so a regression
 * that (a) marks a failed read as available (a false "no sessions" all-clear),
 * (b) drops the active-filters signal on a filtered-away scope (so the user
 * loses the Clear-filters fix), or (c) flags a genuinely-empty ready read as
 * unavailable/filtered, fails here.
 *
 * ISS-8909 retired the desktop v1 stack, so the assertions are made against the
 * REAL shared `SessionsListSurfaceV2` this view now always renders: each case
 * asserts the empty-state COPY that surface derives and renders
 * (`sessions-empty-state.tsx`, routed by `renderSessionsListBody`) rather than
 * the derived booleans the retired v1 body took as props. That is the same
 * contract read one layer further out — the honest reason a reader actually
 * sees — and it cannot pass against a surface that renders the wrong one.
 * The Clear-filters and Retry WIRING is still pinned: Clear-filters is driven
 * through the real rendered control, and Retry through the handler the surface
 * is handed (the errored card renders the host's recovery Link in its place —
 * see `SessionsEmptyState` — so there is no Retry button to click).
 *
 * It also locks the bookmarked-out-of-range page repair: a settled response with
 * a smaller total than the requested page must clamp the page (write the
 * corrected `?page=` param), never leave the user on a blank page.
 *
 * Cloud mode is used purely to collapse `displayState` to "ready" so the cloud
 * query's own isLoading/isError/data drive the listing (matching the sibling
 * sessions-view-* suites); the local-monitor axis is covered elsewhere.
 */

/**
 * The props SessionsView hands the shared listing. Captured ALONGSIDE the real
 * render (the spy below renders the genuine surface), so a case can drive a
 * callback the rendered card does not expose without giving up the rendered copy
 * every other assertion here reads.
 */
type CapturedSurfaceProps = {
  isError: boolean;
  isPending: boolean;
  isSyncing: boolean;
  onRetry: (() => void) | undefined;
  rows: readonly { id: string }[];
};

const captured: { surface: CapturedSurfaceProps | null } = { surface: null };

// Also capture the props SessionsView folds into the always-available summary
// bar, so the SessionsView-side fold that turns a resolved-but-usage-failed read
// (`pageData.usageError === true`, no `usage`) into the cards' `isError` is
// locked at the call site — not just in the `resolveSummaryCardsErrored` helper's
// isolated unit test (whitlockk, thread cid 3680316494). A regression that dropped
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
  useFeatureFlagGate: vi.fn(),
  useFeatureFlagGateOptional: vi.fn(),
}));

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));

// A single capturable date-window setter so the Clear-filters tests can assert
// the callback actually resets the window to DEFAULT_DATE_RANGE (not just that
// the filtered signal was derived). Shared across every useSharedDateRange
// return value below; cleared in beforeEach with the rest of the mocks.
const setDateRange = vi.hoisted(() => vi.fn());

let desktopApiDescriptor: PropertyDescriptor | undefined;

// A SPY, not a stub: it records the props SessionsView derives and then renders
// the REAL surface, so every empty-state assertion below reads the copy the
// shared `SessionsEmptyState` actually produces. Stubbing the render out would
// delete exactly what these cases exist to check.
vi.mock(
  "@repo/app/agents/components/sessions/sessions-list-surface-v2",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@repo/app/agents/components/sessions/sessions-list-surface-v2")
      >();
    const OriginalSurface = original.SessionsListSurfaceV2;
    return {
      ...original,
      SessionsListSurfaceV2: (props: Parameters<typeof OriginalSurface>[0]) => {
        captured.surface = {
          isError: props.isError ?? false,
          isPending: props.isPending ?? false,
          isSyncing: props.isSyncing ?? false,
          onRetry: props.onRetry,
          rows: props.rows,
        };
        return <OriginalSurface {...props} />;
      },
    };
  }
);

vi.mock("@repo/app/agents/components/sessions/sessions-summary-cards", () => ({
  SessionsSummaryCards: (props: { isError: boolean; isLoading: boolean }) => {
    capturedSummary.props = {
      isError: props.isError,
      isLoading: props.isLoading,
    };
    return <div data-testid="sessions-summary-cards" />;
  },
}));

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessionAnalytics: hooks.useAgentSessionAnalytics,
  useAgentSessionsPageData: hooks.useAgentSessionsPageData,
  useAgentSessionUsage: hooks.useAgentSessionUsage,
  // ISS-7249: Retry cancels the exact list read before refetching it.
  useCancelAgentSessionsPageData: () => () => undefined,
}));

vi.mock("../use-local-agent-session-usage", () => ({
  useLocalAgentSessionUsage: hooks.useLocalAgentSessionUsage,
}));

vi.mock("../../../hooks/use-ingest-progress", () => ({
  useIngestProgress: hooks.useIngestProgress,
}));

vi.mock("../../../hooks/use-file-access-blocks", () => ({
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
  // FEA-4201: the readiness-carrying read. `isReady` is settled-ness, not
  // enabled-ness, and the real desktop port settles ASYNCHRONOUSLY — the
  // signed-in account's PostHog assignment arrives over the IPC bridge. This
  // mock pins it settled so the suites exercise the resolved state; `enabled`
  // mirrors this suite's own set.
  useFeatureFlagGate: hooks.useFeatureFlagGate,
  // ISS-9692: `useTablePageSizeOptions` reads the ladder gate through the
  // provider-optional port, so this exhaustive module mock owes it an entry
  // too. Same answer as the required gate above.
  useFeatureFlagGateOptional: hooks.useFeatureFlagGateOptional,
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
  useDesktopLocalReadReason: () => undefined,
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
      list: { items: [], total, readSource: ReadSource.Cloud },
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
  let recordDeadEndTelemetry: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    desktopApiDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "desktopApi"
    );
    vi.clearAllMocks();
    captured.surface = null;
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
    hooks.useFeatureFlagGate.mockReturnValue({
      enabled: false,
      isReady: true,
    });
    hooks.useFeatureFlagGateOptional.mockReturnValue({
      enabled: false,
      isReady: true,
    });
    hooks.useSessionsViewState.mockReturnValue({
      isViewReady: true,
      sortKey: null,
      sortDir: "desc",
      secondarySorts: [],
      setSecondarySorts: vi.fn(),
      groupBy: SessionGroupBy.None,
      setGroupBy: vi.fn(),
      hiddenSummaryCards: new Set<string>(),
      toggleSummaryCard: vi.fn(),
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
    // ISS-7249: the real preload sink the dead-end reporter invokes. Without it
    // the reporter's try/catch would swallow the TypeError and the wiring test
    // below would pass against a surface that emits nothing.
    recordDeadEndTelemetry = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        getAgentMonitorUrl,
        onDbChanged: vi.fn(() => undefined),
        recordDeadEndTelemetry,
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
    render(<SessionsView />, {
      wrapper: SessionsViewTestProviders,
    });

    // Neither unavailable (a real read succeeded) nor filtered (no filter is
    // narrowing) → the honest empty state resolves to the genuine onboarding
    // "nothing yet", never a false error or a filtered message. Asserting the
    // rendered reason covers both derived signals at once: either one flipped
    // would render one of the two surfaces excluded below.
    await waitFor(() => expect(screen.getByText(GENUINE_EMPTY)).toBeTruthy());
    expect(screen.queryByText(ERRORED_EMPTY)).toBeNull();
    expect(screen.queryByText(FILTERED_EMPTY)).toBeNull();
    // Settled, not loading: the loading treatment outranks the empty state, so a
    // read still reported as pending could not have rendered it — and the empty
    // state itself only renders at zero rows.
    expect(screen.queryByText(SESSIONS_LIST_LOADING_LABEL)).toBeNull();
    expect(captured.surface?.rows.length).toBe(0);
  });

  // ISS-6382: the restore gate's two failure directions on THIS surface. The
  // read must not go out under the default sort (`sortBy`/`sortDir` are in the
  // query key), and the zero rows it has while held closed must not be reported
  // as a settled empty result — a disabled query reports `isLoading: false`, so
  // the pre-gate derivation would have shown the onboarding "no sessions yet"
  // over an account that has plenty.
  it("holds the read closed and keeps the body loading while the view restores", async () => {
    hooks.useSessionsViewState.mockReturnValue({
      isViewReady: false,
      sortKey: null,
      sortDir: "desc",
      secondarySorts: [],
      setSecondarySorts: vi.fn(),
      groupBy: SessionGroupBy.None,
      setGroupBy: vi.fn(),
      hiddenSummaryCards: new Set<string>(),
      toggleSummaryCard: vi.fn(),
      visibleColumns: new Set<string>(["name"]),
      columnOrder: undefined,
      setColumnOrder: vi.fn(),
      setSort: vi.fn(),
      toggleColumn: vi.fn(),
      resetView: vi.fn(),
    });

    // What a held-closed query actually reports: no data, and `isLoading` FALSE
    // because nothing is in flight. The default fixture above resolves rows
    // regardless of `enabled`, which would hide the very conflation under test.
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: undefined,
      isFetching: false,
      isPlaceholderData: false,
      isLoading: false,
      isError: false,
      refetch,
    });

    const { rerender } = render(<SessionsView />, {
      wrapper: SessionsViewTestProviders,
    });

    await waitFor(() =>
      expect(screen.getByText(SESSIONS_LIST_LOADING_LABEL)).toBeTruthy()
    );
    // Asserted as "no call was ever enabled" AND "there was a call": an empty
    // call list would satisfy the first on its own.
    expect(readGateCalls().length).toBeGreaterThan(0);
    expect(readGateCalls()).not.toContain(true);
    // The zero-row surface is never reached, so no honest-empty variant — the
    // genuine "no sessions yet" onboarding least of all — can be rendered.
    expect(renderedEmptyStateReasons()).toEqual([]);
    expect(capturedSummary.props?.isLoading).toBe(true);

    // POSITIVE CONTROL (whitlockk review). Everything above is an ABSENCE, and an
    // absence proves nothing unless the same probe demonstrably matches when the
    // condition flips: a gate wired `enabled: false` forever — the permanent
    // skeleton `VIEW_RESTORE_AUTH_DEADLINE_MS` exists to prevent — satisfies
    // every assertion above. Open the gate and the read must go out, and the
    // body must leave the loading label for the settled surface.
    hooks.useSessionsViewState.mockReturnValue({
      isViewReady: true,
      sortKey: null,
      sortDir: "desc",
      secondarySorts: [],
      setSecondarySorts: vi.fn(),
      groupBy: SessionGroupBy.None,
      setGroupBy: vi.fn(),
      hiddenSummaryCards: new Set<string>(),
      toggleSummaryCard: vi.fn(),
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
    rerender(<SessionsView />);

    await waitFor(() => expect(screen.getByText(GENUINE_EMPTY)).toBeTruthy());
    expect(readGateCalls().at(-1)).toBe(true);
    expect(screen.queryByText(SESSIONS_LIST_LOADING_LABEL)).toBeNull();
  });

  it("does not turn an unproven no-data read into a settled empty list", async () => {
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: undefined,
      isFetching: false,
      isPlaceholderData: false,
      isLoading: false,
      isError: false,
      isLoadingError: false,
      refetch,
    });

    render(<SessionsView />, {
      wrapper: SessionsViewTestProviders,
    });

    // The pending treatment, which here is the row skeleton rather than the
    // labelled spinner: the view IS ready and the query reports nothing in
    // flight, so no loading copy is derived — but the read has still proven
    // nothing, and the body must hold rather than settle.
    await waitFor(() =>
      expect(screen.getByTestId(SESSIONS_LIST_SKELETON_TEST_ID)).toBeTruthy()
    );
    expect(renderedEmptyStateReasons()).toEqual([]);
  });

  it("keeps a gated cached-error read loading instead of rendering an empty or unavailable list", async () => {
    hooks.useSessionsViewState.mockReturnValue({
      isViewReady: false,
      sortKey: null,
      sortDir: "desc",
      secondarySorts: [],
      setSecondarySorts: vi.fn(),
      groupBy: SessionGroupBy.None,
      setGroupBy: vi.fn(),
      hiddenSummaryCards: new Set<string>(),
      toggleSummaryCard: vi.fn(),
      visibleColumns: new Set<string>(["name"]),
      columnOrder: undefined,
      setColumnOrder: vi.fn(),
      setSort: vi.fn(),
      toggleColumn: vi.fn(),
      resetView: vi.fn(),
    });
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: undefined,
      isFetching: false,
      isPlaceholderData: false,
      isLoading: false,
      isError: true,
      isLoadingError: true,
      refetch,
    });

    render(<SessionsView />, {
      wrapper: SessionsViewTestProviders,
    });

    await waitFor(() =>
      expect(screen.getByText(SESSIONS_LIST_LOADING_LABEL)).toBeTruthy()
    );
    expect(readGateCalls()).not.toContain(true);
    expect(renderedEmptyStateReasons()).toEqual([]);
    expect(capturedSummary.props?.isLoading).toBe(true);
  });

  it("derives an active-filters signal when a non-default window narrows the scope to zero rows", async () => {
    // A non-default date window is an active filter, so a zero-row result is
    // Filtered (Clear-filters offered), not genuinely Empty.
    hooks.useSharedDateRange.mockReturnValue({
      dateRange: "30d",
      setDateRange,
    });
    render(<SessionsView />, {
      wrapper: SessionsViewTestProviders,
    });

    await waitFor(() => expect(screen.getByText(FILTERED_EMPTY)).toBeTruthy());
    // Filtered, and NOT unavailable: a read that succeeded must never render the
    // error card.
    expect(screen.queryByText(ERRORED_EMPTY)).toBeNull();
    expect(screen.queryByText(GENUINE_EMPTY)).toBeNull();

    // Lock the Clear-filters wiring itself, not just the derived signal: pressing
    // the control the filtered card actually offers must reset the date window
    // back to DEFAULT_DATE_RANGE. Without this the suite would still pass if
    // SessionsView stopped resetting the window, because the card would render
    // identically.
    fireEvent.click(clearFiltersControlInEmptyCard());
    expect(setDateRange).toHaveBeenCalledWith(DEFAULT_DATE_RANGE);
  });

  it("derives an active-filters signal when a search term narrows the scope to zero rows", async () => {
    // The URL-owned `?search=` term is one of the three narrowers (window /
    // facet / search) that flip the empty reason from genuine to filtered.
    hooks.useSearchParamsValue.mockReturnValue(
      new URLSearchParams("search=widget")
    );
    render(<SessionsView />, {
      wrapper: SessionsViewTestProviders,
    });

    await waitFor(() => expect(screen.getByText(FILTERED_EMPTY)).toBeTruthy());

    // Pressing Clear filters must strip the URL-owned `?search=` narrower (the
    // facet writer doesn't manage it, so a regression that dropped it would leave
    // the empty search re-running). Assert the URL SessionsView replaces to no
    // longer carry the search term — proving the control runs and resets the
    // scope, not just that the filtered signal was derived.
    fireEvent.click(clearFiltersControlInEmptyCard());
    await waitFor(() => expect(navigation.replace).toHaveBeenCalled());
    const replacedUrl = navigation.replace.mock.calls.at(-1)?.[0] as string;
    expect(replacedUrl).not.toContain("search");
    // The window half of the same reset, read where this scope expresses it: the
    // window was ALREADY the default here, so the reset writes no new range —
    // it strips every URL-owned window param in that one write instead, which is
    // what leaves the reader on DEFAULT_DATE_RANGE. A reset that left one behind
    // would "clear" straight back into a narrowed scope.
    for (const param of SESSION_URL_OWNED_WINDOW_PARAMS) {
      expect(replacedUrl).not.toContain(param);
    }
  });

  it("marks the list unavailable (not a false all-clear) when the read errors with no rows, and Retry re-runs it", async () => {
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: undefined,
      isFetching: false,
      isPlaceholderData: false,
      isLoading: false,
      isError: true,
      // ISS-7528: an INITIAL rejection sets BOTH flags on the real observer
      // (`isLoadingError = isError && no data was ever loaded`), so this
      // hand-set fixture states both. They diverge only on a refetch failure
      // over held data — the case a hand-set fixture cannot represent at all,
      // and which `sessions-view-read-failure-states.test.tsx` drives through a
      // real query instead.
      isLoadingError: true,
      refetch,
    });
    render(<SessionsView />, {
      wrapper: SessionsViewTestProviders,
    });

    // An errored read is the highest-precedence reason: unavailable, and NOT
    // syncing (a real error wins over the still-coming-up holding message), so
    // the card is the destructive one and never the quiet holding surface.
    await waitFor(() => expect(screen.getByText(ERRORED_EMPTY)).toBeTruthy());
    expect(screen.queryByText(SYNCING_EMPTY)).toBeNull();

    // Retry re-runs the read — `refetch()` already replaces a wedged in-flight
    // attempt (query-core defaults `cancelRefetch` to true), so no explicit option.
    //
    // It must ALSO re-poll the local source via recheckLocalSource() — an
    // unavailable/wedged local monitor stops polling, so re-running only the query
    // half would leave the source stuck (whitlockk, thread cid 3680316496). Capture
    // the initial getAgentMonitorUrl count (the mount poll), fire Retry, and
    // assert another call landed. Asserting the delta (not an absolute count)
    // keeps the test robust to the mount effect's own poll cadence.
    //
    // Driven through the handler the surface is handed rather than a rendered
    // button: `SessionsEmptyState` renders the host's recovery Link INSTEAD of
    // Retry whenever one is wired, and this host always wires one, so the errored
    // card has no Retry button to click.
    const callsBeforeRetry = getAgentMonitorUrl.mock.calls.length;
    // ISS-12039: the Retry read is user-initiated even though its key settled.
    const settledKey = { client: settledQueryClient(), queryKey: ["s"] };
    let retryInitiator: string | undefined;
    refetch.mockImplementation(() => {
      retryInitiator = queryReadInitiator(settledKey);
      return Promise.resolve(undefined);
    });
    captured.surface?.onRetry?.();
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(retryInitiator).toBe(ReadInitiator.User);
    expect(queryReadInitiator(settledKey)).toBe(ReadInitiator.Background);
    await waitFor(() =>
      expect(getAgentMonitorUrl.mock.calls.length).toBeGreaterThan(
        callsBeforeRetry
      )
    );
  });

  it("counts the unavailable list as a dead end, and records the Retry the user takes (ISS-7249)", async () => {
    // The list surface's production-path wiring. Its sibling, the session
    // detail, has session-detail-dead-end-wiring.test.tsx; without this one a
    // regression that dropped `useSessionsListDeadEndTelemetry` from
    // SessionsView, or re-pointed `onRetry` at the untracked `handleRetry`,
    // would leave every other test in this change green.
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: undefined,
      isFetching: false,
      isPlaceholderData: false,
      isLoading: false,
      isError: true,
      // ISS-7528: an INITIAL rejection sets BOTH flags on the real observer
      // (`isLoadingError = isError && no data was ever loaded`), so this
      // hand-set fixture states both. They diverge only on a refetch failure
      // over held data — the case a hand-set fixture cannot represent at all,
      // and which `sessions-view-read-failure-states.test.tsx` drives through a
      // real query instead.
      isLoadingError: true,
      refetch,
    });
    render(<SessionsView />, {
      wrapper: SessionsViewTestProviders,
    });

    await waitFor(() => expect(screen.getByText(ERRORED_EMPTY)).toBeTruthy());
    await waitFor(() => expect(recordDeadEndTelemetry).toHaveBeenCalled());

    // A failed read with no rows is `unavailable`/`fetch_failed` — never the
    // `true_zero` all-clear it has not earned.
    expect(recordDeadEndTelemetry.mock.calls[0]?.[0]).toMatchObject({
      treatment: DeadEndFlowTreatment.SessionsListUnavailable,
      phase: DeadEndFlowPhase.Rendered,
      state: DeadEndFlowState.Unavailable,
      reason: DeadEndFlowReason.FetchFailed,
      retryOffered: true,
      retryAttempt: 0,
    });
    const renderedCount = recordDeadEndTelemetry.mock.calls.length;

    captured.surface?.onRetry?.();
    // The wrapped handler still runs the real recovery — the telemetry must not
    // have replaced the behavior it observes.
    expect(refetch).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        recordDeadEndTelemetry.mock.calls.some(
          (call) => call[0]?.phase === DeadEndFlowPhase.RetryAttempted
        )
      ).toBe(true)
    );
    expect(recordDeadEndTelemetry.mock.calls.length).toBeGreaterThan(
      renderedCount
    );
  });

  it("folds a resolved-but-usage-failed read into the summary bar's error state (no false zeroes)", async () => {
    // The list half resolved (rows present, no whole-query error) but the usage
    // half failed — pageData carries usageError:true and no `usage`. SessionsView
    // must fold that into the always-available cards' isError so they dash rather
    // than render false zeroes (whitlockk, thread cid 3680316494). This locks the
    // SessionsView-side wiring the resolveSummaryCardsErrored helper unit test
    // cannot see; dropping it would leave the helper test green.
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: {
        list: {
          items: [{ id: "session-1" }],
          total: 1,
          readSource: ReadSource.Cloud,
        },
        usage: undefined,
        usageError: true,
      },
      isFetching: false,
      isPlaceholderData: false,
      isLoading: false,
      isError: false,
      refetch,
    });
    render(<SessionsView />, {
      wrapper: SessionsViewTestProviders,
    });

    await waitFor(() =>
      expect(screen.getByTestId("sessions-summary-cards")).toBeTruthy()
    );
    expect(capturedSummary.props?.isError).toBe(true);
    expect(capturedSummary.props?.isLoading).toBe(false);
  });

  it("repairs a bookmarked page on an empty corpus (zero total) back to /sessions", async () => {
    // The empty-corpus branch clampSessionsPageIndex takes when total is zero: a
    // bookmarked ?page=5 with no sessions at all must clamp to page 0 and rewrite
    // the URL to /sessions, never strand the user on a permanently blank page
    // (whitlockk, thread cid 3680316500). This is the total===0 branch the total===30
    // clamp test above does not exercise.
    hooks.useSearchParamsValue.mockReturnValue(new URLSearchParams("page=5"));
    hooks.useAgentSessionsPageData.mockReturnValue({
      ...emptyListPageData(0),
      refetch,
    });
    render(<SessionsView />, {
      wrapper: SessionsViewTestProviders,
    });

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
    render(<SessionsView />, {
      wrapper: SessionsViewTestProviders,
    });

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
          readSource: ReadSource.Cloud,
        },
        usage: { ...EMPTY_USAGE, totalSessions: 60 },
      },
      isFetching: false,
      isPlaceholderData: false,
      isLoading: false,
      isError: false,
      refetch,
    });
    render(<SessionsView />, {
      wrapper: SessionsViewTestProviders,
    });

    // Let the local-monitor status effect settle so any errant clamp would fire.
    await waitFor(() =>
      expect(window.desktopApi.getAgentMonitorUrl).toHaveBeenCalled()
    );
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  // ISS-6382 (tamsinb review): the WARM-cache twin of the gate test above. That
  // one hands the gate a COLD read (`data: undefined`), which is the easy half —
  // `!hasData` holds either way. `enabled: false` does not detach the observer
  // from the cache, so on a revisit this read serves the PREVIOUS visit's
  // payload for the whole restore window, and `getSessionsTableLoadingLabel`
  // short-circuits on `!hasData`: with rows in hand it returned no label at all,
  // the body fell through both of its loading branches, and the cached
  // default-view rows rendered under the sort the user is leaving.
  it("does not render the WARM default-view cache while the view restores", async () => {
    hooks.useSessionsViewState.mockReturnValue({
      isViewReady: false,
      sortKey: null,
      sortDir: "desc",
      secondarySorts: [],
      setSecondarySorts: vi.fn(),
      groupBy: SessionGroupBy.None,
      setGroupBy: vi.fn(),
      hiddenSummaryCards: new Set<string>(),
      toggleSummaryCard: vi.fn(),
      visibleColumns: new Set<string>(["name"]),
      columnOrder: undefined,
      setColumnOrder: vi.fn(),
      setSort: vi.fn(),
      toggleColumn: vi.fn(),
      resetView: vi.fn(),
    });
    // The revisit: a settled, POPULATED payload with `isLoading` false, which is
    // exactly what a disabled observer on an already-warm key reports.
    hooks.useAgentSessionsPageData.mockReturnValue({
      ...warmListPageData(),
      refetch,
    });

    const { rerender } = render(<SessionsView />, {
      wrapper: SessionsViewTestProviders,
    });

    await waitFor(() =>
      expect(screen.getByText(SESSIONS_LIST_LOADING_LABEL)).toBeTruthy()
    );
    // The cached rows never reach the listing: the body is still on its loading
    // branch, and the view withheld the rows from the surface entirely.
    expect(captured.surface?.rows.length).toBe(0);
    expect(capturedSummary.props?.isLoading).toBe(true);
    expect(readGateCalls()).not.toContain(true);

    // POSITIVE CONTROL. Every assertion above is an absence, which a view that
    // never renders rows at all would satisfy just as well. Open the gate over
    // the SAME cached payload and the rows must appear.
    hooks.useSessionsViewState.mockReturnValue({
      isViewReady: true,
      sortKey: null,
      sortDir: "desc",
      secondarySorts: [],
      setSecondarySorts: vi.fn(),
      groupBy: SessionGroupBy.None,
      setGroupBy: vi.fn(),
      hiddenSummaryCards: new Set<string>(),
      toggleSummaryCard: vi.fn(),
      visibleColumns: new Set<string>(["name"]),
      columnOrder: undefined,
      setColumnOrder: vi.fn(),
      setSort: vi.fn(),
      toggleColumn: vi.fn(),
      resetView: vi.fn(),
    });
    rerender(<SessionsView />);

    await waitFor(() => expect(captured.surface?.rows.length).toBe(1));
    expect(screen.queryByText(SESSIONS_LIST_LOADING_LABEL)).toBeNull();
  });

  it("does not render the WARM cache while a URL custom-window gate resolves", async () => {
    let customWindowReady = false;
    hooks.useSearchParamsValue.mockReturnValue(
      new URLSearchParams("from=2026-09-01&to=2026-09-10")
    );
    hooks.useFeatureFlagGate.mockImplementation((key: string) => ({
      enabled:
        key === DESKTOP_SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY &&
        customWindowReady,
      isReady:
        key !== DESKTOP_SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY ||
        customWindowReady,
    }));
    hooks.useAgentSessionsPageData.mockReturnValue({
      ...warmListPageData(),
      refetch,
    });

    const { rerender } = render(<SessionsView />, {
      wrapper: SessionsViewTestProviders,
    });

    await waitFor(() =>
      expect(screen.getByText(SESSIONS_LIST_LOADING_LABEL)).toBeTruthy()
    );
    expect(captured.surface?.rows.length).toBe(0);
    expect(capturedSummary.props?.isLoading).toBe(true);
    expect(readGateCalls()).not.toContain(true);

    customWindowReady = true;
    rerender(<SessionsView />);

    await waitFor(() => expect(captured.surface?.rows.length).toBe(1));
    expect(readGateCalls().at(-1)).toBe(true);
    expect(screen.queryByText(SESSIONS_LIST_LOADING_LABEL)).toBeNull();
  });
});

/**
 * ISS-6382: every `enabled` the view has handed the combined page read, oldest
 * first. Read as a whole rather than a single call because the gate's contract
 * spans renders — closed on the first commit, open after the restore commits.
 */
function readGateCalls(): (boolean | undefined)[] {
  return hooks.useAgentSessionsPageData.mock.calls.map(
    (call: unknown[]) => (call[1] as { enabled?: boolean } | undefined)?.enabled
  );
}

/** A settled, POPULATED combined page read — the warm-cache shape (ISS-6382). */
function warmListPageData() {
  return {
    data: {
      list: {
        items: [{ id: "session-warm-cache" }],
        total: 1,
        readSource: ReadSource.Cloud,
      },
      usage: EMPTY_USAGE,
    },
    isFetching: false,
    isPlaceholderData: false,
    isLoading: false,
    isError: false,
  };
}

/**
 * The three honest zero-row reasons the shared `SessionsEmptyState` renders, by
 * the copy each one is recognizable by. Spelled here rather than imported
 * because the component states them inline; a rename that moved the copy would
 * fail these cases, which is the intended coupling — the reason a reader is
 * given IS the contract under test.
 */
const ERRORED_EMPTY = "Couldn't load sessions";
const SYNCING_EMPTY = "Getting your sessions ready";
const FILTERED_EMPTY = "No matching sessions";
const GENUINE_EMPTY = "No sessions yet";
/** The filtered card's always-safe fix, and the control these cases drive. */
const CLEAR_FILTERS_ACTION = "Clear filters";
/** @see renderSessionsListBody — the v2 stack's quiet pending treatment. */
const SESSIONS_LIST_SKELETON_TEST_ID = "sessions-list-skeleton";
/**
 * The filtered card's own Clear-filters control. Scoped to the rows region
 * because the toolbar offers the same action beside its active-filter chips, and
 * the card's is the one these cases are about.
 */
function clearFiltersControlInEmptyCard(): HTMLElement {
  return within(screen.getByTestId(SESSIONS_HISTORY_LIST_TEST_ID)).getByRole(
    "button",
    { name: CLEAR_FILTERS_ACTION }
  );
}

/**
 * Which zero-row reason the body settled on, across ALL four — because a body
 * that fell through to any of them has already told the reader something a
 * still-pending read has not earned. Returned rather than asserted so the
 * assertion stays in the case that owns it, and so a leak names itself.
 */
function renderedEmptyStateReasons(): string[] {
  return [GENUINE_EMPTY, FILTERED_EMPTY, ERRORED_EMPTY, SYNCING_EMPTY].filter(
    (copy) => screen.queryByText(copy) !== null
  );
}

/** A query client whose `["s"]` key has already settled with data. */
function settledQueryClient(): QueryClient {
  const client = new QueryClient();
  client.setQueryData(["s"], 1);
  return client;
}
