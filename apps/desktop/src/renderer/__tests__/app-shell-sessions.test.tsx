/**
 * Desktop app-shell: the Sessions surface (ISS-5147 split).
 *
 * Split out of the former monolithic `app-shell.test.tsx`. Owns one
 * responsibility: what the shell does with the shared Sessions/Insights
 * wrappers — sidebar search submit/clear semantics, status filtering,
 * pagination and scroll restoration, and the session detail surface. Sidebar
 * persistence and shell routing live in the sibling `app-shell-*.test.tsx`
 * files.
 */

import { GRID_TABLE_SCROLL_BAND_TEST_ID } from "@closedloop-ai/design-system/components/ui/grid-table-list-surface";
import type { AgentSessionsPageData } from "@repo/api/src/types/agent-session";
import { ReadInitiator } from "@repo/api/src/types/read-initiator";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
// Imported for the Filter control's own label AND for the module's side effect:
// it installs the Radix pointer-capture shims jsdom omits, without which the
// real `FilterPopover` throws on open. `apps/desktop` declares no `setupFiles`,
// so this import is how every desktop suite that drives a real menu gets them
// (see the harness header, and the sibling `sessions-view-toolbar-options-menu`
// and `sessions-desktop-view-state-persistence` suites).
import { SESSIONS_TOOLBAR_FILTER_BUTTON } from "@repo/app/agents/components/sessions/__tests__/sessions-toolbar-mount-harness";
import { SessionStatusFacetValue } from "@repo/app/agents/lib/session-status-filters";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  findSharedRouteHeading,
  findTopbarCurrentPage,
  getDesktopSessionDetailScrollElements,
  renderDesktopApp,
  SHOW_COMMENTS_BUTTON_NAME,
  setupAppShellSuite,
} from "./app-shell-harness";
import {
  agentSessionUsage,
  defaultSessionsPageDataRequest,
  requestedSessionStatuses,
} from "./app-shell-session-fixtures";

vi.mock("../components/UpdateBanner", () => ({
  UpdateBanner: () => null,
}));

// ISS-10195: the guided-onboarding host is stubbed OUT of this Sessions suite.
// It is mounted app-wide by the sidebar and calls
// `useOnboardingSessionDiscovery(true)`, which reads
// `agentSessionsApi.usage(ALL_LOCAL_SESSIONS)` — an empty-filter read with
// nothing to do with the Insights opt-in this suite measures. Retiring the
// workspace-experience gate removed the root resolver's boot-boundary hold, so
// that read now lands inside the "scans stay opt-in" assertion below. Stubbing
// the unrelated consumer keeps that assertion meaning exactly what it says —
// that no INSIGHTS scan fired before the click — rather than widening it to
// tolerate a second, unrelated caller.
vi.mock(
  "../components/onboarding/desktop-guided-onboarding-dialog-host",
  () => ({
    DesktopGuidedOnboardingDialogHost: () => null,
  })
);

