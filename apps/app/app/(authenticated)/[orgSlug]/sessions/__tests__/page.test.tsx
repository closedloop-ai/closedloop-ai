import { AgentSessionComparisonMode } from "@repo/api/src/types/agent-session-usage-comparison";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SessionStatusFacetValue } from "@repo/app/agents/lib/session-status-filters";
import {
  SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY,
  SESSIONS_OWNER_SCOPE_CHIP_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { expectCriticalAxeClean } from "@repo/app/test/a11y/axe";
import {
  A11yTheme,
  expectElementContrast,
  themeBackground,
} from "@repo/app/test/a11y/contrast";
import { A11yThemeRoot } from "@repo/app/test/a11y/react";
import { focusManager } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionsPageQuery,
  enableSessionsPageFeatureFlag,
  lastSessionsTableCallArgs,
  mockSessionsPageEmptyState,
  mockSessionsPageListErrorState,
  mockSessionsPageLoadingState,
  mockSessionsPageRefetchSpies,
  navigationReplaceMock,
  orgDefaultSessionsPageHookArgs,
  resetSessionsPageTestState,
  selectedUserSessionsPageHookArgs,
  sessionLinkName,
  sessionsEmptyDescription,
  sessionsEmptyTitle,
  setSelectedSessionUser,
  setSessionsFacetQuery,
  setSessionsPageQuery,
  setSessionsTotal,
  useAgentSessionsMock,
  useAgentSessionUsageMock,
} from "../../../__tests__/sessions-page-test-helpers";
import SessionsPage from "../page";

// The Status sort-header button's accessible name is exactly "Status". Anchor
// the match so it does not also resolve the GridTable column-reorder handle,
// whose aria-label is "Reorder Status column, use arrow keys" (FEA-4021/4150).
const STATUS_BUTTON_NAME_REGEX = /^Status$/;
// ISS-5975: deliberately loose. The removed control's accessible name was
// "Refresh sessions" with a visible "Refresh" label, so matching the word
// anywhere catches a reintroduction under either spelling.
const REFRESH_BUTTON_NAME_REGEX = /refresh/i;
const A11Y_THEMES = [A11yTheme.Light, A11yTheme.Dark] as const;

