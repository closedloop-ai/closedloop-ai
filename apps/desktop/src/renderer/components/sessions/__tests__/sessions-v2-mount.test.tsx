import { SESSIONS_CUSTOM_DATE_WINDOW_FLAG_KEY } from "@repo/api/src/types/sessions-custom-date-window-flag";
import { SESSIONS_LIST_LOADING_LABEL } from "@repo/app/agents/components/sessions/sessions-list-loading-labels";
import { SESSIONS_HISTORY_LIST_TEST_ID } from "@repo/app/agents/components/sessions/sessions-list-surface-v2";
import {
  SESSION_DATE_FROM_PARAM,
  SESSION_DATE_TO_PARAM,
} from "@repo/app/agents/lib/session-custom-date-window";
import { SESSIONS_PAGE_PARAM } from "@repo/app/agents/lib/session-pagination";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../../shared/local-session-source-status";
import {
  applyDefaultSessionsViewHooks,
  installDesktopApiStub,
  listWith,
  renderSessionsView,
  restoreDesktopApi,
  sessionsViewHookMocks,
  sessionsViewNavigationMock,
} from "./fixtures/sessions-view-render-fixture";

/**
 * ISS-9107 — the desktop Sessions branch selected by `grid-table-v2`.
 *
 * The flag chooses between two whole stacks, so both are driven here from one
 * baseline: OFF must render exactly what ships today, ON must render the shared
 * `SessionsListSurfaceV2`. The fixture mocks the v1 list body to a marker and
 * leaves the v2 surface REAL, which is what makes the two distinguishable and
 * what makes the ON case a genuine mount rather than an assertion about props.
 *
 * That real mount is the point of AC3. A shared component newly hosted on a
 * second shell breaks on providers the first shell happened to supply, and this
 * repo has shipped that defect; a test that stubbed the surface would prove
 * nothing about it. Anything the surface reaches for and the desktop tree does
 * not provide throws out of `render` and fails these cases.
 */

const LOCAL_SOURCE_READY = {
  localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.ready,
};
/** The rolling preset pills, one of which must NOT read as selected under a window. */
const PRESET_LABELS = [
  "Last 7 days",
  "Last 30 days",
  "Last 90 days",
  "All time",
];
/** ISS-9107 AC7 — what the reader must be able to see and remove. */
const CUSTOM_WINDOW_FROM = "2026-08-01";
const CUSTOM_WINDOW_TO = "2026-08-07";
/**
 * ISS-9822 — the two calendar days the pick case presses. Pinned literals against
 * a pinned clock, never re-derived from the encoder under test.
 */
const PICK_CLOCK = new Date(2026, 0, 15, 12, 0, 0);
const JANUARY_5_DAY_NAME = /January 5/;
const JANUARY_12_DAY_NAME = /January 12/;
const PICKED_FROM = "2026-01-05";
const PICKED_TO = "2026-01-12";
/** Deep enough that no page-size ladder clamps page 3 back to page 1. */
const LATER_PAGE = "3";
const LATER_PAGE_TOTAL = 240;

/** jsdom reports zero width, which folds the toolbar to its compact menus. */
let restoreContainerWidth: (() => void) | null = null;