describe("App shell sessions surface", () => {
  setupAppShellSuite();

  it("renders real shared sessions and insights wrappers through the desktop provider", async () => {
    // Opened at #/sessions rather than at the empty-hash default: this test owns
    // the shared Sessions/Insights WRAPPERS, and the empty-hash default is no
    // longer Sessions (`DEFAULT_NAV_ID` is the canonical Dashboard landing), so
    // relying on it here would only be re-testing the landing. The launch path
    // through Dashboard into Sessions is pinned by the page-two test below.
    // Views are reached by hash navigation since the sidebar nav items are
    // links folded into a collapsed Labs section under FOCUS_MODE.
    await renderDesktopApp("#/sessions");

    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
    expect(window.location.hash).toBe("#/sessions");

    await screen.findByRole("link", { name: "Shell Active Session" });
    const sessionLink = screen
      .getAllByRole("link", { name: "Shell Active Session" })
      .find((link) => link.getAttribute("href") === "#/sessions/s-active");
    expect(sessionLink?.getAttribute("href")).toBe("#/sessions/s-active");

    window.location.hash =
      sessionLink?.getAttribute("href") ?? "#/sessions/s-active";
    expect(await findSharedRouteHeading("Shell Active Session")).toBeDefined();

    // The breadcrumb's "Sessions" parent is the back affordance (the in-page
    // "Back to Sessions" control was removed).
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "breadcrumb" })).getByRole(
        "link",
        { name: "Sessions" }
      )
    );
    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
    await waitFor(() => expect(window.location.hash).toBe("#/sessions"));

    window.location.hash = "#/insights";
    expect(await findSharedRouteHeading("Insights")).toBeDefined();
    expect(screen.getByRole("button", { name: "Load insights" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Load insights" }));
    // The loaded bounded view fetches the paged session list; that call is the
    // mount signal (the former "Recent session activity" card was removed in
    // FEA-3989).
    await waitFor(() =>
      expect(window.desktopApi.agentSessionsApi.list).toHaveBeenCalled()
    );

    expect(window.desktopApi.agentSessionsApi.detail).toHaveBeenCalledWith(
      "s-active",
      { readInitiator: ReadInitiator.User }
    );
  });

  it("submits the Labs sidebar search to the sessions view and forwards the local search filter", async () => {
    await renderDesktopApp("#/sessions");

    const searchInput = await openLabsSearch();
    expect(searchInput.hasAttribute("disabled")).toBe(false);
    fireEvent.change(searchInput, {
      target: { value: "Failed Session" },
    });
    const searchForm = searchInput.closest("form");
    expect(searchForm).not.toBeNull();
    fireEvent.submit(searchForm as HTMLFormElement);

    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions?search=Failed+Session");
    });
    await waitFor(() => {
      expect(window.desktopApi.agentSessionsApi.pageData).toHaveBeenCalledWith(
        defaultSessionsPageDataRequest({ offset: 0, search: "Failed Session" })
      );
    });
    expect(
      await screen.findByRole("link", { name: "Shell Failed Session" })
    ).toBeDefined();
    expect(
      screen.queryByRole("link", { name: "Shell Active Session" })
    ).toBeNull();
  });

  it("shows an in-list loading state while a sidebar search is pending", async () => {
    await renderDesktopApp("#/sessions");

    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
    expect(
      await screen.findByRole("link", { name: "Shell Active Session" })
    ).toBeDefined();
    expect(await screen.findByText("26")).toBeDefined();

    // FEA-4157: the Sessions view reads its list + summary through `pageData`, so
    // gate the search read there. The standalone facet-option `usage` read still
    // fires (unfiltered), and the loading-state assertions below confirm it is
    // never search-scoped.
    //
    // ISS-12161: the FEA-2187 fallback poll re-reads the UNFILTERED pageData key
    // every 2s while the view still observes it, and that tick can land before
    // the search read is issued (it did, under coverage timing). The poll is
    // product-correct, so until the search read is issued the unfiltered key
    // answers with the harness's own data. Only after the view has left it do
    // non-search reads drop to 0, so the "26" below can only be the held value.
    const pendingPageData = new Promise<AgentSessionsPageData>(() => undefined);
    const pageDataApi = vi.mocked(window.desktopApi.agentSessionsApi.pageData);
    const serveUnfilteredPageData = pageDataApi.getMockImplementation();
    let searchReadIssued = false;
    pageDataApi.mockImplementation((request = {}) => {
      if (request.search) {
        searchReadIssued = true;
        return pendingPageData;
      }
      if (!searchReadIssued && serveUnfilteredPageData) {
        return serveUnfilteredPageData(request);
      }
      return Promise.resolve({
        list: { items: [], total: 0, viewerScope: "self" },
        usage: agentSessionUsage(0),
      });
    });
    vi.mocked(window.desktopApi.agentSessionsApi.usage).mockImplementation(() =>
      Promise.resolve(agentSessionUsage(0))
    );

    const searchInput = await openLabsSearch();
    fireEvent.change(searchInput, {
      target: { value: "Failed Session" },
    });
    const searchForm = searchInput.closest("form");
    expect(searchForm).not.toBeNull();
    fireEvent.submit(searchForm as HTMLFormElement);

    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions?search=Failed+Session");
    });
    await waitFor(() => {
      expect(window.desktopApi.agentSessionsApi.pageData).toHaveBeenCalledWith(
        expect.objectContaining({ search: "Failed Session" })
      );
    });

    expect(screen.getByRole("status").textContent).toContain(
      "Searching sessions..."
    );
    // FEA-4177: the summary cards no longer grey-flash on a pending search. The
    // aggregate read now rides the combined `pageData` query, whose card skeleton
    // is gated on the query's own initial-load flag (`isLoading`) — not the
    // table's loading state — so a `keepPreviousData` search refetch holds the
    // last-good total ("26") in place instead of blanking it, matching the web
    // page's parity. The table row/pagination still clear below.
    expect(screen.getByText("26")).toBeDefined();
    expect(
      screen.queryByRole("link", { name: "Shell Active Session" })
    ).toBeNull();
    // ISS-9216: the v2 surface keeps the footer MOUNTED through a placeholder
    // read and PINS every control in it, where the retired v1 body dropped the
    // strip outright (dropping it cost a row's worth of height and reflowed the
    // table above). What this line protects is unchanged — the reader still
    // cannot page over rows the pending search has already made stale — so it
    // now asserts the control is inert rather than absent.
    // The Electron footer case additionally holds a real empty pageData read.
    // The page-two case below clicks this same control on a
    // settled list, so "pinned" here discriminates rather than always holding.
    expect(
      screen.getByLabelText("Go to next page").getAttribute("aria-disabled")
    ).toBe("true");
    expect(
      vi
        .mocked(window.desktopApi.agentSessionsApi.usage)
        .mock.calls.some(([request]) => request?.search === "Failed Session")
    ).toBe(false);
    expect(
      vi
        .mocked(window.desktopApi.agentSessionsApi.analytics)
        .mock.calls.some(([request]) => request?.search === "Failed Session")
    ).toBe(false);
  });

  it("clears an active sessions search from the desktop sidebar", async () => {
    await renderDesktopApp("#/sessions?search=Failed+Session");

    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
    const activeSearchInput = await openLabsSearch();
    expect(activeSearchInput.value).toBe("Failed Session");

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions");
    });
    expect(activeSearchInput.value).toBe("");
    await waitFor(() => {
      expect(window.desktopApi.agentSessionsApi.pageData).toHaveBeenCalledWith(
        defaultSessionsPageDataRequest({ offset: 0, search: undefined })
      );
    });
  });

  it("clears a draft sessions search to the unfiltered sessions route", async () => {
    await renderDesktopApp("#/sessions");

    const searchInput = await openLabsSearch();
    fireEvent.change(searchInput, {
      target: { value: "Failed Session" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions");
    });
    expect((searchInput as HTMLInputElement).value).toBe("");
  });

  // FEA-2472: the clear-and-reset path also has to work when the user deletes
  // the query text and presses Return (submits an empty query), not only via
  // the "x" clear affordance covered above. An empty submit must reset the
  // search, restore the full unfiltered list, and drop the active-search
  // indicator — a regression here would strand stale filtered results.
  it("restores the full sessions list when the query is deleted and Return is pressed", async () => {
    await renderDesktopApp("#/sessions?search=Failed+Session");

    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
    // The list starts filtered to the single matching session.
    expect(
      await screen.findByRole("link", { name: "Shell Failed Session" })
    ).toBeDefined();
    expect(
      screen.queryByRole("link", { name: "Shell Active Session" })
    ).toBeNull();

    const searchInput = await openLabsSearch();
    expect(searchInput.value).toBe("Failed Session");

    // Delete the query text, then submit (press Return) on the empty input.
    fireEvent.change(searchInput, { target: { value: "" } });
    const searchForm = searchInput.closest("form");
    expect(searchForm).not.toBeNull();
    fireEvent.submit(searchForm as HTMLFormElement);

    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions");
    });
    expect(searchInput.value).toBe("");
    // The active-search indicator (clear affordance) is removed after reset.
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    // The reset re-issues the combined list + summary read with no search term.
    await waitFor(() => {
      expect(window.desktopApi.agentSessionsApi.pageData).toHaveBeenCalledWith(
        defaultSessionsPageDataRequest({ offset: 0, search: undefined })
      );
    });
    // The full, unfiltered result set is shown again.
    expect(
      await screen.findByRole("link", { name: "Shell Active Session" })
    ).toBeDefined();
  });

  it("treats a whitespace-only query as an empty submit and restores the full list", async () => {
    await renderDesktopApp("#/sessions?search=Failed+Session");

    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
    expect(
      await screen.findByRole("link", { name: "Shell Failed Session" })
    ).toBeDefined();

    const searchInput = await openLabsSearch();
    // Whitespace-only input is treated as empty and resets to the bare route.
    fireEvent.change(searchInput, { target: { value: "   " } });
    const searchForm = searchInput.closest("form");
    fireEvent.submit(searchForm as HTMLFormElement);

    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions");
    });
    expect(searchInput.value).toBe("");
    await waitFor(() => {
      expect(window.desktopApi.agentSessionsApi.pageData).toHaveBeenCalledWith(
        expect.objectContaining({ search: undefined })
      );
    });
    expect(
      await screen.findByRole("link", { name: "Shell Active Session" })
    ).toBeDefined();
  });

  it("restores the full list from an empty filtered result when the search is cleared with Return", async () => {
    await renderDesktopApp("#/sessions");

    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
    expect(
      await screen.findByRole("link", { name: "Shell Active Session" })
    ).toBeDefined();

    const searchInput = await openLabsSearch();

    // A query that matches nothing collapses the list to the empty state.
    fireEvent.change(searchInput, {
      target: { value: "no-such-session-xyz" },
    });
    fireEvent.submit(searchInput.closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(window.location.hash).toBe(
        "#/sessions?search=no-such-session-xyz"
      );
    });
    // FEA-4181: a search term is an active filter, so an empty result is the
    // filtered-empty "No matching sessions" (not the old "No sessions found").
    expect(await screen.findByText("No matching sessions")).toBeDefined();
    expect(
      screen.queryByRole("link", { name: "Shell Active Session" })
    ).toBeNull();

    // Deleting the query and pressing Return returns to the full list, not the
    // empty state it collapsed to while filtered.
    fireEvent.change(searchInput, { target: { value: "" } });
    fireEvent.submit(searchInput.closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions");
    });
    expect(
      await screen.findByRole("link", { name: "Shell Active Session" })
    ).toBeDefined();
    expect(screen.queryByText("No matching sessions")).toBeNull();
  });

  it("treats Return on an already-empty search input as a no-op that keeps the full list", async () => {
    await renderDesktopApp("#/sessions");

    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
    expect(
      await screen.findByRole("link", { name: "Shell Active Session" })
    ).toBeDefined();

    const searchInput = await openLabsSearch();
    expect(searchInput.value).toBe("");
    // The unfiltered route shows no active-search indicator to begin with.
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();

    fireEvent.submit(searchInput.closest("form") as HTMLFormElement);

    // Submitting an empty query keeps the unfiltered route and never appends a
    // search parameter.
    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions");
    });
    expect(window.location.hash).not.toContain("search=");
    expect(
      screen.getByRole("link", { name: "Shell Active Session" })
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    // No search-scoped fetch was ever issued (the Sessions view reads through
    // the combined `pageData` call).
    expect(
      vi
        .mocked(window.desktopApi.agentSessionsApi.pageData)
        .mock.calls.some(([request]) => Boolean(request?.search))
    ).toBe(false);
  });

  it("forwards selected session statuses to the desktop local data source and resets pagination", async () => {
    await renderDesktopApp("#/sessions?page=2");
    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
    await waitFor(() => {
      expect(pageDataReads()).toContainEqual({ offset: 25, statuses: [] });
    });

    // ISS-8909: driven through the REAL Filter control the shared v2 surface
    // renders. The v1 `SessionsToolbar` this case used to mock is no longer
    // mounted, so a mock of it would never run — but what the case asserts is
    // the SHELL's contract and is unchanged: a status facet selection has to
    // reach the desktop local data source and reset the page.
    fireEvent.pointerDown(
      screen.getByRole("button", { name: SESSIONS_TOOLBAR_FILTER_BUTTON }),
      { button: 0, ctrlKey: false }
    );
    const statusFacet = within(screen.getByRole("menu")).getByRole("menuitem", {
      name: "Status",
    });
    // Keyboard rather than hover: Radix opens a submenu on either, and the
    // keyboard route needs no pointer geometry jsdom cannot supply.
    fireEvent.keyDown(statusFacet, { key: "ArrowRight" });
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: SESSION_STATUS_LABELS[SessionStatusFacetValue.Inactive],
      })
    );

    // FEA-3560: the page-resetting replace also mirrors the selected status
    // into the hash URL, so detail→back / restart restores the filtered view.
    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions?status=inactive");
    });
    await waitFor(() => {
      expect(pageDataReads()).toContainEqual({
        offset: 0,
        statuses: [SessionStatusFacetValue.Inactive],
      });
    });
  });

  it("returns from a page-two session detail to the same sessions page and scroll position", async () => {
    // Launch empty (Dashboard, the canonical landing) and navigate, so the
    // Sessions list under test sits in the keep-alive map exactly where
    // production puts it — second, under a still-mounted Dashboard.
    const firstRender = renderDesktopApp("");
    expect(await findTopbarCurrentPage("Dashboard")).toBeDefined();
    window.location.hash = "#/sessions";
    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
    expect(
      (await screen.findAllByRole("link", { name: "Shell Active Session" }))
        .length
    ).toBeGreaterThan(0);

    fireEvent.click(screen.getByLabelText("Go to next page"));
    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions?page=2");
    });
    await waitFor(() => {
      expect(window.desktopApi.agentSessionsApi.pageData).toHaveBeenCalledWith(
        defaultSessionsPageDataRequest({ offset: 25, search: undefined })
      );
    });
    firstRender.unmount();

    const { navigation } = renderDesktopApp("#/sessions?page=2");
    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
    await waitFor(() => {
      expect(window.desktopApi.agentSessionsApi.pageData).toHaveBeenCalledWith(
        defaultSessionsPageDataRequest({ offset: 25, search: undefined })
      );
    });

    // ISS-12471: the content viewport is NOT the scroller on this route -- the
    // Sessions body pins itself to the window height and the grid band scrolls
    // inside it.
    const scrollBand = screen.getByTestId(GRID_TABLE_SCROLL_BAND_TEST_ID);
    scrollBand.scrollTop = 384;
    fireEvent.scroll(scrollBand);

    const pageTwoLink = await screen.findByRole("link", {
      name: "Shell Page Two Session",
    });
    window.location.hash =
      pageTwoLink.getAttribute("href") ?? "#/sessions/s-page-two";
    expect(
      await findSharedRouteHeading("Shell Page Two Session")
    ).toBeDefined();
    expect(window.desktopApi.agentSessionsApi.detail).toHaveBeenCalledWith(
      "s-page-two",
      { readInitiator: ReadInitiator.User }
    );
    expect(navigation.getHistory()).toContain("/sessions/s-page-two");
    // The breadcrumb's "Sessions" parent preserves the originating list's page
    // query (and restores its scroll) — the back affordance now that the in-page
    // "Back to Sessions" control is gone.
    const sessionsCrumb = within(
      screen.getByRole("navigation", { name: "breadcrumb" })
    ).getByRole("link", { name: "Sessions" });
    expect(sessionsCrumb.getAttribute("href")).toBe("#/sessions?page=2");

    fireEvent.click(sessionsCrumb);
    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions?page=2");
    });
    expect(
      await screen.findByRole("link", { name: "Shell Page Two Session" })
    ).toBeDefined();
    // The band the list comes back on is a fresh node, so the offset below is
    // the restore and not a value jsdom was still holding.
    expect(screen.getByTestId(GRID_TABLE_SCROLL_BAND_TEST_ID)).not.toBe(
      scrollBand
    );
    await waitFor(() => {
      expect(screen.getByTestId(GRID_TABLE_SCROLL_BAND_TEST_ID).scrollTop).toBe(
        384
      );
    });
  });

  it("keeps desktop insights scans opt-in and unmounts insights when inactive", async () => {
    await renderDesktopApp("#/insights");

    // ISS-5037: Insights is a Labs destination, so the first frame here is the
    // gate's HOLD — and the hold deliberately renders the destination's own
    // PageShell + title, which is the whole point (the flag resolving open must
    // be a no-op on screen). That makes the "Insights" heading true of both the
    // hold and the loaded page, so waiting on the heading no longer proves the
    // page mounted. Wait on the page's own opt-in copy instead, which only the
    // real view renders.
    expect(await findSharedRouteHeading("Insights")).toBeDefined();
    expect(await screen.findByText("Local session history")).toBeDefined();
    expect(screen.getByRole("button", { name: "Load insights" })).toBeDefined();
    expect(window.desktopApi.agentSessionsApi.list).not.toHaveBeenCalled();
    expect(window.desktopApi.agentSessionsApi.usage).not.toHaveBeenCalled();
    expect(window.desktopApi.agentSessionsApi.analytics).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Load insights" }));
    await waitFor(() => {
      expect(window.desktopApi.agentSessionsApi.list).toHaveBeenCalledWith({
        readInitiator: ReadInitiator.User,
        limit: 25,
        offset: 0,
      });
    });
    // The loaded bounded view keeps the single "Insights" <h1> (FEA-3989) and
    // fetches only the list (no eager usage/analytics on mount).
    expect(await findSharedRouteHeading("Insights")).toBeDefined();
    expect(window.desktopApi.agentSessionsApi.usage).not.toHaveBeenCalled();
    expect(window.desktopApi.agentSessionsApi.analytics).not.toHaveBeenCalled();
  });

  it("renders the shared detail not-found state through the real route wrapper", async () => {
    await renderDesktopApp("#/sessions/missing");

    expect(await screen.findByText("Session not found")).toBeDefined();
    expect(window.desktopApi.agentSessionsApi.detail).toHaveBeenCalledWith(
      "missing",
      { readInitiator: ReadInitiator.User }
    );
  });

  /**
   * A link that says "Back to Sessions" has to go to Sessions.
   *
   * The shell handed `SessionDetailView` the raw `sessionBackHref` — the last
   * nav route of ANY section, which exists to keep the originating TAB
   * highlighted, not to name a destination. That prop feeds only the not-found
   * and provider-error states, whose sole control is a link labelled "Back to
   * Sessions", so a detail opened from any other surface aimed that link at that
   * surface. With Dashboard as the canonical landing it resolved to `/dashboard`
   * on the ordinary launch path, and the one way out of a dead end navigated
   * somewhere its own label denied.
   *
   * It now takes `sessionsListHref`, the Sessions-coerced href the breadcrumb
   * parent already used, so the label and the destination cannot disagree —
   * while still preserving the originating list's query when there is one. Both
   * halves are pinned below: the coercion, and the preservation it must not cost.
   */
  it("points the not-found state's back link at Sessions, not at the landing page", async () => {
    await renderDesktopApp("");
    expect(await findTopbarCurrentPage("Dashboard")).toBeDefined();

    window.location.hash = "#/sessions/missing";
    expect(await screen.findByText("Session not found")).toBeDefined();

    expect(
      screen
        .getByRole("link", { name: "Back to Sessions" })
        .getAttribute("href")
    ).toBe("#/sessions");
  });

  it("returns the not-found state to the originating sessions page, query and all", async () => {
    await renderDesktopApp("#/sessions?page=2");
    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();

    window.location.hash = "#/sessions/missing";
    expect(await screen.findByText("Session not found")).toBeDefined();

    expect(
      screen
        .getByRole("link", { name: "Back to Sessions" })
        .getAttribute("href")
    ).toBe("#/sessions?page=2");
  });

  it("renders desktop local session details without unsupported write controls", async () => {
    await renderDesktopApp("#/sessions/s-pending");

    expect(await findSharedRouteHeading("Shell Pending Session")).toBeDefined();
    const { contentViewport, detailShell, traceScroller, workspace } =
      getDesktopSessionDetailScrollElements();
    expect(workspace).toBeInstanceOf(HTMLElement);
    expect(traceScroller).toBeInstanceOf(HTMLElement);
    expect(detailShell?.className).toEqual(
      expect.stringContaining("overflow-hidden")
    );
    expect(detailShell?.className).toEqual(expect.stringContaining("h-full"));
    expect(contentViewport?.className).toEqual(
      expect.stringContaining("min-h-0")
    );
    expect(contentViewport?.className).toEqual(
      expect.stringContaining("overflow-hidden")
    );
    expect(contentViewport?.className).not.toEqual(
      expect.stringContaining("overflow-auto")
    );
    // FEA-4233: a zero-comment session folds the rail to its slim re-open handle
    // once the discovery read settles empty, rather than an open "Comments"
    // panel. This spec's point is the scroll-shell wiring, not the rail — assert
    // the collapsed handle.
    expect(
      await screen.findByRole("button", { name: SHOW_COMMENTS_BUTTON_NAME })
    ).toBeDefined();
    expect(document.querySelector(".sd3-cmts")).toBeNull();

    window.location.hash = "#/sessions/s-blocked";
    expect(await findSharedRouteHeading("Shell Blocked Session")).toBeDefined();
    expect(
      await screen.findByRole("button", { name: SHOW_COMMENTS_BUTTON_NAME })
    ).toBeDefined();
    expect(document.querySelector(".sd3-cmts")).toBeNull();

    expect(window.desktopApi.agentSessionsApi.detail).toHaveBeenCalledWith(
      "s-pending",
      { readInitiator: ReadInitiator.User }
    );
    expect(window.desktopApi.agentSessionsApi.detail).toHaveBeenCalledWith(
      "s-blocked",
      { readInitiator: ReadInitiator.User }
    );
  });
});

