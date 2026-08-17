/**
 * @file subagent-purpose.test.ts
 * @description FEA-2271 (PRD-488, Phase 2): deterministic tests for the subagent
 * purpose-attribution post-pass. Layers: (1) `classifySubagentPurpose` — one
 * wiring smoke test that a subagent's own tool evidence routes to a purpose (the
 * phase-mapping table itself is FEA-2269's `scoreWindow`, tested in
 * activity-scoring.test.ts, and is covered transitively by the span tests below);
 * (2) `computeSubagentSpans` — the claim map + span synthesis incl. the Q-007
 * parallel/collision tie-break and the skip-`other` gate; (3)
 * `applySubagentPurposeAttribution` — split/relabel/coalesce over hand-built
 * segments incl. idle preservation and the provenance marker; (4) end-to-end
 * through `classifyActivitySegments`, asserting FR-8 purpose re-attribution,
 * complete-tiling preservation, and graceful degradation. Every fixture is a
 * synthetic `NormalizedSession`; the classifier reads no DB (AGENTS.md: assert
 * observable behavior, not logs/timing).
 *
 * The re-PARTITION (not re-add) invariant (R11) is deliberately NOT re-asserted
 * here: the pure classifier never sums token amounts, so a re-add cannot occur at
 * this layer. It is guarded where it can actually break — the golden layer2
 * `token_events` byte-identical parity (over the subagent-bearing corpus sessions)
 * and the sqlite import test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { EvidenceLayer } from "../src/main/collectors/evidence/evidence-model.js";
import {
  ACTIVITY_CLASSIFIER_VERSION,
  type ActivitySegmentRecord,
  classifyActivitySegments,
  deriveSessionBoundsMs,
  segmentIndexForMs,
} from "../src/main/collectors/parsing/activity-segment-classifier.js";
import { ACTIVITY_PHASE } from "../src/main/collectors/parsing/activity-taxonomy.js";
import { CARRIED_CONFIDENCE } from "../src/main/collectors/parsing/phase-carry.js";
import {
  applySubagentPurposeAttribution,
  classifySubagentPurpose,
  computeSubagentSpans,
} from "../src/main/collectors/parsing/subagent-purpose.js";
import {
  Harness,
  type NormalizedSubagent,
  type NormalizedTokenRecord,
  type NormalizedToolUse,
} from "../src/main/collectors/types.js";
import { makeSession } from "./normalized-session-test-utils.js";

const ms = (iso: string): number => Date.parse(iso);

function editTool(timestamp: string, file = "/src/x.ts"): NormalizedToolUse {
  return { name: "Edit", timestamp, input: { file_path: file } };
}
function readTool(timestamp: string, file = "/src/x.ts"): NormalizedToolUse {
  return { name: "Read", timestamp, input: { file_path: file } };
}

/** One folded per-turn token record (amounts are irrelevant to the tiling). */
function turn(timestamp: string): NormalizedTokenRecord {
  return {
    timestamp,
    model: "test-model",
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
  };
}
function series(timestamps: string[]): NormalizedTokenRecord[] {
  return timestamps.map(turn);
}

/** A subagent carrying its own tool evidence + its own (folded) per-turn series. */
function sub(
  id: string,
  toolUses: NormalizedToolUse[],
  turnTimestamps: string[]
): NormalizedSubagent {
  return { id, name: id, toolUses, tokenSeries: series(turnTimestamps) };
}

// ── Layer 1: classifySubagentPurpose ─────────────────────────────────────────

test("purpose: a read/search-dominated subagent classifies to explore", () => {
  const purpose = classifySubagentPurpose(
    sub(
      "s1",
      [
        readTool("2026-01-01T00:04:00.000Z"),
        readTool("2026-01-01T00:04:30.000Z"),
      ],
      []
    ),
    Harness.Claude
  );
  assert.equal(purpose.phase, ACTIVITY_PHASE.Explore);
  assert.ok(purpose.confidence >= 0.5, "a clear read window is confident");
  assert.deepEqual(purpose.layers, [EvidenceLayer.Structural]);
});

// ── Layer 2: computeSubagentSpans ────────────────────────────────────────────

