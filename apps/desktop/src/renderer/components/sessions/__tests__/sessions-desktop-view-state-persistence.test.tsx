import {
  SESSIONS_TOOLBAR_OPTIONS_BUTTON,
  SessionsToolbarMountHarness,
} from "@repo/app/agents/components/sessions/__tests__/sessions-toolbar-mount-harness";
import { useSessionsViewState } from "@repo/app/agents/hooks/use-sessions-view-state";
import {
  SessionSortDir as SortDir,
  SessionSortKey as SortKey,
} from "@repo/app/agents/lib/session-sort-group";
import {
  SESSIONS_SAVED_VIEW_HIDDEN_VERSION,
  SESSIONS_SAVED_VIEW_VERSION,
} from "@repo/app/agents/lib/sessions-saved-view-migration";
import {
  SESSIONS_COST_COLUMN_ID,
  SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS,
  SESSIONS_OWNER_COLUMN_ID,
} from "@repo/app/agents/lib/sessions-table-columns";
import { renderHookWithAuth } from "@repo/app/shared/hooks/__tests__/persisted-table-view-state.test-support";
import { MAX_SERIALIZED_TABLE_VIEW_LENGTH } from "@repo/app/shared/hooks/persisted-table-view-snapshot";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../../shared/local-session-source-status";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import { DesktopAuthProvider } from "../../../shared-agent-sessions/desktop-auth-provider";
import { SessionsView } from "../SessionsView";

/**
 * ISS-9449 (PRD-716): the desktop Sessions view state — sort, hidden columns,
 * column order, migrations, corrupt-input degradation, the oversized-carry
 * shed, and the offline round trip — flows through the SAME shared hook web
 * uses (`useSessionsViewState` -> `usePersistedTableViewState`), keyed by
 * `sessions:saved-view:sessions:desktop[:u:<userId>]`. No sibling suite in this
 * directory exercises the REAL hook against REAL localStorage across an
 * auth transition; the closest, `sessions-view-saved-view-auth-deadline.test.tsx`,
 * only covers auth that never resolves.
 */

const LEGACY_KEY = "sessions:saved-view:sessions:desktop";
const PER_USER_KEY = "sessions:saved-view:sessions:desktop:u:user-1";
const SIGNED_IN = { isLoaded: true, userId: "user-1" };
const SIGNED_OUT = { isLoaded: true, userId: null };

function mountSessionsView(auth: { isLoaded: boolean; userId: string | null }) {
  return renderHookWithAuth(
    () => useSessionsViewState("sessions:desktop"),
    auth
  );
}

function savedView(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    columnOrder: [],
    hiddenColumns: [],
    sortDir: SortDir.Desc,
    sortKey: SortKey.Started,
    ...overrides,
  });
}