/**
 * The sidebar search box, reached by opening Labs.
 *
 * ISS-8759 (desktop mirror): the search control moved INTO the Labs section,
 * which ships collapsed (ISS-4478, reaffirmed by the operator 2026-09-03) and
 * whose collapsible unmounts its body while closed. Every case that drives
 * search therefore opens Labs first — the same thing the desktop e2e helpers
 * (`labs-flag-seeding-contract.spec.ts`) already do. What each case asserts
 * about SEARCH is unchanged; only the route to the control is.
 */
async function openLabsSearch(): Promise<HTMLInputElement> {
  const labsToggle = await screen.findByRole("button", { name: "Labs" });
  if (labsToggle.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(labsToggle);
  }
  await waitFor(() =>
    expect(labsToggle.getAttribute("aria-expanded")).toBe("true")
  );
  // Re-queried AFTER the section has settled: the collapsible mounts its body
  // asynchronously, so a reference taken mid-open can be replaced underneath.
  return (await screen.findByRole("textbox", {
    name: "Search",
  })) as HTMLInputElement;
}

/** Each `pageData` read's page offset and requested statuses, in call order. */
function pageDataReads() {
  return vi
    .mocked(window.desktopApi.agentSessionsApi.pageData)
    .mock.calls.map(([request = {}]) => ({
      offset: request.offset,
      statuses: requestedSessionStatuses(request),
    }));
}
