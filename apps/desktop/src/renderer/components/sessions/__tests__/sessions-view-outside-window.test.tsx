/**
 * ISS-11913 — the DESKTOP host's half: a machine whose agent sessions are all
 * older than the default 7d window (the onboarding run that reported this saw
 * "No sessions yet" over 36 analyzed sessions).
 *
 * The windowed list read is the fixture's mocked page-data hook, settled empty.
 * The unwindowed probe `SessionsView` issues runs for real through an injected
 * data source, the seam the local SQLite source plugs into in production — so
 * these cases fail if the view stops asking, asks with a window, or stops
 * handing the answer to the surface and to its own dead-end classifier.
 */

import type { AgentSessionListResponse } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import {
  SESSIONS_DATE_RANGE_EMPTY_DESCRIPTION,
  SESSIONS_GENUINELY_EMPTY_TITLE,
} from "@repo/app/agents/components/sessions/sessions-empty-state";
import type { AgentSessionsDataSource } from "@repo/app/agents/data-source/agent-sessions-data-source";
import { MY_TASKS_RECENCY_SHOW_ALL_LABEL } from "@repo/app/my-tasks/lib/my-tasks-recency-window";
import { LIST_LOADING_STALL_THRESHOLDS } from "@repo/app/shared/hooks/use-loading-stall";
import { DateRange } from "@repo/app/shared/lib/format-utils";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DeadEndFlowReason,
  DeadEndFlowState,
  DeadEndFlowTreatment,
} from "../../../../shared/dead-end-telemetry-contract";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../../shared/local-session-source-status";
import {
  applyDefaultSessionsViewHooks,
  installDesktopApiStub,
  listWith,
  renderSessionsView,
  restoreDesktopApi,
  sessionsViewHookMocks,
} from "./fixtures/sessions-view-render-fixture";

const DATE_RANGE_EMPTY_COPY =
  "No sessions were active in the selected date range.";

const OLDER_SESSION = { id: "ses-older", name: "agent/older-than-the-window" };

/** @see renderSessionsListBody — the surface's quiet pending treatment. */
const SESSIONS_LIST_SKELETON_TEST_ID = "sessions-list-skeleton";

let recordDeadEndTelemetry: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  applyDefaultSessionsViewHooks();
  // The full view state: Show all time writes through the host's view-change
  // router, which reads every axis of it.
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
    visibleColumns: new Set<string>(["name"]),
  });
  recordDeadEndTelemetry = vi.fn().mockResolvedValue({ ok: true });
  installDesktopApiStub({
    getAgentMonitorUrl: vi.fn().mockResolvedValue({
      localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.ready,
    }),
    onDbChanged: vi.fn(() => undefined),
    recordDeadEndTelemetry,
  });
});

afterEach(() => {
  vi.useRealTimers();
  restoreDesktopApi();
});

