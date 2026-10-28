import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  holdSessionsViewRestore,
  mockSessionsPageGatedRead,
  resetSessionsPageTestState,
  sessionsEmptyTitle,
  setSessionsPageQuery,
  setSessionsTotal,
  useAgentSessionsMock,
  useAgentSessionUsageMock,
} from "../../../__tests__/sessions-page-test-helpers";
import SessionsPage from "../page";
import { SessionsPageTestProviders } from "./sessions-page-test-providers";
import {
  closeSessionsMenus,
  openSessionsFacetSubmenu,
  SESSIONS_FILTER_BUTTON,
  SESSIONS_OWNER_FACET_OPTION_NAME,
  SESSIONS_OWNER_FACET_USER_ID,
  sessionsFacetOptionNames,
  sessionsFacetOptionRow,
  sessionsOwnerFacetUsageEntry,
  toggleSessionsFacetOption,
} from "./sessions-v2-toolbar-driver";

/**
 * The GridTable v2 footer + facet-usage contracts the review flagged, asserted
 * through the real page rather than the primitives:
 *
 *  - a page-size change must not leave a request out for the OLD page index at
 *    the NEW size (the clamp effect cannot catch it — the old index is still a
 *    valid page at the larger size);
 *  - the range readout must not state a stale total as settled fact while the
 *    list is placeholder data, when the summary cards beside it are skeletons;
 *  - the toolbar's facet options must come from the ACTIVE-FILTER usage
 *    response, which is where the server's self-excluding facet counts live.
 */

const ROWS_PER_PAGE_OPTION = "100 / page";

const STALE_READOUT = /of 431 sessions/;
const ZERO_READOUT = /Showing 0 of 0 sessions/;
const PLACEHOLDER_ROW_NAME = "Shared sessions list extraction";
/** `PaginationNext`'s accessible name in the shared footer's pager. */
const NEXT_PAGE_NAME = "Go to next page";

beforeEach(() => {
  resetSessionsPageTestState("organization");
});

describe("Sessions page — rows-per-page (FEA-4199)", () => {
  it("never requests the old page index at the new page size", async () => {
    // 431 sessions at 25/page puts the user on a real page 4 (index 3), and
    // index 3 is STILL a valid page at 100/page (`ceil(431/100) - 1 = 4`) — which
    // is why the clamp effect below the handler cannot rescue this and
    // `markPageReset()` has to.
    setSessionsTotal(431);
    setSessionsPageQuery("4");
    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    await waitFor(() => {
      expect(listOffsetsAtLimit(25)).toContain(75);
    });

    // The shared Select stub renders a native `<select>` whose trigger (and so
    // the control's accessible name) is stubbed out, so reach it through the
    // option only this control offers.
    const hundredPerPage = await screen.findByRole("option", {
      name: ROWS_PER_PAGE_OPTION,
    });
    const pageSizeSelect = hundredPerPage.closest(
      "select"
    ) as HTMLSelectElement;
    fireEvent.change(pageSizeSelect, { target: { value: "100" } });

    await waitFor(() => {
      expect(listOffsetsAtLimit(100)).toEqual([0]);
    });
    // The whole point: no read for `offset: 300` (the old index × the new size)
    // ever went out on the way there.
    expect(listOffsetsAtLimit(100)).not.toContain(300);
  });
});

