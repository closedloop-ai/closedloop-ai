import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { getDurationScaleMinutes } from "@repo/app/shared/lib/format-utils";
import { describe, expect, it, vi } from "vitest";
import {
  resolveSessionDurationDetail,
  resolveSessionDurationEnd,
  resolveSessionDurationWindow,
  resolveSessionTimelineAxisEnd,
  resolveSessionWallClockLabel,
  resolveSessionWallClockMs,
  SESSION_DURATION_ENDED_DETAIL,
  SESSION_DURATION_RUNNING_DETAIL,
  type SessionDurationWindow,
} from "../session-duration";

/**
 * ISS-5131 (#4409 review): `nowMs` is a REQUIRED argument of both resolvers —
 * neither reads the ambient clock any more, which is what stops a memoized
 * consumer from freezing a running Duration while captioning it "Start to now".
 * These wrappers pin a default so the many terminal-window cases below stay
 * readable; every test that actually depends on the clock passes its own.
 */
const DEFAULT_NOW_MS = new Date("2026-08-04T18:05:00.000Z").getTime();

function wallClockMs(
  startedAt: Date | string | null | undefined,
  window: SessionDurationWindow,
  nowMs: number = DEFAULT_NOW_MS
): number | null {
  return resolveSessionWallClockMs(startedAt, window, nowMs);
}

function wallClockLabel(
  startedAt: Date | string | null | undefined,
  window: SessionDurationWindow,
  nowMs: number = DEFAULT_NOW_MS
): string | null {
  return resolveSessionWallClockLabel(startedAt, window, nowMs);
}

const ENDED_AT = "2026-06-10T13:00:00.000Z";
const LAST_ACTIVITY_AT = "2026-06-10T12:40:00.000Z";
const UPDATED_AT = "2026-06-10T12:55:00.000Z";

describe("resolveSessionDurationEnd (the ISS-5131 legacy timeline bound)", () => {
  it("FEA-3594: prefers lastActivityAt over endedAt (defense-in-depth against stale ended_at)", () => {
    expect(
      resolveSessionDurationEnd(ENDED_AT, LAST_ACTIVITY_AT, UPDATED_AT)
    ).toBe(LAST_ACTIVITY_AT);
  });

  it("FEA-3594: falls back to endedAt when lastActivityAt is absent", () => {
    expect(resolveSessionDurationEnd(ENDED_AT, null, UPDATED_AT)).toBe(
      ENDED_AT
    );
  });

  it("falls back to lastActivityAt for an active session (never Date.now)", () => {
    expect(resolveSessionDurationEnd(null, LAST_ACTIVITY_AT, UPDATED_AT)).toBe(
      LAST_ACTIVITY_AT
    );
  });

  it("falls back to updatedAt only when both endedAt and lastActivityAt are absent", () => {
    expect(resolveSessionDurationEnd(null, null, UPDATED_AT)).toBe(UPDATED_AT);
  });

  it("passes Date instances through unchanged", () => {
    const endedAt = new Date(ENDED_AT);
    expect(resolveSessionDurationEnd(endedAt, null)).toBe(endedAt);
  });

  it("returns null when no bound is available", () => {
    expect(resolveSessionDurationEnd(null, null)).toBeNull();
    expect(
      resolveSessionDurationEnd(undefined, undefined, undefined)
    ).toBeNull();
  });
});

describe("resolveSessionDurationDetail (ISS-5131)", () => {
  it("names the bounds the number was actually measured between", () => {
    // The FEA-4186 caption said "Start to last activity" for BOTH lifecycle
    // cases. On a completed session that named a bound the span is not taken to
    // — the sentence that made the inflated 170h read as legitimate.
    expect(
      resolveSessionDurationDetail(
        resolveSessionDurationWindow(SESSION_STATUS.ACTIVE, null)
      )
    ).toBe(SESSION_DURATION_RUNNING_DETAIL);
    expect(
      resolveSessionDurationDetail(
        resolveSessionDurationWindow(SESSION_STATUS.INACTIVE, ENDED_AT)
      )
    ).toBe(SESSION_DURATION_ENDED_DETAIL);
    expect(SESSION_DURATION_RUNNING_DETAIL).not.toBe(
      SESSION_DURATION_ENDED_DETAIL
    );
  });

  it("names no bounds for an unmeasurable window", () => {
    // There is no span, so there are no two instants to name. The caller
    // substitutes its own absence caption rather than captioning an empty value
    // slot with the bounds of a measurement nothing made.
    expect(
      resolveSessionDurationDetail(
        resolveSessionDurationWindow(SESSION_STATUS.INACTIVE, null)
      )
    ).toBeNull();
  });
});

