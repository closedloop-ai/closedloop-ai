import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { SHARED_AGENT_SESSIONS_TRANSIENT_ERROR_CODE } from "../../../../shared/shared-agent-sessions-contract";
import { TransientSourceError } from "../../../shared/transient-source-error";
import { signedOutCutover } from "../../../shared-agent-sessions/__tests__/fixtures/cloud-read-cutover-fixtures";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import { SessionsView } from "../SessionsView";

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

// The real sessions-list content routes `isSyncing` to the quiet reconnecting
// empty state and an errored (non-syncing) read to the hard "Couldn't load
// sessions" card; render a stand-in that echoes the two signals so the test asserts
// which surface SessionsView selected without depending on the shared component's
// internal copy.
vi.mock("@repo/app/agents/components/sessions/agent-sessions-list", () => ({
  AgentSessionsListContent: (props: {
    isSyncing?: boolean;
    emptySignals?: { isUnavailable?: boolean };
  }) => (
    <div
      data-is-syncing={props.isSyncing ? "true" : "false"}
      data-is-unavailable={props.emptySignals?.isUnavailable ? "true" : "false"}
      data-testid="sessions-table-body"
    />
  ),
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

// LOCAL mode — the surface the ticket reports. displayState is driven by the local
// source status resolved below (ready), not collapsed to "ready" like the cloud
// tests.
vi.mock("../../../shared-agent-sessions/desktop-app-core-provider", () => ({
  useDesktopAppCoreMode: () => DesktopAppCoreMode.Local,
  // ISS-5477: SessionsView derives the read-source badge detail from the
  // same provider, so this factory has to answer for it too.
  useDesktopCloudReadCutover: () => signedOutCutover(),
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
  render(<SessionsView />);
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

    const body = screen.getByTestId("sessions-table-body");
    // The table routes to the quiet syncing/reconnecting surface, never the hard
    // "something went wrong" card.
    expect(body.getAttribute("data-is-syncing")).toBe("true");
    expect(body.getAttribute("data-is-unavailable")).toBe("true");
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
      error: new Error("SQLITE_CORRUPT: database disk image is malformed"),
      isFetching: false,
      isPlaceholderData: false,
      refetch: vi.fn().mockResolvedValue(undefined),
    });

    await renderSettled();

    const body = screen.getByTestId("sessions-table-body");
    // A fatal error is unavailable but NOT syncing → the hard error + Retry surface.
    expect(body.getAttribute("data-is-syncing")).toBe("false");
    expect(body.getAttribute("data-is-unavailable")).toBe("true");
  });
});
