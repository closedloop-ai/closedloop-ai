import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  DateFilterField,
  DatePreset,
  useTableFilters,
} from "../use-table-filters";
import { makeFilterItem } from "./table-filter-fixtures";

describe("useTableFilters — custom date ranges", () => {
  test("uses updatedAt for an updated custom range", () => {
    const inside = makeFilterItem("inside", {
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2025-01-15T00:00:00.000Z"),
    });
    const outside = makeFilterItem("outside", {
      createdAt: new Date("2025-01-15T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    });
    const { result } = renderHook(() =>
      useTableFilters({ items: [inside, outside] })
    );

    act(() => {
      result.current.toggleHideCompletedItems();
      result.current.setDateFilter({
        field: DateFilterField.UpdatedAt,
        preset: DatePreset.Custom,
        startDate: new Date("2025-01-01T00:00:00.000Z"),
        endDate: new Date("2025-01-31T23:59:59.999Z"),
      });
    });

    expect(result.current.isCustomRangeValid).toBe(true);
    expect(result.current.applyFilters([inside, outside])).toEqual([inside]);
    expect(result.current.activeChips).toContainEqual({
      category: "date",
      label: "Updated: Custom range",
    });
  });

  test.each([
    { startDate: undefined, endDate: undefined },
    {
      startDate: new Date("2025-02-01T00:00:00.000Z"),
      endDate: new Date("2025-01-01T00:00:00.000Z"),
    },
  ])("pins an invalid custom range as non-filtering", (range) => {
    const item = makeFilterItem("kept");
    const { result } = renderHook(() => useTableFilters({ items: [item] }));

    act(() => {
      result.current.toggleHideCompletedItems();
      result.current.setDateFilter({
        field: DateFilterField.CreatedAt,
        preset: DatePreset.Custom,
        ...range,
      });
    });

    expect(result.current.isCustomRangeValid).toBe(false);
    // Pins current behavior; it looks odd because an invalid visible range is
    // retained as an active chip while its predicate deliberately passes rows.
    // Both halves are asserted on purpose: the chip is the user-visible half,
    // and without its assertion the chip could stop rendering with this test
    // still green on the predicate alone.
    expect(result.current.applyFilters([item])).toEqual([item]);
    expect(result.current.activeChips).toContainEqual({
      category: "date",
      label: "Created: Custom range",
    });
  });
});

describe("useTableFilters — date presets", () => {
  // Preset windows are computed from the wall clock, so the clock is pinned:
  // an unpinned run cannot place a fixture on a window edge. Pinning the
  // instant is not on its own enough for a case that names an exact edge —
  // `getDateRangeForPreset` walks the LOCAL calendar, so the zone decides
  // where that edge lands. Cases that assert one pin the zone too.
  const NOW = new Date("2026-05-15T12:00:00.000Z");
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test.each([
    [DatePreset.Last24h, 49],
    [DatePreset.Last7d, 8 * 24],
    [DatePreset.Last30d, 31 * 24],
    [DatePreset.Last3m, 120 * 24],
  ])("applies %s against the selected timestamp", (preset, oldHours) => {
    const now = Date.now();
    const recent = makeFilterItem("recent", {
      createdAt: new Date(now - 60 * 60 * 1000),
      updatedAt: new Date(now - 60 * 60 * 1000),
    });
    const old = makeFilterItem("old", {
      createdAt: new Date(now - oldHours * 60 * 60 * 1000),
      updatedAt: new Date(now - oldHours * 60 * 60 * 1000),
    });
    const { result } = renderHook(() =>
      useTableFilters({ items: [recent, old] })
    );

    act(() => {
      result.current.toggleHideCompletedItems();
      result.current.setDateFilter({
        field: DateFilterField.CreatedAt,
        preset,
      });
    });

    expect(result.current.applyFilters([recent, old])).toEqual([recent]);
    expect(result.current.activeChips).toContainEqual({
      category: "date",
      label: `Created: ${
        {
          [DatePreset.Last24h]: "Last 24 hours",
          [DatePreset.Last7d]: "Last 7 days",
          [DatePreset.Last30d]: "Last 30 days",
          [DatePreset.Last3m]: "Last 3 months",
        }[preset]
      }`,
    });
  });

  // These fixtures place the edge in fixed milliseconds, which equals the
  // production code's local-calendar step only in a zone with no offset change
  // inside the window — so the zone is pinned to UTC, the one zone where
  // `setDate(-N)` is always exactly N×24h. Africa/Cairo is the counterexample:
  // its spring transition falls inside the 30-day window ending mid-May, which
  // moves the start an hour and drops `atStart` out of the range. What DST does
  // to these windows is a separate question, pinned by the Last24h cases below.
  describe("window edges (UTC)", () => {
    pinZone("UTC");

    test.each([
      [DatePreset.Last24h, DAY_MS],
      [DatePreset.Last7d, 7 * DAY_MS],
      [DatePreset.Last30d, 30 * DAY_MS],
    ])(
      "keeps %s rows on both window edges and drops the ones outside",
      (preset, spanMs) => {
        const atStart = makeFilterItem("at-start", {
          createdAt: new Date(NOW.getTime() - spanMs),
        });
        const beforeStart = makeFilterItem("before-start", {
          createdAt: new Date(NOW.getTime() - spanMs - 1),
        });
        const atEnd = makeFilterItem("at-end", { createdAt: NOW });
        const afterEnd = makeFilterItem("after-end", {
          createdAt: new Date(NOW.getTime() + 1),
        });
        const items = [atStart, beforeStart, atEnd, afterEnd];

        const result = renderWithDatePreset(items, preset);

        expect(result.current.applyFilters(items)).toEqual([atStart, atEnd]);
      }
    );
  });

  // `setMonth(getMonth() - 3)` overflows whenever today's day-of-month does not
  // exist three months back: 2026-05-31 becomes 2026-02-31, which normalizes to
  // 2026-03-03, making the window 89 days rather than the 90+ its label implies.
  // Those are LOCAL date fields, so this case pins the zone as well as the
  // clock — at UTC+14 the same instant is already the 1st and no overflow
  // happens at all.
  describe("Last3m month-end overflow", () => {
    pinZone("UTC");

    beforeEach(() => {
      vi.setSystemTime(new Date("2026-05-31T12:00:00.000Z"));
    });

    // `excluded` is the row that tells an 89-day window from a flat 90-day one:
    // inside the latter, outside the former. Both fixtures sit 12h clear of the
    // real edge so neither rides on the boundary itself.
    test("ends the window at the overflowed date, not 90 days back", () => {
      const included = makeFilterItem("inside-89-day-window", {
        createdAt: new Date("2026-03-04T00:00:00.000Z"),
      });
      const excluded = makeFilterItem("inside-90-days-only", {
        createdAt: new Date("2026-03-03T00:00:00.000Z"),
      });
      const items = [included, excluded];

      const result = renderWithDatePreset(items, DatePreset.Last3m);

      expect(result.current.applyFilters(items)).toEqual([included]);
    });
  });

  // `setHours(getHours() - 24)` is local-calendar arithmetic, so on a DST
  // transition day the "Last 24 hours" window is 23 or 25 real hours. These two
  // cases pin that as it stands rather than assert it is right: whether the
  // preset should count elapsed time instead is an open product question, not
  // something this suite decides.
  describe("Last24h across a DST transition (America/Chicago)", () => {
    pinZone("America/Chicago");

    test("spans 23 real hours on the spring-forward day", () => {
      // 2026-03-08 02:00 local jumps to 03:00, so a window ending at noon CDT
      // starts at noon CST the previous day — 23 hours of real time earlier.
      vi.setSystemTime(new Date("2026-03-08T17:00:00.000Z"));
      const atEdge = makeFilterItem("23h-old-window-edge", {
        createdAt: new Date("2026-03-07T18:00:00.000Z"),
      });
      const exactly24hOld = makeFilterItem("24h-old", {
        createdAt: new Date("2026-03-07T17:00:00.000Z"),
      });
      const items = [atEdge, exactly24hOld];

      const result = renderWithDatePreset(items, DatePreset.Last24h);

      // A row exactly 24 real hours old sits OUTSIDE "Last 24 hours" here.
      expect(result.current.applyFilters(items)).toEqual([atEdge]);
    });

    test("spans 25 real hours on the fall-back day", () => {
      // 2026-11-01 01:00 local repeats, stretching the same window to 25 hours.
      vi.setSystemTime(new Date("2026-11-01T18:00:00.000Z"));
      const atEdge = makeFilterItem("25h-old-window-edge", {
        createdAt: new Date("2026-10-31T17:00:00.000Z"),
      });
      const justOutside = makeFilterItem("just-past-the-edge", {
        createdAt: new Date("2026-10-31T16:59:59.999Z"),
      });
      const items = [atEdge, justOutside];

      const result = renderWithDatePreset(items, DatePreset.Last24h);

      // A row 25 real hours old is still INSIDE "Last 24 hours" here.
      expect(result.current.applyFilters(items)).toEqual([atEdge]);
    });
  });
});

function renderWithDatePreset(items: DocumentRowItem[], preset: DatePreset) {
  const { result } = renderHook(() => useTableFilters({ items }));
  act(() => {
    result.current.toggleHideCompletedItems();
    result.current.setDateFilter({
      field: DateFilterField.CreatedAt,
      preset,
    });
  });
  return result;
}

/**
 * Pins the process time zone for a suite. Local-calendar date arithmetic in
 * `getDateRangeForPreset` reads whatever zone the runner happens to be in, so a
 * case whose expectation depends on the local calendar has to fix it.
 */
function pinZone(timeZone: string) {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    process.env.TZ = timeZone;
  });

  afterEach(() => {
    if (originalTz === undefined) {
      Reflect.deleteProperty(process.env, "TZ");
    } else {
      process.env.TZ = originalTz;
    }
  });
}
