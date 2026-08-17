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
import type { AgentSessionsPageData } from "@repo/api/src/types/agent-session";
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
import { agentSessionUsage } from "./app-shell-session-fixtures";

vi.mock("../components/UpdateBanner", () => ({
  UpdateBanner: () => null,
}));
vi.mock("@repo/app/agents/components/sessions/sessions-toolbar", () => ({
  SessionsToolbar: ({
    onFiltersChange,
  }: {
    onFiltersChange: (next: {
      statuses: string[];
      userIds: string[];
      repositories: string[];
    }) => void;
  }) => (
    <button
      onClick={() =>
        onFiltersChange({
          statuses: [SessionStatusFacetValue.Inactive],
          userIds: [],
          repositories: [],
        })
      }
      type="button"
    >
      Apply inactive status filter
    </button>
  ),
}));

describe("App shell sessions surface", () => {
  setupAppShellSuite();

  it("renders real shared sessions and insights wrappers through the desktop provider", async () => {
    // The default route is the Sessions page (Dashboard is a placeholder).
    // Views are reached by hash navigation since the sidebar nav items are
    // links folded into a collapsed Labs section under FOCUS_MODE.
    await renderDesktopApp("");

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
      "s-active"
    );
  });

  it("submits top-left search to the sessions view and forwards the local search filter", async () => {
    await renderDesktopApp("#/sessions");

    const searchInput = screen.getByPlaceholderText("Search");
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
      expect(window.desktopApi.agentSessionsApi.pageData).toHaveBeenCalledWith({
        limit: 25,
        offset: 0,
        search: "Failed Session",
        // The stable complete UTC window scopes every sessions list query.
        startDate: expect.any(String),
        endDate: expect.any(String),
        statuses: [],
        repositories: [],
        harnesses: [],
        models: [],
        autonomyTiers: [],
        costBuckets: [],
        changePresence: [],
        prAssociation: [],
        // PLN-1034: Sessions default to most-recent-activity, descending.
        sortBy: "lastActivity",
        sortDir: "desc",
        // Owner facet (sessions-owner-attribution) threads userIds through the query.
        userIds: [],
      });
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
    const pendingPageData = new Promise<AgentSessionsPageData>(() => undefined);
    vi.mocked(window.desktopApi.agentSessionsApi.pageData).mockImplementation(
      (request = {}) => {
        if (request.search) {
          return pendingPageData;
        }
        return Promise.resolve({
          list: { items: [], total: 0, viewerScope: "self" },
          usage: agentSessionUsage(0),
        });
      }
    );
    vi.mocked(window.desktopApi.agentSessionsApi.usage).mockImplementation(() =>
      Promise.resolve(agentSessionUsage(0))
    );

    const searchInput = screen.getByPlaceholderText("Search");
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
    expect(screen.queryByLabelText("Go to next page")).toBeNull();
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
    const activeSearchInput = screen.getByRole("textbox", {
      name: "Search",
    }) as HTMLInputElement;
    expect(activeSearchInput.value).toBe("Failed Session");

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions");
    });
    expect(activeSearchInput.value).toBe("");
    await waitFor(() => {
      expect(window.desktopApi.agentSessionsApi.pageData).toHaveBeenCalledWith({
        limit: 25,
        offset: 0,
        search: undefined,
        // The stable complete UTC window scopes every sessions list query.
        startDate: expect.any(String),
        endDate: expect.any(String),
        statuses: [],
        repositories: [],
        harnesses: [],
        models: [],
        autonomyTiers: [],
        costBuckets: [],
        changePresence: [],
        prAssociation: [],
        sortBy: "lastActivity",
        sortDir: "desc",
        // Owner facet (sessions-owner-attribution) threads userIds through the query.
        userIds: [],
      });
    });
  });

  it("clears a draft sessions search to the unfiltered sessions route", async () => {
    await renderDesktopApp("#/sessions");

    const searchInput = screen.getByRole("textbox", { name: "Search" });
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

    const searchInput = screen.getByRole("textbox", {
      name: "Search",
    }) as HTMLInputElement;
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
      expect(window.desktopApi.agentSessionsApi.pageData).toHaveBeenCalledWith({
        limit: 25,
        offset: 0,
        search: undefined,
        // The stable complete UTC window scopes every sessions list query.
        startDate: expect.any(String),
        endDate: expect.any(String),
        statuses: [],
        repositories: [],
        harnesses: [],
        models: [],
        autonomyTiers: [],
        costBuckets: [],
        changePresence: [],
        prAssociation: [],
        sortBy: "lastActivity",
        sortDir: "desc",
        // Owner facet (sessions-owner-attribution) threads userIds through the query.
        userIds: [],
      });
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

    const searchInput = screen.getByRole("textbox", {
      name: "Search",
    }) as HTMLInputElement;
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

    const searchInput = screen.getByRole("textbox", {
      name: "Search",
    }) as HTMLInputElement;

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

    const searchInput = screen.getByRole("textbox", {
      name: "Search",
    }) as HTMLInputElement;
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
      expect(window.desktopApi.agentSessionsApi.pageData).toHaveBeenCalledWith(
        expect.objectContaining({
          offset: 25,
          statuses: [],
        })
      );
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Apply inactive status filter" })
    );

    // FEA-3560: the page-resetting replace also mirrors the selected status
    // into the hash URL, so detail→back / restart restores the filtered view.
    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions?status=inactive");
    });
    await waitFor(() => {
      expect(window.desktopApi.agentSessionsApi.pageData).toHaveBeenCalledWith(
        expect.objectContaining({
          offset: 0,
          statuses: [SessionStatusFacetValue.Inactive],
        })
      );
    });
  });

  it("returns from a page-two session detail to the same sessions page and scroll position", async () => {
    const firstRender = renderDesktopApp("");
    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
    expect(
      await screen.findByRole("link", { name: "Shell Active Session" })
    ).toBeDefined();

    fireEvent.click(screen.getByLabelText("Go to next page"));
    await waitFor(() => {
      expect(window.location.hash).toBe("#/sessions?page=2");
    });
    await waitFor(() => {
      expect(window.desktopApi.agentSessionsApi.pageData).toHaveBeenCalledWith({
        limit: 25,
        offset: 25,
        search: undefined,
        // The stable complete UTC window scopes every sessions list query.
        startDate: expect.any(String),
        endDate: expect.any(String),
        statuses: [],
        repositories: [],
        harnesses: [],
        models: [],
        autonomyTiers: [],
        costBuckets: [],
        changePresence: [],
        prAssociation: [],
        sortBy: "lastActivity",
        sortDir: "desc",
        // Owner facet (sessions-owner-attribution) threads userIds through the query.
        userIds: [],
      });
    });
    firstRender.unmount();

    const { navigation } = renderDesktopApp("#/sessions?page=2");
    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
    await waitFor(() => {
      expect(window.desktopApi.agentSessionsApi.pageData).toHaveBeenCalledWith({
        limit: 25,
        offset: 25,
        search: undefined,
        // The stable complete UTC window scopes every sessions list query.
        startDate: expect.any(String),
        endDate: expect.any(String),
        statuses: [],
        repositories: [],
        harnesses: [],
        models: [],
        autonomyTiers: [],
        costBuckets: [],
        changePresence: [],
        prAssociation: [],
        sortBy: "lastActivity",
        sortDir: "desc",
        // Owner facet (sessions-owner-attribution) threads userIds through the query.
        userIds: [],
      });
    });

    const contentViewport = screen.getByTestId("desktop-content-viewport");
    contentViewport.scrollTop = 384;
    fireEvent.scroll(contentViewport);

    const pageTwoLink = await screen.findByRole("link", {
      name: "Shell Page Two Session",
    });
    window.location.hash =
      pageTwoLink.getAttribute("href") ?? "#/sessions/s-page-two";
    expect(
      await findSharedRouteHeading("Shell Page Two Session")
    ).toBeDefined();
    expect(window.desktopApi.agentSessionsApi.detail).toHaveBeenCalledWith(
      "s-page-two"
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
    await waitFor(() => {
      expect(screen.getByTestId("desktop-content-viewport").scrollTop).toBe(
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
      "missing"
    );
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
      "s-pending"
    );
    expect(window.desktopApi.agentSessionsApi.detail).toHaveBeenCalledWith(
      "s-blocked"
    );
  });
});
