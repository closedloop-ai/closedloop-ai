import {
  SESSION_UNKNOWN_COST_BUCKET_ID,
  SessionChangePresenceId,
  SessionPrAssociationId,
} from "@repo/api/src/agent-session-filters";
import { SESSION_AUTONOMY_TIER_FILTER_OPTIONS } from "@repo/api/src/session-autonomy-tiers";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import {
  DEFAULT_SESSION_FACET_FILTERS,
  type SessionFacetFilters,
} from "@repo/app/agents/lib/session-filter-adapter";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { SessionsListReadState } from "@repo/app/agents/lib/sessions-list-read-state";
import { SESSIONS_STATUS_COLUMN_ID } from "@repo/app/agents/lib/sessions-table-columns";
import { TOTAL_ESTIMATED_COST_SESSIONS_COLUMN_LABELS } from "@repo/app/agents/lib/sessions-total-estimated-cost-columns";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import {
  EMPTY_TABLE_GROUPING,
  type TableGroupingState,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionsListSurfaceV2 } from "../sessions-list-surface-v2";
import type { SessionsListViewState } from "../sessions-list-view-state";

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

/**
 * ISS-7865 — the three parity gaps that stopped `SessionsListSurfaceV2` hosting
 * a real Sessions list: client-side pagination, two facets against the hosts'
 * nine, and a date range that reached no query.
 *
 * Every case asserts the QUERY A HOST WOULD ISSUE, never what rendered. The
 * surface has no production mount, so a test that checks a control appears is
 * satisfied today AND would stay satisfied with the wiring broken — which is
 * the defect itself. `ParityHost` stands in for a real host.
 */

const LIVE_UPDATE_STATUS_TEST_ID = "sessions-live-update-status";
const PAGE_SIZE = 10;

/**
 * The server query a host builds from the surface's view state. Written out
 * rather than imported from the desktop view's `buildFacetQuery` or any helper
 * the surface owns: sharing code with the thing under test would make it agree
 * with itself. The duplication is the point.
 */
type IssuedQuery = {
  statuses: readonly string[];
  userIds: readonly string[];
  repositories: readonly string[];
  harnesses: readonly string[];
  models: readonly string[];
  autonomyTiers: readonly string[];
  costBuckets: readonly string[];
  changePresence: readonly string[];
  prAssociation: readonly string[];
  dateRange: string;
  sortBy: SessionsListViewState["sortBy"];
  sortDir: SessionsListViewState["sortDir"];
  limit: number;
  offset: number;
};

function toIssuedQuery(view: SessionsListViewState): IssuedQuery {
  const { facets } = view;
  return {
    statuses: facets.statuses,
    userIds: facets.userIds,
    repositories: facets.repositories,
    harnesses: facets.harnesses,
    models: facets.models,
    autonomyTiers: facets.autonomyTiers,
    costBuckets: facets.costBuckets,
    changePresence: facets.changePresence,
    prAssociation: facets.prAssociation,
    dateRange: view.dateRange,
    sortBy: view.sortBy,
    sortDir: view.sortDir,
    limit: PAGE_SIZE,
    offset: view.page * PAGE_SIZE,
  };
}

const AUTONOMY_TIER_VALUE = SESSION_AUTONOMY_TIER_FILTER_OPTIONS[0].value;

/** One value in every facet the desktop host sends, as canonical contract values. */
const EVERY_FACET_SELECTED: SessionFacetFilters = {
  ...DEFAULT_SESSION_FACET_FILTERS,
  statuses: [SESSION_STATUS.ACTIVE],
  userIds: ["user-pascoe"],
  repositories: ["closedloop-ai/closedloop-ai"],
  harnesses: ["claude"],
  models: ["claude-opus-5"],
  autonomyTiers: [AUTONOMY_TIER_VALUE],
  costBuckets: [SESSION_UNKNOWN_COST_BUCKET_ID],
  changePresence: [SessionChangePresenceId.HasChanges],
  prAssociation: [SessionPrAssociationId.HasPr],
};

function baseView(
  overrides: Partial<SessionsListViewState> = {}
): SessionsListViewState {
  return {
    sortBy: null,
    sortDir: "asc",
    grouping: EMPTY_TABLE_GROUPING,
    facets: DEFAULT_SESSION_FACET_FILTERS,
    dateRange: DEFAULT_DATE_RANGE,
    // One data column keeps the mount cheap; the neighbouring files in this
    // directory already sit near their timeout.
    visibleColumnIds: new Set(["status"]),
    page: 0,
    scopeUserId: null,
    ...overrides,
  };
}

