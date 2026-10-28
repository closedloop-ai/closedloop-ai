import { describe, expect, it, vi } from "vitest";
import {
  DateRange,
  DEFAULT_DATE_RANGE,
} from "../../../shared/lib/format-utils";
import { DEFAULT_SESSION_FACET_FILTERS } from "../session-filter-adapter";
import { SessionGroupBy } from "../session-grouping";
import { SessionSortKey, type SessionSortRule } from "../session-sort-group";
import {
  applySessionsHostViewChange,
  resolveSessionsScopeDelta,
} from "../sessions-host-view-change";
import type { SessionsHostViewState } from "../sessions-list-view-adapter";

/**
 * ISS-8909 — the write ORDER a `SessionsListSurfaceV2` update has to land in,
 * and the one thing that changed when this router moved out of the web page:
 * `markPageReset` is now OPTIONAL, because it answers a question only a host
 * with a lagging page index has.
 *
 * Optional is the risky direction. A host that supplies the marker must still
 * get it called (dropping the call silently reinstates the ISS-8335 defect
 * where a re-sort left the reader on a page of an order that no longer
 * existed), and a host that omits it must get every OTHER write unchanged
 * rather than a thrown render.
 */

const CURRENT = {
  dateRange: DEFAULT_DATE_RANGE,
  facets: DEFAULT_SESSION_FACET_FILTERS,
  groupBy: SessionGroupBy.None,
  pageIndex: 3,
  scopeUserId: null,
  secondarySorts: [],
  sortDir: "desc" as const,
  sortKey: SessionSortKey.LastActivity,
  visibleColumns: new Set<string>(["status"]),
};

const SORT_MOVED: SessionsHostViewState = {
  dateRange: CURRENT.dateRange,
  facets: CURRENT.facets,
  groupBy: CURRENT.groupBy,
  page: CURRENT.pageIndex,
  scopeUserId: null,
  // ISS-8966: nothing is searched in any case below — this router reads the
  // sort, scope, column and page axes and never the term — so the fixture says
  // so with the axis's own "no search" spelling rather than inventing one.
  search: "",
  secondarySorts: [],
  sortDir: "desc",
  sortKey: SessionSortKey.Cost,
  visibleColumns: new Set<string>(["status"]),
};

function handlers() {
  return {
    markPageReset: vi.fn(),
    onScopeChange: vi.fn(),
    replacePage: vi.fn(),
    setGroupBy: vi.fn(),
    setSecondarySorts: vi.fn(),
    setSort: vi.fn(),
    toggleColumn: vi.fn(),
  };
}

