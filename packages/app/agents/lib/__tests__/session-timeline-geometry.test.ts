import type {
  ActivityBucket,
  SyncedActivitySegmentRow,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import {
  alignBucketRowsToTranscript,
  getLimitDotPercent,
  getWindowPercent,
  resolveSessionTimelineWindow,
  type SessionTimelineWindowSource,
} from "../session-timeline-geometry";
import { createActivityBuckets } from "./session-timeline-geometry-fixtures";

/**
 * ISS-4833 / ISS-4821: the Session Timeline's ONE window, and the geometry it
 * drives.
 *
 * The reference shape throughout is SES 019fa57e, the reported case: a session
 * whose `endedAt` is a stale/sweeper-stamped instant while ~71% of its events
 * are dated AFTER it. Under the prior derivation the axis label and the plotted
 * geometry read that session two different ways — the label covered the honest
 * span while every post-`endedAt` dot clamped to the right edge — so each
 * assertion below is written so the PRIOR behavior fails it.
 */

const STARTED_AT = "2026-06-10T09:00:00.000Z";
/** Sweeper/heal stamped this an hour in, long before the work actually stopped. */
const STALE_ENDED_AT = "2026-06-10T10:00:00.000Z";
const LAST_ACTIVITY_AT = "2026-06-10T13:00:00.000Z";
const FIRST_ROW_AT = "2026-06-10T09:30:00.000Z";
const LAST_ROW_AT = "2026-06-10T12:30:00.000Z";
const POST_END_ROW_AT = "2026-06-10T11:00:00.000Z";
/** A row-update bump long after the last observed activity. */
const SYNC_BUMP_AT = "2026-06-10T18:00:00.000Z";

const ACTOR = {
  color: "var(--primary)",
  harness: "codex",
  human: null,
  name: "gpt-5.5",
  sessionId: "session-timeline-window",
};

function promptRow(row: number, at: string): TurnItem {
  return {
    _row: row,
    actor: ACTOR,
    cum: 0,
    t: at,
    tMs: Date.parse(at),
    text: `turn ${row}`,
    type: "prompt",
  };
}

function staleEndedSource(
  overrides: Partial<SessionTimelineWindowSource> = {}
): SessionTimelineWindowSource {
  return {
    endedAt: STALE_ENDED_AT,
    lastActivityAt: LAST_ACTIVITY_AT,
    startedAt: STARTED_AT,
    turnItems: [
      promptRow(0, FIRST_ROW_AT),
      promptRow(1, POST_END_ROW_AT),
      promptRow(2, LAST_ROW_AT),
    ],
    updatedAt: LAST_ACTIVITY_AT,
    ...overrides,
  };
}

/** Jump-target-bearing bars, pre-repair (`tl0: 999` overshoots every row). */
function bucketsOf(count: number): ActivityBucket[] {
  return Array.from({ length: count }, (_, index) => ({
    byModel: {},
    cCache: 0,
    cIn: 0,
    cOut: 0,
    key: `b-${index}`,
    label: `${index}`,
    tl0: 999,
    toolStart: 0,
    total: 1,
  }));
}

function tiling(startAt: string, endAt: string): SyncedActivitySegmentRow[] {
  return [
    {
      confidence: 0.9,
      endMs: Date.parse(endAt),
      evidenceLayers: ["structural"],
      phase: "implement",
      startMs: Date.parse(startAt),
      version: 1,
    },
  ];
}

describe("resolveSessionTimelineWindow (ISS-4833)", () => {
  it("anchors both ends to the plotted rows, so a sweeper-stamped endedAt cannot inflate the window", () => {
    const window = resolveSessionTimelineWindow(staleEndedSource());

    // Not `startedAt` (09:00) on the left and not `max(endedAt, lastActivityAt)`
    // (13:00) on the right — both ends are instants the screen actually draws.
    expect(window).toEqual({
      startMs: Date.parse(FIRST_ROW_AT),
      endMs: Date.parse(LAST_ROW_AT),
    });
  });

  it("reaches past a stale endedAt to cover rows dated after it (ISS-4821)", () => {
    const window = resolveSessionTimelineWindow(staleEndedSource());

    expect(window?.endMs).toBeGreaterThan(Date.parse(STALE_ENDED_AT));
  });

  it("unions the Activity-phases tiling bounds so the axis reconciles with the phases caption", () => {
    // The tiling runs wider than the transcript on BOTH sides — it is the span
    // the "phases span …" caption directly beneath the axis prints, so the axis
    // has to cover it rather than state a second, smaller number.
    const window = resolveSessionTimelineWindow(
      staleEndedSource({
        activitySegmentRows: tiling(STARTED_AT, LAST_ACTIVITY_AT),
      })
    );

    expect(window).toEqual({
      startMs: Date.parse(STARTED_AT),
      endMs: Date.parse(LAST_ACTIVITY_AT),
    });
  });

  /*
   * ISS-5075 (stage review): a truncated read makes the LAST PLOTTED row mark
   * where reading stopped, not where the run stopped. Ending the axis there
   * would contradict the Duration property on the same screen and silently
   * rescale a partial run to look complete, so the lifecycle end wins when it is
   * later — and the uncovered tail stays visibly (and honestly) empty.
   */
  it("keeps the axis on the full run when the event read was truncated", () => {
    const window = resolveSessionTimelineWindow(
      staleEndedSource({ eventsTruncated: true })
    );

    expect(window?.endMs).toBe(Date.parse(LAST_ACTIVITY_AT));
  });

  it("still ends at the last plotted row when the read was NOT truncated", () => {
    const window = resolveSessionTimelineWindow(staleEndedSource());

    expect(window?.endMs).toBe(Date.parse(LAST_ROW_AT));
  });

  /*
   * ISS-5075 (logical-QA review): that extension takes OBSERVED bounds only.
   * `updatedAt` is a sync bump, not evidence of activity — the same reason
   * `resolveSessionTimelineAxisEnd` keeps it out of its max — and a long
   * still-running session with neither `endedAt` nor `lastActivityAt` is exactly
   * the population that trips the event cap, so admitting it here would grow the
   * calendar span on every resync while the bars stayed put.
   */
  it("does not extend a truncated axis to the sync-bump timestamp", () => {
    const window = resolveSessionTimelineWindow({
      ...staleEndedSource({ eventsTruncated: true }),
      endedAt: null,
      lastActivityAt: null,
      updatedAt: SYNC_BUMP_AT,
    });

    expect(window?.endMs).toBe(Date.parse(LAST_ROW_AT));
  });

  it("ignores a malformed tiling row rather than letting it widen the window", () => {
    const window = resolveSessionTimelineWindow(
      staleEndedSource({
        activitySegmentRows: [
          {
            confidence: 0.9,
            endMs: Number.NaN,
            evidenceLayers: [],
            phase: "implement",
            startMs: Number.NaN,
            version: 1,
          },
        ],
      })
    );

    expect(window).toEqual({
      startMs: Date.parse(FIRST_ROW_AT),
      endMs: Date.parse(LAST_ROW_AT),
    });
  });

  it("degrades to the lifecycle anchors when nothing is plotted (pre-backfill / version-skewed detail)", () => {
    // No transcript and no tiling: the ISS-4684 `max(endedAt, lastActivityAt)`
    // repair still applies, which is what keeps a pre-backfill row (whose
    // `lastActivityAt` collapsed onto `startedAt`) off a 1-minute scale.
    const window = resolveSessionTimelineWindow({
      endedAt: LAST_ACTIVITY_AT,
      lastActivityAt: STARTED_AT,
      startedAt: STARTED_AT,
      turnItems: [],
      updatedAt: LAST_ACTIVITY_AT,
    });

    expect(window).toEqual({
      startMs: Date.parse(STARTED_AT),
      endMs: Date.parse(LAST_ACTIVITY_AT),
    });
  });

  it("returns null when no bound is usable at all", () => {
    expect(
      resolveSessionTimelineWindow({
        endedAt: null,
        lastActivityAt: null,
        startedAt: null,
        turnItems: [],
        updatedAt: null,
      })
    ).toBeNull();
  });

  it("returns null rather than repairing an inverted window", () => {
    // A corrupt `endedAt` EARLIER than `startedAt` is nonsensical source data.
    // Clamping it to a zero-length window would plot the geometry against a
    // fabricated extent; `null` is the honest unknown, and it is also what the
    // prior per-call-site `endMs < startMs` guards did (no-op / ordinal).
    expect(
      resolveSessionTimelineWindow({
        endedAt: STARTED_AT,
        lastActivityAt: null,
        startedAt: LAST_ACTIVITY_AT,
        turnItems: [],
        updatedAt: null,
      })
    ).toBeNull();
  });
});

describe("getLimitDotPercent (ISS-4821)", () => {
  const session = staleEndedSource();

  it("places an event dated after a stale endedAt at its true fraction", () => {
    const window = resolveSessionTimelineWindow(staleEndedSource());

    // 09:30 → 12:30 is a 3h window; 11:00 sits half way through it.
    expect(getLimitDotPercent(window, session, POST_END_ROW_AT, 1)).toBeCloseTo(
      50,
      5
    );
  });

  it("clamped that same event to the right edge on the prior window — the reported bug", () => {
    expect(
      getLimitDotPercent(
        priorWindow(staleEndedSource()),
        session,
        POST_END_ROW_AT,
        1
      )
    ).toBe(100);
  });

  it("falls back to the transcript-row ordinal when the window is unusable", () => {
    // Three trace rows, asking for the last one ⇒ the final ordinal position.
    expect(getLimitDotPercent(null, session, POST_END_ROW_AT, 2)).toBe(100);
  });
});

describe("alignBucketRowsToTranscript (ISS-4821)", () => {
  it("spreads post-endedAt rows across the buckets instead of collapsing them into the last one", () => {
    const session = staleEndedSource();
    const window = resolveSessionTimelineWindow(staleEndedSource());

    const aligned = alignBucketRowsToTranscript(
      createActivityBuckets(4),
      session,
      window
    );

    // Rows at 09:30 / 11:00 / 12:30 over a 3h window land in buckets 0, 2 and 3,
    // so the repaired jump targets are distinct rather than all the final row.
    expect(aligned.map((bucket) => bucket.tl0)).toEqual([0, 0, 1, 2]);
  });

  it("is a no-op when the window is unusable", () => {
    const session = staleEndedSource();
    const buckets = idleBucketsOf(2);

    expect(alignBucketRowsToTranscript(buckets, session, null)).toBe(buckets);
  });
});

/*
 * FEA-3412 / FEA-3586, moved here by ISS-5999.
 *
 * These two cases used to be asserted through `AgentSessionDetailView` by
 * clicking one bar per source bin. ISS-5819's clock window has a 5-MINUTE floor,
 * and ISS-5999 made that window unconditional, so a run measured in minutes now
 * renders its bins as ONE column and per-slice clicks are no longer observable
 * on the page. The arithmetic is unchanged, and this is the function that owns
 * it — the view test keeps the wiring assertion that a repaired row reaches the
 * bar's `onJump` at all.
 *
 * `MINUTE_ROWS` is the shape the reporter hit: a transcript whose rows sit in
 * distinct one-minute slices, with `endedAt` overshooting the last of them.
 */
describe("alignBucketRowsToTranscript per-slice anchoring (FEA-3412 / FEA-3586)", () => {
  it("anchors each bar to the earliest row in its OWN slice", () => {
    const session = minuteSlicedSource();
    const window = resolveSessionTimelineWindow(session);

    const aligned = alignBucketRowsToTranscript(bucketsOf(3), session, window);

    // Rows at 12:01 / 12:02 / 12:03:30 over the real [12:01, 12:03:30] activity
    // span land in bins 0, 1 and 2 — never all in the first, and never the
    // overshooting `tl0: 999` the producer sent.
    expect(aligned.map((bucket) => bucket.tl0)).toEqual([0, 1, 2]);
  });

  it("buckets over the real activity span when endedAt overshoots it", () => {
    // The reported symptom: a stale end anchor 40m past the last row stretched
    // the bucket window, collapsing every row into bin 0 so bars past the first
    // forward-filled to the top of the transcript.
    const session = minuteSlicedSource({
      endedAt: "2026-06-10T12:44:00.000Z",
      lastActivityAt: "2026-06-10T12:44:00.000Z",
      updatedAt: "2026-06-10T12:44:00.000Z",
    });
    const window = resolveSessionTimelineWindow(session);

    const aligned = alignBucketRowsToTranscript(bucketsOf(3), session, window);

    expect(aligned.map((bucket) => bucket.tl0)).toEqual([0, 1, 2]);
  });

  it("still repairs a zero-duration session rather than leaving the raw index", () => {
    // The producer accepts a span of one instant and floors it at 1ms; bailing
    // on equality would leave `tl0: 999` in place and re-break every bar click.
    const instant = "2026-06-10T12:01:00.000Z";
    const session = minuteSlicedSource({
      endedAt: instant,
      lastActivityAt: instant,
      startedAt: instant,
      turnItems: [promptRow(0, instant)],
      updatedAt: instant,
    });
    const window = resolveSessionTimelineWindow(session);

    const aligned = alignBucketRowsToTranscript(bucketsOf(3), session, window);

    expect(aligned.map((bucket) => bucket.tl0)).toEqual([0, 0, 0]);
  });
});

/**
 * ISS-5124: the repair's two bail paths used to return the buckets untouched,
 * leaving the desktop producer's raw sync-time timeline-event index sitting in
 * `tl0`. That is not a transcript `_row`, but `tl0 != null` is the whole signal
 * the bar reads to announce `Jump to activity bucket …`, and the click then
 * resolves through `findTraceScrollTarget` ("greatest `[data-row]` ≤ row"), so
 * an overshooting index silently lands on the LAST rendered anchor — several
 * distinct bars collapsing onto one identical scroll position, which is what
 * the VQA pass measured across two sessions.
 */
describe("alignBucketRowsToTranscript unrepairable buckets (ISS-5124)", () => {
  it("demotes an unrepaired jump target instead of passing the raw sync index through, when the window is unusable", () => {
    const aligned = alignBucketRowsToTranscript(
      bucketsOf(3),
      staleEndedSource(),
      null
    );

    expect(aligned.map((bucket) => bucket.tl0)).toEqual([null, null, null]);
  });

  it("demotes an unrepaired jump target when the transcript carries no timed rows", () => {
    const window = resolveSessionTimelineWindow(staleEndedSource());
    const untimed: SessionTimelineWindowSource = { turnItems: [] };

    const aligned = alignBucketRowsToTranscript(
      bucketsOf(3),
      untimed,
      window ?? null
    );

    expect(aligned.map((bucket) => bucket.tl0)).toEqual([null, null, null]);
  });

  /*
   * The reported "distinct bars, one shared scroll target" signature is asserted
   * where it is observable — against a real click in
   * `session-timeline-unrepaired-bucket-jump.test.tsx`. Re-stating it here as a
   * third `window === null` case would exercise no additional branch: that guard
   * short-circuits before any bucket-count or forward-fill logic runs.
   */
  it("preserves every non-jump field while demoting", () => {
    const [demoted] = alignBucketRowsToTranscript(
      bucketsOf(1),
      staleEndedSource(),
      null
    );

    expect(demoted).toMatchObject({ key: "b-0", label: "0", total: 1 });
  });
});

/**
 * ISS-5137: where the axis window gets its phase-tiling bounds, and why they are
 * the tiling's WHOLE span.
 *
 * ISS-4833 filtered IDLE segments out of the candidate set. The reasoning was
 * sound in isolation — the desktop classifier's `deriveSessionBoundsMs` calls
 * `consider(session.endedAt)` unconditionally and `appendIdleTiling` closes the
 * tail with an IDLE segment running out to that bound, so unioning the raw span
 * carried a swept timestamp back in — but it silently broke the contract the
 * axis exists to hold. The "phases span …" caption one row beneath measures the
 * tiling INCLUDING its idle spans, so any leading or trailing idle segment made
 * the two adjacent captions state different numbers for the same session.
 *
 * The resolver now reads the projection's published span, so one derivation
 * feeds both captions. The structural sweeper guard survives only on the
 * NO-TILING case (pinned by the third test below) — narrower than the swept
 * desktop-synced population FEA-3594 was written about, since on any session
 * that has a tiling the swept `endedAt` re-enters through the tail idle pad.
 * What bounds that is measured, not assumed: see the swept-tiling geometry-cost
 * describe further down.
 */
describe("resolveSessionTimelineWindow phase-tiling bounds (ISS-5137)", () => {
  function idleRow(startAt: string, endAt: string): SyncedActivitySegmentRow {
    return {
      confidence: 0,
      endMs: Date.parse(endAt),
      evidenceLayers: [],
      phase: "idle",
      startMs: Date.parse(startAt),
      version: 1,
    };
  }

  function activeRow(startAt: string, endAt: string): SyncedActivitySegmentRow {
    return {
      confidence: 0.9,
      endMs: Date.parse(endAt),
      evidenceLayers: ["structural"],
      phase: "implement",
      startMs: Date.parse(startAt),
      version: 1,
    };
  }

  it("covers the tiling's idle tail, because the caption beneath the axis measures it too", () => {
    // ISS-5137, reversing ISS-4833's idle exclusion. The shape the classifier
    // emits: active work ending at the last row, then an idle segment closing
    // out to the session end. Excluding that pad made the axis print
    // `calendar span 18m 0s` directly above `phases span 20m 0s` on the same
    // session — the ISS-4791 two-contradicting-captions defect, one row apart —
    // and under-reported elapsed time on a label whose own words are "calendar
    // span". The projection's published span is the caption's SSOT, so the axis
    // reads it verbatim.
    const window = resolveSessionTimelineWindow(
      staleEndedSource({
        activitySegmentRows: [
          activeRow(FIRST_ROW_AT, LAST_ROW_AT),
          idleRow(LAST_ROW_AT, LAST_ACTIVITY_AT),
        ],
        endedAt: LAST_ACTIVITY_AT,
      })
    );

    expect(window?.endMs).toBe(Date.parse(LAST_ACTIVITY_AT));
  });

  it("covers the tiling's leading idle gap for the same reason", () => {
    const window = resolveSessionTimelineWindow(
      staleEndedSource({
        activitySegmentRows: [
          idleRow(STARTED_AT, FIRST_ROW_AT),
          activeRow(FIRST_ROW_AT, LAST_ROW_AT),
        ],
      })
    );

    expect(window?.startMs).toBe(Date.parse(STARTED_AT));
  });

  it("still keeps a swept endedAt out of the window when the session has NO tiling", () => {
    // ISS-5137 does not weaken FEA-3594's structural guard for the population it
    // was written for: with no `activitySegmentRows` there is no idle pad to
    // read, `endedAt` is not a candidate at all while plotted rows exist, and a
    // sweeper-stamped instant three hours past the last row cannot stretch the
    // axis. This is the case the exclusion was actually protecting.
    const window = resolveSessionTimelineWindow(
      staleEndedSource({
        activitySegmentRows: undefined,
        endedAt: LAST_ACTIVITY_AT,
      })
    );

    expect(window?.endMs).toBe(Date.parse(LAST_ROW_AT));
  });

  it("still unions an UNATTRIBUTED but observed phase span, which is not idle", () => {
    // `other`/unknown with no evidence renders as `unavailable` — the classifier
    // did observe that span, it just could not attribute it, so it still counts.
    const window = resolveSessionTimelineWindow(
      staleEndedSource({
        activitySegmentRows: [
          {
            confidence: 0,
            endMs: Date.parse(LAST_ACTIVITY_AT),
            evidenceLayers: [],
            phase: "other",
            startMs: Date.parse(LAST_ROW_AT),
            version: 1,
          },
        ],
      })
    );

    expect(window?.endMs).toBe(Date.parse(LAST_ACTIVITY_AT));
  });

  it("covers transcript rows past a TRUNCATED phase prefix, even though the caption then reports a smaller span", () => {
    // wongk review: a truncated tiling is a start-ordered PREFIX. The axis has to
    // cover everything drawn, so it legitimately exceeds the phase-only span the
    // "phases span …" caption formats. Pinned so the divergence is a documented
    // contract on the partial-data path rather than silent drift.
    const window = resolveSessionTimelineWindow(
      staleEndedSource({
        activitySegmentRows: [activeRow(FIRST_ROW_AT, POST_END_ROW_AT)],
        activitySegmentRowsTruncated: true,
      })
    );

    expect(window?.endMs).toBe(Date.parse(LAST_ROW_AT));
    expect(window?.endMs).toBeGreaterThan(Date.parse(POST_END_ROW_AT));
  });
});

/**
 * ISS-5137 stage review: what widening the window actually costs.
 *
 * The reconciliation was argued in terms of two captions, but this window is
 * also the geometry's denominator, so the review asked whether reading the
 * tiling's whole span moves rendered pixels rather than only text. It does, on
 * one of the two consumers and not the other, and on the swept population it
 * moves them to where the shipped flag-OFF path already puts them. All three
 * facts are pinned here so neither the docstring above nor a future reader has
 * to take the trade on trust.
 *
 * The fixture is the classifier's real swept shape: `deriveSessionBoundsMs`
 * unions `endedAt` and returns `max + 1`, and `appendIdleTiling` closes the tail
 * with an idle pad out to that bound whenever the gap clears
 * `ACTIVITY_IDLE_GAP_MS` (10 minutes) — here a 30-minute tail.
 */
describe("resolveSessionTimelineWindow swept-tiling geometry cost (ISS-5137)", () => {
  /** `deriveSessionBoundsMs` closes the tiling 1ms past the swept `endedAt`. */
  const SWEPT_SPAN_END_MS = Date.parse(LAST_ACTIVITY_AT) + 1;

  /** A swept session as the classifier tiles it: work, then an idle pad. */
  function sweptSource(): SessionTimelineWindowSource {
    return staleEndedSource({
      activitySegmentRows: [
        {
          confidence: 0.9,
          endMs: Date.parse(LAST_ROW_AT) + 1,
          evidenceLayers: ["structural"],
          phase: "implement",
          startMs: Date.parse(STARTED_AT),
          version: 1,
        },
        {
          confidence: 0,
          endMs: SWEPT_SPAN_END_MS,
          evidenceLayers: [],
          phase: "idle",
          startMs: Date.parse(LAST_ROW_AT) + 1,
          version: 1,
        },
      ],
      endedAt: LAST_ACTIVITY_AT,
    });
  }

  it("converges on the PRIOR window, so the geometry here is what already shipped", () => {
    // The bound on the cost. FEA-3594's guard is genuinely NARROWER after this
    // change — a swept `endedAt` re-enters through the tail idle pad — but on
    // exactly that population the resolved window lands on
    // `startedAt → endedAt`, which is what this surface rendered before
    // ISS-4833. The 1ms is `deriveSessionBoundsMs`' exclusive upper bound, not
    // slack.
    const session = sweptSource();
    const reconciled = resolveSessionTimelineWindow(session);
    const prior = priorWindow(session);

    expect(reconciled?.startMs).toBe(prior?.startMs);
    expect((reconciled?.endMs ?? 0) - (prior?.endMs ?? 0)).toBe(1);
  });

  it("compresses event dots toward the left edge, which the idle-exclusion window did not", () => {
    // The cost itself, recorded rather than implied: `getWindowPercent` divides
    // by `endMs - startMs`, so the last plotted row no longer sits at 100%.
    // Asserted against the no-tiling window (the same session with the pad
    // removed) so this fails if the pad ever stops reaching the axis.
    const swept = resolveSessionTimelineWindow(sweptSource());
    const withoutTiling = resolveSessionTimelineWindow(
      staleEndedSource({ activitySegmentRows: undefined })
    );

    expect(getWindowPercent(withoutTiling, LAST_ROW_AT)).toBe(100);
    // 3h30m of a 4h window. Approximate because the tiling's exclusive upper
    // bound makes the span 4h + 1ms, which is the same 1ms as above.
    expect(getWindowPercent(swept, LAST_ROW_AT)).toBeCloseTo(87.5, 4);
  });

  it("does NOT move bar-click jump targets, because the bucketing clamp is an identity here", () => {
    // The review's second consumer, disproved. `alignBucketRowsToTranscript`
    // buckets over the TIMED ROWS' own [min, max] clamped inside the window
    // (FEA-3586) — and this window is a union that already contains every one of
    // those rows, so both clamps are identities and widening it cannot reach the
    // bucketing. Eight bars, not four: window-driven bucketing would put the
    // first row in bar 1 rather than bar 0, so this would fail if the clamp ever
    // stopped biting.
    const session = sweptSource();
    const swept = alignBucketRowsToTranscript(
      createActivityBuckets(8),
      session,
      resolveSessionTimelineWindow(session)
    );
    const withoutTiling = alignBucketRowsToTranscript(
      createActivityBuckets(8),
      session,
      resolveSessionTimelineWindow(
        staleEndedSource({ activitySegmentRows: undefined })
      )
    );

    expect(swept.map((bucket) => bucket.tl0)).toEqual(
      withoutTiling.map((bucket) => bucket.tl0)
    );
    expect(swept[0].tl0).toBe(0);
  });
});

describe("getWindowPercent (persisted-geometry rebasing seam)", () => {
  const window = {
    endMs: Date.parse(LAST_ROW_AT),
    startMs: Date.parse(FIRST_ROW_AT),
  };

  it("places an absolute instant at its true fraction of the window", () => {
    expect(getWindowPercent(window, POST_END_ROW_AT)).toBeCloseTo(50, 5);
  });

  it("returns null — not a fabricated 0 — when the window or the instant is unusable", () => {
    expect(getWindowPercent(null, POST_END_ROW_AT)).toBeNull();
    // The desktop producer's relative clock offset is not an absolute instant.
    expect(getWindowPercent(window, "not-a-timestamp")).toBeNull();
    expect(
      getWindowPercent(
        { endMs: Date.parse(FIRST_ROW_AT), startMs: Date.parse(FIRST_ROW_AT) },
        FIRST_ROW_AT
      )
    ).toBeNull();
  });
});

/**
 * The window this surface plotted BEFORE ISS-4833: `startedAt → endedAt ??
 * updatedAt`, with the same inverted-window no-op guard. Reproduced here rather
 * than imported, because ISS-5366 retired the
 * `session-timeline-axis-reconciliation` gate and deleted the production
 * resolver along with it — but the two assertions above are about how the
 * CURRENT window relates to that historical one, so the comparison baseline is
 * test-owned now.
 */
function priorWindow(
  session: SessionTimelineWindowSource
): { endMs: number; startMs: number } | null {
  const startMs = Date.parse(String(session.startedAt ?? ""));
  const endMs = Date.parse(String(session.endedAt ?? session.updatedAt ?? ""));
  if (
    !(Number.isFinite(startMs) && Number.isFinite(endMs)) ||
    endMs < startMs
  ) {
    return null;
  }
  return { endMs, startMs };
}

/**
 * ISS-5124: buckets the producer already marked non-jumping. The repair has
 * nothing to demote on these, so it must hand back the very same array —
 * `buildActivityBuckets`' result feeds a memoized `jumpBlocks` upstream.
 */
function idleBucketsOf(count: number): ActivityBucket[] {
  return bucketsOf(count).map((bucket) => ({ ...bucket, tl0: null }));
}

/**
 * A transcript whose three rows sit in distinct one-minute slices — the FEA-3412
 * shape, where each bar must anchor to its own slice rather than collapsing onto
 * the top of the transcript.
 */
function minuteSlicedSource(
  overrides: Partial<SessionTimelineWindowSource> = {}
): SessionTimelineWindowSource {
  return {
    endedAt: "2026-06-10T12:03:30.000Z",
    lastActivityAt: "2026-06-10T12:03:30.000Z",
    startedAt: "2026-06-10T12:01:00.000Z",
    turnItems: [
      promptRow(0, "2026-06-10T12:01:00.000Z"),
      promptRow(1, "2026-06-10T12:02:00.000Z"),
      promptRow(2, "2026-06-10T12:03:30.000Z"),
    ],
    updatedAt: "2026-06-10T12:03:30.000Z",
    ...overrides,
  };
}
