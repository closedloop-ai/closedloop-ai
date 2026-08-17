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
 * that held data — or an observed-complete boot import — collapses the effective
 * display state to "ready" so the rows render instead of the spinner. The
 * genuinely-still-starting case (no data, no complete import) still spins.
 *
 * ISS-4837: the module mocks, hook baseline, `window.desktopApi` descriptor
 * handling and the render/flush helper live in the shared
 * `./fixtures/sessions-view-render-fixture` module, shared with
 * `sessions-view-status-self-heal`. Only this suite's own overrides stay here.
 */

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

    // The full-body "Loading sessions..." spinner must NOT be showing — held data
    // collapsed the latched "starting" to "ready".
    expect(screen.queryByText("Loading sessions...")).toBeNull();
    const body = screen.getByTestId("sessions-table-body");
    expect(body.getAttribute("data-is-loading")).toBe("false");
    expect(body.getAttribute("data-item-count")).toBe("2");
  });

  it("collapses starting via the import arm (not the held-data arm) when the boot import is observed complete with no held rows", async () => {
    // ISS-4772 review (wongk/logical-QA): exercise the INGEST arm specifically —
    // the query holds no rows (`data` undefined, the fixture default), but the
    // boot import has settled complete, so the local source is genuinely up. The
    // latched "starting" label must collapse to "ready" off the import signal
    // alone and stop blanking the body to the infinite spinner.
    sessionsViewHooks.useIngestProgress.mockReturnValue({
      total: 10,
      processed: 10,
      preparing: false,
      complete: true,
    });

    await renderSessionsView();

    // The infinite full-body spinner must NOT show — the settled import collapsed
    // the latched "starting". With no rows the body lands on the honest empty
    // surface, which is correct here because the read gate was promoted alongside
    // the display state, so this "empty" reflects a read that actually ran.
    expect(screen.queryByText("Loading sessions...")).toBeNull();
    const body = screen.getByTestId("sessions-table-body");
    expect(body.getAttribute("data-is-loading")).toBe("false");
    expect(body.getAttribute("data-item-count")).toBe("0");
  });

  it("does NOT collapse starting on keepPreviousData rows from a stale query key", async () => {
    // ISS-4772 review (wongk cid 3696061970): `keepPreviousData` keeps the prior
    // key's rows on screen as `isPlaceholderData` while a filter/page change
    // loads. Those rows describe a scope the active query has not read yet, so
    // they must NOT promote the latched "starting" to "ready" — that would let
    // the table lie about the active scope. `hasHeldListData` requires rows from
    // the ACTIVE key, so the honest loading state holds until the real read lands.
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
    expect(screen.getByText("Loading sessions...")).toBeTruthy();
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
    expect(screen.getByText("Loading sessions...")).toBeTruthy();
  });
});
