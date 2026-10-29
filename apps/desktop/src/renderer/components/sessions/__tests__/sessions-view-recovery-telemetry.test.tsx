/**
 * @description ISS-7249, review cids 3821326374 / 3821326660: the dead-end
 * retry telemetry for the treatment users actually hit, asserted against the
 * REAL rendered tree.
 *
 * This file renders the real v2 list surface, the real `SessionsEmptyState`,
 * the real `SessionsRecoveryAction` Link and a real navigation adapter, finds
 * the affordance BY ITS ACCESSIBLE NAME, and clicks it. If the precedence ever
 * flips, or the Link is re-wired to the untracked handler, the click stops
 * producing telemetry and this goes red.
 */
import { SESSIONS_RETRY_LABEL } from "@repo/app/agents/components/sessions/sessions-empty-state";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { NavigationProvider } from "@repo/navigation/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import {
  DeadEndFlowPhase,
  DeadEndFlowReason,
  DeadEndFlowState,
  DeadEndFlowTreatment,
} from "../../../../shared/dead-end-telemetry-contract";
import {
  createDesktopNavigation,
  type DesktopHashHost,
} from "../../../navigation/desktop-adapter";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import { SessionsView } from "../SessionsView";
import { SessionsViewTestProviders } from "./fixtures/sessions-view-render-fixture";

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
const setDateRange = vi.hoisted(() => vi.fn());

let desktopApiDescriptor: PropertyDescriptor | undefined;