test("spans: one subagent's consecutive folded turns become one span at its purpose + subagentId", () => {
  const session = makeSession({
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:10:00.000Z",
    toolUses: [editTool("2026-01-01T00:01:00.000Z")],
    // parent series = main turn + the two folded subagent turns
    tokenSeries: series([
      "2026-01-01T00:01:00.000Z",
      "2026-01-01T00:04:00.000Z",
      "2026-01-01T00:05:00.000Z",
    ]),
    subagents: [
      sub(
        "a",
        [readTool("2026-01-01T00:04:00.000Z")],
        ["2026-01-01T00:04:00.000Z", "2026-01-01T00:05:00.000Z"]
      ),
    ],
  });
  const spans = computeSubagentSpans(session, Harness.Claude);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].subagentId, "a");
  assert.equal(spans[0].phase, ACTIVITY_PHASE.Explore);
  assert.equal(spans[0].startMs, ms("2026-01-01T00:04:00.000Z"));
  // endMs is one ms past the run's last turn (half-open, excludes the next turn)
  assert.equal(spans[0].endMs, ms("2026-01-01T00:05:00.000Z") + 1);
});

test("spans (Q-007): parallel subagents' interleaved turns are each attributed to their OWN subagent, never crossed", () => {
  const session = makeSession({
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:10:00.000Z",
    tokenSeries: series([
      "2026-01-01T00:04:00.000Z", // a
      "2026-01-01T00:05:00.000Z", // b
      "2026-01-01T00:06:00.000Z", // a
      "2026-01-01T00:07:00.000Z", // b
    ]),
    subagents: [
      sub(
        "a",
        [readTool("2026-01-01T00:04:00.000Z")],
        ["2026-01-01T00:04:00.000Z", "2026-01-01T00:06:00.000Z"]
      ),
      sub(
        "b",
        [editTool("2026-01-01T00:05:00.000Z")],
        ["2026-01-01T00:05:00.000Z", "2026-01-01T00:07:00.000Z"]
      ),
    ],
  });
  const spans = computeSubagentSpans(session, Harness.Claude);
  // a different owner between two of a subagent's turns breaks the run → 4 spans
  assert.equal(spans.length, 4);
  assert.deepEqual(
    spans.map((s) => [s.subagentId, s.phase]),
    [
      ["a", ACTIVITY_PHASE.Explore],
      ["b", ACTIVITY_PHASE.Implement],
      ["a", ACTIVITY_PHASE.Explore],
      ["b", ACTIVITY_PHASE.Implement],
    ]
  );
  // no span engulfs another owner's turn (strictly non-overlapping, ascending)
  for (let i = 1; i < spans.length; i++) {
    assert.ok(spans[i].startMs >= spans[i - 1].endMs, "non-overlapping");
  }
});

test("spans (Q-007 collision): two subagents sharing an identical turn ms break the tie by subagent id (smallest wins)", () => {
  const shared = "2026-01-01T00:05:00.000Z";
  const session = makeSession({
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:10:00.000Z",
    tokenSeries: series([shared]),
    subagents: [
      // declared out of id-order to prove the sort, not insertion order, decides
      sub("b", [editTool(shared)], [shared]),
      sub("a", [readTool(shared)], [shared]),
    ],
  });
  const spans = computeSubagentSpans(session, Harness.Claude);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].subagentId, "a", "smallest id claims the colliding ms");
  assert.equal(spans[0].phase, ACTIVITY_PHASE.Explore);
});

