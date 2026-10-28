import type {
  AgentSessionDetail,
  SessionMarker,
} from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import {
  buildActivityMarkers,
  buildLimitDotEvents,
} from "../session-activity-markers";
import { buildDotCells } from "../session-timeline-dot-cells";

/**
 * ISS-4821 review (whitlockk, codex): PERSISTED timeline geometry did not follow the
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

describe("persisted throttle dots follow the resolved window (whitlockk review)", () => {
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

/**
 * ISS-8653: a limit dot carries its ABSOLUTE instant, so the dot rail has a key
 * commensurable with the `atMs` `buildTurnMarker` already attaches.
 *
 * ATTACHED ONLY WHERE `x` ALREADY ENCODES THAT INSTANT — a usable window and a
 * timestamp inside it, which is exactly when `getWindowPercent` returns an
 * unclamped fraction of that same window. That precondition is what makes the
 * addition inert for POSITION: `resolveMarkerMs` reads back the instant it would
 * otherwise reconstruct from `x`. Outside it the two genuinely disagree, so the
 * absence in the three negative cases below is the contract, not an oversight.
 */
describe("a limit dot carries its instant only where x already encodes it (ISS-8653)", () => {
  it("attaches atMs for a throttle inside the resolved window", () => {
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

    expect(dots[0].atMs).toBe(Date.parse(WINDOW_MID_AT));
  });

  it("attaches none when the session resolves no window to bound the instant", () => {
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
      null
    );

    expect(dots[0].atMs).toBeUndefined();
  });

  it("attaches none for a throttle dated outside the window, whose x is clamped", () => {
    const dots = buildLimitDotEvents(
      sessionWith({
        throttles: [
          {
            durMin: 5,
            tl: 0,
            t0: "2026-06-10T12:00:00.000Z",
            t1: "2026-06-10T12:05:00.000Z",
            x0: PRODUCER_PERCENT,
          },
        ],
      }),
      WINDOW
    );

    // Clamped to the right edge, and `atMs` would move it off that edge — or out
    // of the projection entirely. Where the dot belongs then is a separate
    // question this ticket does not answer.
    expect(dots[0].x).toBe(100);
    expect(dots[0].atMs).toBeUndefined();
  });
});

describe("persisted markers follow the resolved window (whitlockk / codex review)", () => {
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

/**
 * ISS-7632: a persisted marker this screen cannot anchor to a transcript row
 * carries NO jump target, and the type now says so.
 *
 * FEA-4252's first bullet already promised it — "an absent/non-finite `tl` is
 * preserved (the dot stays an inert no-op, never a fabricated jump to the top)"
 * — and the dot rail already honoured it, reading `?.tl ?? null` because
 * ISS-5479 found a synced marker deserializing without a row. What was missing
 * was a compiler that agreed: `normalizePersistedMarkerRow` declared `: number`
 * and reached the promise through `return tl as number`, so no reader was ever
 * forced to handle the absence and nothing exercised it.
 *
 * The two producers of "no usable row" are pinned separately because they are
 * reachable by different routes: a non-finite `tl` is type-legal and therefore
 * reachable inside the type boundary, while an outright missing `tl` is a
 * deserialization state the wire type does not model.
 */
describe("a persisted marker with no anchorable row yields no jump target (ISS-7632)", () => {
  it("yields no row for a non-finite tl rather than passing NaN off as a number", () => {
    const markers = buildActivityMarkers(
      sessionWith({
        markers: [
          {
            kind: "commit",
            label: "seed",
            t: WINDOW_MID_AT,
            tl: Number.NaN,
            x: PRODUCER_PERCENT,
          },
        ],
      }),
      WINDOW
    );

    expect(markers).toHaveLength(1);
    // Not `NaN`: `NaN` survives the `?? null` every downstream reader uses, so
    // it reached the rail as a dot that still offered — and announced — a jump,
    // to a row that does not exist.
    expect(markers[0].tl).toBeUndefined();
  });

  it("yields no row for a tl the sync boundary dropped", () => {
    const markers = buildActivityMarkers(
      sessionWith({ markers: [markerWithoutRow()] }),
      WINDOW
    );

    expect(markers).toHaveLength(1);
    expect(markers[0].tl).toBeUndefined();
  });

  it("carries the absence into the dot cell the rail reads its jump target from", () => {
    const markers = buildActivityMarkers(
      sessionWith({ markers: [markerWithoutRow()] }),
      WINDOW
    );

    const [cell] = buildDotCells(markers, [], 1);

    // Lane-agnostic on purpose: the assertion is about the row surviving the
    // hop, not about which lane a commit lands in.
    const events = [...cell.b, ...cell.g, ...cell.r];
    expect(events).toHaveLength(1);
    // `session-timeline-dot-rail.tsx` turns exactly this into `?.tl ?? null`,
    // and a null `dotRow` is what makes the dot an inert, aria-disabled no-op.
    expect(events[0].tl).toBeUndefined();
    expect(events[0].tl ?? null).toBeNull();
  });
});

/**
 * A persisted marker that deserialized without its transcript row.
 *
 * `SessionMarker.tl` is declared required, but `markers` is parsed out of a
 * synced JSON column rather than constructed in-process — the trust boundary
 * where AGENTS.md keeps malformed and version-skewed input in scope for tests —
 * and ISS-5479 exists precisely because a real marker arrives without one. The
 * cast is how a fixture reaches that state; the alternative is a test that
 * cannot exercise the case at all.
 */
function markerWithoutRow(): SessionMarker {
  return {
    kind: "commit",
    label: "seed",
    t: WINDOW_MID_AT,
    x: PRODUCER_PERCENT,
  } as SessionMarker;
}
