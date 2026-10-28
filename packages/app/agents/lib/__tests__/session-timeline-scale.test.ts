import {
  clampTimelineWindowStart,
  defaultTimelineScale,
  followTimelineWindowStart,
  recentreWindowStartForScale,
  resolveTimelineColumnIndex,
  resolveTimelineScaleGeometry,
  resolveTimelineWindowEdges,
  SCALE_MINUTES,
  TIMELINE_SCALE_OPTIONS,
  TIMELINE_VISIBLE_COLUMNS,
  TimelineScale,
  timelineColumnStartMs,
} from "@repo/app/agents/lib/session-timeline-scale";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * These pin `defaultTimelineScale`/geometry/column-boundary behavior against a
 * fixed UTC clock. The module floors and steps columns using the LOCAL
 * timezone (see `floorToLocalColumnBoundary`/`timelineColumnStartMs`), so
 * without pinning `TZ` these assertions would depend on whatever zone the
 * test runner happens to be in. UTC has no DST, so every boundary here is
 * exactly where the fixed-width arithmetic says it is — DST-specific
 * behavior is covered separately in `session-timeline-dst.test.ts`.
 */
const originalTimezone = process.env.TZ;

beforeAll(() => {
  process.env.TZ = "UTC";
});

afterAll(() => {
  if (originalTimezone === undefined) {
    Reflect.deleteProperty(process.env, "TZ");
    return;
  }
  process.env.TZ = originalTimezone;
});

const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

describe("TimelineScale constants", () => {
  it("prints the toggle's own labels as values", () => {
    expect(TimelineScale.FiveMinutes).toBe("5m");
    expect(TimelineScale.FifteenMinutes).toBe("15m");
    expect(TimelineScale.OneHour).toBe("1h");
    expect(TimelineScale.TwelveHours).toBe("12h");
  });

  it("orders the toggle coarsening left to right", () => {
    expect(TIMELINE_SCALE_OPTIONS).toEqual([
      TimelineScale.FiveMinutes,
      TimelineScale.FifteenMinutes,
      TimelineScale.OneHour,
      TimelineScale.TwelveHours,
    ]);
  });

  it("maps every scale to its column width in minutes", () => {
    expect(SCALE_MINUTES).toEqual({
      "12h": 720,
      "15m": 15,
      "1h": 60,
      "5m": 5,
    });
  });

  it("fixes the window at 24 columns", () => {
    expect(TIMELINE_VISIBLE_COLUMNS).toBe(24);
  });
});

describe("defaultTimelineScale", () => {
  it("opens a short session at 5m", () => {
    const startMs = Date.UTC(2026, 0, 1, 9, 0, 0);
    const endMs = startMs + 30 * MIN_MS;
    expect(defaultTimelineScale({ endMs, startMs })).toBe(
      TimelineScale.FiveMinutes
    );
  });

  it("opens a 3h session at 15m once 5m needs more than 24 columns", () => {
    const startMs = Date.UTC(2026, 0, 1, 9, 0, 0);
    const endMs = startMs + 3 * HOUR_MS;
    expect(defaultTimelineScale({ endMs, startMs })).toBe(
      TimelineScale.FifteenMinutes
    );
  });

  it("opens a ~6h session starting mid-column at 1h", () => {
    // The module's own worked example: starting at 09:01 (not on a 5m/15m
    // boundary) means the floored origin absorbs an extra minute, so a
    // 6h-long run needs 25 fifteen-minute columns, not 24, and only 1h fits.
    const startMs = Date.UTC(2026, 0, 1, 9, 1, 0);
    const endMs = startMs + 6 * HOUR_MS + MIN_MS;
    expect(defaultTimelineScale({ endMs, startMs })).toBe(
      TimelineScale.OneHour
    );
  });

  it("opens a 30h session at 12h once 1h needs more than 24 columns", () => {
    const startMs = Date.UTC(2026, 0, 1, 9, 0, 0);
    const endMs = startMs + 30 * HOUR_MS;
    expect(defaultTimelineScale({ endMs, startMs })).toBe(
      TimelineScale.TwelveHours
    );
  });

  it("keeps 5m when a boundary-aligned session needs exactly 24 columns", () => {
    const startMs = Date.UTC(2026, 0, 1, 9, 0, 0);
    const endMs = startMs + 2 * HOUR_MS;
    expect(defaultTimelineScale({ endMs, startMs })).toBe(
      TimelineScale.FiveMinutes
    );
  });

  it("bumps to 15m when a boundary-aligned session is one ms past 24 columns", () => {
    const startMs = Date.UTC(2026, 0, 1, 9, 0, 0);
    const endMs = startMs + 2 * HOUR_MS + 1;
    expect(defaultTimelineScale({ endMs, startMs })).toBe(
      TimelineScale.FifteenMinutes
    );
  });

  it("falls back to 12h when even the coarsest scale needs scrubbing", () => {
    const startMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const endMs = startMs + 10 * 365 * 24 * HOUR_MS;
    const geometryAtTwelveHours = resolveTimelineScaleGeometry({
      endMs,
      scale: TimelineScale.TwelveHours,
      startMs,
    });
    // Confirms this exercises the trailing `return TimelineScale.TwelveHours`
    // fallback, not the in-loop early return for a fitting 12h geometry.
    expect(geometryAtTwelveHours.maxWindowStart).toBeGreaterThan(0);
    expect(defaultTimelineScale({ endMs, startMs })).toBe(
      TimelineScale.TwelveHours
    );
  });
});