describe("resolveSessionDurationWindow (ISS-5131)", () => {
  // The reported session `019fb3e3`: a COMPLETED run whose `lastActivityAt`
  // tracks SYNC time and lands six days after its own `endedAt`. Measuring to it
  // reported 170h 30m for a session that ran 31h 4m — a 5.5x inflation.
  const REPRO_STARTED_AT = "2026-07-28T14:58:31.028Z";
  const REPRO_ENDED_AT = "2026-07-29T22:02:53.365Z";
  const REPRO_TRUE_SPAN_MS =
    new Date(REPRO_ENDED_AT).getTime() - new Date(REPRO_STARTED_AT).getTime();

  it("bounds a terminal session by its own endedAt, not by a later activity/sync timestamp", () => {
    const window = resolveSessionDurationWindow(
      SESSION_STATUS.INACTIVE,
      REPRO_ENDED_AT
    );
    expect(window).toEqual({ kind: "ended", end: REPRO_ENDED_AT });
    expect(wallClockMs(REPRO_STARTED_AT, window)).toBe(REPRO_TRUE_SPAN_MS);
    expect(wallClockLabel(REPRO_STARTED_AT, window)).toBe("31h 4m");
  });

  it("does not grow after the session ended, however far the clock advances", () => {
    // The defect's signature: the reported number kept climbing on a finished
    // session. Two readings six days apart must be byte-identical.
    const window = resolveSessionDurationWindow(
      SESSION_STATUS.INACTIVE,
      REPRO_ENDED_AT
    );
    const soonAfter = wallClockLabel(
      REPRO_STARTED_AT,
      window,
      new Date("2026-07-29T23:00:00.000Z").getTime()
    );
    const sixDaysLater = wallClockLabel(
      REPRO_STARTED_AT,
      window,
      new Date("2026-08-04T18:05:00.000Z").getTime()
    );
    expect(soonAfter).toBe("31h 4m");
    expect(sixDaysLater).toBe(soonAfter);
  });

  it("measures a running session against the CALLER's clock, and only that clock", () => {
    // ISS-5131 (#4409 review): the resolvers take `nowMs` and never read the
    // ambient one. Moving the SYSTEM clock while holding `nowMs` fixed must not
    // move the answer — that is what makes the value provably a function of its
    // arguments, so a memoized consumer's frozen render is a caller bug the
    // types can point at rather than an invisible one.
    const window = resolveSessionDurationWindow(SESSION_STATUS.ACTIVE, null);
    expect(window).toEqual({ kind: "running" });
    const startedAt = "2026-06-10T10:00:00.000Z";
    const pinnedNowMs = new Date("2026-06-10T12:30:00.000Z").getTime();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-10T12:30:00.000Z"));
      expect(wallClockMs(startedAt, window, pinnedNowMs)).toBe(150 * 60_000);
      expect(wallClockLabel(startedAt, window, pinnedNowMs)).toBe("2h 30m");
      vi.setSystemTime(new Date("2026-06-20T12:30:00.000Z"));
      expect(wallClockMs(startedAt, window, pinnedNowMs)).toBe(150 * 60_000);
      expect(wallClockLabel(startedAt, window, pinnedNowMs)).toBe("2h 30m");
    } finally {
      vi.useRealTimers();
    }
    // ...and it DOES move when the caller hands over a later instant.
    expect(
      wallClockLabel(
        startedAt,
        window,
        new Date("2026-06-10T13:30:00.000Z").getTime()
      )
    ).toBe("3h 30m");
  });

  it("ignores a stale endedAt on a session that is still running", () => {
    // Only the status decides which branch is taken. A running session carrying
    // a leftover `endedAt` (ISS-5182: an inactive session that resumed must have
    // it cleared) still measures to now rather than freezing at that instant.
    expect(
      resolveSessionDurationWindow(SESSION_STATUS.ACTIVE, ENDED_AT)
    ).toEqual({ kind: "running" });
  });

  it("treats a TERMINAL session with no endedAt as unmeasurable, never as running", () => {
    // One instant is not a span. Falling through to the running branch would
    // render a finished session's duration growing forever.
    expect(resolveSessionDurationWindow(SESSION_STATUS.INACTIVE, null)).toEqual(
      { kind: "unmeasurable" }
    );
    expect(resolveSessionDurationWindow(SESSION_STATUS.ERROR, null)).toEqual({
      kind: "unmeasurable",
    });
    expect(
      wallClockLabel("2026-06-10T10:00:00.000Z", {
        kind: "unmeasurable",
      })
    ).toBeNull();
    expect(
      wallClockMs("2026-06-10T10:00:00.000Z", {
        kind: "unmeasurable",
      })
    ).toBeNull();
  });

  it("bounds the LEGACY terminal statuses too (ISS-4586 version skew)", () => {
    // Stored rows and older desktop builds still carry `completed`/`abandoned`.
    // Falling through to the running branch would measure a long-finished legacy
    // row against `now()` — the same growing-forever number, on the population
    // least likely to be looked at closely.
    for (const status of ["completed", "abandoned"]) {
      expect(resolveSessionDurationWindow(status, REPRO_ENDED_AT)).toEqual({
        kind: "ended",
        end: REPRO_ENDED_AT,
      });
      expect(resolveSessionDurationWindow(status, null)).toEqual({
        kind: "unmeasurable",
      });
    }
  });

  it("stops timing a STALE session, so its Duration cannot contradict its Status", () => {
    // #4409 review: with `sessions-honest-unknown-states` on, the Sessions list
    // hands this the DISPLAYED status, so a row silent past the cutoff arrives
    // as `stale`. Keeping it on the running branch put a Status cell reading
    // "Unknown" beside a Duration confidently claiming 73h and climbing — one
    // row both disclaiming knowledge of the state and still timing the run.
    expect(
      resolveSessionDurationWindow(DISPLAYED_SESSION_STATUS.STALE, null)
    ).toEqual({
      kind: "unmeasurable",
    });
    expect(
      resolveSessionDurationWindow(DISPLAYED_SESSION_STATUS.UNKNOWN, null)
    ).toEqual({
      kind: "unmeasurable",
    });
    // Evidence still wins where there IS evidence: a stale row that does carry
    // an end instant is bounded by it rather than blanked.
    expect(
      resolveSessionDurationWindow(DISPLAYED_SESSION_STATUS.STALE, ENDED_AT)
    ).toEqual({ kind: "ended", end: ENDED_AT });
  });

  it("resolves an UNRECOGNIZED or ABSENT status by evidence, never by reaching for the clock", () => {
    // ISS-4997: an unknown status asserts nothing about the lifecycle. An
    // `endedAt` is evidence the session ended; its ABSENCE is not evidence that
    // it is still going, so the span is unmeasurable rather than live.
    expect(
      resolveSessionDurationWindow("some-future-status", ENDED_AT)
    ).toEqual({ kind: "ended", end: ENDED_AT });
    expect(resolveSessionDurationWindow("some-future-status", null)).toEqual({
      kind: "unmeasurable",
    });
    expect(resolveSessionDurationWindow(null, null)).toEqual({
      kind: "unmeasurable",
    });
    expect(resolveSessionDurationWindow(undefined, ENDED_AT)).toEqual({
      kind: "ended",
      end: ENDED_AT,
    });
  });

  it("accepts Date objects as well as ISO strings, so web and desktop share one derivation", () => {
    const endedAt = new Date(ENDED_AT);
    expect(
      resolveSessionDurationWindow(SESSION_STATUS.INACTIVE, endedAt)
    ).toEqual({ kind: "ended", end: endedAt });
    expect(
      wallClockLabel(new Date("2026-06-10T12:00:00.000Z"), {
        kind: "ended",
        end: endedAt,
      })
    ).toBe("1h 0m");
  });
});

