import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { drainedCutover } from "../../../shared-agent-sessions/__tests__/fixtures/cloud-read-cutover-fixtures";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import { SessionsView } from "../SessionsView";

/**
 * FEA-3639: a blocking Sessions-list load must never sit on an infinite
 * skeleton. This mounts SessionsView with the list read wedged in `isLoading`
 * (no data, no error — the wedged-db-host case) and, driving fake timers past
 * the soft/hard thresholds, asserts the escalation: plain spinner → spinner +
 * Retry (~10s) → actionable "temporarily unavailable" + Retry (~30s), and that
 * Retry re-runs the read. Cloud mode is used purely to collapse `displayState`
 * to "ready" so the query's own `isLoading` drives the table (the local-monitor
 * status axis is covered elsewhere).
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

vi.mock("@repo/app/agents/components/sessions/agent-sessions-list", () => ({
  AgentSessionsListContent: () => <div data-testid="sessions-table-body" />,
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
  // FEA-3639: SessionsView now renders the file-access banner, which reads this
  // hook. No block in these tests → empty, so the banner renders nothing.
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

// SessionsView composes the surface-agnostic navigation Link (via the errored
// empty's recovery action). Stub it as a plain anchor so the view mounts without
// a NavigationProvider ancestor. (The hard-stall surface exercised here carries
// only Retry — the recovery Link is deliberately not threaded into it.)
vi.mock("@repo/navigation/link", () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
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

const SOFT_MS = 10_000;
const HARD_MS = 30_000;

describe("SessionsView loading stall (FEA-3639)", () => {
  let refetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    desktopApiDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "desktopApi"
    );
    vi.clearAllMocks();
    refetch = vi.fn().mockResolvedValue(undefined);
    hooks.useSharedDateRange.mockReturnValue({
      dateRange: "7d",
      setDateRange: vi.fn(),
    });
    hooks.useSearchParamsValue.mockReturnValue(new URLSearchParams());
    hooks.useSessionsViewState.mockReturnValue({
      sortKey: null,
      sortDir: "desc",
      visibleColumns: new Set<string>(["name"]),
      setSort: vi.fn(),
      toggleColumn: vi.fn(),
    });
    // The list read is wedged: loading, with no data and no settled error — the
    // exact shape a hung db-host IPC read produces (no query-level timeout).
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      isFetching: true,
      isPlaceholderData: false,
      refetch,
    });
    hooks.useAgentSessionUsage.mockReturnValue({
      data: undefined,
      isFetching: true,
      isPlaceholderData: false,
      isError: false,
    });
    hooks.useAgentSessionAnalytics.mockReturnValue({ data: undefined });
    hooks.useLocalAgentSessionUsage.mockReturnValue({
      data: undefined,
      isError: false,
    });
    hooks.useIngestProgress.mockReturnValue(null);
    // Local monitor status is irrelevant in cloud mode (displayState collapses to
    // "ready"); resolve it deterministically so its poll doesn't churn the fake
    // clock.
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        getAgentMonitorUrl: vi
          .fn()
          .mockRejectedValue(new Error("local monitor unavailable")),
        onDbChanged: vi.fn(() => undefined),
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    if (desktopApiDescriptor) {
      Object.defineProperty(window, "desktopApi", desktopApiDescriptor);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
    desktopApiDescriptor = undefined;
  });

  it("escalates a wedged load to a retry then an actionable error, and Retry re-runs the read", async () => {
    render(<SessionsView />);
    // Flush the initial async (local-monitor status rejection) so the tree
    // settles before the clock advances.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Before the soft threshold: a plain spinner, no retry, no error.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(
      screen.queryByText("Sessions are temporarily unavailable")
    ).toBeNull();

    // Soft threshold: the spinner gains a Retry, still no error.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SOFT_MS);
    });
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(
      screen.queryByText("Sessions are temporarily unavailable")
    ).toBeNull();

    // Hard threshold: the actionable "temporarily unavailable" error.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HARD_MS - SOFT_MS);
    });
    expect(
      screen.getByText("Sessions are temporarily unavailable")
    ).toBeTruthy();

    // Retry must actually recover the wedged read, not just fire the mock: it
    // re-runs the read (`refetch()` already replaces an in-flight fetch —
    // query-core defaults `cancelRefetch` to true — so no explicit option) AND
    // restarts the stall budget, so the actionable error clears back to a plain
    // spinner (no Retry button) — proving the 10s/30s window truly reset instead
    // of latching "hard". The flush settles the local-source recheck's async
    // state update.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText("Sessions are temporarily unavailable")
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    // …and the fresh budget re-escalates on its own timeline.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SOFT_MS);
    });
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