describe("applySessionsHostViewChange", () => {
  it("marks the page reset for a host that supplies the marker", () => {
    const spies = handlers();
    applySessionsHostViewChange(SORT_MOVED, CURRENT, spies);
    expect(spies.markPageReset).toHaveBeenCalledTimes(1);
    expect(spies.setSort).toHaveBeenCalledWith(SessionSortKey.Cost, "desc");
    expect(spies.replacePage).toHaveBeenCalledWith(0);
  });

  // A host with no lagging index (the desktop renderer reads its page straight
  // back out of the hash URL it just wrote) omits the marker entirely. The
  // page reset itself is NOT optional — only the marking of it is.
  it("still resets the page for a host that omits the marker", () => {
    const { markPageReset: _omitted, ...withoutMarker } = handlers();
    expect(() =>
      applySessionsHostViewChange(SORT_MOVED, CURRENT, withoutMarker)
    ).not.toThrow();
    expect(withoutMarker.setSort).toHaveBeenCalledWith(
      SessionSortKey.Cost,
      "desc"
    );
    expect(withoutMarker.replacePage).toHaveBeenCalledWith(0);
  });

  // ISS-4728 / ISS-5355: a scope change already wrote its own page reset
  // carrying the NEW facets, so a second page write would copy the same
  // pre-click search-params snapshot and put the cleared facets back.
  it("skips the page write when the scope branch fired", () => {
    const spies = handlers();
    const nextFacets = {
      ...DEFAULT_SESSION_FACET_FILTERS,
      statuses: ["error"],
    };
    applySessionsHostViewChange(
      { ...SORT_MOVED, facets: nextFacets, page: 7, sortKey: CURRENT.sortKey },
      CURRENT,
      spies
    );
    expect(spies.onScopeChange).toHaveBeenCalledWith({
      clearScopeUser: false,
      search: null,
      dateRange: null,
      facets: nextFacets,
    });
    expect(spies.replacePage).not.toHaveBeenCalled();
  });

  /**
   * ISS-9822: the host is holding a clear for an axis this router does not
   * compare — an explicit `?from=`/`?to=` window, a `?search=` term — on an
   * update that moved nothing else. Without the synthesized write the clear
   * never reaches the URL, and the trailing page branch writes instead: two
   * writes off one pre-click snapshot, which is the ISS-4728 trap.
   */
  it("synthesizes one scope write for a pending clear that moved no axis", () => {
    const spies = handlers();
    applySessionsHostViewChange(
      { ...SORT_MOVED, page: 0, sortKey: CURRENT.sortKey },
      CURRENT,
      spies,
      { pendingScopeClear: true }
    );
    expect(spies.onScopeChange).toHaveBeenCalledTimes(1);
    expect(spies.onScopeChange).toHaveBeenCalledWith({
      clearScopeUser: false,
      search: null,
      dateRange: null,
      facets: CURRENT.facets,
    });
    expect(spies.replacePage).not.toHaveBeenCalled();
  });

  it("still writes the scope once when a pending clear rides a real delta", () => {
    const spies = handlers();
    const nextFacets = {
      ...DEFAULT_SESSION_FACET_FILTERS,
      statuses: ["error"],
    };
    applySessionsHostViewChange(
      { ...SORT_MOVED, facets: nextFacets, page: 0, sortKey: CURRENT.sortKey },
      CURRENT,
      spies,
      { pendingScopeClear: true }
    );
    expect(spies.onScopeChange).toHaveBeenCalledTimes(1);
    expect(spies.onScopeChange).toHaveBeenCalledWith({
      clearScopeUser: false,
      search: null,
      dateRange: null,
      facets: nextFacets,
    });
    expect(spies.replacePage).not.toHaveBeenCalled();
  });

  it("writes nothing when no axis moved and no clear is pending", () => {
    const spies = handlers();
    applySessionsHostViewChange(
      { ...SORT_MOVED, sortKey: CURRENT.sortKey },
      CURRENT,
      spies
    );
    expect(spies.onScopeChange).not.toHaveBeenCalled();
    expect(spies.replacePage).not.toHaveBeenCalled();
    expect(spies.setSort).not.toHaveBeenCalled();
  });

  it("applies a visible-column change in both directions", () => {
    const spies = handlers();
    applySessionsHostViewChange(
      {
        ...SORT_MOVED,
        sortKey: CURRENT.sortKey,
        visibleColumns: new Set<string>(["cost"]),
      },
      CURRENT,
      spies
    );
    expect(spies.toggleColumn.mock.calls.flat().sort()).toStrictEqual([
      "cost",
      "status",
    ]);
  });
});

const UNMOVED: SessionsHostViewState = {
  ...SORT_MOVED,
  sortKey: CURRENT.sortKey,
};

const COST_ASC: SessionSortRule = {
  direction: "asc",
  fieldId: SessionSortKey.Cost,
};