describe("resolveTimelineScaleGeometry", () => {
  it("derives columnMs from the scale", () => {
    const startMs = Date.UTC(2026, 0, 1, 9, 0, 0);
    const endMs = startMs;
    expect(
      resolveTimelineScaleGeometry({
        endMs,
        scale: TimelineScale.FiveMinutes,
        startMs,
      }).columnMs
    ).toBe(5 * MIN_MS);
    expect(
      resolveTimelineScaleGeometry({
        endMs,
        scale: TimelineScale.FifteenMinutes,
        startMs,
      }).columnMs
    ).toBe(15 * MIN_MS);
    expect(
      resolveTimelineScaleGeometry({
        endMs,
        scale: TimelineScale.OneHour,
        startMs,
      }).columnMs
    ).toBe(HOUR_MS);
    expect(
      resolveTimelineScaleGeometry({
        endMs,
        scale: TimelineScale.TwelveHours,
        startMs,
      }).columnMs
    ).toBe(12 * HOUR_MS);
  });

  it("floors originMs to the scale's column boundary", () => {
    const startMs = Date.UTC(2026, 0, 1, 9, 37, 42, 123);
    const endMs = startMs;
    expect(
      resolveTimelineScaleGeometry({
        endMs,
        scale: TimelineScale.FiveMinutes,
        startMs,
      }).originMs
    ).toBe(Date.UTC(2026, 0, 1, 9, 35, 0, 0));
    expect(
      resolveTimelineScaleGeometry({
        endMs,
        scale: TimelineScale.FifteenMinutes,
        startMs,
      }).originMs
    ).toBe(Date.UTC(2026, 0, 1, 9, 30, 0, 0));
    expect(
      resolveTimelineScaleGeometry({
        endMs,
        scale: TimelineScale.OneHour,
        startMs,
      }).originMs
    ).toBe(Date.UTC(2026, 0, 1, 9, 0, 0, 0));
  });

  it("floors a 12h origin to local midnight or noon", () => {
    const morningMs = Date.UTC(2026, 0, 1, 9, 37, 42, 123);
    const afternoonMs = Date.UTC(2026, 0, 1, 14, 37, 42, 123);
    expect(
      resolveTimelineScaleGeometry({
        endMs: morningMs,
        scale: TimelineScale.TwelveHours,
        startMs: morningMs,
      }).originMs
    ).toBe(Date.UTC(2026, 0, 1, 0, 0, 0, 0));
    expect(
      resolveTimelineScaleGeometry({
        endMs: afternoonMs,
        scale: TimelineScale.TwelveHours,
        startMs: afternoonMs,
      }).originMs
    ).toBe(Date.UTC(2026, 0, 1, 12, 0, 0, 0));
  });

  it("always draws at least one column, even for a zero-length span", () => {
    const startMs = Date.UTC(2026, 0, 1, 9, 0, 0);
    const geometry = resolveTimelineScaleGeometry({
      endMs: startMs,
      scale: TimelineScale.FiveMinutes,
      startMs,
    });
    expect(geometry.totalColumns).toBe(1);
    expect(geometry.maxWindowStart).toBe(0);
  });

  it("computes maxWindowStart as totalColumns minus the visible width, floored at 0", () => {
    const startMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const endMs = startMs + 100 * 15 * MIN_MS;
    const geometry = resolveTimelineScaleGeometry({
      endMs,
      scale: TimelineScale.FifteenMinutes,
      startMs,
    });
    expect(geometry.totalColumns).toBe(100);
    expect(geometry.maxWindowStart).toBe(76);
  });
});

