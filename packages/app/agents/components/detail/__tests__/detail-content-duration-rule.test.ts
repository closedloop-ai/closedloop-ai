import {
  SESSION_STATUS,
  STALE_SESSION_DISPLAY_THRESHOLD_HOURS,
} from "@repo/api/src/types/session-status";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_DURATION_ENDED_DETAIL,
  SESSION_DURATION_RUNNING_DETAIL,
} from "../../../lib/session-duration";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import {
  buildSessionDetailContent,
  DURATION_UNRECORDED_DETAIL,
} from "../detail-content";

/**
 * ISS-5131: the session-DETAIL half of the Duration rule — `now - start` while
 * running, `end - start` once terminal. `detail-content.test.ts` is at the
 * file-size ceiling, so this ships as its own sibling rather than growing it.
 *
 * Both detail Duration surfaces — the Duration MetricCard and the Overview
 * `durationLabel` — read the one derivation, so they must move together with the
 * list cell (`synced-sessions-table-duration-zero-span.test.tsx`). A surface that
 * moved alone would re-open the ISS-4631 list<->detail contradiction.
 */

const STARTED_AT = new Date("2026-06-10T10:00:00.000Z");
const ENDED_AT = new Date("2026-06-10T12:30:00.000Z");
/**
 * ISS-5575: the instant every assertion about a RUNNING fixture is measured at.
 * Inside the staleness cutoff of both active fixtures' own activity anchors, so
 * "running" is true of them at this clock — which is what those tests mean, and
 * what the real wall clock stopped making true once the Duration window started
 * reading the DISPLAYED status.
 */
const RUNNING_FIXTURE_NOW = new Date("2026-06-10T12:30:00.000Z");
/**
 * ISS-5575: comfortably past {@link STALE_SESSION_DISPLAY_THRESHOLD_HOURS} from
 * {@link STARTED_AT}, so a stored-`active` fixture anchored there has folded to
 * "Stale" — the state the Sessions list already renders as the em-dash.
 */
const STALE_FIXTURE_NOW = new Date(
  STARTED_AT.getTime() + (STALE_SESSION_DISPLAY_THRESHOLD_HOURS + 6) * 3_600_000
);

// The reported session `019fb3e3`: COMPLETED, but its `lastActivityAt` tracks
// SYNC time and lands six days past `endedAt`, and the collector's `wallClock`
// was derived from that same activity anchor. Measuring to either reported
// 170h 30m for a run that lasted 31h 4m.
const REPRO_STARTED_AT = new Date("2026-07-28T14:58:31.028Z");
const REPRO_ENDED_AT = new Date("2026-07-29T22:02:53.365Z");
const inflatedCompletedSession = createAgentSessionDetailFixture({
  status: SESSION_STATUS.INACTIVE,
  startedAt: REPRO_STARTED_AT,
  endedAt: REPRO_ENDED_AT,
  lastActivityAt: new Date("2026-08-04T17:28:37.425Z"),
  updatedAt: new Date("2026-08-04T17:58:39.726Z"),
  wallClock: "170h 30m",
});

// A terminal session with no end instant: one recorded instant is not a span.
const unendedTerminalSession = createAgentSessionDetailFixture({
  status: SESSION_STATUS.INACTIVE,
  startedAt: STARTED_AT,
  endedAt: null,
  lastActivityAt: STARTED_AT,
  wallClock: null,
});

const runningSession = createAgentSessionDetailFixture({
  status: SESSION_STATUS.ACTIVE,
  startedAt: STARTED_AT,
  endedAt: null,
  lastActivityAt: STARTED_AT,
  wallClock: null,
});

const endedSession = createAgentSessionDetailFixture({
  status: SESSION_STATUS.INACTIVE,
  startedAt: STARTED_AT,
  endedAt: ENDED_AT,
  lastActivityAt: new Date("2026-06-11T09:00:00.000Z"),
  wallClock: null,
});

/**
 * ISS-5575: a stored-`active` run that has gone silent past the display cutoff.
 * The Sessions LIST folds it to "Stale" and its Duration cell to the em-dash;
 * until the fold reached `buildSessionDetailContent`, the detail's Duration card
 * kept a number climbing against `now()` for the same record.
 */