// Deliberately NOT mocked here, unlike the sibling suite: the real list content,
// empty state and recovery Link ARE the subject.
vi.mock("@repo/app/agents/components/sessions/sessions-summary-cards", () => ({
  SessionsSummaryCards: () => <div data-testid="sessions-summary-cards" />,
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

vi.mock("../../../shared-agent-sessions/desktop-app-core-provider", () => ({
  useDesktopAppCoreMode: () => DesktopAppCoreMode.Cloud,
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

const RECOVERY_LABEL = /clear filters and reload/i;

// Minimal in-memory hash host so the desktop navigation adapter mounts without
// a real `window.location.hash` (mirrors the desktop-adapter unit test).
function createFakeHashHost(initialHash = ""): DesktopHashHost {
  let hash = initialHash;
  const listeners = new Set<() => void>();
  return {
    getHash: () => hash,
    setHash: (href) => {
      if (hash.slice(1) === href) {
        return;
      }
      hash = `#${href}`;
      for (const listener of listeners) {
        listener();
      }
    },
    onHashChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function renderSessionsOnDesktop() {
  const desktopNavigation = createDesktopNavigation(
    createFakeHashHost("#/sessions")
  );
  return render(
    <NavigationProvider adapter={desktopNavigation.adapter}>
      <SessionsView />
    </NavigationProvider>,
    // ISS-7869: the strip's connect wiring needs the auth/API adapters and an
    // ambient QueryClient, which production supplies and this suite did not.
    { wrapper: SessionsViewTestProviders }
  );
}

describe("Sessions list dead-end recovery telemetry, real tree (ISS-7249)", () => {
  let recordDeadEndTelemetry: ReturnType<typeof vi.fn>;
  let refetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    desktopApiDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "desktopApi"
    );
    vi.clearAllMocks();
    refetch = vi.fn().mockResolvedValue(undefined);
    hooks.useSharedDateRange.mockReturnValue({
      dateRange: DEFAULT_DATE_RANGE,
      setDateRange,
    });
    hooks.useSearchParamsValue.mockReturnValue(new URLSearchParams());
    hooks.useSessionsViewState.mockReturnValue({
      // ISS-6382: the ISS-4655 restore gate now holds this view's read closed
      // until the persisted view has settled, and the body renders a spinner for
      // that window. This suite's subject is the SETTLED errored read, so it
      // seeds a ready view — the state every mount reaches within
      // `VIEW_RESTORE_AUTH_DEADLINE_MS` (the latch fails OPEN), and the one the
      // other nine desktop sessions suites already seed.
      isViewReady: true,
      sortKey: null,
      sortDir: "desc",
      visibleColumns: new Set<string>(["name"]),
      columnOrder: undefined,
      setColumnOrder: vi.fn(),
      setSort: vi.fn(),
      toggleColumn: vi.fn(),
      resetView: vi.fn(),
    });
    // The treatment under test: a settled FAILED read with no rows —
    // sessions_list_unavailable / fetch_failed, the branch that reports
    // `retryOffered: true`.
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
    recordDeadEndTelemetry = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        getAgentMonitorUrl: vi.fn().mockResolvedValue({}),
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

  it("renders the recovery Link and no Retry button for the unavailable treatment", async () => {
    renderSessionsOnDesktop();

    // Positive control for the absence assertion below: the errored card really
    // did render, and this query really can find a control in it.
    const recovery = await screen.findByRole("link", { name: RECOVERY_LABEL });
    expect(recovery).toBeTruthy();
    // The precedence the stubbed sibling suite could not see. `onRetry` is
    // wired, and is still unreachable, because `errorRecoveryAction` wins.
    expect(
      screen.queryByRole("button", { name: isRetryButtonName })
    ).toBeNull();
  });

  it("records a retry when the user clicks the affordance that is actually on screen", async () => {
    renderSessionsOnDesktop();

    await waitFor(() =>
      expect(
        recordDeadEndTelemetry.mock.calls.some(
          (call) => call[0]?.phase === DeadEndFlowPhase.Rendered
        )
      ).toBe(true)
    );
    const rendered = recordDeadEndTelemetry.mock.calls.find(
      (call) => call[0]?.phase === DeadEndFlowPhase.Rendered
    )?.[0];
    expect(rendered).toMatchObject({
      treatment: DeadEndFlowTreatment.SessionsListUnavailable,
      state: DeadEndFlowState.Unavailable,
      reason: DeadEndFlowReason.FetchFailed,
      retryOffered: true,
    });

    fireEvent.click(await screen.findByRole("link", { name: RECOVERY_LABEL }));

    // The claim `retryOffered: true` makes is now observable end to end: the one
    // affordance on screen produces the attempt record.
    await waitFor(() =>
      expect(
        recordDeadEndTelemetry.mock.calls.some(
          (call) => call[0]?.phase === DeadEndFlowPhase.RetryAttempted
        )
      ).toBe(true)
    );
    const attempted = recordDeadEndTelemetry.mock.calls.find(
      (call) => call[0]?.phase === DeadEndFlowPhase.RetryAttempted
    )?.[0];
    expect(attempted?.retryAttempt).toBe(1);
    expect(attempted?.treatment).toBe(
      DeadEndFlowTreatment.SessionsListUnavailable
    );

    // Telemetry must not replace the behavior it observes: the real reset still
    // ran, clearing the date window back to the default.
    expect(setDateRange).toHaveBeenCalledWith(DEFAULT_DATE_RANGE);
  });

  it("leaves a modified click untracked, because it does not retry this tab", async () => {
    renderSessionsOnDesktop();
    await waitFor(() => expect(recordDeadEndTelemetry).toHaveBeenCalled());
    recordDeadEndTelemetry.mockClear();

    // A Cmd-click opens the clean list in a new tab and deliberately leaves this
    // tab's scope alone, so nothing was retried here and nothing may be counted.
    fireEvent.click(await screen.findByRole("link", { name: RECOVERY_LABEL }), {
      metaKey: true,
    });

    expect(setDateRange).not.toHaveBeenCalled();
    expect(
      recordDeadEndTelemetry.mock.calls.some(
        (call) => call[0]?.phase === DeadEndFlowPhase.RetryAttempted
      )
    ).toBe(false);
  });
});

/** Anchored: the fallback control is named exactly its Retry label and nothing else. */
function isRetryButtonName(name: string): boolean {
  return name.toLowerCase() === SESSIONS_RETRY_LABEL.toLowerCase();
}