describe("useSessionsViewState persistence (ISS-9449)", () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("waits for auth before restoring, then reads the per-user key over the legacy one", () => {
    localStorage.setItem(LEGACY_KEY, savedView({ sortKey: SortKey.Cost }));
    const perUserSeed = savedView({ sortKey: SortKey.Started });
    localStorage.setItem(PER_USER_KEY, perUserSeed);

    const { result, setAuth } = mountSessionsView({
      isLoaded: false,
      userId: null,
    });

    // Auth unresolved: the hook is on its own defaults, and nothing under
    // either key was touched — no read raced auth, no write clobbered it.
    expect(result.current.sortKey).toBe(SortKey.LastActivity);
    expect(localStorage.getItem(LEGACY_KEY)).toBe(
      savedView({ sortKey: SortKey.Cost })
    );
    expect(localStorage.getItem(PER_USER_KEY)).toBe(perUserSeed);

    setAuth(SIGNED_IN);

    // The per-user view restored, not the legacy one sitting under a
    // different sort — proves the per-user key wins once auth resolves.
    expect(result.current.sortKey).toBe(SortKey.Started);

    act(() => {
      result.current.setSort(SortKey.Duration);
    });

    expect(JSON.parse(localStorage.getItem(PER_USER_KEY) ?? "{}").sortKey).toBe(
      SortKey.Duration
    );
    // The legacy key was never this session's write target, so it is
    // untouched byte-for-byte by the per-user edit.
    expect(localStorage.getItem(LEGACY_KEY)).toBe(
      savedView({ sortKey: SortKey.Cost })
    );
  });

  it("migrates a legacy view to the per-user key on first signed-in restore", async () => {
    const legacySeed = savedView({ sortKey: SortKey.Cost });
    localStorage.setItem(LEGACY_KEY, legacySeed);
    expect(localStorage.getItem(PER_USER_KEY)).toBeNull();

    const { result } = mountSessionsView(SIGNED_IN);

    expect(result.current.sortKey).toBe(SortKey.Cost);

    await waitFor(() => {
      expect(localStorage.getItem(PER_USER_KEY)).not.toBeNull();
    });
    expect(JSON.parse(localStorage.getItem(PER_USER_KEY) ?? "{}").sortKey).toBe(
      SortKey.Cost
    );
    // The legacy record itself is untouched by the migration write.
    expect(localStorage.getItem(LEGACY_KEY)).toBe(legacySeed);
  });

  it("degrades to defaults on non-JSON bytes without throwing", () => {
    localStorage.setItem(PER_USER_KEY, "{not json");

    let mounted: ReturnType<typeof mountSessionsView> | undefined;
    expect(() => {
      mounted = mountSessionsView(SIGNED_IN);
    }).not.toThrow();
    const view = mounted?.result.current;
    expect(view?.sortKey).toBe(SortKey.LastActivity);
    for (const hiddenId of SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS) {
      expect(view?.visibleColumns.has(hiddenId)).toBe(false);
    }
    expect(view?.visibleColumns.has(SESSIONS_OWNER_COLUMN_ID)).toBe(true);
  });

  it("degrades to defaults on a malformed enum value", () => {
    localStorage.setItem(
      PER_USER_KEY,
      JSON.stringify({ sortDir: "sideways", sortKey: SortKey.Started })
    );
    const { result } = mountSessionsView(SIGNED_IN);

    // The whole view fails `savedViewSchema.safeParse`, not only `sortDir` —
    // `sortKey` does not survive either, which is what distinguishes this
    // from the per-axis corruption case below.
    expect(result.current.sortKey).toBe(SortKey.LastActivity);
    expect(result.current.sortDir).toBe(SortDir.Desc);
  });

  it("degrades per corrupt axis independently, re-running the column migrations", async () => {
    localStorage.setItem(
      PER_USER_KEY,
      JSON.stringify({
        columnOrder: [SESSIONS_COST_COLUMN_ID, 7, null],
        hiddenColumns: 42,
        hiddenColumnsVersion: -1,
        savedViewVersion: 99_999,
        sortDir: SortDir.Desc,
        sortKey: SortKey.Started,
        viewStateVersions: { columnOrder: 99_999 },
      })
    );
    const { result } = mountSessionsView(SIGNED_IN);

    // The sort axis is unaffected by the corruption on the other two.
    expect(result.current.sortKey).toBe(SortKey.Started);
    // `columnOrder` degrades to `[]` (non-array/non-string entries dropped),
    // leaving only the one well-formed string entry.
    expect(result.current.columnOrder).toEqual([SESSIONS_COST_COLUMN_ID]);
    // `hiddenColumns: 42` degrades to `[]`, and BOTH version markers are out
    // of `[0, 1000]` so they collapse to unversioned (0) — which means every
    // hidden-columns migration step re-runs against the empty set. The
    // result is NOT an empty hidden set: the migrations hide (at least) the
    // shipped default-hidden columns, and an unrelated toggleable column
    // stays visible.
    for (const hiddenId of SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS) {
      expect(result.current.visibleColumns.has(hiddenId)).toBe(false);
    }
    expect(result.current.visibleColumns.has(SESSIONS_OWNER_COLUMN_ID)).toBe(
      true
    );

    // Once re-persisted, the stamps read as THIS build's versions — the
    // migration ran to completion and the record says so.
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(PER_USER_KEY) ?? "{}");
      expect(stored.viewStateVersions?.columnOrder).toBe(
        SESSIONS_SAVED_VIEW_VERSION
      );
      expect(stored.viewStateVersions?.hiddenColumns).toBe(
        SESSIONS_SAVED_VIEW_HIDDEN_VERSION
      );
    });
  });

  it("resetView rewrites defaults, drops carried/unknown ids, and stamps current versions", async () => {
    localStorage.setItem(
      PER_USER_KEY,
      JSON.stringify({
        columnOrder: ["future-column", SESSIONS_OWNER_COLUMN_ID, "status"],
        hiddenColumns: [SESSIONS_OWNER_COLUMN_ID, "future-column"],
        hiddenColumnsVersion: 0,
        savedViewVersion: 0,
        sortDir: SortDir.Desc,
        sortKey: SortKey.Started,
        viewStateVersions: { columnOrder: 0, hiddenColumns: 0 },
      })
    );
    const { result } = mountSessionsView(SIGNED_IN);
    await waitFor(() => {
      expect(localStorage.getItem(PER_USER_KEY)).not.toBeNull();
    });

    act(() => {
      result.current.resetView();
    });

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(PER_USER_KEY) ?? "{}");
      expect(new Set(stored.hiddenColumns)).toEqual(
        new Set(SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS)
      );
      expect(stored.columnOrder).toEqual([]);
      expect(stored.hiddenColumns).not.toContain("future-column");
      expect(stored.columnOrder).not.toContain("future-column");
      expect(stored.viewStateVersions.columnOrder).toBe(
        SESSIONS_SAVED_VIEW_VERSION
      );
      expect(stored.viewStateVersions.hiddenColumns).toBe(
        SESSIONS_SAVED_VIEW_HIDDEN_VERSION
      );
    });
  });

  it("persists an offline edit and restores it across a remount, with no fetch", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("offline"));
    const first = mountSessionsView(SIGNED_IN);
    act(() => {
      first.result.current.toggleColumn(SESSIONS_OWNER_COLUMN_ID);
      first.result.current.setSort(SortKey.Cost);
    });
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(PER_USER_KEY) ?? "{}");
      expect(stored.sortKey).toBe(SortKey.Cost);
      expect(stored.hiddenColumns).toContain(SESSIONS_OWNER_COLUMN_ID);
    });
    first.unmount();

    const second = mountSessionsView(SIGNED_IN);
    expect(second.result.current.sortKey).toBe(SortKey.Cost);
    expect(
      second.result.current.visibleColumns.has(SESSIONS_OWNER_COLUMN_ID)
    ).toBe(false);
    second.unmount();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sheds an oversized carried column id on the first re-persist", async () => {
    const hugeId = "x".repeat(70_000);
    localStorage.setItem(
      PER_USER_KEY,
      JSON.stringify({
        columnOrder: [hugeId, SESSIONS_COST_COLUMN_ID],
        hiddenColumns: [],
        sortDir: SortDir.Desc,
        sortKey: SortKey.Started,
      })
    );
    mountSessionsView(SIGNED_IN);

    await waitFor(() => {
      const raw = localStorage.getItem(PER_USER_KEY);
      expect(raw).not.toBeNull();
      expect(raw).not.toContain(hugeId);
      expect((raw as string).length).toBeLessThan(
        MAX_SERIALIZED_TABLE_VIEW_LENGTH
      );
    });
  });

  it("uses the legacy un-namespaced key when signed out", async () => {
    const { result } = mountSessionsView(SIGNED_OUT);

    act(() => {
      result.current.setSort(SortKey.Cost);
    });

    await waitFor(() => {
      expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull();
    });
    expect(localStorage.getItem(PER_USER_KEY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Component wiring: the same restore/write path, mounted through the real
// SessionsView + the real DesktopAuthProvider (not the static auth adapter
// every sibling `sessions-view-*` suite uses) and the real v2 list surface,
// stubbing only the desktop gateway's auth bridge. Proves SessionsView ->
// useSessionsViewState -> localStorage end to end, not just the hook in
// isolation above.
// ---------------------------------------------------------------------------

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

/**
 * ISS-8909: the toolbar is no longer a component this shell mounts — it is
 * internal to the v2 surface, which receives `onResetView`. So the second half
 * of the case below is driven through the SHIPPED control (the Options menu's
 * "Reset view" row) rather than a captured prop: the wire is only worth
 * anything if it reaches the row the reader clicks.
 */
const RESET_VIEW_MENU_ITEM = "Reset view";

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

// Deliberately NOT mocked: `../../../shared-agent-sessions/desktop-auth-provider`
// (the real `DesktopAuthProvider` mounts below) and
// `@repo/app/agents/hooks/use-sessions-view-state` (the real hook runs).

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

const COMPONENT_LEGACY_KEY = "sessions:saved-view:sessions:desktop";
const COMPONENT_PER_USER_KEY = "sessions:saved-view:sessions:desktop:u:user-1";

let desktopApiDescriptor: PropertyDescriptor | undefined;

function stubAuthenticatedDesktopApi() {
  desktopApiDescriptor = Object.getOwnPropertyDescriptor(window, "desktopApi");
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getDesktopAuthState: vi.fn(() =>
        Promise.resolve({
          organizationId: null,
          status: DesktopAuthStatus.Authenticated,
          userId: "user-1",
        })
      ),
      onDesktopAuthStateChanged: vi.fn(() => () => undefined),
    },
  });
}

function restoreDesktopApi() {
  if (desktopApiDescriptor) {
    Object.defineProperty(window, "desktopApi", desktopApiDescriptor);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
  desktopApiDescriptor = undefined;
}

describe("SessionsView -> useSessionsViewState wiring under the real DesktopAuthProvider (ISS-9449)", () => {
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

  afterEach(() => {
    cleanup();
    restoreDesktopApi();
  });

  it("reads the saved per-user sort on the real mount, then rewrites defaults through the real toolbar's onResetView", async () => {
    localStorage.setItem(
      COMPONENT_PER_USER_KEY,
      savedView({ sortKey: SortKey.Started })
    );
    stubAuthenticatedDesktopApi();

    act(() => {
      render(
        <SessionsToolbarMountHarness>
          <DesktopAuthProvider>
            <SessionsView />
          </DesktopAuthProvider>
        </SessionsToolbarMountHarness>
      );
    });

    await waitFor(() => {
      expect(reads.calls.some((call) => call.enabled)).toBe(true);
    });
    for (const call of reads.calls.filter((c) => c.enabled)) {
      expect(call.sortBy).toBe(SortKey.Started);
      expect(call.sortDir).toBe(SortDir.Desc);
    }

    // The real toolbar's own row, opened from the real Options menu.
    fireEvent.pointerDown(
      screen.getByRole("button", { name: SESSIONS_TOOLBAR_OPTIONS_BUTTON }),
      { button: 0, ctrlKey: false }
    );
    fireEvent.click(
      within(screen.getByRole("menu")).getByRole("menuitem", {
        name: RESET_VIEW_MENU_ITEM,
      })
    );

    await waitFor(() => {
      const stored = JSON.parse(
        localStorage.getItem(COMPONENT_PER_USER_KEY) ?? "{}"
      );
      expect(new Set(stored.hiddenColumns)).toEqual(
        new Set(SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS)
      );
      expect(stored.columnOrder).toEqual([]);
    });
    expect(localStorage.getItem(COMPONENT_LEGACY_KEY)).toBeNull();
  });
});
