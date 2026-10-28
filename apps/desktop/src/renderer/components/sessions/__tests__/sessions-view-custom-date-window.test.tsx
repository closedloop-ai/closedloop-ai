import { SESSIONS_HISTORY_LIST_TEST_ID } from "@repo/app/agents/components/sessions/sessions-list-surface-v2";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { DESKTOP_SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY } from "../../../../shared/feature-flags-labs-detail";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import { SessionsView } from "../SessionsView";
import { SessionsViewTestProviders } from "./fixtures/sessions-view-render-fixture";

/**
 * FEA-4201. The lib suite proves the codec and the web suite proves the web
 * route; this proves the DESKTOP renderer reads the same two params into the
 * same query, because a shared codec neither surface calls is a codec that
 * silently does nothing on one of them.
 *
 * The assertion is on the EMITTED QUERY, never on the URL: a URL assertion alone
 * stays green while this view ignores the params entirely.
 *
 * Expected bounds are pinned literals rather than a call to the module's own
 * bounds helper — deriving them from the encoder under test would make this
 * agree with any encoding it happened to produce, including a wrong one.
 *
 * ISS-8909 rehomed the observation point. The v1 stack composed
 * `SessionsToolbar` beside a list body, so this suite read the setter off the
 * toolbar's props and gated its renders on that body's marker. `SessionsView`
 * now always mounts `SessionsListSurfaceV2`, which OWNS the custom-window
 * control, so the same two claims are read where they now live: the render gate
 * is the surface's own `SESSIONS_HISTORY_LIST_TEST_ID`, and the withheld /
 * handed-over setter is the surface's `onCustomDateWindowChange` prop. The
 * surface mock is a SPY — it preserves the real exports, so the marker asserted
 * against is the one the real surface publishes.
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

/** The props the stubbed v2 surface was last rendered with. */
const captured = vi.hoisted(() => ({
  surface: null as Record<string, unknown> | null,
}));

/** Flipped per test; read through a getter so the module mock stays hoisted. */
const coreMode = vi.hoisted(() => ({ current: "cloud" as "cloud" | "local" }));

/** Flag keys this render resolves to on. Empty is the closed-by-default state. */
const enabledFlags = vi.hoisted(() => ({ current: new Set<string>() }));

let desktopApiDescriptor: PropertyDescriptor | undefined;

// Spied, not replaced: the real module's exports are kept, so the marker this
// stub renders is the surface's OWN published test id rather than a literal
// this file would have to keep in sync by hand.
vi.mock(
  "@repo/app/agents/components/sessions/sessions-list-surface-v2",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@repo/app/agents/components/sessions/sessions-list-surface-v2")
      >();
    return {
      ...original,
      SessionsListSurfaceV2: (props: Record<string, unknown>) => {
        captured.surface = props;
        return <div data-testid={original.SESSIONS_HISTORY_LIST_TEST_ID} />;
      },
    };
  }
);

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
  useFeatureFlagEnabled: (key: string) => enabledFlags.current.has(key),
  useFeatureFlagEnabledOptional: (key: string) => enabledFlags.current.has(key),
  // FEA-4201: the readiness-carrying read. `isReady` is settled-ness, not
  // enabled-ness, and the real desktop port settles ASYNCHRONOUSLY — the
  // signed-in account's PostHog assignment arrives over the IPC bridge. This
  // mock pins it settled so the suites exercise the resolved state; `enabled`
  // mirrors this suite's own set.
  useFeatureFlagGate: (key: string) => ({
    enabled: enabledFlags.current.has(key),
    isReady: true,
  }),
  // ISS-9692: `useTablePageSizeOptions` reads the ladder gate through the
  // provider-optional port, so this exhaustive module mock owes it an entry
  // too. Same answer as the required gate above.
  useFeatureFlagGateOptional: (key: string) => ({
    enabled: enabledFlags.current.has(key),
    isReady: true,
  }),
}));

vi.mock("@repo/app/shared/hooks/use-shared-date-range", () => ({
  useSharedDateRange: hooks.useSharedDateRange,
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ replace: vi.fn() }),
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
  useDesktopAppCoreMode: () =>
    coreMode.current === "cloud"
      ? DesktopAppCoreMode.Cloud
      : DesktopAppCoreMode.Local,
  useDesktopLocalReadReason: () => undefined,
}));

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: { status: DesktopAuthStatus.Authenticated, userId: "user-1" },
    beginSignIn: vi.fn().mockResolvedValue({ ok: true }),
    cancelSignIn: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
  }),
}));

// The two IPC reads the issue-href builder depends on. Stubbed rather than
// exercised here — `use-desktop-linked-entity-columns.test.tsx` owns the href
// rule itself; this file is about whether the seams are wired at all.
vi.mock("../../../shared-agent-sessions/use-desktop-identity", () => ({
  useDesktopIdentity: () => ({
    identity: { organizationSlug: "acme" },
    isResolved: true,
  }),
}));

