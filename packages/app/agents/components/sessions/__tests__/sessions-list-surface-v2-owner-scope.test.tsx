import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import {
  DEFAULT_SESSION_FACET_FILTERS,
  type SessionFacetFilters,
} from "@repo/app/agents/lib/session-filter-adapter";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { DEFAULT_TABLE_PAGE_SIZE } from "@repo/design-system/components/ui/table-page-size-select";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionTableRowFixture } from "../session-list-fixtures";
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
 * ISS-8037 — the `?userId=` owner scope as a VIEW-STATE AXIS.
 *
 * The scope narrows both of the host's reads. Before this it reached
 * `SessionsListSurfaceV2` through nothing at all: no chip named it, no control
 * removed it, and `filtersActive` did not count it — so a scoped-away list
 * rendered the genuinely-empty state and told the reader their org has no
 * sessions when it has plenty, with no way back short of editing the URL.
 *
 * It is an axis rather than a host callback because removal has to compose with
 * `ActiveFiltersBar`'s "Clear all", which fires `clearAllFilters()` and then one
 * `onToggle` per selected value SYNCHRONOUSLY with no render between. A removal
 * that lived outside the view state would be a second write built from the
 * host's pre-click snapshot, re-asserting what the first one just cleared.
 */

const SCOPED_USER_ID = "user-pascoe";

const SCOPED_USER_NAME = "Pascoe Birchall";

const ROWS: readonly SessionTableRow[] = [
  createSessionTableRowFixture({
    id: "ses-1",
    name: "agent/scoped-row",
    user: { avatarUrl: null, id: SCOPED_USER_ID, name: SCOPED_USER_NAME },
  }),
];

/**
 * Enough matched rows that `page: 2` is a REAL page. The surface reports an
 * out-of-range page back to its host, and that clamp is a second `onChange` —
 * which would sit in the call log this file counts and read as the two-write
 * defect it exists to detect.
 *
 * DERIVED from the surface's own page size rather than written as a literal:
 * ISS-7052 (#6074) moved the surface's default from 10 to
 * `DEFAULT_TABLE_PAGE_SIZE`, and the literal 30 that had bought three pages at
 * the old size bought only two at the new one — so the clamp fired on mount and
 * every count in this file read one call high. Four pages keeps `page: 2`
 * comfortably in range at whatever the shared default becomes next.
 */
const SERVER_TOTAL_ROWS = DEFAULT_TABLE_PAGE_SIZE * 4;

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

const OTHER_USER_ID = "user-alex";

const OTHER_USER_NAME = "Alex Chen";

const ORG_MEMBER_NAMES: Readonly<Record<string, string>> = {
  [SCOPED_USER_ID]: SCOPED_USER_NAME,
  [OTHER_USER_ID]: OTHER_USER_NAME,
};

/** Only ever ADDS a name it knows — the `SessionOwnerNameResolver` contract. */
function resolveOwnerName(userId: string): string | undefined {
  return ORG_MEMBER_NAMES[userId];
}

/**
 * The v2 chip row renders ONE chip per active facet group, labelled from that
 * group's own options — so this is the label the folded scope must produce.
 */
const SCOPE_CHIP_REMOVE_LABEL = `Remove Owner: ${SCOPED_USER_NAME} filter`;

const OWNER_CHIP_LABEL_PATTERN = /^Remove Owner: /;

const CLEAR_ALL_LABEL = "Clear all";

/** `FilterPopover`'s trigger, which appends `: <count>` once a facet is active. */
const FILTER_BUTTON_LABEL = "Filter";

let restoreContainerWidth: (() => void) | null = null;

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

