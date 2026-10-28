import {
  TIMELINE_SCALE_OPTIONS,
  TimelineScale,
} from "@repo/app/agents/lib/session-timeline-scale";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  makeBranchDetail,
  makeBranchSession,
} from "../../__tests__/branch-fixtures";
import { buildActorColorDomain } from "../branch-actor-domain";
import {
  BranchTimelineGrouping,
  buildSessionTimeline,
  MAX_TIMELINE_DAYS,
} from "../branch-session-buckets";

/**
 * ISS-8771 — the Branch trace on the SAME window/grid contract as the Session
 * trace (`packages/app/agents/lib/session-timeline-scale.ts`).
 *
 * WHAT THESE CASES CATCH. The Branch timeline used to floor every column with
 * `Math.floor(ms / columnMs) * columnMs` and step it with `+= columnMs`. Both
 * are UTC arithmetic — the epoch's own zero is UTC midnight — under an axis
 * whose labels are rendered on the VIEWER's clock by `formatClock`. So a `12h`
 * column began at UTC midnight while announcing local noon, and a fixed step
 * walked straight through a DST transition the label had already crossed. The
 * timezone cases below are red under that arithmetic and green on the canonical
 * grid.
 *
 * `24` is written as a literal throughout rather than imported from
 * `TIMELINE_VISIBLE_COLUMNS`. A fixture that reads its expectation from the
 * constant it guards cannot fail when that constant moves, which is the one
 * thing these cases exist to prevent.
 */

const EASTERN = "America/New_York";
/** +05:30 — the offset that makes a UTC hour grid visibly not on the hour. */
const KOLKATA = "Asia/Kolkata";
const HOUR_MS = 3_600_000;
const originalTimezone = process.env.TZ;

function timelineOf(
  detail: ReturnType<typeof makeBranchDetail>,
  options: { scale?: TimelineScale; windowStart?: number } = {}
) {
  return buildSessionTimeline(
    detail,
    buildActorColorDomain(
      detail.sessions.map((session) => session.ownerUserId ?? null)
    ),
    BranchTimelineGrouping.SessionOwner,
    { windowStart: 0, ...options }
  );
}

/** A branch whose activity is far wider than 24 columns at every scale. */
function longRunningBranch(over: { startedAt: string; endedAt: string }) {
  return makeBranchDetail({
    estimatedCostUsd: 120,
    sessions: [
      makeBranchSession({
        sessionId: "long",
        estimatedCostUsd: 120,
        ownerUserId: "u1",
        ownerUserName: "Cosimo",
        ...over,
      }),
    ],
  });
}

afterAll(() => {
  if (originalTimezone === undefined) {
    Reflect.deleteProperty(process.env, "TZ");
    return;
  }
  process.env.TZ = originalTimezone;
});

describe("every supported scale renders exactly 24 visible buckets", () => {
  const detail = longRunningBranch({
    endedAt: "2026-07-01T00:00:00.000Z",
    startedAt: "2026-06-01T00:00:00.000Z",
  });

  for (const scale of TIMELINE_SCALE_OPTIONS) {
    it(`renders 24 columns at ${scale}`, () => {
      const timeline = timelineOf(detail, { scale });

      expect(timeline.columns).toHaveLength(24);
      // The window is a VIEWPORT over a much longer span, which is what makes
      // "24" a fixed bar width rather than an accident of this fixture.
      expect(timeline.totalColumns).toBeGreaterThan(24);
      expect(timeline.maxWindowStart).toBe(timeline.totalColumns - 24);
    });
  }

  it("still renders 24 after the scrubber pans to the far end", () => {
    const timeline = timelineOf(detail, {
      scale: TimelineScale.FifteenMinutes,
      windowStart: Number.MAX_SAFE_INTEGER,
    });

    expect(timeline.columns).toHaveLength(24);
    expect(timeline.windowStart).toBe(timeline.maxWindowStart);
  });
});

describe("awkward spans keep the window contract", () => {
  it("keeps 24 columns for a span that ends mid-column", () => {
    const timeline = timelineOf(
      longRunningBranch({
        // 25 hours and 7 minutes — neither a whole number of `1h` columns nor
        // aligned to the clock boundary the origin is floored to.
        endedAt: "2026-06-02T02:07:00.000Z",
        startedAt: "2026-06-01T01:00:00.000Z",
      }),
      { scale: TimelineScale.OneHour }
    );

    expect(timeline.columns).toHaveLength(24);
    expect(timeline.totalColumns).toBe(26);
  });

  it("draws one column for a span shorter than a single column", () => {
    const timeline = timelineOf(
      longRunningBranch({
        endedAt: "2026-06-01T10:00:30.000Z",
        startedAt: "2026-06-01T10:00:00.000Z",
      }),
      { scale: TimelineScale.OneHour }
    );

    // The window cannot exceed the span the branch has evidence for: a Branch
    // column carries no coverage channel, so a 24-column viewport here would
    // assert 23 measured-quiet hours nobody looked at.
    expect(timeline.columns).toHaveLength(1);
    expect(timeline.totalColumns).toBe(1);
    expect(timeline.maxWindowStart).toBe(0);
  });
});

