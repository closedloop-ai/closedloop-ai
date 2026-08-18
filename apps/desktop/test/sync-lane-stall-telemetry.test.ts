/**
 * ISS-5973 coverage for the sync-lane stall monitored event.
 *
 * `describeStall` and `describeItemsRemaining` are not exported, so every case
 * drives them through the public {@link reportSyncLaneStall} and asserts on the
 * emitted event — which is also the boundary that matters, since the alert text
 * is what an operator reads.
 *
 * The version-skew cases are the point of the file: an absent or unrecognised
 * `kind` must still EMIT, falling back to the original ISS-5387 wording. Dropping
 * the alert over a field this build cannot read would be strictly worse than
 * describing it imprecisely.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Observability } from "../src/main/telemetry/observability.js";
import { reportSyncLaneStall } from "../src/main/telemetry/sync-lane-stall-telemetry.js";
import type { EnrichedTelemetryEvent } from "../src/main/telemetry/telemetry-service.js";
import { SyncLaneStallKind } from "../src/shared/sync-burndown-contract.js";

const STALL_CATEGORY = "sync.durable_cursor.stalled";
const NO_PROGRESS_RE = /is running with 2928 item\(s\) still owed/;
const NO_PROGRESS_ZERO_RE = /completed 0 unit\(s\)/;
const UNKNOWN_ITEMS_RE = /with unknown item\(s\) still owed/;
const LOWER_BOUND_ITEMS_RE = /with >=200 item\(s\) still owed/;
const EXACT_ITEMS_RE = /with 200 item\(s\) still owed/;
const CURSOR_FROZEN_RE = /durable cursor that did not advance/;
const NEVER_PERSISTED_RE = /never persisted/;
const STALE_AGE_RE = /5s stale/;

function captureStall(
  input: Parameters<typeof reportSyncLaneStall>[0]
): EnrichedTelemetryEvent[] {
  const events: EnrichedTelemetryEvent[] = [];
  Observability.init({ telemetrySend: (event) => events.push(event) });
  try {
    reportSyncLaneStall(input);
  } finally {
    Observability.reset();
  }
  return events;
}

describe("reportSyncLaneStall (ISS-5973)", () => {
  const baseInput = {
    lane: "session_metadata",
    workCompletedSincePrevious: 0,
    durableCursorAgeMs: 5000,
    deadLetteredCount: 0,
  };

  it("describes a no-progress stall by the backlog it is not draining", () => {
    const events = captureStall({
      ...baseInput,
      kind: SyncLaneStallKind.NoProgress,
      itemsRemaining: 2928,
    });

    assert.equal(events.length, 1);
    assert.equal(events[0]?.category, STALL_CATEGORY);
    assert.equal(events[0]?.severity, "error");
    assert.match(String(events[0]?.message), NO_PROGRESS_RE);
    assert.match(String(events[0]?.message), NO_PROGRESS_ZERO_RE);
  });

  it("reports an unmeasurable backlog as unknown, never a fabricated zero", () => {
    const events = captureStall({
      ...baseInput,
      kind: SyncLaneStallKind.NoProgress,
      itemsRemaining: null,
    });

    assert.match(String(events[0]?.message), UNKNOWN_ITEMS_RE);
  });

  it("marks a capped backlog as a FLOOR rather than an exact count", () => {
    // The invocation lane's template probe stops at 200. Printing that bare says
    // the queue holds exactly 200 items when a 3,500-session backfill is sitting
    // behind it — the same reassuring lie as a fabricated zero, in the one line
    // an operator sizes the incident from.
    const events = captureStall({
      ...baseInput,
      kind: SyncLaneStallKind.NoProgress,
      itemsRemaining: 200,
      itemsRemainingIsLowerBound: true,
    });

    assert.equal(events.length, 1);
    assert.match(String(events[0]?.message), LOWER_BOUND_ITEMS_RE);
  });

  it("prints an exact count bare when the probe did not cap", () => {
    // Absent means EXACT: a producer that predates the field must not have every
    // count decorated with a `>=` it has not earned.
    const events = captureStall({
      ...baseInput,
      kind: SyncLaneStallKind.NoProgress,
      itemsRemaining: 200,
    });

    assert.match(String(events[0]?.message), EXACT_ITEMS_RE);
    assert.doesNotMatch(String(events[0]?.message), LOWER_BOUND_ITEMS_RE);
  });

  it("keeps the cursor-frozen wording for a cursor-frozen stall", () => {
    const events = captureStall({
      ...baseInput,
      workCompletedSincePrevious: 50,
      kind: SyncLaneStallKind.CursorFrozen,
    });

    assert.match(String(events[0]?.message), CURSOR_FROZEN_RE);
    assert.match(String(events[0]?.message), STALE_AGE_RE);
  });

  it("still emits when kind is ABSENT, as a pre-ISS-5973 caller sends", () => {
    const events = captureStall({
      ...baseInput,
      workCompletedSincePrevious: 7,
    });

    assert.equal(events.length, 1, "an older caller must not lose its alert");
    assert.equal(events[0]?.category, STALL_CATEGORY);
    assert.match(String(events[0]?.message), CURSOR_FROZEN_RE);
  });

  it("still emits on an UNRECOGNISED kind from a newer build", () => {
    const events = captureStall({
      ...baseInput,
      workCompletedSincePrevious: 7,
      kind: "a_kind_this_build_has_never_heard_of",
    });

    assert.equal(
      events.length,
      1,
      "an unknown kind must degrade to the generic wording, not drop the alert"
    );
    assert.match(String(events[0]?.message), CURSOR_FROZEN_RE);
  });

  it("names a cursor that was never persisted rather than inventing an age", () => {
    const events = captureStall({
      ...baseInput,
      workCompletedSincePrevious: 7,
      durableCursorAgeMs: null,
    });

    assert.match(String(events[0]?.message), NEVER_PERSISTED_RE);
  });

  it("carries no content — only a lane id, counts, and an age", () => {
    const events = captureStall({
      ...baseInput,
      kind: SyncLaneStallKind.NoProgress,
      itemsRemaining: 2928,
    });

    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes("session-"), false);
    assert.equal(serialized.includes("/Users/"), false);
  });
});
