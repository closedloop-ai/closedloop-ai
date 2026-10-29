import { SESSION_URL_OWNED_WINDOW_PARAMS } from "@repo/app/agents/lib/session-custom-date-window";
import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSessionsListUrlWriters } from "../use-sessions-list-url-writers";

/**
 * ISS-9107 AC7 — "Clear filters" must REMOVE `?from=`/`?to=`, in the one write
 * that carries the cleared facets.
 *
 * The bug this pins shipped on the first revision of this branch:
 * `resolveSessionsScopeDelta` reports `dateRange: null` whenever the PRESET has
 * not moved, and the writer stripped the window params only on a preset move.
 * So a reader whose preset was already the default cleared their filters and
 * kept an explicit window narrowing the list, with nothing naming it.
 *
 * Asserted on the `clearParamKeys` the writer passes, because that argument IS
 * the removal — and on the write COUNT, because two writes in one click both
 * start from the pre-click search-params snapshot and the later restores what
 * the earlier removed (ISS-4728).
 */

const SEARCH_PARAM = "search";

function renderWriters() {
  const replaceListParams = vi.fn();
  const { result } = renderHook(() =>
    useSessionsListUrlWriters({
      facetFilters: DEFAULT_SESSION_FACET_FILTERS,
      replaceListParams,
      searchParam: SEARCH_PARAM,
      setDateRange: vi.fn(),
      setFacetFilters: vi.fn(),
      setSort: vi.fn(),
    })
  );
  return { replaceListParams, writers: result.current };
}

/**
 * The `clearParamKeys` of the writer's SINGLE call, and the call count with it —
 * one write per action is half the contract, so the count is returned for the
 * test body to assert rather than checked in here.
 */
function writeOf(replaceListParams: ReturnType<typeof vi.fn>): {
  callCount: number;
  clearedKeys: string[];
} {
  return {
    callCount: replaceListParams.mock.calls.length,
    clearedKeys: [...(replaceListParams.mock.calls[0]?.[2] ?? [])],
  };
}

describe("useSessionsListUrlWriters.handleScopeChange (ISS-9107)", () => {
  it("strips the window params when the reader cleared filters and the preset did not move", () => {
    const { replaceListParams, writers } = renderWriters();

    writers.handleScopeChange({
      search: null,
      clearWindow: true,
      dateRange: null,
      facets: DEFAULT_SESSION_FACET_FILTERS,
    });

    const { callCount, clearedKeys } = writeOf(replaceListParams);
    expect(callCount).toBe(1);
    expect(clearedKeys).toEqual(
      expect.arrayContaining([...SESSION_URL_OWNED_WINDOW_PARAMS])
    );
  });

  // The negative sibling. A bare facet toggle must leave an explicit window
  // alone — the v1 branch does — or narrowing by status would silently widen
  // the interval the reader chose.
  it("leaves the window alone on a scope change that neither cleared nor moved the preset", () => {
    const { replaceListParams, writers } = renderWriters();

    writers.handleScopeChange({
      search: null,
      clearWindow: false,
      dateRange: null,
      facets: DEFAULT_SESSION_FACET_FILTERS,
    });

    const { callCount, clearedKeys } = writeOf(replaceListParams);
    expect(callCount).toBe(1);
    expect(clearedKeys).toEqual([]);
  });

  it("strips the window params when a preset is picked, window or not", () => {
    const { replaceListParams, writers } = renderWriters();

    writers.handleScopeChange({
      search: null,
      clearWindow: false,
      dateRange: "30d",
      facets: DEFAULT_SESSION_FACET_FILTERS,
    });

    const { callCount, clearedKeys } = writeOf(replaceListParams);
    expect(callCount).toBe(1);
    expect(clearedKeys).toEqual(
      expect.arrayContaining([...SESSION_URL_OWNED_WINDOW_PARAMS])
    );
  });

  it("carries the search strip and the window strip in the SAME write", () => {
    const { replaceListParams, writers } = renderWriters();

    writers.handleScopeChange({
      search: "",
      clearWindow: true,
      dateRange: null,
      facets: DEFAULT_SESSION_FACET_FILTERS,
    });

    const { callCount, clearedKeys } = writeOf(replaceListParams);
    expect(callCount).toBe(1);
    expect(clearedKeys).toEqual(
      expect.arrayContaining([SEARCH_PARAM, ...SESSION_URL_OWNED_WINDOW_PARAMS])
    );
  });
});