describe("columns land on the VIEWER's clock, not the epoch's", () => {
  beforeAll(() => {
    process.env.TZ = KOLKATA;
  });

  it("starts a 1h column on the local hour in a half-hour-offset zone", () => {
    const timeline = timelineOf(
      longRunningBranch({
        endedAt: "2026-06-01T14:00:00.000Z",
        startedAt: "2026-06-01T10:20:00.000Z",
      }),
      { scale: TimelineScale.OneHour }
    );
    const firstColumn = new Date(timeline.columns[0]?.hourStart ?? "");

    // UTC flooring lands on :30 past the local hour in +05:30 and stays there
    // for the whole axis, under labels that say otherwise.
    expect(firstColumn.getMinutes()).toBe(0);
    expect(firstColumn.getSeconds()).toBe(0);
    for (const column of timeline.columns) {
      expect(new Date(column.hourStart).getMinutes()).toBe(0);
    }
  });

  it("starts a 12h column on local midnight or noon", () => {
    const timeline = timelineOf(
      longRunningBranch({
        endedAt: "2026-06-05T00:00:00.000Z",
        startedAt: "2026-06-01T10:20:00.000Z",
      }),
      { scale: TimelineScale.TwelveHours }
    );

    for (const column of timeline.columns) {
      const local = new Date(column.hourStart);
      expect([0, 12]).toContain(local.getHours());
      expect(local.getMinutes()).toBe(0);
    }
  });
});

describe("a 12h column that swallows a DST transition is not 12 real hours", () => {
  beforeAll(() => {
    process.env.TZ = EASTERN;
  });

  it("keeps the boundary after spring-forward on local noon", () => {
    // 8 March 2026 is the spring-forward day in America/New_York: 02:00 does
    // not exist, so the local morning is 11 real hours long.
    const startMs = new Date(2026, 2, 8, 0, 30).getTime();
    const timeline = timelineOf(
      longRunningBranch({
        endedAt: new Date(startMs + 4 * 24 * HOUR_MS).toISOString(),
        startedAt: new Date(startMs).toISOString(),
      }),
      { scale: TimelineScale.TwelveHours }
    );
    const first = Date.parse(timeline.columns[0]?.hourStart ?? "");
    const second = Date.parse(timeline.columns[1]?.hourStart ?? "");

    expect(new Date(first).getHours()).toBe(0);
    expect(new Date(second).getHours()).toBe(12);
    // A fixed `+= columnMs` step made this 12 hours and put the label on 11:00.
    expect(second - first).toBe(11 * HOUR_MS);
  });
});

describe("the 90-day span cap bounds the SPAN, not the window", () => {
  it("caps an outlier far-future end instead of allocating unbounded columns", () => {
    const timeline = timelineOf(
      longRunningBranch({
        endedAt: "9999-01-01T00:00:00.000Z",
        startedAt: "2026-06-10T10:00:00.000Z",
      }),
      { scale: TimelineScale.OneHour }
    );
    const maxHours = 24 * 90;

    // The cap is the span the scrubber pans across; the viewport stays 24. This
    // used to read `columns` because the un-windowed derivation returned every
    // column — that mode is gone (ISS-8771), so the cap is asserted where it
    // now lives rather than dropped.
    expect(timeline.totalColumns).toBe(maxHours);
    expect(timeline.columns).toHaveLength(24);
    expect(timeline.fullStartMs).toBe(Date.parse("2026-06-10T10:00:00.000Z"));
    expect(timeline.fullEndMs).toBe(
      (timeline.fullStartMs ?? 0) + maxHours * HOUR_MS
    );
  });

  it("keeps the clamped Session's whole spend reachable and marks it truncated", () => {
    const detail = longRunningBranch({
      endedAt: "2026-04-11T10:00:00.000Z",
      startedAt: "2026-01-01T10:00:00.000Z",
    });
    const timeline = timelineOf(detail, { scale: TimelineScale.OneHour });
    const reached = new Map<string, number>();
    for (let start = 0; start <= timeline.maxWindowStart; start += 24) {
      for (const column of timelineOf(detail, {
        scale: TimelineScale.OneHour,
        windowStart: start,
      }).columns) {
        reached.set(column.hourStart, column.total);
      }
    }

    expect(timeline.totalColumns).toBe(24 * 90);
    expect(timeline.columns).toHaveLength(24);
    // The session runs 100 days at $120; the 90-day cap charts 90 of them.
    expect(timeline.chartableCostUsd).toBeCloseTo(120 * (90 / 100));
    expect(
      [...reached.values()].reduce((sum, total) => sum + total, 0)
    ).toBeCloseTo(timeline.chartableCostUsd ?? 0);
    expect(
      timeline.truncatedSessions.map((session) => session.sessionId)
    ).toEqual(["long"]);
  });
});