test("spans: consecutive same-purpose turns from DIFFERENT subagents coalesce into ONE span (anti-fragmentation), marked with the run's first contributor", () => {
  // Deliberate design (the fix for the delegation-heavy fragmentation defect):
  // spans group by PURPOSE PHASE, not by subagent id, so a run of consecutive
  // same-purpose turns from many different subagents collapses to one segment
  // instead of shattering into one-per-turn. The provenance marker is a single
  // representative — the run's FIRST contributor in time (the run head). Splitting
  // these by subagent id (or persisting multiple owners) is explicitly NOT done:
  // it re-introduces the fragmentation this collapse exists to prevent.
  const session = makeSession({
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:10:00.000Z",
    toolUses: [editTool("2026-01-01T00:01:00.000Z")],
    tokenSeries: series([
      "2026-01-01T00:01:00.000Z", // main
      "2026-01-01T00:04:00.000Z", // subagent b (explore)
      "2026-01-01T00:05:00.000Z", // subagent a (explore)
      "2026-01-01T00:08:00.000Z", // main (breaks the run)
    ]),
    subagents: [
      sub(
        "b",
        [readTool("2026-01-01T00:04:00.000Z")],
        ["2026-01-01T00:04:00.000Z"]
      ),
      sub(
        "a",
        [readTool("2026-01-01T00:05:00.000Z")],
        ["2026-01-01T00:05:00.000Z"]
      ),
    ],
  });
  const spans = computeSubagentSpans(session, Harness.Claude);
  assert.equal(
    spans.length,
    1,
    "same-phase turns from two subagents → one span"
  );
  assert.equal(spans[0].phase, ACTIVITY_PHASE.Explore);
  assert.equal(
    spans[0].subagentId,
    "b",
    "marker is the run head's contributor (b's turn is first in time)"
  );
  assert.equal(spans[0].startMs, ms("2026-01-01T00:04:00.000Z"));
  // run extends to the breaking main turn, absorbing the token-free gap between
  // the two subagent turns rather than leaving an empty main-phase sliver
  assert.equal(spans[0].endMs, ms("2026-01-01T00:08:00.000Z"));
});

test("spans: a subagent whose purpose is `other` claims nothing (spend stays in the main tiling)", () => {
  const session = makeSession({
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:10:00.000Z",
    tokenSeries: series(["2026-01-01T00:04:00.000Z"]),
    subagents: [sub("a", [], ["2026-01-01T00:04:00.000Z"])],
  });
  assert.deepEqual(computeSubagentSpans(session, Harness.Claude), []);
});

// ── Layer 3: applySubagentPurposeAttribution — relabel over hand-built tiling ──

const SESSION_END = ms("2026-01-01T00:10:00.000Z");

function seg(
  phase: ActivitySegmentRecord["phase"],
  startMs: number,
  endMs: number
): ActivitySegmentRecord {
  return {
    phase,
    startMs,
    endMs,
    confidence: 0.6,
    evidenceLayers: [EvidenceLayer.Structural],
    version: ACTIVITY_CLASSIFIER_VERSION,
  };
}

test("relabel: a subagent window is carved out of the main phase and stamped with its purpose + subagentId", () => {
  const session = makeSession({
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:10:00.000Z",
    tokenSeries: series([
      "2026-01-01T00:01:00.000Z",
      "2026-01-01T00:04:00.000Z",
      "2026-01-01T00:08:00.000Z",
    ]),
    subagents: [
      sub(
        "rev",
        [readTool("2026-01-01T00:04:00.000Z")],
        ["2026-01-01T00:04:00.000Z"]
      ),
    ],
  });
  const segments = [
    seg(ACTIVITY_PHASE.Implement, ms("2026-01-01T00:00:00.000Z"), SESSION_END),
  ];
  const out = applySubagentPurposeAttribution(
    segments,
    session,
    Harness.Claude
  );
  assert.deepEqual(
    out.map((s) => s.phase),
    [ACTIVITY_PHASE.Implement, ACTIVITY_PHASE.Explore, ACTIVITY_PHASE.Implement]
  );
  const carved = out.find((s) => s.phase === ACTIVITY_PHASE.Explore);
  assert.equal(carved?.subagentId, "rev", "carved segment carries provenance");
  assert.equal(
    out.filter((s) => s.phase === ACTIVITY_PHASE.Implement)[0].subagentId ??
      null,
    null,
    "untouched main segments have no subagent marker"
  );
});

