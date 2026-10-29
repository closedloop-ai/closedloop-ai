/**
 * @file lane-stall-clock.test.ts
 * @description ISS-8615 (PRD-699 §7.3): the shared lane-stall clock SHAPE.
 *
 * Every expectation is an independently-written literal. The ladder rungs are
 * spelled in minutes-as-milliseconds rather than recomputed with the rung
 * formula, because a test that re-derives the formula stays green for every
 * value the formula gets wrong.
 *
 * No fake timers: `nowMs` is an argument on every function here, so each case
 * pins its own instant. The clock only becomes real at the production wiring,
 * which `lane-environmental-defer.test.ts` covers.
 */
import { describe, expect, it } from "vitest";
import { SESSION_LANE_STALL_CEILING_MS } from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import { TRANSCRIPT_LANE_STALL_CEILING_MS } from "../src/main/transcript-sync/transcript-sync-types.js";
import {
  DEFAULT_LANE_STALL_SCHEDULE,
  LANE_STALL_CEILING_MS,
  LANE_STALL_MAX_RETRY_MS,
  LANE_STALL_RETRY_FLOOR_MS,
  laneStallDelayMs,
  laneStallRetryMs,
  laneStallWindow,
} from "../src/shared/lane-stall-clock.js";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const NOW_MS = 1_800_000_000_000;

describe("the shared constants", () => {
  it("pins the ceiling, floor, and per-delay cap to their standard values", () => {
    expect(LANE_STALL_CEILING_MS).toBe(86_400_000);
    expect(LANE_STALL_RETRY_FLOOR_MS).toBe(300_000);
    expect(LANE_STALL_MAX_RETRY_MS).toBe(3_600_000);
  });

  it("gives both durable lanes the SAME ceiling, by construction", () => {
    // `main/sync/AGENTS.md`: two lanes measuring the same outage must not
    // disagree about when to give up. Each is asserted against the literal
    // rather than against the other, so a change to one is a red line here even
    // if someone changes both.
    expect(SESSION_LANE_STALL_CEILING_MS).toBe(86_400_000);
    expect(TRANSCRIPT_LANE_STALL_CEILING_MS).toBe(86_400_000);
  });

  it("defaults a lane to that ceiling, floor, and cap", () => {
    expect(DEFAULT_LANE_STALL_SCHEDULE.ceilingMs).toBe(86_400_000);
    expect(DEFAULT_LANE_STALL_SCHEDULE.floorMs).toBe(300_000);
    expect(DEFAULT_LANE_STALL_SCHEDULE.maxRetryMs).toBe(3_600_000);
  });
});

describe("laneStallRetryMs — the staged ladder off the run clock", () => {
  it("stages 5 → 10 → 20 → 40 → 60 minutes as the run ages", () => {
    expect(laneStallRetryMs(0)).toBe(5 * MINUTE_MS);
    expect(laneStallRetryMs(5 * MINUTE_MS)).toBe(10 * MINUTE_MS);
    expect(laneStallRetryMs(15 * MINUTE_MS)).toBe(20 * MINUTE_MS);
    expect(laneStallRetryMs(35 * MINUTE_MS)).toBe(40 * MINUTE_MS);
    expect(laneStallRetryMs(75 * MINUTE_MS)).toBe(60 * MINUTE_MS);
  });

  it("holds each rung until the run has actually earned the next one", () => {
    expect(laneStallRetryMs(5 * MINUTE_MS - 1)).toBe(5 * MINUTE_MS);
    expect(laneStallRetryMs(15 * MINUTE_MS - 1)).toBe(10 * MINUTE_MS);
  });

  it("pins at the per-delay cap and never exceeds it, even after a day", () => {
    expect(laneStallRetryMs(DAY_MS)).toBe(60 * MINUTE_MS);
    expect(laneStallRetryMs(DAY_MS * 400)).toBe(60 * MINUTE_MS);
  });

  it("reads an unusable age as a FRESH stall and gives it the floor", () => {
    // A clock we cannot subtract is not evidence that anything should wait
    // longer. The positive sibling above is what proves the ladder does move.
    for (const unusable of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(laneStallRetryMs(unusable)).toBe(5 * MINUTE_MS);
    }
  });

  it("honors a lane's own floor and cap when it states one", () => {
    const brisk = { floorMs: 1000, maxRetryMs: 4000, ceilingMs: DAY_MS };
    expect(laneStallRetryMs(0, brisk)).toBe(1000);
    expect(laneStallRetryMs(1000, brisk)).toBe(2000);
    expect(laneStallRetryMs(3000, brisk)).toBe(4000);
    expect(laneStallRetryMs(DAY_MS, brisk)).toBe(4000);
  });
});