/** Grouped by the one data column these fixtures render. */
const GROUPED_BY_STATUS: TableGroupingState = {
  primary: {
    fieldId: "status",
    order: TableGroupOrder.Ascending,
    showEmptyGroups: false,
  },
  secondary: EMPTY_TABLE_GROUPING.secondary,
};

/** Rows named by their 1-based index, so a page is identifiable on screen. */
function serverRows(from: number, count: number): readonly SessionTableRow[] {
  return Array.from({ length: count }, (_, index) =>
    createSessionTableRowFixture({
      id: `ses-${from + index}`,
      name: `agent/row-${from + index}`,
    })
  );
}

/**
 * A host that owns the query: it holds the view state, hands the surface the
 * page the "server" returned for it, and records the query it would have sent.
 */
function ParityHost({
  initialView,
  isPlaceholderPage = false,
  onQuery,
  pageRows,
  readState,
  totalRows,
}: {
  initialView: SessionsListViewState;
  isPlaceholderPage?: boolean;
  onQuery: (query: IssuedQuery) => void;
  pageRows: (page: number) => readonly SessionTableRow[];
  readState?: SessionsListReadState;
  totalRows?: number;
}) {
  const [view, setView] = useState(initialView);
  const controlledView = {
    onChange: (next: SessionsListViewState) => {
      setView(next);
      onQuery(toIssuedQuery(next));
    },
    value: view,
    ...(readState === undefined ? {} : { readState }),
    ...(totalRows === undefined ? {} : { totalRows }),
  };
  return (
    <SessionsListSurfaceV2
      controlledView={controlledView}
      isPlaceholderPage={isPlaceholderPage}
      pageSize={PAGE_SIZE}
      rows={pageRows(view.page)}
      usage={undefined}
    />
  );
}

const NEXT_PAGE_LABEL = "Go to next page";

/** A facet chip's remove control, matched by its GROUP label alone. */
const REMOVE_COST_FACET = /^Remove Cost: /;

const REMOVE_CHANGES_FACET = /^Remove Changes: /;

const RANGE_READOUT_PREFIX = /^Showing/;

const NEGATIVE_TOTAL_READOUT = /of -1 sessions/;

let restoreContainerWidth: (() => void) | null = null;

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