test("relabel: an idle segment inside a subagent span is never split or relabelled", () => {
  const session = makeSession({
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:40:00.000Z",
    tokenSeries: series([
      "2026-01-01T00:04:00.000Z", // subagent turn
      "2026-01-01T00:35:00.000Z", // subagent turn after a >10min gap
    ]),
    subagents: [
      sub(
        "a",
        [
          readTool("2026-01-01T00:04:00.000Z"),
          readTool("2026-01-01T00:35:00.000Z"),
        ],
        ["2026-01-01T00:04:00.000Z", "2026-01-01T00:35:00.000Z"]
      ),
    ],
  });
  const segments = [
    seg(
      ACTIVITY_PHASE.Implement,
      ms("2026-01-01T00:00:00.000Z"),
      ms("2026-01-01T00:04:00.001Z")
    ),
    seg(
      ACTIVITY_PHASE.Idle,
      ms("2026-01-01T00:04:00.001Z"),
      ms("2026-01-01T00:35:00.000Z")
    ),
    seg(
      ACTIVITY_PHASE.Implement,
      ms("2026-01-01T00:35:00.000Z"),
      ms("2026-01-01T00:40:00.000Z")
    ),
  ];
  const out = applySubagentPurposeAttribution(
    segments,
    session,
    Harness.Claude
  );
  const idle = out.filter((s) => s.phase === ACTIVITY_PHASE.Idle);
  assert.equal(idle.length, 1, "idle survives unchanged");
  assert.equal(
    idle[0].subagentId ?? null,
    null,
    "idle never carries a subagent marker"
  );
  // the active slices on both sides of the idle gap flip to the subagent purpose
  assert.ok(
    out.some((s) => s.phase === ACTIVITY_PHASE.Explore && s.subagentId === "a")
  );
});

// ── Layer 4: end-to-end through classifyActivitySegments ─────────────────────

test("FR-8: a delegated read-only subagent inside an implement window is attributed to explore, not implement", () => {
  const session = makeSession({
    sessionId: "fea-2271-fr8",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:10:00.000Z",
    // main agent is implementing throughout
    toolUses: [
      editTool("2026-01-01T00:01:00.000Z"),
      editTool("2026-01-01T00:02:00.000Z"),
      editTool("2026-01-01T00:08:00.000Z"),
    ],
    tokenSeries: series([
      "2026-01-01T00:01:00.000Z",
      "2026-01-01T00:02:00.000Z",
      "2026-01-01T00:04:00.000Z", // subagent turn (folded)
      "2026-01-01T00:05:00.000Z", // subagent turn (folded)
      "2026-01-01T00:08:00.000Z",
    ]),
    subagents: [
      sub(
        "reviewer",
        [
          readTool("2026-01-01T00:04:00.000Z"),
          readTool("2026-01-01T00:05:00.000Z"),
        ],
        ["2026-01-01T00:04:00.000Z", "2026-01-01T00:05:00.000Z"]
      ),
    ],
  });
  const segments = classifyActivitySegments(session, Harness.Claude);
  // the subagent's own turns land in an explore segment with provenance…
  const idx = segmentIndexForMs(segments, ms("2026-01-01T00:04:30.000Z"));
  assert.equal(segments[idx].phase, ACTIVITY_PHASE.Explore);
  assert.equal(segments[idx].subagentId, "reviewer");
  // …while the surrounding main-agent spend stays implement (no marker)
  const before = segmentIndexForMs(segments, ms("2026-01-01T00:01:00.000Z"));
  const after = segmentIndexForMs(segments, ms("2026-01-01T00:08:00.000Z"));
  assert.equal(segments[before].phase, ACTIVITY_PHASE.Implement);
  assert.equal(segments[after].phase, ACTIVITY_PHASE.Implement);
  assert.equal(segments[before].subagentId ?? null, null);
});

test("complete-tiling preserved: contiguous, positive-width, spans the exact session bounds", () => {
  const session = makeSession({
    sessionId: "fea-2271-tiling",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:10:00.000Z",
    toolUses: [
      editTool("2026-01-01T00:01:00.000Z"),
      editTool("2026-01-01T00:08:00.000Z"),
    ],
    tokenSeries: series([
      "2026-01-01T00:01:00.000Z",
      "2026-01-01T00:04:00.000Z",
      "2026-01-01T00:08:00.000Z",
    ]),
    subagents: [
      sub(
        "a",
        [readTool("2026-01-01T00:04:00.000Z")],
        ["2026-01-01T00:04:00.000Z"]
      ),
    ],
  });
  const segments = classifyActivitySegments(session, Harness.Claude);
  const bounds = deriveSessionBoundsMs(session);
  assert.ok(bounds);
  assert.equal(segments[0].startMs, bounds.startMs);
  assert.equal(segments.at(-1)?.endMs, bounds.endMs);
  for (let i = 0; i < segments.length; i++) {
    assert.ok(segments[i].endMs > segments[i].startMs, "positive width");
    if (i + 1 < segments.length) {
      assert.equal(segments[i].endMs, segments[i + 1].startMs, "contiguous");
    }
  }
});