describe("Sessions page — range readout honesty", () => {
  it("states the range once the list has settled", async () => {
    setSessionsTotal(431);
    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    expect(await screen.findByText(STALE_READOUT)).toBeInTheDocument();
  });

  it("withholds the readout while the list is placeholder data", async () => {
    // A filter/date change leaves `keepPreviousData` serving the PRE-change
    // population. The summary cards on this page already treat
    // `isPlaceholderData` as loading (FEA-4177) so they never present a
    // placeholder number as real; the readout beside them has to hold the same
    // line, or the two halves of one strip disagree about whether the number is
    // known yet.
    useAgentSessionsMock.mockImplementation(() => ({
      data: { items: [], total: 431 },
      isLoading: false,
      isPlaceholderData: true,
    }));
    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    await waitFor(() => {
      expect(screen.queryByText(STALE_READOUT)).toBeNull();
    });
  });

  it("withholds the readout while placeholder ROWS are still on screen", async () => {
    // ISS-8635: the empty-list case above cannot reach this one. #4480 is
    // precisely the case WITH rows, where the index has moved to page 4 while
    // page 1's rows are still painted and a derived range names the new index
    // over them ("Showing 76-100 of 431").
    setSessionsPageQuery("4");
    useAgentSessionsMock.mockImplementation(() => ({
      data: { items: [createAgentSessionListItemFixture()], total: 431 },
      isLoading: false,
      isPlaceholderData: true,
    }));
    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    // Anchor the negative: the rows ARE on screen, so a null readout is the
    // footer withholding it rather than the whole list having failed to render.
    await screen.findByText(PLACEHOLDER_ROW_NAME);
    expect(screen.queryByText(STALE_READOUT)).toBeNull();
  });

  it("does not state a zero total while a no-data read is still unsettled", () => {
    mockSessionsPageGatedRead();
    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    expect(screen.queryByText(sessionsEmptyTitle)).toBeNull();
    expect(screen.getByTestId("sessions-list-skeleton")).toBeInTheDocument();
    expect(screen.queryByText(ZERO_READOUT)).toBeNull();
  });

  it("keeps a gated cached-error read on the loading surface", () => {
    holdSessionsViewRestore();
    mockSessionsPageGatedRead();
    useAgentSessionsMock.mockReturnValue({
      data: undefined,
      isError: true,
      isLoading: false,
      isLoadingError: true,
      isPending: true,
    });
    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    expect(screen.queryByText(sessionsEmptyTitle)).toBeNull();
    expect(screen.getByTestId("sessions-list-skeleton")).toBeInTheDocument();
    expect(screen.queryByText(ZERO_READOUT)).toBeNull();
  });
});

describe("Sessions page — placeholder footer (ISS-9216)", () => {
  it("keeps the footer mounted and pinned while a zero-row placeholder page is in flight", async () => {
    // The zero-row placeholder is the case ISS-9216 newly renders a footer for:
    // the shared `shouldRenderListPagination` rule keeps the strip mounted
    // through a placeholder read so paging does not drop a row's worth of
    // height. Mounted is only half of Branches' shipped behaviour — the other
    // half is that every control in it is pinned, or a click pages a list whose
    // rows are already stale and lands the reader on an index nothing on screen
    // corresponds to.
    useAgentSessionsMock.mockImplementation(() => ({
      data: { items: [], total: 431 },
      isLoading: false,
      isPlaceholderData: true,
    }));
    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    // Mounted: the rows-per-page control is the footer's left group, and the
    // pager is its right one. Before ISS-9216 neither rendered at all here.
    const hundredPerPage = await screen.findByRole("option", {
      name: ROWS_PER_PAGE_OPTION,
    });
    const pageSizeSelect = hundredPerPage.closest(
      "select"
    ) as HTMLSelectElement;
    expect(pageSizeSelect).toBeDisabled();

    // 431 rows at 25/page is 18 pages from page 1, so "next" is a page that
    // EXISTS — `aria-disabled` here is the placeholder read pinning it, not the
    // pager running out of pages.
    expect(screen.getByLabelText(NEXT_PAGE_NAME)).toHaveAttribute(
      "aria-disabled",
      "true"
    );
  });
});

/**
 * ISS-10301 re-pointed both cases below.
 *
 * They used to read a `toolbar-usage-harnesses` prop marker rendered by the
 * `vi.mock` stand-in for the v1 `SessionsToolbar`, and to narrow by clicking a
 * "Filter owner Ada" button that same stand-in rendered. Neither exists: the page
 * mounts the shipped v2 surface, whose facets route through
 * `filterController`/`filterViewModel`.
 *
 * The ISS-5283 contract is unchanged, and the first case now observes it one step
 * closer to the reader: the marker reported WHICH usage object the page handed the
 * toolbar, while the Harness submenu is what the toolbar actually OFFERS to filter
 * by — the thing ISS-5283 exists to keep honest.
 */