describe("SessionsListSurfaceV2 server pagination", () => {
  /**
   * Gap 1. Slicing the rows it was handed gave a host that had already applied
   * `limit`/`offset` exactly `ceil(pageSize/pageSize)` — one page — however many
   * rows the server matched. A fixture whose result set fits on one page cannot
   * observe that, so the server total here is larger than one page.
   */
  it("pages through the server's total and issues the next page's offset", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onQuery = vi.fn();
    render(
      <ParityHost
        initialView={baseView()}
        onQuery={onQuery}
        pageRows={(page) => serverRows(page * PAGE_SIZE + 1, PAGE_SIZE)}
        totalRows={25}
      />
    );

    fireEvent.click(screen.getByLabelText(NEXT_PAGE_LABEL));

    // The offset is the whole claim: a surface still slicing its own rows never
    // asks the server for anything, and page 2 does not exist for it to ask on.
    expect(onQuery).toHaveBeenCalledTimes(1);
    expect(onQuery).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10, offset: 10 })
    );

    // The positive sibling: the server's page-2 rows are now on screen, and
    // page 1's are gone.
    expect(screen.getByText("agent/row-11")).toBeInTheDocument();
    expect(screen.queryByText("agent/row-1")).toBeNull();
  });

  /**
   * The same gap from a host arriving ALREADY on page 2 — a restored saved view
   * or a back-navigation. The rendered rows alone cannot observe it: deriving
   * the page count from `rows` also clamps `safePage` to 0, and slicing a
   * ten-row payload from 0 returns it whole, so the list LOOKS right while the
   * footer has decided there is one page. Paging ONWARD separates them.
   */
  it("keeps paging beyond the second page of a server total", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onQuery = vi.fn();
    render(
      <ParityHost
        initialView={baseView({ page: 1 })}
        onQuery={onQuery}
        pageRows={() => serverRows(11, PAGE_SIZE)}
        totalRows={25}
      />
    );

    expect(screen.getByText("agent/row-11")).toBeInTheDocument();
    expect(screen.getByText("agent/row-20")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(NEXT_PAGE_LABEL));

    expect(onQuery).toHaveBeenCalledTimes(1);
    expect(onQuery).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10, offset: 20 })
    );
  });

  /**
   * Grouping a SERVER-DRIVEN view groups the page, not the population — so the
   * paginator is the only way to reach the rest of the result, and dropping it
   * made grouping a one-page trap (review cid 3845403843). The desktop host
   * gates its footer on loading and a zero total alone, never on `groupBy`.
   *
   * Client-side the population IS in hand, so grouping renders every group and
   * the paginator is correctly absent — the sibling below holds that line, so a
   * fix that simply always paginates cannot pass this pair.
   */
  it("keeps the paginator reachable when a server-driven view is grouped", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onQuery = vi.fn();
    render(
      <ParityHost
        initialView={baseView({ grouping: GROUPED_BY_STATUS })}
        onQuery={onQuery}
        pageRows={(page) => serverRows(page * PAGE_SIZE + 1, PAGE_SIZE)}
        totalRows={25}
      />
    );

    expect(
      screen.queryByRole("columnheader", {
        name: TOTAL_ESTIMATED_COST_SESSIONS_COLUMN_LABELS[
          SESSIONS_STATUS_COLUMN_ID
        ],
      })
    ).toBeNull();
    expect(screen.getByText("agent/row-1")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(NEXT_PAGE_LABEL));

    // The offset is the claim: the grouped view can still ASK for page 2.
    expect(onQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 10, offset: 10 })
    );
  });

  /**
   * Re-ordering re-decides which rows fall in which page, so holding the page
   * index resumes a NEW order partway through — skipping its start — and can
   * name a page the re-ordered result no longer has. Both hosts already reset:
   * `SessionsView.handleSort` calls `setPage(0)` and the web page's calls
   * `replacePage(0)` (review cid 3845403856).
   */
  it("returns to page one when a server-driven view is re-sorted", async () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onQuery = vi.fn();
    render(
      <ParityHost
        initialView={baseView({ page: 1 })}
        onQuery={onQuery}
        pageRows={() => serverRows(11, PAGE_SIZE)}
        totalRows={25}
      />
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Status column options" })
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Sort ascending" })
    );

    // ONE commit carrying the reset: written as two writes the page reset would
    // derive from the pre-update value and discard the sort.
    expect(onQuery).toHaveBeenCalledTimes(1);
    expect(onQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 0 })
    );
  });

  it("issues a descending Autonomy sort and returns to page one", async () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onQuery = vi.fn();
    render(
      <ParityHost
        initialView={baseView({
          page: 1,
          visibleColumnIds: new Set(["status", "autonomy"]),
        })}
        onQuery={onQuery}
        pageRows={() => serverRows(11, PAGE_SIZE)}
        totalRows={25}
      />
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Autonomy column options" })
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Sort descending" })
    );

    expect(onQuery).toHaveBeenCalledTimes(1);
    expect(onQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({
        offset: 0,
        sortBy: "autonomy",
        sortDir: "desc",
      })
    );
  });

  it("hides the paginator for a grouped client-side view", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    render(
      <SessionsListSurfaceV2
        initialGrouping={GROUPED_BY_STATUS}
        pageSize={PAGE_SIZE}
        rows={serverRows(1, 25)}
        usage={undefined}
      />
    );

    // Every group is whole here, so there is no page to go to.
    expect(screen.queryByLabelText(NEXT_PAGE_LABEL)).toBeNull();
  });
});