test("degradation: a session with no subagents is identical to the FEA-2269/2270 tiling (no-op)", () => {
  const base = {
    sessionId: "fea-2271-degrade",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:10:00.000Z",
    toolUses: [
      editTool("2026-01-01T00:01:00.000Z"),
      editTool("2026-01-01T00:08:00.000Z"),
    ],
    tokenSeries: series([
      "2026-01-01T00:01:00.000Z",
      "2026-01-01T00:08:00.000Z",
    ]),
  };
  const noSubs = makeSession(base);
  const withEmptySubs = makeSession({ ...base, subagents: [] });
  assert.deepEqual(
    classifyActivitySegments(noSubs, Harness.Claude),
    classifyActivitySegments(withEmptySubs, Harness.Claude)
  );
  // no segment carries a subagent marker when there are no subagents
  for (const s of classifyActivitySegments(noSubs, Harness.Claude)) {
    assert.equal(s.subagentId ?? null, null);
  }
});

test("degradation: a subagent whose series never folded into the parent leaves the tiling unchanged (safe)", () => {
  // subagent turns that are NOT present in the parent tokenSeries produce no
  // token rows to re-file; the pass must not crash or fabricate spend.
  const parentOnly = makeSession({
    sessionId: "fea-2271-unfolded",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:10:00.000Z",
    toolUses: [editTool("2026-01-01T00:01:00.000Z")],
    tokenSeries: series(["2026-01-01T00:01:00.000Z"]),
    subagents: [
      sub(
        "a",
        [readTool("2026-01-01T09:00:00.000Z")],
        ["2026-01-01T09:00:00.000Z"]
      ),
    ],
  });
  const segments = classifyActivitySegments(parentOnly, Harness.Claude);
  // the parent's only row stays attributed; no subagent marker was applied because
  // the subagent's turn ms is outside the tiling (never folded into the parent).
  assert.ok(segments.every((s) => s.subagentId == null));
  assert.equal(
    segmentIndexForMs(segments, ms("2026-01-01T00:01:00.000Z")) >= 0,
    true
  );
});

/**
 * A parent declaration a subagent inherits: the phase, and the confidence that
 * declaration itself carried — `0.9` is what a request-opened `review` scores.
 */
const DECLARING_CONFIDENCE = 0.9;
const DECLARED_REVIEW = {
  phase: ACTIVITY_PHASE.Review,
  confidence: DECLARING_CONFIDENCE,
};
const DECLARED_REWORK = {
  phase: ACTIVITY_PHASE.Rework,
  confidence: DECLARING_CONFIDENCE,
};

// ── AA-08: the declared-phase prior (PLN-1490 step 5) ───────────────────────
//
// A subagent's purpose is scored from its own tool mix, and that mix is
// read-dominated for exactly the delegations whose purpose is least ambiguous.
// Measured over the golden corpus, ALL 74 subagents scored `explore` (65) or
// `other` (9) — not one scored `review`, including two 18-agent review fleets.
// Reading code IS what reviewing looks like, so only the context a subagent was
// spawned into can tell the two apart.

test("AA-08: a read-dominated subagent inside a declared review is reviewing", () => {
  const reader = sub(
    "s1",
    [
      readTool("2026-01-01T00:04:00.000Z"),
      readTool("2026-01-01T00:04:30.000Z"),
    ],
    []
  );
  const own = classifySubagentPurpose(reader, Harness.Claude, null);
  assert.equal(own.phase, ACTIVITY_PHASE.Explore, "own evidence reads explore");

  const withPrior = classifySubagentPurpose(
    reader,
    Harness.Claude,
    DECLARED_REVIEW
  );
  assert.equal(withPrior.phase, ACTIVITY_PHASE.Review);
  assert.equal(
    withPrior.confidence,
    CARRIED_CONFIDENCE,
    "strength comes from the DECLARATION (0.9), capped at the carried ceiling — never from the score of the phase just discarded"
  );
  assert.deepEqual(
    withPrior.layers,
    [EvidenceLayer.Declared],
    "the layer records what produced the LABEL, and that was the parent's declaration"
  );
});

