import { SESSION_LIST_MAX_OFFSET } from "@repo/api/src/types/agent-session-list-limits";
import { SESSIONS_PAGE_PARAM } from "@repo/app/agents/lib/session-pagination";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import { SessionsView } from "../SessionsView";
import { PAGE_SIZE } from "../sessions-render-model";
import { SessionsViewTestProviders } from "./fixtures/sessions-view-render-fixture";

/**
 * ISS-9074: the Cloud/Local split lives in ONE expression in `SessionsView`
 * (`isCloudMode ? SESSION_LIST_MAX_OFFSET : undefined`), and nothing that tests
 * `buildSessionsRenderModel` in isolation can reach it — hardcode that ternary
 * to `undefined` and every render-model case stays green while the desktop
 * silently starts asking the cloud route for offsets it rejects with a 400.
 *
 * So this mounts the real view and asserts the OUTGOING list read, once per
 * mode, from one `?page=` the cap does and does not apply to.
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

// Holds the mode the mocked provider answers with. A plain string would
// hardcode a contract value; this is set from `DesktopAppCoreMode` per case,
// which `vi.hoisted` cannot reference because it runs before the imports.
const coreMode = vi.hoisted(() => ({ current: "" }));

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));

let desktopApiDescriptor: PropertyDescriptor | undefined;

// ISS-8909: `SessionsView` mounts the v2 surface unconditionally now, so the v1
// body marker these cases read is no longer rendered.
// The subject here is the HOST's decision — which read state and how many rows
// it hands down — so the surface is stood down to the same marker, echoing the
// same two signals. The real v2 surface is covered by its own suites.
vi.mock("../sessions-v2-view", () => ({
  SessionsV2View: (props: {
    input: { isSessionsTableLoading?: boolean; items?: unknown[] };
  }) => (
    <div
      data-is-loading={props.input.isSessionsTableLoading ? "true" : "false"}
      data-item-count={props.input.items?.length ?? 0}
      data-testid="sessions-table-body"
    />
  ),
}));

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

// One-based in the URL, so this is page index 499 — the first page past the
// cloud ceiling at PAGE_SIZE 25 (499 * 25 = 12,475 > 10,000).
const REQUESTED_PAGE = 500;
const REQUESTED_PAGE_INDEX = REQUESTED_PAGE - 1;
const UNCAPPED_OFFSET = REQUESTED_PAGE_INDEX * PAGE_SIZE;

const lastListFilters = () => {
  const calls = hooks.useAgentSessionsPageData.mock.calls;
  return calls.at(-1)?.[0];
};

describe("SessionsView caps the list offset in Cloud mode only", () => {
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
    hooks.useSearchParamsValue.mockReturnValue(
      new URLSearchParams([[SESSIONS_PAGE_PARAM, String(REQUESTED_PAGE)]])
    );
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
        list: { items: [{ id: "session-1" }], total: 30_000 },
        usage: undefined,
      },
      isFetching: false,
      isPlaceholderData: false,
      isLoading: false,
      isError: false,
    });
    hooks.useAgentSessionUsage.mockReturnValue({
      data: undefined,
      isFetching: false,
      isPlaceholderData: false,
      isError: false,
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
        // Ready, so the LOCAL case below is gated ON and actually issues a read.
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

  it("sends the ceiling, not the requested offset, when the source is the cloud route", async () => {
    coreMode.current = DesktopAppCoreMode.Cloud;

    render(<SessionsView />, { wrapper: SessionsViewTestProviders });

    await waitFor(() => expect(lastListFilters()).toBeDefined());
    expect(lastListFilters()).toMatchObject({
      limit: PAGE_SIZE,
      offset: SESSION_LIST_MAX_OFFSET,
    });
    // Not merely "some smaller number": the uncapped offset is what the cloud
    // route rejects, so name it rather than let a different bug satisfy this.
    expect(lastListFilters()?.offset).not.toBe(UNCAPPED_OFFSET);
  });

  it("sends the requested offset when the source is local SQLite, which has no ceiling", async () => {
    coreMode.current = DesktopAppCoreMode.Local;

    render(<SessionsView />, { wrapper: SessionsViewTestProviders });

    await waitFor(() => expect(lastListFilters()).toBeDefined());
    expect(lastListFilters()).toMatchObject({
      limit: PAGE_SIZE,
      offset: UNCAPPED_OFFSET,
    });
    // The cap must not have leaked across the split.
    expect(lastListFilters()?.offset).toBeGreaterThan(SESSION_LIST_MAX_OFFSET);
  });
});
