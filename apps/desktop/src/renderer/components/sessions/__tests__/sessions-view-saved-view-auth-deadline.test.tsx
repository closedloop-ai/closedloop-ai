import { SessionsToolbarMountHarness } from "@repo/app/agents/components/sessions/__tests__/sessions-toolbar-mount-harness";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import { VIEW_RESTORE_AUTH_DEADLINE_MS } from "@repo/app/shared/hooks/use-table-view-storage-key";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../../shared/local-session-source-status";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import { SessionsView } from "../SessionsView";

/**
 * ISS-8262 (whitlockk review, PR #6123): the desktop Sessions surface's FIRST
 * `pageData` request must carry the SAVED sort when auth never resolves.
 *
 * The sibling launched-Electron spec
 * (`apps/desktop/test/e2e/sessions-saved-view-restore-gate.spec.ts`) cannot
 * discriminate this: its profile's auth bridge settles as signed out well inside
 * `VIEW_RESTORE_AUTH_DEADLINE_MS`, so `storageKey` resolves to the legacy key on
 * its own and the read carries the saved sort with or without the deadline
 * fallback. This suite is the coverage that DOES discriminate it, at the layer
 * where auth can be held unresolved deterministically — no timing race, and no
 * dependency on whether the main process's startup auth push lands before the
 * renderer attaches its listener.
 *
 * The REAL `useSessionsViewState` runs (it is deliberately not mocked, unlike
 * every sibling `sessions-view-*` suite), so this exercises the shipped wiring
 * end to end: the persisted-view hook's key resolution, `isViewReady`, and
 * `SessionsView`'s own `pageDataFilters` / `enabled` derivation. A unit test on
 * the hook alone cannot prove that `sortKey` reaches the request.
 *
 * Local mode with a `ready` local source, matching the surface this ticket is
 * about: every desktop profile today is signed out.
 */

const SAVED_VIEW_STORAGE_KEY = "sessions:saved-view:sessions:desktop";

/**
 * `started` / `desc` deliberately — the default view is `lastActivity` / `desc`
 * (`useSessionsViewState`), so a request issued on the DEFAULTS is
 * distinguishable on the sort key rather than only on its absence.
 */
const SAVED_VIEW = {
  columnOrder: [],
  hiddenColumns: [],
  sortDir: "desc",
  sortKey: "started",
} as const;

type CapturedRead = { sortBy?: string; sortDir?: string; enabled: boolean };

const { hooks, reads } = vi.hoisted(() => ({
  hooks: {
    useAgentSessionAnalytics: vi.fn(),
    useAgentSessionsPageData: vi.fn(),
    useAgentSessionUsage: vi.fn(),
    useLocalAgentSessionUsage: vi.fn(),
    useIngestProgress: vi.fn(),
    useSharedDateRange: vi.fn(),
    useSearchParamsValue: vi.fn(),
  },
  reads: { calls: [] as CapturedRead[] },
}));

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessionAnalytics: hooks.useAgentSessionAnalytics,
  useAgentSessionsPageData: hooks.useAgentSessionsPageData,
  useAgentSessionUsage: hooks.useAgentSessionUsage,
  useCancelAgentSessionsPageData: () => () => undefined,
}));

vi.mock("@repo/app/agents/hooks/use-has-connected-agent", () => ({
  useHasConnectedAgent: () => ({ data: undefined }),
}));

vi.mock("@repo/app/shared/hooks/use-shared-date-range", () => ({
  useSharedDateRange: hooks.useSharedDateRange,
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({
    back: vi.fn(),
    navigate: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
}));

vi.mock("@repo/navigation/use-path", () => ({ usePath: () => "/sessions" }));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: hooks.useSearchParamsValue,
}));

vi.mock("../use-local-agent-session-usage", () => ({
  useLocalAgentSessionUsage: hooks.useLocalAgentSessionUsage,
}));

vi.mock("../agent-coaching-tips", () => ({
  AgentCoachingTips: () => <div data-testid="agent-coaching-tips" />,
}));

vi.mock("../../../hooks/use-ingest-progress", () => ({
  useIngestProgress: hooks.useIngestProgress,
}));

vi.mock("../../../hooks/use-file-access-blocks", () => ({
  useFileAccessBlocks: () => [],
}));