describe("SessionsListSurfaceV2 facet parity", () => {
  /**
   * Gaps 2 and 4 in ONE comparison. Asserted as a single deep-equal against a
   * pinned literal rather than nine independent checks: the claim is that the
   * surface and its host express the SAME query, and per-facet assertions
   * against constants pass happily while the shape as a whole drifts apart.
   */
  it("carries every facet the desktop host sends into one query", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onQuery = vi.fn();
    render(
      <ParityHost
        initialView={baseView({
          facets: EVERY_FACET_SELECTED,
          dateRange: "90d",
        })}
        onQuery={onQuery}
        pageRows={() => serverRows(1, 2)}
        totalRows={2}
      />
    );

    // Every facet is REACHABLE from the toolbar — an active facet renders a
    // removable chip, and a facet the surface does not offer renders none.
    for (const label of [
      "Status",
      "Owner",
      "Autonomy",
      "Harness",
      "Model",
      "Cost",
      "Changes",
      "Pull request",
      "Repository",
    ]) {
      expect(
        screen.getByLabelText(new RegExp(`^Remove ${label}: `))
      ).toBeInTheDocument();
    }

    // Removing ONE facet issues a query carrying the other eight untouched. Cost
    // is the one chosen deliberately: a cost BUCKET is a server-side threshold
    // over a value `SessionTableRow` carries only as a formatted label, so a
    // surface filtering its own rows could not have answered it at all.
    fireEvent.click(screen.getByLabelText(REMOVE_COST_FACET));

    expect(onQuery).toHaveBeenLastCalledWith({
      statuses: [SESSION_STATUS.ACTIVE],
      userIds: ["user-pascoe"],
      repositories: ["closedloop-ai/closedloop-ai"],
      harnesses: ["claude"],
      models: ["claude-opus-5"],
      autonomyTiers: [AUTONOMY_TIER_VALUE],
      costBuckets: [],
      changePresence: [SessionChangePresenceId.HasChanges],
      prAssociation: [SessionPrAssociationId.HasPr],
      dateRange: "90d",
      sortBy: null,
      sortDir: "asc",
      limit: 10,
      offset: 0,
    });
  });

  /**
   * TWO values in ONE of the newly-added facets. `ActiveFiltersBar` removes a
   * facet by replaying one `onToggle` per selected value with no render
   * between, and the canonical builder computes each next value from the
   * RENDER-time snapshot — so stored verbatim the second replay undoes the
   * first (#5566, now reachable on all nine). One value cannot observe it.
   */
  it("clears every value of a multi-value facet in one removal", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onQuery = vi.fn();
    render(
      <ParityHost
        initialView={baseView({
          facets: {
            ...DEFAULT_SESSION_FACET_FILTERS,
            changePresence: [
              SessionChangePresenceId.HasChanges,
              SessionChangePresenceId.NoChanges,
            ],
          },
        })}
        onQuery={onQuery}
        pageRows={() => serverRows(1, 2)}
        totalRows={2}
      />
    );

    fireEvent.click(screen.getByLabelText(REMOVE_CHANGES_FACET));

    // A literal empty array: the claim is that NOTHING stays selected, and the
    // stale-snapshot shape reports one surviving value here.
    expect(onQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ changePresence: [] })
    );
  });
});

describe("SessionsListSurfaceV2 date range", () => {
  /**
   * Gap 3. `dateRange` lived in a private `useState` and appeared in exactly two
   * places — the state and the toggle's own `value` — so it reached no query.
   * Asserted on the emitted query, never on the segment's rendered state, which
   * stayed correct the whole time the control was inert.
   */
  it("issues a query carrying the selected window, from page one", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onQuery = vi.fn();
    render(
      <ParityHost
        initialView={baseView({ page: 2 })}
        onQuery={onQuery}
        pageRows={() => serverRows(1, 2)}
        totalRows={25}
      />
    );

    fireEvent.click(screen.getByLabelText("Last 90 days"));

    // The window AND the page reset, in one query: a narrower window can leave
    // the reader on a page the new result set no longer has.
    expect(onQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ dateRange: "90d", offset: 0 })
    );
  });
});

