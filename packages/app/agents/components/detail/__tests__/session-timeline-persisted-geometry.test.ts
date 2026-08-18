import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import {
  buildActivityMarkers,
  buildLimitDotEvents,
} from "../agent-session-detail-view";

/**
 * ISS-4821 review (wongk, codex): PERSISTED timeline geometry did not follow the
 * resolved window.
 *
 * `SessionMarker.x` and `SessionThrottle.x0` are fractions the PRODUCER computed
 * over the producer's own window (`startedAt → resolvePresentationEndMs`), and
 * that window is not in the detail DTO. So once the screen resolves a different
 * window — which is the entire point of ISS-4833 — keeping those fractions
 * relabels the axis while leaving the dots where they were: events still crowd
 * an edge despite the fix.
 *
 * The two producers preserve different things, so the rebasing has two paths and
 * one honest fallback, and each is pinned below.
 */

const WINDOW_START_AT = "2026-06-10T09:00:00.000Z";
const WINDOW_MID_AT = "2026-06-10T10:00:00.000Z";
const WINDOW_END_AT = "2026-06-10T11:00:00.000Z";
const WINDOW = {
  endMs: Date.parse(WINDOW_END_AT),
  startMs: Date.parse(WINDOW_START_AT),
};
/** A fraction no rebasing could produce, so a passthrough is unmistakable. */
const PRODUCER_PERCENT = 7;

function sessionWith(
  overrides: Partial<AgentSessionDetail>
): AgentSessionDetail {
  return { ...createAgentSessionDetailFixture(), ...overrides };
}

describe("persisted throttle dots follow the resolved window (wongk review)", () => {
  it("rebases an explicit throttle from its absolute t0 instead of keeping the producer's x0", () => {
    const dots = buildLimitDotEvents(
      sessionWith({
        throttles: [
          {
            durMin: 5,
            tl: 0,
            t0: WINDOW_MID_AT,
            t1: WINDOW_END_AT,
            x0: PRODUCER_PERCENT,
          },
        ],
      }),
      WINDOW
    );

    expect(dots).toHaveLength(1);
    // The midpoint of the window, not the producer's 7%.
    expect(dots[0].x).toBeCloseTo(50, 5);
  });

  it("keeps the producer's x0 when the session resolves no window at all", () => {
    const dots = buildLimitDotEvents(
      sessionWith({
        throttles: [
          {
            durMin: 5,
            tl: 0,
            t0: WINDOW_MID_AT,
            t1: WINDOW_END_AT,
            x0: PRODUCER_PERCENT,
          },
        ],
      }),
      // No usable bound anywhere, so every stored fraction renders verbatim
      // rather than having a coordinate fabricated for it.
      null
    );

    expect(dots[0].x).toBe(PRODUCER_PERCENT);
  });

  it("keeps the producer's x0 when the throttle carries no parseable instant", () => {
    const dots = buildLimitDotEvents(
      sessionWith({
        throttles: [
          {
            durMin: 5,
            tl: 0,
            t0: "not-a-timestamp",
            t1: "not-a-timestamp",
            x0: PRODUCER_PERCENT,
          },
        ],
      }),
      WINDOW
    );

    expect(dots[0].x).toBe(PRODUCER_PERCENT);
  });
});

describe("persisted markers follow the resolved window (wongk / codex review)", () => {
  it("rebases a cloud marker from its absolute t (deriveCorrectionMarkers writes source.observedAt)", () => {
    const markers = buildActivityMarkers(
      sessionWith({
        markers: [
          {
            kind: "commit",
            label: "seed",
            t: WINDOW_MID_AT,
            tl: 0,
            x: PRODUCER_PERCENT,
          },
        ],
      }),
      WINDOW
    );

    expect(markers).toHaveLength(1);
    expect(markers[0].x).toBeCloseTo(50, 5);
  });

  it("rebases a DESKTOP marker — whose t is a relative clock offset — from its transcript row's instant", () => {
    // `buildTraceMarkers` (apps/desktop/src/main/database/session-trace.ts)
    // writes `t: formatTraceClockOffset(rowMs - startMs)`, e.g. "1:00:00". There
    // is no absolute instant on the marker, but its re-anchored transcript row
    // has one, and that row is what the dot is supposed to point at.
    const rowAt = WINDOW_MID_AT;
    const markers = buildActivityMarkers(
      sessionWith({
        markers: [
          {
            kind: "commit",
            label: "seed",
            t: "1:00:00",
            tl: 4,
            x: PRODUCER_PERCENT,
          },
        ],
        turnItems: [
          {
            _row: 4,
            actor: {
              color: "var(--primary)",
              harness: "codex",
              human: null,
              name: "gpt-5.5",
              sessionId: "persisted-geometry",
            },
            cum: 0,
            t: rowAt,
            tMs: Date.parse(rowAt),
            text: "turn 4",
            type: "prompt",
          },
        ],
      }),
      WINDOW
    );

    expect(markers[0].x).toBeCloseTo(50, 5);
  });

  it("keeps the stored fraction when the session resolves no window at all", () => {
    const markers = buildActivityMarkers(
      sessionWith({
        markers: [
          {
            kind: "commit",
            label: "seed",
            t: WINDOW_MID_AT,
            tl: 0,
            x: PRODUCER_PERCENT,
          },
        ],
      }),
      null
    );

    expect(markers[0].x).toBe(PRODUCER_PERCENT);
  });

  it("keeps the stored fraction when neither an instant nor a timed row is available", () => {
    // The version-skew floor: an older payload renders exactly as it does today
    // rather than having a coordinate fabricated for it.
    const markers = buildActivityMarkers(
      sessionWith({
        markers: [
          {
            kind: "commit",
            label: "seed",
            t: "1:00:00",
            tl: 999,
            x: PRODUCER_PERCENT,
          },
        ],
        turnItems: [],
      }),
      WINDOW
    );

    expect(markers[0].x).toBe(PRODUCER_PERCENT);
  });
});