const staleActiveSession = createAgentSessionDetailFixture({
  status: SESSION_STATUS.ACTIVE,
  startedAt: STARTED_AT,
  endedAt: null,
  lastActivityAt: STARTED_AT,
  wallClock: null,
});

const runningWithStaleEndSession = createAgentSessionDetailFixture({
  status: SESSION_STATUS.ACTIVE,
  startedAt: STARTED_AT,
  endedAt: ENDED_AT,
  lastActivityAt: ENDED_AT,
  wallClock: null,
});

/** The "Ended" metadata row's rendered value for a session. */
function endedMetadata(session: typeof endedSession): string | undefined {
  return buildSessionDetailContent(session).metadata.find(
    (entry) => entry.label === "Ended"
  )?.value;
}

function durationMetric(session: typeof endedSession): {
  value: string | null;
  detail?: string;
} {
  const metric = buildSessionDetailContent(session).metrics.find(
    (entry) => entry.label === "Duration"
  );
  if (!metric) {
    throw new Error("Duration metric missing from session detail content");
  }
  return metric;
}

function overview(session: typeof endedSession) {
  return buildSessionDetailContent(session).overview;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("session detail Duration — ISS-5131 wall-time rule", () => {
  it("measures a terminal session start -> endedAt, not to a later activity/sync timestamp", () => {
    // The whole defect in one assertion: 31h 4m, never the collector's
    // "170h 30m" nor the six-days-later `lastActivityAt` it was anchored on.
    expect(durationMetric(inflatedCompletedSession).value).toBe("31h 4m");
    expect(overview(inflatedCompletedSession).durationLabel).toBe("31h 4m");
    expect(durationMetric(inflatedCompletedSession).value).not.toBe("170h 30m");
  });

  it("captions each surface with the bounds its number was measured between", () => {
    // ISS-5575: the running/ended caption is now clock-dependent, because the
    // window is resolved from the DISPLAYED status and an `active` run silent
    // past the staleness cutoff no longer counts as running. `runningSession`
    // is fixture-dated, so against the real wall clock it is months silent and
    // would caption "Length not recorded" — a true statement about a stale run,
    // but not the rule under test here. Pin the clock beside its own activity,
    // exactly as "measures a running session against now" below already does.
    vi.useFakeTimers();
    vi.setSystemTime(RUNNING_FIXTURE_NOW);
    expect(durationMetric(endedSession).detail).toBe(
      SESSION_DURATION_ENDED_DETAIL
    );
    expect(overview(endedSession).durationDetail).toBe(
      SESSION_DURATION_ENDED_DETAIL
    );
    expect(durationMetric(runningSession).detail).toBe(
      SESSION_DURATION_RUNNING_DETAIL
    );
    expect(overview(runningSession).durationDetail).toBe(
      SESSION_DURATION_RUNNING_DETAIL
    );
  });

  it("stops timing a stored-active run the list has already folded to Stale", () => {
    // ISS-5575: BOTH detail-content Duration surfaces resolve their window from
    // the DISPLAYED status now, so neither can keep timing a run the Sessions
    // list has stopped believing is live. Reverting either call site back to
    // `resolveSessionDurationWindow(session.status, session.endedAt)` reds this:
    // the raw `active` reads as running and the card reports "30h 0m".
    vi.useFakeTimers();
    vi.setSystemTime(STALE_FIXTURE_NOW);
    expect(durationMetric(staleActiveSession).value).toBeNull();
    expect(durationMetric(staleActiveSession).detail).toBe(
      DURATION_UNRECORDED_DETAIL
    );
    expect(overview(staleActiveSession).durationLabel).toBeNull();
    expect(overview(staleActiveSession).durationDetail).toBe(
      DURATION_UNRECORDED_DETAIL
    );
  });

  it("hands MetricCard a null — not an em-dash string — for a terminal session with no end instant", () => {
    // #4291 review: `MetricCard` derives its own no-data state from a nullish
    // value and renders the muted "No data" glyph; a "—" string would defeat that
    // and print the rule character in the bold 2xl value slot (FEA-4236).
    expect(durationMetric(unendedTerminalSession).value).toBeNull();
    expect(overview(unendedTerminalSession).durationLabel).toBeNull();
  });

  it("stops claiming measured bounds once the value is absent", () => {
    expect(durationMetric(unendedTerminalSession).detail).toBe(
      DURATION_UNRECORDED_DETAIL
    );
    expect(overview(unendedTerminalSession).durationDetail).toBe(
      DURATION_UNRECORDED_DETAIL
    );
  });

  it("measures a running session against now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(RUNNING_FIXTURE_NOW);
    expect(durationMetric(runningSession).value).toBe("2h 30m");
    expect(overview(runningSession).durationLabel).toBe("2h 30m");
  });

  it("keeps the MetricCard and the Overview label byte-identical on every session", () => {
    // ONE derivation: a divergence here means a second switch appeared.
    for (const session of [
      inflatedCompletedSession,
      unendedTerminalSession,
      endedSession,
    ]) {
      expect(durationMetric(session).value).toBe(
        overview(session).durationLabel
      );
      expect(durationMetric(session).detail).toBe(
        overview(session).durationDetail
      );
    }
  });

  it("divides the event rate by the SAME span the Duration shows", () => {
    // ISS-4675: the reader must be able to recompute the rate from the two
    // values on screen. Against the inflated 170h denominator the same events
    // reported a rate 5.5x too low.
    const stats = overview(inflatedCompletedSession);
    const eventCount = inflatedCompletedSession.events.length;
    const spanMinutes =
      (REPRO_ENDED_AT.getTime() - REPRO_STARTED_AT.getTime()) / 60_000;
    expect(stats.durationLabel).toBe("31h 4m");
    expect(stats.eventRateHint).toBe(
      `${Math.round(eventCount / spanMinutes)} events / min`
    );
  });
});