vi.mock("../../../shared-agent-sessions/use-web-app-origin", () => ({
  useWebAppOrigin: () => ({
    origin: "https://app.closedloop.ai",
    isResolved: true,
  }),
}));

describe("SessionsView — custom from/to date window (FEA-4201)", () => {
  beforeEach(() => {
    desktopApiDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "desktopApi"
    );
    vi.clearAllMocks();
    enabledFlags.current = new Set<string>();
    captured.surface = null;
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
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: {
        list: { items: [{ id: "session-1" }], total: 1, readSource: undefined },
        usage: {
          totalSessions: 1,
          totalInputTokens: 10,
          totalOutputTokens: 5,
          earliestSessionAt: "2026-07-01T00:00:00.000Z",
          latestSessionAt: "2026-07-02T00:00:00.000Z",
          byRepository: [],
        },
      },
      isFetching: false,
      isPlaceholderData: false,
      isLoading: false,
      isError: false,
    });
    hooks.useAgentSessionUsage.mockReturnValue({
      data: {
        totalSessions: 1,
        totalInputTokens: 10,
        totalOutputTokens: 5,
        earliestSessionAt: "2026-07-01T00:00:00.000Z",
        latestSessionAt: "2026-07-02T00:00:00.000Z",
        byRepository: [],
      },
      isFetching: false,
      isPlaceholderData: false,
      isError: false,
    });
    hooks.useAgentSessionAnalytics.mockReturnValue({
      data: { byRepository: [] },
    });
    hooks.useLocalAgentSessionUsage.mockReturnValue({
      data: {
        totalSessions: 1,
        totalInputTokens: 10,
        totalOutputTokens: 5,
        byRepository: [],
      },
      isError: false,
    });
    hooks.useIngestProgress.mockReturnValue(null);
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        // Local mode needs a READY local monitor to get past the read gate and
        // render the list at all, which is what makes the local-half assertion
        // below a real negative rather than an unrendered one.
        getAgentMonitorUrl: vi.fn().mockResolvedValue("http://127.0.0.1:7777"),
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

  it("bounds a single-day drill-down at BOTH ends", async () => {
    coreMode.current = "cloud";
    enabledFlags.current = new Set([
      DESKTOP_SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY,
    ]);
    hooks.useSearchParamsValue.mockReturnValue(
      new URLSearchParams("from=2026-01-01&to=2026-01-01")
    );

    render(<SessionsView />, { wrapper: SessionsViewTestProviders });

    await screen.findByTestId(SESSIONS_HISTORY_LIST_TEST_ID);
    expect(lastPageDataFilters()).toMatchObject({
      endDate: "2026-01-01T23:59:59.999Z",
      startDate: "2026-01-01T00:00:00.000Z",
    });
  });

  /**
   * ISS-4779 closed-by-default. With the Labs toggle off the params must be
   * INERT, not merely un-offered: a link written by a build that has it on would
   * otherwise narrow a listing whose viewer has no control to see or clear it.
   */
  it("ignores the params entirely with the Labs toggle off", async () => {
    coreMode.current = "cloud";
    hooks.useSearchParamsValue.mockReturnValue(
      new URLSearchParams("from=2026-01-01&to=2026-01-01")
    );

    render(<SessionsView />, { wrapper: SessionsViewTestProviders });

    await screen.findByTestId(SESSIONS_HISTORY_LIST_TEST_ID);
    const filters = lastPageDataFilters();
    expect(filters?.startDate).not.toBe("2026-01-01T00:00:00.000Z");
    expect(filters?.endDate).not.toBe("2026-01-01T23:59:59.999Z");
  });

  // The v2 surface keys the Custom control off this prop's PRESENCE, so a
  // withheld setter is what stops the control mounting at all — see
  // `useSessionsWindowClearFold`, which deliberately passes the absence through
  // rather than wrapping it in an always-present handler.
  it("withholds the surface setter with the toggle off, so no control mounts", async () => {
    coreMode.current = "cloud";

    render(<SessionsView />, { wrapper: SessionsViewTestProviders });

    await waitFor(() => expect(captured.surface).not.toBeNull());
    expect(surfaceProps()?.onCustomDateWindowChange).toBeUndefined();
  });

  it("hands the surface the setter with the toggle on", async () => {
    coreMode.current = "cloud";
    enabledFlags.current = new Set([
      DESKTOP_SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY,
    ]);

    render(<SessionsView />, { wrapper: SessionsViewTestProviders });

    await waitFor(() => expect(captured.surface).not.toBeNull());
    expect(typeof surfaceProps()?.onCustomDateWindowChange).toBe("function");
  });
});

/** The props `SessionsListSurfaceV2` was last rendered with. */
function surfaceProps(): Record<string, unknown> | undefined {
  return captured.surface ?? undefined;
}

/** The filters the combined list+usage read was last asked for. */
function lastPageDataFilters(): Record<string, unknown> | undefined {
  const calls = hooks.useAgentSessionsPageData.mock.calls;
  return calls.at(-1)?.[0] as Record<string, unknown> | undefined;
}
