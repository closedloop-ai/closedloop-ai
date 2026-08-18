import { GRID_TABLE_V2_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  enableSessionsPageFeatureFlag,
  resetSessionsPageTestState,
  setSessionsPageQuery,
  setSessionsTotal,
  useAgentSessionsMock,
  useAgentSessionUsageMock,
} from "../../../__tests__/sessions-page-test-helpers";
import SessionsPage from "../page";

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
const OWNER_FILTER_BUTTON = "Filter owner Ada";
const STALE_READOUT = /of 431 sessions/;

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
    enableSessionsPageFeatureFlag(GRID_TABLE_V2_FEATURE_FLAG_KEY);
    render(<SessionsPage />);

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
    enableSessionsPageFeatureFlag(GRID_TABLE_V2_FEATURE_FLAG_KEY);
    render(<SessionsPage />);

    expect(await screen.findByText(STALE_READOUT)).toBeInTheDocument();
  });

  it("withholds the readout while the list is placeholder data", async () => {
    // A filter/date change leaves `keepPreviousData` serving the PRE-change
    // population. The summary cards on this page already treat
    // `isPlaceholderData` as loading (FEA-4177) so they never present a
    // placeholder number as real; the readout beside them has to hold the same
    // line, or the two halves of one strip disagree about whether the number is
    // known yet.
    enableSessionsPageFeatureFlag(GRID_TABLE_V2_FEATURE_FLAG_KEY);
    useAgentSessionsMock.mockImplementation(() => ({
      data: { items: [], total: 431 },
      isLoading: false,
      isPlaceholderData: true,
    }));
    render(<SessionsPage />);

    await waitFor(() => {
      expect(screen.queryByText(STALE_READOUT)).toBeNull();
    });
  });
});

describe("Sessions page — facet options come from the active-filter usage (ISS-5283)", () => {
  it("hands the toolbar the response for the CURRENT filters, not a date-only one", async () => {
    // The mock answers differently per params, so the assertion cannot be
    // satisfied by a page that sends the wrong scope.
    useAgentSessionUsageMock.mockImplementation(
      (filters: { userIds?: string[] }) => ({
        data: {
          byHarness: filters?.userIds?.length
            ? [{ harness: "self-excluded" }]
            : [{ harness: "unfiltered" }],
        },
        isLoading: false,
        isLoadingError: false,
      })
    );
    render(<SessionsPage />);
    expect(
      await screen.findByTestId("toolbar-usage-harnesses")
    ).toHaveTextContent("unfiltered");

    fireEvent.click(screen.getByRole("button", { name: OWNER_FILTER_BUTTON }));

    await waitFor(() => {
      expect(screen.getByTestId("toolbar-usage-harnesses")).toHaveTextContent(
        "self-excluded"
      );
    });
  });

  it("issues no second, facet-unfiltered usage read alongside the filtered one", async () => {
    render(<SessionsPage />);
    await screen.findByTestId("toolbar-usage-harnesses");
    useAgentSessionUsageMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: OWNER_FILTER_BUTTON }));

    await waitFor(() => {
      expect(usageScopesSinceClear()).toContainEqual(
        expect.objectContaining({ userIds: ["user-e2e"] })
      );
    });
    // Every usage read after the facet went active carries the facet. A
    // surviving date-only read would show up here as a second, facet-less scope.
    for (const scope of usageScopesSinceClear()) {
      expect(scope.userIds).toEqual(["user-e2e"]);
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