/**
 * ISS-5131 (wongk, #4409): the "Ended" metadata row is derived from the SAME
 * window the Duration cards resolved. Branching on `endedAt` alone put two
 * contradicting facts on one screen in both directions.
 */
describe('session detail "Ended" metadata reconciles with the Duration window', () => {
  it("says the length was not recorded, not that the session is still running", () => {
    // A TERMINAL session with no end instant. Branching on `endedAt` alone read
    // its absence as "Still running" — beside a Duration card that had already
    // said "Length not recorded", i.e. one screen simultaneously claiming the
    // run is live and that it has a length nobody wrote down.
    expect(durationMetric(unendedTerminalSession).value).toBeNull();
    expect(durationMetric(unendedTerminalSession).detail).toBe(
      DURATION_UNRECORDED_DETAIL
    );
    expect(endedMetadata(unendedTerminalSession)).not.toBe("Still running");
    expect(endedMetadata(unendedTerminalSession)).toBe("Not recorded");
  });

  it("says the session is still running even when a stale endedAt lingers", () => {
    // The mirror case. ISS-5182 clears `endedAt` when an inactive session
    // resumes; until then the leftover instant was printed as a settled end
    // time, next to a Duration captioned "Start to now".
    // ISS-5575: pinned for the same reason as the caption test above — this
    // fixture is only "still running" while its own activity is inside the
    // staleness cutoff, and it is fixture-dated.
    vi.useFakeTimers();
    vi.setSystemTime(RUNNING_FIXTURE_NOW);
    expect(durationMetric(runningWithStaleEndSession).detail).toBe(
      SESSION_DURATION_RUNNING_DETAIL
    );
    expect(endedMetadata(runningWithStaleEndSession)).toBe("Still running");
  });

  it("prints the end timestamp for a session that really did end", () => {
    expect(durationMetric(endedSession).detail).toBe(
      SESSION_DURATION_ENDED_DETAIL
    );
    const value = endedMetadata(endedSession);
    expect(value).not.toBe("Still running");
    expect(value).not.toBe("Not recorded");
  });

  it("never says 'Still running' while the Duration card names measured bounds", () => {
    // The class-level invariant behind the three examples: the two facts are
    // read off one window, so no session can produce a mismatched pair.
    for (const session of [
      inflatedCompletedSession,
      unendedTerminalSession,
      runningSession,
      runningWithStaleEndSession,
      endedSession,
    ]) {
      const isRunningCaption =
        durationMetric(session).detail === SESSION_DURATION_RUNNING_DETAIL;
      expect(endedMetadata(session) === "Still running").toBe(isRunningCaption);
    }
  });
});