describe("SessionsListSurfaceV2 owner scope", () => {
  /**
   * The chip, its label, and its removal — plus the OFF sibling on the same
   * mount, so "no chip" is measured against a render that does produce one
   * rather than against a surface that renders no chips at all.
   */
  it("names the scope with a removable Owner chip, and only while it is set", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onChange = vi.fn();
    const scoped: SessionsListViewState = {
      ...BASE_VIEW,
      page: 2,
      scopeUserId: SCOPED_USER_ID,
    };
    const { rerender } = render(
      <SessionsListSurfaceV2
        controlledView={{
          onChange,
          totalRows: SERVER_TOTAL_ROWS,
          value: scoped,
        }}
        resolveOwnerName={resolveOwnerName}
        rows={ROWS}
        usage={undefined}
      />
    );

    // Named through the Owner facet's own label vocabulary, and named with the
    // person rather than the opaque id the URL carries.
    expect(screen.getByLabelText(SCOPE_CHIP_REMOVE_LABEL)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(SCOPE_CHIP_REMOVE_LABEL));

    // ONE call carrying BOTH axes. The count is asserted because two sequential
    // writes would also produce a call matching one of the halves.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      ...scoped,
      page: 0,
      scopeUserId: null,
    });

    rerender(
      <SessionsListSurfaceV2
        controlledView={{
          onChange,
          totalRows: SERVER_TOTAL_ROWS,
          value: BASE_VIEW,
        }}
        resolveOwnerName={resolveOwnerName}
        rows={ROWS}
        usage={undefined}
      />
    );

    // The positive sibling for the negative: with the scope gone the chip goes
    // too, and the chip row has nothing left to name.
    expect(screen.queryByLabelText(SCOPE_CHIP_REMOVE_LABEL)).toBeNull();
    expect(screen.queryByRole("button", { name: CLEAR_ALL_LABEL })).toBeNull();
  });

  /**
   * The false-completeness half. A scoped-away list is a FILTERED empty, and the
   * reader is owed the sentence that says so plus the control that undoes it —
   * not "No sessions yet" over an org that has plenty.
   */
  it("reads a scoped-away list as filtered rather than genuinely empty", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const { rerender } = render(
      <SessionsListSurfaceV2
        controlledView={{
          onChange: vi.fn(),
          totalRows: 0,
          value: { ...BASE_VIEW, scopeUserId: SCOPED_USER_ID },
        }}
        resolveOwnerName={resolveOwnerName}
        rows={[]}
        usage={undefined}
      />
    );

    expect(screen.getByText("No matching sessions")).toBeInTheDocument();
    // The empty state's own visible control, matched on its TEXT: the Filter
    // popover's icon-only clear also answers to the accessible name "Clear
    // filters", and it is on screen for the same reason (see below).
    expect(screen.getByText("Clear filters")).toBeInTheDocument();
    expect(screen.queryByText("No sessions yet")).toBeNull();
    // The toolbar's Filter button counts the scope. Unfolded it read a bare
    // "Filter" — no count, no clear — directly above an empty state saying the
    // filters excluded everything: this ticket's defect, one control over.
    expect(screen.getByLabelText(FILTER_BUTTON_LABEL)).toHaveTextContent(
      `${FILTER_BUTTON_LABEL}: 1`
    );

    rerender(
      <SessionsListSurfaceV2
        controlledView={{ onChange: vi.fn(), totalRows: 0, value: BASE_VIEW }}
        resolveOwnerName={resolveOwnerName}
        rows={[]}
        usage={undefined}
      />
    );

    // The positive sibling on the same subject in the opposite state: with no
    // scope the SAME zero rows are a genuine empty, so the filtered sentence
    // above is a claim about the scope and not about zero rows.
    expect(screen.getByText("No sessions yet")).toBeInTheDocument();
    expect(screen.queryByText("No matching sessions")).toBeNull();
    // …and the Filter button drops back to its bare, uncounted state, so the
    // count above is a claim about the scope and not about zero rows.
    expect(screen.getByLabelText(FILTER_BUTTON_LABEL)).toHaveTextContent(
      FILTER_BUTTON_LABEL
    );
    expect(screen.getByLabelText(FILTER_BUTTON_LABEL)).not.toHaveTextContent(
      `${FILTER_BUTTON_LABEL}: 1`
    );
  });

  /**
   * THE case this ticket was deferred over.
   *
   * "Clear all" is `clearAllFilters()` followed by one `onToggle` per selected
   * value, synchronously and with no render between. The refuted wiring — the
   * scope removed by a second host write built from the pre-click snapshot —
   * settles on a state that has the facets cleared and the SCOPE PUT BACK (or
   * the reverse). So the assertion is not "the last call looks right": it is
   * that no state this click ever reports re-asserts a narrower the click
   * cleared, and that the state the host is left holding has every one gone.
   */
  it("clears the facets and the scope into one settled state on Clear all", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onChange = vi.fn();
    const narrowed: SessionsListViewState = {
      ...BASE_VIEW,
      dateRange: "90d",
      facets: withFacets({ statuses: [SESSION_STATUS.ACTIVE] }),
      page: 2,
      scopeUserId: SCOPED_USER_ID,
    };
    render(
      <SessionsListSurfaceV2
        controlledView={{
          onChange,
          totalRows: SERVER_TOTAL_ROWS,
          value: narrowed,
        }}
        resolveOwnerName={resolveOwnerName}
        rows={ROWS}
        usage={undefined}
      />
    );

    // Both narrowers are on screen before the click, so the clear has something
    // to fail at.
    expect(screen.getByLabelText(SCOPE_CHIP_REMOVE_LABEL)).toBeInTheDocument();
    expect(
      screen.getByLabelText(
        `Remove Status: ${SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE]} filter`
      )
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: CLEAR_ALL_LABEL }));

    // Not one state among several: no write this click makes may hand the host
    // back a scope the same click already cleared.
    for (const [reported] of onChange.mock.calls) {
      expect(reported.scopeUserId).toBeNull();
    }
    // And the state the host stores has every narrower gone, in one object.
    // ISS-8216 added the custom-field axis to that object: it is a narrower this
    // state now carries, so "every narrower gone" has to name it too.
    expect(onChange).toHaveBeenLastCalledWith({
      ...narrowed,
      customFieldFilters: EMPTY_SESSIONS_CUSTOM_FIELD_FILTERS,
      dateRange: DEFAULT_DATE_RANGE,
      facets: DEFAULT_SESSION_FACET_FILTERS,
      page: 0,
      scopeUserId: null,
      // ISS-8966: the search axis joined this state and is cleared in the same
      // commit, so "every narrower gone" has to name it too.
      search: "",
    });
  });

  /**
   * The MERGED case: the scoped user is also a selected Owner facet value. Two
   * chips reading "Owner: Pascoe Birchall", one of which only half-unnarrows the
   * list, is the confusion the chip row exists to end — so the row names the
   * owner once and that one chip's removal has to be TOTAL.
   *
   * The count assertion is the load-bearing half: an implementation that
   * appended a second scope chip beside the facet's own would still satisfy a
   * plain "the chip is there".
   */
  it("names a scope that is also a facet value once, and removes both", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onChange = vi.fn();
    const merged: SessionsListViewState = {
      ...BASE_VIEW,
      facets: withFacets({ userIds: [SCOPED_USER_ID] }),
      page: 2,
      scopeUserId: SCOPED_USER_ID,
    };
    render(
      <SessionsListSurfaceV2
        controlledView={{
          onChange,
          totalRows: SERVER_TOTAL_ROWS,
          value: merged,
        }}
        resolveOwnerName={resolveOwnerName}
        rows={ROWS}
        usage={undefined}
      />
    );

    expect(screen.getAllByLabelText(OWNER_CHIP_LABEL_PATTERN)).toHaveLength(1);

    fireEvent.click(screen.getByLabelText(SCOPE_CHIP_REMOVE_LABEL));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      ...merged,
      facets: DEFAULT_SESSION_FACET_FILTERS,
      page: 0,
      scopeUserId: null,
    });
  });

  /**
   * The scope and a DIFFERENT selected Owner, which is the shape that exercises
   * the folded group's OTHER branch: the chip row renders one chip per group, so
   * its remove replays a toggle per selected value, and only the scoped id may
   * route to the scope remover — the rest must reach the facet's own `onToggle`.
   *
   * Without this case a fold that sent EVERY Owner value to `onRemoveScope`
   * passes the whole file, and ships a remove that strips the scope while
   * leaving the reader's own Owner selection narrowing the list underneath a
   * chip that no longer names it.
   *
   * The chip LABEL is asserted here too, in order. The bar builds it by walking
   * the group's options and keeping the selected ones, so the scope leads only
   * if it leads in `options` — and `FilterChip` truncates, which makes last
   * place the position that disappears.
   */
  it("routes only the scoped value to the scope remover, and names it first", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onChange = vi.fn();
    const both: SessionsListViewState = {
      ...BASE_VIEW,
      facets: withFacets({ userIds: [OTHER_USER_ID] }),
      page: 2,
      scopeUserId: SCOPED_USER_ID,
    };
    render(
      <SessionsListSurfaceV2
        controlledView={{ onChange, totalRows: SERVER_TOTAL_ROWS, value: both }}
        resolveOwnerName={resolveOwnerName}
        rows={ROWS}
        usage={undefined}
      />
    );

    fireEvent.click(
      screen.getByLabelText(
        `Remove Owner: ${SCOPED_USER_NAME}, ${OTHER_USER_NAME} filter`
      )
    );

    // The facet value is gone as well as the scope. A fold that mistook it for
    // the scope would report `userIds: ["user-alex"]` still selected.
    expect(onChange).toHaveBeenLastCalledWith({
      ...both,
      facets: DEFAULT_SESSION_FACET_FILTERS,
      page: 0,
      scopeUserId: null,
    });
  });

  /**
   * The uncontrolled arm, where this surface owns the rows rather than a server.
   * The scope has to NARROW here too, not merely be advertised: a mount that
   * chipped it and counted it in `filtersActive` while showing every row would
   * name a narrowing that never happened — the same class of lie, pointed the
   * other way.
   */
  it("narrows the rows it owns by the seeded scope", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const rows: readonly SessionTableRow[] = [
      ...ROWS,
      createSessionTableRowFixture({
        id: "ses-2",
        name: "agent/other-owner-row",
        user: { avatarUrl: null, id: OTHER_USER_ID, name: OTHER_USER_NAME },
      }),
    ];
    const { rerender } = render(
      // ISS-8217: unbounded, so the SCOPE is the only thing narrowing these
      // rows. The fixture's start instants are pinned in the past, so the
      // default rolling window would empty the table and the absence below
      // would no longer be the scope's doing.
      <SessionsListSurfaceV2
        initialDateRange="all"
        initialScopeUserId={SCOPED_USER_ID}
        resolveOwnerName={resolveOwnerName}
        rows={rows}
        usage={undefined}
      />
    );

    expect(screen.getByText("agent/scoped-row")).toBeInTheDocument();
    expect(screen.queryByText("agent/other-owner-row")).toBeNull();

    // Removing the chip widens the list back — the positive sibling proving the
    // absence above is the scope's doing and not a missing row.
    fireEvent.click(screen.getByLabelText(SCOPE_CHIP_REMOVE_LABEL));
    rerender(
      <SessionsListSurfaceV2
        initialScopeUserId={SCOPED_USER_ID}
        resolveOwnerName={resolveOwnerName}
        rows={rows}
        usage={undefined}
      />
    );

    expect(screen.getByText("agent/other-owner-row")).toBeInTheDocument();
    expect(screen.getByText("agent/scoped-row")).toBeInTheDocument();
  });
});