test("AA-08: an evidence-free subagent still reports the declaration's strength", () => {
  // The failure this pins: confidence used to be derived from the subagent's own
  // score for the phase it just discarded, and `scoreWindow` returns 0 for an
  // unreadable stream. So a review the user explicitly asked for rendered
  // "0% confidence" in the UI, which prints the number verbatim.
  const silent = sub("s1", [], []);
  const own = classifySubagentPurpose(silent, Harness.Claude, null);
  assert.deepEqual(own.layers, [], "no tool stream yields no evidence");
  assert.equal(own.confidence, 0, "and no confidence of its own");

  const withPrior = classifySubagentPurpose(
    silent,
    Harness.Claude,
    DECLARED_REVIEW
  );
  assert.equal(withPrior.phase, ACTIVITY_PHASE.Review);
  assert.equal(
    withPrior.confidence,
    CARRIED_CONFIDENCE,
    "the declaration's strength, not the discarded score's"
  );
  assert.deepEqual(withPrior.layers, [EvidenceLayer.Declared]);
});

test("AA-08: a WEAK declaration is not strengthened by inheritance", () => {
  // The cap is a ceiling, not a floor: a declaration weaker than the carried
  // ceiling passes through at its own strength.
  const weak = 0.3;
  const reader = sub("s1", [readTool("2026-01-01T00:04:00.000Z")], []);
  const withPrior = classifySubagentPurpose(reader, Harness.Claude, {
    phase: ACTIVITY_PHASE.Review,
    confidence: weak,
  });
  assert.equal(withPrior.confidence, weak);
});

test("AA-08: only the subagent's OWN ARGMAX contradicts the prior", () => {
  // This is the whole rule. Keying on "any source mutation" instead, one
  // reviewer carrying a single edit among 44 reads stayed `explore` while its 17
  // peers became `review`; because parallel fleet turns interleave and runs group
  // by purpose PHASE, that lone disagreement shattered 27 segments into 288.
  const mostlyReading = sub(
    "s1",
    [
      readTool("2026-01-01T00:04:00.000Z"),
      readTool("2026-01-01T00:04:10.000Z"),
      readTool("2026-01-01T00:04:20.000Z"),
      editTool("2026-01-01T00:04:30.000Z"),
    ],
    []
  );
  assert.equal(
    classifySubagentPurpose(mostlyReading, Harness.Claude, DECLARED_REVIEW)
      .phase,
    ACTIVITY_PHASE.Review,
    "one incidental edit is not evidence the agent was not reviewing"
  );

  const building = sub(
    "s2",
    [
      editTool("2026-01-01T00:05:00.000Z"),
      editTool("2026-01-01T00:05:10.000Z"),
      editTool("2026-01-01T00:05:20.000Z"),
    ],
    []
  );
  assert.equal(
    classifySubagentPurpose(building, Harness.Claude, DECLARED_REVIEW).phase,
    ACTIVITY_PHASE.Implement,
    "an agent whose own evidence argmaxes to implement was not reviewing"
  );
});

test("AA-08: a rework prior has no contradiction case", () => {
  // Editing is what rework IS, and a read-only helper inside a rework arc is
  // still doing rework.
  for (const tools of [
    [
      editTool("2026-01-01T00:05:00.000Z"),
      editTool("2026-01-01T00:05:10.000Z"),
    ],
    [readTool("2026-01-01T00:05:00.000Z")],
  ]) {
    assert.equal(
      classifySubagentPurpose(
        sub("s", tools, []),
        Harness.Claude,
        DECLARED_REWORK
      ).phase,
      ACTIVITY_PHASE.Rework
    );
  }
});

test("AA-08: with no prior, purpose is unchanged", () => {
  // Sessions with no declared review/rework must tile exactly as before.
  const reader = sub("s1", [readTool("2026-01-01T00:04:00.000Z")], []);
  const before = classifySubagentPurpose(reader, Harness.Claude);
  const explicitNull = classifySubagentPurpose(reader, Harness.Claude, null);
  assert.deepEqual(before, explicitNull);
  assert.equal(before.phase, ACTIVITY_PHASE.Explore);
});