describe("SessionsView — sessions outside the window (ISS-11913)", () => {
  it("offers Show all time, and reports a filtered empty, when every session is older than the window", async () => {
    const source = createProbeSource(1);
    await renderSessionsView({}, { dataSource: source });

    expect(await screen.findByText(DATE_RANGE_EMPTY_COPY)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show all time" })).toBeTruthy();
    expect(screen.queryByText(SESSIONS_GENUINELY_EMPTY_TITLE)).toBeNull();
    // The whole population: one row, no window.
    expect(source.list).toHaveBeenCalledWith({ countOnly: true, limit: 1 });
    // The classifier names the treatment the reader actually sees.
    await waitFor(() =>
      expect(lastDeadEndRecord()).toMatchObject({
        reason: DeadEndFlowReason.FilteredOut,
        state: DeadEndFlowState.NotApplicable,
      })
    );
  });

  it("keeps No sessions yet, reported as a true zero, when the machine has no sessions at all", async () => {
    const source = createProbeSource(0);
    await renderSessionsView({}, { dataSource: source });

    await waitFor(() => expect(source.list).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("No sessions yet")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: MY_TASKS_RECENCY_SHOW_ALL_LABEL })
    ).toBeNull();
    await waitFor(() =>
      expect(lastDeadEndRecord()).toMatchObject({
        reason: DeadEndFlowReason.Absent,
        state: DeadEndFlowState.TrueZero,
      })
    );
    expect(recordedReasons()).not.toContain(DeadEndFlowReason.FilteredOut);
  });

  it("falls back to No sessions yet, reported as a true zero, when the probe fails", async () => {
    const source = createProbeSource(1);
    vi.mocked(source.list).mockRejectedValue(new Error("probe failed"));
    await renderSessionsView({}, { dataSource: source });

    expect(await screen.findByText("No sessions yet")).toBeTruthy();
    await waitFor(() =>
      expect(recordedReasons()).toContain(DeadEndFlowReason.Absent)
    );
    expect(recordedReasons()).not.toContain(DeadEndFlowReason.FilteredOut);
  });

  it("holds the loading treatment, and records no dead end, while the probe is out", async () => {
    const source = createProbeSource(1);
    vi.mocked(source.list).mockReturnValue(new Promise(() => undefined));
    await renderSessionsView({}, { dataSource: source });

    await waitFor(() => expect(source.list).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId(SESSIONS_LIST_SKELETON_TEST_ID)).toBeTruthy();
    expect(screen.queryByText(SESSIONS_GENUINELY_EMPTY_TITLE)).toBeNull();
    expect(recordedReasons()).not.toContain(DeadEndFlowReason.Absent);
  });

  it("counts a probe that never lands toward the stall bound", async () => {
    vi.useFakeTimers();
    const source = createProbeSource(1);
    vi.mocked(source.list).mockReturnValue(new Promise(() => undefined));
    await renderSessionsView({}, { dataSource: source });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIST_LOADING_STALL_THRESHOLDS.softMs);
    });

    expect(source.list).toHaveBeenCalledTimes(1);
    expect(
      recordDeadEndTelemetry.mock.calls.map((call) => call[0]?.treatment)
    ).toContain(DeadEndFlowTreatment.SessionsListStalled);
  });

  it("Show all time widens the shared range, and the sessions render", async () => {
    const setDateRange = vi.fn();
    sessionsViewHookMocks().useSharedDateRange.mockReturnValue({
      dateRange: DateRange.Last7Days,
      setDateRange,
    });
    const view = await renderSessionsView(
      {},
      { dataSource: createProbeSource(1) }
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Show all time" })
    );
    expect(setDateRange).toHaveBeenCalledWith(DateRange.AllTime);

    // The shared range writes back, and the list re-reads unwindowed. A fresh
    // mount, because this fixture renders `SessionsView` only through its own
    // helper.
    sessionsViewHookMocks().useSharedDateRange.mockReturnValue({
      dateRange: DateRange.AllTime,
      setDateRange,
    });
    sessionsViewHookMocks().useAgentSessionsPageData.mockReturnValue({
      data: { list: listWith([OLDER_SESSION]), usage: undefined },
      isError: false,
      isFetching: false,
      isLoading: false,
      isPlaceholderData: false,
      refetch: vi.fn(),
    });
    view.unmount();
    await renderSessionsView({}, { dataSource: createProbeSource(1) });

    expect(await screen.findByText(OLDER_SESSION.name)).toBeTruthy();
    expect(
      screen.queryByText(SESSIONS_DATE_RANGE_EMPTY_DESCRIPTION)
    ).toBeNull();
  });
});

function lastDeadEndRecord(): Record<string, unknown> | undefined {
  return recordDeadEndTelemetry.mock.calls.at(-1)?.[0];
}

/** Every dead-end reason recorded so far, in order — a transient one included. */
function recordedReasons(): unknown[] {
  return recordDeadEndTelemetry.mock.calls.map((call) => call[0]?.reason);
}

function createProbeSource(total: number): AgentSessionsDataSource {
  const list: AgentSessionListResponse = {
    items: [],
    total,
    viewerScope: AgentSessionViewerScope.Self,
  };
  return {
    scope: "desktop-local-test",
    list: vi.fn().mockResolvedValue(list),
    detail: vi.fn().mockRejectedValue(new Error("detail unused")),
    usage: vi.fn().mockRejectedValue(new Error("usage unused")),
    pageData: vi.fn().mockRejectedValue(new Error("pageData unused")),
    analytics: vi.fn().mockRejectedValue(new Error("analytics unused")),
  };
}