describe("the span cap counts CANONICAL columns, not nominal ones", () => {
  beforeAll(() => {
    process.env.TZ = EASTERN;
  });

  it("keeps the final 12h column of a run exactly as long as the cap allows", () => {
    // Exactly `MAX_TIMELINE_DAYS` of REAL time from local midnight, crossing the
    // 8 March 2026 spring-forward. A `12h` column is a local HALF-DAY, so 90 real
    // days here span 181 half-days, not 180: the transition gives one of them 11
    // real hours. `Math.floor(MAX_TIMELINE_SPAN_MS / columnMs)` answered 180 —
    // nominal width against a variable-width grid — and cost the run its last
    // column, then reported it truncated at precisely the length the disclosure
    // says fits (#6566 review, whitlockk).
    const startMs = new Date(2026, 1, 1, 0, 0, 0, 0).getTime();
    const endMs = startMs + MAX_TIMELINE_DAYS * 24 * HOUR_MS;
    const timeline = timelineOf(
      longRunningBranch({
        endedAt: new Date(endMs).toISOString(),
        startedAt: new Date(startMs).toISOString(),
      }),
      { scale: TimelineScale.TwelveHours }
    );

    expect(timeline.totalColumns).toBe(181);
    // …and the grid still reaches the run's real end rather than stopping short.
    expect(timeline.fullEndMs ?? 0).toBeGreaterThanOrEqual(endMs);
  });

  it("does not report a run truncated at exactly the span the cap allows", () => {
    // The user-visible half of the same defect, asserted on its own so the
    // disclosure cannot regress behind a still-green column count: the timeline
    // told the reader this Session's activity ran past the rendered span while
    // the Session ended inside it.
    const startMs = new Date(2026, 1, 1, 0, 0, 0, 0).getTime();
    const timeline = timelineOf(
      longRunningBranch({
        endedAt: new Date(
          startMs + MAX_TIMELINE_DAYS * 24 * HOUR_MS
        ).toISOString(),
        startedAt: new Date(startMs).toISOString(),
      }),
      { scale: TimelineScale.TwelveHours }
    );

    expect(timeline.truncatedSessions).toEqual([]);
  });

  it("still refuses more than the capped span for a far-future outlier", () => {
    const timeline = timelineOf(
      longRunningBranch({
        endedAt: "9999-01-01T00:00:00.000Z",
        startedAt: "2026-02-01T00:00:00.000Z",
      }),
      { scale: TimelineScale.TwelveHours }
    );

    // The cap still BOUNDS: a corrupt end cannot buy more than the local
    // half-days `MAX_TIMELINE_DAYS` of real time actually contains.
    expect(timeline.totalColumns).toBeLessThanOrEqual(
      2 * MAX_TIMELINE_DAYS + 1
    );
    expect(timeline.columns).toHaveLength(24);
  });
});

describe("the projection never truncates the event population", () => {
  it("reaches every costed column by scrubbing, and the total reconciles", () => {
    const detail = longRunningBranch({
      endedAt: "2026-06-04T00:00:00.000Z",
      startedAt: "2026-06-01T00:00:00.000Z",
    });
    const reached = new Map<string, number>();
    const probe = timelineOf(detail, { scale: TimelineScale.OneHour });
    for (let start = 0; start <= probe.maxWindowStart; start += 1) {
      for (const column of timelineOf(detail, {
        scale: TimelineScale.OneHour,
        windowStart: start,
      }).columns) {
        reached.set(column.hourStart, column.total);
      }
    }

    // Every column of the full span is reachable — not merely "the totals add
    // up", which a projection that dropped a column and inflated its neighbour
    // would also satisfy.
    expect(reached.size).toBe(probe.totalColumns);
    expect(
      [...reached.values()].reduce((sum, total) => sum + total, 0)
    ).toBeCloseTo(probe.chartableCostUsd ?? 0);
    expect(probe.chartableCostUsd).toBeCloseTo(120);
  });
});
