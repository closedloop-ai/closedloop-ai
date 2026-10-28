import { ReadSource } from "@repo/api/src/types/read-source";
import { SESSIONS_HISTORY_LIST_TEST_ID } from "@repo/app/agents/components/sessions/sessions-list-surface-v2";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import { SessionsView } from "../SessionsView";
import { SessionsViewTestProviders } from "./fixtures/sessions-view-render-fixture";

/**
 * PLN-1138 Phase 2 regression guard (raised in review): in cloud mode the
 * Sessions view reads the HTTP source over the D-G bridge, so the read gate must
 * NOT depend on local-monitor readiness. This mounts SessionsView in cloud mode
 * with the local monitor *unavailable* and asserts the sessions query is still
 * enabled and the v2 list region still renders (`displayState` collapses to
 * "ready") —
 * i.e. an authenticated+online user sees cloud rows even when the local monitor
 * is down. `sessions-view-responsive.test.tsx` covers the default Local path.
 */

const hooks = vi.hoisted(() => ({
  enabledFlags: new Set<string>(),
  useAgentSessionAnalytics: vi.fn(),
  useAgentSessionsPageData: vi.fn(),
  useAgentSessionUsage: vi.fn(),
  useLocalAgentSessionUsage: vi.fn(),
  useIngestProgress: vi.fn(),
  useSessionsViewState: vi.fn(),
  useSharedDateRange: vi.fn(),
  useSearchParamsValue: vi.fn(),
}));

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
}));

// The props the host handed the shared v2 surface on its last render.
const surface = vi.hoisted(() => ({
  props: undefined as { exportItem?: unknown } | undefined,
}));

let desktopApiDescriptor: PropertyDescriptor | undefined;

