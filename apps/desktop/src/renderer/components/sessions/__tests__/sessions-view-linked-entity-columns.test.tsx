import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { drainedCutover } from "../../../shared-agent-sessions/__tests__/fixtures/cloud-read-cutover-fixtures";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import { SessionsView } from "../SessionsView";

/**
 * FEA-4209 / FEA-4210 (wongk review): the desktop Sessions view has to WIRE the
 * linked-entity seams, not merely leave them wireable.
 *
 * `SyncedSessionsTable` gates the `Owning project` / `Linked issues` columns on
 * a host opt-in as well as the shared `grid-table-v2` flag, and the original
 * reasoning for that gate stopped at "the desktop local producer emits neither
 * field". But the desktop has two source modes and the CLOUD one reads the same
 * HTTP list the web app does, so its rows carry both fields — which meant a
 * cloud-mode desktop with the Labs toggle on got no columns and no View-menu
 * entries on data it already had in hand.
 *
 * This asserts against the props SessionsView actually hands its two children,
 * in BOTH modes, because the defect was a missing prop rather than a wrong
 * value: an assertion that only ran in cloud mode would have been just as green
 * before the fix if it checked the local half, and vice-versa.
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

/** The props each stubbed child was last rendered with. */
const captured = vi.hoisted(() => ({
  list: null as Record<string, unknown> | null,
  toolbar: null as Record<string, unknown> | null,
}));

/** Flipped per test; read through a getter so the module mock stays hoisted. */
const coreMode = vi.hoisted(() => ({ current: "cloud" as "cloud" | "local" }));

let desktopApiDescriptor: PropertyDescriptor | undefined;

vi.mock("@repo/app/agents/components/sessions/agent-sessions-list", () => ({
  AgentSessionsListContent: (props: Record<string, unknown>) => {
    captured.list = props;
    return <div data-testid="sessions-table-body" />;
  },
}));

vi.mock("@repo/app/agents/components/sessions/sessions-toolbar", () => ({
  SessionsToolbar: (props: Record<string, unknown>) => {
    captured.toolbar = props;
    return <div data-testid="sessions-toolbar" />;
  },
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
  useFeatureFlagEnabledOptional: () => false,
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
  useDesktopCloudReadCutover: () => drainedCutover(),
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

describe("SessionsView — linked-entity column seams (FEA-4209 / FEA-4210)", () => {
  beforeEach(() => {
    desktopApiDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "desktopApi"
    );
    vi.clearAllMocks();
    captured.list = null;
    captured.toolbar = null;
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

  it("opts the CLOUD-mode list and View menu into the linked-entity columns", async () => {
    coreMode.current = "cloud";
    render(<SessionsView />);

    await waitFor(() => expect(captured.list).not.toBeNull());
    // The columns themselves…
    expect(captured.list?.showLinkedEntityColumns).toBe(true);
    // …and the route builder they need, or every issue chip would be inert on a
    // surface that can resolve a destination perfectly well.
    expect(typeof captured.list?.getIssueHref).toBe("function");
    // …and the View-menu entries, or the columns ship with no way to hide them.
    expect(captured.toolbar?.includeLinkedEntityColumns).toBe(true);
  });

  it("keeps the LOCAL-mode list and View menu out of them", async () => {
    coreMode.current = "local";
    render(<SessionsView />);

    // Rendered for real — the local producer emits neither `project` nor
    // `linkedArtifacts`, so opting in here would grow two tracks of em dashes
    // on an already ~1,000px-overflowing grid.
    await waitFor(() => expect(captured.list).not.toBeNull());
    expect(captured.list?.showLinkedEntityColumns).toBe(false);
    expect(captured.toolbar?.includeLinkedEntityColumns).toBe(false);
  });
});
