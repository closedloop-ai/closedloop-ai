/**
 * ISS-9665 — the priority facet can select "no priority", and a row with no
 * priority is matched EXPLICITLY rather than dropped by every priority filter.
 *
 * The predicate used to read `item.data.priority && filters.priorities.includes(…)`,
 * so an unset row failed the truthiness check and fell out of any active
 * priority filter with no facet that could ever keep it. That is the same defect
 * class as the serializer folding NULL to MEDIUM: a NULL silently taking a
 * branch nobody chose for it.
 *
 * Every case here is a pair — a filter that must KEEP the unset row and one that
 * must EXCLUDE it — because a predicate that returned everything, and one that
 * returned nothing, each satisfy exactly one half.
 */
import { Priority } from "@repo/api/src/types/common";
import { PRIORITY_UNSET_VALUE } from "@repo/api/src/types/search-query";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mockFlagEnabled = vi.fn();

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabledOptional: (key: string) => mockFlagEnabled(key),
}));

import { useTableFilters } from "../use-table-filters";
import { makeFilterItem } from "./table-filter-fixtures";

const UNSET_ROW = makeFilterItem("unset", { priority: null });
const HIGH_ROW = makeFilterItem("high", { priority: Priority.High });
const MEDIUM_ROW = makeFilterItem("medium", { priority: Priority.Medium });
const ITEMS = [UNSET_ROW, HIGH_ROW, MEDIUM_ROW];

beforeEach(() => {
  mockFlagEnabled.mockReset();
  mockFlagEnabled.mockReturnValue(true);
});

function idsAfterSelecting(selected: readonly string[]): string[] {
  const { result } = renderHook(() => useTableFilters({ items: ITEMS }));
  for (const value of selected) {
    act(() => {
      result.current.togglePriority(
        value as Parameters<typeof result.current.togglePriority>[0]
      );
    });
  }
  // Driven through the hook's own filter entry point, not a re-derivation.
  return result.current.applyFilters(ITEMS).map((item) => item.data.id);
}

describe("priority facet — the unset value", () => {
  test("selecting it keeps ONLY the rows with no priority", () => {
    expect(idsAfterSelecting([PRIORITY_UNSET_VALUE])).toEqual(["unset"]);
  });

  test("selecting a real priority excludes the unset row", () => {
    // The sibling of the case above. Without it, a predicate that always kept
    // the unset row would pass the first test and still be wrong.
    expect(idsAfterSelecting([Priority.High])).toEqual(["high"]);
  });

  test("selecting both keeps the unset row and that priority, nothing else", () => {
    expect(
      idsAfterSelecting([PRIORITY_UNSET_VALUE, Priority.High]).sort()
    ).toEqual(["high", "unset"]);
  });

  test("no priority filter at all keeps every row, unset included", () => {
    expect(idsAfterSelecting([]).sort()).toEqual(["high", "medium", "unset"]);
  });
});

describe("priority facet — counts", () => {
  test("the unset rows are counted under the unset value, not dropped", () => {
    const { result } = renderHook(() => useTableFilters({ items: ITEMS }));

    // Whole-map equality: a counter that merely ADDED an unset bucket while
    // double-counting those rows under MEDIUM would pass a key-by-key read.
    expect(Object.fromEntries(result.current.priorityCounts)).toEqual({
      [PRIORITY_UNSET_VALUE]: 1,
      [Priority.High]: 1,
      [Priority.Medium]: 1,
    });
  });
});

describe("priority facet — a persisted unset selection outlives the flag", () => {
  test("is dropped from the ACTIVE filters when the flag goes off", () => {
    // The selection lives in localStorage for 7 days but the flag can go off
    // inside that window. Honoring it then would filter rows whose null
    // priority the flag-off path has already folded back to MEDIUM — matching
    // nothing, and leaving no visible chip to clear because the facet option
    // that created it is not rendered either.
    mockFlagEnabled.mockReturnValue(true);
    const { result, rerender } = renderHook(() =>
      useTableFilters({ items: ITEMS })
    );
    act(() => {
      result.current.togglePriority(PRIORITY_UNSET_VALUE);
    });
    expect(
      result.current.applyFilters(ITEMS).map((item) => item.data.id)
    ).toEqual(["unset"]);

    mockFlagEnabled.mockReturnValue(false);
    rerender();

    expect(result.current.filters.priorities).toEqual([]);
    expect(
      result.current
        .applyFilters(ITEMS)
        .map((item) => item.data.id)
        .sort()
    ).toEqual(["high", "medium", "unset"]);
  });

  test("a real priority selection survives the flag going off", () => {
    // The sibling that stops the drop from being a blanket "clear priorities on
    // flag-off" — only the value the flag introduced is withdrawn.
    mockFlagEnabled.mockReturnValue(true);
    const { result, rerender } = renderHook(() =>
      useTableFilters({ items: ITEMS })
    );
    act(() => {
      result.current.togglePriority(Priority.High);
    });

    mockFlagEnabled.mockReturnValue(false);
    rerender();

    expect(result.current.filters.priorities).toEqual([Priority.High]);
    expect(
      result.current.applyFilters(ITEMS).map((item) => item.data.id)
    ).toEqual(["high"]);
  });
});
