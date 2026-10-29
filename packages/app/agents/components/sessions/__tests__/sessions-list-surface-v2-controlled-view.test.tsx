import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import {
  DEFAULT_SESSION_FACET_FILTERS,
  type SessionFacetFilters,
} from "@repo/app/agents/lib/session-filter-adapter";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionTableRowFixture,
  SESSION_FIXTURE_NOW_MS,
} from "../session-list-fixtures";
import { SessionsListSurfaceV2 } from "../sessions-list-surface-v2";
import {
  EMPTY_SESSIONS_CUSTOM_FIELD_FILTERS,
  type SessionsListViewState,
} from "../sessions-list-view-state";

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

/**
 * ISS-7262 — the view-state lift that lets a host already owning
 * filters/sort/columns drive `SessionsListSurfaceV2` instead of running a second
 * copy of the same state beside it.
 *
 * The first two cases are driven through PAGINATION, the one view axis whose
 * effect is visible without opening a popover, so the assertions read rendered
 * ROWS — the thing the view state exists to decide — rather than the control
 * that requested the change.
 *
 * The third is driven through a FILTER, because paging cannot observe the
 * contract the patch API exists for: a filter handler moves the filter AND the
 * page in one commit, and split back into two sequential writes both would
 * derive from the same unchanged `controller.value`, so the page reset would
 * land without the filter and the user's click would be silently dropped.
 */

const OWNER_NAME = "Pascoe Birchall";

const OWNER_ID = "user-pascoe";

const OWNER = { avatarUrl: null, id: OWNER_ID, name: OWNER_NAME };

/** One display name, two different people — see the owner-identity case below. */
const SHARED_OWNER_NAME = "Alex Chen";

const ROWS: readonly SessionTableRow[] = [
  createSessionTableRowFixture({
    id: "ses-1",
    name: "agent/first-row",
    user: OWNER,
  }),
  createSessionTableRowFixture({
    id: "ses-2",
    name: "agent/second-row",
    user: OWNER,
  }),
];

/**
 * One visible data column on purpose: this surface mounts a toolbar, four menus
 * and the summary strip, so a mount is expensive and the neighbouring files in
 * this directory already sit near their timeout. Paging does not read the
 * column set.
 */
const BASE_VIEW: SessionsListViewState = {
  sortBy: null,
  sortDir: "asc",
  grouping: EMPTY_TABLE_GROUPING,
  facets: DEFAULT_SESSION_FACET_FILTERS,
  dateRange: DEFAULT_DATE_RANGE,
  visibleColumnIds: new Set(["status"]),
  page: 0,
  scopeUserId: null,
};

/** One facet selected, every other facet left empty. */
function withFacets(
  selection: Partial<SessionFacetFilters>
): SessionFacetFilters {
  return { ...DEFAULT_SESSION_FACET_FILTERS, ...selection };
}

const NEXT_PAGE_LABEL = "Go to next page";

let restoreContainerWidth: (() => void) | null = null;

