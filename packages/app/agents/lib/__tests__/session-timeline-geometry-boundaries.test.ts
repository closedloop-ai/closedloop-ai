import type { TurnItem } from "@repo/api/src/types/agent-session";
import { Harness } from "@repo/lib/harness/types";
import { describe, expect, it } from "vitest";
import {
  alignBucketRowsToTranscript,
  getLimitDotPercent,
  getTraceRowPercent,
  getTurnItemMs,
  resolveSessionTimelineWindow,
  type SessionTimelineWindow,
} from "../session-timeline-geometry";
import { createActivityBuckets } from "./session-timeline-geometry-fixtures";

const ACTOR = {
  color: "var(--primary)",
  harness: Harness.Claude,
  human: null,
  name: "claude-opus-4",
  sessionId: "geometry-boundaries",
};
const START_AT = "2026-08-07T12:00:00.000Z";
const END_AT = "2026-08-07T12:01:40.000Z";
const START_MS = Date.parse(START_AT);
const END_MS = Date.parse(END_AT);
const WINDOW: SessionTimelineWindow = { endMs: END_MS, startMs: START_MS };

describe("session timeline row boundaries", () => {
  it.each([
    undefined,
    null,
  ])("uses lifecycle bounds when transcript rows are %s", (turnItems) => {
    expect(
      resolveSessionTimelineWindow({
        endedAt: END_AT,
        startedAt: START_AT,
        turnItems,
      })
    ).toEqual(WINDOW);
  });

  it("ignores rowless and invalid-time items when resolving plotted bounds", () => {
    expect(
      resolveSessionTimelineWindow({
        endedAt: END_AT,
        startedAt: START_AT,
        turnItems: [
          sessionStart("2026-08-07T11:00:00.000Z"),
          prompt(10, "not-a-date", Number.NaN),
        ],
      })
    ).toEqual(WINDOW);
  });

  it("returns no window when neither plotted rows nor lifecycle bounds are usable", () => {
    expect(
      resolveSessionTimelineWindow({
        endedAt: "invalid",
        startedAt: null,
        turnItems: [
          prompt(10, "invalid", Number.NaN),
          { type: "idle", gap: 1 },
        ],
      })
    ).toBeNull();
  });

  it("prefers a numeric tMs and otherwise parses the string timestamp", () => {
    const stringTimestamp = "2026-08-07T13:00:00.000Z";

    expect(getTurnItemMs(prompt(10, stringTimestamp, START_MS))).toBe(START_MS);
    expect(getTurnItemMs(sessionStart(stringTimestamp))).toBe(
      Date.parse(stringTimestamp)
    );
  });

  it("falls back to trace-row ordinal when the timestamp is invalid", () => {
    const session = {
      turnItems: [
        sessionStart(START_AT),
        prompt(10, START_AT),
        { type: "idle", gap: 5 } as const,
        prompt(30, "2026-08-07T12:00:50.000Z"),
        prompt(50, END_AT),
      ],
    };

    expect(getLimitDotPercent(WINDOW, session, "invalid", 25)).toBe(50);
    expect(getTraceRowPercent(session, 51)).toBe(100);
  });
});

describe("alignBucketRowsToTranscript repair boundaries", () => {
  it("is a reference-preserving no-op without timed rows", () => {
    // ISS-5124: the no-op (identity-return) path requires all buckets to
    // already be idle (`tl0 === null`). Active buckets (`tl0: 999`) are now
    // demoted rather than passed through — that is the ISS-5124 fix.
    const buckets = createActivityBuckets(2).map((b) => ({
      ...b,
      tl0: null,
    }));

    expect(
      alignBucketRowsToTranscript(
        buckets,
        { turnItems: [sessionStart(START_AT), { type: "end", text: "done" }] },
        WINDOW
      )
    ).toBe(buckets);
  });

  it("repairs a leading jump target to the earliest transcript row while retaining idle buckets", () => {
    const buckets = createActivityBuckets(3);
    buckets[0].tl0 = null;

    const aligned = alignBucketRowsToTranscript(
      buckets,
      { turnItems: [prompt(40, START_AT), prompt(90, END_AT)] },
      WINDOW
    );

    expect(aligned.map((bucket) => bucket.tl0)).toEqual([null, 40, 90]);
    expect(aligned[0]).toBe(buckets[0]);
  });

  it("carries the nearest preceding row through empty bucket slices", () => {
    const aligned = alignBucketRowsToTranscript(
      createActivityBuckets(4),
      {
        turnItems: [
          prompt(10, START_AT),
          prompt(30, "2026-08-07T12:01:15.000Z"),
          prompt(40, END_AT),
        ],
      },
      WINDOW
    );

    expect(aligned.map((bucket) => bucket.tl0)).toEqual([10, 10, 10, 30]);
  });
});

function prompt(
  row: number,
  time: string,
  timeMs = Date.parse(time)
): TurnItem {
  return {
    _row: row,
    actor: ACTOR,
    cum: 0,
    t: time,
    tMs: timeMs,
    text: `row ${row}`,
    type: "prompt",
  };
}

function sessionStart(time: string): TurnItem {
  return { actor: ACTOR, t: time, type: "sessionstart" };
}
