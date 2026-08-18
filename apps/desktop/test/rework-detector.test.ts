/**
 * @file rework-detector.test.ts
 * @description FEA-2270 (PRD-488, Story 3): deterministic tests for the in-session
 * review→fix rework post-pass. Three layers: (1) `computeReworkSpans` — the pure
 * review-intent entry/exit span logic + cue precision; (2) `applyReworkDetection`
 * — the relabel + the ≥1-edit honest-zero gate over hand-built segments; (3)
 * end-to-end through `classifyActivitySegments`, asserting observable phase output
 * (no timing/log assertions, per AGENTS.md). Every fixture is a synthetic
 * `NormalizedSession`; the classifier reads no DB.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EvidenceLayer,
  type EvidenceUnit,
  ToolCategory,
} from "../src/main/collectors/evidence/evidence-model.js";
import {
  ACTIVITY_CLASSIFIER_VERSION,
  type ActivitySegmentRecord,
  classifyActivitySegments,
  deriveSessionBoundsMs,
} from "../src/main/collectors/parsing/activity-segment-classifier.js";
import { ACTIVITY_PHASE } from "../src/main/collectors/parsing/activity-taxonomy.js";
import {
  applyReworkDetection,
  computeReworkSpans,
  isReviewFixPrompt,
  REWORK_CONFIDENCE_PROMPT,
} from "../src/main/collectors/parsing/rework-detector.js";
import {
  Harness,
  type NormalizedMessage,
  type NormalizedToolUse,
} from "../src/main/collectors/types.js";
import { makeSession } from "./normalized-session-test-utils.js";

const ms = (iso: string): number => Date.parse(iso);

function humanMsg(text: string, timestamp: string): NormalizedMessage {
  return { role: "human", timestamp, text };
}
function editTool(timestamp: string, file = "/src/x.ts"): NormalizedToolUse {
  return { name: "Edit", timestamp, input: { file_path: file } };
}
function readTool(timestamp: string, file = "/src/x.ts"): NormalizedToolUse {
  return { name: "Read", timestamp, input: { file_path: file } };
}
function bashTool(timestamp: string, command: string): NormalizedToolUse {
  return { name: "Bash", timestamp, input: { command } };
}
function mutateUnit(timestamp: string): EvidenceUnit {
  return {
    ms: ms(timestamp),
    category: ToolCategory.MutateCode,
    layer: EvidenceLayer.Structural,
  };
}
function readUnit(timestamp: string): EvidenceUnit {
  return {
    ms: ms(timestamp),
    category: ToolCategory.ReadSearch,
    layer: EvidenceLayer.Structural,
  };
}

const SESSION_END = ms("2026-01-01T01:00:00.000Z");

// ── Layer 1: computeReworkSpans — entry/exit span logic ──────────────────────

test("no review-intent signal → no spans (honest zero source)", () => {
  const session = makeSession({
    messages: [
      humanMsg(
        "let's build the pagination feature",
        "2026-01-01T00:01:00.000Z"
      ),
    ],
    toolUses: [editTool("2026-01-01T00:02:00.000Z")],
  });
  assert.deepEqual(computeReworkSpans(session, SESSION_END), []);
});

test("address-review prompt opens a span running to session end (no exit prompt)", () => {
  const session = makeSession({
    messages: [
      humanMsg(
        "evaluate the following code review comments",
        "2026-01-01T00:10:00.000Z"
      ),
    ],
  });
  const spans = computeReworkSpans(session, SESSION_END);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].startMs, ms("2026-01-01T00:10:00.000Z"));
  assert.equal(spans[0].endMs, SESSION_END);
  assert.equal(spans[0].confidence, REWORK_CONFIDENCE_PROMPT);
  assert.deepEqual(spans[0].layers, [
    EvidenceLayer.Declared,
    EvidenceLayer.Structural,
  ]);
});

test("a later non-review prompt closes the span (new work resumes)", () => {
  const session = makeSession({
    messages: [
      humanMsg("address the review comments", "2026-01-01T00:10:00.000Z"),
      humanMsg(
        "now add a pagination control to the list",
        "2026-01-01T00:20:00.000Z"
      ),
    ],
  });
  const spans = computeReworkSpans(session, SESSION_END);
  assert.equal(spans.length, 1);
  assert.deepEqual(
    [spans[0].startMs, spans[0].endMs],
    [ms("2026-01-01T00:10:00.000Z"), ms("2026-01-01T00:20:00.000Z")]
  );
});

test("a follow-up address-review prompt EXTENDS the same span, not a new one", () => {
  const session = makeSession({
    messages: [
      humanMsg("address the review comments", "2026-01-01T00:10:00.000Z"),
      humanMsg(
        "also address the remaining PR comments",
        "2026-01-01T00:20:00.000Z"
      ),
    ],
  });
  const spans = computeReworkSpans(session, SESSION_END);
  assert.equal(spans.length, 1, "consecutive review prompts stay one span");
  assert.equal(spans[0].endMs, SESSION_END);
});

test("a review command/skill does NOT open a rework span (it is a review REQUEST, not rework)", () => {
  // State-aware model (PRD-488): a request to PERFORM a review establishes the
  // `review` phase (review-intent-detector.ts + the carry pass), never `rework`.
  // rework-detector no longer reads slash commands or skills at all.
  const command = makeSession({
    slashCommands: [
      { name: "code-review", timestamp: "2026-01-01T00:05:00.000Z" },
    ],
  });
  assert.deepEqual(computeReworkSpans(command, SESSION_END), []);

  const skill = makeSession({
    skills: [
      { name: "security-review", timestamp: "2026-01-01T00:05:00.000Z" },
    ],
  });
  assert.deepEqual(computeReworkSpans(skill, SESSION_END), []);

  const preview = makeSession({
    slashCommands: [{ name: "preview", timestamp: "2026-01-01T00:05:00.000Z" }],
  });
  assert.deepEqual(computeReworkSpans(preview, SESSION_END), []);
});

test("a PR-open (`gh pr create`) does NOT open a rework span (git-lifecycle is ambient)", () => {
  // A `gh pr create` is git-lifecycle; the state-aware model treats it as AMBIENT
  // (it inherits the current phase in the carry pass), never a rework trigger.
  const session = makeSession({
    toolUses: [bashTool("2026-01-01T00:05:00.000Z", "gh pr create --fill")],
  });
  assert.deepEqual(computeReworkSpans(session, SESSION_END), []);
});

test("tie-break: at an identical ms the exit closes the prior span before a new enter opens", () => {
  // span1 opens at 00:05; at 00:10 a non-review prompt (exit) and an address-review
  // prompt (enter) share the exact same timestamp. BOUNDARY_KIND_RANK sorts exit
  // before enter, so span1 must close at 00:10 and a fresh span open there.
  const session = makeSession({
    messages: [
      humanMsg("address the review comments", "2026-01-01T00:05:00.000Z"),
      humanMsg("now build the export button", "2026-01-01T00:10:00.000Z"),
      humanMsg("also address the PR comments", "2026-01-01T00:10:00.000Z"),
    ],
  });
  const spans = computeReworkSpans(session, SESSION_END);
  assert.equal(
    spans.length,
    2,
    "exit-then-enter at one instant yields two spans"
  );
  assert.deepEqual(
    [spans[0].startMs, spans[0].endMs],
    [ms("2026-01-01T00:05:00.000Z"), ms("2026-01-01T00:10:00.000Z")],
    "prior span closes exactly at the shared instant, not extended past it"
  );
  assert.equal(spans[1].startMs, ms("2026-01-01T00:10:00.000Z"));
  assert.equal(spans[1].endMs, SESSION_END);
  assert.equal(
    spans[1].confidence,
    REWORK_CONFIDENCE_PROMPT,
    "the co-timed address-review prompt opened the second span"
  );
});

test("a textless human turn (tool-result role) does not close an open span", () => {
  const session = makeSession({
    messages: [
      humanMsg("address the review comments", "2026-01-01T00:05:00.000Z"),
      humanMsg("", "2026-01-01T00:10:00.000Z"), // tool-result turn: role human, no steering text
    ],
  });
  const spans = computeReworkSpans(session, SESSION_END);
  assert.equal(spans.length, 1);
  assert.equal(
    spans[0].endMs,
    SESSION_END,
    "an empty-text human turn is neither enter nor exit"
  );
});

test("tolerates a legacy/partial session whose collections are undefined (backfill safety)", () => {
  // A session persisted before a collection field existed deserializes it as
  // undefined despite the type. The v3 bump re-derives ALL such history, so the
  // detector must not throw when messages/slashCommands/skills/toolUses are absent.
  const partial = {
    ...makeSession({}),
    messages: undefined,
    slashCommands: undefined,
    skills: undefined,
    toolUses: undefined,
  } as unknown as Parameters<typeof computeReworkSpans>[0];
  assert.deepEqual(computeReworkSpans(partial, SESSION_END), []);
  const segments = [
    seg(ACTIVITY_PHASE.Implement, ms("2026-01-01T00:00:00.000Z"), SESSION_END),
  ];
  assert.deepEqual(
    applyReworkDetection(segments, partial, []).map((s) => s.phase),
    [ACTIVITY_PHASE.Implement],
    "no triggers ⇒ segments pass through unchanged, no throw"
  );
});

test("cue precision: fix-review phrasings match, review-request phrasings do not", () => {
  const positives = [
    "evaluate the following code review comments",
    "address the review comments",
    "fix the PR feedback",
    "apply the reviewer's comments",
    "handle the CR comments",
    "go through the review findings",
    "please address the changes requested",
    // split-clause / object-before-PR phrasings (co-occurrence fallback)
    "there's a comment on the PR. please fix the issue it raised",
    "address the comments on the PR",
    "reply to the reviewer comments and resolve them",
  ];
  for (const text of positives) {
    const session = makeSession({
      messages: [humanMsg(text, "2026-01-01T00:10:00.000Z")],
    });
    assert.equal(
      computeReworkSpans(session, SESSION_END).length,
      1,
      `should trigger: "${text}"`
    );
  }
  const negatives = [
    "review this code for bugs",
    "can you review the PR",
    "add a comment explaining this function",
    "let's implement the pagination feature",
    "I addressed the review comments already", // past-tense statement, not an instruction
    "add code review feedback inline as comments", // authoring a review, not fixing one
    "the PR comments look good, no changes needed", // reference but no fix directive
    "review my local changes", // asking for a review, not fixing findings
  ];
  for (const text of negatives) {
    const session = makeSession({
      messages: [humanMsg(text, "2026-01-01T00:10:00.000Z")],
    });
    assert.deepEqual(
      computeReworkSpans(session, SESSION_END),
      [],
      `should NOT trigger: "${text}"`
    );
  }
});

test("negation veto: a DECLINED address-review intent opens no rework span; 'don't forget' still does", () => {
  // The declined intent is followed by edits, so the ≥1-edit gate would NOT save us —
  // the veto must stop the span from opening in the first place.
  const declined = [
    "no need to address the review comments right now, hold off",
    "don't address the review comments yet",
    "you don't need to fix the PR feedback",
    "we won't fix the PR feedback in this session",
  ];
  for (const text of declined) {
    const session = makeSession({
      messages: [humanMsg(text, "2026-01-01T00:10:00.000Z")],
      toolUses: [editTool("2026-01-01T00:11:00.000Z")],
    });
    assert.deepEqual(
      computeReworkSpans(session, SESSION_END),
      [],
      `declined ⇒ no span: "${text}"`
    );
  }
  // a do-anyway idiom ("don't forget") is not a decline and still opens a span
  const doAnyway = makeSession({
    messages: [
      humanMsg(
        "don't forget to address the review comments",
        "2026-01-01T00:10:00.000Z"
      ),
    ],
  });
  assert.equal(computeReworkSpans(doAnyway, SESSION_END).length, 1);
});

// ── Layer 2: applyReworkDetection — relabel + honest-zero gate ────────────────

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

test("gate: a review span with NO edit leaves segments untouched (honest zero)", () => {
  // address-review prompt at 00:05 opens a span, but the timeline carries only a
  // read (no mutate_code) inside it → the honest-zero gate leaves segments as-is.
  const session = makeSession({
    messages: [
      humanMsg("address the review comments", "2026-01-01T00:05:00.000Z"),
    ],
  });
  const segments = [
    seg(
      ACTIVITY_PHASE.Explore,
      ms("2026-01-01T00:05:00.000Z"),
      ms("2026-01-01T00:20:00.000Z")
    ),
    seg(ACTIVITY_PHASE.Implement, ms("2026-01-01T00:20:00.000Z"), SESSION_END),
  ];
  const out = applyReworkDetection(segments, session, [
    readUnit("2026-01-01T00:10:00.000Z"),
  ]);
  assert.deepEqual(
    out.map((s) => s.phase),
    [ACTIVITY_PHASE.Explore, ACTIVITY_PHASE.Implement]
  );
});

test("gate satisfied: all active segments in the span become rework; idle stays idle", () => {
  const session = makeSession({
    messages: [
      humanMsg("address the review comments", "2026-01-01T00:05:00.000Z"),
    ],
  });
  const segments = [
    // before the span → untouched
    seg(
      ACTIVITY_PHASE.Implement,
      ms("2026-01-01T00:00:00.000Z"),
      ms("2026-01-01T00:05:00.000Z")
    ),
    // inside the span → relabelled (explore + implement + review), idle preserved
    seg(
      ACTIVITY_PHASE.Explore,
      ms("2026-01-01T00:05:00.000Z"),
      ms("2026-01-01T00:07:00.000Z")
    ),
    seg(
      ACTIVITY_PHASE.Implement,
      ms("2026-01-01T00:07:00.000Z"),
      ms("2026-01-01T00:09:00.000Z")
    ),
    seg(
      ACTIVITY_PHASE.Idle,
      ms("2026-01-01T00:09:00.000Z"),
      ms("2026-01-01T00:30:00.000Z")
    ),
    seg(ACTIVITY_PHASE.Review, ms("2026-01-01T00:30:00.000Z"), SESSION_END),
  ];
  // a real edit inside the span confirms it (the gate reads mutate_code times).
  const out = applyReworkDetection(segments, session, [
    mutateUnit("2026-01-01T00:07:30.000Z"),
  ]);
  assert.deepEqual(
    out.map((s) => s.phase),
    [
      ACTIVITY_PHASE.Implement, // pre-span initial build stays implement
      ACTIVITY_PHASE.Rework, // explore-during-fix + the edit, coalesced into one run
      ACTIVITY_PHASE.Idle, // spend-free gap breaks the run and is unchanged
      ACTIVITY_PHASE.Rework, // committing the fix is rework
    ]
  );
  // relabelled segments carry the trigger's confidence + declared provenance
  const rework = out.filter((s) => s.phase === ACTIVITY_PHASE.Rework);
  for (const s of rework) {
    assert.equal(s.confidence, REWORK_CONFIDENCE_PROMPT);
    assert.deepEqual(s.evidenceLayers, [
      EvidenceLayer.Declared,
      EvidenceLayer.Structural,
    ]);
  }
});

test("coalesce: distinct adjacent phases inside one span become ONE rework run (FEA-2269 maximal-run invariant)", () => {
  const session = makeSession({
    messages: [
      humanMsg("address the review comments", "2026-01-01T00:05:00.000Z"),
    ],
  });
  // three originally-distinct adjacent phases, all inside the one span
  const segments = [
    seg(
      ACTIVITY_PHASE.Explore,
      ms("2026-01-01T00:05:00.000Z"),
      ms("2026-01-01T00:06:00.000Z")
    ),
    seg(
      ACTIVITY_PHASE.Implement,
      ms("2026-01-01T00:06:00.000Z"),
      ms("2026-01-01T00:07:00.000Z")
    ),
    seg(ACTIVITY_PHASE.Validate, ms("2026-01-01T00:07:00.000Z"), SESSION_END),
  ];
  const out = applyReworkDetection(segments, session, [
    mutateUnit("2026-01-01T00:06:30.000Z"),
  ]);
  assert.deepEqual(
    out.map((s) => s.phase),
    [ACTIVITY_PHASE.Rework],
    "three adjacent flipped pieces collapse to a single rework run"
  );
  // tiling stays complete/contiguous over the whole range
  assert.equal(out[0].startMs, ms("2026-01-01T00:05:00.000Z"));
  assert.equal(out[0].endMs, SESSION_END);
});

test("edit gate boundary: an edit at exactly the span start confirms (inclusive start)", () => {
  const session = makeSession({
    messages: [
      humanMsg("address the review comments", "2026-01-01T00:05:00.000Z"),
    ],
  });
  const segments = [
    seg(ACTIVITY_PHASE.Implement, ms("2026-01-01T00:05:00.000Z"), SESSION_END),
  ];
  // the only edit lands at exactly span.startMs (the trigger instant).
  const out = applyReworkDetection(segments, session, [
    mutateUnit("2026-01-01T00:05:00.000Z"),
  ]);
  assert.deepEqual(
    out.map((s) => s.phase),
    [ACTIVITY_PHASE.Rework],
    "an edit at the inclusive start confirms the span"
  );
});

test("edit gate boundary: an edit at exactly the span end does NOT confirm (exclusive end)", () => {
  const session = makeSession({
    messages: [
      humanMsg("address the review comments", "2026-01-01T00:05:00.000Z"),
      humanMsg("now build the CSV export", "2026-01-01T00:20:00.000Z"), // exit ⇒ span ends 00:20
    ],
  });
  const segments = [
    seg(
      ACTIVITY_PHASE.Implement,
      ms("2026-01-01T00:05:00.000Z"),
      ms("2026-01-01T00:20:00.000Z")
    ),
    seg(ACTIVITY_PHASE.Implement, ms("2026-01-01T00:20:00.000Z"), SESSION_END),
  ];
  // the only edit lands at exactly span.endMs (the exit instant) → outside [start, end).
  const out = applyReworkDetection(segments, session, [
    mutateUnit("2026-01-01T00:20:00.000Z"),
  ]);
  assert.ok(
    !out.some((s) => s.phase === ACTIVITY_PHASE.Rework),
    "an edit at the exclusive end must not confirm the span"
  );
});

// ── Layer 3: end-to-end through classifyActivitySegments ─────────────────────

function phasesOf(segments: ActivitySegmentRecord[]): string[] {
  return segments.map((s) => s.phase);
}

test("AC-003.1: edits after an address-review prompt are rework, distinct from the initial build", () => {
  const session = makeSession({
    sessionId: "rework-positive",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:10:00.000Z",
    toolUses: [
      // initial implementation
      editTool("2026-01-01T00:01:00.000Z"),
      editTool("2026-01-01T00:01:30.000Z"),
      // fix pass (after the review prompt)
      editTool("2026-01-01T00:05:00.000Z"),
      editTool("2026-01-01T00:05:30.000Z"),
    ],
    messages: [
      humanMsg(
        "evaluate the following code review comments",
        "2026-01-01T00:04:00.000Z"
      ),
    ],
  });
  const segments = classifyActivitySegments(session, Harness.Claude);
  const promptMs = ms("2026-01-01T00:04:00.000Z");

  assert.ok(
    segments.some((s) => s.phase === ACTIVITY_PHASE.Rework),
    `expected a rework segment; got ${phasesOf(segments).join(",")}`
  );
  // every rework segment starts at/after the review prompt…
  for (const s of segments) {
    if (s.phase === ACTIVITY_PHASE.Rework) {
      assert.ok(
        s.startMs >= promptMs,
        "rework never precedes the review trigger"
      );
    }
  }
  // …and the initial build (before the prompt) is NOT rework.
  const firstImplement = segments.find(
    (s) => s.startMs < promptMs && s.phase !== ACTIVITY_PHASE.Idle
  );
  assert.ok(
    firstImplement && firstImplement.phase !== ACTIVITY_PHASE.Rework,
    "initial build stays non-rework"
  );
});

test("AC-003.3: exploration and a git commit between edits are NOT rework signals", () => {
  const session = makeSession({
    sessionId: "no-rework-normal-loop",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:10:00.000Z",
    toolUses: [
      editTool("2026-01-01T00:01:00.000Z"),
      readTool("2026-01-01T00:02:00.000Z"), // exploration — normal, not a review signal
      bashTool("2026-01-01T00:03:00.000Z", "git commit -m 'wip'"), // commit — normal, not review
      editTool("2026-01-01T00:04:00.000Z"),
    ],
  });
  const segments = classifyActivitySegments(session, Harness.Claude);
  assert.ok(!segments.some((s) => s.phase === ACTIVITY_PHASE.Rework));
});

test("PR-open then edits does NOT produce rework (git is ambient, no review prompt)", () => {
  // Under the state-aware model a `gh pr create` is ambient git-lifecycle, not a
  // rework trigger; with no address-review prompt the following edits stay implement.
  const session = makeSession({
    sessionId: "pr-then-edits-no-rework",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:10:00.000Z",
    toolUses: [
      bashTool("2026-01-01T00:02:00.000Z", "gh pr create --fill"),
      editTool("2026-01-01T00:05:00.000Z"),
      editTool("2026-01-01T00:05:30.000Z"),
    ],
  });
  assert.ok(
    !classifyActivitySegments(session, Harness.Claude).some(
      (s) => s.phase === ACTIVITY_PHASE.Rework
    )
  );
});

test("exit boundary: work after a new (non-review) prompt is implement, not rework", () => {
  const session = makeSession({
    sessionId: "rework-then-new-work",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:20:00.000Z",
    toolUses: [
      editTool("2026-01-01T00:05:00.000Z"), // rework (after review prompt)
      editTool("2026-01-01T00:05:30.000Z"),
      editTool("2026-01-01T00:15:00.000Z"), // new work (after the new prompt)
      editTool("2026-01-01T00:15:30.000Z"),
    ],
    messages: [
      humanMsg("address the review comments", "2026-01-01T00:04:00.000Z"),
      humanMsg(
        "now build the export-to-CSV button",
        "2026-01-01T00:10:00.000Z"
      ),
    ],
  });
  const segments = classifyActivitySegments(session, Harness.Claude);
  const exitMs = ms("2026-01-01T00:10:00.000Z");
  const after = segments.filter(
    (s) => s.startMs >= exitMs && s.phase !== ACTIVITY_PHASE.Idle
  );
  assert.ok(after.length > 0);
  for (const s of after) {
    assert.notEqual(
      s.phase,
      ACTIVITY_PHASE.Rework,
      "post-exit work is not rework"
    );
  }
});

test("determinism + tiling preserved: rework relabel is byte-identical and stays contiguous/complete", () => {
  const session = makeSession({
    sessionId: "rework-determinism",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:10:00.000Z",
    toolUses: [
      editTool("2026-01-01T00:05:00.000Z"),
      editTool("2026-01-01T00:05:30.000Z"),
    ],
    messages: [
      humanMsg("address the review comments", "2026-01-01T00:04:00.000Z"),
    ],
  });
  const first = classifyActivitySegments(session, Harness.Claude);
  const second = classifyActivitySegments(session, Harness.Claude);
  assert.deepEqual(first, second);

  // relabel-only: the tiling still spans the bounds contiguously with positive width.
  const bounds = deriveSessionBoundsMs(session);
  assert.ok(bounds);
  assert.equal(first[0].startMs, bounds.startMs);
  assert.equal(first.at(-1)?.endMs, bounds.endMs);
  for (let i = 0; i < first.length; i++) {
    assert.ok(first[i].endMs > first[i].startMs, "positive width");
    if (i + 1 < first.length) {
      assert.equal(
        first[i].endMs,
        first[i + 1].startMs,
        "contiguous, no gap/overlap"
      );
    }
  }
});

// ── AA-09 C1: the edit gate reads WORKSPACE mutations only ────────────────────

function scratchUnit(timestamp: string): EvidenceUnit {
  return {
    ms: ms(timestamp),
    category: ToolCategory.MutateScratch,
    layer: EvidenceLayer.Structural,
  };
}
function documentUnit(timestamp: string): EvidenceUnit {
  return {
    ms: ms(timestamp),
    category: ToolCategory.MutateDocument,
    layer: EvidenceLayer.Structural,
  };
}

function reviewSpanSegments(): ActivitySegmentRecord[] {
  return [
    seg(
      ACTIVITY_PHASE.Explore,
      ms("2026-01-01T00:05:00.000Z"),
      ms("2026-01-01T00:20:00.000Z")
    ),
    seg(ACTIVITY_PHASE.Implement, ms("2026-01-01T00:20:00.000Z"), SESSION_END),
  ];
}

function reviewSession() {
  return makeSession({
    messages: [
      humanMsg("address the review comments", "2026-01-01T00:05:00.000Z"),
    ],
  });
}

test("AA-09 C1: a review span whose only write is bookkeeping is NOT rework", () => {
  // The corpus shape: a declared review walk in which the agent writes only its
  // own state files. Before C1 those were `mutate_code`, so the gate confirmed
  // rework off writes that changed nothing in the project.
  const out = applyReworkDetection(reviewSpanSegments(), reviewSession(), [
    scratchUnit("2026-01-01T00:10:00.000Z"),
  ]);
  assert.deepEqual(
    out.map((s) => s.phase),
    [ACTIVITY_PHASE.Explore, ACTIVITY_PHASE.Implement],
    "bookkeeping is not a fix — the honest-zero gate must hold"
  );
});

test("AA-09 C1: a documentation edit DOES confirm rework", () => {
  // Answering review feedback by correcting the docs is a real fix, so the gate
  // must not have been narrowed to source-only.
  const out = applyReworkDetection(reviewSpanSegments(), reviewSession(), [
    documentUnit("2026-01-01T00:10:00.000Z"),
  ]);
  assert.ok(
    out.some((s) => s.phase === ACTIVITY_PHASE.Rework),
    "a doc fix inside a review span is rework"
  );
});

// ── AA-07: cue calibration (PLN-1490 step 4) ────────────────────────────────
//
// Both directions are corpus-driven. The over-trigger erased two whole sessions'
// implement/validate structure by declaring them rework from t0; the
// under-triggers left explicit, edit-followed address-review asks at honest zero.

test("AA-07: a long autonomous work order is not an address-review request", () => {
  // The split-clause fallback pairs a review-comment REFERENCE with a fix
  // DIRECTIVE. Across a 2,265-character kickoff those two halves land in
  // unrelated clauses — "post a brief comment on PR #1946 explaining why" and
  // "other agents handling sibling findings" — and the whole session became
  // rework at confidence 0.9, stripping every implement and validate segment.
  const kickoff = [
    "You are implementing exactly ONE finding from an overnight nightly-review PR,",
    "running in parallel with other agents handling sibling findings.",
    "Implement just this finding into a green, mergeable fix PR.",
    "If the finding turns out to be bogus, do not implement it.",
    "Instead post a brief comment on PR #1946 explaining why.",
    "x".repeat(600),
  ].join(" ");
  assert.equal(isReviewFixPrompt(kickoff), false);
});

test("AA-07: authoring a comment is not addressing one", () => {
  assert.equal(
    isReviewFixPrompt("post a brief comment on PR #1946 explaining why"),
    false
  );
  assert.equal(
    isReviewFixPrompt("leave a comment on the PR and resolve the thread"),
    false
  );
});

test("AA-07: a directive inside a hyphenated compound does not fire", () => {
  // `appl\w*` matched inside `nightly-apply`, and `review]` satisfied the
  // review-object — two fragments of a status-tag literal, not a request.
  assert.equal(
    isReviewFixPrompt(
      "Instead post a [nightly-apply: BLOCKED — needs enablement; human review] comment on PR #2198"
    ),
    false
  );
});

test("AA-07: severity shorthand is a valid review object", () => {
  // "the 2 mediums in the PR" names findings by SEVERITY with no object noun;
  // real edits, a commit and a push followed, and rework was zero.
  assert.equal(
    isReviewFixPrompt(
      "go ahead and fix the 2 mediums in the PR and we'll merge"
    ),
    true
  );
  assert.equal(isReviewFixPrompt("address the blockers in the review"), true);
  // ...but severity words with no review context stay out.
  assert.equal(isReviewFixPrompt("fix the mediums"), false);
});

test("AA-07: a reviewer's possessive findings are review context", () => {
  // "Tina's findings" names the reviewer rather than the review.
  assert.equal(
    isReviewFixPrompt("can you implement Tina's findings outlined here?"),
    true
  );
});

test("AA-07: demonstratives are admitted in the comment reference", () => {
  // Only a bare "the" was accepted, so "comments on this PR" — an extremely
  // common phrasing — missed entirely.
  for (const text of [
    "look at the comments on this PR and fix them",
    "please address the comments on that PR",
    "fix the comments on my PR",
  ]) {
    assert.equal(isReviewFixPrompt(text), true, text);
  }
});

test("AA-07: the negation veto still wins over the new cues", () => {
  // The added recall must not open a path around the decline guard.
  assert.equal(
    isReviewFixPrompt("no need to fix the 2 mediums in the PR yet"),
    false
  );
  assert.equal(
    isReviewFixPrompt("don't address the comments on this PR"),
    false
  );
});