// ISS-8909: the v1 Sessions stack is retired, so the REAL shared
// `SessionsListSurfaceV2` is what mounts here — and it must stay real, because
// the summary-card assertions below read cards this surface renders from its
// own `summaryCards` prop. This wrapper renders that real component and only
// records the props it was handed, so the export-row contract (does the host
// OFFER a row?) stays assertable without opening the View menu that would
// actually render it: the real `SessionsCsvExportMenuItem` owns a
// `useApiClient()` call that throws without an auth provider this suite does
// not mount — the very hazard `useSessionsExportItem` returning an ELEMENT
// exists to contain.
vi.mock(
  "@repo/app/agents/components/sessions/sessions-list-surface-v2",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@repo/app/agents/components/sessions/sessions-list-surface-v2")
      >();
    return {
      ...original,
      SessionsListSurfaceV2: (
        props: Parameters<typeof original.SessionsListSurfaceV2>[0]
      ) => {
        surface.props = props;
        return <original.SessionsListSurfaceV2 {...props} />;
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

// FEA-3574 review (whitlockk): in Cloud mode SessionsView reads the LOCAL usage
// totals via this hook (a real `useQuery`) so the always-available cards stay
// SQLite-backed. Stub it so this cloud-read-gate test doesn't need a
// `QueryClientProvider`; the local-source data flow is asserted in the shared
// sessions-summary-cards tests.
vi.mock("../use-local-agent-session-usage", () => ({
  useLocalAgentSessionUsage: hooks.useLocalAgentSessionUsage,
}));

// FEA-4128: SessionsView polls the shared ingest progress in Cloud mode to hold
// the always-available cards in a skeleton while a first-launch import is still
// populating the local store. Stub the hook (and re-export its type) so these
// tests drive the import-in-progress signal directly.
vi.mock("../../../hooks/use-ingest-progress", () => ({
  useIngestProgress: hooks.useIngestProgress,
}));

vi.mock("../../../hooks/use-file-access-blocks", () => ({
  // FEA-3639: SessionsView renders the file-access banner, which reads this
  // hook. No block here → empty, so the banner renders nothing.
  useFileAccessBlocks: () => [],
}));

// Stub the org-scoped connected-agent probe (PRD-536 §5) so these SessionsView
// tests don't stand up the real API-client/auth providers just to render.
vi.mock("@repo/app/agents/hooks/use-has-connected-agent", () => ({
  useHasConnectedAgent: () => ({ data: undefined }),
}));

vi.mock("@repo/app/agents/hooks/use-sessions-view-state", () => ({
  useSessionsViewState: hooks.useSessionsViewState,
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => hooks.enabledFlags.has(key),
  // ISS-4890/4906/4901 + ISS-4887: the shared table and summary strip read
  // their gates OPTIONALLY, so this module mock must expose both hooks or the
  // whole subtree throws on the missing export. Both resolve OFF here, which
  // is the flag default and the behavior these tests assert.
  useFeatureFlagEnabledOptional: (key: string) => hooks.enabledFlags.has(key),
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

// Force cloud mode without standing up the real app-core provider (QueryClient,
// adapters, IPC bridge). SessionsView imports only `useDesktopAppCoreMode` here.
vi.mock("../../../shared-agent-sessions/desktop-app-core-provider", () => ({
  useDesktopAppCoreMode: () => DesktopAppCoreMode.Cloud,
  // ISS-5477: SessionsView derives the read-source badge detail from the
  // same provider, so this factory has to answer for it too.
  useDesktopLocalReadReason: () => undefined,
}));

// FEA-3574: SessionsView now reads the durable-session auth state to drive the
// cloud-only delivery cards' per-card auth state, so it calls `useDesktopAuth()`
// unconditionally. Stub the provider so these cloud-read-gate tests don't have to
// mount the real DesktopAuthProvider; the authenticated case keeps the delivery
// cards in the neutral-empty state (no sign-in CTA). The auth-state machine
// itself is covered by the shared sessions-summary-cards tests and the signed-out
// case in sessions-view-responsive.test.tsx.
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: { status: DesktopAuthStatus.Authenticated },
    beginSignIn: vi.fn().mockResolvedValue({ ok: true }),
    cancelSignIn: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
  }),
}));

describe("SessionsView search term by gridview-adoption (ISS-13035)", () => {
  beforeEach(() => {
    desktopApiDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "desktopApi"
    );
    vi.clearAllMocks();
    hooks.enabledFlags.clear();
    surface.props = undefined;
    hooks.useSharedDateRange.mockReturnValue({
      dateRange: "7d",
      setDateRange: vi.fn(),
    });
    hooks.useSearchParamsValue.mockReturnValue(
      new URLSearchParams("search=feature")
    );
    hooks.useSessionsViewState.mockReturnValue({
      isViewReady: true,
      sortKey: null,
      sortDir: "desc",
      // ISS-8335: the sort rules AFTER the primary. The v2 surface adapter
      // iterates them, so the real hook's empty-array default is part of the
      // shape this fixture owes it.
      secondarySorts: [],
      setSecondarySorts: vi.fn(),
      visibleColumns: new Set<string>(["name"]),
      setSort: vi.fn(),
      toggleColumn: vi.fn(),
    });
    // FEA-4157: the table + summary cards read from ONE combined
    // `useAgentSessionsPageData` ({ list, usage }); the facet-option toolbar read
    // stays on `useAgentSessionUsage`. In Cloud mode the always-available cards
    // additionally read `useLocalAgentSessionUsage` (the SQLite split below).
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: {
        list: {
          items: [{ id: "session-1" }],
          total: 50,
          readSource: ReadSource.Cloud,
        },
        usage: {
          totalSessions: 50,
          totalInputTokens: 1000,
          totalOutputTokens: 250,
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
        totalSessions: 50,
        totalInputTokens: 1000,
        totalOutputTokens: 250,
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
    // FEA-3574 review (whitlockk): the separate LOCAL usage read that backs the
    // always-available cards in Cloud mode. Defaults to a loaded local total so
    // the always-available cards render from SQLite, not the cloud read.
    hooks.useLocalAgentSessionUsage.mockReturnValue({
      data: {
        totalSessions: 50,
        totalInputTokens: 1000,
        totalOutputTokens: 250,
        byRepository: [],
      },
      isError: false,
    });
    // FEA-4128: no first-launch import in flight by default, so the always-
    // available cards render their loaded local totals (the import-in-progress
    // skeleton path is exercised explicitly below).
    hooks.useIngestProgress.mockReturnValue(null);
    // Local monitor is UNAVAILABLE: getAgentMonitorUrl rejects, so the local
    // source status resolves to `unavailable` (never `ready`). In Local mode this
    // would gate the read off and show the unavailable state; cloud mode must not.
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
    // Unmount before removing window.desktopApi: SessionsView's local-monitor
    // status effect runs a 500ms poll that reads window.desktopApi, so tearing
    // the global down while a component is still mounted leaks into the next test.
    cleanup();
    if (desktopApiDescriptor) {
      Object.defineProperty(window, "desktopApi", desktopApiDescriptor);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
    desktopApiDescriptor = undefined;
  });

  function listFilters() {
    return hooks.useAgentSessionsPageData.mock.calls.at(-1)?.[0] as
      | Record<string, unknown>
      | undefined;
  }

  it("DESKTOP-SEARCH-1 keeps the local search hint and sends the cloud list no term while the flag is off", async () => {
    render(<SessionsView />, { wrapper: SessionsViewTestProviders });
    await waitFor(() =>
      expect(screen.queryByTestId(SESSIONS_HISTORY_LIST_TEST_ID)).toBeTruthy()
    );

    expect(listFilters()?.search).toBe("feature");
    expect(listFilters()?.listSearch).toBeUndefined();
  });

  it("DESKTOP-SEARCH-2 sends the term to the cloud list route once the flag is on", async () => {
    hooks.enabledFlags.add(GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY);
    render(<SessionsView />, { wrapper: SessionsViewTestProviders });
    await waitFor(() =>
      expect(screen.queryByTestId(SESSIONS_HISTORY_LIST_TEST_ID)).toBeTruthy()
    );

    expect(listFilters()?.listSearch).toBe("feature");
  });
});
