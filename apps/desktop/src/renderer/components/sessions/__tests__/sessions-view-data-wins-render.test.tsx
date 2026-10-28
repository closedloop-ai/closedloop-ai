import { isGridChromeRowId } from "@closedloop-ai/design-system/lib/grid-table-v2-chrome-rows";
import { SESSIONS_LIST_LOADING_LABEL } from "@repo/app/agents/components/sessions/sessions-list-loading-labels";
import { SESSIONS_HISTORY_LIST_TEST_ID } from "@repo/app/agents/components/sessions/sessions-list-surface-v2";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyDefaultSessionsViewHooks,
  installDesktopApiStub,
  listWith,
  renderSessionsView,
  restoreDesktopApi,
  sessionsViewHookMocks,
  stuckLocalSourceProbe,
} from "./fixtures/sessions-view-render-fixture";

const sessionsViewHooks = sessionsViewHookMocks();

/**
 * ISS-4772 (Step 2): after long uptime a dropped `getAgentMonitorUrl` transition
 * can strand `localSessionSourceStatus` on "starting" while the page-data query
 * and backend are healthy. The full-body "Loading" gate keyed off that latched
 * "starting" then blanked the whole list to an infinite spinner even though the
 * rows were in hand. These render SessionsView in LOCAL mode with the local
 * source status wedged on "starting" (the probe never resolves ready) and assert
 * that a current settled read — even an empty one — collapses the effective
 * display state to "ready" so the table or empty state renders instead of the
 * spinner. The genuinely-still-starting case (no data, no complete import) still
 * spins.
 *
 * ISS-4837: the module mocks, hook baseline, `window.desktopApi` descriptor
 * handling and the render/flush helper live in the shared
 * `./fixtures/sessions-view-render-fixture` module, shared with
 * `sessions-view-status-self-heal`. Only this suite's own overrides stay here.
 *
 * ISS-8909: the v1 list content the fixture used to stand in for is no longer
 * mounted, so the rendered v2 surface IS what these cases read — the rows it
 * paints, or the honest empty state where there are none. Both halves of each
 * claim survive the move: the spinner is absent AND the row count is what the
 * settled read carried.
 */

/** Body rows the v2 grid painted, excluding its header row. */
function renderedRowCount(): number {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-grid-row][data-grid-row-id]")
  ).filter((row) => !isGridChromeRowId(row.dataset.gridRowId ?? "")).length;
}

/**
 * The neutral genuinely-empty title (local mode always reports a connected
 * agent, so this is the zero-row copy, never the onboarding ask). A literal
 * rather than a read off the component, so it cannot agree with itself.
 */
const NEUTRAL_EMPTY_TITLE = "No sessions yet";

describe("SessionsView data-wins render while status latched starting (ISS-4772)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyDefaultSessionsViewHooks();
    // The local source probe NEVER resolves ready — the wedge. The initial
    // "starting" state therefore never transitions on its own.
    installDesktopApiStub({
      getAgentMonitorUrl: stuckLocalSourceProbe(),
      onDbChanged: vi.fn(() => undefined),
    });
  });

  afterEach(() => {
    cleanup();
    restoreDesktopApi();
  });

  it("renders the held rows, not the infinite spinner, when the page-data query has data while status is latched starting", async () => {
    sessionsViewHooks.useAgentSessionsPageData.mockReturnValue({
      data: { list: listWith([{ id: "s1" }, { id: "s2" }]) },
      isLoading: false,
      isError: false,
      isFetching: false,
      isPlaceholderData: false,
      refetch: vi.fn(),
    });

    await renderSessionsView();

    // The full-body SESSIONS_LIST_LOADING_LABEL spinner must NOT be showing — held data
    // collapsed the latched "starting" to "ready".
    expect(screen.queryByText(SESSIONS_LIST_LOADING_LABEL)).toBeNull();
    expect(screen.getByTestId(SESSIONS_HISTORY_LIST_TEST_ID)).toBeTruthy();
    // The held rows themselves, not merely a list region: a surface that swapped
    // the rows for a skeleton would satisfy the absence above.
    expect(renderedRowCount()).toBe(2);
  });

  it("renders the honest empty state when the page-data query settles empty while status is latched starting", async () => {
    await renderSessionsView();

    expect(screen.queryByText(SESSIONS_LIST_LOADING_LABEL)).toBeNull();
    expect(screen.getByTestId(SESSIONS_HISTORY_LIST_TEST_ID)).toBeTruthy();
    // Settled empty is SAID, not left blank: the honest zero-row copy with no
    // rows behind it.
    expect(screen.getByText(NEUTRAL_EMPTY_TITLE)).toBeTruthy();
    expect(renderedRowCount()).toBe(0);
  });

  it("does NOT collapse starting on keepPreviousData rows from a stale query key", async () => {
    // ISS-4772 review (whitlockk cid 3696061970): `keepPreviousData` keeps the prior
    // key's rows on screen as `isPlaceholderData` while a filter/page change
    // loads. Those rows describe a scope the active query has not read yet, so
    // they must NOT promote the latched "starting" to "ready" — that would let
    // the table lie about the active scope. `hasCurrentListData` requires a read
    // from the ACTIVE key, so the honest loading state holds until it lands.
    sessionsViewHooks.useAgentSessionsPageData.mockReturnValue({
      data: { list: listWith([{ id: "stale1" }, { id: "stale2" }]) },
      isLoading: false,
      isError: false,
      isFetching: true,
      isPlaceholderData: true,
      refetch: vi.fn(),
    });

    await renderSessionsView();

    // Placeholder rows do not count as held data → the view stays honestly
    // loading rather than claiming "ready" over an unread scope.
    expect(screen.getByText(SESSIONS_LIST_LOADING_LABEL)).toBeTruthy();
  });

  it("still shows the loading spinner when genuinely starting with no data and no complete import", async () => {
    sessionsViewHooks.useAgentSessionsPageData.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      isFetching: true,
      isPlaceholderData: false,
      refetch: vi.fn(),
    });

    await renderSessionsView();

    // The unresolved starting state (no held data, no complete import) keeps the
    // honest full-body loading state — the fix must not mask a genuine cold start.
    expect(screen.getByText(SESSIONS_LIST_LOADING_LABEL)).toBeTruthy();
  });
});