describe("clampTimelineWindowStart", () => {
  it("returns 0 for NaN", () => {
    expect(clampTimelineWindowStart(Number.NaN, 10)).toBe(0);
  });

  it("returns 0 for +/-Infinity", () => {
    expect(clampTimelineWindowStart(Number.POSITIVE_INFINITY, 10)).toBe(0);
    expect(clampTimelineWindowStart(Number.NEGATIVE_INFINITY, 10)).toBe(0);
  });

  it("floors a negative window start at 0", () => {
    expect(clampTimelineWindowStart(-5, 10)).toBe(0);
  });

  it("caps a window start beyond the max at the max", () => {
    expect(clampTimelineWindowStart(50, 10)).toBe(10);
  });

  it("rounds a fractional in-range value", () => {
    expect(clampTimelineWindowStart(5.4, 10)).toBe(5);
    expect(clampTimelineWindowStart(5.5, 10)).toBe(6);
  });

  it("collapses to 0 when maxWindowStart is 0", () => {
    expect(clampTimelineWindowStart(5, 0)).toBe(0);
  });
});

describe("followTimelineWindowStart", () => {
  it("pans left when the active column is before the window", () => {
    expect(
      followTimelineWindowStart({
        activeColumn: 3,
        currentWindowStart: 10,
        maxWindowStart: 100,
      })
    ).toBe(3);
  });

  it("pans right by the minimum needed when the active column is after the window", () => {
    expect(
      followTimelineWindowStart({
        activeColumn: 30,
        currentWindowStart: 0,
        maxWindowStart: 100,
      })
    ).toBe(7);
  });

  it("treats the column exactly at the window's far edge as out of view", () => {
    expect(
      followTimelineWindowStart({
        activeColumn: TIMELINE_VISIBLE_COLUMNS,
        currentWindowStart: 0,
        maxWindowStart: 100,
      })
    ).toBe(1);
  });

  it("leaves the window alone when the active column is already inside it", () => {
    expect(
      followTimelineWindowStart({
        activeColumn: 15,
        currentWindowStart: 5,
        maxWindowStart: 100,
      })
    ).toBe(5);
  });

  it("leaves the window alone when the active column equals the window start", () => {
    expect(
      followTimelineWindowStart({
        activeColumn: 5,
        currentWindowStart: 5,
        maxWindowStart: 100,
      })
    ).toBe(5);
  });

  it("clamps a rightward pan to maxWindowStart", () => {
    expect(
      followTimelineWindowStart({
        activeColumn: 1000,
        currentWindowStart: 0,
        maxWindowStart: 50,
      })
    ).toBe(50);
  });
});

describe("recentreWindowStartForScale", () => {
  const startMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  const endMs = startMs + 10 * 24 * HOUR_MS;

  it("re-centres the window on the same instant it was already centred on", () => {
    const visibleMidpointMs = startMs + 2 * HOUR_MS;
    expect(
      recentreWindowStartForScale({
        endMs,
        nextScale: TimelineScale.FiveMinutes,
        startMs,
        visibleMidpointMs,
      })
    ).toBe(12);
  });

  it("clamps the re-centred window at 0 near the start of the session", () => {
    expect(
      recentreWindowStartForScale({
        endMs,
        nextScale: TimelineScale.FiveMinutes,
        startMs,
        visibleMidpointMs: startMs,
      })
    ).toBe(0);
  });

  it("clamps the re-centred window at maxWindowStart near the end of the session", () => {
    expect(
      recentreWindowStartForScale({
        endMs,
        nextScale: TimelineScale.FiveMinutes,
        startMs,
        visibleMidpointMs: endMs,
      })
    ).toBe(2856);
  });
});

