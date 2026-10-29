import { AgentSessionComparisonMode } from "@repo/api/src/types/agent-session-usage-comparison";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import { SessionStatusFacetValue } from "@repo/app/agents/lib/session-status-filters";
import { SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
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
import { SessionsPageTestProviders } from "./sessions-page-test-providers";
import {
  SESSIONS_OWNER_FACET_OPTION_NAME,
  SESSIONS_OWNER_FACET_USER_ID,
  sessionsChipRemoveName,
  sessionsOwnerFacetUsageEntry,
  sortSessionsColumn,
  toggleSessionsFacetOption,
} from "./sessions-v2-toolbar-driver";

// ISS-5975: deliberately loose. The removed control's accessible name was
// "Refresh sessions" with a visible "Refresh" label, so matching the word
// anywhere catches a reintroduction under either spelling.
const REFRESH_BUTTON_NAME_REGEX = /refresh/i;
const A11Y_THEMES = [A11yTheme.Light, A11yTheme.Dark] as const;
/**
 * The `?userId=` scope's chip, as the shipped chip row labels it.
 *
 * ISS-10301: this replaces the retired "User filtered" badge, which lived only in
 * the deleted v1 host. The value is the raw id because these suites mock the org
 * roster to `undefined`, which is `resolveOwnerChipLabel`'s documented fallback —
 * never a fabricated name.
 */
const SCOPE_USER_ID = "user-123";
const SCOPE_CHIP_LABEL = `Owner: ${SCOPE_USER_ID}`;

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
  // the `desktop-agent-session-sync` flag via `<FeatureFlagged>` (ISS-8022
  // has since retired that flag entirely)
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
      const flaggedOff = render(<SessionsPage />, {
        wrapper: SessionsPageTestProviders,
      });
      expect(document.title).toBe("Closedloop.ai");
      flaggedOff.unmount();

      enableSessionsPageFeatureFlag(
        SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY
      );
      render(<SessionsPage />, {
        wrapper: SessionsPageTestProviders,
      });
      expect(document.title).toBe("Sessions | Closedloop.ai");
    } finally {
      document.title = previousTitle;
    }
  });

  it("renders session rows directly with no feature-flag gate (FEA-4155)", () => {
    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

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
      const first = render(<SessionsPage />, {
        wrapper: SessionsPageTestProviders,
      });
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

      const sameDay = render(<SessionsPage />, {
        wrapper: SessionsPageTestProviders,
      });
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

  /**
   * ISS-10301: the "User filtered" badge this also asserted is RETIRED — it was
   * rendered by the deleted v1 host and by nothing else. What the scope surfaces
   * as now is the chip the next case pins; this case keeps the half the badge was
   * never about, the `?userId=` READ contract.
   */
  it("preserves selected-user query filtering", () => {
    setSelectedSessionUser(SCOPE_USER_ID);

    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    expect(useAgentSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining(selectedUserSessionsPageHookArgs),
      expect.anything()
    );
  });

  // ISS-4728: the selected-user scope moves OUT of the legacy badge and INTO the
  // active-filter chip row. What must not move is the URL contract: `?userId=`
  // still narrows the read, and a link from another surface still lands on the
  // same rows.
  //
  // ISS-10301: no longer gated. `sessions-owner-scope-chip`'s OFF arm was the v1
  // host's badge and nothing else, so with v1 deleted the chip is the ONLY thing
  // that can name this narrower — see `sessions-v2-page.tsx`. Read off the real
  // chip rather than the retired v1 toolbar stand-in's `toolbar-scope-user-id`
  // prop marker.
  it("folds the selected-user scope into the chip row without changing the ?userId query contract", () => {
    setSelectedSessionUser(SCOPE_USER_ID);

    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    expect(screen.getByText(SCOPE_CHIP_LABEL)).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: sessionsChipRemoveName(SCOPE_CHIP_LABEL),
      })
    ).toBeInTheDocument();
    // The read is byte-identical to the case above, which asserts it without
    // looking at the chip at all.
    expect(useAgentSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining(selectedUserSessionsPageHookArgs),
      expect.anything()
    );
  });

  it("removing the scope chip strips ONLY ?userId, keeping the active facets", async () => {
    const user = userEvent.setup();
    setSelectedSessionUser(SCOPE_USER_ID);
    setSessionsFacetQuery("status", [SessionStatusFacetValue.Inactive]);

    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    await user.click(
      screen.getByRole("button", {
        name: sessionsChipRemoveName(SCOPE_CHIP_LABEL),
      })
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
    // The same person is both the deep-link scope and a selected Owner facet
    // value, which is the case the chip row collapses into ONE chip. The single
    // remove control below IS that collapse: two chips reading `Owner: user-123`
    // would resolve `getByRole` to two elements and throw.
    setSelectedSessionUser(SCOPE_USER_ID);
    setSessionsFacetQuery("owner", [SCOPE_USER_ID]);
    setSessionsFacetQuery("status", [SessionStatusFacetValue.Inactive]);

    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    const replacesBeforeClick = navigationReplaceMock.mock.calls.length;
    await user.click(
      screen.getByRole("button", {
        name: sessionsChipRemoveName(SCOPE_CHIP_LABEL),
      })
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

  it("uses the page query for API offset and writes pagination through the route", async () => {
    const user = userEvent.setup();
    setSessionsPageQuery("2");
    setSelectedSessionUser("user-123");
    setSessionsTotal(50);

    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

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

    const { container } = render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    const summarySurface = container.querySelector(".sticky.left-0");
    expect(summarySurface).toBeInTheDocument();
    const pagination = screen.getByRole("navigation", { name: "pagination" });
    expect(pagination).toHaveClass("min-w-max");
    expect(pagination.parentElement).toHaveClass("overflow-x-auto");
  });

  it("repairs a stale page query after the response proves it is out of range", async () => {
    setSessionsPageQuery("2");
    setSessionsTotal(10);

    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

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

    const { rerender } = render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });
    expect(useAgentSessionsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 25 }),
      expect.anything()
    );

    // ISS-10301: the v2 grid sorts from the per-column options menu, not from a
    // header button whose accessible name is the bare column word — that was the
    // v1 `SortableColumnHeader`. Same gesture for the reader, same page reset
    // under test.
    await sortSessionsColumn(user, "Status");

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
    seedSessionsOwnerFacetOption();

    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });
    expect(useAgentSessionsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 25 }),
      expect.anything()
    );

    // ISS-10301: narrowed through the REAL Owner submenu. The retired v1 toolbar
    // stand-in rendered a "Filter owner Ada" button that called `onFiltersChange`
    // directly; the option below only exists because the seeded usage carries the
    // owner, which is how the shipped facet list is built.
    await toggleSessionsFacetOption(
      user,
      "Owner",
      SESSIONS_OWNER_FACET_OPTION_NAME
    );

    // FEA-3560: the same replace that resets the page mirrors the facet into
    // the URL, so a later detail→back restores the filtered view.
    expect(navigationReplaceMock).toHaveBeenCalledWith(
      `/acme/sessions?owner=${SESSIONS_OWNER_FACET_USER_ID}`,
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

    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });
    expect(lastSessionsTableCallArgs()).toEqual(
      expect.objectContaining({ offset: 25, statuses: [] })
    );

    // ISS-10301: two toggles through the REAL Status submenu, in place of the
    // retired stand-in's single "Apply lifecycle filters" button. ISS-4696's point
    // is preserved by construction rather than by a hand-written array — the
    // submenu can only offer what `SESSION_STATUS_FILTER_OPTIONS` holds, so a
    // retired value is not selectable here at all.
    await toggleSessionsFacetOption(
      user,
      "Status",
      SESSION_STATUS_LABELS[SessionStatusFacetValue.Active]
    );
    await toggleSessionsFacetOption(
      user,
      "Status",
      SESSION_STATUS_LABELS[SessionStatusFacetValue.Inactive]
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
    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });
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

    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

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

    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

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

    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("passes empty results into the real shared list renderer", async () => {
    mockSessionsPageEmptyState("organization");

    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    // Awaited: ISS-11913 holds an empty default-window list on its loading
    // treatment until the outside-window probe answers.
    expect(await screen.findByText(sessionsEmptyTitle)).toBeInTheDocument();
    expect(screen.getByText(sessionsEmptyDescription)).toBeInTheDocument();
  });

  // FEA-4177 (whitlockk): an INITIAL list-read rejection must render an honest error,
  // not the "No sessions found" empty state (which lies that the filters matched
  // nothing). ISS-4534: the errored card's single action is "Clear filters and
  // reload" (a superset of a bare retry), not a standalone Retry.
  it("renders an error (not the empty state) when the list read fails", () => {
    const refetch = vi.fn();
    mockSessionsPageListErrorState(refetch);

    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

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
    const { usageRefetch } = mockSessionsPageListErrorState(refetch);

    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

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
    // ISS-7414 (whitlockk review): the POSITIVE CONTROL for the summary half. The
    // `userId` narrower moves the summary key too, so clearing it reloads the
    // cards on its own — and an explicit refetch here would re-run the pre-clear
    // failing scope. A fix that just refetched both queries unconditionally on
    // every press would pass the two cases below and fail HERE.
    expect(usageRefetch).not.toHaveBeenCalled();
  });

  // ISS-7414: the same recovery Link pressed from an ALREADY-DEFAULT scope — no
  // facets, default range, no `?userId=`, first page — which is what a general
  // read failure actually looks like. Every setter then writes the value it
  // already held, no query key moves, and the key change the filtered branch
  // above relies on never happens, so the press started and ended no read at
  // all. Desktop fixed this in ISS-7249 (`useSessionsListRecovery`); the web
  // adapter never got the branch, which is why the control was reported as "not
  // working". With nothing to clear, the reload IS the whole action.
  it("errored list read on an already-default scope reloads, because clearing filters alone moves no query key", async () => {
    // Resolves, because the real `refetch()` returns a promise the recovery
    // handler attaches its self-catch to. A bare `vi.fn()` returning undefined
    // is a shape the query contract cannot produce.
    const refetch = vi.fn().mockResolvedValue(undefined);
    const { usageRefetch } = mockSessionsPageListErrorState(refetch);

    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    expect(screen.getByText("Couldn't load sessions")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("link", { name: "Clear filters and reload" })
    );

    expect(refetch).toHaveBeenCalledTimes(1);
    // ISS-7414 (whitlockk review): and the SUMMARY read too. The cards and the
    // toolbar's facet counts read that one query, a general outage errors it
    // beside the list, and on this scope nothing moves its key either — so
    // reloading only the rows hands back a table under figures still describing
    // the failed read, with nothing on screen saying they are stale. ISS-5975
    // fixed exactly this shape for focus (`useQueryFreshnessGroup`, and the
    // focus test below); the recovery control owes the same contract.
    expect(usageRefetch).toHaveBeenCalledTimes(1);
  });

  // ISS-7414: the other half of the same predicate. A non-zero page is a real
  // key change even with no facet active — `markPageReset()` drops
  // `effectivePageIndex` to 0, which moves `offset` in `listFilters` — so the
  // reset reloads on its own and the explicit refetch must NOT also fire. Firing
  // it would re-run the pre-clear page-N read, the failing scope the user is
  // escaping. Without this case, dropping `&& effectivePageIndex === 0` from the
  // predicate leaves every other test in this file green.
  it("errored list read on a non-default page does not refetch the pre-clear scope", async () => {
    const refetch = vi.fn().mockResolvedValue(undefined);
    setSessionsPageQuery("2");
    const { usageRefetch } = mockSessionsPageListErrorState(refetch);

    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    expect(screen.getByText("Couldn't load sessions")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("link", { name: "Clear filters and reload" })
    );

    expect(refetch).not.toHaveBeenCalled();
    // ISS-7414 (whitlockk review): the two predicates are NOT the same predicate,
    // and this is the scope that proves it. Pagination is deliberately absent
    // from the summary key (FEA-4177), so the page reset that reloads the LIST
    // here moves nothing for the summary — leaving the cards errored unless this
    // fires. No filter is active, so what it re-reads is the scope the user is
    // landing on, not a narrowed one they are escaping.
    expect(usageRefetch).toHaveBeenCalledTimes(1);
  });

  // FEA-4181 (review cid 3653717604): a filtered-away zero-row result on the
  // canonical org route offers Clear filters (not the genuine "No sessions yet"
  // onboarding zero-state), and clearing strips the URL-owned `userId` narrower
  // so the reset can't re-run the same empty result.
  it("renders the filtered-empty state with Clear filters, which strips userId", async () => {
    setSelectedSessionUser("user-123");
    mockSessionsPageEmptyState("organization");

    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    const emptyState = screen.getByText("No matching sessions");
    expect(emptyState).toBeInTheDocument();
    expect(screen.queryByText(sessionsEmptyTitle)).not.toBeInTheDocument();

    // ISS-10301: the EMPTY STATE's recovery action specifically. With an active
    // narrower on screen the toolbar renders its own ICON-ONLY "Clear filters"
    // beside the Filter button, so a bare `getByRole` resolves two; the one under
    // test is the labelled button the empty state offers, which is the only one
    // carrying the words.
    const clearFilters = screen
      .getAllByRole("button", { name: "Clear filters" })
      .filter((button) => button.textContent?.includes("Clear filters"));
    expect(clearFilters).toHaveLength(1);
    await userEvent.click(clearFilters[0] as HTMLElement);

    const lastReplace = navigationReplaceMock.mock.calls.at(-1)?.[0] as string;
    expect(lastReplace).toBe("/acme/sessions");
  });

  it.each([A11yTheme.Light, A11yTheme.Dark])(
    "keeps sessions route critical a11y and contrast clean in %s theme",
    async (theme) => {
      setSelectedSessionUser(SCOPE_USER_ID);

      const { container } = render(
        <A11yThemeRoot theme={theme}>
          <SessionsPage />
        </A11yThemeRoot>,
        { wrapper: SessionsPageTestProviders }
      );

      await expectCriticalAxeClean(container);
      // ISS-10301: the scope's own affordance, which is the chip now that the v1
      // "User filtered" badge is gone. Asserted here for the same reason it always
      // was — it proves the axe sweep above actually covered the scoped state.
      expect(screen.getByText(SCOPE_CHIP_LABEL)).toBeInTheDocument();
      expectElementContrast(screen.getByText("Session"), {
        background: themeBackground(theme),
        label: `sessions route row ${theme}`,
      });
    }
  );

  it.each([
    [
      "loading",
      () => mockSessionsPageLoadingState(),
      () => document.querySelector(".animate-pulse"),
    ],
    [
      "empty",
      () => mockSessionsPageEmptyState("organization"),
      // Found, not got: see "passes empty results into the real shared list
      // renderer" (ISS-11913).
      () => screen.findByText(sessionsEmptyTitle),
    ],
    [
      "selected-user",
      () => setSelectedSessionUser(SCOPE_USER_ID),
      () => screen.getByText(SCOPE_CHIP_LABEL),
    ],
    ["populated", () => undefined, () => screen.getByText("Session")],
  ])(
    "keeps sessions %s state a11y and contrast clean",
    async (_state, setup, getTarget) => {
      for (const theme of A11Y_THEMES) {
        setup();

        const { container, unmount } = render(
          <A11yThemeRoot theme={theme}>
            <SessionsPage />
          </A11yThemeRoot>,
          { wrapper: SessionsPageTestProviders }
        );

        const target = await getTarget();
        expect(target).toBeInstanceOf(Element);
        await expectCriticalAxeClean(container);
        expectElementContrast(target as Element, {
          background: themeBackground(theme),
          label: `sessions ${_state} ${theme}`,
        });
        unmount();
      }
    }
  );

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

    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    // The header still renders (breadcrumbs), so this is a real absence check
    // against a mounted surface rather than a page that failed to render.
    expect(screen.getByTestId("header")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: REFRESH_BUTTON_NAME_REGEX })
    ).not.toBeInTheDocument();
  });

  // ISS-12286 (PRD-792): a focus re-reads only the stale half. This proves
  // THIS PAGE wires the freshness group — deleting the hook call from
  // `page.tsx` leaves the hook's own suite green and fails the list assertion
  // here — and that the fresh summary is no longer re-read on the list's
  // account, which the rule this replaced did.
  it("re-reads only the stale list on focus, leaving the fresh summary alone", () => {
    const { listRefetch, usageRefetch } = mockSessionsPageRefetchSpies(
      "organization",
      { listIsStale: true, usageIsStale: false }
    );

    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });
    // `focusManager` notifies on a CHANGE, so the blur is load-bearing.
    focusManager.setFocused(false);
    focusManager.setFocused(true);

    expect(listRefetch).toHaveBeenCalled();
    expect(usageRefetch).not.toHaveBeenCalled();
  });

  // ISS-9074: the API's list endpoint refuses an offset past
  // SESSION_LIST_MAX_OFFSET (10,000), so a stale bookmark or a hand-edited
  // `?page=` far past the real result set must not be forwarded verbatim. The
  // page clamps the OFFSET synchronously — the very first request is already
  // safe — and a follow-up effect repairs the URL to match.
  it("caps the offset at SESSION_LIST_MAX_OFFSET when the URL page exceeds the API ceiling", async () => {
    setSessionsPageQuery("500");
    setSessionsTotal(30_000);

    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    // ?page=500 is index 499, but the ceiling is index 400 (10,000 / 25 per
    // page) — the synchronous clamp sends offset 10,000, never the raw
    // 499 * 25 = 12,475.
    expect(useAgentSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 10_000 }),
      expect.anything()
    );
    // The clamp effect repairs the URL to the capped page (index 400 → "401").
    await waitFor(() =>
      expect(navigationReplaceMock).toHaveBeenCalledWith(
        "/acme/sessions?page=401",
        { scroll: false }
      )
    );
  });

  // ISS-9074: the sibling of the offset cap above. 30,000 rows at 25/page is
  // 1,200 raw pages, but the API will never serve past offset 10,000 (page
  // index 400), so the paginator must not advertise pages nobody can reach.
  it("caps the advertised page count so the paginator never offers unreachable pages", () => {
    setSessionsTotal(30_000);

    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    // Landing on the default (first) page still reads offset 0.
    expect(useAgentSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 0 }),
      expect.anything()
    );
    // The paginator's last-page link is capped at index 400 ("401"), never the
    // raw 1,200 pages the uncapped total would produce.
    const pagination = screen.getByRole("navigation", { name: "pagination" });
    expect(within(pagination).getByText("401")).toBeInTheDocument();
    expect(within(pagination).queryByText("1200")).not.toBeInTheDocument();
  });
});

/**
 * REPLACES the usage fixture with one carrying the `byUser` row the Owner facet
 * builds {@link SESSIONS_OWNER_FACET_OPTION_NAME} from.
 *
 * Replaces rather than extends, and says so: `resetSessionsPageTestState` sets a
 * plain `mockReturnValue` whose whole payload is the two summary fields restated
 * below, so there is no per-args implementation to preserve — and the one case
 * that calls this asserts the LIST read's `offset`/`userIds`, never a summary
 * figure. The row itself comes from the shared driver, so this suite and
 * `page-v2-footer.test.tsx` cannot drift on the owner's id or option label.
 */
function seedSessionsOwnerFacetOption() {
  useAgentSessionUsageMock.mockReturnValue({
    data: {
      totalSessions: 1,
      totalEstimatedCost: 0,
      byUser: [sessionsOwnerFacetUsageEntry()],
    },
    isLoading: false,
  });
}
