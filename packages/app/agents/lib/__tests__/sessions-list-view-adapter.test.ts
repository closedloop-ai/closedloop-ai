import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { describe, expect, it } from "vitest";
import { DEFAULT_DATE_RANGE } from "../../../shared/lib/format-utils";
import { DEFAULT_SESSION_FACET_FILTERS } from "../session-filter-adapter";
import { SessionGroupBy } from "../session-grouping";
import {
  OWNER_COLUMN_ID,
  SessionSortDir,
  SessionSortKey,
} from "../session-sort-group";
import {
  reconcileSessionsVisibleColumns,
  SESSIONS_HOST_GROUP_OPTION_IDS,
  type SessionsHostViewState,
  toHiddenCustomFieldColumnIds,
  toSessionGroupBy,
  toSessionsHostViewState,
  toSessionsListSortField,
  toSessionsListViewState,
  toTableGroupingState,
} from "../sessions-list-view-adapter";

/**
 * ISS-7052 Part A — the host↔surface view-state bridge.
 *
 * The Owner cases are the reason this module exists rather than an inline
 * `identity`: `owner` is the COLUMN id and `user` is the SERVER sort key, they
 * differ for exactly one column out of ten, and the last time they were treated
 * as equal every row sorted against a reader that does not exist, produced `""`,
 * and the list came back looking merely unsorted rather than broken.
 */

const HOST_BASE: SessionsHostViewState = {
  sortKey: null,
  sortDir: SessionSortDir.Desc,
  secondarySorts: [],
  groupBy: SessionGroupBy.None,
  facets: DEFAULT_SESSION_FACET_FILTERS,
  dateRange: DEFAULT_DATE_RANGE,
  visibleColumns: new Set(["status", "cost"]),
  page: 0,
  scopeUserId: null,
  search: "",
};

describe("sort key ↔ column id", () => {
  it("maps the host's `user` sort key onto the surface's `owner` column", () => {
    const view = toSessionsListViewState({
      ...HOST_BASE,
      sortKey: SessionSortKey.User,
    });

    expect(view.sortBy).toBe(OWNER_COLUMN_ID);
    // An identity function would leave `user` here, which the surface has no
    // reader for — the exact silent-empty-sort defect FEA-4300 fixed.
    expect(view.sortBy).not.toBe(SessionSortKey.User);
  });

  it("maps the surface's `owner` column back onto the server's `user` key", () => {
    const host = toSessionsHostViewState({
      ...toSessionsListViewState(HOST_BASE),
      sortBy: OWNER_COLUMN_ID,
    });

    expect(host.sortKey).toBe(SessionSortKey.User);
    expect(host.sortKey).not.toBe(OWNER_COLUMN_ID);
  });

  it("round-trips every other sort key unchanged", () => {
    for (const key of Object.values(SessionSortKey)) {
      const view = toSessionsListViewState({ ...HOST_BASE, sortKey: key });
      expect(
        toSessionsHostViewState({ ...view, sortBy: view.sortBy }).sortKey
      ).toBe(key);
    }
  });

  it("drops a column the surface cannot sort on rather than sorting on nothing", () => {
    // Natural order beats ranking every row by a reader that returns "".
    expect(toSessionsListSortField("not-a-column")).toBeNull();
    expect(toSessionsListSortField(null)).toBeNull();
  });

  it("keeps a null sort null in both directions", () => {
    expect(toSessionsListViewState(HOST_BASE).sortBy).toBeNull();
    expect(
      toSessionsHostViewState({
        ...toSessionsListViewState(HOST_BASE),
        sortBy: null,
      }).sortKey
    ).toBeNull();
  });
});

describe("grouping (one host slot ↔ two surface levels)", () => {
  it("puts the host's dimension in primary and leaves secondary empty", () => {
    const grouping = toTableGroupingState(SessionGroupBy.Status);

    expect(grouping.primary.fieldId).toBe(SessionGroupBy.Status);
    expect(grouping.secondary.fieldId).toBeNull();
  });

  it("maps None to no grouping, not to a group on the literal string 'none'", () => {
    expect(toTableGroupingState(SessionGroupBy.None)).toEqual(
      EMPTY_TABLE_GROUPING
    );
  });

  it("collapses a secondary level the host cannot persist", () => {
    // The host has one slot. Taking primary is the honest projection; silently
    // keeping secondary somewhere would be a value the host can never read back.
    expect(
      toSessionGroupBy({
        primary: { ...EMPTY_TABLE_GROUPING.primary, fieldId: "owner" },
        secondary: { ...EMPTY_TABLE_GROUPING.secondary, fieldId: "harness" },
      })
    ).toBe(SessionGroupBy.Owner);
  });

  it("refuses a dimension the host cannot persist instead of storing it", () => {
    // `model` is groupable on the surface but absent from SessionGroupBy, so it
    // must come back as None rather than being written and lost on reload.
    expect(
      toSessionGroupBy({
        ...EMPTY_TABLE_GROUPING,
        primary: { ...EMPTY_TABLE_GROUPING.primary, fieldId: "model" },
      })
    ).toBe(SessionGroupBy.None);
    expect(SESSIONS_HOST_GROUP_OPTION_IDS).not.toContain("model");
  });
});

