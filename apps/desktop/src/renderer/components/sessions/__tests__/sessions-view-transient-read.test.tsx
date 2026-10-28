import { queryRetryDelay } from "@repo/app/shared/query/query-client";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { SHARED_AGENT_SESSIONS_TRANSIENT_ERROR_CODE } from "../../../../shared/shared-agent-sessions-contract";
import { TransientSourceError } from "../../../shared/transient-source-error";
import {
  DesktopAppCoreMode,
  DesktopLocalReadReason,
} from "../../../shared-agent-sessions/desktop-app-core-mode";
import { SessionsView } from "../SessionsView";
import { SessionsViewTestProviders } from "./fixtures/sessions-view-render-fixture";

/**
 * ISS-4483: a settled TRANSIENT list read error (the local db-host child restarting
 * / crash-looping mid-backfill) must NOT dump the user on the hard "Couldn't load
 * sessions" card, and the always-available summary cards must NOT collapse to a
 * confirmed `0`/`0`/`$0`. Instead the read auto-retries (owned by the shared query
 * client) and, while it settles, the table shows the quiet reconnecting surface and
 * the cards stay in their loading state. A PERSISTENT (fatal) error still surfaces
 * the hard error. These render SessionsView in LOCAL mode — the surface the ticket
 * reports — with the local source `ready` and the pageData read settled to an error.
 */

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

let desktopApiDescriptor: PropertyDescriptor | undefined;

/**
 * The two zero-row surfaces this suite tells apart, asserted as the RENDERED
 * copy of `sessions-empty-state.tsx` rather than through a stand-in echoing
 * props.
 *
 * ISS-8909 retired the v1 list content this suite used to mock, so the real
 * shared surface mounts and the derived `isSyncing` / unavailable signals are
 * observable where the reader meets them: a transient failure routes to the
 * quiet syncing surface, a fatal one to the hard error card. Spelled as
 * literals, deliberately not imported from the component under test — reading
 * the copy off it would keep these green after the surface stopped rendering
 * either state.
 */
const SYNCING_TITLE = "Getting your sessions ready";
const OUTAGE_TITLE = "Couldn't load sessions";

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
  useFeatureFlagGate: () => ({
    enabled: false,
    isReady: true,
  }),
  // ISS-9692: `useTablePageSizeOptions` reads the ladder gate through the
  // provider-optional port, so this exhaustive module mock owes it an entry
  // too. Same answer as the required gate above.
  useFeatureFlagGateOptional: () => ({
    enabled: false,
    isReady: true,
  }),
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

// LOCAL mode — the surface the ticket reports. displayState is driven by the local
// source status resolved below (ready), not collapsed to "ready" like the cloud
// tests.
vi.mock("../../../shared-agent-sessions/desktop-app-core-provider", () => ({
  useDesktopAppCoreMode: () => DesktopAppCoreMode.Local,
  // ISS-5477: SessionsView derives the read-source badge detail from the
  // same provider, so this factory has to answer for it too.
  useDesktopLocalReadReason: () => DesktopLocalReadReason.SignedOut,
}));

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: { status: DesktopAuthStatus.Authenticated },
    beginSignIn: vi.fn().mockResolvedValue({ ok: true }),
    cancelSignIn: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
  }),
}));

async function renderSettled(): Promise<void> {
  render(<SessionsView />, {
    wrapper: SessionsViewTestProviders,
  });
  // Flush the local-source status probe so displayState settles to "ready".
  await act(async () => {
    await Promise.resolve();
  });
}