describe("org sessions page wrapper", () => {
  beforeEach(() => {
    resetSessionsPageTestState("organization");
  });

  afterEach(() => {
    // `focusManager` is a module-level singleton shared by every test in the
    // process. Hand it back to its own document-driven default so a suite that
    // drove a focus transition cannot leave the next one pinned.
    focusManager.setFocused(undefined);
  });

  // FEA-4155: the P0 blank-render bug was this page gating its whole body behind
  // the `DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY` flag via `<FeatureFlagged>`
  // whose default fallback is `null`. Flags are being wound down, so once that
  // flag resolved to a real false/absent the surface blanked. The surface is now
  // always-on — its content renders directly, no flag gate. This test proves the
  // real session rows render and the page no longer wraps them in a flag gate.
  // ISS-5574: every Sessions/Branches page reported the app-wide "Closedloop.ai",
  // so several open tabs were indistinguishable. Asserts the REAL document.title
  // for this route, and that the flag-off default is untouched.
  it("names the browser tab after this surface, behind the flag", () => {
    const previousTitle = document.title;
    document.title = "Closedloop.ai";
    try {
      const flaggedOff = render(<SessionsPage />);
      expect(document.title).toBe("Closedloop.ai");
      flaggedOff.unmount();

      enableSessionsPageFeatureFlag(
        SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY
      );
      render(<SessionsPage />);
      expect(document.title).toBe("Sessions | Closedloop.ai");
    } finally {
      document.title = previousTitle;
    }
  });

  it("renders session rows directly with no feature-flag gate (FEA-4155)", () => {
    render(<SessionsPage />);

    const sessionLink = screen.getByRole("link", { name: sessionLinkName });

    expect(sessionLink).toHaveAttribute("href", "/acme/sessions/session-1");
    // No feature-flag gate wraps the body anymore (regression guard).
    expect(sessionLink.closest("[data-feature-flag]")).toBeNull();
    expect(useAgentSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining(orgDefaultSessionsPageHookArgs),
      expect.anything()
    );
  });

  it("shares one stable UTC window across remounts and compares within that read", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-07T12:00:00.000Z"));

    try {
      const first = render(<SessionsPage />);
      const firstWindow = lastSessionsTableCallArgs();
      const firstStartDate =
        typeof firstWindow?.startDate === "string"
          ? firstWindow.startDate
          : undefined;
      const firstEndDate =
        typeof firstWindow?.endDate === "string"
          ? firstWindow.endDate
          : undefined;
      // The cards aggregate the SAME window the table paints (FEA-4298 /
      // ISS-4429). Both come from one helper call, and this is what stops them
      // drifting apart again.
      expect(
        useAgentSessionUsageMock.mock.calls.some(
          ([filters]) =>
            filters?.startDate === firstStartDate &&
            filters?.endDate === firstEndDate &&
            // ISS-5809: that one read also carries the comparison opt-in, so the
            // period-over-period chip needs no request of its own.
            filters?.comparison === AgentSessionComparisonMode.Prior
        )
      ).toBe(true);
      const currentStartMs = Date.parse(firstStartDate ?? "");
      const currentEndMs = Date.parse(firstEndDate ?? "");
      const windowWidthMs = currentEndMs - currentStartMs + 1;
      // ISS-5809: and NOTHING asks for the adjacent prior window any more. This
      // is the deleted request, asserted as an absence — without it, reviving the
      // second read would go unnoticed.
      expect(
        useAgentSessionUsageMock.mock.calls.some(
          ([filters]) =>
            filters?.startDate ===
              new Date(currentStartMs - windowWidthMs).toISOString() &&
            filters?.endDate === new Date(currentStartMs - 1).toISOString()
        )
      ).toBe(false);
      first.unmount();
      vi.setSystemTime(new Date("2026-08-07T23:59:59.999Z"));

      const sameDay = render(<SessionsPage />);
      expect(lastSessionsTableCallArgs()?.startDate).toBe(firstStartDate);
      expect(lastSessionsTableCallArgs()?.endDate).toBe(firstEndDate);
      vi.setSystemTime(new Date("2026-08-08T00:00:00.000Z"));

      sameDay.rerender(<SessionsPage />);
      const nextDayStartDate = lastSessionsTableCallArgs()?.startDate;
      const nextDayEndDate = lastSessionsTableCallArgs()?.endDate;
      expect(nextDayStartDate).not.toBe(firstStartDate);
      expect(nextDayEndDate).not.toBe(firstEndDate);
      expect(
        useAgentSessionUsageMock.mock.calls.some(
          ([filters]) =>
            filters?.startDate === nextDayStartDate &&
            filters?.endDate === nextDayEndDate
        )
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves selected-user query filtering", () => {
    setSelectedSessionUser("user-123");

    render(<SessionsPage />);

    expect(screen.getByText("User filtered")).toBeInTheDocument();
    expect(useAgentSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining(selectedUserSessionsPageHookArgs),
      expect.anything()
    );
  });

  // ISS-4728: with the flag ON the selected-user scope moves OUT of the legacy
  // badge and INTO the active-filter chip row. What must not move is the URL
  // contract: `?userId=` still narrows the read, and a link from another surface
  // still lands on the same rows.
  it("folds the selected-user scope into the chip row without changing the ?userId query contract", () => {
    enableSessionsPageFeatureFlag(SESSIONS_OWNER_SCOPE_CHIP_FEATURE_FLAG_KEY);
    setSelectedSessionUser("user-123");

    render(<SessionsPage />);

    expect(screen.queryByText("User filtered")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Showing sessions for the selected user.")
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("toolbar-scope-user-id")).toHaveTextContent(
      "user-123"
    );
    // The read is byte-identical to the flag-OFF path above.
    expect(useAgentSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining(selectedUserSessionsPageHookArgs),
      expect.anything()
    );
  });

  it("removing the scope chip strips ONLY ?userId, keeping the active facets", async () => {
    const user = userEvent.setup();
    enableSessionsPageFeatureFlag(SESSIONS_OWNER_SCOPE_CHIP_FEATURE_FLAG_KEY);
    setSelectedSessionUser("user-123");
    setSessionsFacetQuery("status", [SessionStatusFacetValue.Inactive]);

    render(<SessionsPage />);

    await user.click(
      screen.getByRole("button", { name: "Remove selected user scope" })
    );

    // `?userId` is gone; the Status facet the user set here survives. A remove
    // that also wiped the facets would be "Clear all" wearing a chip's clothes.
    expect(navigationReplaceMock).toHaveBeenLastCalledWith(
      "/acme/sessions?status=inactive",
      { scroll: false }
    );
  });

  it("removing the MERGED owner chip strips ?userId AND the owner facet in one write", async () => {
    const user = userEvent.setup();
    enableSessionsPageFeatureFlag(SESSIONS_OWNER_SCOPE_CHIP_FEATURE_FLAG_KEY);
    // The same person is both the deep-link scope and a selected Owner facet
    // value, which is the case the chip row collapses into ONE chip.
    setSelectedSessionUser("user-123");
    setSessionsFacetQuery("owner", ["user-123"]);
    setSessionsFacetQuery("status", [SessionStatusFacetValue.Inactive]);

    render(<SessionsPage />);

    const replacesBeforeClick = navigationReplaceMock.mock.calls.length;
    await user.click(
      screen.getByRole("button", { name: "Remove merged owner scope" })
    );

    // ONE write for the whole gesture. Two replaces is the defect itself: both
    // copy the same pre-click params snapshot, so whichever lands second
    // reinstates the narrower the first removed.
    expect(navigationReplaceMock.mock.calls.length).toBe(
      replacesBeforeClick + 1
    );
    // REGRESSION GUARD (review cid 3701353686): assert the LAST navigation, and
    // assert it carries NEITHER narrower. The previous implementation issued two
    // replaces from one click — the second copied the same pre-click params
    // snapshot and put `?userId=user-123` back, so the chip reappeared over a
    // still-narrowed list. Every unrelated facet must still survive.
    expect(navigationReplaceMock).toHaveBeenLastCalledWith(
      "/acme/sessions?status=inactive",
      { scroll: false }
    );
    const lastUrl = navigationReplaceMock.mock.lastCall?.[0] as string;
    expect(lastUrl).not.toContain("userId");
    expect(lastUrl).not.toContain("owner");
  });

  it("forwards no scope to the toolbar when the flag is off", () => {
    setSelectedSessionUser("user-123");

    render(<SessionsPage />);

    expect(
      screen.queryByTestId("toolbar-scope-user-id")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove selected user scope" })
    ).not.toBeInTheDocument();
  });

  it("uses the page query for API offset and writes pagination through the route", async () => {
    const user = userEvent.setup();
    setSessionsPageQuery("2");
    setSelectedSessionUser("user-123");
    setSessionsTotal(50);

    render(<SessionsPage />);

    expect(useAgentSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        offset: 25,
        userId: "user-123",
      }),
      expect.anything()
    );

    await user.click(
      within(screen.getByRole("navigation", { name: "pagination" })).getByText(
        "1"
      )
    );

    expect(navigationReplaceMock).toHaveBeenCalledWith(
      "/acme/sessions?userId=user-123",
      { scroll: false }
    );
  });

  it("bounds summary cards and pagination inside the shared scroll surface", () => {
    setSessionsTotal(50);

    const { container } = render(<SessionsPage />);

    const summarySurface = container.querySelector(".sticky.left-0");
    expect(summarySurface).toBeInTheDocument();
    const pagination = screen.getByRole("navigation", { name: "pagination" });
    expect(pagination).toHaveClass("min-w-max");
    expect(pagination.parentElement).toHaveClass("overflow-x-auto");
  });

  it("repairs a stale page query after the response proves it is out of range", async () => {
    setSessionsPageQuery("2");
    setSessionsTotal(10);

    render(<SessionsPage />);

    expect(useAgentSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 25 }),
      expect.anything()
    );
    await waitFor(() =>
      expect(navigationReplaceMock).toHaveBeenCalledWith("/acme/sessions", {
        scroll: false,
      })
    );
    expect(useAgentSessionsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 0 }),
      expect.anything()
    );
  });

  it("prevents a stale page offset after sorting while search params still lag", async () => {
    const user = userEvent.setup();
    setSessionsPageQuery("2");
    setSessionsTotal(50);

    const { rerender } = render(<SessionsPage />);
    expect(useAgentSessionsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 25 }),
      expect.anything()
    );

    await user.click(
      screen.getByRole("button", { name: STATUS_BUTTON_NAME_REGEX })
    );

    expect(navigationReplaceMock).toHaveBeenCalledWith("/acme/sessions", {
      scroll: false,
    });
    expect(useAgentSessionsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 0 }),
      expect.anything()
    );

    clearSessionsPageQuery();
    rerender(<SessionsPage />);

    expect(useAgentSessionsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 0 }),
      expect.anything()
    );
  });

  it("prevents a stale page offset after facet filters change while search params still lag", async () => {
    const user = userEvent.setup();
    setSessionsPageQuery("2");
    setSessionsTotal(50);

    render(<SessionsPage />);
    expect(useAgentSessionsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 25 }),
      expect.anything()
    );

    await user.click(screen.getByRole("button", { name: "Filter owner Ada" }));

    // FEA-3560: the same replace that resets the page mirrors the facet into
    // the URL, so a later detail→back restores the filtered view.
    expect(navigationReplaceMock).toHaveBeenCalledWith(
      "/acme/sessions?owner=user-e2e",
      { scroll: false }
    );
    await waitFor(() =>
      expect(useAgentSessionsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          offset: 0,
          userIds: ["user-e2e"],
        }),
        expect.anything()
      )
    );
  });

  it("sends selected status facets as canonical statuses and resets pagination", async () => {
    const user = userEvent.setup();
    setSessionsPageQuery("2");
    setSessionsTotal(50);

    render(<SessionsPage />);
    expect(lastSessionsTableCallArgs()).toEqual(
      expect.objectContaining({ offset: 25, statuses: [] })
    );

    await user.click(
      screen.getByRole("button", { name: "Apply lifecycle filters" })
    );

    // FEA-3560: the page-resetting replace carries the selected statuses.
    // ISS-4696: the values are the facet vocabulary the Filter popover can
    // actually emit, not the `completed`/`abandoned` ISS-4586 retired.
    expect(navigationReplaceMock).toHaveBeenCalledWith(
      "/acme/sessions?status=active&status=inactive",
      { scroll: false }
    );
    await waitFor(() =>
      expect(lastSessionsTableCallArgs()).toEqual(
        expect.objectContaining({
          offset: 0,
          statuses: [
            SessionStatusFacetValue.Active,
            SessionStatusFacetValue.Inactive,
          ],
        })
      )
    );
    expect(lastSessionsTableCallArgs()).not.toHaveProperty("status");
  });

  // FEA-4194: the unapproved Substantive | Idle | All quality segment was
  // removed, so the web adapter must never send a `quality` filter — not on the
  // paginated list read and not on the summary usage read. The server defaults
  // an absent `quality` to `all` (fail-open), so every session shows regardless
  // of substantive/idle.
  it("never sends a quality filter to the list or the summary usage read", () => {
    render(<SessionsPage />);
    expect(lastSessionsTableCallArgs()).not.toHaveProperty("quality");
    // The paginated list read (FEA-4177 split query) omits quality.
    expect(useAgentSessionsMock).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ quality: expect.anything() }),
      expect.anything()
    );
    // Every usage read (facet-option + summary) omits quality too.
    expect(
      useAgentSessionUsageMock.mock.calls.every(
        (call) => !(call[0] && "quality" in call[0])
      )
    ).toBe(true);
  });

  // FEA-3560 regression: navigating into a session detail unmounts the list;
  // coming back restores the list URL (history / breadcrumb) but not component
  // state. The page must re-seed its facet filters from the URL on mount so the
  // restored view queries the FILTERED set, not page N of the unfiltered one.
  it("seeds facet filters from the list URL on mount (detail→back restore)", () => {
    setSessionsFacetQuery("owner", ["user-e2e"]);
    setSessionsFacetQuery("status", [
      SESSION_STATUS.ACTIVE,
      SESSION_STATUS.INACTIVE,
    ]);
    setSessionsPageQuery("2");
    setSessionsTotal(50);

    render(<SessionsPage />);

    expect(lastSessionsTableCallArgs()).toEqual(
      expect.objectContaining({
        offset: 25,
        statuses: [SESSION_STATUS.ACTIVE, SESSION_STATUS.INACTIVE],
        userIds: ["user-e2e"],
      })
    );
  });

  it("carries facet params through pagination replaces", async () => {
    const user = userEvent.setup();
    setSessionsFacetQuery("owner", ["user-e2e"]);
    setSessionsTotal(50);

    render(<SessionsPage />);

    await user.click(
      within(screen.getByRole("navigation", { name: "pagination" })).getByText(
        "2"
      )
    );

    expect(navigationReplaceMock).toHaveBeenCalledWith(
      "/acme/sessions?owner=user-e2e&page=2",
      { scroll: false }
    );
  });

  it("passes loading state into the real shared list renderer", () => {
    mockSessionsPageLoadingState();

    render(<SessionsPage />);

    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("passes empty results into the real shared list renderer", () => {
    mockSessionsPageEmptyState("organization");

    render(<SessionsPage />);

    expect(screen.getByText(sessionsEmptyTitle)).toBeInTheDocument();
    expect(screen.getByText(sessionsEmptyDescription)).toBeInTheDocument();
  });

  // FEA-4177 (wongk): an INITIAL list-read rejection must render an honest error,
  // not the "No sessions found" empty state (which lies that the filters matched
  // nothing). ISS-4534: the errored card's single action is "Clear filters and
  // reload" (a superset of a bare retry), not a standalone Retry.
  it("renders an error (not the empty state) when the list read fails", () => {
    const refetch = vi.fn();
    mockSessionsPageListErrorState(refetch);

    render(<SessionsPage />);

    expect(screen.getByText("Couldn't load sessions")).toBeInTheDocument();
    expect(screen.queryByText(sessionsEmptyTitle)).not.toBeInTheDocument();
    // The redundant standalone Retry is gone — recovery is the superset action.
    expect(
      screen.queryByRole("button", { name: "Retry" })
    ).not.toBeInTheDocument();
  });

  // ISS-4534: the errored card must not be a dead end. Its single honest action
  // is a "Clear filters and reload" Link back to the Sessions list root — a plain
  // click clears the active filters (which re-issues the read via the query-key
  // change, NOT a stale refetch on the failing narrowed scope), and its href still
  // opens a working list in a new tab on a modified click.
  it("errored list read offers a 'Clear filters and reload' recovery link that clears filters back to the list root", async () => {
    const refetch = vi.fn();
    setSelectedSessionUser("user-123");
    mockSessionsPageListErrorState(refetch);

    render(<SessionsPage />);

    expect(screen.getByText("Couldn't load sessions")).toBeInTheDocument();
    const recovery = screen.getByRole("link", {
      name: "Clear filters and reload",
    });
    expect(recovery).toHaveAttribute("href", "/acme/sessions");

    // A plain click clears the filters (routing back to the clean list root) —
    // it does NOT re-run refetch() on the pre-clear, failing narrowed scope.
    await userEvent.click(recovery);
    const lastReplace = navigationReplaceMock.mock.calls.at(-1)?.[0] as string;
    expect(lastReplace).toBe("/acme/sessions");
    expect(refetch).not.toHaveBeenCalled();
  });

  // FEA-4181 (review cid 3653717604): a filtered-away zero-row result on the
  // canonical org route offers Clear filters (not the genuine "No sessions yet"
  // onboarding zero-state), and clearing strips the URL-owned `userId` narrower
  // so the reset can't re-run the same empty result.
  it("renders the filtered-empty state with Clear filters, which strips userId", async () => {
    setSelectedSessionUser("user-123");
    mockSessionsPageEmptyState("organization");

    render(<SessionsPage />);

    expect(screen.getByText("No matching sessions")).toBeInTheDocument();
    expect(screen.queryByText(sessionsEmptyTitle)).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Clear filters" })
    );

    const lastReplace = navigationReplaceMock.mock.calls.at(-1)?.[0] as string;
    expect(lastReplace).toBe("/acme/sessions");
  });

  it.each([
    A11yTheme.Light,
    A11yTheme.Dark,
  ])("keeps sessions route critical a11y and contrast clean in %s theme", async (theme) => {
    setSelectedSessionUser("user-123");

    const { container } = render(
      <A11yThemeRoot theme={theme}>
        <SessionsPage />
      </A11yThemeRoot>
    );

    await expectCriticalAxeClean(container);
    expect(screen.getByText("User filtered")).toBeInTheDocument();
    expectElementContrast(screen.getByText("Session"), {
      background: themeBackground(theme),
      label: `sessions route row ${theme}`,
    });
  });

  it.each([
    [
      "loading",
      () => mockSessionsPageLoadingState(),
      () => document.querySelector(".animate-pulse"),
    ],
    [
      "empty",
      () => mockSessionsPageEmptyState("organization"),
      () => screen.getByText(sessionsEmptyTitle),
    ],
    [
      "selected-user",
      () => setSelectedSessionUser("user-123"),
      () => screen.getByText("User filtered"),
    ],
    ["populated", () => undefined, () => screen.getByText("Session")],
  ])("keeps sessions %s state a11y and contrast clean", async (_state, setup, getTarget) => {
    for (const theme of A11Y_THEMES) {
      setup();

      const { container, unmount } = render(
        <A11yThemeRoot theme={theme}>
          <SessionsPage />
        </A11yThemeRoot>
      );

      const target = getTarget();
      expect(target).toBeInstanceOf(Element);
      await expectCriticalAxeClean(container);
      expectElementContrast(target as Element, {
        background: themeBackground(theme),
        label: `sessions ${_state} ${theme}`,
      });
      unmount();
    }
  });

  // ISS-5975: the manual Refresh control is gone from the Sessions LIST, on both
  // surfaces. It was only ever needed because the web shell had no automatic
  // freshness (ISS-5976's root cause), and re-reading the list is now the query
  // client's job on window focus / reconnect.
  //
  // Scope note, so this is not read as more than it is: `SessionsToolbar` is
  // STUBBED in this suite, so what this covers is the page's OWN chrome — the
  // header slot ISS-5478 put the button in. The real toolbar's absence guard
  // lives beside the toolbar, in
  // `packages/app/agents/components/sessions/__tests__/sessions-prototype-alignment.test.tsx`,
  // which is the test that fails if a Refresh control reappears there.
  it("renders no Refresh control in the sessions page header", () => {
    mockSessionsPageRefetchSpies("organization");

    render(<SessionsPage />);

    // The header still renders (breadcrumbs), so this is a real absence check
    // against a mounted surface rather than a page that failed to render.
    expect(screen.getByTestId("header")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: REFRESH_BUTTON_NAME_REGEX })
    ).not.toBeInTheDocument();
  });

  // ISS-5975 (wongk review): removing the button removed the one thing that
  // re-read BOTH halves of this page at once. `useQueryFreshnessGroup`'s own
  // suite proves the grouping rule; this proves THIS PAGE takes it — deleting
  // the hook call from `page.tsx` leaves that suite green and fails this.
  //
  // The scenario is the mixed one, which is the only one that discriminates:
  // the list's 60-second window has elapsed and the usage read's has not,
  // because their fetches resolved at different instants. Ungrouped, focus
  // refetches the rows alone and the cards keep describing the old population.
  it("re-reads the summary aggregates on focus even when only the list is stale", () => {
    const { listRefetch, usageRefetch } = mockSessionsPageRefetchSpies(
      "organization",
      { listIsStale: true, usageIsStale: false }
    );

    render(<SessionsPage />);
    // `focusManager` notifies on a CHANGE, so the blur is load-bearing.
    focusManager.setFocused(false);
    focusManager.setFocused(true);

    expect(listRefetch).toHaveBeenCalled();
    expect(usageRefetch).toHaveBeenCalled();
  });
});