describe("laneStallWindow — start, clear, and ceiling", () => {
  it("OPENS a run at now when there is none on record", () => {
    const window = laneStallWindow({ stalledSinceMs: null, nowMs: NOW_MS });
    expect(window.startedAtMs).toBe(NOW_MS);
    expect(window.elapsedMs).toBe(0);
    expect(window.expired).toBe(false);
    expect(window.opened).toBe(true);
  });

  it("CONTINUES an existing run from its original origin", () => {
    const window = laneStallWindow({
      stalledSinceMs: NOW_MS - 90 * MINUTE_MS,
      nowMs: NOW_MS,
    });
    expect(window.startedAtMs).toBe(NOW_MS - 90 * MINUTE_MS);
    expect(window.elapsedMs).toBe(90 * MINUTE_MS);
    expect(window.opened).toBe(false);
  });

  it("expires at the ceiling and not one millisecond before it", () => {
    expect(
      laneStallWindow({ stalledSinceMs: NOW_MS - DAY_MS, nowMs: NOW_MS })
        .expired
    ).toBe(true);
    expect(
      laneStallWindow({ stalledSinceMs: NOW_MS - DAY_MS + 1, nowMs: NOW_MS })
        .expired
    ).toBe(false);
  });

  it("opens a fresh run on an UNREADABLE origin rather than expiring one", () => {
    const window = laneStallWindow({
      stalledSinceMs: Number.NaN,
      nowMs: NOW_MS,
    });
    expect(window.startedAtMs).toBe(NOW_MS);
    expect(window.expired).toBe(false);
    expect(window.opened).toBe(true);
  });

  it("clamps a FUTURE origin to now, keeping the ceiling reachable", () => {
    const window = laneStallWindow({
      stalledSinceMs: NOW_MS + DAY_MS * 365,
      nowMs: NOW_MS,
    });
    expect(window.startedAtMs).toBe(NOW_MS);
    expect(window.elapsedMs).toBe(0);
    // `opened` stays false: the row HAD a run on record, it was just unusable,
    // so a caller can still tell "no clock" from "a clock I had to repair".
    expect(window.opened).toBe(false);
  });
});

describe("laneStallDelayMs — scheduling one attempt", () => {
  it("uses the staged rung when the server asked for nothing", () => {
    expect(
      laneStallDelayMs({
        stalledSinceMs: NOW_MS - 20 * MINUTE_MS,
        nowMs: NOW_MS,
      })
    ).toBe(20 * MINUTE_MS);
  });

  it("honors Retry-After as a MINIMUM, never as a replacement", () => {
    const stalledSinceMs = NOW_MS - 20 * MINUTE_MS;
    // Longer than the rung: the server wins.
    expect(
      laneStallDelayMs({
        stalledSinceMs,
        nowMs: NOW_MS,
        retryAfterMs: 45 * MINUTE_MS,
      })
    ).toBe(45 * MINUTE_MS);
    // Shorter than the rung: the ladder wins. A `min` here would let a
    // transient 60s hint pin the schedule to its opening rung forever.
    expect(
      laneStallDelayMs({
        stalledSinceMs,
        nowMs: NOW_MS,
        retryAfterMs: MINUTE_MS,
      })
    ).toBe(20 * MINUTE_MS);
  });

  it("caps the next attempt by what is LEFT of the run, while budget remains", () => {
    // 10 minutes left of the day; the rung would have asked for an hour.
    expect(
      laneStallDelayMs({
        stalledSinceMs: NOW_MS - DAY_MS + 10 * MINUTE_MS,
        nowMs: NOW_MS,
      })
    ).toBe(10 * MINUTE_MS);
  });

  it("stops capping once the budget is SPENT, instead of retrying every tick", () => {
    // Past the ceiling the terminal is ack-gated, so a zero here would be a hot
    // loop in exactly the outage where the ack is least likely to land.
    expect(
      laneStallDelayMs({
        stalledSinceMs: NOW_MS - DAY_MS - MINUTE_MS,
        nowMs: NOW_MS,
      })
    ).toBe(60 * MINUTE_MS);
  });

  it("clamps a Retry-After longer than the whole run to the ceiling", () => {
    expect(
      laneStallDelayMs({
        stalledSinceMs: NOW_MS,
        nowMs: NOW_MS,
        retryAfterMs: DAY_MS * 30,
      })
    ).toBe(DAY_MS);
  });

  it("ignores an unreadable Retry-After rather than scheduling on it", () => {
    expect(
      laneStallDelayMs({
        stalledSinceMs: NOW_MS,
        nowMs: NOW_MS,
        retryAfterMs: Number.NaN,
      })
    ).toBe(5 * MINUTE_MS);
    expect(
      laneStallDelayMs({
        stalledSinceMs: NOW_MS,
        nowMs: NOW_MS,
        retryAfterMs: -1,
      })
    ).toBe(5 * MINUTE_MS);
  });
});