describe("the 1:1 axes survive the round trip", () => {
  it("carries facets, date range, visible columns and page through unchanged", () => {
    const host: SessionsHostViewState = {
      ...HOST_BASE,
      page: 3,
      visibleColumns: new Set(["status", "owner", "cost"]),
    };
    const back = toSessionsHostViewState(toSessionsListViewState(host));

    expect(back.page).toBe(3);
    expect(back.facets).toEqual(host.facets);
    expect(back.dateRange).toBe(host.dateRange);
    expect([...back.visibleColumns].sort()).toEqual(
      [...host.visibleColumns].sort()
    );
  });

  it("keeps page 0-based, matching resolvePaginationBounds and the URL", () => {
    // Both sides clamp from 0. An off-by-one here would silently skip page 1.
    expect(toSessionsListViewState({ ...HOST_BASE, page: 0 }).page).toBe(0);
    expect(toSessionsListViewState({ ...HOST_BASE, page: 7 }).page).toBe(7);
  });

  it("carries the owner scope out AND back, including its removal", () => {
    // ISS-8037. Both directions, because either one dropping the axis is a
    // silent failure with the same shape: outbound, the surface renders no chip
    // over a list the host has narrowed; inbound, the chip's remove reports a
    // state the host reads as unchanged and never strips `?userId=` for. The
    // `null` leg is the one the removal actually travels on.
    const scoped: SessionsHostViewState = {
      ...HOST_BASE,
      scopeUserId: "user-pascoe",
    };

    expect(toSessionsListViewState(scoped).scopeUserId).toBe("user-pascoe");
    expect(
      toSessionsHostViewState(toSessionsListViewState(scoped))
    ).toMatchObject({ scopeUserId: "user-pascoe" });
    expect(
      toSessionsHostViewState({
        ...toSessionsListViewState(scoped),
        scopeUserId: null,
      }).scopeUserId
    ).toBeNull();
  });
});

describe("FEA-4222 custom-field columns are the host's own half", () => {
  const PRIORITY_COLUMN_ID = "custom-field:priority";
  const STAGE_COLUMN_ID = "custom-field:stage";

  it("strips custom-field ids from what the page is asked to persist", () => {
    const back = toSessionsHostViewState({
      ...toSessionsListViewState(HOST_BASE),
      visibleColumnIds: new Set([
        "status",
        "cost",
        PRIORITY_COLUMN_ID,
        STAGE_COLUMN_ID,
      ]),
    });

    // The page's `toggleColumn` does not filter against its valid-id list, so an
    // id it cannot represent does not bounce — it is written into the saved
    // view's `hiddenColumns` and persisted. Declared columns are untouched.
    expect([...back.visibleColumns].sort()).toEqual(["cost", "status"]);
  });

  it("rejoins the custom half the page could not store", () => {
    const visible = reconcileSessionsVisibleColumns(
      new Set(["status"]),
      [PRIORITY_COLUMN_ID, STAGE_COLUMN_ID],
      new Set([STAGE_COLUMN_ID])
    );

    expect([...visible].sort()).toEqual(["status", PRIORITY_COLUMN_ID].sort());
  });

  it("shows a custom column it has never been told about", () => {
    // The default and the whole reason the local half stores HIDDEN ids: a field
    // that appears after mount — created by the reader, or attached by an admin
    // — must render without a second action.
    const visible = reconcileSessionsVisibleColumns(
      new Set(["status"]),
      [PRIORITY_COLUMN_ID],
      new Set()
    );

    expect([...visible]).toContain(PRIORITY_COLUMN_ID);
  });

  it("forgets a hidden column whose field the org no longer has", () => {
    // Derived by subtraction from the columns that EXIST, so a stale id cannot
    // survive to hide a later field that happens to reuse its id.
    const hidden = toHiddenCustomFieldColumnIds(new Set(["status"]), [
      PRIORITY_COLUMN_ID,
    ]);

    expect([...hidden]).toEqual([PRIORITY_COLUMN_ID]);
    expect([...hidden]).not.toContain(STAGE_COLUMN_ID);
  });

  it("round-trips a reader hiding then re-showing one custom column", () => {
    const columnIds = [PRIORITY_COLUMN_ID, STAGE_COLUMN_ID];
    const hidden = toHiddenCustomFieldColumnIds(
      new Set(["status", STAGE_COLUMN_ID]),
      columnIds
    );

    expect([...hidden]).toEqual([PRIORITY_COLUMN_ID]);
    expect([
      ...reconcileSessionsVisibleColumns(
        new Set(["status"]),
        columnIds,
        hidden
      ),
    ]).not.toContain(PRIORITY_COLUMN_ID);
    expect([
      ...reconcileSessionsVisibleColumns(
        new Set(["status"]),
        columnIds,
        toHiddenCustomFieldColumnIds(
          new Set(["status", STAGE_COLUMN_ID, PRIORITY_COLUMN_ID]),
          columnIds
        )
      ),
    ]).toContain(PRIORITY_COLUMN_ID);
  });
});

