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
  COMPONENT_INVOCATION_STORED_REBUILD_REVISION,
  DATA_REVISION,
} from "../src/main/collectors/engine/data-revision.js";
import {
  ACTIVITY_CLASSIFIER_VERSION,
  ACTIVITY_IDLE_GAP_MS,
  type ActivitySegmentRecord,
  activitySegmentId,
  classifyActivitySegments,
  deriveSessionBoundsMs,
  segmentIndexForMs,
} from "../src/main/collectors/parsing/activity-segment-classifier.js";
import { ACTIVITY_PHASE } from "../src/main/collectors/parsing/activity-taxonomy.js";
import { BUILTIN_TRANSCRIPT_SOURCES } from "../src/main/collectors/parsing/transcript-sources.js";
import {
  Harness,
  type NormalizedMessage,
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

test("AA-01: a late UNCATEGORIZED tool (null adapter category) anchors activity, not trailing idle", () => {
  // buildEvidenceTimeline drops tools the harness adapter cannot categorize
  // (TodoWrite / Task, and EVERY tool from an unknown harness), so anchoring idle on
  // the scored timeline alone would let a late uncategorized tool sit inside the new
  // trailing idle span and be mis-reported as dead time. AA-01 unions the RAW
  // session.toolUses timestamps into the anchor set, so the tool's instant counts as
  // observed activity regardless of whether the adapter recognized the tool name.
  const session = makeSession({
    sessionId: "late-uncategorized-tool",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:25:30.000Z",
    toolUses: [
      toolUse("Read", "2026-01-01T00:01:00.000Z"),
      // TodoWrite carries no structural category → absent from the scored timeline.
      toolUse("TodoWrite", "2026-01-01T00:25:00.000Z"),
    ],
  });
  const segments = classifyActivitySegments(session, Harness.Claude);
  assertContiguousComplete(segments, session);
  const todoMs = ms("2026-01-01T00:25:00.000Z");
  const idx = segmentIndexForMs(segments, todoMs);
  assert.notEqual(idx, -1, "the late tool instant is attributed to a segment");
  assert.notEqual(
    segments[idx].phase,
    ACTIVITY_PHASE.Idle,
    "the uncategorized tool anchors ACTIVE time, not swallowed by trailing idle"
  );
  // The dead ~24-minute gap BEFORE the tool is still idle — only the observed
  // instants (the early Read and the late TodoWrite) are active.
  assert.ok(
    segments.some((s) => s.phase === ACTIVITY_PHASE.Idle),
    "the pre-tool inactivity is still an idle gap"
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

test("no assumed plan-first order: a session may START in implement (FR-10)", () => {
  // The engine carries no plan→build→review prior — a debugging-first session can
  // open directly in `implement`. Under the state-aware model the trailing reads
  // then INHERIT that implement state (explore is only the LEADING orientation,
  // before the first strong phase), so the whole session tiles to implement rather
  // than spawning a fresh trailing `explore`.
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
  // Opens in implement (not a forced leading explore); the trailing sustained
  // reads INHERIT implement — but AA-05 marks the inherited window `carried`
  // rather than coalescing it, so the phase sequence is implement→implement
  // (same phase, distinct carried provenance), never a fresh trailing `explore`.
  assert.deepEqual(
    segments.map((s) => s.phase),
    [ACTIVITY_PHASE.Implement, ACTIVITY_PHASE.Implement],
    "opens in implement; trailing reads inherit it as a carried window"
  );
  // The inherited (carried) trailing window claims no first-hand evidence.
  assert.deepEqual(segments.at(-1)?.evidenceLayers, []);
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

test("FEA-4184: a bare-human → declared-plan transition is not absorbed by hysteresis (no retro-relabel)", () => {
  // wongk's case: a bare human tick (scores `other` — no plan-specific
  // declaration) followed by ONE declared-plan tick. With dwell = 2 the lone plan
  // tick used to be a transient, absorbed into the leading `other` run;
  // appendActiveSegments then rescored the COMBINED {human, DeclaredPlan} counts as
  // `plan`, relabelling the whole run from the human tick's start. The plan tick is
  // now a hard boundary, so the human region keeps its non-plan label and `plan`
  // begins exactly at the declaration.
  const session = makeSession({
    sessionId: "bare-human-then-plan",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:05:00.000Z",
    // a bare human turn (a plain prompt) BEFORE any plan is declared
    messages: [
      { role: "human", timestamp: "2026-01-01T00:01:00.000Z", text: null },
    ],
    // then the user actually declares a plan
    slashCommands: [
      { name: "create-plan", timestamp: "2026-01-01T00:01:30.000Z" },
    ],
  });
  const segments = classifyActivitySegments(session, Harness.Claude);
  assertContiguousComplete(segments, session);

  // The first (leading, pre-declaration) segment must NOT be `plan` — the bare
  // human turn is ambient steering, and the plan declaration must not reach back
  // and relabel it.
  assert.notEqual(
    segments[0].phase,
    ACTIVITY_PHASE.Plan,
    "the bare-human region before the declaration is never relabelled plan"
  );
  // A `plan` segment DOES appear, and it begins at/after the declaration instant
  // — never before it.
  const planSeg = segments.find((s) => s.phase === ACTIVITY_PHASE.Plan);
  assert.ok(planSeg, "the declared plan still produces a plan segment");
  assert.ok(
    planSeg.startMs >= ms("2026-01-01T00:01:30.000Z"),
    "plan begins at the declaration, not at the earlier bare-human turn"
  );
});

test("FEA-4184: a bare human turn with NO plan declaration never yields a plan segment", () => {
  // The default false-positive shape the bug produced: session-start human turns
  // with no plan-specific declaration must tile to explore/other, never plan.
  const session = makeSession({
    sessionId: "bare-human-only",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:05:00.000Z",
    messages: [
      { role: "human", timestamp: "2026-01-01T00:01:00.000Z", text: null },
      { role: "human", timestamp: "2026-01-01T00:02:00.000Z", text: null },
    ],
    // a GENERIC (non-plan) declaration must not gate plan either
    toolUses: [
      toolUse("mcp__closedloop__get-document", "2026-01-01T00:02:30.000Z"),
    ],
  });
  const segments = classifyActivitySegments(session, Harness.Claude);
  assert.ok(
    segments.every((s) => s.phase !== ACTIVITY_PHASE.Plan),
    "no plan segment without a plan-specific declaration"
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

// ── AA-01: idle anchored on the harness-blind union of ALL activity instants ──

function humanMsg(timestamp: string): NormalizedMessage {
  return { role: "human", timestamp, text: "…" };
}

test("AA-01: a zero-assistant-turn session detects idle from human-message instants", () => {
  // edac412f shape: no tokenSeries at all, only two human turns ~22 min apart.
  // Before AA-01 the idle-gap loop (sourced from tokenSeries only) never ran and
  // the whole span tiled active; now the human-message instants anchor the gap.
  // Uses NO tool vocabulary, so it proves idle detection with zero harness signal.
  const session = makeSession({
    sessionId: "human-only-idle",
    startedAt: "2026-06-26T14:11:57.859Z",
    endedAt: "2026-06-26T14:34:00.382Z",
    tokenSeries: [],
    userMessages: 2,
    messages: [
      humanMsg("2026-06-26T14:11:57.859Z"),
      humanMsg("2026-06-26T14:34:00.382Z"),
    ],
  });
  const segments = classifyActivitySegments(session, Harness.Claude);
  const idle = segments.filter((s) => s.phase === ACTIVITY_PHASE.Idle);
  assert.equal(
    idle.length,
    1,
    "the 22-minute dead gap is now a single idle span"
  );
  assert.ok(
    idle[0].endMs - idle[0].startMs >= ACTIVITY_IDLE_GAP_MS,
    "idle span clears the gap threshold"
  );
  assertContiguousComplete(segments, session);
});

for (const harness of [Harness.Claude, Harness.Codex]) {
  test(`AA-01: dead time AFTER the last activity instant tiles as trailing idle (${harness})`, () => {
    // f7441d99 shape: one turn, then the declared session end driven far past it by
    // trailing machine records. The tail must be idle, not swallowed by an active
    // segment. Runs for a non-Claude harness too — the union is harness-blind.
    const session = makeSession({
      sessionId: `tail-idle-${harness}`,
      startedAt: "2026-06-17T00:53:00.000Z",
      endedAt: "2026-06-17T01:53:00.000Z", // 59 min past the only turn
      tokenSeries: [turn("2026-06-17T00:54:00.000Z")],
    });
    const segments = classifyActivitySegments(session, harness);
    assert.equal(
      segments.at(-1)?.phase,
      ACTIVITY_PHASE.Idle,
      "the final segment is idle, not a multi-minute active tail"
    );
    assertContiguousComplete(segments, session);
  });
}

test("AA-01: dead time BEFORE the first activity instant tiles as leading idle", () => {
  // Declared start sits an hour before any observed activity.
  const session = makeSession({
    sessionId: "head-idle",
    startedAt: "2026-06-17T00:00:00.000Z",
    endedAt: "2026-06-17T01:00:30.000Z",
    tokenSeries: [turn("2026-06-17T01:00:00.000Z")], // first activity 60 min in
  });
  const segments = classifyActivitySegments(session, Harness.Claude);
  assert.equal(
    segments[0].phase,
    ACTIVITY_PHASE.Idle,
    "the leading hour of dead time is idle, not active"
  );
  assertContiguousComplete(segments, session);
});

// ── FEA-4184 (wongk): the classifier-version backfill enumerates only
// BUILTIN_TRANSCRIPT_SOURCES (Claude/Codex/Cursor), so Copilot/OpenCode re-tile
// through the DATA_REVISION-driven collector rebuild instead. These pin both
// halves of that routing so a future classifier bump can't silently strand
// Copilot/OpenCode on a stale version.

test("FEA-4184: the classifier re-tiles Copilot/OpenCode sessions at the current version", () => {
  // The collector rebuild re-imports a session and re-runs classifyActivitySegments
  // for EVERY harness — including the two the segment backfill can't reach. Prove
  // the classifier produces current-version segments for both, so a DATA_REVISION
  // rebuild lifts their stale v5 rows to v6.
  for (const harness of [Harness.Copilot, Harness.OpenCode]) {
    const session = makeSession({
      sessionId: `retile-${harness}`,
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:05:00.000Z",
      toolUses: [
        toolUse("patch", "2026-01-01T00:01:00.000Z"),
        toolUse("patch", "2026-01-01T00:02:00.000Z"),
      ],
    });
    const segments = classifyActivitySegments(session, harness);
    assertContiguousComplete(segments, session);
    assert.ok(
      segments.every((s) => s.version === ACTIVITY_CLASSIFIER_VERSION),
      `${harness} segments carry the current classifier version`
    );
  }
});

test("FEA-4184: Copilot/OpenCode are absent from the segment-backfill source list (the gap the DATA_REVISION bump covers)", () => {
  const backfillHarnesses = new Set(
    BUILTIN_TRANSCRIPT_SOURCES.map((s) => s.harness)
  );
  assert.ok(
    !backfillHarnesses.has(Harness.Copilot),
    "Copilot is not a BUILTIN_TRANSCRIPT_SOURCE — it can't be re-tiled by the classifier backfill"
  );
  assert.ok(
    !backfillHarnesses.has(Harness.OpenCode),
    "OpenCode is not a BUILTIN_TRANSCRIPT_SOURCE — it can't be re-tiled by the classifier backfill"
  );
  // …so the classifier bump MUST be paired with a DATA_REVISION bump that drives
  // the collector rebuild (which reprocesses every harness). Guard that the bump
  // advanced past the last rebuild-worthy revision, so the rebuild actually runs.
  assert.ok(
    DATA_REVISION > COMPONENT_INVOCATION_STORED_REBUILD_REVISION,
    "DATA_REVISION advanced so the collector rebuild reprocesses Copilot/OpenCode to the new classifier version"
  );
});