/**
 * ISS-8217: pin the clock to the instant this file's fixture rows are relative
 * to. The client resolver now applies the date window, and these rows carry a
 * FIXED past start instant, so against the wall clock they age out of the
 * default range and every mount below renders an empty table — a view-state
 * test failing on the calendar. Only `Date` is faked, so React's scheduler and
 * the surface's own interval keep real timers.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SESSION_FIXTURE_NOW_MS);
});

afterEach(() => {
  vi.useRealTimers();
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

describe("SessionsListSurfaceV2 view state", () => {
  it("keeps its own view state when no controller is supplied", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    render(
      <SessionsListSurfaceV2 pageSize={1} rows={ROWS} usage={undefined} />
    );

    expect(screen.getByText("agent/first-row")).toBeInTheDocument();
    expect(screen.queryByText("agent/second-row")).toBeNull();

    fireEvent.click(screen.getByLabelText(NEXT_PAGE_LABEL));

    expect(screen.getByText("agent/second-row")).toBeInTheDocument();
    expect(screen.queryByText("agent/first-row")).toBeNull();
  });

  it("renders the controller's value and reports changes instead of applying them", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onChange = vi.fn();
    const { rerender } = render(
      <SessionsListSurfaceV2
        controlledView={{ value: BASE_VIEW, onChange }}
        pageSize={1}
        rows={ROWS}
        usage={undefined}
      />
    );

    expect(screen.getByText("agent/first-row")).toBeInTheDocument();
    expect(screen.queryByText("agent/second-row")).toBeNull();

    fireEvent.click(screen.getByLabelText(NEXT_PAGE_LABEL));

    // The surface reports the whole next state, not a partial patch — a host
    // storing what it is handed must get a complete view back.
    expect(onChange).toHaveBeenCalledWith({ ...BASE_VIEW, page: 1 });
    // And it does NOT move itself. A host that has not committed the change yet
    // — or declined it — must not find the list already a page ahead of the
    // state it believes it owns.
    expect(screen.getByText("agent/first-row")).toBeInTheDocument();
    expect(screen.queryByText("agent/second-row")).toBeNull();

    rerender(
      <SessionsListSurfaceV2
        controlledView={{ value: { ...BASE_VIEW, page: 1 }, onChange }}
        pageSize={1}
        rows={ROWS}
        usage={undefined}
      />
    );

    // The positive sibling for the two negatives above: once the host commits,
    // the surface follows. Without this the pair would also pass against a
    // surface that had simply stopped paginating at all.
    expect(screen.getByText("agent/second-row")).toBeInTheDocument();
    expect(screen.queryByText("agent/first-row")).toBeNull();
  });

  /**
   * ONE mount for both filter clearings. They share it because a controlled
   * surface never self-applies, so the rendered state is identical before each
   * click — and a mount here is expensive enough to matter: this file's
   * uncontrolled case timed out at 6.5 s on the default 5 s budget when the file
   * carried four of them under heavy host load.
   */
  it("reports a filter clearing as one write, from the chip and from Clear all", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onChange = vi.fn();
    const filtered: SessionsListViewState = {
      ...BASE_VIEW,
      facets: withFacets({
        statuses: [SESSION_STATUS.ACTIVE],
        userIds: [OWNER_ID],
      }),
      page: 2,
    };
    render(
      <SessionsListSurfaceV2
        controlledView={{ value: filtered, onChange }}
        pageSize={1}
        rows={ROWS}
        usage={undefined}
      />
    );

    // An active facet renders its chip in the toolbar, so the filter handler is
    // reachable without opening the popover.
    //
    // ISS-7902: named by the badge's DISPLAY word, not the stored one. The
    // client Status facet used to label its options with the raw value, so this
    // chip read "Status: active" beside a column of pills reading "Active" —
    // and beside the SERVER-driven facet builder, which has always labelled
    // through `SESSION_STATUS_LABELS` (`session-status-filters.ts`, and the
    // shipped `sessions-active-filters-bar` test asserts it that way). The
    // locator moved because the label did; the one-write-per-click contract
    // this test exists for is untouched.
    fireEvent.click(
      screen.getByLabelText(
        `Remove Status: ${SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE]} filter`
      )
    );

    // ONE call carrying BOTH axes. The count is asserted, not just the payload:
    // two sequential writes would also produce a call matching one of the two
    // halves, and only the count distinguishes them.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      ...filtered,
      facets: withFacets({ userIds: [OWNER_ID] }),
      page: 0,
    });

    onChange.mockClear();

    // `ActiveFiltersBar` answers this one click with `clearAllFilters()` plus an
    // `onToggle` per selected value — several writes, no render between them.
    // Asserted on the LAST reported state because that is what a host stores.
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));

    // ISS-8216 put the custom-field axis in this state, so the one settled
    // object a host stores now carries its cleared value too. ISS-8966 added the
    // search axis for the same reason and it is cleared in the same commit: a
    // "Clear all" that left the term applied would leave the list narrowed by a
    // filter the chip row had just stopped naming.
    expect(onChange).toHaveBeenLastCalledWith({
      ...filtered,
      customFieldFilters: EMPTY_SESSIONS_CUSTOM_FIELD_FILTERS,
      facets: DEFAULT_SESSION_FACET_FILTERS,
      page: 0,
      search: "",
    });
  });

  /**
   * TWO selected values in ONE facet, which is the only shape that can observe
   * this defect — and why the single-value case above passed while it was live.
   *
   * "Clear all" is `clearAllFilters()` followed by one `onToggle` per selected
   * value, all synchronously, with no render between them. When both toggles
   * computed their next array from the same RENDER-TIME `statuses` snapshot, the
   * second undid the first: `toggleValue(["active","error"], "active")` dropped
   * `active`, then `toggleValue(["active","error"], "error")` dropped `error`
   * from that same stale pair and handed back `["active"]` — so clearing two
   * statuses left the first one selected. With one value there is no second
   * toggle to overwrite the first, so the bug is invisible.
   */
  it("clears every value when one facet holds two of them", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onChange = vi.fn();
    const filtered: SessionsListViewState = {
      ...BASE_VIEW,
      facets: withFacets({
        statuses: [SESSION_STATUS.ACTIVE, SESSION_STATUS.ERROR],
      }),
      page: 2,
    };
    render(
      <SessionsListSurfaceV2
        controlledView={{ value: filtered, onChange }}
        pageSize={1}
        rows={ROWS}
        usage={undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));

    // Every facet empty, not anything derived from the value under test: the
    // whole claim is that NOTHING stays selected, and the pre-fix code reported
    // `["active"]` here.
    expect(onChange).toHaveBeenLastCalledWith({
      ...BASE_VIEW,
      customFieldFilters: EMPTY_SESSIONS_CUSTOM_FIELD_FILTERS,
      facets: DEFAULT_SESSION_FACET_FILTERS,
      page: 0,
      // ISS-8966: the search axis is cleared in the same commit — see the
      // sibling case above.
      search: "",
    });
  });

  /**
   * Two DIFFERENT people who happen to share a display name. `SessionTableRow`
   * says the name is only how we spell an owner and the id is the identity, so a
   * facet keyed on the name cannot tell these two apart: selecting one of them
   * kept both users' rows, which is the wrong answer for whichever of the two
   * the reader did not pick.
   *
   * Asserted on the rendered ROWS rather than on the reported filter value —
   * the claim is about which sessions survive, and a name-keyed filter reports a
   * perfectly plausible-looking `["Alex Chen"]` while showing the wrong list.
   */
  it("filters owners by id, so two people sharing a name stay distinct", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const rows: readonly SessionTableRow[] = [
      createSessionTableRowFixture({
        id: "ses-alex-a",
        name: "agent/alex-a-row",
        user: { avatarUrl: null, id: "user-alex-a", name: SHARED_OWNER_NAME },
      }),
      createSessionTableRowFixture({
        id: "ses-alex-b",
        name: "agent/alex-b-row",
        user: { avatarUrl: null, id: "user-alex-b", name: SHARED_OWNER_NAME },
      }),
    ];

    render(
      <SessionsListSurfaceV2
        controlledView={{
          value: {
            ...BASE_VIEW,
            facets: withFacets({ userIds: ["user-alex-a"] }),
          },
          onChange: vi.fn(),
        }}
        pageSize={10}
        rows={rows}
        usage={undefined}
      />
    );

    // Only the selected user's session. The other row belongs to a different
    // person who merely spells their name the same way.
    expect(screen.getByText("agent/alex-a-row")).toBeInTheDocument();
    expect(screen.queryByText("agent/alex-b-row")).toBeNull();
  });
});