function choosePageSize(optionName: string): void {
  const trigger = screen.getByRole("combobox", { name: "Rows per page" });
  installPointerCaptureStub(trigger);
  fireEvent.pointerDown(trigger, {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  fireEvent.click(screen.getByRole("option", { name: optionName }));
}

function installPointerCaptureStub(element: Element): void {
  const target = element as Element & {
    hasPointerCapture?: (pointerId: number) => boolean;
    releasePointerCapture?: (pointerId: number) => void;
    setPointerCapture?: (pointerId: number) => void;
  };
  target.hasPointerCapture ??= () => false;
  target.releasePointerCapture ??= () => undefined;
  target.setPointerCapture ??= () => undefined;
}

function seedViewState(): void {
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
}

/**
 * ISS-8909 retired `grid-table-v2`, so the v2 surface is the only Sessions arm
 * and there is no gate to set. Kept as the seam for the OTHER flags these cases
 * turn on.
 */
function enableFlags(enabled: readonly string[] = []) {
  sessionsViewHookMocks().useFeatureFlagEnabled.mockImplementation(
    (key: string) => enabled.includes(key)
  );
}

/** Puts an explicit `?from=`/`?to=` window on the shell's URL. */
function seedCustomWindowUrl(): void {
  sessionsViewHookMocks().useSearchParamsValue.mockReturnValue(
    new URLSearchParams({ from: CUSTOM_WINDOW_FROM, to: CUSTOM_WINDOW_TO })
  );
}

function settledPageData(rows: { id: string }[], total = rows.length) {
  return {
    data: { list: { ...listWith(rows), total } },
    isError: false,
    isFetching: false,
    isLoading: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  applyDefaultSessionsViewHooks();
  seedViewState();
  installDesktopApiStub({
    getLocalSessionSourceStatus: vi.fn().mockResolvedValue(LOCAL_SOURCE_READY),
    onDbChanged: () => () => undefined,
  });
});

afterEach(() => {
  cleanup();
  restoreDesktopApi();
  restoreContainerWidth?.();
  restoreContainerWidth = null;
  // Unconditional, in the hook rather than at the end of the case that fakes
  // the clock: an assertion that throws in between would otherwise leave a
  // frozen `Date` in this worker for every later case.
  vi.useRealTimers();
});

describe("desktop Sessions v2 surface mount (ISS-9107)", () => {
  it("links a mounted Session row to its type-specific detail route", async () => {
    enableFlags();
    sessionsViewHookMocks().useAgentSessionsPageData.mockReturnValue(
      settledPageData([{ id: "ses-1" }])
    );

    await renderSessionsView();

    expect(
      globalThis.document.querySelector('a[href="/sessions/ses-1"]')
    ).not.toBeNull();
  });

  /**
   * ISS-9107 (whitlockk review) — `SessionsView` sends its SQLite source only
   * `sortBy`/`sortDir`, so the mounted surface must not offer a SECOND ordering
   * rule. Driven through the real menu rather than asserted as a prop: the cap
   * is only worth anything if it reaches the control the reader touches.
   */
  it("offers no second sort rule on the mounted v2 surface", async () => {
    enableFlags();
    sessionsViewHookMocks().useSessionsViewState.mockReturnValue({
      ...sessionsViewHookMocks().useSessionsViewState(),
      sortDir: "desc",
      sortKey: "status",
    });
    sessionsViewHookMocks().useAgentSessionsPageData.mockReturnValue(
      settledPageData([{ id: "ses-1" }])
    );

    await renderSessionsView();

    const sortTrigger = screen
      .getAllByRole("button")
      .find((button) => button.textContent?.startsWith("Sorts:"));
    expect(sortTrigger).toBeDefined();
    fireEvent.pointerDown(sortTrigger as HTMLElement, {
      button: 0,
      ctrlKey: false,
    });

    // The words are the whole contract: at the cap a pick REPLACES, so the
    // section must not invite an addition the desktop query would drop.
    expect(screen.queryByText("Add another sort")).toBeNull();
    expect(screen.getByText("Sort by")).not.toBeNull();
  });

  it("reads v2 page size from the URL and resets a higher page in one write", async () => {
    enableFlags();
    sessionsViewHookMocks().useSearchParamsValue.mockReturnValue(
      new URLSearchParams({ page: "3", pageSize: "50" })
    );
    sessionsViewHookMocks().useAgentSessionsPageData.mockReturnValue(
      settledPageData([{ id: "ses-1" }], 125)
    );

    await renderSessionsView();

    expect(
      sessionsViewHookMocks().useAgentSessionsPageData.mock.lastCall?.[0]
    ).toEqual(expect.objectContaining({ limit: 50, offset: 100 }));
    expect(
      screen.getByRole("combobox", { name: "Rows per page" }).textContent
    ).toContain("50 / page");

    choosePageSize("100 / page");

    expect(sessionsViewNavigationMock().replace).toHaveBeenCalledTimes(1);
    expect(sessionsViewNavigationMock().replace).toHaveBeenCalledWith(
      "/sessions?pageSize=100",
      { scroll: false }
    );
  });

  it("writes v2 page size on page one where the surface page reset is inert", async () => {
    enableFlags();
    sessionsViewHookMocks().useSearchParamsValue.mockReturnValue(
      new URLSearchParams({ pageSize: "50" })
    );
    sessionsViewHookMocks().useAgentSessionsPageData.mockReturnValue(
      settledPageData([{ id: "ses-1" }], 125)
    );

    await renderSessionsView();

    choosePageSize("100 / page");

    expect(sessionsViewNavigationMock().replace).toHaveBeenCalledTimes(1);
    expect(sessionsViewNavigationMock().replace).toHaveBeenCalledWith(
      "/sessions?pageSize=100",
      { scroll: false }
    );
  });

  // AC4 — nothing half-rendered. The mount was sequenced AFTER ISS-9105 and
  // ISS-9106 landed (PR #6591), so the loading copy the operator approved as a
  // temporary absence is now a capability the v2 reader actually gets. Asserting
  // it renders is what proves the sequencing bought something.
  it("carries the restored loading copy on the v2 branch", async () => {
    enableFlags();
    sessionsViewHookMocks().useAgentSessionsPageData.mockReturnValue({
      data: undefined,
      isError: false,
      isFetching: true,
      isLoading: true,
      isPlaceholderData: false,
      refetch: vi.fn(),
    });

    await renderSessionsView();

    expect(screen.getByTestId(SESSIONS_HISTORY_LIST_TEST_ID)).not.toBeNull();
    expect(screen.getByText(SESSIONS_LIST_LOADING_LABEL)).not.toBeNull();
  });

  // The accessible signal the v1 wrapper carries. A reader on a screen reader
  // must not lose "this list is busy" by turning the flag on.
  it("marks the v2 table region busy while the list read is in flight", async () => {
    enableFlags();
    sessionsViewHookMocks().useAgentSessionsPageData.mockReturnValue({
      data: undefined,
      isError: false,
      isFetching: true,
      isLoading: true,
      isPlaceholderData: false,
      refetch: vi.fn(),
    });

    await renderSessionsView();

    expect(
      screen
        .getByTestId(SESSIONS_HISTORY_LIST_TEST_ID)
        .closest('[aria-busy="true"]')
    ).not.toBeNull();
  });

  /**
   * ISS-9107 AC7 — an explicit `?from=`/`?to=` window is VISIBLE as Custom, and
   * no preset may read as selected beside it.
   *
   * The window still bounds the read either way (`SessionsView` resolves it over
   * the preset), so the defect this pins is a control stating an interval the
   * rows were never read over — a list narrowed by something the reader cannot
   * see and therefore cannot remove.
   */
  it("shows the custom window and deselects every preset on the v2 branch", async () => {
    enableFlags([SESSIONS_CUSTOM_DATE_WINDOW_FLAG_KEY]);
    seedCustomWindowUrl();
    sessionsViewHookMocks().useAgentSessionsPageData.mockReturnValue(
      settledPageData([{ id: "ses-1" }])
    );

    await renderSessionsView();

    expect(screen.getByTestId(SESSIONS_HISTORY_LIST_TEST_ID)).not.toBeNull();
    for (const label of PRESET_LABELS) {
      const preset = screen.queryByRole("radio", { name: label });
      expect(preset?.getAttribute("aria-checked") ?? "false").toBe("false");
    }
  });

  // The positive sibling: with NO window the preset speaks for the read and must
  // read as selected, or the assertion above would pass on a toolbar that simply
  // never checks anything.
  it("keeps the preset selected when no custom window owns the read", async () => {
    enableFlags([SESSIONS_CUSTOM_DATE_WINDOW_FLAG_KEY]);
    sessionsViewHookMocks().useAgentSessionsPageData.mockReturnValue(
      settledPageData([{ id: "ses-1" }])
    );

    await renderSessionsView();

    const checked = PRESET_LABELS.map((label) =>
      screen.queryByRole("radio", { name: label })?.getAttribute("aria-checked")
    );
    expect(checked).toContain("true");
  });

  /**
   * ISS-9822 — a window PICKED from a later page survives, in ONE write.
   *
   * The cases above that touch the window all run on page 0, where the
   * surface's trailing `updateView({ page: 0 })` moves nothing. From page 3 it
   * does: the pick writes `?from=`/`?to=` with its page reset, and a shell that
   * reads that `page: 0` as a move still to make writes AGAIN off the same
   * pre-click hash snapshot, with no window on it — and the later write wins.
   *
   * No window is seeded on purpose. A seeded one is copied back out of that
   * pre-click snapshot by the second write, which hides the clobber.
   */
  it("keeps a custom window picked from a later page, in one write", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(PICK_CLOCK);
    restoreContainerWidth = stubContainerWidthPx(1440);
    enableFlags([SESSIONS_CUSTOM_DATE_WINDOW_FLAG_KEY]);
    sessionsViewHookMocks().useSearchParamsValue.mockReturnValue(
      new URLSearchParams({ [SESSIONS_PAGE_PARAM]: LATER_PAGE })
    );
    sessionsViewHookMocks().useAgentSessionsPageData.mockReturnValue(
      settledPageData([{ id: "ses-1" }], LATER_PAGE_TOTAL)
    );

    await renderSessionsView();
    const { replace } = sessionsViewNavigationMock();
    replace.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    fireEvent.click(
      await screen.findByRole("button", { name: JANUARY_5_DAY_NAME })
    );
    fireEvent.click(screen.getByRole("button", { name: JANUARY_12_DAY_NAME }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    // The COUNT is the rule, not an incidental: the pick already carried its own
    // page reset, so any second write can only be that reset again off the
    // pre-click params — the shape that drops the window.
    const urls = replace.mock.calls.map(([url]) => String(url));
    expect(urls).toHaveLength(1);
    const written = new URLSearchParams(urls[0]?.split("?")[1] ?? "");
    expect(written.get(SESSION_DATE_FROM_PARAM)).toBe(PICKED_FROM);
    expect(written.get(SESSION_DATE_TO_PARAM)).toBe(PICKED_TO);
    expect(written.has(SESSIONS_PAGE_PARAM)).toBe(false);
  });

  // The positive sibling: a settled read must NOT claim to be busy, or the
  // attribute says nothing and a screen reader is told the list is loading forever.
  it("drops aria-busy once the read has settled", async () => {
    enableFlags();
    sessionsViewHookMocks().useAgentSessionsPageData.mockReturnValue({
      data: { list: listWith([{ id: "ses-1" }]) },
      isError: false,
      isFetching: false,
      isLoading: false,
      isPlaceholderData: false,
      refetch: vi.fn(),
    });

    await renderSessionsView();

    expect(
      screen
        .getByTestId(SESSIONS_HISTORY_LIST_TEST_ID)
        .closest('[aria-busy="true"]')
    ).toBeNull();
  });
});