describe("resolveSessionWallClockMs / Label: no fabricated numbers (ISS-4979)", () => {
  const STARTED_AT = "2026-06-10T10:00:00.000Z";

  it("reports no measurement for a zero-width span rather than a fabricated 0s", () => {
    // The cloud list projection floors an absent `lastActivityAt` to the start,
    // and a row can genuinely carry a single recorded instant. Neither is a
    // measurement, so neither may print "0s".
    const window = { kind: "ended", end: STARTED_AT } as const;
    expect(wallClockMs(STARTED_AT, window)).toBeNull();
    expect(wallClockLabel(STARTED_AT, window)).toBeNull();
  });

  it("reports no measurement for a clock-skewed span (end before start)", () => {
    const window = { kind: "ended", end: STARTED_AT } as const;
    expect(wallClockMs("2026-06-10T14:54:00.000Z", window)).toBeNull();
    expect(wallClockLabel("2026-06-10T14:54:00.000Z", window)).toBeNull();
  });

  it("reports no measurement when the start bound is missing or unparseable", () => {
    const window = { kind: "ended", end: ENDED_AT } as const;
    expect(wallClockMs(null, window)).toBeNull();
    expect(wallClockLabel(undefined, window)).toBeNull();
    expect(wallClockLabel("not-a-date", window)).toBeNull();
    expect(wallClockLabel("not-a-date", { kind: "running" })).toBeNull();
  });

  it("reports no measurement when the END bound is unparseable", () => {
    const window = { kind: "ended", end: "not-a-date" } as const;
    expect(wallClockMs(STARTED_AT, window)).toBeNull();
    expect(wallClockLabel(STARTED_AT, window)).toBeNull();
  });

  it("keeps the label and its numeric twin on the same side of every line", () => {
    // Anything derived from the number (the Overview event rate, the sort key)
    // must reconcile with the string the reader is shown, so the two helpers can
    // never disagree about whether a measurement exists.
    const cases = [
      { start: STARTED_AT, window: { kind: "ended", end: ENDED_AT } as const },
      {
        start: STARTED_AT,
        window: { kind: "ended", end: STARTED_AT } as const,
      },
      { start: null, window: { kind: "ended", end: ENDED_AT } as const },
      { start: STARTED_AT, window: { kind: "unmeasurable" } as const },
      { start: STARTED_AT, window: { kind: "running" } as const },
    ];
    for (const { start, window } of cases) {
      expect(wallClockLabel(start, window) === null).toBe(
        wallClockMs(start, window) === null
      );
    }
  });
});

