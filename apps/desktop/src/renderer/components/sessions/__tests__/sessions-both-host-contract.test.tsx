/**
 * ISS-9544 — the DESKTOP half of the Sessions both-host contract.
 *
 * The states live once in
 * `@repo/app/agents/components/sessions/__tests__/sessions-both-host-contract`;
 * `apps/app/components/agent-sessions/__tests__/sessions-both-host-contract.test.tsx`
 * runs the identical cases over the identical fixture against the web host.
 * This file owns only the Electron adapter — the SQLite-backed read hooks, the
 * desktop provider stack, and its read of the SAME PostHog key web resolves
 * (ISS-8753); there is no desktop Labs gate to mock beside it.
 *
 * The star's absence here is the contract's one divergence, and it is CHECKED:
 * the day this shell starts rendering it, the entry reddens instead of excusing
 * the shell forever.
 */

import {
  SESSIONS_BOTH_HOST_CONTRACT,
  type SessionsBothHostFixture,
} from "@repo/app/agents/components/sessions/__tests__/sessions-both-host-contract";
import {
  DESKTOP_HOST,
  runBothHostContract,
} from "@repo/app/shared/testing/both-host-render-contract";
import { afterEach, beforeEach, vi } from "vitest";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../../shared/local-session-source-status";
import {
  applyDefaultSessionsViewHooks,
  installDesktopApiStub,
  listWith,
  renderSessionsView,
  restoreDesktopApi,
  sessionsViewHookMocks,
} from "./fixtures/sessions-view-render-fixture";

const LOCAL_SOURCE_READY = {
  localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.ready,
};

beforeEach(() => {
  vi.clearAllMocks();
  applyDefaultSessionsViewHooks();
  sessionsViewHookMocks().useSessionsViewState.mockReturnValue({
    columnOrder: undefined,
    groupBy: "none",
    hiddenSummaryCards: new Set<string>(),
    isViewReady: true,
    resetView: vi.fn(),
    secondarySorts: [],
    setColumnOrder: vi.fn(),
    setGroupBy: vi.fn(),
    setSecondarySorts: vi.fn(),
    setSort: vi.fn(),
    sortDir: "desc",
    sortKey: null,
    toggleColumn: vi.fn(),
    toggleSummaryCard: vi.fn(),
    visibleColumns: new Set<string>(["name", "status"]),
  });
  installDesktopApiStub({
    getLocalSessionSourceStatus: vi.fn().mockResolvedValue(LOCAL_SOURCE_READY),
    onDbChanged: () => () => undefined,
  });
});

afterEach(() => {
  restoreDesktopApi();
});

runBothHostContract<SessionsBothHostFixture>({
  contract: SESSIONS_BOTH_HOST_CONTRACT,
  host: DESKTOP_HOST,
  mount: async (fixture) => {
    sessionsViewHookMocks().useSearchParamsValue.mockReturnValue(
      new URLSearchParams(
        fixture.statusFilter ? `status=${fixture.statusFilter}` : ""
      )
    );
    sessionsViewHookMocks().useAgentSessionsPageData.mockReturnValue({
      data: {
        list: {
          ...listWith([...fixture.items]),
          total: fixture.total ?? fixture.items.length,
        },
      },
      isError: false,
      isFetching: false,
      isLoading: false,
      isPlaceholderData: false,
      refetch: vi.fn(),
    });
    await renderSessionsView();
  },
});