describe("applySessionsHostViewChange secondary sorts and other axes", () => {
  it("writes only the direction change when the primary key is unchanged", () => {
    const spies = handlers();
    applySessionsHostViewChange({ ...UNMOVED, sortDir: "asc" }, CURRENT, spies);
    expect(spies.setSort).toHaveBeenCalledWith(
      SessionSortKey.LastActivity,
      "asc"
    );
    expect(spies.setSecondarySorts).not.toHaveBeenCalled();
    expect(spies.replacePage).toHaveBeenCalledWith(0);
  });

  it("writes an added secondary rule without touching the primary sort", () => {
    const spies = handlers();
    applySessionsHostViewChange(
      { ...UNMOVED, secondarySorts: [COST_ASC] },
      CURRENT,
      spies
    );
    expect(spies.setSort).not.toHaveBeenCalled();
    expect(spies.setSecondarySorts).toHaveBeenCalledWith([COST_ASC]);
    expect(spies.markPageReset).toHaveBeenCalledTimes(1);
    expect(spies.replacePage).toHaveBeenCalledTimes(1);
    expect(spies.replacePage).toHaveBeenCalledWith(0);
  });

  it.each([
    ["field", { ...COST_ASC, fieldId: SessionSortKey.LastActivity }],
    ["direction", { ...COST_ASC, direction: "desc" as const }],
  ])("treats a same-length list with a different %s as moved", (_l, rule) => {
    const spies = handlers();
    applySessionsHostViewChange(
      { ...UNMOVED, secondarySorts: [rule] },
      { ...CURRENT, secondarySorts: [COST_ASC] },
      spies
    );
    expect(spies.setSecondarySorts).toHaveBeenCalledWith([rule]);
  });

  it("compares secondary rules by value, not identity", () => {
    const spies = handlers();
    applySessionsHostViewChange(
      { ...UNMOVED, secondarySorts: [{ ...COST_ASC }] },
      { ...CURRENT, secondarySorts: [COST_ASC] },
      spies
    );
    expect(spies.setSecondarySorts).not.toHaveBeenCalled();
    expect(spies.markPageReset).not.toHaveBeenCalled();
    expect(spies.replacePage).not.toHaveBeenCalled();
  });

  it("writes a group-by change without resetting the page", () => {
    const spies = handlers();
    applySessionsHostViewChange(
      { ...UNMOVED, groupBy: SessionGroupBy.Status },
      CURRENT,
      spies
    );
    expect(spies.setGroupBy).toHaveBeenCalledWith(SessionGroupBy.Status);
    expect(spies.replacePage).not.toHaveBeenCalled();
  });

  it("writes a page move when nothing else changed", () => {
    const spies = handlers();
    applySessionsHostViewChange({ ...UNMOVED, page: 5 }, CURRENT, spies);
    expect(spies.replacePage).toHaveBeenCalledTimes(1);
    expect(spies.replacePage).toHaveBeenCalledWith(5);
    expect(spies.onScopeChange).not.toHaveBeenCalled();
    expect(spies.markPageReset).not.toHaveBeenCalled();
  });

  it("marks the page reset a group-by change carries", () => {
    const spies = handlers();
    applySessionsHostViewChange(
      { ...UNMOVED, groupBy: SessionGroupBy.Status, page: 0 },
      CURRENT,
      spies
    );
    expect(spies.setGroupBy).toHaveBeenCalledWith(SessionGroupBy.Status);
    expect(spies.markPageReset).toHaveBeenCalledTimes(1);
    expect(spies.replacePage).toHaveBeenCalledTimes(1);
    expect(spies.replacePage).toHaveBeenCalledWith(0);
  });
});

describe("resolveSessionsScopeDelta", () => {
  const current = {
    dateRange: DEFAULT_DATE_RANGE,
    facets: DEFAULT_SESSION_FACET_FILTERS,
    scopeUserId: "user-1",
  };

  it("returns null when no scope axis moved", () => {
    expect(resolveSessionsScopeDelta(current, current)).toBeNull();
  });

  it("carries a moved window and keeps the current facets", () => {
    expect(
      resolveSessionsScopeDelta(
        { ...current, dateRange: DateRange.Last30Days },
        current
      )
    ).toEqual({
      clearScopeUser: false,
      search: null,
      dateRange: DateRange.Last30Days,
      facets: current.facets,
    });
  });

  it("clears the owner scope when the next state drops it", () => {
    expect(
      resolveSessionsScopeDelta({ ...current, scopeUserId: null }, current)
    ).toEqual({
      clearScopeUser: true,
      search: null,
      dateRange: null,
      facets: current.facets,
    });
  });

  it("does not treat a different selected owner as a clear", () => {
    expect(
      resolveSessionsScopeDelta({ ...current, scopeUserId: "user-2" }, current)
    ).toBeNull();
  });

  it("does not clear an owner scope that was never set", () => {
    expect(
      resolveSessionsScopeDelta(
        { ...current, scopeUserId: null },
        { ...current, scopeUserId: null }
      )
    ).toBeNull();
  });
});
