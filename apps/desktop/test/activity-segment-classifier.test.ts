/**
 * @file activity-segment-classifier.test.ts
 * @description FEA-2267 unit tests for the PURE activity-segment classifier:
 * determinism / byte-identical output, complete contiguous tiling, the Q-005
 * idle contract, deterministic hashed IDs, and the canonical boundary join.
 * No database — the classifier reads only a NormalizedSession.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  ACTIVITY_IDLE_GAP_MS,
  type ActivitySegmentRecord,
  activitySegmentId,
  classifyActivitySegments,
  deriveSessionBoundsMs,
  segmentIndexForMs,
} from "../src/main/collectors/parsing/activity-segment-classifier.js";
import { ACTIVITY_PHASE } from "../src/main/collectors/parsing/activity-taxonomy.js";
import {
  Harness,
  type NormalizedSession,
  type NormalizedTokenRecord,
} from "../src/main/collectors/types.js";
import { makeSession, toolUse } from "./normalized-session-test-utils.js";

const ms = (iso: string): number => Date.parse(iso);

function turn(timestamp: string): NormalizedTokenRecord {
  return {
    timestamp,
    model: "claude-sonnet-4-5",
    input: 100,
    output: 50,
    cacheRead: 10,
    cacheWrite: 5,
  };
}

// Asserts the tiling is complete (spans the derived session bounds), contiguous,
// and that EVERY segment — including the last — has positive width. Throws
// (rather than calling assert.* outside a test body) so biome's
// noMisplacedAssertion rule stays satisfied; a throw fails the calling test all
// the same. Expected bounds come from deriveSessionBoundsMs (the SSOT) so the
// helper does not hard-code the +1 upper-bound convention.
function assertContiguousComplete(
  segments: ActivitySegmentRecord[],
  session: NormalizedSession
): void {
  const bounds = deriveSessionBoundsMs(session);
  if (!bounds) {
    throw new Error("expected derivable session bounds");
  }
  if (segments.length === 0) {
    throw new Error("expected at least one segment");
  }
  if (segments[0].startMs !== bounds.startMs) {
    throw new Error(
      `first segment must start at ${bounds.startMs}, got ${segments[0].startMs}`
    );
  }
  const last = segments.at(-1);
  if (!last || last.endMs !== bounds.endMs) {
    throw new Error(
      `last segment must end at ${bounds.endMs}, got ${last?.endMs}`
    );
  }
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].endMs <= segments[i].startMs) {
      throw new Error(`segment ${i} must have positive width`);
    }
    if (
      i + 1 < segments.length &&
      segments[i].endMs !== segments[i + 1].startMs
    ) {
      throw new Error(
        `segment ${i} must abut segment ${i + 1} (no gap / no overlap)`
      );
    }
  }
}

test("classify is deterministic: identical input → byte-identical records + IDs", () => {
  const session = makeSession({
    sessionId: "det",
    startedAt: "2026-06-01T00:00:00.000Z",
    endedAt: "2026-06-01T00:25:00.000Z",
    tokenSeries: [
      turn("2026-06-01T00:01:00.000Z"),
      turn("2026-06-01T00:20:00.000Z"),
    ],
  });

  const first = classifyActivitySegments(session, Harness.Claude);
  const second = classifyActivitySegments(session, Harness.Claude);
  assert.deepEqual(first, second, "two runs must produce deep-equal records");

  const idsA = first.map((s) => activitySegmentId("det", s.startMs, s.version));
  const idsB = second.map((s) =>
    activitySegmentId("det", s.startMs, s.version)
  );
  assert.deepEqual(idsA, idsB, "hashed IDs must be stable across runs");
  assert.equal(
    new Set(idsA).size,
    idsA.length,
    "segment IDs are unique within a session (start_ms is the natural key)"
  );
});

test("activitySegmentId matches sha256(sessionId|startMs|version)[:16]", () => {
  const expected = createHash("sha256")
    .update("sess|1717200000000|1")
    .digest("hex")
    .slice(0, 16);
  assert.equal(activitySegmentId("sess", 1_717_200_000_000, 1), expected);
  assert.notEqual(
    activitySegmentId("sess", 1, 1),
    activitySegmentId("sess", 2, 1),
    "different start_ms → different id"
  );
});

test("empty token series → a single `other` segment spanning [startMs, endMs)", () => {
  const session = makeSession({
    sessionId: "empty",
    startedAt: "2026-06-01T00:00:00.000Z",
    endedAt: "2026-06-01T00:05:00.000Z",
    tokenSeries: [],
  });
  const segments = classifyActivitySegments(session, Harness.Claude);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].phase, ACTIVITY_PHASE.Other);
  assertContiguousComplete(segments, session);
});

test("turns within the idle threshold → one contiguous `other` segment", () => {
  const session = makeSession({
    sessionId: "active",
    startedAt: "2026-06-01T00:00:00.000Z",
    endedAt: "2026-06-01T00:05:00.000Z",
    tokenSeries: [
      turn("2026-06-01T00:01:00.000Z"),
      turn("2026-06-01T00:02:00.000Z"),
      turn("2026-06-01T00:03:00.000Z"),
    ],
  });
  const segments = classifyActivitySegments(session, Harness.Claude);
  assert.equal(segments.length, 1, "no gap exceeds the threshold");
  assert.equal(segments[0].phase, ACTIVITY_PHASE.Other);
  assertContiguousComplete(segments, session);
  // every turn lands in the single segment
  for (const t of session.tokenSeries) {
    assert.equal(segmentIndexForMs(segments, ms(t.timestamp)), 0);
  }
});

test("inter-turn gap ≥ threshold → first-class `idle` segment between two `other` neighbours", () => {
  const session = makeSession({
    sessionId: "idle",
    startedAt: "2026-06-01T00:00:00.000Z",
    endedAt: "2026-06-01T00:25:00.000Z",
    tokenSeries: [
      turn("2026-06-01T00:01:00.000Z"),
      // 19-minute gap (> ACTIVITY_IDLE_GAP_MS) before the next turn
      turn("2026-06-01T00:20:00.000Z"),
    ],
  });
  const segments = classifyActivitySegments(session, Harness.Claude);
  assert.deepEqual(
    segments.map((s) => s.phase),
    [ACTIVITY_PHASE.Other, ACTIVITY_PHASE.Idle, ACTIVITY_PHASE.Other],
    "idle is its own labelled kind, flanked by active segments"
  );
  assertContiguousComplete(segments, session);

  const idle = segments[1];
  assert.ok(
    idle.endMs - idle.startMs >= ACTIVITY_IDLE_GAP_MS,
    "idle span covers the inactivity gap"
  );
  // The idle span contains NEITHER turn → it carries no token spend.
  const turnA = ms("2026-06-01T00:01:00.000Z");
  const turnB = ms("2026-06-01T00:20:00.000Z");
  assert.equal(segmentIndexForMs(segments, turnA), 0, "pre-gap turn is active");
  assert.equal(
    segmentIndexForMs(segments, turnB),
    2,
    "post-gap turn is active"
  );
  assert.ok(
    !(turnA >= idle.startMs && turnA < idle.endMs),
    "turn A is not inside the idle span"
  );
  assert.ok(
    !(turnB >= idle.startMs && turnB < idle.endMs),
    "turn B is not inside the idle span"
  );
});

test("segmentIndexForMs resolves the exclusive endMs to the last segment (inclusive arm)", () => {
  // A real turn never sits on endMs (it is one ms past the latest timestamp),
  // but a caller may probe exactly at the exclusive bound; the last-segment-
  // inclusive arm must still resolve it rather than drop it.
  const session = makeSession({
    sessionId: "boundary",
    startedAt: "2026-06-01T00:00:00.000Z",
    endedAt: "2026-06-01T00:05:00.000Z",
    tokenSeries: [
      turn("2026-06-01T00:01:00.000Z"),
      turn("2026-06-01T00:05:00.000Z"),
    ],
  });
  const segments = classifyActivitySegments(session, Harness.Claude);
  const bounds = deriveSessionBoundsMs(session);
  assert.ok(bounds);
  assert.equal(segments.at(-1)?.endMs, bounds.endMs);
  assert.equal(
    segmentIndexForMs(segments, bounds.endMs),
    segments.length - 1,
    "probing at the exclusive endMs resolves to the last segment"
  );
  assert.equal(
    segmentIndexForMs(segments, bounds.startMs - 1),
    -1,
    "a timestamp before the first segment is unattributed"
  );
});

test("idle gap before a final turn at the session end → positive-width final segment (no zero-width row)", () => {
  // The reviewer's corner: endedAt == the last turn AND a >10-min gap precedes
  // it. The +1 upper bound keeps the trailing active segment non-empty so no
  // start_ms === end_ms row is persisted, and the last turn stays active (idle
  // is never the final segment).
  const session = makeSession({
    sessionId: "tail-idle",
    startedAt: "2026-06-01T00:00:00.000Z",
    endedAt: "2026-06-01T00:20:00.000Z",
    tokenSeries: [
      turn("2026-06-01T00:00:00.000Z"),
      // 20-minute gap (> ACTIVITY_IDLE_GAP_MS) then the final turn AT endedAt
      turn("2026-06-01T00:20:00.000Z"),
    ],
  });
  const segments = classifyActivitySegments(session, Harness.Claude);
  assert.deepEqual(
    segments.map((s) => s.phase),
    [ACTIVITY_PHASE.Other, ACTIVITY_PHASE.Idle, ACTIVITY_PHASE.Other]
  );
  assertContiguousComplete(segments, session); // also asserts every segment > 0 width
  const lastTurn = ms("2026-06-01T00:20:00.000Z");
  assert.equal(
    segmentIndexForMs(segments, lastTurn),
    2,
    "the final turn is attributed to the trailing active segment, not idle"
  );
});

test("deriveSessionBoundsMs encloses declared + observed timestamps; null when none parse", () => {
  const session = makeSession({
    sessionId: "bounds",
    startedAt: "2026-06-01T00:10:00.000Z",
    endedAt: "2026-06-01T00:12:00.000Z",
    // a turn EARLIER than startedAt and LATER than endedAt must widen the span
    tokenSeries: [
      turn("2026-06-01T00:00:00.000Z"),
      turn("2026-06-01T00:30:00.000Z"),
    ],
  });
  const bounds = deriveSessionBoundsMs(session);
  assert.deepEqual(bounds, {
    startMs: ms("2026-06-01T00:00:00.000Z"),
    // endMs is one ms past the latest observed timestamp (see deriveSessionBoundsMs).
    endMs: ms("2026-06-01T00:30:00.000Z") + 1,
  });

  const undated = makeSession({
    sessionId: "undated",
    startedAt: null,
    endedAt: null,
    tokenSeries: [],
  });
  assert.equal(deriveSessionBoundsMs(undated), null);
  assert.deepEqual(classifyActivitySegments(undated, Harness.Claude), []);
});

// ── FEA-2269: the real structural classifier over the FEA-2268 evidence timeline.
// These sessions carry no tokenSeries, so bounds come from startedAt/endedAt and
// the whole session is one active span; toolUses/messages/slashCommands drive the
// windowing. (The stub-era tests above — token-only sessions — still classify to
// `other`/`idle` because they carry no tool/message evidence.)

test("real classifier: explore then implement never collapse into one label (AC-002)", () => {
  const session = makeSession({
    sessionId: "plan-build",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:05:00.000Z",
    toolUses: [
      toolUse("Read", "2026-01-01T00:01:00.000Z"),
      toolUse("Grep", "2026-01-01T00:01:30.000Z"),
      toolUse("Read", "2026-01-01T00:02:00.000Z"),
      toolUse("Edit", "2026-01-01T00:03:00.000Z"),
      toolUse("Write", "2026-01-01T00:03:30.000Z"),
      toolUse("Edit", "2026-01-01T00:04:00.000Z"),
    ],
  });
  const segments = classifyActivitySegments(session, Harness.Claude);
  assert.deepEqual(
    segments.map((s) => s.phase),
    [ACTIVITY_PHASE.Explore, ACTIVITY_PHASE.Implement],
    "read-heavy region and mutate region stay distinct adjacent windows"
  );
  assertContiguousComplete(segments, session);
  // Deterministic: identical input → byte-identical records.
  assert.deepEqual(classifyActivitySegments(session, Harness.Claude), segments);
});

test("pure-planning session: no fabricated implement; declared provenance recorded (AC-002.3, FR-7)", () => {
  const session = makeSession({
    sessionId: "pure-plan",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:05:00.000Z",
    slashCommands: [{ name: "plan", timestamp: "2026-01-01T00:00:30.000Z" }],
    messages: [
      { role: "human", timestamp: "2026-01-01T00:01:00.000Z", text: null },
      { role: "human", timestamp: "2026-01-01T00:02:00.000Z", text: null },
      { role: "human", timestamp: "2026-01-01T00:03:00.000Z", text: null },
    ],
    toolUses: [toolUse("Read", "2026-01-01T00:01:30.000Z")],
  });
  const segments = classifyActivitySegments(session, Harness.Claude);
  assert.ok(
    segments.every((s) => s.phase !== ACTIVITY_PHASE.Implement),
    "no implement window is fabricated without any code mutation"
  );
  assert.ok(
    segments.some((s) => s.evidenceLayers.includes("declared")),
    "the declared plan signal surfaces as declared provenance"
  );
  assertContiguousComplete(segments, session);
});

test("no assumed order: implement before explore stays two distinct windows (FR-10)", () => {
  const session = makeSession({
    sessionId: "debug-first",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:05:00.000Z",
    toolUses: [
      toolUse("Edit", "2026-01-01T00:01:00.000Z"),
      toolUse("Edit", "2026-01-01T00:01:30.000Z"),
      toolUse("Read", "2026-01-01T00:03:00.000Z"),
      toolUse("Grep", "2026-01-01T00:03:30.000Z"),
    ],
  });
  const segments = classifyActivitySegments(session, Harness.Claude);
  assert.deepEqual(
    segments.map((s) => s.phase),
    [ACTIVITY_PHASE.Implement, ACTIVITY_PHASE.Explore],
    "the engine carries no plan→build→review prior"
  );
  assertContiguousComplete(segments, session);
});

test("hysteresis: a lone off-pattern turn inside a burst does not open a new window", () => {
  const session = makeSession({
    sessionId: "hysteresis",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:05:00.000Z",
    toolUses: [
      toolUse("Edit", "2026-01-01T00:01:00.000Z"),
      toolUse("Edit", "2026-01-01T00:01:30.000Z"),
      // one Read in the middle of a sustained implement burst
      toolUse("Read", "2026-01-01T00:02:00.000Z"),
      toolUse("Edit", "2026-01-01T00:02:30.000Z"),
      toolUse("Edit", "2026-01-01T00:03:00.000Z"),
    ],
  });
  const segments = classifyActivitySegments(session, Harness.Claude);
  assert.deepEqual(
    segments.map((s) => s.phase),
    [ACTIVITY_PHASE.Implement],
    "the transient Read is absorbed, not split into its own window"
  );
  assertContiguousComplete(segments, session);
});

test("ambiguous window (read + mutate tie) lands in explicit `other` below the floor (AC-005)", () => {
  const session = makeSession({
    sessionId: "ambiguous",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:05:00.000Z",
    // a Read and an Edit at the SAME ms → one near-tie tick
    toolUses: [
      toolUse("Read", "2026-01-01T00:02:00.000Z"),
      toolUse("Edit", "2026-01-01T00:02:00.000Z"),
    ],
  });
  const segments = classifyActivitySegments(session, Harness.Claude);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].phase, ACTIVITY_PHASE.Other);
  assert.ok(
    segments[0].confidence < 0.5,
    "other carries its sub-floor confidence, never force-fit"
  );
  assertContiguousComplete(segments, session);
});

test("a compaction marker does not split or relabel a window", () => {
  const base = {
    sessionId: "compaction",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:05:00.000Z",
    toolUses: [
      toolUse("Edit", "2026-01-01T00:01:00.000Z"),
      toolUse("Edit", "2026-01-01T00:02:00.000Z"),
      toolUse("Edit", "2026-01-01T00:03:00.000Z"),
    ],
  };
  const withoutCompaction = classifyActivitySegments(
    makeSession(base),
    Harness.Claude
  );
  const withCompaction = classifyActivitySegments(
    makeSession({
      ...base,
      compactions: [{ timestamp: "2026-01-01T00:02:30.000Z" }],
    }),
    Harness.Claude
  );
  assert.deepEqual(
    withCompaction,
    withoutCompaction,
    "compactions are not evidence — the tiling is identical with or without one"
  );
  assert.deepEqual(
    withoutCompaction.map((s) => s.phase),
    [ACTIVITY_PHASE.Implement]
  );
});