vi.mock("../../../shared-agent-sessions/desktop-app-core-provider", () => ({
  useDesktopAppCoreMode: () => DesktopAppCoreMode.Local,
  useDesktopLocalReadReason: () => undefined,
}));

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: { status: DesktopAuthStatus.SignedOut },
    beginSignIn: vi.fn().mockResolvedValue({ ok: true }),
    cancelSignIn: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
  }),
}));

// Partial: only the local-source probe is pinned, so the read gate's OTHER
// conjunct is satisfied deterministically. `useSessionsReadGate` itself — the
// thing that consumes it — stays real.
vi.mock("../sessions-view-source-status", async (original) => {
  const actual =
    await original<typeof import("../sessions-view-source-status")>();
  return {
    ...actual,
    useLocalSessionSourceStatus: () => ({
      status: LOCAL_SESSION_SOURCE_STATUSES.ready,
      recheck: vi.fn(),
    }),
  };
});

/**
 * Mount with the shared auth port held UNRESOLVED — the state a Clerk mount that
 * never hydrates, or a desktop auth bridge whose pull never answers, stays in
 * forever. Innermost provider wins, so this overrides the settled adapter the
 * harness supplies.
 */
function renderWithUnresolvedAuth() {
  // `act` around the mount so the post-mount restore effect and the summary
  // band's own follow-up commit are flushed inside it — the tree settles under
  // fake timers with no pending-update warning.
  act(() => {
    render(
      <SessionsToolbarMountHarness>
        <AuthAdapterProvider
          adapter={createStaticAuthAdapter({ isLoaded: false, userId: null })}
        >
          <SessionsView />
        </AuthAdapterProvider>
      </SessionsToolbarMountHarness>
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  reads.calls = [];
  hooks.useAgentSessionsPageData.mockImplementation(
    (
      filters: { sortBy?: string; sortDir?: string },
      options: { enabled?: boolean }
    ) => {
      reads.calls.push({
        enabled: options?.enabled === true,
        sortBy: filters?.sortBy,
        sortDir: filters?.sortDir,
      });
      return {
        data: undefined,
        isError: false,
        isFetching: false,
        isLoading: false,
        isPlaceholderData: false,
      };
    }
  );
  hooks.useSharedDateRange.mockReturnValue({
    dateRange: "7d",
    setDateRange: vi.fn(),
  });
  hooks.useSearchParamsValue.mockReturnValue(new URLSearchParams());
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
});

afterEach(cleanup);

describe("ISS-8262 — desktop Sessions reads the saved view past the auth deadline", () => {
  it("issues no request under the DEFAULT sort once the deadline opens the gate", () => {
    localStorage.setItem(SAVED_VIEW_STORAGE_KEY, JSON.stringify(SAVED_VIEW));
    vi.useFakeTimers();
    try {
      renderWithUnresolvedAuth();

      // Before the deadline the gate is shut: auth may yet name a per-user key.
      expect(reads.calls.some((call) => call.enabled)).toBe(false);

      act(() => vi.advanceTimersByTime(VIEW_RESTORE_AUTH_DEADLINE_MS));

      // Every request the surface actually issued — a single one carrying the
      // default sort is the wasted first pagination this ticket is about, and
      // `enabled: false` calls are not requests at all.
      const issued = reads.calls.filter((call) => call.enabled);
      expect(issued.length).toBeGreaterThan(0);
      for (const call of issued) {
        expect(call.sortBy).toBe(SAVED_VIEW.sortKey);
        expect(call.sortDir).toBe(SAVED_VIEW.sortDir);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("still opens the gate when there is no saved view to restore", () => {
    vi.useFakeTimers();
    try {
      renderWithUnresolvedAuth();
      act(() => vi.advanceTimersByTime(VIEW_RESTORE_AUTH_DEADLINE_MS));

      // The positive sibling for the assertion above: the deadline must remain a
      // way to LOAD, so a profile with nothing saved still reads — on the
      // defaults, which is correct there. Without this, a regression that simply
      // never opened the gate would leave the first test vacuously green.
      const issued = reads.calls.filter((call) => call.enabled);
      expect(issued.length).toBeGreaterThan(0);
      expect(issued.every((call) => call.sortBy !== SAVED_VIEW.sortKey)).toBe(
        true
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
