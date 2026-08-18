import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import { buildSessionTraceSyncFields } from "../src/main/database/session-trace.js";
import {
  baseSessionTraceInput as baseInput,
  traceTimelineRow as timelineRow,
  traceTokenEvent as tokenEvent,
} from "./session-trace-test-utils.js";

// FEA-3586: the session-detail timeline showed activity bars only for "the first
// hour" and rendered idle (cost 0) for everything after, and the green dot did
// not anchor to its time block. Root cause: the activity buckets/markers were
// distributed over the raw [startedAt, endedAt/updatedAt] window. When the end
// anchor overshoots the last real activity (a stale/orphan-swept `endedAt`, or a
// re-sync-bumped `updated_at`), `durationMs` dwarfs the active span, so every
// event's `floor((eventMs - startMs) / bucketMs)` collapses into the first
// bucket(s). Bucketing over the REAL activity extent spreads the bars across the
// full strip and keeps the markers anchored to their true position.

const bucketCost = (bucket: ActivityBucket): number =>
  bucket.cIn + bucket.cOut + bucket.cCache;

test("activity spreads across buckets when ended_at overshoots the last real activity", () => {
  // Real work spans 12:00 → 12:40 (40m). `ended_at` is set 10 HOURS later than
  // the last event — an overshooting end anchor. Pre-fix, every event floors
  // into bucket 0 and all later bars render idle ("no bars past the first hour").
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      endedAt: "2026-06-07T22:40:00.000Z",
      updatedAt: "2026-06-07T22:40:00.000Z",
      timelineRows: [
        timelineRow("2026-06-07T12:00:00.000Z"),
        timelineRow("2026-06-07T12:20:00.000Z"),
        timelineRow("2026-06-07T12:40:00.000Z"),
      ],
      tokenEvents: [
        tokenEvent("2026-06-07T12:00:00.000Z"),
        tokenEvent("2026-06-07T12:20:00.000Z"),
        tokenEvent("2026-06-07T12:40:00.000Z"),
      ],
    })
  );

  const buckets = fields.activityBuckets ?? [];
  assert.ok(buckets.length >= 3, "expected several buckets across the span");

  // Every bucket carries cost — activity fills the strip, not just bucket 0.
  const costed = buckets.filter((bucket) => bucketCost(bucket) > 0);
  assert.ok(
    costed.length >= 2,
    `expected activity past the first bucket, got ${costed.length} costed of ${buckets.length}`
  );

  // Specifically, the LAST bucket (the tail of the span) is not idle.
  const lastBucket = buckets.at(-1);
  assert.ok(lastBucket, "expected a last bucket");
  assert.ok(
    bucketCost(lastBucket) > 0,
    "the last bucket must carry the trailing activity, not render idle"
  );
});

test("markers anchor past x=0 across a multi-hour activity span", () => {
  // A prompt at the very start and a git commit ~2h in. The commit marker must
  // land near the far end of the strip, not collapse to x≈0.
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      // ended_at overshoots the last activity (12:00 + 2h = 14:00) by 6h.
      endedAt: "2026-06-07T20:00:00.000Z",
      updatedAt: "2026-06-07T20:00:00.000Z",
      timelineRows: [
        {
          eventType: "UserMessage",
          toolName: null,
          createdAt: "2026-06-07T12:00:00.000Z",
          label: "Prompt",
        },
        {
          eventType: "GitCommit",
          toolName: null,
          createdAt: "2026-06-07T14:00:00.000Z",
          label: "commit abc123",
        },
      ],
    })
  );

  const markers = fields.markers ?? [];
  const commit = markers.find((marker) => marker.kind === "commit");
  assert.ok(commit, "expected a commit marker");
  // Over the real 2h activity window the commit sits at the far end (~100%),
  // not compressed to the left by the 8h raw window.
  assert.ok(
    commit.x > 90,
    `commit marker should anchor near the end of its window, got x=${commit.x}`
  );
});

test("first-hour correctness is preserved for a session that actually ends on time", () => {
  // A genuinely-ended 40m session (ended_at == last activity). Activity should
  // still spread across the strip exactly as before the fix.
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      endedAt: "2026-06-07T12:40:00.000Z",
      updatedAt: "2026-06-07T12:40:00.000Z",
      timelineRows: [
        timelineRow("2026-06-07T12:00:00.000Z"),
        timelineRow("2026-06-07T12:20:00.000Z"),
        timelineRow("2026-06-07T12:40:00.000Z"),
      ],
      tokenEvents: [
        tokenEvent("2026-06-07T12:00:00.000Z"),
        tokenEvent("2026-06-07T12:20:00.000Z"),
        tokenEvent("2026-06-07T12:40:00.000Z"),
      ],
    })
  );

  const buckets = fields.activityBuckets ?? [];
  const costed = buckets.filter((bucket) => bucketCost(bucket) > 0);
  assert.ok(
    costed.length >= 2,
    "an on-time session must still distribute activity across buckets"
  );
});
