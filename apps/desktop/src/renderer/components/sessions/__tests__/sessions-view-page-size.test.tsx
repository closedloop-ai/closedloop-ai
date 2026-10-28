import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import { SessionsView } from "../SessionsView";
import { SessionsViewTestProviders } from "./fixtures/sessions-view-render-fixture";

/**
 * ISS-8756 — the desktop Sessions list READS at the page size its URL holds.
 *
 * This is the desktop half of the change and the one that could not be caught
 * anywhere else. `SessionsView` used to build its list filters from the module
 * constant `PAGE_SIZE`, so the rows-per-page control on this surface moved a
 * number the fetch never saw — the query stayed at 25 no matter what the reader
 * picked, and every render-model test stayed green because none of them reaches
 * the filter builder. So this mounts the real view and asserts the OUTGOING
 * read, from a URL that names a large page.
 *
 * Local mode, so `maxOffset` is undefined and the offset arithmetic below is the
 * page size's alone — the cloud ceiling is the sibling
 * `sessions-view-max-offset-cap.test.tsx`.
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
  useTablePageSizeOptions: vi.fn(),
}));

const coreMode = vi.hoisted(() => ({ current: "" }));

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));

let desktopApiDescriptor: PropertyDescriptor | undefined;

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessionAnalytics: hooks.useAgentSessionAnalytics,
  useAgentSessionsPageData: hooks.useAgentSessionsPageData,
  useAgentSessionUsage: hooks.useAgentSessionUsage,
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
  useFeatureFlagEnabledOptional: () => false,
  useFeatureFlagGate: () => ({ enabled: false, isReady: true }),
  // ISS-9692: `useTablePageSizeOptions` reads the ladder gate through the
  // provider-optional port, so this exhaustive module mock owes it an entry
  // too. Same answer as the required gate above.
  useFeatureFlagGateOptional: () => ({ enabled: false, isReady: true }),
}));

// The ladder resolver is mocked so this file drives the URL value straight
// through; the shared hook's own suite owns ladder clamping. Here the question is
// whether the value the view holds reaches the read at all.
vi.mock("@repo/app/shared/hooks/use-table-page-size-options", () => ({
  useTablePageSizeOptions: hooks.useTablePageSizeOptions,
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
  useDesktopAppCoreMode: () => coreMode.current,
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

/** The URL rows-per-page under test — the largest rung the ladder offers. */
const URL_PAGE_SIZE = 500;
/** The page size that shipped, so a regression to the constant is nameable. */
const LEGACY_FIXED_PAGE_SIZE = 25;

const lastListFilters = () => {
  const calls = hooks.useAgentSessionsPageData.mock.calls;
  return calls.at(-1)?.[0];
};

function mountWithUrlPageSize(pageSize: number | null, ladderEnabled = true) {
  const resolvedPageSize = pageSize ?? LEGACY_FIXED_PAGE_SIZE;
  hooks.useSessionsViewState.mockReturnValue({
    isViewReady: true,
    setSort: vi.fn(),
    sortDir: "desc",
    sortKey: null,
    toggleColumn: vi.fn(),
    visibleColumns: new Set<string>(["name"]),
  });
  hooks.useTablePageSizeOptions.mockReturnValue({
    isExtendedLadderEnabled: ladderEnabled,
    // ISS-9692 (whitlockk review): resolved. This fixture's local-source gate keeps
    // the page read closed regardless, so the readiness GATE cannot be observed
    // here — it is asserted on the web page, whose harness can open the read.
    isReady: true,
    options: ladderEnabled ? [25, 50, 100, 250, 500] : [25, 50, 100],
    pageSize: resolvedPageSize,
  });
  hooks.useSearchParamsValue.mockReturnValue(
    pageSize === null
      ? new URLSearchParams()
      : new URLSearchParams({ pageSize: String(pageSize) })
  );
  return render(<SessionsView />, { wrapper: SessionsViewTestProviders });
}

describe("SessionsView reads at the URL rows-per-page", () => {
  beforeEach(() => {
    desktopApiDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "desktopApi"
    );
    vi.clearAllMocks();
    coreMode.current = DesktopAppCoreMode.Local;
    hooks.useSharedDateRange.mockReturnValue({
      dateRange: "7d",
      setDateRange: vi.fn(),
    });
    hooks.useSearchParamsValue.mockReturnValue(new URLSearchParams());
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: {
        list: { items: [{ id: "session-1" }], total: 30_000 },
        usage: undefined,
      },
      isError: false,
      isFetching: false,
      isLoading: false,
      isPlaceholderData: false,
    });
    hooks.useAgentSessionUsage.mockReturnValue({
      data: undefined,
      isError: false,
      isFetching: false,
      isPlaceholderData: false,
    });
    hooks.useAgentSessionAnalytics.mockReturnValue({
      data: { byRepository: [] },
    });
    hooks.useLocalAgentSessionUsage.mockReturnValue({
      data: undefined,
      isError: false,
    });
    hooks.useIngestProgress.mockReturnValue(null);
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        getAgentMonitorUrl: vi.fn().mockResolvedValue("http://127.0.0.1:1234"),
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

  it("asks the list read for the URL page size, not the shipped fixed one", async () => {
    mountWithUrlPageSize(URL_PAGE_SIZE);

    await waitFor(() => expect(lastListFilters()).toBeDefined());
    expect(lastListFilters()?.limit).toBe(URL_PAGE_SIZE);
    // Named, so a regression to the constant cannot be satisfied by some other
    // number happening to differ.
    expect(lastListFilters()?.limit).not.toBe(LEGACY_FIXED_PAGE_SIZE);
  });

  it("still reads at 25 for a viewer who has chosen nothing", async () => {
    mountWithUrlPageSize(null);

    await waitFor(() => expect(lastListFilters()).toBeDefined());
    expect(lastListFilters()?.limit).toBe(LEGACY_FIXED_PAGE_SIZE);
  });
});