describe("SessionsListSurfaceV2 honest server-driven states", () => {
  it("keeps placeholder rows server-driven when the host withholds the total", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    render(
      <ParityHost
        initialView={baseView({ page: 1 })}
        isPlaceholderPage
        onQuery={vi.fn()}
        pageRows={() => serverRows(1, 25)}
        readState={SessionsListReadState.Placeholder}
      />
    );

    expect(screen.getByText("agent/row-1")).toBeInTheDocument();
    // No footer readout; the live-update `<output>` is present but silent.
    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.dataset.testid).toBe(LIVE_UPDATE_STATUS_TEST_ID);
    expect(statuses[0]).toBeEmptyDOMElement();
  });

  it("routes controlled read failures through the surface error state", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    render(
      <ParityHost
        initialView={baseView()}
        onQuery={vi.fn()}
        pageRows={() => []}
        readState={SessionsListReadState.Error}
      />
    );

    expect(screen.getByText("Couldn't load sessions")).toBeInTheDocument();
    expect(screen.queryByText("No sessions yet")).toBeNull();
  });

  /**
   * The clamp used to govern the slice, so correcting the footer corrected the
   * rows too. Server-driven there is no slice: the host built its read from its
   * OWN page, so a stale page 6 answered with zero rows while the footer said
   * "3 of 3" and `totalRows` said 25.
   */
  it("reports an out-of-range page back to the host instead of showing it empty", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onQuery = vi.fn();
    render(
      <ParityHost
        initialView={baseView({ page: 5 })}
        onQuery={onQuery}
        pageRows={(page) => (page > 2 ? [] : serverRows(1, PAGE_SIZE))}
        totalRows={25}
      />
    );

    // 25 rows over pages of 10 is three pages, so the last valid index is 2.
    expect(onQuery).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10, offset: 20 })
    );
    // And it never claims the org has no sessions while holding a total of 25.
    expect(screen.queryByText("No sessions yet")).toBeNull();
  });

  it("withholds invalid server totals from the footer readout", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    render(
      <ParityHost
        initialView={baseView()}
        onQuery={vi.fn()}
        pageRows={() => serverRows(1, 2)}
        totalRows={-1}
      />
    );

    expect(screen.getByText("agent/row-1")).toBeInTheDocument();
    expect(screen.queryByText(RANGE_READOUT_PREFIX)).toBeNull();
    expect(screen.queryByText(NEGATIVE_TOTAL_READOUT)).toBeNull();
  });

  /**
   * `list-empty-state` is explicit that a non-default date window IS a narrowed
   * scope. Left out of the signal, a windowed-away result renders "No sessions
   * yet" at an org with plenty — the failure that module's header names.
   */
  it("treats a narrowed window as an active filter, and clearing restores it", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onQuery = vi.fn();
    render(
      <ParityHost
        initialView={baseView({ dateRange: "90d" })}
        onQuery={onQuery}
        pageRows={() => []}
        totalRows={0}
      />
    );

    expect(screen.queryByText("No sessions yet")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    // The window is what narrowed, so a clear that left it set would be a fix
    // that does not fix — the same zero rows under different copy.
    expect(onQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ dateRange: DEFAULT_DATE_RANGE, offset: 0 })
    );
  });

  /**
   * No producer can sort by session NAME — it is in neither
   * `AGENT_SESSION_SORT_COLUMNS` nor `SessionSortKey`. Client-side `sortRows`
   * reads it so the lead column sorts for real; server-driven the header's sort
   * menu would assert an order the server never applied.
   */
  it("offers the lead-column sort only where something can apply it", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const { unmount } = render(
      <ParityHost
        initialView={baseView()}
        onQuery={vi.fn()}
        pageRows={() => serverRows(1, 2)}
        totalRows={2}
      />
    );

    expect(
      screen.queryByRole("button", { name: "Session column options" })
    ).toBeNull();
    unmount();

    // The positive sibling on the SAME locator: uncontrolled, the surface sorts
    // its own rows, so the control is honest and must still be there.
    // ISS-8217: unbounded, so the fixture's FIXED past start instants cannot age
    // out of the client resolver's window and empty the table this asserts on.
    render(
      <SessionsListSurfaceV2
        initialDateRange="all"
        rows={serverRows(1, 2)}
        usage={undefined}
      />
    );

    expect(
      screen.getByRole("button", { name: "Session column options" })
    ).toBeInTheDocument();
  });

  /**
   * FEA-2505's Changes and Pull request facets are unconditional now that
   * `sessions-change-pr-filters` has retired ON, so this surface must offer them
   * from its own builder rather than waiting on a host read that no longer
   * exists. Asserted alongside an always-on sibling so it cannot pass by failing
   * to open the menu at all.
   */
  it("offers the change/PR facets from its own builder", async () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const user = userEvent.setup();
    render(
      <SessionsListSurfaceV2
        controlledView={{
          onChange: vi.fn(),
          totalRows: 2,
          value: baseView(),
        }}
        pageSize={PAGE_SIZE}
        rows={serverRows(1, 2)}
        usage={undefined}
      />
    );

    await user.click(screen.getByRole("button", { name: "Filter" }));

    expect(
      screen.getByRole("menuitem", { name: "Changes" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Pull request" })
    ).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Cost" })).toBeInTheDocument();
  });

  /**
   * The CHIP ROW is built from what is SELECTED, not from what the popover
   * offers: a saved view or a shared URL can carry
   * `changePresence`/`prAssociation`, and the host sends those values in its
   * query regardless — so a chip row that skipped them would leave the list
   * silently narrowed with no chip naming the filter and no remove path
   * (review cid 3845403849). ISS-4605 settled exactly this on
   * `SessionsActiveFiltersBar`, which passes `includeChangePrFilters: true`.
   */
  it("keeps a selected facet's chip nameable and removable", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onQuery = vi.fn();
    render(
      <ParityHost
        initialView={baseView({ facets: EVERY_FACET_SELECTED })}
        onQuery={onQuery}
        pageRows={() => serverRows(1, 2)}
        totalRows={2}
      />
    );

    // Selected, and still nameable and removable.
    expect(screen.getByLabelText(REMOVE_CHANGES_FACET)).toBeInTheDocument();
    // The always-on sibling from the same builder is unaffected.
    expect(screen.getByLabelText(REMOVE_COST_FACET)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(REMOVE_CHANGES_FACET));

    // Removing it reaches the QUERY — a chip that rendered but could not clear
    // the value the server is filtering on would be the same trap with a label.
    expect(onQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({
        changePresence: [],
        prAssociation: [SessionPrAssociationId.HasPr],
      })
    );
  });
});
