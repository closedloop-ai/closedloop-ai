import assert from "node:assert/strict";
import { test } from "vitest";
import { buildSessionTraceSyncFields } from "../src/main/database/session-trace.js";
import {
  baseSessionTraceInput as baseInput,
  traceTimelineRow as timelineRow,
  traceTokenEvent as tokenEvent,
} from "./session-trace-test-utils.js";

/**
 * ISS-5850 (producer side): `span.startMs`/`span.endMs` must describe the SAME
 * interval the bins beside them tile.
 *
 * The consumer's whole coverage decision is an overlap test between a rendered
 * column and this pair (`resolveColumnCoverage`), so an extent that disagrees
 * with the emitted bins by even a millisecond is a bin the strip draws outside
 * the extent that produced it. These cases pin the agreement at both ends of the
 * input range: an ordinary multi-bin session, and the degenerate single-instant
 * one that is the only input where the floor in `durationMs` is observable.
 */

const ONE_INSTANT = "2026-06-07T12:00:00.000Z";
const ONE_INSTANT_MS = Date.parse(ONE_INSTANT);

test("the stated extent ends exactly where the last emitted bin ends", () => {
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
  const first = buckets.at(0);
  const last = buckets.at(-1);
  assert.ok(first && last, "expected the strip to carry bins");
  assert.equal(fields.span?.startMs, first.binStartMs);
  assert.equal(fields.span?.endMs, last.binEndMs);
});

test("a single-instant session states the FLOORED extent its one bin occupies", () => {
  /*
   * #5921 review (codex P2). Every usable timeline row and token event shares
   * one timestamp, so the raw activity window is zero-width — but a zero-width
   * strip cannot be drawn, so `durationMs` floors to 1ms and the producer emits
   * one bin ending a millisecond after it starts. Before the fix the span
   * reported the RAW window end, one millisecond short of that bin: the only
   * input in the whole space where the two disagreed, and the one where a
   * consumer sees a bin protruding past the extent that produced it.
   */
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: ONE_INSTANT,
      endedAt: "2026-06-07T13:00:00.000Z",
      updatedAt: "2026-06-07T13:00:00.000Z",
      timelineRows: [timelineRow(ONE_INSTANT)],
      tokenEvents: [tokenEvent(ONE_INSTANT)],
    })
  );

  const buckets = fields.activityBuckets ?? [];
  assert.equal(buckets.length, 1, "a zero-width window yields exactly one bin");
  const only = buckets[0];
  assert.ok(only, "expected the single bin");
  assert.equal(only.binStartMs, ONE_INSTANT_MS);
  assert.equal(only.binEndMs, ONE_INSTANT_MS + 1);

  assert.equal(fields.span?.startMs, ONE_INSTANT_MS);
  // The assertion that fails on the pre-fix `endMs: windowEndMs`.
  assert.equal(fields.span?.endMs, ONE_INSTANT_MS + 1);
});

test("a later-start session pins the extent to its first bin, not to startedAt", () => {
  const fields = buildSessionTraceSyncFields(
    baseInput({
      startedAt: "2026-06-07T12:00:00.000Z",
      endedAt: "2026-06-07T13:00:00.000Z",
      updatedAt: "2026-06-07T13:00:00.000Z",
      timelineRows: [
        timelineRow("2026-06-07T12:30:00.000Z"),
        timelineRow("2026-06-07T12:45:00.000Z"),
        timelineRow("2026-06-07T13:00:00.000Z"),
      ],
      tokenEvents: [
        tokenEvent("2026-06-07T12:30:00.000Z"),
        tokenEvent("2026-06-07T12:45:00.000Z"),
        tokenEvent("2026-06-07T13:00:00.000Z"),
      ],
    })
  );

  const buckets = fields.activityBuckets ?? [];
  const first = buckets.at(0);
  assert.ok(first, "expected at least one bin");
  assert.equal(fields.span?.startMs, first.binStartMs);
  assert.notEqual(
    fields.span?.startMs,
    Date.parse("2026-06-07T12:00:00.000Z"),
    "the extent must start at the first bin, not at startedAt"
  );
});
