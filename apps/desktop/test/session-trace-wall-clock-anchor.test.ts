import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSessionTraceSyncFields } from "../src/main/database/session-trace.js";
import {
  baseSessionTraceInput as baseInput,
  traceTimelineRow as timelineRow,
  traceTokenEvent as tokenEvent,
} from "./session-trace-test-utils.js";

// FEA-3427: for an open (ended_at null) / long-lived session, wall-clock must be
// anchored to the LAST real activity timestamp (the timeline/token-event
// extent), NOT the mutable `updated_at` — which is bumped on every touch/re-sync
// and drifts days-to-weeks past the actual activity, overstating wall-time to
// "~480h" / "20 days". A genuinely-ended session (ended_at present) is
// unchanged; a session with no activity timestamps at all still falls back to
// `updated_at`.

test("open session anchors wall-clock to last activity, not the drifted updated_at", () => {
  // Started at 12:00; last real activity at 12:18 (18m of work). `updated_at`
  // sits 20 days later from re-syncs — it must NOT determine wall-clock.
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      endedAt: null,
      updatedAt: "2026-06-27T12:00:00.000Z",
      timelineRows: [
        timelineRow("2026-06-07T12:05:00.000Z"),
        timelineRow("2026-06-07T12:18:00.000Z"),
      ],
    })
  );
  // 18 minutes of activity span, not ~480h.
  assert.equal(fields.wallClock, "18m");
});

test("open session uses the token-event extent when it is the latest activity", () => {
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      endedAt: null,
      updatedAt: "2026-06-27T12:00:00.000Z",
      timelineRows: [timelineRow("2026-06-07T12:05:00.000Z")],
      // A token event 25m in is the last real activity.
      tokenEvents: [tokenEvent("2026-06-07T12:25:00.000Z")],
    })
  );
  assert.equal(fields.wallClock, "25m");
});

// ISS-5182: an ended session's wall-clock is bounded by `ended_at`, and
// activity recorded AFTER it cannot extend the span. This reverses FEA-3594,
// which preferred activity unconditionally as defense-in-depth against a
// sweeper that stamped `ended_at` with wall-clock time. FEA-3266/FEA-3580 then
// made both sweepers write `ended_at = last_activity_at` (i.e.
// `max(event.created_at)` frozen at the terminal transition), so the defect
// that flag guarded no longer exists — while the flag itself caused a worse
// one: `last_activity_at` keeps being recomputed at ingest after a session goes
// terminal, so preferring it re-measured finished sessions against a timestamp
// days past their own end.
test("ended session bounds wallClock by ended_at, ignoring later activity", () => {
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      endedAt: "2026-06-07T12:30:00.000Z",
      updatedAt: "2026-06-27T12:00:00.000Z",
      // 15m past the end. Under FEA-3594 this anchored the span (45m).
      timelineRows: [timelineRow("2026-06-07T12:45:00.000Z")],
    })
  );
  assert.equal(fields.wallClock, "30m");
});

// ISS-5131: the production row (`muscat - 0f02703d`) that reported a 31h
// session as 170h — a 5.5x inflation — verbatim. `ended_at` was frozen
// correctly at the terminal transition; `last_activity_at` then advanced six
// more days at ingest, and the activity-first anchor adopted it.
test("ISS-5131: six days of post-terminal activity drift cannot inflate wallClock", () => {
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-07-28T14:58:31.028Z",
      endedAt: "2026-07-29T22:02:53.365Z",
      updatedAt: "2026-08-04T17:58:39.726Z",
      timelineRows: [
        timelineRow("2026-07-29T20:00:00.000Z"),
        // The drifted last_activity_at, 6 days after the session ended.
        timelineRow("2026-08-04T17:28:37.425Z"),
      ],
    })
  );
  // The true agent span, not the 170h 30m the drifted anchor produced.
  assert.equal(fields.wallClock, "31h 4m");
});

test("open session with no activity falls back to updated_at", () => {
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      endedAt: null,
      updatedAt: "2026-06-07T12:07:00.000Z",
      timelineRows: [],
      tokenEvents: [],
    })
  );
  // No activity timestamps → last-resort updated_at anchor (7m).
  assert.equal(fields.wallClock, "7m");
});

// ISS-4447: the reported regression scenario — a large ended session whose
// `updated_at` is a POST-session re-sync bump ~1h past `ended_at`. Wall-clock
// must read the ~71.9h `ended_at` span, NOT the ~73h `updated_at` re-sync time
// (the pre-FEA-3427 fallback). Uses the real production numbers from session
// 019fa3f3-a556-7509-9c22-9b9a32655c4c: start 2026-07-24T19:19:… (rounded here to
// a clean start), ended 71h52m later, `updated_at` a further 68m45s of re-sync
// drift on top of that.
test("ISS-4447: ended session ignores the post-session updated_at re-sync bump", () => {
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-07-24T19:20:36.000Z",
      // ended_at / last_activity_at agree at 71h52m45s from start.
      endedAt: "2026-07-27T19:13:21.000Z",
      // updated_at is 68m54s LATER (a lastSyncedAt-adjacent re-sync touch) — the
      // value that yields the buggy 73h. It must NOT anchor wall-clock.
      updatedAt: "2026-07-27T20:22:15.000Z",
      // A late token event still trailing ended_at proves activity does not
      // override ended_at either (ended_at is authoritative when present).
      timelineRows: [timelineRow("2026-07-27T19:13:00.000Z")],
      tokenEvents: [tokenEvent("2026-07-27T19:13:20.000Z")],
    })
  );
  // 71h52m45s → floors to 71h 52m, NOT 73h.
  assert.equal(fields.wallClock, "71h 52m");
});