describe("timelineColumnStartMs", () => {
  it("steps a non-12h column by a fixed width from the origin", () => {
    const originMs = Date.UTC(2026, 0, 1, 9, 0, 0);
    expect(
      timelineColumnStartMs({
        columnIndex: 0,
        originMs,
        scale: TimelineScale.FifteenMinutes,
      })
    ).toBe(originMs);
    expect(
      timelineColumnStartMs({
        columnIndex: 3,
        originMs,
        scale: TimelineScale.FifteenMinutes,
      })
    ).toBe(originMs + 3 * 15 * MIN_MS);
  });

  it("steps a 12h column by local calendar arithmetic", () => {
    const originMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(
      timelineColumnStartMs({
        columnIndex: 1,
        originMs,
        scale: TimelineScale.TwelveHours,
      })
    ).toBe(Date.UTC(2026, 0, 1, 12, 0, 0));
    expect(
      timelineColumnStartMs({
        columnIndex: 2,
        originMs,
        scale: TimelineScale.TwelveHours,
      })
    ).toBe(Date.UTC(2026, 0, 2, 0, 0, 0));
    expect(
      timelineColumnStartMs({
        columnIndex: 3,
        originMs,
        scale: TimelineScale.TwelveHours,
      })
    ).toBe(Date.UTC(2026, 0, 2, 12, 0, 0));
  });
});

describe("resolveTimelineColumnIndex", () => {
  it("inverts timelineColumnStartMs below 12h", () => {
    const originMs = Date.UTC(2026, 0, 1, 9, 0, 0);
    for (const columnIndex of [0, 1, 5, 10]) {
      const boundaryMs = timelineColumnStartMs({
        columnIndex,
        originMs,
        scale: TimelineScale.FifteenMinutes,
      });
      expect(
        resolveTimelineColumnIndex({
          instantMs: boundaryMs,
          originMs,
          scale: TimelineScale.FifteenMinutes,
        })
      ).toBe(columnIndex);
      // An instant partway through the column still belongs to it.
      expect(
        resolveTimelineColumnIndex({
          instantMs: boundaryMs + MIN_MS,
          originMs,
          scale: TimelineScale.FifteenMinutes,
        })
      ).toBe(columnIndex);
    }
  });

  it("inverts timelineColumnStartMs at 12h", () => {
    const originMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    for (const columnIndex of [0, 1, 2, 3]) {
      const boundaryMs = timelineColumnStartMs({
        columnIndex,
        originMs,
        scale: TimelineScale.TwelveHours,
      });
      expect(
        resolveTimelineColumnIndex({
          instantMs: boundaryMs,
          originMs,
          scale: TimelineScale.TwelveHours,
        })
      ).toBe(columnIndex);
    }
  });

  it("returns 0 for a non-finite instant", () => {
    const originMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(
      resolveTimelineColumnIndex({
        instantMs: Number.NaN,
        originMs,
        scale: TimelineScale.OneHour,
      })
    ).toBe(0);
    expect(
      resolveTimelineColumnIndex({
        instantMs: Number.POSITIVE_INFINITY,
        originMs,
        scale: TimelineScale.OneHour,
      })
    ).toBe(0);
  });
});

describe("resolveTimelineWindowEdges", () => {
  it("returns TIMELINE_VISIBLE_COLUMNS + 1 edges", () => {
    const originMs = Date.UTC(2026, 0, 1, 9, 0, 0);
    const edges = resolveTimelineWindowEdges({
      originMs,
      scale: TimelineScale.FifteenMinutes,
      windowStart: 0,
    });
    expect(edges).toHaveLength(TIMELINE_VISIBLE_COLUMNS + 1);
  });

  it("pins the first and last edge to the window's real boundaries", () => {
    const originMs = Date.UTC(2026, 0, 1, 9, 0, 0);
    const windowStart = 2;
    const edges = resolveTimelineWindowEdges({
      originMs,
      scale: TimelineScale.FifteenMinutes,
      windowStart,
    });
    expect(edges[0]).toBe(originMs + windowStart * 15 * MIN_MS);
    expect(edges.at(-1)).toBe(
      originMs + (windowStart + TIMELINE_VISIBLE_COLUMNS) * 15 * MIN_MS
    );
  });

  it("returns strictly increasing edges", () => {
    const originMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const edges = resolveTimelineWindowEdges({
      originMs,
      scale: TimelineScale.TwelveHours,
      windowStart: 0,
    });
    for (let index = 1; index < edges.length; index += 1) {
      expect(edges[index]).toBeGreaterThan(edges[index - 1]);
    }
  });
});