describe("SessionsView transient db-host read (ISS-4483)", () => {
  beforeEach(() => {
    desktopApiDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "desktopApi"
    );
    vi.clearAllMocks();
    hooks.useSharedDateRange.mockReturnValue({
      dateRange: "7d",
      setDateRange: vi.fn(),
    });
    hooks.useSearchParamsValue.mockReturnValue(new URLSearchParams());
    hooks.useSessionsViewState.mockReturnValue({
      isViewReady: true,
      sortKey: null,
      sortDir: "desc",
      visibleColumns: new Set<string>(["name"]),
      setSort: vi.fn(),
      toggleColumn: vi.fn(),
    });
    hooks.useAgentSessionUsage.mockReturnValue({
      data: undefined,
      isFetching: false,
      isPlaceholderData: false,
      isError: false,
    });
    hooks.useAgentSessionAnalytics.mockReturnValue({ data: undefined });
    hooks.useLocalAgentSessionUsage.mockReturnValue({
      data: undefined,
      isError: false,
    });
    hooks.useIngestProgress.mockReturnValue(null);
    // Local source is READY, so displayState is "ready" and the settled query
    // error (not the source status) drives the empty surface.
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        getAgentMonitorUrl: vi
          .fn()
          .mockResolvedValue({ localSessionSourceStatus: "ready" }),
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

  it("routes a settled TRANSIENT error to the reconnecting surface, not the hard error, and HOLDS the card labels while skeletoning only the values (no fake 0)", async () => {
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      // ISS-7528: an INITIAL rejection sets BOTH flags on the real observer, so
      // this fixture states both. The transient term's own contribution to
      // `isUnavailable` (a transient failure over a read that ALREADY
      // SUCCEEDED, where `isLoadingError` is false) is covered by
      // `sessions-summary-cards-state.test.tsx`.
      isLoadingError: true,
      error: new TransientSourceError(
        "Agent sessions source failed.",
        SHARED_AGENT_SESSIONS_TRANSIENT_ERROR_CODE
      ),
      fetchStatus: "fetching",
      failureCount: 1,
      isFetching: true,
      isPlaceholderData: false,
      refetch: vi.fn().mockResolvedValue(undefined),
    });

    await renderSettled();

    // The table routes to the quiet syncing/reconnecting surface, never the hard
    // "something went wrong" card. Both halves are asserted: the presence alone
    // would pass on a surface that rendered every unavailable state at once.
    expect(screen.getByText(SYNCING_TITLE)).not.toBeNull();
    expect(screen.queryByText(OUTAGE_TITLE)).toBeNull();
    // ISS-4483 (review cid 3679535439): HOLD the labels, skeleton only the values.
    // The always-available cards keep their labels (the row keeps its shape and the
    // user can read what is coming) while the value slot shimmers — so the labels
    // ARE present, but the cards must NOT collapse to a confirmed `0`/`$0`.
    // `getByText` throws if the label is absent, so its resolving proves the label
    // is held (not skeletoned away with the value).
    expect(screen.getByText("Sessions")).not.toBeNull();
    expect(screen.getByText("Total Tokens")).not.toBeNull();
    expect(screen.queryByText("0")).toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("still surfaces the hard error for a settled PERSISTENT (fatal) error", async () => {
    // A fatal error carries no transient code, so it is not classified transient.
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      // ISS-7528: an INITIAL rejection sets BOTH flags on the real observer
      // (`isLoadingError = isError && no data was ever loaded`), so this
      // hand-set fixture states both. They diverge only on a refetch failure
      // over held data — the case a hand-set fixture cannot represent at all,
      // and which `sessions-view-read-failure-states.test.tsx` drives through a
      // real query instead.
      isLoadingError: true,
      error: new Error("SQLITE_CORRUPT: database disk image is malformed"),
      isFetching: false,
      isPlaceholderData: false,
      refetch: vi.fn().mockResolvedValue(undefined),
    });

    await renderSettled();

    // A fatal error is unavailable but NOT syncing → the hard error surface, and
    // the quiet syncing copy must not stand in for it.
    expect(screen.getByText(OUTAGE_TITLE)).not.toBeNull();
    expect(screen.queryByText(SYNCING_TITLE)).toBeNull();
  });

  /**
   * ISS-6382 (whitlockk review): the bounded usage recovery drives a MANUAL
   * `refetch()`, which ignores `enabled`, off a signal read from the query's
   * `data` — the CACHED payload on a revisit. So a cached `usageErrorTransient`
   * armed the recovery while the restore gate held the read closed, and one
   * backoff later fetched the default view anyway. This asserts the wiring: that
   * the view hands the recovery its EFFECTIVE gate, not a constant.
   */
  it("does not let a CACHED transient usage error refetch through the closed restore gate", async () => {
    vi.useFakeTimers();
    try {
      const refetch = vi.fn().mockResolvedValue(undefined);
      hooks.useAgentSessionsPageData.mockReturnValue({
        // The warm cache: a resolved payload the observer still serves while
        // `enabled` is false. `usageErrorTransient` is what arms the recovery.
        data: {
          sessions: [],
          total: 0,
          usage: undefined,
          usageError: true,
          usageErrorTransient: true,
        },
        isLoading: false,
        isError: false,
        isFetching: false,
        isPlaceholderData: false,
        refetch,
      });
      setViewReady(false);

      const { rerender } = render(<SessionsView />, {
        wrapper: SessionsViewTestProviders,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          queryRetryDelay(0) + queryRetryDelay(1)
        );
      });

      // Slow auth hydration keeps `isViewReady` false well past the first
      // backoff. Nothing may be dispatched in that window.
      expect(refetch).not.toHaveBeenCalled();

      // POSITIVE CONTROL. Without it, a recovery that never fires at all passes
      // the assertion above, and `enabled false forever` would read as a fix.
      setViewReady(true);
      rerender(<SessionsView />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(queryRetryDelay(0));
      });

      expect(refetch).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

function setViewReady(isViewReady: boolean) {
  hooks.useSessionsViewState.mockReturnValue({
    isViewReady,
    sortKey: null,
    sortDir: "desc",
    visibleColumns: new Set<string>(["name"]),
    setSort: vi.fn(),
    toggleColumn: vi.fn(),
  });
}
