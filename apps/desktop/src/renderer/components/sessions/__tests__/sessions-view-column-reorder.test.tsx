import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { drainedCutover } from "../../../shared-agent-sessions/__tests__/fixtures/cloud-read-cutover-fixtures";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import { SessionsView } from "../SessionsView";

/**
 * FEA-4150 (wongk review): the desktop SessionsView column-reorder/reset prop
 * chain (`SessionsView` → `SessionsTableBody` → `AgentSessionsListContent` →
 * shared `SessionsTable`; and the toolbar's `onResetView`) had NO renderer
 * coverage — both existing SessionsView suites mock `AgentSessionsListContent`
 * and `useSessionsViewState`, so a dropped `onColumnOrderChange` / `onResetView`
 * callback still shipped green. This mounts SessionsView with the REAL shared
 * table (not mocked) and a deterministic, non-default persisted column order,
 * then proves the Electron adapter forwards the order to the table and drives
 * `setColumnOrder` on a keyboard reorder — mirroring the BranchesView reorder
 * wiring test. The toolbar is mocked to a marker that captures its `onResetView`
 * prop so the reset wiring is asserted too.
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

const wiring = vi.hoisted(() => ({
  setColumnOrderMock: vi.fn(),
  resetViewMock: vi.fn(),
  toolbarPropsMock: vi.fn(),
}));

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
}));

let desktopApiDescriptor: PropertyDescriptor | undefined;

// The real shared table renders — only the surrounding data-fetching siblings
// and the controlled toolbar are stubbed. The toolbar marker records its props
// so the reset wiring (`onResetView` → hook `resetView`) is asserted below.
vi.mock("@repo/app/agents/components/sessions/sessions-toolbar", () => ({
  SessionsToolbar: (props: { onResetView?: () => void }) => {
    wiring.toolbarPropsMock(props);
    return <div data-testid="sessions-toolbar" />;
  },
}));

// The session name is a navigation-port `Link`; stub it to a plain anchor so the
// real table renders without standing up the navigation adapter (this test is
// about reorder/reset wiring, not routing).
vi.mock("@repo/navigation/link", () => ({
  Link: (props: { href?: string; children?: React.ReactNode }) => (
    <a href={props.href}>{props.children}</a>
  ),
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
  // FEA-3639: SessionsView renders the file-access banner, which reads this
  // hook. No block here → empty, so the banner renders nothing.
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
  // The real table's SessionSyncStatusBadge reads the optional flag hook.
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

// A non-default persisted order (Repository before Owner) over a visible set
// with both columns, so the shared table renders reorder handles for each —
// proving the `columnOrder` + `onColumnOrderChange` wiring reached the real
// table on the Electron surface, not just the web page.
const PERSISTED_ORDER = ["repo", "owner", "status"] as const;
const VISIBLE_COLUMNS = new Set<string>(["owner", "status", "repo"]);
const REORDER_REPOSITORY_HANDLE = "Reorder Repository column, use arrow keys";
const REORDER_OWNER_HANDLE = "Reorder Owner column, use arrow keys";

describe("SessionsView column reorder/reset wiring (FEA-4150, Electron surface)", () => {
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
      sortKey: null,
      sortDir: "desc",
      visibleColumns: VISIBLE_COLUMNS,
      columnOrder: PERSISTED_ORDER,
      setColumnOrder: wiring.setColumnOrderMock,
      setSort: vi.fn(),
      toggleColumn: vi.fn(),
      resetView: wiring.resetViewMock,
    });
    // FEA-4157: the table + summary cards read from ONE combined
    // `useAgentSessionsPageData` ({ list, usage }). The reorder wiring under test
    // needs the real shared table to render a row, so the fixture item rides on
    // `list.items`; the facet-option toolbar read stays on `useAgentSessionUsage`.
    hooks.useAgentSessionsPageData.mockReturnValue({
      data: {
        list: {
          items: [createAgentSessionListItemFixture()],
          total: 1,
          readSource: undefined,
        },
        usage: {
          totalSessions: 1,
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
        totalSessions: 1,
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
    hooks.useLocalAgentSessionUsage.mockReturnValue({
      data: {
        totalSessions: 1,
        totalInputTokens: 1000,
        totalOutputTokens: 250,
        byRepository: [],
      },
      isError: false,
    });
    hooks.useIngestProgress.mockReturnValue(null);
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
    if (desktopApiDescriptor) {
      Object.defineProperty(window, "desktopApi", desktopApiDescriptor);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
    desktopApiDescriptor = undefined;
  });

  it("forwards the persisted order to the real table and drives setColumnOrder on reorder", async () => {
    render(<SessionsView />);

    // The real shared table rendered its reorder handles (it is NOT mocked here),
    // proving the desktop adapter forwarded `columnOrder`/`onColumnOrderChange`
    // all the way to the shared SessionsTable on the Electron surface.
    const repoHandle = await screen.findByRole("button", {
      name: REORDER_REPOSITORY_HANDLE,
    });
    expect(
      screen.getByRole("button", { name: REORDER_OWNER_HANDLE })
    ).toBeDefined();

    // Keyboard-reorder Repository one slot right (past Owner). The desktop
    // adapter merges the reordered VISIBLE subset back into the full data order
    // before calling the hook's setColumnOrder.
    fireEvent.keyDown(repoHandle, { key: "ArrowRight" });
    expect(wiring.setColumnOrderMock).toHaveBeenCalledTimes(1);
    const nextOrder = wiring.setColumnOrderMock.mock.calls[0][0] as string[];
    expect(nextOrder.indexOf("owner")).toBeLessThan(nextOrder.indexOf("repo"));
    // The full data order is emitted (hidden/absent columns retained), not the
    // rendered subset alone — e.g. a column outside the visible set survives.
    expect(nextOrder).toContain("cost");
  });

  it("wires the toolbar's onResetView to the hook's resetView", async () => {
    render(<SessionsView />);
    await screen.findByRole("button", { name: REORDER_REPOSITORY_HANDLE });

    // The desktop adapter passes the hook's `resetView` down as the toolbar's
    // `onResetView`; invoking it drives the reset (a dropped wiring would ship
    // green with both suites mocking the toolbar out).
    const toolbarProps = wiring.toolbarPropsMock.mock.calls.at(-1)?.[0] as {
      onResetView?: () => void;
    };
    expect(toolbarProps?.onResetView).toBeTypeOf("function");
    toolbarProps.onResetView?.();
    expect(wiring.resetViewMock).toHaveBeenCalledTimes(1);
  });
});
