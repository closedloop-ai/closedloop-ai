import {
  DEFAULT_SESSION_FACET_FILTERS,
  type SessionFacetFilters,
} from "@repo/app/agents/lib/session-filter-adapter";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  OWNER_COLUMN_ID,
  SessionSortKey,
} from "../../../lib/session-sort-group";
import type { SessionsListViewState } from "../sessions-list-view-state";
import { useSessionsListView } from "../sessions-list-view-state";

/**
 * ISS-7262 — `useSessionsListView` at its own seam, with no component mount.
 *
 * The surface-level test next door proves a host DRIVES the list; these prove
 * the merge semantics the patch API exists for, which a single-axis interaction
 * like paging cannot observe.
 */

const SEED: SessionsListViewState = {
  sortBy: null,
  sortDir: "asc",
  grouping: EMPTY_TABLE_GROUPING,
  facets: DEFAULT_SESSION_FACET_FILTERS,
  dateRange: DEFAULT_DATE_RANGE,
  visibleColumnIds: new Set(["status"]),
  page: 3,
  scopeUserId: null,
};

/** One facet selected, every other facet left empty. */
function withFacets(
  selection: Partial<SessionFacetFilters>
): SessionFacetFilters {
  return { ...DEFAULT_SESSION_FACET_FILTERS, ...selection };
}

const HOST_VIEW: SessionsListViewState = {
  ...SEED,
  sortBy: "cost",
  facets: withFacets({ statuses: ["Active"] }),
  page: 7,
};

/**
 * COMPILE-TIME guard on `sortBy`'s vocabulary. `tsc` is the assertion here, not
 * the `expect` below: these two declarations are checked against
 * `SessionsListViewState`, and each fails the build if the union stops holding
 * the line.
 *
 * `OWNER_COLUMN_ID` must be ACCEPTED — without this half the negative below
 * would still pass against a union narrowed to nothing usable.
 */
const OWNER_COLUMN_SORT_VIEW: SessionsListViewState = {
  ...SEED,
  sortBy: OWNER_COLUMN_ID,
};

/**
 * And the Owner column's SERVER sort key must be REJECTED. `owner` and `user`
 * are the one pair the two vocabularies spell differently, so a host adapting a
 * persisted `SessionSortKey` straight through is wrong for exactly this column.
 * While `sortBy` was `string`, this compiled and then sorted on a column
 * `sessionCellValue` has no reader for, so every row compared as `""`.
 *
 * If `sortBy` ever re-widens, the directive below becomes unused and `tsc` fails
 * with TS2578 — which is the regression this guard is for.
 */
const SERVER_SORT_KEY_VIEW: SessionsListViewState = {
  ...SEED,
  // @ts-expect-error `user` is a SessionSortKey, not a column id.
  sortBy: SessionSortKey.User,
};

describe("useSessionsListView", () => {
  /**
   * Keeps the two compile-time guards above reachable, and pins the FACT they
   * are about: these are two different spellings of the same column, so a host
   * passing one where the other is meant is not a no-op.
   */
  it("distinguishes the Owner column id from its server sort key", () => {
    expect(OWNER_COLUMN_SORT_VIEW.sortBy).toBe("owner");
    expect(SERVER_SORT_KEY_VIEW.sortBy).toBe("user");
    expect(OWNER_COLUMN_SORT_VIEW.sortBy).not.toBe(SERVER_SORT_KEY_VIEW.sortBy);
  });

  it("merges a patch into its own state when uncontrolled", () => {
    const { result } = renderHook(() =>
      useSessionsListView(undefined, () => SEED)
    );

    expect(result.current[0]).toEqual(SEED);

    act(() =>
      result.current[1]({
        facets: withFacets({ statuses: ["Active"] }),
        page: 0,
      })
    );

    // Merged, not replaced: the axes the patch did not name survive.
    expect(result.current[0]).toEqual({
      ...SEED,
      facets: withFacets({ statuses: ["Active"] }),
      page: 0,
    });
  });

  it("reads the controller's value and never consults the seed", () => {
    const onChange = vi.fn();
    const createSeed = vi.fn(() => SEED);
    const { result } = renderHook(() =>
      useSessionsListView({ value: HOST_VIEW, onChange }, createSeed)
    );

    // The `initial*` props a host also passed are inert while controlled — the
    // controller's value is the whole view, not a merge over the seed.
    expect(result.current[0]).toEqual(HOST_VIEW);
    expect(result.current[0].page).not.toBe(SEED.page);
  });

  it("commits a multi-axis patch in ONE controlled write", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useSessionsListView({ value: HOST_VIEW, onChange }, () => SEED)
    );

    // The shape every filter callback uses: narrow the scope AND return to the
    // first page. Split back into two sequential writes, each would derive from
    // the same unchanged `HOST_VIEW` and the page reset would land without the
    // filter — the regression this patch API exists to make impossible.
    act(() =>
      result.current[1]({
        facets: withFacets({ userIds: ["user-pascoe"] }),
        page: 0,
      })
    );

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      ...HOST_VIEW,
      facets: withFacets({ userIds: ["user-pascoe"] }),
      page: 0,
    });
    // Reported, not applied — the host still owns the value.
    expect(result.current[0]).toEqual(HOST_VIEW);
  });

  it("composes several controlled writes fired in ONE event", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useSessionsListView({ value: HOST_VIEW, onChange }, () => SEED)
    );

    // The shape `ActiveFiltersBar`'s "Clear all" produces: `clearAllFilters()`
    // and then one `onToggle` per selected facet value, all synchronously, with
    // no render in between. `controller.value` is a prop and cannot move across
    // those calls, so without carrying our own emission forward the last write
    // would rebuild from the pre-click value and drop the earlier ones.
    act(() => {
      result.current[1]((current) => ({
        facets: { ...current.facets, statuses: [] },
        page: 0,
      }));
      result.current[1]((current) => ({
        facets: { ...current.facets, userIds: [] },
      }));
    });

    expect(onChange).toHaveBeenLastCalledWith({
      ...HOST_VIEW,
      facets: DEFAULT_SESSION_FACET_FILTERS,
      page: 0,
    });
  });

  it("drops a staged emission once the host commits a new value", () => {
    const onChange = vi.fn();
    const { rerender, result } = renderHook(
      ({ value }: { value: SessionsListViewState }) =>
        useSessionsListView({ value, onChange }, () => SEED),
      { initialProps: { value: HOST_VIEW } }
    );

    act(() => result.current[1]({ facets: DEFAULT_SESSION_FACET_FILTERS }));

    // The host commits something OTHER than what we staged. The next write must
    // build on the host's value, not on our superseded one — otherwise a
    // rejected or rewritten commit would be silently reinstated.
    const committed: SessionsListViewState = { ...HOST_VIEW, sortBy: "repo" };
    rerender({ value: committed });
    act(() => result.current[1]({ page: 0 }));

    expect(onChange).toHaveBeenLastCalledWith({ ...committed, page: 0 });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ facets: HOST_VIEW.facets })
    );
  });
});