describe("ISS-8335 — secondary sort rules round-trip to the host", () => {
  it("carries the WHOLE ordered rule list to the surface, lead rule first", () => {
    const view = toSessionsListViewState({
      ...HOST_BASE,
      secondarySorts: [
        { direction: SessionSortDir.Asc, fieldId: SessionSortKey.User },
      ],
      sortDir: SessionSortDir.Desc,
      sortKey: SessionSortKey.Status,
    });
    // The Owner rule is spelled in the SURFACE's vocabulary (`owner`), not the
    // server's (`user`) — the same FEA-4300 bridge the primary crosses, so the
    // toolbar names the second rule after the header it belongs to.
    expect(view.sorts).toEqual([
      { direction: SessionSortDir.Desc, fieldId: "status" },
      { direction: SessionSortDir.Asc, fieldId: "owner" },
    ]);
  });

  it("reports a surface sort change back as primary PLUS the rest", () => {
    const host = toSessionsHostViewState({
      ...toSessionsListViewState(HOST_BASE),
      sortBy: "status",
      sortDir: SessionSortDir.Desc,
      sorts: [
        { direction: SessionSortDir.Desc, fieldId: "status" },
        { direction: SessionSortDir.Asc, fieldId: "owner" },
      ],
    });
    // `owner` → `user`: a rule spelled the table's way is rejected by the
    // route's closed `sortBy` enum, which would 400 the whole list.
    expect(host.secondarySorts).toEqual([
      { direction: SessionSortDir.Asc, fieldId: SessionSortKey.User },
    ]);
  });

  it("does NOT drop the second rule (the ISS-8335 defect)", () => {
    // The counterfactual in one assertion: before this change the host held the
    // tail in component state and `toSessionsHostViewState` returned nothing for
    // it, so the toolbar showed a rule no query carried.
    const host = toSessionsHostViewState({
      ...toSessionsListViewState(HOST_BASE),
      sortBy: "status",
      sortDir: SessionSortDir.Desc,
      sorts: [
        { direction: SessionSortDir.Desc, fieldId: "status" },
        { direction: SessionSortDir.Asc, fieldId: "cost" },
        { direction: SessionSortDir.Desc, fieldId: "repo" },
      ],
    });
    expect(host.secondarySorts).toHaveLength(2);
  });

  it("emits no rule list at all when the lead slot is empty", () => {
    // The saved view has ONE lead slot (`sortKey`), so a secondary rule cannot
    // be promoted to lead — a list led by a rule the next reload could not
    // restore is the same lie in a different place.
    const view = toSessionsListViewState({
      ...HOST_BASE,
      secondarySorts: [
        { direction: SessionSortDir.Asc, fieldId: SessionSortKey.User },
      ],
      sortKey: null,
    });
    expect(view.sorts).toEqual([]);
  });
});

/**
 * ISS-8966 — the SEARCH axis crossing the same bridge.
 *
 * It is 1:1 in value but not in obligation: the host's slot is REQUIRED and the
 * surface's is optional (a saved view written before the axis existed carries no
 * key), so the two directions are asserted separately rather than as one
 * `toStrictEqual` on a round-trip that would hide a drop in either.
 */
describe("search axis ↔ host view state", () => {
  it("hands the host's term to the surface and reports it back", () => {
    const view = toSessionsListViewState({ ...HOST_BASE, search: "deploy" });

    expect(view.search).toBe("deploy");
    expect(toSessionsHostViewState(view).search).toBe("deploy");
  });

  it("reports a cleared term as the host's empty string, not as absent", () => {
    // The host's axis is a `string`, and its URL strip fires on `""`. An
    // `undefined` arriving here would be a term the host could not act on —
    // "Clear all" would leave `?search=` in the address bar.
    const host = toSessionsHostViewState({
      ...toSessionsListViewState({ ...HOST_BASE, search: "deploy" }),
      search: "",
    });

    expect(host.search).toBe("");
  });

  // The obligation itself, and the only thing in the repo that asserts it.
  // Every construction site names `search` today, so relaxing the host slot to
  // `search?: string` compiles clean and leaves this whole suite green — which
  // is how a `SessionsHostViewState` literal written on another branch reached
  // the merge queue missing the axis and failed only once the two were merged.
  // A shape whose omission is assignable back to the whole resolves to `never`
  // below, so that relaxation fails `tsc` here instead.
  it("keeps the host's search slot required, not merely populated", () => {
    const searchIsRequired: Omit<
      SessionsHostViewState,
      "search"
    > extends SessionsHostViewState
      ? never
      : true = true;

    expect(searchIsRequired).toBe(true);
  });

  it("normalizes a whitespace-only term to the unsearched value", () => {
    // Otherwise the host would write `?search=%20%20` and the surface would
    // resolve it back to nothing — a URL claiming a filter the list does not
    // have, and a chip row that cannot name it.
    expect(
      toSessionsHostViewState({
        ...toSessionsListViewState(HOST_BASE),
        search: "   ",
      }).search
    ).toBe("");
  });
});