describe("resolveSessionTimelineAxisEnd (ISS-4684)", () => {
  // The SES `019fa57e…` repro shape: the session was marked `endedAt` ~44.9h
  // after start, but real activity continued for ~93.7h. `lastActivityAt` is the
  // honest last-activity bound the "Activity phases" span runs to.
  const AXIS_STARTED_AT = "2026-07-27T21:28:09.000Z";
  const STALE_ENDED_AT = "2026-07-29T18:22:45.000Z";
  const HONEST_LAST_ACTIVITY_AT = "2026-07-31T19:08:52.000Z";

  it("anchors on the honest lastActivityAt, NOT the stale endedAt, when activity continued past endedAt", () => {
    // The bug: activity dated after `endedAt` is the majority of the session, so
    // an axis anchored on `endedAt` tops out early. The axis end must be the
    // later `lastActivityAt` so the axis covers the plotted activity.
    expect(
      resolveSessionTimelineAxisEnd(
        STALE_ENDED_AT,
        HONEST_LAST_ACTIVITY_AT,
        UPDATED_AT
      )
    ).toBe(HONEST_LAST_ACTIVITY_AT);
    // Guard against a regression to the observed-running Duration precedence
    // (`endedAt ?? …`), which would return the stale end.
    expect(
      resolveSessionTimelineAxisEnd(
        STALE_ENDED_AT,
        HONEST_LAST_ACTIVITY_AT,
        UPDATED_AT
      )
    ).not.toBe(STALE_ENDED_AT);
  });

  it("computes the same axis total as start->lastActivityAt when activity is the later bound (helper-contract, not a render assertion)", () => {
    // NOTE: this pins only the helper output — that the axis end this helper
    // returns yields the same scaleMinutes as the honest start->lastActivityAt
    // span when lastActivityAt is the later bound. It does NOT render the detail
    // view or exercise the Activity-phases projection, so it is not a full
    // cross-widget reconciliation assertion. A render regression over real
    // activity rows plus web/Electron E2E are tracked in an ISS follow-up.
    const axisScaleMinutes = getDurationScaleMinutes(
      AXIS_STARTED_AT,
      resolveSessionTimelineAxisEnd(
        STALE_ENDED_AT,
        HONEST_LAST_ACTIVITY_AT,
        UPDATED_AT
      )
    );
    const phasesSpanMinutes = getDurationScaleMinutes(
      AXIS_STARTED_AT,
      HONEST_LAST_ACTIVITY_AT
    );
    expect(axisScaleMinutes).toBe(phasesSpanMinutes);
    // …and the honest span is materially larger than the stale-endedAt axis the
    // bug produced, so this is not a no-op equality.
    const staleAxisMinutes = getDurationScaleMinutes(
      AXIS_STARTED_AT,
      STALE_ENDED_AT
    );
    expect(axisScaleMinutes).toBeGreaterThan(staleAxisMinutes);
  });

  it("pins the max() delta: a pre-backfill row (lastActivityAt fell back to startedAt) reaches the later endedAt", () => {
    // The one shape where `max(endedAt, lastActivityAt)` differs from the old
    // `lastActivityAt ?? endedAt` precedence: projections fill
    // `lastActivityAt ?? sessionStartedAt`, so a pre-backfill row's
    // `lastActivityAt` IS `startedAt`. The old precedence would crop the axis to
    // a ~0-minute scale at `startedAt`; `max()` reaches the real `endedAt`.
    const lastActivityEqualsStart = AXIS_STARTED_AT;
    expect(
      resolveSessionTimelineAxisEnd(
        STALE_ENDED_AT,
        lastActivityEqualsStart,
        UPDATED_AT
      )
    ).toBe(STALE_ENDED_AT);
    // Regression guard: the OLD `lastActivityAt ?? endedAt` precedence would have
    // returned `startedAt` here, collapsing the axis — assert we do NOT.
    expect(
      resolveSessionTimelineAxisEnd(
        STALE_ENDED_AT,
        lastActivityEqualsStart,
        UPDATED_AT
      )
    ).not.toBe(lastActivityEqualsStart);
  });

  it("keeps endedAt when it is genuinely the latest bound (a clean completed session)", () => {
    // ENDED_AT (13:00) is after both LAST_ACTIVITY_AT (12:40) and UPDATED_AT
    // (12:55): a normal completed session whose activity did not run past its
    // end still anchors on endedAt.
    expect(
      resolveSessionTimelineAxisEnd(ENDED_AT, LAST_ACTIVITY_AT, UPDATED_AT)
    ).toBe(ENDED_AT);
  });

  it("falls back to endedAt when lastActivityAt is absent (older / version-skewed detail)", () => {
    expect(resolveSessionTimelineAxisEnd(STALE_ENDED_AT, null)).toBe(
      STALE_ENDED_AT
    );
    expect(resolveSessionTimelineAxisEnd(STALE_ENDED_AT, undefined)).toBe(
      STALE_ENDED_AT
    );
  });

  it("reaches lastActivityAt for a still-running session (no endedAt)", () => {
    expect(
      resolveSessionTimelineAxisEnd(null, HONEST_LAST_ACTIVITY_AT, UPDATED_AT)
    ).toBe(HONEST_LAST_ACTIVITY_AT);
  });

  it("does NOT extend the axis to a later updatedAt (a sync-bump, not activity) — preserves FEA-4186", () => {
    // Active session: startedAt-relative lastActivity 13:00, but the row was
    // sync-bumped at updatedAt 21:00. The axis must stay on the observed last
    // activity (13:00), NOT stretch 8h further to the sync timestamp — otherwise
    // it re-introduces the idle-wall-clock inflation FEA-4186 removed.
    const laterUpdatedAt = "2026-06-10T21:00:00.000Z";
    expect(
      resolveSessionTimelineAxisEnd(null, LAST_ACTIVITY_AT, laterUpdatedAt)
    ).toBe(LAST_ACTIVITY_AT);
    // Same guard for a completed session whose endedAt precedes the sync bump.
    expect(resolveSessionTimelineAxisEnd(ENDED_AT, null, laterUpdatedAt)).toBe(
      ENDED_AT
    );
  });

  it("falls back to updatedAt only when both endedAt and lastActivityAt are absent", () => {
    expect(resolveSessionTimelineAxisEnd(null, null, UPDATED_AT)).toBe(
      UPDATED_AT
    );
  });

  it("returns null when no bound is available so the axis uses its minimum scale", () => {
    expect(resolveSessionTimelineAxisEnd(null, null)).toBeNull();
    expect(
      resolveSessionTimelineAxisEnd(undefined, undefined, undefined)
    ).toBeNull();
  });

  it("ignores an unparseable bound and takes the other valid one", () => {
    // A malformed timestamp must not win nor poison the result; the helper
    // degrades to the valid bound rather than lying about the axis end.
    expect(
      resolveSessionTimelineAxisEnd("not-a-date", HONEST_LAST_ACTIVITY_AT)
    ).toBe(HONEST_LAST_ACTIVITY_AT);
    expect(resolveSessionTimelineAxisEnd(STALE_ENDED_AT, "not-a-date")).toBe(
      STALE_ENDED_AT
    );
    expect(resolveSessionTimelineAxisEnd("not-a-date", null, null)).toBeNull();
  });

  it("passes a Date instance through unchanged when it is the latest bound", () => {
    const lastActivity = new Date(HONEST_LAST_ACTIVITY_AT);
    expect(resolveSessionTimelineAxisEnd(STALE_ENDED_AT, lastActivity)).toBe(
      lastActivity
    );
  });
});
