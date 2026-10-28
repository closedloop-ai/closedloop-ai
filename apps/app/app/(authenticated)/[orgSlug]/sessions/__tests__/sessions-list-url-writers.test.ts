import { SESSION_URL_OWNED_WINDOW_PARAMS } from "@repo/app/agents/lib/session-custom-date-window";
import {
  DEFAULT_SESSION_FACET_FILTERS,
  type SessionFacetFilters,
} from "@repo/app/agents/lib/session-filter-adapter";
import { SESSIONS_SEARCH_PARAM } from "@repo/app/agents/lib/session-url-scope-params";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSessionsListUrlWriters } from "../use-sessions-list-url-writers";

/**
 * ISS-9555 slice 4 — the web writers' half of the ISS-4728 contract, which had
 * no unit coverage at all before this file while the desktop twin had its own.
 *
 * Every case asserts the write COUNT alongside what the write carried, because
 * one write per action IS the contract: `useReplaceListParams` copies the
 * render's search-params snapshot, so a second write in the same interaction
 * starts from the pre-interaction URL and silently restores what the first
 * removed.
 */

const SELECTED_USER_PARAM = "userId";
const OWNED_PROJECT_IDS = ["project-1"];

function renderWriters({
  facetFilters = DEFAULT_SESSION_FACET_FILTERS,
  projectFacetEnabled = true,
}: {
  facetFilters?: SessionFacetFilters;
  projectFacetEnabled?: boolean;
} = {}) {
  const markPageReset = vi.fn();
  const replaceListParams = vi.fn();
  const { result } = renderHook(() =>
    useSessionsListUrlWriters({
      facetFilters,
      markPageReset,
      projectFacetEnabled,
      replaceListParams,
      selectedUserParam: SELECTED_USER_PARAM,
      setDateRange: vi.fn(),
      setFacetFilters: vi.fn(),
    })
  );
  return { markPageReset, replaceListParams, writers: result.current };
}

/** The single write's arguments, with the call count for the test to assert. */
function writeOf(replaceListParams: ReturnType<typeof vi.fn>): {
  callCount: number;
  clearedKeys: string[];
  facets: SessionFacetFilters | undefined;
  pageIndex: number | undefined;
} {
  const call = replaceListParams.mock.calls[0];
  return {
    callCount: replaceListParams.mock.calls.length,
    clearedKeys: [...(call?.[2] ?? [])],
    facets: call?.[0],
    pageIndex: call?.[1],
  };
}

describe("useSessionsListUrlWriters (web)", () => {
  it("clears the owner scope and the window in the one write that resets the facets", () => {
    const { markPageReset, replaceListParams, writers } = renderWriters();

    writers.handleClearFilters();

    const write = writeOf(replaceListParams);
    expect(write.callCount).toBe(1);
    expect(write.clearedKeys).toEqual([
      SELECTED_USER_PARAM,
      SESSIONS_SEARCH_PARAM,
      ...SESSION_URL_OWNED_WINDOW_PARAMS,
    ]);
    expect(write.facets).toBe(DEFAULT_SESSION_FACET_FILTERS);
    expect(write.pageIndex).toBe(0);
    expect(markPageReset).toHaveBeenCalledTimes(1);
  });

  it("removes the selected user without stripping the window the reader arrived with", () => {
    const { replaceListParams, writers } = renderWriters();
    const nextFilters: SessionFacetFilters = {
      ...DEFAULT_SESSION_FACET_FILTERS,
      statuses: ["active"],
    };

    writers.handleRemoveSelectedUser(nextFilters);

    const write = writeOf(replaceListParams);
    expect(write.callCount).toBe(1);
    expect(write.clearedKeys).toEqual([SELECTED_USER_PARAM]);
    expect(write.facets).toBe(nextFilters);
    expect(write.pageIndex).toBe(0);
  });

  it("strips nothing when a scope change moved only the facets", () => {
    const { replaceListParams, writers } = renderWriters();

    writers.handleScopeChange({
      clearScopeUser: false,
      dateRange: null,
      facets: DEFAULT_SESSION_FACET_FILTERS,
    });

    const write = writeOf(replaceListParams);
    expect(write.callCount).toBe(1);
    expect(write.clearedKeys).toEqual([]);
  });

  /**
   * ISS-9822 — the sibling of the case above, and the pair is the point: the two
   * deltas differ in `clearWindow` and nothing else, so a writer that ignored the
   * field would pass one and fail the other, and one that hardcoded the strip
   * would fail the first. The v2 surface reports its window clear through a
   * SEPARATE callback, so the page's fold is the only thing that knows the click
   * carried one — which is why this rides the delta rather than being derived
   * from the moved axes.
   */
  it("strips the window on a facet-only change that reports a pending clear", () => {
    const { replaceListParams, writers } = renderWriters();

    writers.handleScopeChange({
      clearScopeUser: false,
      clearWindow: true,
      dateRange: null,
      facets: DEFAULT_SESSION_FACET_FILTERS,
    });

    const write = writeOf(replaceListParams);
    expect(write.callCount).toBe(1);
    expect(write.clearedKeys).toEqual([...SESSION_URL_OWNED_WINDOW_PARAMS]);
  });

  it("strips the owner scope and the window together when both axes moved", () => {
    const { replaceListParams, writers } = renderWriters();

    writers.handleScopeChange({
      clearScopeUser: true,
      dateRange: DEFAULT_DATE_RANGE,
      facets: DEFAULT_SESSION_FACET_FILTERS,
    });

    const write = writeOf(replaceListParams);
    expect(write.callCount).toBe(1);
    expect(write.clearedKeys).toEqual([
      SELECTED_USER_PARAM,
      ...SESSION_URL_OWNED_WINDOW_PARAMS,
    ]);
  });

  it("re-asserts a project facet the gate emptied, not one the reader cleared", () => {
    const owned: SessionFacetFilters = {
      ...DEFAULT_SESSION_FACET_FILTERS,
      projectIds: OWNED_PROJECT_IDS,
    };
    const gatedOff = renderWriters({
      facetFilters: owned,
      projectFacetEnabled: false,
    });

    gatedOff.writers.handleScopeChange({
      clearScopeUser: false,
      dateRange: null,
      facets: DEFAULT_SESSION_FACET_FILTERS,
    });

    expect(writeOf(gatedOff.replaceListParams).facets?.projectIds).toEqual(
      OWNED_PROJECT_IDS
    );

    const gatedOn = renderWriters({
      facetFilters: owned,
      projectFacetEnabled: true,
    });

    gatedOn.writers.handleScopeChange({
      clearScopeUser: false,
      dateRange: null,
      facets: DEFAULT_SESSION_FACET_FILTERS,
    });

    expect(writeOf(gatedOn.replaceListParams).facets?.projectIds).toEqual([]);
  });

  it("strips the window in the same write as the page reset on a preset change", () => {
    const { markPageReset, replaceListParams, writers } = renderWriters();

    writers.handleDateRangeChange(DEFAULT_DATE_RANGE);

    const write = writeOf(replaceListParams);
    expect(write.callCount).toBe(1);
    expect(write.clearedKeys).toEqual([...SESSION_URL_OWNED_WINDOW_PARAMS]);
    expect(write.pageIndex).toBe(0);
    expect(markPageReset).toHaveBeenCalledTimes(1);
  });
});