describe("Sessions page — facet options come from the active-filter usage (ISS-5283)", () => {
  it("hands the toolbar the response for the CURRENT filters, not a date-only one", async () => {
    const user = userEvent.setup();
    // The mock answers differently per params, so the assertion cannot be
    // satisfied by a page that sends the wrong scope. `byUser` is constant across
    // both answers so the Owner option stays clickable either way — this case is
    // about the HARNESS list moving.
    useAgentSessionUsageMock.mockImplementation(
      (filters: { userIds?: string[] }) => ({
        data: {
          byHarness: filters?.userIds?.length
            ? [{ harness: "self-excluded" }]
            : [{ harness: "unfiltered" }],
          byUser: [sessionsOwnerFacetUsageEntry()],
        },
        isLoading: false,
        isLoadingError: false,
      })
    );
    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });
    expect(await sessionsFacetOptionNames(user, "Harness")).toEqual([
      "unfiltered",
    ]);

    await toggleSessionsFacetOption(
      user,
      "Owner",
      SESSIONS_OWNER_FACET_OPTION_NAME
    );

    // Read ONCE, not inside a `waitFor`: the read is a gesture (open popover,
    // open submenu, dismiss), so retrying it would drive the surface repeatedly
    // and report a timeout where a wrong option list should report itself.
    // `user.click` already flushed the commit the toggle produced.
    expect(await sessionsFacetOptionNames(user, "Harness")).toEqual([
      "self-excluded",
    ]);
  });

  it("issues no second, facet-unfiltered usage read alongside the filtered one", async () => {
    const user = userEvent.setup();
    useAgentSessionUsageMock.mockImplementation(() => ({
      data: { byHarness: [], byUser: [sessionsOwnerFacetUsageEntry()] },
      isLoading: false,
      isLoadingError: false,
    }));
    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });
    await screen.findByRole("button", { name: SESSIONS_FILTER_BUTTON });
    // The submenu is opened BEFORE the window starts: reaching a real control
    // costs renders of its own, and each of those re-invokes the read with the
    // facets in force AT THAT MOMENT — still unfiltered. The contract is about
    // reads issued once the facet IS active, so the window starts at the click.
    const owners = await openSessionsFacetSubmenu(user, "Owner");
    useAgentSessionUsageMock.mockClear();
    await user.click(
      sessionsFacetOptionRow(owners, SESSIONS_OWNER_FACET_OPTION_NAME)
    );
    await closeSessionsMenus(user);

    await waitFor(() => {
      expect(usageScopesSinceClear()).toContainEqual(
        expect.objectContaining({ userIds: [SESSIONS_OWNER_FACET_USER_ID] })
      );
    });
    // Every usage read after the facet went active carries the facet. A
    // surviving date-only read would show up here as a second, facet-less scope.
    for (const scope of usageScopesSinceClear()) {
      expect(scope.userIds).toEqual([SESSIONS_OWNER_FACET_USER_ID]);
    }
  });
});

/** Every distinct `offset` the paginated list read was asked for at `limit`. */
function listOffsetsAtLimit(limit: number): number[] {
  const offsets = useAgentSessionsMock.mock.calls
    .map((call) => call[0] as { limit?: number; offset?: number })
    .filter((args) => args?.limit === limit)
    .map((args) => args.offset ?? 0);
  return [...new Set(offsets)];
}

/** The filter scopes every `useAgentSessionUsage` call carried since the clear. */
function usageScopesSinceClear(): { userIds?: string[] }[] {
  return useAgentSessionUsageMock.mock.calls.map(
    (call) => (call[0] ?? {}) as { userIds?: string[] }
  );
}
